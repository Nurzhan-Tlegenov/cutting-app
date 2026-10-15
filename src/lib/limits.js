// Лимиты бесплатного использования (см. migration_limits.sql). Лимит — сколько чего может БЫТЬ одновременно:
// лимит заказов 3 — не больше трёх заказов в кабинете; удалил один — можно завести ещё один.
// Пороги ставит мастер-аккаунт (общие для всех и личные), на сам мастер-аккаунт они не действуют.
// Проверяет база; здесь — показать, сколько осталось, и понятно сказать, когда предел достигнут.
import { supabase } from './supabase'

export const LIMIT_KEYS = [
  ['orders', 'Заказов в кабинете', 'client', 'заказов'],
  ['models', 'Заказов с 3D-моделью', 'client', 'заказов с 3D-моделью'],
  ['materials', 'Загруженных материалов (текстур)', 'client', 'загруженных материалов'],
  ['import_mats', 'Материалов за один импорт из модели', 'client', 'материалов за один импорт', 'cap'],
  ['accepted', 'Принятых заказов (в работе)', 'production', 'принятых заказов'],
  ['views3d', 'Просмотров 3D-модели заказов в работе', 'production', 'заказов в работе с открытой 3D-моделью'],
]
// cap — предел на одно действие, а не счётчик: в строке «осталось N из M» не показывается
export const isCap = key => LIMIT_KEYS.some(([k, , , , t]) => k === key && t === 'cap')
export const LIMITS_SQL_HINT = 'Лимиты ещё не включены в базе: выполните migration_limits.sql в Supabase (SQL Editor) — один раз.'

const WHAT = Object.fromEntries(LIMIT_KEYS.map(([k, , , w]) => [k, w]))
const ADVICE = {
  orders: 'Удалите ненужный заказ — и сможете завести новый.',
  models: 'Удалите заказ с 3D-моделью, который больше не нужен, — и сможете загрузить новую.',
  materials: 'Удалите ненужный материал — и сможете загрузить новый.',
  accepted: 'Когда заказ исполнен, он уходит из списка производства — и можно принять новый.',
  views3d: 'Когда заказ исполнен, место освобождается. Открытые раньше модели смотреть можно и дальше.',
  import_mats: 'Выберите в импорте один материал; остальные можно загрузить в другие заказы.',
}

/** Текст уведомления о пределе */
export function limitText(key, limit) {
  return `Предел бесплатного использования: не больше ${limit} ${WHAT[key] || ''}.\n${ADVICE[key] || ''}\nЧтобы расширить лимит, напишите администратору приложения.`
}

/** Ошибка базы «LIMIT:ключ:порог» -> { key, limit, text } или null */
export function limitFromError(err) {
  const m = /LIMIT:(\w+):(\d+)/.exec(String(err?.message ?? err ?? ''))
  return m ? { key: m[1], limit: Number(m[2]), text: limitText(m[1], Number(m[2])) } : null
}

let cache = null, cacheAt = 0
/** Мои лимиты: { limits: { ключ: { limit, used } }, master, unlimited } или null (в базе ещё нет лимитов) */
export async function myLimits(force = false) {
  if (!force && cache && Date.now() - cacheAt < 15000) return cache
  try {
    const { data, error } = await supabase.rpc('my_limits')
    cache = error ? null : data || null
  } catch { cache = null }
  cacheAt = Date.now()
  return cache
}
export const resetLimitsCache = () => { cache = null; cacheAt = 0 }

/** Достигнут ли предел: -> { key, limit, used, text } или null */
export async function reached(key) {
  const l = (await myLimits(true))?.limits?.[key]
  if (!l || l.limit == null || l.used < l.limit) return null
  return { key, limit: l.limit, used: l.used, text: limitText(key, l.limit) }
}

// ── мастер-аккаунт ──
const call = async (fn, args) => {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) return { error: /function|schema cache|PGRST202/i.test(error.message) ? LIMITS_SQL_HINT : error.message }
  return { data }
}
export const adminLimits = () => call('admin_limits')
export const adminSetDefaultLimits = limits => call('admin_set_default_limits', { p_limits: limits })
export const adminSetUserLimits = (userId, unlimited, limits) => call('admin_set_user_limits', { p_user: userId, p_unlimited: !!unlimited, p_limits: limits || {} })
