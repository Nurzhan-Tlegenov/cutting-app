// Подсветка одинаковых деталей на карте раскроя (галочка «Одинаковые» рядом с «Кромка»).
// Одинаковые — абсолютно одинаковые: то же наименование, те же длина и ширина, та же кромка по сторонам и тот же
// контур (вырезы, присадка). Цвет — только у групп, где деталей 2 шт. и больше. Детали с обработкой снизу / с двух
// сторон остаются фиолетовыми, как и были, — им цвет не даётся. Цвета спокойные, полупрозрачные (прозрачность — ползунок).
import { backSide } from './partInfo'

// rgb без прозрачности; без фиолетового (обработка снизу), оранжевого (мелкие у края, выбранная) и яркого красного (наложение)
export const SAME_COLORS = ['33,150,243', '67,160,71', '236,64,122', '0,172,193', '124,179,66', '121,85,72', '0,121,107', '96,125,139', '229,115,115', '57,73,171', '175,180,43', '255,167,38']

const num = v => Math.round((Number(v) || 0) * 10) / 10
const edge = e => (e ? (typeof e === 'object' ? String(e.name || e.type || 1) : String(e)) : '')
const contourKey = c => { if (!c) return ''; try { return typeof c === 'string' ? c : JSON.stringify(c) } catch { return '' } }

/** { индекс детали: 'r,g,b' } — только для одинаковых деталей (2 шт. и больше) */
export function sameColorMap(details) {
  const groups = new Map()
  ;(details || []).forEach((d, i) => {
    if (!d || backSide(d)) return
    const key = [String(d.name || '').trim().toLowerCase(), num(d.length), num(d.width),
      edge(d.edge_left), edge(d.edge_right), edge(d.edge_top), edge(d.edge_bottom), contourKey(d.contour)].join('|')
    const g = groups.get(key) || { idx: [], qty: 0 }
    g.idx.push(i); g.qty += Math.max(1, Number(d.qty) || 1)
    groups.set(key, g)
  })
  const out = {}
  let c = 0
  for (const g of groups.values()) {
    if (g.qty < 2) continue
    const rgb = SAME_COLORS[c++ % SAME_COLORS.length]
    for (const i of g.idx) out[i] = rgb
  }
  return out
}
