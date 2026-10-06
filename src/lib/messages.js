// Сообщения внутри приложения (см. migration_messages_posts.sql):
//   новости мастер-аккаунта всем, обращения пользователей к мастер-аккаунту, ответы,
//   файлы для отладки с комментарием (уходят мастер-аккаунту, пользователю не скачиваются).
import { supabase } from './supabase'
import { getUserSettings, saveUserSettings } from './userSettings'

const isMissing = e => /app_messages|shared_posts|PGRST205|PGRST202|42P01|schema cache/i.test(String(e?.message || '') + ' ' + String(e?.code || ''))
export const MSG_SQL_HINT = 'Сообщения пока не включены в базе: выполните migration_messages_posts.sql в Supabase (SQL Editor) — один раз.'
const COLS = 'id,created_at,from_id,from_name,to_id,kind,title,body,file_name,file_size,order_id'
const fail = e => ({ error: isMissing(e) ? MSG_SQL_HINT : String(e?.message || e), missing: isMissing(e) })
const nameOf = profile => [profile?.full_name, profile?.phone].filter(Boolean).join(' · ') || profile?.email || ''

/** Лента сообщений, новые сверху. -> { data: [...] } | { error, missing } */
export async function listMessages(limit = 200) {
  try {
    const { data, error } = await supabase.from('app_messages').select(COLS).order('created_at', { ascending: false }).limit(limit)
    return error ? fail(error) : { data: data || [] }
  } catch (e) { return fail(e) }
}
async function insert(row) {
  try {
    const { error } = await supabase.from('app_messages').insert(row)
    return error ? fail(error) : { ok: true }
  } catch (e) { return fail(e) }
}
/** Обращение пользователя к мастер-аккаунту */
export const sendAppeal = (user, profile, body) => insert({ from_id: user.id, from_name: nameOf(profile), kind: 'appeal', body })
/** Новость от мастер-аккаунта всем пользователям */
export const sendNews = (user, profile, title, body) => insert({ from_id: user.id, from_name: nameOf(profile), kind: 'news', title, body })
/** Ответ мастер-аккаунта пользователю */
export const sendReply = (user, profile, toId, body) => insert({ from_id: user.id, from_name: nameOf(profile), to_id: toId, kind: 'reply', body })
/** Файл для отладки с комментарием — мастер-аккаунту */
export const sendDebugFile = (user, profile, { fileName, payload, comment, orderId, title }) =>
  insert({ from_id: user.id, from_name: nameOf(profile), kind: 'debug', title: title || '', body: comment, file_name: fileName, file_size: String(payload || '').length, payload: String(payload || ''), order_id: orderId || null })

export async function deleteMessage(id) {
  try { const { error } = await supabase.from('app_messages').delete().eq('id', id); return error ? fail(error) : { ok: true } } catch (e) { return fail(e) }
}
/** Содержимое приложенного файла */
export async function messagePayload(id) {
  try {
    const { data, error } = await supabase.from('app_messages').select('payload,file_name').eq('id', id).single()
    return error ? fail(error) : { payload: data?.payload || '', fileName: data?.file_name || 'file.txt' }
  } catch (e) { return fail(e) }
}

/** Что считать входящим для этого пользователя */
export const isIncoming = (m, userId, master) => m.from_id !== userId && (master ? m.kind === 'appeal' || m.kind === 'debug' : m.kind === 'news' || m.kind === 'reply')
/** Сколько непрочитанных входящих */
export async function unreadCount(user, master) {
  if (!user) return 0
  try {
    const seen = getUserSettings(user).msgSeenAt || '1970-01-01T00:00:00Z'
    let q = supabase.from('app_messages').select('id', { count: 'exact', head: true }).gt('created_at', seen).neq('from_id', user.id)
    q = master ? q.in('kind', ['appeal', 'debug']) : q.in('kind', ['news', 'reply'])
    const { count, error } = await q
    return error ? 0 : count || 0
  } catch { return 0 }
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
    const data = { ...post }; delete data.shared; delete data.forAll; delete data.ownerId
    const { error } = await supabase.from('shared_posts').upsert({ id: post.id, owner_id: user.id, name: post.name, data, updated_at: new Date().toISOString() })
    return error ? fail(error) : { ok: true }
  } catch (e) { return fail(e) }
}
export async function removeSharedPost(id) {
  try { const { error } = await supabase.from('shared_posts').delete().eq('id', id); return error ? fail(error) : { ok: true } } catch (e) { return fail(e) }
}
