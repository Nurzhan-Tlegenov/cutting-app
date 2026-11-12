// Бета-тест новых функций (migration_beta.sql). Кто тестирует — выбирает мастер-аккаунт в «Пользователях».
// Мастер-аккаунт видит все бета-функции всегда.
import { supabase } from './supabase'
import { sendReply } from './messages'

export const BETA_FEATURES = [
  ['beam_saw', 'Пильный центр'],
  ['merge_nesting', 'Объединённый раскрой'],
  ['constructor', 'Конструктор мебели'],
  ['linear_cut', 'Линейный раскрой'],
  ['dxf', 'Выгрузка DXF раскроя'],   // не бета: выдаётся по запросу, как постпроцессор (🔑)
]
export const GRANT_FEATURES = new Set(['dxf'])          // выдаются по запросу — значок 🔑 вместо β
export const BETA_SQL_HINT = 'Бета-тест ещё не включён в базе: выполните migration_beta.sql в Supabase (SQL Editor) — один раз.'
const isMissing = e => /PGRST202|42883|schema cache|Could not find the function/i.test(`${e?.message || ''} ${e?.code || ''}`)

let cache = null, cacheAt = 0
/** Мои бета-функции: массив ключей; база ещё без бета-теста — пусто */
export async function myBeta(force = false) {
  if (!force && cache && Date.now() - cacheAt < 30000) return cache
  try {
    const { data, error } = await supabase.rpc('my_beta')
    cache = error ? [] : Array.isArray(data) ? data : []
  } catch { cache = [] }
  cacheAt = Date.now()
  return cache
}
export const hasBeta = async (feature, force) => (await myBeta(force)).includes(feature)

// ── мастер-аккаунт ──
const call = async (fn, args) => {
  try {
    const { data, error } = await supabase.rpc(fn, args)
    if (error) return { error: isMissing(error) ? BETA_SQL_HINT : error.message, missing: isMissing(error) }
    return { data }
  } catch (e) { return { error: String(e?.message || e) } }
}
/** -> { data: Map(user_id -> [ключи]) } | { error } */
export async function adminBeta() {
  const r = await call('admin_beta')
  return r.error ? r : { data: new Map((r.data || []).map(x => [x.user_id, x.features || []])) }
}
export const adminSetBeta = (userId, feature, on) => call('admin_set_beta', { p_user: userId, p_feature: feature, p_on: !!on })

/** Запросы доступа в «Сообщениях»: заголовок обращения -> ключ (мастер выдаёт прямо из сообщения) */
export const GRANT_REQUESTS = { 'Запрос: выгрузка DXF': 'dxf' }
export const grantOfMessage = m => GRANT_REQUESTS[String(m?.title || '').trim()] || null
const GRANT_TEXT = { dxf: ['🔑 Вам выдана выгрузка DXF раскроя.', 'Выгрузка DXF раскроя отключена.'] }
/** Мастер: выдать / отключить доступ по запросу и сразу уведомить пользователя (сообщение + пуш) */
export async function grantFeature(me, profile, userId, userName, feature, on) {
  const r = await adminSetBeta(userId, feature, on)
  if (r?.error) return r
  const t = GRANT_TEXT[feature]
  if (t) await sendReply(me, profile, userId, on ? t[0] : t[1], userName || '')
  return r
}
