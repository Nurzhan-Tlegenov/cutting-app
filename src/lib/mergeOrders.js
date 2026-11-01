// Объединённый раскрой: несколько заказов клиента — один раскрой (экономия листов).
//
// Объединение — это отдельный заказ (orders.merge_of = список заказов-источников), в который детали
// заказов-источников копируются. Дальше с ним работает всё как с обычным заказом: раскрой по материалам,
// смета (одна, общая — сумма по всем заказам), отправка на производство, ЧПУ, бирки.
// Сами заказы-источники не меняются (orders.merged_into — только пометка), их можно раскроить отдельно —
// например, чтобы увидеть смету одного заказа.
//
// У каждой скопированной детали в contour.meta:
//   material / thickness — чем режем (после «Объединить материал» — выбранный материал),
//   srcMat   — материал детали в её заказе («имя|толщина»), чтобы объединение материалов можно было отменить,
//   srcOrder — { id, number, name, seq }: из какого заказа деталь; seq — номер заказа в объединении (1, 2, 3…).
// Обозначение детали начинается с номера заказа в объединении: «1·БОК», «2·БОК» — без конфликта одинаковых позиций.
// На бирке «Заказ» — заказ самой детали (labelMaker → labelInfo).
import { supabase } from './supabase'
import { fetchOrderDetails, insertOrderDetails } from './orderDetails'
import { detailMatKey } from './detailMaterial'
import { detailMeta } from './partLabel'
import { getNextOrderNumber, orderTitle } from './orderUtils'

export const MERGE_FEATURE = 'merge_nesting'
export const MERGE_SQL_HINT = 'Объединённый раскрой ещё не включён в базе: выполните migration_merge_nesting.sql в Supabase (SQL Editor) — один раз.'
const missingCol = e => /merge_of|merged_into|schema cache|PGRST204|42703/i.test(`${e?.message || ''} ${e?.code || ''}`)

/** Список заказов объединения [{ id, number, name, seq, sig }] (у обычного заказа — пусто) */
export function mergeList(order) {
  let v = order?.merge_of
  if (typeof v === 'string') { try { v = JSON.parse(v) } catch { v = null } }
  return Array.isArray(v) ? v.filter(x => x && x.id) : []
}
export const isMerged = order => mergeList(order).length > 0

/** Подпись заказа-источника в объединении: «1 — №261101_001 Кухня» */
export const srcOrderLabel = s => `${s.seq} — №${s.number || '?'}${s.name ? ` ${s.name}` : ''}`

/** Из какого заказа деталь (в объединении) — { id, number, name, seq } или null */
export function detailSrcOrder(d) {
  const s = detailMeta(d)?.srcOrder
  return s && s.id ? s : null
}

// «Подпись» деталей заказа: поменяли деталировку после объединения — объединение надо обновить
export function detailsSig(rows) {
  let h = 0
  const str = (rows || []).map(r => [r.id, r.length, r.width, r.qty, r.rotatable ? 1 : 0, r.edge_top, r.edge_right, r.edge_bottom, r.edge_left, String(r.contour || '').length].join(':')).join('|')
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0
  return `${(rows || []).length}_${(h >>> 0).toString(36)}`
}

const parseContour = c => {
  if (!c) return {}
  if (typeof c === 'object') return { ...c }
  try { const v = JSON.parse(c); return v && typeof v === 'object' ? v : {} } catch { return {} }
}
const splitKey = k => { const i = String(k).lastIndexOf('|'); return i < 0 ? [String(k), ''] : [k.slice(0, i), k.slice(i + 1)] }
const thickOf = t => (t !== '' && t != null && isFinite(Number(t)) ? Number(t) : undefined)

