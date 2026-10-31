// Сообщения внутри приложения (см. migration_messages_posts.sql):
//   новости мастер-аккаунта всем, обращения пользователей к мастер-аккаунту, ответы,
//   файлы для отладки с комментарием (уходят мастер-аккаунту, пользователю не скачиваются).
import { supabase } from './supabase'
import { getUserSettings, saveUserSettings } from './userSettings'
import { APP_VERSION } from './version'
import { gzipSync, gunzipSync } from 'fflate'

const isMissing = e => /app_messages|shared_posts|PGRST205|PGRST202|42P01|schema cache/i.test(String(e?.message || '') + ' ' + String(e?.code || ''))
export const MSG_SQL_HINT = 'Сообщения пока не включены в базе: выполните migration_messages_posts.sql в Supabase (SQL Editor) — один раз.'
const COLS = 'id,created_at,from_id,from_name,to_id,kind,title,body,file_name,file_size,order_id'
const fail = e => ({ error: isMissing(e) ? MSG_SQL_HINT : String(e?.message || e), missing: isMissing(e) })
const nameOf = profile => [profile?.full_name, profile?.phone].filter(Boolean).join(' · ') || profile?.email || ''

/** Лента сообщений, новые сверху. -> { data: [...] } | { error, missing } */
export async function listMessages(limit = 200) {
  try {
    // галочки «дошло / прочитано» (migration_msg_receipts.sql); колонок ещё нет — без них
    let { data, error } = await supabase.from('app_messages').select(COLS + ',delivered_at,read_at').order('created_at', { ascending: false }).limit(limit)
    if (error && /delivered_at|read_at/.test(String(error.message))) ({ data, error } = await supabase.from('app_messages').select(COLS).order('created_at', { ascending: false }).limit(limit))
    if (error) return fail(error)
    // переписка по заказам — в ленте только своя (сотрудник производства видит чаты всех заказов — им место в заказе)
    const uid = (await supabase.auth.getUser())?.data?.user?.id
    return { data: (data || []).filter(m => m.kind !== 'order' || m.from_id === uid || m.to_id === uid) }
  } catch (e) { return fail(e) }
}
// Большой файл — частями: один запрос на 10–20 МБ на медленной / мобильной сети обрывался («TypeError: Failed to fetch»).
// Сообщение создаётся с первой частью, остальные дописываются по одной (msg_append, migration_msg_chunks.sql),
// каждая — с повтором при сбое сети.
const CHUNK = 900 * 1024
const netErr = e => /Failed to fetch|NetworkError|Load failed|network|timeout|ECONN|aborted/i.test(String(e?.message || e))
async function retry(fn, tries = 4) {
  let last
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fn()
      if (!r?.error || !netErr(r.error)) return r
      last = r.error
    } catch (e) { if (!netErr(e)) throw e; last = e }
    await new Promise(res => setTimeout(res, 800 * (i + 1)))
  }
  return { error: last }
}
const NET_HINT = 'Связь прервалась при отправке. Проверьте интернет и попробуйте ещё раз (большой файл лучше отправлять по Wi-Fi).'
async function insert(row, onProgress = null) {
  try {
    const payload = row.payload || ''
    if (payload.length <= CHUNK) {
      const { error } = await retry(() => supabase.from('app_messages').insert(row))
      return error ? (netErr(error) ? { error: NET_HINT } : fail(error)) : { ok: true }
    }
    const parts = []
    for (let i = 0; i < payload.length; i += CHUNK) parts.push(payload.slice(i, i + CHUNK))
    onProgress?.(0, parts.length)
    const first = await retry(() => supabase.from('app_messages').insert({ ...row, payload: parts[0] }).select('id').single())
    if (first.error) return netErr(first.error) ? { error: NET_HINT } : fail(first.error)
    const id = first.data.id
    for (let k = 1; k < parts.length; k++) {
      onProgress?.(k, parts.length)
      const r = await retry(() => supabase.rpc('msg_append', { p_id: id, p_chunk: parts[k] }))
      if (r.error) {
        await supabase.from('app_messages').delete().eq('id', id)      // недописанный файл — не оставляем
        if (/msg_append|PGRST202|schema cache/i.test(String(r.error?.message || r.error))) return { error: 'Большие файлы пока не включены в базе: выполните migration_msg_chunks.sql в Supabase (SQL Editor) — один раз.' }
        return netErr(r.error) ? { error: NET_HINT } : fail(r.error)
      }
    }
    onProgress?.(parts.length, parts.length)
    return { ok: true }
  } catch (e) { return netErr(e) ? { error: NET_HINT } : fail(e) }
}
/** Обращение пользователя к мастер-аккаунту */
export const sendAppeal = (user, profile, body, extra = {}) => insert({ from_id: user.id, from_name: nameOf(profile), kind: 'appeal', body, ...(extra.orderId ? { order_id: extra.orderId } : {}), ...(extra.title ? { title: extra.title } : {}) })
/** Обращение «убрать тестовый заказ из итогов»: заказ, номер и производство — для кнопок мастер-аккаунта в «Сообщениях».
 *  Старые обращения без order_id узнаются по тексту (номер в «(№ …)», производство в «производства «…»»). */
