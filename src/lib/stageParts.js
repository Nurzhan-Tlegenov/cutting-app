// Детали заказа на рабочем посту: какие идут через пост (по правилу поста) и сопоставление кода с бирки с деталью.
import { supabase } from './supabase'
import { panelXml } from './drill6Xml'
import { cutDetails, parseEdgeTypes, edgeKey, rawDetail } from './edgeCut'
import { detailMeta } from './partLabel'
import { savedNestings } from './savedNesting'
import { labelInfo, labelQr } from './labelMaker'
import { toLatin } from './orderUtils'

// Правило поста: list — какие детали; для присадки — что учитывать (отверстия сверху, снизу, в торцы, пазы, фрезеровки).
export const RULE_LISTS = [['all', 'Все детали'], ['edge', 'С кромкой'], ['drill', 'С присадкой'], ['none', 'Без списка деталей']]
export const DRILL_KEYS = [['top', 'отверстия сверху (лицевая)'], ['bottom', 'отверстия снизу'], ['edge', 'отверстия в торцы'], ['grooves', 'пазы'], ['mills', 'фрезеровки, вырезы, выемки']]
/** Правило по умолчанию — по названию поста */
export function defaultRule(name) {
  const n = String(name || '').toLowerCase()
  if (/присад|сверл|drill/.test(n)) return { list: 'drill', top: false, bottom: true, edge: true, grooves: false, mills: false }   // отверстия сверху сделал фрезер
  if (/кром|edge/.test(n)) return { list: 'edge' }
  if (/достав|deliver|отгруз/.test(n)) return { list: 'none' }
  return { list: 'all' }
}
export const ruleOf = (rule, name) => (rule && rule.list ? rule : defaultRule(name))
/** Пост по умолчанию — раскрой, кромление, присадка: заказ проходит его всегда (без галочки в заказе) */
export const isBasePost = name => /(раскр|распил|кром|присад|сверл)/i.test(String(name || ''))
/** Пост «по галочке в заказе» — сборка, установка, упаковка и любые свои посты. Как post_on_demand в базе */
export function onDemandOf(rule, name) {
  if (isBasePost(name)) return false
  return rule && typeof rule.onDemand === 'boolean' ? rule.onDemand : true
}
export function ruleText(rule) {
  if (rule.list === 'none') return 'без списка деталей'
  if (rule.list === 'edge') return rule.sides ? 'детали с кромкой, счёт по сторонам' : 'детали с кромкой'
  if (rule.list === 'drill') { const on = DRILL_KEYS.filter(([k]) => rule[k]).map(([, l]) => l); return on.length ? `детали, у которых есть: ${on.join(', ')}` : 'ничего не выбрано' }
  return 'все детали заказа'
}

const n0 = v => Number(v) || 0
const r1 = v => String(Math.round(n0(v) * 10) / 10)
const SIDES = ['left', 'right', 'top', 'bottom']
/** Фигурная (криволинейная) деталь — у контура есть свои вершины; отверстия и пазы деталь фигурной не делают */
export function isShaped(d) {
  if (!d?.contour) return false
  try { const c = typeof d.contour === 'string' ? JSON.parse(d.contour) : d.contour; return Array.isArray(c?.vertices) && c.vertices.length > 2 } catch { return false }
}
/** Сколько прямых сторон с кромкой у прямолинейной детали (у фигурной — 0: кромка там по участкам контура) */
export const edgedSides = d => (isShaped(d) ? 0 : SIDES.filter(s => edgeKey(d['edge_' + s])).length)