// Копия детали заказа-источника для объединения
function copyRow(r, src, s, mergedId) {
  const { id: _i, created_at: _c, order_id: _o, _parsedContour: _p, ...cols } = r
  void _i; void _c; void _o; void _p
  const key = detailMatKey(r, src)
  const [name, thick] = splitKey(key)
  const c = parseContour(r.contour)
  c.meta = { ...(c.meta || {}), material: name, thickness: thickOf(thick), srcMat: key, srcOrder: { id: s.id, number: s.number, name: s.name, seq: s.seq }, srcDetail: r.id }
  const pfx = String(r.prefix || '').trim()
  const nm = String(r.name || '').trim()
  const prefix = pfx ? `${s.seq}·${pfx}` : ''
  return { ...cols, order_id: mergedId, prefix, display_name: pfx ? `${prefix} ${nm || 'Деталь'}` : `${s.seq}·${nm || 'Деталь'}`, contour: JSON.stringify(c) }
}

/**
 * Объединить заказы в один раскрой. orders — строки orders (свои черновики), productionId — общее производство.
 * -> { order } | { error }
 */
export async function createMergedOrder(orders, productionId = null, onProgress) {
  const list = [...orders].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
  const srcs = []
  const rowsBy = []
  for (const [i, o] of list.entries()) {
    const { data, error } = await fetchOrderDetails(o.id)
    if (error) return { error: `Заказ ${orderTitle(o)}: ${error.message}` }
    rowsBy.push(data || [])
    srcs.push({ id: o.id, number: o.order_number || '', name: String(o.order_name || '').trim(), seq: i + 1, sig: detailsSig(data) })
  }
  if (!rowsBy.some(r => r.length)) return { error: 'В выбранных заказах нет деталей.' }
  const base = list[0]
  const row = {}
  for (const [c, v] of Object.entries(base)) {
    if (c === 'id' || c === 'order_number' || c === 'status' || c.endsWith('_at') || c === 'archived_by' || c === 'archived_sheets'
      || c === 'return_note' || c === 'nesting_result' || c === 'merged_into' || c === 'merge_of' || c === 'offcuts_owner') continue
    row[c] = v
  }
  const title = `Объединение: ${list.map(o => o.order_number || orderTitle(o)).join(' + ')}`
  Object.assign(row, {
    order_number: await getNextOrderNumber(supabase), status: 'draft', nesting_result: null,
    order_name: title.length > 120 ? title.slice(0, 117) + '…' : title,
    production_id: productionId ?? base.production_id ?? null,
    merge_of: srcs,
  })
  const { data: made, error: e1 } = await supabase.from('orders').insert(row).select().single()
  if (e1 || !made) {
    if (missingCol(e1)) return { error: MERGE_SQL_HINT }
    return { error: /limit/i.test(e1?.message || '') ? 'Достигнут предел бесплатного использования: заказов слишком много. Удалите или отправьте в архив ненужные.' : (e1?.message || 'Не удалось создать объединённый раскрой') }
  }
  const copies = rowsBy.flatMap((rows, i) => rows.map(r => copyRow(r, list[i], srcs[i], made.id)))
    .map((r, k) => ({ ...r, sort_order: k }))
  const { error: e2 } = await insertOrderDetails(copies, onProgress)
  if (e2) { await supabase.from('orders').delete().eq('id', made.id); return { error: e2.message } }
  await supabase.from('orders').update({ merged_into: made.id }).in('id', list.map(o => o.id))
  return { order: made }
}

// Запись contour у многих деталей — по несколько запросов одновременно
async function writeContours(patches, onProgress) {
  let done = 0, err = null
  const queue = [...patches]
  const worker = async () => {
    while (queue.length && !err) {
      const p = queue.shift()
      const { error } = await supabase.from('order_details').update({ contour: p.contour }).eq('id', p.id)
      if (error) err = error
      onProgress?.(++done, patches.length)
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker))
  return { error: err }
}

/**
 * Объединить материалы (ключи «имя|толщина») в один — «чем режем» (cutKey).
 * rows — детали объединения, order — сам заказ объединения. -> { error } | {}
 */
export async function mergeMaterials(rows, order, keys, cutKey, onProgress) {
  const set = new Set(keys)
  const [name, thick] = splitKey(cutKey)
  const patches = []
  for (const r of rows) {
    const k = detailMatKey(r, order)
    if (!set.has(k)) continue
    const c = parseContour(r.contour)
    c.meta = { ...(c.meta || {}), srcMat: c.meta?.srcMat || k, material: name, thickness: thickOf(thick) }
    patches.push({ id: r.id, contour: JSON.stringify(c) })
  }
  return writeContours(patches, onProgress)
}

