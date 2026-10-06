// Ссылка на симуляцию обработки листа: открывается без входа (см. migration_sim_shares.sql).
// Ссылка — снимок: G-код листа, лист, контуры деталей, диаметры инструментов. Повторное создание
// для того же листа обновляет снимок, адрес остаётся прежним. Удалили — ссылка не открывается.
import { supabase } from './supabase'

const isMissing = e => /sim_shares|shared_sim|PGRST205|PGRST202|42P01|42883|schema cache/i.test(String(e?.message || '') + ' ' + String(e?.code || ''))
export const SIM_SHARE_HINT = 'Ссылки на симуляцию пока не включены в базе: выполните migration_sim_shares.sql в Supabase (SQL Editor) — один раз.'
export const simShareUrl = code => `${window.location.origin}/s/${code}`

const KIND = { hole: 'h', groove: 'g', pocket: 'p', cutout: 'c', outer: 'o' }
const KIND_BACK = Object.fromEntries(Object.entries(KIND).map(([k, v]) => [v, k]))
const r1 = v => Math.round(v * 10) / 10

/** Снимок симуляции -> строка для базы */
export function packSim({ text, kinds, opIds, sheet, outlines, thickness, rapid, tools, zShift = 0 }) {
  return JSON.stringify({
    v: 1, text, k: (kinds || []).map(x => KIND[x] || '-').join(''), o: opIds || [],
    sheet, outlines: (outlines || []).map(pts => pts.map(([x, y]) => [r1(x), r1(y)])), thickness, rapid, tools, z: zShift || 0,
  })
}
export function unpackSim(str) {
  const d = typeof str === 'string' ? JSON.parse(str) : str
  return { text: d.text || '', kinds: [...(d.k || '')].map(ch => KIND_BACK[ch] || null), opIds: d.o || [], sheet: d.sheet || null, outlines: d.outlines || [], thickness: d.thickness || 16, rapid: d.rapid || 20000, tools: d.tools || {}, zShift: d.z || 0 }
}

/** Код ссылки, если она уже есть. -> { code } | { code: null } | { error, missing } */
export async function getSimShare(orderId, name) {
  try {
    const { data, error } = await supabase.from('sim_shares').select('code').eq('order_id', orderId).eq('name', name).maybeSingle()
    if (error) return { code: null, error: isMissing(error) ? SIM_SHARE_HINT : error.message, missing: isMissing(error) }
    return { code: data?.code || null }
  } catch (e) { return { code: null, error: String(e?.message || e) } }
}
/** Создать ссылку или обновить её снимок. -> { code } | { error } */
export async function saveSimShare(orderId, name, userId, payload) {
  try {
    const { data, error } = await supabase.from('sim_shares')
      .upsert({ user_id: userId, order_id: orderId, name, data: payload, updated_at: new Date().toISOString() }, { onConflict: 'user_id,order_id,name' })
      .select('code').single()
    if (error) return { error: isMissing(error) ? SIM_SHARE_HINT : error.message }
    return { code: data.code }
  } catch (e) { return { error: String(e?.message || e) } }
}
export async function deleteSimShare(code) {
  try {
    const { error } = await supabase.from('sim_shares').delete().eq('code', code)
    return error ? { error: error.message } : { ok: true }
  } catch (e) { return { error: String(e?.message || e) } }
}
/** Симуляция по ссылке (без входа). -> { name, ...снимок } | null (ссылка закрыта) | { error } */
export async function fetchSharedSim(code) {
  try {
    const { data, error } = await supabase.rpc('shared_sim', { p_code: code })
    if (error) return { error: isMissing(error) ? 'Просмотр по ссылке не настроен.' : error.message }
    if (!data) return null
    return { name: data.name, ...unpackSim(data.data) }
  } catch (e) { return { error: String(e?.message || e) } }
}
/** Все ссылки на симуляцию по заказу: [{ code, name, updated_at }] */
export async function listSimShares(orderId) {
  try {
    const { data, error } = await supabase.from('sim_shares').select('code,name,updated_at').eq('order_id', orderId).order('name')
    return error ? [] : data || []
  } catch { return [] }
}
/** Заказы, у которых открыты ссылки на симуляцию: Map id заказа -> сколько ссылок */
export async function simShareOrders() {
  try {
    const { data, error } = await supabase.from('sim_shares').select('order_id')
    const map = new Map()
    if (!error) for (const r of data || []) map.set(r.order_id, (map.get(r.order_id) || 0) + 1)
    return map
  } catch { return new Map() }
}
