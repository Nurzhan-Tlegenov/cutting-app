// Бета-тест новых функций (migration_beta.sql). Кто тестирует — выбирает мастер-аккаунт в «Пользователях».
// Мастер-аккаунт видит все бета-функции всегда.
import { supabase } from './supabase'

export const BETA_FEATURES = [
  ['beam_saw', 'Пильный центр'],
]
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
