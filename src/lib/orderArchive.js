// Архив заказов (migration_order_archive.sql).
// Исполненный заказ отправляется в архив: 3D-модель и карта раскроя удаляются сразу, остаются детали с контурами,
// кромкой и присадкой — заказ можно восстановить и разложить заново. В архиве заказ хранится KEEP_MONTHS месяцев,
// потом удаляется сам; в общей статистике остаётся строка истории. Заказы мастер-аккаунта сами не удаляются.
import { supabase } from './supabase'

export const KEEP_MONTHS = 3
export const ARCHIVE_SQL_HINT = 'Архив ещё не включён: выполните migration_order_archive.sql в Supabase (SQL Editor) — один раз.'
const missing = e => /PGRST202|42883|schema cache|Could not find the function/i.test(`${e?.message || ''} ${e?.code || ''}`)

async function call(fn, args) {
  try {
    const { data, error } = await supabase.rpc(fn, args)
    if (error) return { error: missing(error) ? ARCHIVE_SQL_HINT : /not done/.test(error.message) ? 'В архив можно отправить только исполненный заказ' : error.message }
    return { data }
  } catch (e) { return { error: String(e?.message || e) } }
}

/** До какого дня заказ хранится в архиве */
export function keepUntil(archivedAt) {
  const d = new Date(archivedAt)
  d.setMonth(d.getMonth() + KEEP_MONTHS)
  return d
}
export const keepUntilText = archivedAt => keepUntil(archivedAt).toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' })
export const daysLeft = archivedAt => Math.max(0, Math.ceil((keepUntil(archivedAt) - Date.now()) / 864e5))

/** Спросить и отправить в архив. -> { at } | { error } | null (отказались) */
export async function archiveOrder(order, title) {
  if (!window.confirm(`Отправить заказ «${title}» в архив?\n\n• 3D-модель и карта раскроя удалятся сразу.\n• Детали, контуры, кромка и присадка останутся — заказ можно восстановить и разложить заново.\n• В архиве заказ хранится ${KEEP_MONTHS} месяца, потом удаляется полностью.`)) return null
  const r = await call('archive_order', { p_order: order.id })
  return r.error ? r : { at: r.data || new Date().toISOString() }
}
export const restoreOrder = id => call('restore_order', { p_order: id })

/** Удалить заказы, у которых вышел срок хранения в архиве. Вызывается при входе; ошибки не важны. */
export async function purgeArchived() {
  try { await supabase.rpc('purge_archived_orders') } catch { /* архив ещё не включён */ }
}
/** Пометки архива для списка заказов производства: Map(id -> archived_at). Нет колонки в базе — пустая Map. */
export async function archivedMap(ids) {
  const m = new Map()
  if (!ids?.length) return m
  try {
    const { data, error } = await supabase.from('orders').select('id, archived_at').in('id', ids).not('archived_at', 'is', null)
    if (!error) (data || []).forEach(o => m.set(o.id, o.archived_at))
  } catch { /* без архива */ }
  return m
}
