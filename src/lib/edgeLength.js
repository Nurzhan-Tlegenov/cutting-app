// Кромка на фигурных деталях.
// Кроме четырёх сторон (edge_left/right/top/bottom в карточке детали) кромку
// можно назначить на любой участок контура и на вырез:
//   vertex.edge = 'название' — участок от этой вершины до следующей (если
//     следующая вершина — дуговая ('arc'), участок — вся дуга до вершины за ней);
//   hole.edge = 'название'   — весь периметр выреза.
// Координаты — мм, X — ширина, Y — длина, (0,0) — левый нижний угол.

const num = v => Number(v) || 0

function circumcenter(a, b, c) {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y))
  if (Math.abs(d) < 1e-9) return null
  const a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y
  return { x: (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d, y: (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d }
}
function arcPoints(sp, mid, ep, n = 20) {
  const C = circumcenter(sp, mid, ep)
  if (!C) return [[sp.x, sp.y], [ep.x, ep.y]]
  const R = Math.hypot(sp.x - C.x, sp.y - C.y)
  const sa = Math.atan2(sp.y - C.y, sp.x - C.x)
  let dm = Math.atan2(mid.y - C.y, mid.x - C.x) - sa; while (dm < 0) dm += Math.PI * 2
  let de = Math.atan2(ep.y - C.y, ep.x - C.x) - sa; while (de < 0) de += Math.PI * 2
  const sweep = dm > de ? -(Math.PI * 2 - de) : de
  return Array.from({ length: n + 1 }, (_, i) => [C.x + R * Math.cos(sa + sweep * i / n), C.y + R * Math.sin(sa + sweep * i / n)])
}

/** Участки контура: [{ i (номер начальной вершины), j (конечной), pts: [[x,y]...], len, arc, edge }] */
export function contourSegments(vertices) {
  const vs = vertices || []
  const n = vs.length
  const out = []
  if (n < 2) return out
  for (let i = 0; i < n; i++) {
    const a = vs[i]
    if (a.type === 'arc') continue
    let j = (i + 1) % n, mid = null
    if (vs[j].type === 'arc') { mid = vs[j]; j = (j + 1) % n }
    const b = vs[j]
    const pts = mid ? arcPoints(a, mid, b) : [[num(a.x), num(a.y)], [num(b.x), num(b.y)]]
    let len = 0
    for (let k = 1; k < pts.length; k++) len += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1])
    out.push({ i, j, pts, len, arc: !!mid, edge: a.edge || null })
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

function holePerimeter(hole) {
  if (hole.type === 'circle') return Math.PI * (num(hole.d) || 100)
  if (Array.isArray(hole.vertices) && hole.vertices.length > 2) return contourSegments(hole.vertices).reduce((s, g) => s + g.len, 0)
  return 2 * ((num(hole.hw) || 200) + (num(hole.hh) || 100))
}

/**
 * Вся кромка детали: [{ name, mm }] — стороны + фигурные участки + вырезы.
 * d — строка order_details ({ length, width, edge_*, contour }) или деталь формы ({ w, h, edges, contour }).
 */
export function detailEdgeList(d) {
  const L = num(d.length ?? d.w), W = num(d.width ?? d.h)
  const sides = d.edges || { top: d.edge_top, right: d.edge_right, bottom: d.edge_bottom, left: d.edge_left }
  const out = []
  const add = (name, mm) => { if (name && name !== 'false' && mm > 0) out.push({ name: name === 'default' ? 'Кромка' : String(name), mm }) }
  add(sides.left, L); add(sides.right, L)      // Дл / Дп — вдоль длины
  add(sides.top, W); add(sides.bottom, W)      // Шв / Шн — вдоль ширины
  let c = d.contour
  if (typeof c === 'string') { try { c = JSON.parse(c) } catch { c = null } }
  if (c) {
    for (const seg of contourSegments(c.vertices)) {
      if (!seg.edge) continue
      const side = segmentSide(seg, W, L)
      if (side && sides[side]) continue        // уже посчитано стороной
      add(seg.edge, seg.len)
    }
    for (const h of c.holes || []) if (h.edge) add(h.edge, holePerimeter(h))
  }
  return out
}