/** Объединённые материалы: [{ key, label, sources: [ключи исходных материалов] }] — где есть детали с другим исходным материалом */
export function mergedGroups(rows, order) {
  const map = new Map()
  for (const r of rows || []) {
    const k = detailMatKey(r, order), src = detailMeta(r)?.srcMat || k
    if (!map.has(k)) map.set(k, new Set())
    map.get(k).add(src)
  }
  return [...map.entries()].filter(([k, s]) => s.size > 1 || (s.size === 1 && !s.has(k))).map(([key, s]) => ({ key, sources: [...s] }))
}

/** Разъединить материал key: каждой детали — её исходный материал */
export async function unmergeMaterial(rows, order, key, onProgress) {
  const patches = []
  for (const r of rows) {
    if (detailMatKey(r, order) !== key) continue
    const c = parseContour(r.contour)
    const src = c.meta?.srcMat
    if (!src || src === key) continue
    const [name, thick] = splitKey(src)
    c.meta = { ...(c.meta || {}), material: name, thickness: thickOf(thick) }
    patches.push({ id: r.id, contour: JSON.stringify(c) })
  }
  return writeContours(patches, onProgress)
}

/** Какие заказы-источники поменялись после объединения: -> [seq] (удалённые тоже) */
export async function staleSources(order) {
  const out = []
  for (const s of mergeList(order)) {
    const { data, error } = await fetchOrderDetails(s.id)
    if (error) continue
    if (!data?.length) { const { data: o } = await supabase.from('orders').select('id').eq('id', s.id).maybeSingle(); if (!o) { out.push(s.seq); continue } }
    if (s.sig && detailsSig(data) !== s.sig) out.push(s.seq)
  }
  return out
}

/**
 * Перечитать детали из заказов-источников (их поменяли после объединения). Объединение материалов сохраняется:
 * исходный материал → материал, которым режем, как было. Раскрой сбрасывается. -> { error } | {}
 */
export async function refreshMerged(order, rows, onProgress) {
  const cutBySrc = new Map()
  for (const r of rows || []) { const m = detailMeta(r); if (m?.srcMat) cutBySrc.set(m.srcMat, detailMatKey(r, order)) }
  const srcs = []
  const copies = []
  for (const s of mergeList(order)) {
    const { data: o } = await supabase.from('orders').select('*').eq('id', s.id).maybeSingle()
    if (!o) continue                                       // заказ удалён — его детали уходят из объединения
    const { data, error } = await fetchOrderDetails(s.id)
    if (error) return { error: error.message }
    const ns = { id: o.id, number: o.order_number || '', name: String(o.order_name || '').trim(), seq: s.seq, sig: detailsSig(data) }
    srcs.push(ns)
    for (const r of data || []) {
      const c = copyRow(r, o, ns, order.id)
      const cut = cutBySrc.get(detailMatKey(r, o))
      if (cut) {
        const cc = JSON.parse(c.contour), [name, thick] = splitKey(cut)
        cc.meta = { ...cc.meta, material: name, thickness: thickOf(thick) }
        c.contour = JSON.stringify(cc)
      }
      copies.push(c)
    }
  }
  if (!copies.length) return { error: 'В заказах объединения не осталось деталей.' }
  const fresh = copies.map((r, k) => ({ ...r, sort_order: k }))
  const { error: e1 } = await insertOrderDetails(fresh, onProgress)
  if (e1) return { error: e1.message }
  const old = (rows || []).map(r => r.id)
  for (let i = 0; i < old.length; i += 200) {
    const { error } = await supabase.from('order_details').delete().in('id', old.slice(i, i + 200))
    if (error) return { error: error.message }
  }
  const { error: e2 } = await supabase.from('orders').update({ merge_of: srcs, nesting_result: null }).eq('id', order.id)
  return e2 ? { error: e2.message } : {}
}
