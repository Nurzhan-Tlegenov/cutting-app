// Примечания заказа: order_note — в бланке заказа, prod_note — от производства (у статистики в заказе).
// Оба выводятся в PDF карт раскроя (стандартный вид и элементы конструктора листа). migration_order_notes.sql
import { supabase } from './supabase'

export const NOTES_SQL_HINT = 'Примечание не сохранилось: в базе нет колонки. Выполните migration_order_notes.sql в Supabase (SQL Editor) и сохраните ещё раз.'

/** Записать примечание бланка заказа (хозяин заказа). -> true / false (нет колонки) */
export async function saveOrderNote(orderId, note) {
  const v = String(note || '').trim().slice(0, 2000) || null
  const { error } = await supabase.from('orders').update({ order_note: v }).eq('id', orderId)
  return !error
}

/** Записать примечание производства. -> сохранённый текст; ошибка — исключение с понятным текстом */
export async function saveProdNote(orderId, note) {
  const { data, error } = await supabase.rpc('production_set_note', { p_order: orderId, p_note: String(note || '') })
  if (error) throw new Error(/function|schema cache|does not exist/i.test(error.message) ? NOTES_SQL_HINT : error.message)
  return data || ''
}

export const RENAME_SQL_HINT = 'Переименование пока не включено в базе: выполните migration_order_rename.sql в Supabase (SQL Editor) — один раз.'
/** Новое название заказа (производство или хозяин заказа). -> сохранённое название ('' — пусто, тогда показывается номер) */
export async function saveOrderName(orderId, name) {
  const { data, error } = await supabase.rpc('production_set_name', { p_order: orderId, p_name: String(name || '') })
  if (error) throw new Error(/function|schema cache|does not exist/i.test(error.message) ? RENAME_SQL_HINT : error.message)
  return data || ''
}
