// Кромка на деталях — прямая и криволинейная.
// Кроме четырёх сторон (edge_left/right/top/bottom в карточке детали) кромку можно назначить
// на любой участок контура и на вырез:
//   vertex.edge  = 'название' — участок, который ВЫХОДИТ из этой вершины (прямой отрезок или дуга через точки);
//   vertex.edgeR = 'название' — скругление в самой вершине (радиус R или fillet-дуга);
//   hole.edge    = 'название' — весь периметр выреза; у выреза с вершинами — те же edge / edgeR на его вершинах.
// Координаты — мм, X — ширина, Y — длина, (0,0) — левый нижний угол.
// Геометрия участков — та же, что у контура на карте раскроя и в G-коде (см. verticesToPolygon).
import { roundCorner, sampleFillet, sampleArc3 } from './trueShapeNesting.js'

const num = v => Number(v) || 0
const P = v => ({ x: num(v.x), y: num(v.y) })
const polyLen = pts => { let l = 0; for (let k = 1; k < pts.length; k++) l += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]); return l }

/**
 * Участки контура по порядку обхода:
 * [{ key, i, j, prop, pts: [[x,y]...], len, arc, round, edge }]
 *   key   — имя участка (номер вершины для отрезка/дуги, 'r<номер>' для скругления);
 *   i     — вершина, в которой хранится кромка, prop — в каком её поле ('edge' | 'edgeR');
 *   arc   — участок криволинейный (дуга или скругление), round — это скругление угла.
 */
export function contourSegments(vertices) {
  const vs = vertices || []
  const n = vs.length
  const out = []
  if (n < 2) return out
  const isArc = v => v?.type === 'arc'
  const isFillet = v => v?.type === 'fillet' && v.fcx != null && v.fcy != null && v.fr != null
  const nodes = new Array(n)
  const node = i => {
    if (nodes[i]) return nodes[i]
    const v = vs[i]
    let pts = null
    if (isFillet(v)) {
      pts = sampleFillet(v, 24)
      const prev = P(vs[(i - 1 + n) % n])      // по ходу контура дуга начинается у предыдущей вершины
      const d0 = Math.hypot(pts[0][0] - prev.x, pts[0][1] - prev.y), d1 = Math.hypot(pts[pts.length - 1][0] - prev.x, pts[pts.length - 1][1] - prev.y)
      if (d1 < d0) pts = pts.slice().reverse()
    } else if (num(v.r) > 0 && (!v.type || v.type === 'point')) {
      const r = roundCorner(P(vs[(i - 1 + n) % n]), P(v), P(vs[(i + 1) % n]), num(v.r), 24)
      if (r.length > 1) pts = r
    }
    return (nodes[i] = pts ? { pts, round: true } : { pts: [[num(v.x), num(v.y)]], round: false })
  }
  for (let i = 0; i < n; i++) {
    const a = vs[i]
    if (isArc(a)) continue
    const na = node(i)
    if (na.round) {
      const len = polyLen(na.pts)
      if (len > 0.01) out.push({ key: 'r' + i, i, j: i, prop: 'edgeR', pts: na.pts, len, arc: true, round: true, edge: a.edgeR || (isFillet(a) ? a.edge : null) || null })
    }
    const group = []
    let j = (i + 1) % n, guard = 0
    while (isArc(vs[j]) && guard++ < n) { group.push(vs[j]); j = (j + 1) % n }
    if (isArc(vs[j])) break                    // одни дуговые точки — участков нет
    const start = na.pts[na.pts.length - 1], end = node(j).pts[0]
    let pts
    if (!group.length) pts = [start, end]
    else {
      const sp = P(a), ep = P(vs[j]), g = group.map(P)
      if (g.length === 1) pts = sampleArc3(sp, g[0], ep, 24)
      else {
        pts = []
        for (let k = 0; k + 1 < g.length; k++) pts.push(...sampleArc3(k === 0 ? sp : g[k - 1], g[k], k === g.length - 2 ? ep : g[k + 2], 24))
      }
    }
    const len = polyLen(pts)
    if (len > 0.01) out.push({ key: i, i, j, prop: 'edge', pts, len, arc: group.length > 0, round: false, edge: (isFillet(a) ? null : a.edge) || null })
    if (n === 2 && i === 0) break              // две точки — один отрезок, обратный не нужен
  }
  return out
}