export function excludeRequest(m) {
  if (!m || m.kind !== 'appeal' || !/убрать из итогов/i.test(m.body || '')) return null
  const num = (m.body.match(/\(№\s*([^)\s]+)\)/) || [])[1] || ''
  const prod = (m.body.match(/производства «([^»]*)»/) || [])[1] || ''
  if (!m.order_id && !num) return null
  return { orderId: m.order_id || '', num, prod }
}
/** Обращение с файлами: один файл уходит как есть, несколько — одним архивом .zip (мастер скачивает и распаковывает) */
export async function sendAppealFiles(user, profile, body, files, onProgress = null) {
  const list = [...(files || [])]
  if (!list.length) return sendAppeal(user, profile, body)
  const total = list.reduce((a, f) => a + (f.size || 0), 0)
  const tooBig = mb => ({ error: `Файлы слишком большие (${mb.toFixed(1)} МБ${mb * 1048576 < total ? ' после сжатия' : ''}, можно до ${REPORT_MAX_MB} МБ вместе). Отправьте часть файлов или пришлите их в WhatsApp / Telegram.` })
  if (total > REPORT_RAW_MAX_MB * 1048576) return tooBig(total / 1048576)
  let fileName, payload
  try {
    if (list.length === 1) { fileName = list[0].name; payload = await fileToPayload(list[0]) }
    else {
      const { zipSync } = await import('fflate')
      const entries = {}
      for (const f of list) {
        let name = f.name || 'file', k = 1
        while (entries[name]) name = (f.name || 'file').replace(/(\.[^.]*)?$/, m => `_${++k}${m}`)
        entries[name] = [new Uint8Array(await f.arrayBuffer()), { level: 6 }]
      }
      const zip = zipSync(entries)
      fileName = `Файлы_${list.length}_шт.zip`
      payload = await fileToPayload(new Blob([zip], { type: 'application/zip' }))
    }
  } catch (e) { return { error: 'Не удалось прочитать файл: ' + (e?.message || e) } }
  if (payloadMb(payload) > REPORT_MAX_MB) return tooBig(payloadMb(payload))
  return insert({ from_id: user.id, from_name: nameOf(profile), kind: 'appeal', title: list.length > 1 ? list.map(f => f.name).join(', ').slice(0, 300) : null,
    body, file_name: fileName, file_size: payload.length, payload }, onProgress)
}
/** Новость от мастер-аккаунта всем пользователям */
export const sendNews = (user, profile, title, body) => insert({ from_id: user.id, from_name: nameOf(profile), kind: 'news', title, body })
/** Ответ мастер-аккаунта пользователю */
// toName — кому (личное сообщение из списка пользователей): мастер видит адресата у своих сообщений; пользователю from_name не показывается
export const sendReply = (user, profile, toId, body, toName = '') => insert({ from_id: user.id, from_name: nameOf(profile) + (toName ? ` → ${toName}` : ''), to_id: toId, kind: 'reply', body })
/** Файл для отладки с комментарием — мастер-аккаунту */
export const sendDebugFile = (user, profile, { fileName, payload, comment, orderId, title }, onProgress = null) =>
  insert({ from_id: user.id, from_name: nameOf(profile), kind: 'debug', title: `${title || ''}${title ? ' · ' : ''}v${APP_VERSION}`, body: comment, file_name: fileName, file_size: String(payload || '').length, payload: String(payload || ''), order_id: orderId || null }, onProgress)

export async function deleteMessage(id) {
  try { const { error } = await supabase.from('app_messages').delete().eq('id', id); return error ? fail(error) : { ok: true } } catch (e) { return fail(e) }
}
/** Файл (любой, в т. ч. двоичный: .b3d, .add, .xlsx, .pdf) — в текст для отправки: data:…;base64,…
 *  Крупный файл, который хорошо сжимается (модели bCAD, Базиса, К3, истории раскроя), — сжатым: data:…;gzip;base64,… */
