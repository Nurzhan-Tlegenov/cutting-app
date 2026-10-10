// 3D-модель заказа в базе: таблица order_models (см. migration_order_models.sql).
// data — упакованная модель (packScene из basisB3d).
import { supabase } from './supabase'
import { limitFromError } from './limits'

/** -> { ok } или { ok: false, missing: true } если таблицы ещё нет */
export async function saveOrderModel(orderId, data) {
  if (!orderId || !data) return { ok: true }
  const { error } = await supabase.from('order_models').upsert({ order_id: orderId, data }, { onConflict: 'order_id' })
  if (!error) return { ok: true }
  const lim = limitFromError(error)
  if (lim) return { ok: false, limit: true, message: lim.text }
  const msg = String(error.message || '') + ' ' + String(error.code || '')
  return { ok: false, missing: /order_models|PGRST205|42P01|schema cache/i.test(msg), message: error.message }
}

/** -> распакованная модель или null */
export async function loadOrderModel(orderId) {
  try {
    const { data, error } = await supabase.from('order_models').select('data').eq('order_id', orderId).maybeSingle()
    if (error || !data?.data) return null
    const { unpackScene } = await import('./basisB3d')
    return unpackScene(data.data)
  } catch { return null }
}

export const MODEL_TABLE_HINT = 'Заказ сохранён, но 3D-модель целиком сохранить не удалось: в базе нет таблицы order_models. Выполните migration_order_models.sql в Supabase (SQL Editor) и импортируйте файл ещё раз. Пока в 3D будут видны только детали заказа.'
