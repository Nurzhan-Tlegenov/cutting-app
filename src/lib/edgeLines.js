// Линии кромки на карте раскроя (экран и PDF) для детали с контуром.
// Кромка рисуется с отступом внутрь от контура и идёт по самим его участкам — прямым и криволинейным одинаково:
// на скруглённом углу линия плавно переходит с прямой стороны на дугу, без «прямоугольника» по габариту и без
// перехлёста. У острого угла линия не доходит до него на величину отступа.
import { contourSegments, segmentSide } from './edgeLength.js'

const on = v => !!v && v !== 'false'

/**
 * detail — строка детали ({ width, length, edge_left/right/top/bottom }); contour — её разобранный контур;
 * g — отступ внутрь, мм. -> ломаные [[x, y], ...] в «родных» координатах детали (X — ширина, Y — длина)
 * или null, если у детали нет контура с вершинами (тогда кромка рисуется по сторонам габарита).
 */
export function insetEdgeLines(detail, contour, g) {
  const verts = contour?.vertices
  if (!detail || !Array.isArray(verts) || verts.length < 3) return null
  const segs = contourSegments(verts).filter(sg => sg.pts.length > 1)
  if (!segs.length) return null
  const W = Number(detail.width) || 0, L = Number(detail.length) || 0
  const native = { left: detail.edge_left, right: detail.edge_right, top: detail.edge_top, bottom: detail.edge_bottom }
  // направление обхода контура — чтобы знать, где «внутрь»
  const ring = segs.flatMap(sg => sg.pts)
  let twice = 0
  for (let i = 0; i < ring.length; i++) { const u = ring[i], v = ring[(i + 1) % ring.length]; twice += u[0] * v[1] - v[0] * u[1] }
  const sign = twice >= 0 ? 1 : -1
  const dirAt = (pts, end) => { const u = end ? pts[pts.length - 2] : pts[0], v = end ? pts[pts.length - 1] : pts[1]; const l = Math.hypot(v[0] - u[0], v[1] - u[1]) || 1; return [(v[0] - u[0]) / l, (v[1] - u[1]) / l] }
  const sharp = (da, db) => da[0] * db[0] + da[1] * db[1] < 0.9                 // излом больше ~25° — угол, а не плавный переход
  const trim = (pts, t, fromEnd) => {                                           // укоротить ломаную на t с начала (или с конца)
    const q = fromEnd ? pts.slice().reverse() : pts.slice()
    let left = t
    while (q.length > 1) {
      const l = Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1])
      if (l > left) { const k = left / l; q[0] = [q[0][0] + (q[1][0] - q[0][0]) * k, q[0][1] + (q[1][1] - q[0][1]) * k]; break }
      left -= l; q.shift()
    }
    return fromEnd ? q.reverse() : q
  }
  const out = []
  segs.forEach((sg, i) => {
    const side = segmentSide(sg, W, L)
    if (!((side && on(native[side])) || sg.edge)) return
    const pts = sg.pts
    let line = pts.map((q, k) => {                                              // отступ внутрь по нормали в каждой точке
      const u = pts[Math.max(0, k - 1)], v = pts[Math.min(pts.length - 1, k + 1)]
      const l = Math.hypot(v[0] - u[0], v[1] - u[1]) || 1
      return [q[0] - (v[1] - u[1]) / l * g * sign, q[1] + (v[0] - u[0]) / l * g * sign]
    })
    const prev = segs[(i - 1 + segs.length) % segs.length], next = segs[(i + 1) % segs.length]
    if (sharp(dirAt(prev.pts, true), dirAt(pts, false))) line = trim(line, g, false)
    if (sharp(dirAt(pts, true), dirAt(next.pts, false))) line = trim(line, g, true)
    if (line.length > 1) out.push(line)
  })
  return out
}