/** На какой стороне габарита лежит прямой участок (или null) */
export function segmentSide(seg, W, L, tol = 0.5) {
  if (seg.arc) return null
  const [a, b] = [seg.pts[0], seg.pts[seg.pts.length - 1]]
  if (Math.abs(a[0]) <= tol && Math.abs(b[0]) <= tol) return 'left'
  if (Math.abs(a[0] - W) <= tol && Math.abs(b[0] - W) <= tol) return 'right'
  if (Math.abs(a[1]) <= tol && Math.abs(b[1]) <= tol) return 'bottom'
  if (Math.abs(a[1] - L) <= tol && Math.abs(b[1] - L) <= tol) return 'top'
  return null
}

/** Расстояние от точки до ломаной */
export function distToPolyline(x, y, pts) {
  let best = Infinity
  for (let k = 1; k < pts.length; k++) {
    const [ax, ay] = pts[k - 1], [bx, by] = pts[k]
    const ex = bx - ax, ey = by - ay, l2 = ex * ex + ey * ey
    const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / l2)) : 0
    best = Math.min(best, Math.hypot(x - ax - ex * t, y - ay - ey * t))
  }
  return best
}

/** Участки выреза с кромкой, назначенной по отдельным участкам (вырез с вершинами) */
export function holeEdgeSegments(hole) {
  if (!hole || hole.edge || !Array.isArray(hole.vertices) || hole.vertices.length < 3) return []
  return contourSegments(hole.vertices).filter(s => s.edge)
}

const sideLen = (side, W, L) => (side === 'left' || side === 'right' ? L : W)
const SIDES = ['left', 'right', 'top', 'bottom']

/**
 * Вся кромка детали: [{ name, mm, curved }] — стороны + фигурные участки + вырезы.
 * Длина считается по настоящей длине отрезка или дуги: у стороны со скруглённым углом прямая часть короче габарита.
 * d — строка order_details ({ length, width, edge_*, contour }) или деталь формы ({ w, h, edges, contour }).
 */
export function detailEdgeList(d) {
  const L = num(d.length ?? d.w), W = num(d.width ?? d.h)
  const sides = d.edges || { top: d.edge_top, right: d.edge_right, bottom: d.edge_bottom, left: d.edge_left }
  const out = []
  const on = v => v && v !== 'false'
  const add = (name, mm, curved = false) => { if (on(name) && mm > 0) out.push({ name: name === 'default' || name === true ? 'Кромка' : String(name), mm, curved: !!curved }) }
  let c = d.contour
  if (typeof c === 'string') { try { c = JSON.parse(c) } catch { c = null } }
  const verts = c?.vertices
  if (!Array.isArray(verts) || verts.length < 3) SIDES.forEach(s => add(sides[s], sideLen(s, W, L)))
  else {
    const got = { left: 0, right: 0, top: 0, bottom: 0 }
    for (const seg of contourSegments(verts)) {
      const side = segmentSide(seg, W, L)
      if (side && on(sides[side])) { got[side] += seg.len; add(sides[side], seg.len); continue }
      // участок не на стороне габарита (дуга, скос, внутренний угол фигурной детали) — криволинейная кромка
      if (seg.edge) add(seg.edge, seg.len, true)
    }
    // сторона назначена, а прямых участков контура на ней нет (контур не совпал с габаритом) — по габариту
    SIDES.forEach(s => { if (on(sides[s]) && got[s] < 0.5) add(sides[s], sideLen(s, W, L)) })
  }
  for (const h of c?.holes || []) {
    if (h.edge) {
      if (h.type === 'circle') add(h.edge, Math.PI * (num(h.d) || 100), true)
      else if (Array.isArray(h.vertices) && h.vertices.length > 2) contourSegments(h.vertices).forEach(s => add(h.edge, s.len, true))
      else add(h.edge, 2 * ((num(h.hw) || 200) + (num(h.hh) || 100)), true)
    } else holeEdgeSegments(h).forEach(s => add(s.edge, s.len, true))        // любой закромленный вырез, даже прямоугольный, — криволинейная кромка
  }
  return out
}

/**
 * Итог по кромке для списка деталей (метры, с учётом количества):
 * { total, straight, curved, byName: { название: { total, straight, curved } } }
 */
export function edgeTotals(details) {
  const t = { total: 0, straight: 0, curved: 0, byName: {} }
  for (const d of details || []) {
    const qty = num(d.qty) || 1
    for (const e of detailEdgeList(d)) {
      const m = e.mm / 1000 * qty, k = e.curved ? 'curved' : 'straight'
      const b = t.byName[e.name] || (t.byName[e.name] = { total: 0, straight: 0, curved: 0 })
      t.total += m; t[k] += m; b.total += m; b[k] += m
    }
  }
  return t
}
