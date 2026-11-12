// Торцевые отверстия заказа одним списком (Ø × глубина -> сколько) и замена Ø / глубины перед созданием программ ЧПУ:
// на станке может не быть такого сверла (Ø4 -> Ø5). Замена — только для программ этого заказа, сам заказ не меняется.
import { getAllDrillPoints } from './drillGeometry'
import { contourOf } from './model3dEdit'

const r2 = v => Math.round((Number(v) || 0) * 100) / 100
export const edgeKey = (d, depth) => `${r2(d)}|${r2(depth)}`
export const edgeLabel = k => { const [d, h] = k.split('|'); return `Ø${d}${Number(h) > 0 ? ` × ${h}` : ''}` }

/** Торцевые отверстия на листах раскроя -> [{ key, d, depth, count }] (по возрастанию Ø, глубины) */
export function edgeHoleList(mat) {
  const by = new Map()
  for (const sh of mat?.sheets || []) for (const p of sh?.placed || []) {
    const det = mat.details?.[p.detailIndex]
    const c = contourOf(det)
    if (!c?.drillings?.length) continue
    let pts = []
    try { pts = getAllDrillPoints(c, Number(det.width) || 0, Number(det.length) || 0) } catch { pts = [] }
    for (const pt of pts) if (pt.edge) {
      const k = edgeKey(pt.d || 8, pt.defDepth ?? pt.depth ?? 0)
      by.set(k, (by.get(k) || 0) + 1)
    }
  }
  return [...by].map(([key, count]) => { const [d, depth] = key.split('|').map(Number); return { key, d, depth, count } })
    .sort((a, b) => a.d - b.d || a.depth - b.depth)
}

const mapContour = (c, remap) => {
  if (!c?.drillings?.length) return c
  let changed = false
  const drillings = c.drillings.map(dr => {
    if (dr.kind !== 'edge') return dr
    const n = { ...dr }
    const d0 = dr.d ?? 8, h0 = dr.depth ?? 0
    const pd0 = dr.pairD ?? d0, ph0 = dr.pairDepth ?? h0
    const m = remap[edgeKey(d0, h0)], pm = remap[edgeKey(pd0, ph0)]
    if (pm || m) { n.pairD = pm ? pm.d : pd0; n.pairDepth = pm ? pm.depth : ph0 }   // пара — своими значениями, чтобы не уехала за основным
    if (m) { n.d = m.d; n.depth = m.depth }
    if (dr.extraHoles?.length) n.extraHoles = dr.extraHoles.map(eh => {
      if (eh.kind !== 'edge') return eh
      const e = remap[edgeKey(eh.d ?? 8, eh.depth ?? 13)]
      return e ? { ...eh, d: e.d, depth: e.depth } : eh
    })
    if (m || pm || n.extraHoles !== dr.extraHoles) changed = true
    return n
  })
  return changed ? { ...c, drillings } : c
}
const mapDetail = (d, remap) => {
  if (!d) return d
  const c = contourOf(d), nc = mapContour(c, remap)
  const raw = d._raw && d._raw !== d ? mapDetail(d._raw, remap) : d._raw
  if (nc === c && raw === d._raw) return d
  return { ...d, contour: typeof d.contour === 'string' ? JSON.stringify(nc) : nc, ...(d._raw ? { _raw: raw } : {}) }
}
/** Материал раскроя с заменёнными торцевыми отверстиями; remap: { 'Ø|глубина': { d, depth } } */
export function remapMat(mat, remap) {
  if (!mat || !remap || !Object.keys(remap).length) return mat
  return { ...mat, details: (mat.details || []).map(d => mapDetail(d, remap)) }
}