/** Детали поста: [{ id, name, des, pos, size, qty, what, counts, edged }] — строки заказа (по готовой детали), что прошли фильтр */
export function stageParts(order, rows, rule) {
  if (rule.list === 'none') return []
  const types = parseEdgeTypes(order?.edge_types)
  const T0 = n0(order?.material_thickness) || 16
  const out = []
  for (const d of rows || []) {
    const m = detailMeta(d) || {}
    const edged = ['left', 'right', 'top', 'bottom'].some(s => edgeKey(d['edge_' + s]))
    let c = {}
    try { c = panelXml(d, { T: n0(m.thickness) || T0, id: 'x', post: { d6All: true }, types })?.counts || {} } catch { /* деталь не разобралась — без присадки */ }
    // пазы и фрезеровки сверху (лицевая) делает фрезер на раскрое — они в счёт, только если включены «отверстия сверху»
    const drillHit = (rule.top && c.top) || (rule.bottom && c.bottom) || (rule.edge && c.edge)
      || (rule.grooves && ((rule.top && c.groovesTop) || c.groovesBottom))
      || (rule.mills && ((rule.top && c.millsTop) || c.millsBottom))
    if (rule.list === 'edge' && !edged) continue
    if (rule.list === 'drill' && !drillHit) continue
    const what = [c.top && `сверху ${c.top}`, c.bottom && `снизу ${c.bottom}`, c.edge && `в торцы ${c.edge}`, (c.groovesTop + c.groovesBottom) && `пазов ${c.groovesTop + c.groovesBottom}`, (c.millsTop + c.millsBottom) && `фрезеровок ${c.millsTop + c.millsBottom}`].filter(Boolean).join(', ')
    const pcs = Math.max(1, n0(d.qty) || 1)
    // кромление по сторонам: прямолинейная деталь проходит кромочный станок столько раз, сколько у неё сторон с кромкой —
    // каждый проход сканируется отдельно. Фигурная деталь (кромка по участкам контура) считается как 1 проход на штуку.
    const sides = rule.list === 'edge' && rule.sides ? edgedSides(d) : 0
    const per = sides || 1
    out.push({ id: d.id, name: d.name || 'Деталь', des: m.des || '', pos: m.pos != null ? String(m.pos) : '', size: `${r1(d.length)}×${r1(d.width)}`, qty: pcs * per, pcs, per, sides, what, counts: c, edged })
  }
  return out
}

/** Заказ и его детали (строки order_details — по готовой детали) */
export async function loadOrderParts(orderId) {
  const [{ data: order }, { data: rows }] = await Promise.all([
    supabase.from('orders').select('*').eq('id', orderId).single(),
    supabase.from('order_details').select('*').eq('order_id', orderId).order('sort_order'),
  ])
  return { order: order || null, rows: rows || [] }
}

const norm = s => String(s || '').trim().replace(/\s+/g, '_').toLowerCase()
const forms = s => [...new Set([norm(s), norm(toLatin(s))])].filter(Boolean)

/**
 * Сопоставление кода с бирки с деталью заказа -> (code) => id строки | null.
 * 1) точно: коды всех бирок заказа по шаблону бирки (тот же, по которому печатались бирки);
 * 2) по обозначению детали в коде; 3) по номеру карты и детали на ней (L3 … N12).
 */
export function codeMatcher(order, rows, labelTpl) {
  const exact = new Map()
  const types = parseEdgeTypes(order?.edge_types)
  let mats = []
  try { mats = savedNestings(order, cutDetails(rows, types)) } catch { mats = [] }
  if (labelTpl) {
    for (const mat of mats) mat.sheets.forEach((sh, si) => sh.placed.forEach((p, pi) => {
      const d = mat.details[p.detailIndex]
      if (!d) return
      try { const code = norm(labelQr(labelTpl, labelInfo(order, mat, si, pi))); if (code && !exact.has(code)) exact.set(code, rawDetail(d).id) } catch { /* бирка не собралась */ }
    }))
  }
  const byDes = rows.map(r => ({ id: r.id, f: forms(detailMeta(r)?.des) })).filter(x => x.f.length).sort((a, b) => Math.max(...b.f.map(s => s.length)) - Math.max(...a.f.map(s => s.length)))
  return text => {
    const code = norm(text)
    if (!code) return null
    if (exact.has(code)) return exact.get(code)
    const tokens = code.split(/[^\p{L}\p{N}._/\\-]+/u).filter(Boolean)
    const hit = byDes.find(x => x.f.some(f => tokens.includes(f) || code.endsWith('_' + f) || code === f))
    if (hit) return hit.id
    const L = (code.match(/(?:^|[^a-z0-9])l(\d+)(?![a-z0-9])/) || [])[1], N = (code.match(/(?:^|[^a-z0-9])n(\d+)(?![a-z0-9])/) || [])[1]
    if (L && N) for (const mat of mats) {
      const p = mat.sheets[Number(L) - 1]?.placed[Number(N) - 1]
      const d = p && mat.details[p.detailIndex]
      if (d) return rawDetail(d).id
    }
    return null
  }
}

export const stageScan = (stageId, detailId, n) => supabase.rpc('stage_scan', { p_stage: stageId, p_detail: detailId, p_n: n })
export async function stageScans(stageId) {
  const { data, error } = await supabase.rpc('stage_scans_of', { p_stage: stageId })
  return error ? new Map() : new Map((data || []).map(x => [x.detail_id, x.n]))
}
export const savePostRule = (postId, rule) => supabase.rpc('save_post_rule', { p_id: postId, p_rule: rule })
