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
    ['upil', 'Упил узкой детали', 'за упил (узкую деталь пилят шире, после кромки упиливают в размер)'],
    ['upil_m', 'Упил узкой детали (по метрам)', 'за метр упила — можно вместо цены за штуку или вместе с ней'],
    ['shaped_part', 'Фигурная деталь (доплата)', 'за деталь'],
    ['cutout', 'Вырез в детали', 'за вырез'],
  ] },
  { id: 'edge', title: 'Кромление', items: [
    ['edge_m', 'Кромка прямая до 1 мм', 'за метр'],
    ['edge_thick_m', 'Кромка прямая толще 1 мм', 'за метр'],
    ['edge_curved_m', 'Кромка криволинейная', 'за метр'],
    ['edge_curved_part', 'Криволинейное кромление (доплата)', 'за деталь'],
  ] },
  { id: 'glue', title: 'Склейка', items: [
    ['glue_m2', 'Склейка', 'за м² склеенной детали (площадь по одной стороне)'],
    ['glue_part', 'Склейка (за штуку)', 'за склеенную деталь — можно вместо цены за м² или вместе с ней'],
    ['edge_wide_m', 'Широкая кромка (на склейке)', 'за метр; пусто — кромка склеенных деталей по цене обычной'],
    ['edge_wide_part', 'Широкая кромка (за деталь)', 'за склеенную деталь с кромкой'],
  ] },
  { id: 'drill', title: 'Присадка и фрезеровка', items: [
    ['hole', 'Отверстие в пласть', 'за отверстие'],
    ['edge_hole', 'Отверстие в торец', 'за отверстие'],
    ['drill_m2', 'Присадка за м² — кухни, ванные (мелкие детали)', 'за м² площади всех деталей заказа; в заказе можно выбрать «Без присадки»'],
    ['drill_m2_large', 'Присадка за м² — шкафы (крупные детали)', 'за м²; заполнены обе цены — клиент выбирает тип изделия, пусто — одна цена для всех'],
    ['groove_m', 'Паз', 'за метр'],
    ['groove_narrow', 'Паз до 4 мм шириной', 'за паз (обычно под ХДФ) — можно вместо цены за метр или вместе с ней'],
    ['groove_wide', 'Паз шире 4 мм', 'за паз'],
    ['pocket', 'Выемка', 'за выемку'],
  ] },
  { id: 'other', title: 'Прочее', items: [
    ['label', 'Маркировка (бирка)', 'за деталь'],
  ] },
]
// ХДФ / ДВП (задние стенки, пила): свои цены распила. Пустая цена — как у плиты (migration_hdf_prices.sql)
export const HDF_ITEMS = [
  ['hdf_cut_m', 'Рез', 'за метр реза', 'cut_m'],
  ['hdf_cut_sheet', 'Раскрой листа', 'за лист', 'cut_sheet'],
  ['hdf_cut_part', 'Деталь', 'за деталь', 'cut_part'],
]
// Цены по толщине плиты (раскрой листа, кромка, разгрузка) и по диаметру отверстия (migration_price_thickness.sql)
export const PLATE_CLASSES = [['16', 'до 16 мм'], ['18', '17–21 мм'], ['22', '22–29 мм'], ['30', '30 мм и толще']]
export const EDGE_CLASSES = [['a', 'до 0,5'], ['b', '0,5–1,5'], ['c', 'толще 1,5']]
export const HOLE_CLASSES = [['a', 'Ø до 10'], ['b', 'Ø 11–32'], ['c', 'Ø 33–40'], ['d', 'Ø больше 40']]
const PL = Object.fromEntries(PLATE_CLASSES), EL = Object.fromEntries(EDGE_CLASSES)
export const GROUP_TITLE = { ...Object.fromEntries(PRICE_GROUPS.map(g => [g.id, g.title])), other: 'Прочее' }
const LINE_TITLE = { ...Object.fromEntries(PRICE_GROUPS.flatMap(g => g.items.map(([k, t]) => [k, t]))), cut_tiers: 'Раскрой листа (по числу деталей)',
  hdf_cut_m: 'Рез ХДФ', hdf_cut_sheet: 'Раскрой листа ХДФ', hdf_cut_tiers: 'Раскрой листа ХДФ (по числу деталей)', hdf_cut_part: 'Деталь ХДФ' }
