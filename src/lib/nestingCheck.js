// Проверка СОХРАНЁННОГО раскроя заказа — последний рубеж перед производством.
// Раскрой с пересечением деталей, с зазором меньше ширины реза или с деталью на отступе от края листа — это брак.
// Такой раскрой нельзя ни принять в работу, ни пустить в ЧПУ: заказ нужно вернуть на доработку и переложить.
import { validateNesting } from './validateNesting'
import { sheetGeo, savedNestings } from './savedNesting'
import { supabase } from './supabase'

// только геометрия, из-за которой получается брак (пропавшие детали, поворот текстуры и т. п. здесь не блокируют)
const FATAL = /пересекаются|зазор|заходит на отступ/

/** mats — раскрои по материалам (как savedNestings). -> [строки ошибок] (пусто — раскрой годен) */
export function nestingFaults(order, mats) {
  const out = []
  for (const mat of mats || []) {
    if (!mat?.sheets?.length) continue
    const geo = sheetGeo(order, mat.result)
    let r
    try {
      r = validateNesting({ sheets: mat.sheets, details: mat.details || [], usableX: geo.usableX, usableY: geo.usableY, kerf: geo.kerf, cuttingMethod: 'nesting' })
    } catch { continue }                       // проверка не должна ронять страницу
    const tag = (mats.length > 1 && mat.label) ? `${mat.label} — ` : ''
    for (const e of r.errors) if (FATAL.test(e)) out.push(tag + e)
  }
  return out
}

export const FAULT_TITLE = 'В раскрое нарушена ширина реза или детали пересекаются — по нему получится брак'

/** То же по номеру заказа (когда на экране нет его раскроя): -> [строки ошибок]; не удалось прочитать — [] */
export async function orderFaults(orderId) {
  try {
    const [{ data: order }, { data: details }] = await Promise.all([
      supabase.from('orders').select('*').eq('id', orderId).single(),
      supabase.from('order_details').select('*').eq('order_id', orderId).order('sort_order'),
    ])
    if (!order) return []
    return nestingFaults(order, savedNestings(order, details || []))
  } catch { return [] }
}

/** Текст для окна-сообщения */
export const faultText = (faults, tail) => `${FAULT_TITLE}:\n\n${faults.slice(0, 8).map(f => '• ' + f).join('\n')}${faults.length > 8 ? `\n…и ещё ${faults.length - 8}` : ''}\n\n${tail}`