export const REPORT_MAX_MB = 15            // после сжатия
export const REPORT_RAW_MAX_MB = 60        // сам файл до сжатия
const b64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s) }
export async function fileToPayload(file) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const mime = file.type || 'application/octet-stream'
  if (bytes.length > 256 * 1024) {
    const gz = gzipSync(bytes, { level: 6 })
    if (gz.length < bytes.length * 0.85) return `data:${mime};gzip;base64,` + b64(gz)
  }
  return `data:${mime};base64,` + b64(bytes)
}
/** Сколько МБ займёт файл в сообщении (после сжатия, без base64) */
export const payloadMb = payload => (String(payload || '').length * 3) / 4 / 1048576
/** Текст из сообщения обратно в файл: data:…;base64,… → двоичный (сжатый — распаковывается), иначе — как текст */
export function payloadBlob(payload) {
  const m = /^data:([^;,]*)(;gzip)?(;base64)?,/.exec(payload || '')
  if (!m || !m[3]) return new Blob([payload || ''], { type: 'application/octet-stream' })
  const bin = atob(payload.slice(m[0].length))
  let bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  if (m[2]) bytes = gunzipSync(bytes)
  return new Blob([bytes], { type: m[1] || 'application/octet-stream' })
}
/** Текст присланного файла (истории раскроя и т. п.): из data:… — распакованный, иначе как есть */
export const payloadText = async payload => (/^data:/.test(payload || '') ? await payloadBlob(payload).text() : String(payload || ''))
/** Содержимое приложенного файла */
export async function messagePayload(id) {
  try {
    const { data, error } = await supabase.from('app_messages').select('payload,file_name').eq('id', id).single()
    return error ? fail(error) : { payload: data?.payload || '', fileName: data?.file_name || 'file.txt' }
  } catch (e) { return fail(e) }
}

/** Что считать входящим для этого пользователя */
export const isIncoming = (m, userId, master) => m.from_id !== userId && ((m.kind === 'order' && m.to_id === userId) || (master ? m.kind === 'appeal' || m.kind === 'debug' : m.kind === 'news' || m.kind === 'reply'))
/** Сколько непрочитанных входящих */
export async function unreadCount(user, master) {
  if (!user) return 0
  try {
    const seen = getUserSettings(user).msgSeenAt || '1970-01-01T00:00:00Z'
    let q = supabase.from('app_messages').select('id', { count: 'exact', head: true }).gt('created_at', seen).neq('from_id', user.id)
    q = q.or(`kind.in.(${master ? 'appeal,debug' : 'news,reply'}),and(kind.eq.order,to_id.eq.${user.id})`)   // + сообщения по заказу мне
    const { count, error } = await q
    if (!master) receipt(false)                     // ответы мастер-аккаунта дошли: приложение у пользователя открыто
    return error ? 0 : count || 0
  } catch { return 0 }
}
/** Переписка по заказу (заказчик ↔ производство), старые сверху. -> { data } | { error, missing } */
export async function listOrderMessages(orderId) {
  try {
    const { data, error } = await supabase.from('app_messages').select(COLS).eq('order_id', orderId).eq('kind', 'order').order('created_at', { ascending: true }).limit(300)
    return error ? fail(error) : { data: data || [] }
  } catch (e) { return fail(e) }
}
/** Сообщение по заказу: адресата ставит база (заказчик → производство, производство → заказчик) */
export const sendOrderMessage = (user, profile, orderId, body) => insert({ from_id: user.id, from_name: nameOf(profile), kind: 'order', order_id: orderId, body })
export const ORDER_CHAT_SQL_HINT = 'Переписка по заказу пока не включена в базе: выполните migration_order_chat.sql в Supabase (SQL Editor) — один раз.'
/** Галочки у ответов мастер-аккаунта: дошло (read = false) / прочитано (read = true). Нет функции в базе — молча */
let lastReceipt = 0
export function receipt(read) {
  if (!read && Date.now() - lastReceipt < 60000) return
  lastReceipt = Date.now()
  supabase.rpc('msg_receipt', { p_read: !!read }).then(() => {}, () => {})
}
export const markSeen = user => saveUserSettings({ msgSeenAt: new Date().toISOString() }, user)

// ─── общие постпроцессоры ───────────────────────────────────────────────────
/** Постпроцессоры «для всех»: [{ ...post, shared: true }] */
export async function listSharedPosts() {
  try {
    const { data, error } = await supabase.from('shared_posts').select('id,name,data,owner_id').order('name')
    if (error) return { data: [], ...fail(error) }
    return { data: (data || []).map(r => ({ ...(r.data || {}), id: r.id, name: r.name, shared: true, ownerId: r.owner_id })) }
  } catch (e) { return { data: [], ...fail(e) } }
}
export async function saveSharedPost(post, user) {
  try {
    // инструменты и их назначения у каждого пользователя свои: своя обработка постпроцессора (ownOps) не публикуется
    const data = { ...post }; delete data.shared; delete data.forAll; delete data.ownerId; delete data.ownOps
    const { error } = await supabase.from('shared_posts').upsert({ id: post.id, owner_id: user.id, name: post.name, data, updated_at: new Date().toISOString() })
    return error ? fail(error) : { ok: true }
  } catch (e) { return fail(e) }
}
export async function removeSharedPost(id) {
  try { const { error } = await supabase.from('shared_posts').delete().eq('id', id); return error ? fail(error) : { ok: true } } catch (e) { return fail(e) }
}