const LINE_UNIT = { cut_m: 'м', cut_sheet: 'л.', cut_tiers: 'л.', cut_part: 'дет.', upil: 'шт.', upil_m: 'м', shaped_part: 'дет.', cutout: 'шт.', edge_m: 'м', edge_thick_m: 'м', edge_curved_m: 'м', edge_curved_part: 'дет.', hole: 'шт.', edge_hole: 'шт.', drill_m2: 'м²', drill_m2_large: 'м²', groove_m: 'м', groove_narrow: 'шт.', groove_wide: 'шт.', pocket: 'шт.', label: 'дет.', glue_m2: 'м²', glue_part: 'дет.', edge_wide_m: 'м', edge_wide_part: 'дет.', hdf_cut_m: 'м', hdf_cut_sheet: 'л.', hdf_cut_tiers: 'л.', hdf_cut_part: 'дет.' }
export const lineTitle = key => {
  if (LINE_TITLE[key]) return LINE_TITLE[key]
  let m = /^cut_sheet_(\d+)$/.exec(key); if (m) return `Раскрой листа ${PL[m[1]] || m[1]}`
  m = /^unload_(\d+)$/.exec(key); if (m) return `Разгрузка, лист ${PL[m[1]] || m[1]}`
  m = /^edge_(\d+)_([abc])$/.exec(key); if (m) return `Кромка ${EL[m[2]]} мм · плита ${PL[m[1]] || m[1]}`
  m = /^(edge_)?hole_([dr]):(.+)$/.exec(key); if (m) return `Отверстие ${m[1] ? 'в торец' : 'в пласть'} Ø${String(m[3]).replace(/\./g, ',').replace('-', '–')}`
  m = /^hole_([abcd])$/.exec(key); if (m) return `Отверстие в пласть ${Object.fromEntries(HOLE_CLASSES)[m[1]]}`
  return key
}
export const lineUnit = key => LINE_UNIT[key] || (/^(cut_sheet|unload)_/.test(key) ? 'л.' : /^edge_\d+_/.test(key) ? 'м' : /^(edge_)?hole_/.test(key) ? 'шт.' : '')
/** Клиенты производства — для категорий «розница» / «постоянный» (migration_price_thickness.sql) -> { data } | { error } */
export async function productionClients(productionId) {
  try {
    const { data, error } = await supabase.rpc('production_client_list', { p_prod: productionId })
    if (error) return { error: isMissing(error) ? 'Список клиентов появится после migration_price_thickness.sql в Supabase.' : error.message }
    return { data: data || [] }
  } catch (e) { return { error: String(e?.message || e) } }
}

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
/**
 * Зафиксированная цена, но присадка за м² в ней посчитана по-старому (по площади только деталей с присадкой, до 26.10.2026),
 * — один раз пересчитать по общей площади деталей. Делает это производство (своя цена), остальное в цене — как есть сейчас.
 * -> обновлённая цена или та же
 */
export async function freshFixedQuote(orderId, q, payload) {
  if (!q || !q.own || !Array.isArray(q.lines) || !payload) return q
  const dl = q.lines.find(l => l.key === 'drill_m2' || l.key === 'drill_m2_large')
  const want = Number(payload.drill_m2) || 0
  // присадки в цене нет, а должна быть (список из Excel без отверстий, цена зафиксирована до 26.10.2026) — тоже пересчитать;
  // только старые цены: после пересчёта дата новая, и повторно не трогаем
  const old = !q.at || new Date(q.at).getTime() < Date.parse('2026-10-26T09:30:00Z')
  if (dl ? Math.abs((Number(dl.qty) || 0) - want) < 0.05 : !(want > 0 && old)) return q
  await fixOrderQuote(orderId, payload)
  return (await fetchFixedQuote(orderId)) || q
}
export async function fetchFixedQuote(orderId) {
  if (!orderId) return null
  try {
    const { data, error } = await supabase.rpc('order_quote', { p_order: orderId })
    if (error || !data || data.none) return null
    return data
  } catch { return null }
}

