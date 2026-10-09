// Кабинет производства (см. migration_production_cabinet.sql): своё производство, заявки, статусы.
import { supabase } from './supabase'

const isMissing = e => /PGRST202|42883|schema cache|Could not find the function/i.test(String(e?.message || '') + ' ' + String(e?.code || ''))
export const PROD_SQL_HINT = 'База ещё не обновлена: выполните migration_security_all.sql в Supabase (SQL Editor) — один раз.'

async function call(fn, args) {
  try {
    const { data, error } = await supabase.rpc(fn, args)
    if (error) return { error: isMissing(error) ? PROD_SQL_HINT : error.message, missing: isMissing(error) }
    return { data }
  } catch (e) { return { error: String(e?.message || e) } }
}

/** Моё производство; null — его нет; undefined — в базе ещё нет кабинета производства (миграция не выполнена) */
export async function myProduction(userId) {
  if (!userId) return null
  try {
    const { data, error } = await supabase.from('productions').select('*').eq('owner_id', userId).maybeSingle()
    return error ? undefined : data || null
  } catch { return undefined }
}
/** Зарегистрировать или обновить своё производство. sheet — { kerf, ml, mr, mt, mb } (необязательно). -> { id } | { error } */
export async function registerProduction({ name, phone, city, country }, sheet = {}) {
  const num = v => (v === '' || v == null || !isFinite(Number(v)) ? null : Number(v))
  const r = await call('register_production', { p_name: name || '', p_phone: phone || '', p_city: city || '', p_kerf: num(sheet.kerf), p_ml: num(sheet.ml), p_mr: num(sheet.mr), p_mt: num(sheet.mt), p_mb: num(sheet.mb), p_country: country || '' })
  if (r.error) return { error: /bad name/.test(r.error) ? 'Введите название производства' : /bad country/.test(r.error) ? 'Укажите страну' : r.error }
  return { id: r.data }
}
export const productionOrders = () => call('production_orders')
/**
 * Статистика своего производства (migration_production_stats.sql): лёгкие строки всех заказов, оформленных на производство, —
 * статус, даты, листы, детали, зафиксированная сумма, объёмы работ; вместе с уже удалёнными (от них осталась запись истории).
 */
export const STATS_SQL_HINT = 'Статистика за период и архив производства ещё не включены: выполните migration_production_stats.sql в Supabase (SQL Editor) — один раз.'
export async function productionStats() { const r = await call('production_stats'); return r.missing ? { error: STATS_SQL_HINT, missing: true } : r }
/** Производство убирает исполненный заказ из своих списков (on = false — возвращает). Заказ клиента не меняется. -> { at } | { error } */
export async function productionArchive(orderId, on = true) {
  const r = await call('production_archive_order', { p_order: orderId, p_on: on })
  return r.error ? { error: r.missing ? STATS_SQL_HINT : r.error } : { at: r.data }
}
export const orderClient = orderId => call('order_client', { p_order: orderId })
/** Администратор: подтвердить / отклонить производство ('approved' | 'rejected' | 'pending') */
export const adminSetProduction = (id, status) => call('admin_set_production', { p_id: id, p_status: status })
export const productionSetStatus = (orderId, status) => call('production_set_status', { p_order: orderId, p_status: status })
/** Производство возвращает заказ заказчику на доработку (заказ снова черновик). note — что поправить. -> {} | { error } */
export async function productionReturnOrder(orderId, note) {
  const r = await call('production_return_order', { p_order: orderId, p_note: note || '' })
  return r.missing ? { error: 'База ещё не обновлена: выполните migration_return_order.sql в Supabase (SQL Editor) — один раз.' } : r
}
/**
 * Пометка на заказе для кабинета производства: 'gcode' — создан G-код, 'files' — файлы сохранены (выгружены).
 * Пока в базе нет migration_production_marks.sql — молча ничего не делает. -> { at } | { error }
 */
export async function productionMark(orderId, what) {
  const r = await call('production_mark', { p_order: orderId, p_what: what })
  return r.error ? r : { at: new Date().toISOString() }
}
export const MARKS_SQL_HINT = 'Чтобы на заказах были пометки «G-код создан» и «файлы сохранены», выполните migration_production_marks.sql в Supabase (SQL Editor) — один раз.'
/** Пометки заказа одной строкой-списком: [{ text, on }] */
export function orderMarks(o) {
  const d = v => new Date(v).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
  return [
    { key: 'gcode', short: 'G-код', on: !!o?.gcode_at, text: o?.gcode_at ? `G-код создан · ${d(o.gcode_at)}` : 'G-код не создан' },
    { key: 'files', short: 'Файлы', on: !!o?.files_saved_at, text: o?.files_saved_at ? `Файлы сохранены · ${d(o.files_saved_at)}` : 'Файлы не сохранены' },
  ]
}
/** Производство (или администратор) сохраняет свой вариант раскроя в оформленный на него заказ. -> {} | { error } */
export const productionSaveNesting = (orderId, value) => call('production_save_nesting', { p_order: orderId, p_value: value })
