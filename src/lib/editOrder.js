// «Редактировать заказ» для заказчика — одна и та же кнопка во всех окнах заказа.
//   черновик                      — сразу открывается редактирование;
//   отправлен, но ещё не принят   — с подтверждением заказ отзывается с производства (снова черновик) и открывается;
//   принят в работу или исполнен  — править нельзя: нужно, чтобы производство вернуло заказ на доработку.
import { supabase } from './supabase'

export const EDIT_BTN = { flexShrink: 0, padding: '4px 12px', borderRadius: 20, fontSize: 12, background: 'transparent', border: '0.5px solid var(--blue-mid)', color: 'var(--blue)', cursor: 'pointer', whiteSpace: 'nowrap' }

/** Может ли этот человек править заказ (свой заказ или администратор) */
export const canEditOrder = (order, user, profile) => !!order && (!order.user_id || order.user_id === user?.id || profile?.role === 'admin')

/** Открыть заказ на редактирование. -> true, если перешли в редактирование */
export async function openOrderEdit(order, navigate) {
  if (!order) return false
  if (order.status !== 'draft') {
    if (order.status === 'inwork' || order.status === 'done') {
      window.alert(order.status === 'done'
        ? 'Заказ уже исполнен — изменить его нельзя.'
        : 'Заказ уже принят производством в работу. Чтобы изменить его, попросите производство вернуть заказ на доработку — после этого он снова откроется для правки.')
      return false
    }
    if (!window.confirm('Заказ уже отправлен на производство.\n\nОтозвать его и открыть для редактирования? После правок заказ нужно будет отправить заново.')) return false
    const { error } = await supabase.from('orders').update({ status: 'draft' }).eq('id', order.id)
    if (error) { window.alert('Не удалось отозвать заказ: ' + error.message); return false }
  }
  navigate(`/orders/${order.id}/edit`)
  return true
}
