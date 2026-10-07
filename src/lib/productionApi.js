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
export const orderClient = orderId => call('order_client', { p_order: orderId })
/** Администратор: подтвердить / отклонить производство ('approved' | 'rejected' | 'pending') */
export const adminSetProduction = (id, status) => call('admin_set_production', { p_id: id, p_status: status })
export const productionSetStatus = (orderId, status) => call('production_set_status', { p_order: orderId, p_status: status })
/** Производство возвращает заказ заказчику на доработку (заказ снова черновик). note — что поправить. -> {} | { error } */
export async function productionReturnOrder(orderId, note) {
  const r = await call('production_return_order', { p_order: orderId, p_note: note || '' })
  return r.missing ? { error: 'База ещё не обновлена: выполните migration_return_order.sql в Supabase (SQL Editor) — один раз.' } : r
}
/** Производство (или администратор) сохраняет свой вариант раскроя в оформленный на него заказ. -> {} | { error } */
export const productionSaveNesting = (orderId, value) => call('production_save_nesting', { p_order: orderId, p_value: value })
