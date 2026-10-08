// Прайс-лист производства и стоимость заказа (см. migration_production_prices.sql).
// Расценки видит и меняет только владелец производства. Заказчику база отдаёт готовую сумму по группам работ,
// а аккаунту со своим производством стоимость у чужого производства не отдаёт вовсе.
import { supabase } from './supabase'

export const PRICES_SQL_HINT = 'Чтобы работал прайс-лист и расчёт стоимости, выполните migration_production_prices.sql в Supabase (SQL Editor) — один раз.'
const isMissing = e => /PGRST202|PGRST205|42883|42P01|schema cache|Could not find|does not exist/i.test(String(e?.message || '') + ' ' + String(e?.code || ''))

// Операции прайс-листа: [ключ, название, единица]. Порядок — как на экране.
export const PRICE_GROUPS = [
  { id: 'cut', title: 'Распил', items: [
    ['cut_m', 'Рез', 'за метр реза'],
    ['cut_sheet', 'Раскрой листа', 'за лист'],
    ['cut_part', 'Деталь', 'за деталь'],
    ['shaped_part', 'Фигурная деталь (доплата)', 'за деталь'],
    ['cutout', 'Вырез в детали', 'за вырез'],
  ] },
  { id: 'edge', title: 'Кромление', items: [
    ['edge_m', 'Кромка прямая до 1 мм', 'за метр'],
    ['edge_thick_m', 'Кромка прямая толще 1 мм', 'за метр'],
    ['edge_curved_m', 'Кромка криволинейная', 'за метр'],
    ['edge_curved_part', 'Криволинейное кромление (доплата)', 'за деталь'],
  ] },
  { id: 'drill', title: 'Присадка и фрезеровка', items: [
    ['hole', 'Отверстие в пласть', 'за отверстие'],
    ['edge_hole', 'Отверстие в торец', 'за отверстие'],
    ['groove_m', 'Паз', 'за метр'],
    ['pocket', 'Выемка', 'за выемку'],
  ] },
  { id: 'other', title: 'Прочее', items: [
    ['label', 'Маркировка (бирка)', 'за деталь'],
  ] },
]
export const GROUP_TITLE = Object.fromEntries(PRICE_GROUPS.map(g => [g.id, g.title]))
const LINE_TITLE = { ...Object.fromEntries(PRICE_GROUPS.flatMap(g => g.items.map(([k, t]) => [k, t]))), cut_tiers: 'Раскрой листа (по числу деталей)' }
const LINE_UNIT = { cut_m: 'м', cut_sheet: 'л.', cut_tiers: 'л.', cut_part: 'дет.', shaped_part: 'дет.', cutout: 'шт.', edge_m: 'м', edge_thick_m: 'м', edge_curved_m: 'м', edge_curved_part: 'дет.', hole: 'шт.', edge_hole: 'шт.', groove_m: 'м', pocket: 'шт.', label: 'дет.' }
export const lineTitle = key => LINE_TITLE[key] || key
export const lineUnit = key => LINE_UNIT[key] || ''

export const money = (v, cur) => `${(Math.round(Number(v) * 100) / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })}${cur ? ' ' + cur : ''}`

/** Прайс-лист своего производства. -> { data } | { error, missing } */
export async function loadPrices(productionId) {
  try {
    const { data, error } = await supabase.from('production_prices').select('data').eq('production_id', productionId).maybeSingle()
    if (error) return { error: isMissing(error) ? PRICES_SQL_HINT : error.message, missing: isMissing(error) }
    return { data: data?.data || {} }
  } catch (e) { return { error: String(e?.message || e) } }
}
export async function savePrices(productionId, data) {
  try {
    const { error } = await supabase.from('production_prices').upsert({ production_id: productionId, data, updated_at: new Date().toISOString() })
    if (error) return { error: isMissing(error) ? PRICES_SQL_HINT : error.message }
    return {}
  } catch (e) { return { error: String(e?.message || e) } }
}

/**
 * Стоимость работ производства по статистике раскроя (statsPayload).
 * -> null (цены скрыты или база не обновлена) | { empty: true } (прайс не заполнен или выключен) | { own, currency, total, min_applied, lines | groups }
 */
export async function fetchQuote(productionId, payload) {
  if (!productionId) return null
  try {
    const { data, error } = await supabase.rpc('production_quote', { p_production: productionId, p_stats: payload })
    if (error || !data || data.hidden) return null
    return data
  } catch { return null }
}

/** Зафиксировать цену заказа при оформлении (по прайс-листу производства на этот момент). Ошибки не мешают оформлению. */
export async function fixOrderQuote(orderId, payload) {
  try { await supabase.rpc('fix_order_quote', { p_order: orderId, p_stats: payload }) } catch { /* цена просто не зафиксируется */ }
}
/** Зафиксированная цена заказа. -> null (не фиксировалась, скрыта или база не обновлена) | { fixed: true, at, ...как у fetchQuote } */
export async function fetchFixedQuote(orderId) {
  if (!orderId) return null
  try {
    const { data, error } = await supabase.rpc('order_quote', { p_order: orderId })
    if (error || !data || data.none) return null
    return data
  } catch { return null }
}

