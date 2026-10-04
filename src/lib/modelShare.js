// Ссылка на 3D-модель заказа для клиента: по ней модель открывается без входа в приложение.
// Таблица model_shares + функция shared_model (см. migration_model_shares.sql).
// Ссылка «живая»: показывает заказ в том виде, в каком он сохранён сейчас.
// Закрыть доступ = удалить строку — ссылка сразу перестаёт работать.
import { supabase } from './supabase'

const isMissing = e => /model_shares|shared_model|PGRST205|PGRST202|42P01|42883|schema cache/i.test(String(e?.message || '') + ' ' + String(e?.code || ''))
export const SHARE_TABLE_HINT = 'Ссылки пока не включены в базе: выполните migration_model_shares.sql в Supabase (SQL Editor) — один раз.'

// Ключ ссылки — короткий код (migration_share_code.sql), а в старой базе — длинный токен
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const shareUrl = key => `${window.location.origin}/${UUID.test(key) ? 'view' : 'v'}/${key}`
// колонки code может ещё не быть — тогда читаем только token
async function selectShares(build) {
  let r = await build('order_id,token,code')
  if (r.error && /code/.test(String(r.error.message || ''))) r = await build('order_id,token')
  return r
}
const keyOf = row => row?.code || row?.token || null

// что уже известно: id заказа -> токен (или null); страницы подписываются на изменения
const cache = new Map()
const subs = new Set()
const emit = () => subs.forEach(fn => { try { fn() } catch { /* подписчик сам разберётся */ } })
export function onShareChange(fn) { subs.add(fn); return () => subs.delete(fn) }
export const cachedShare = orderId => cache.get(orderId)

/** -> { token } | { token: null } | { error, missing } */
export async function getShare(orderId) {
  if (!orderId) return { token: null }
  try {
    const { data, error } = await selectShares(cols => supabase.from('model_shares').select(cols).eq('order_id', orderId).maybeSingle())
    if (error) return { token: null, error: error.message, missing: isMissing(error) }
    cache.set(orderId, keyOf(data)); emit()
    return { token: keyOf(data) }
  } catch (e) { return { token: null, error: String(e?.message || e) } }
}

export async function createShare(orderId) {
  try {
    const { error } = await supabase.from('model_shares').insert({ order_id: orderId })
    if (!error) return getShare(orderId)
    {
      if (isMissing(error)) return { token: null, error: SHARE_TABLE_HINT, missing: true }
      const again = await getShare(orderId)          // ссылка уже есть (создана раньше или с другого устройства)
      if (again.token) return again
      return { token: null, error: error.message }
    }
  } catch (e) { return { token: null, error: String(e?.message || e) } }
}

/** Закрыть доступ: ссылка перестаёт открываться */
export async function deleteShare(orderId) {
  try {
    const { error } = await supabase.from('model_shares').delete().eq('order_id', orderId)
    if (error) return { ok: false, error: error.message }
    cache.set(orderId, null); emit()
    return { ok: true }
  } catch (e) { return { ok: false, error: String(e?.message || e) } }
}

/** Заказы, у которых открыта ссылка: Map id заказа -> токен */
export async function listShares() {
  try {
    const { data, error } = await selectShares(cols => supabase.from('model_shares').select(cols))
    if (error) return new Map()
    const map = new Map((data || []).map(r => [r.order_id, keyOf(r)]))
    map.forEach((t, id) => cache.set(id, t))
    return map
  } catch { return new Map() }
}

/** Модель по ссылке (без входа). -> { title, details, model, textures } | null (ссылка закрыта) | { error } */
export async function fetchSharedModel(token) {
  try {
    const { data, error } = UUID.test(token) ? await supabase.rpc('shared_model', { p_token: token }) : await supabase.rpc('shared_model_code', { p_code: token })
    if (error) return { error: isMissing(error) ? 'Просмотр по ссылке не настроен.' : error.message }
    return data || null
  } catch (e) { return { error: String(e?.message || e) } }
}
