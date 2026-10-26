// Пересечения деталей в 3D-модели: где детали заходят друг в друга и насколько.
// Деталь — повёрнутая коробка своего габарита (контур × толщина, p.m — поворот и сдвиг). Две коробки пересекаются,
// если ни одна из 15 осей разделения их не разводит; глубина врезания — наименьшее перекрытие по этим осям.
// Касание (общая плоскость, зазор 0) пересечением не считается. У фигурных деталей (не прямоугольник, вырезы)
// проверка по габариту — такие пересечения помечаются «по габариту»: могут быть ложными (деталь в вырезе соседа).
// Модуль без React.

const TOUCH = 0.5          // мм — до этого касание, не пересечение
export const CLASH_CRITICAL = 5   // мм — от этого пересечение критичное (деталь не встанет)
export const CLASH_NOTICE = 1.5   // мм — от этого заметное (подрезать / проверить), меньше — мелкое (допуск, кромка)

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const len = a => Math.hypot(a[0], a[1], a[2])

function isRect(p) {
  if ((p.holes || []).some(h => h.length > 2)) return false
  if (p.outline.length !== 4) return false
  const xs = new Set(p.outline.map(q => Math.round(q[0] * 10))), ys = new Set(p.outline.map(q => Math.round(q[1] * 10)))
  return xs.size === 2 && ys.size === 2
}

/** Коробка детали: центр, оси (единичные), полуразмеры, мм */
export function partObb(p) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [x, y] of p.outline) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
  const m = p.m, t = Number(p.t) || 0
  const toW = (x, y, z) => [0, 1, 2].map(k => m[k * 3] * x + m[k * 3 + 1] * y + m[k * 3 + 2] * z + m[9 + k])
  const col = i => [m[i], m[3 + i], m[6 + i]]
  const ax = [col(0), col(1), col(2)].map(v => { const l = len(v) || 1; return { u: v.map(c => c / l), s: l } })
  return {
    c: toW((x0 + x1) / 2, (y0 + y1) / 2, t / 2),
    u: ax.map(a => a.u),
    h: [(x1 - x0) / 2 * ax[0].s, (y1 - y0) / 2 * ax[1].s, t / 2 * ax[2].s],
    rect: isRect(p),
  }
}

// глубина врезания двух коробок (0 — не пересекаются или только касаются)
function sat(A, B) {
  const d = [B.c[0] - A.c[0], B.c[1] - A.c[1], B.c[2] - A.c[2]]
  const axes = [...A.u, ...B.u]
  for (const a of A.u) for (const b of B.u) { const c = cross(a, b); const l = len(c); if (l > 1e-6) axes.push(c.map(v => v / l)) }
  let depth = Infinity
  for (const L of axes) {
    const ra = A.h[0] * Math.abs(dot(A.u[0], L)) + A.h[1] * Math.abs(dot(A.u[1], L)) + A.h[2] * Math.abs(dot(A.u[2], L))
    const rb = B.h[0] * Math.abs(dot(B.u[0], L)) + B.h[1] * Math.abs(dot(B.u[1], L)) + B.h[2] * Math.abs(dot(B.u[2], L))
    const ov = ra + rb - Math.abs(dot(d, L))
    if (ov <= TOUCH) return 0
    if (ov < depth) depth = ov
  }
  return depth
}

// середина общего объёма (приближённо): коробка B в системе A, пересечённая с A, — её центр в мире
function overlapCenter(A, B) {
  const corners = []
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const w = [0, 1, 2].map(k => B.c[k] + sx * B.h[0] * B.u[0][k] + sy * B.h[1] * B.u[1][k] + sz * B.h[2] * B.u[2][k])
    const r = [w[0] - A.c[0], w[1] - A.c[1], w[2] - A.c[2]]
    corners.push([dot(r, A.u[0]), dot(r, A.u[1]), dot(r, A.u[2])])
  }
  const mid = [0, 1, 2].map(k => {
    const lo = Math.max(-A.h[k], Math.min(...corners.map(c => c[k]))), hi = Math.min(A.h[k], Math.max(...corners.map(c => c[k])))
    return (lo + hi) / 2
  })
  return [0, 1, 2].map(k => A.c[k] + mid[0] * A.u[0][k] + mid[1] * A.u[1][k] + mid[2] * A.u[2][k])
}

/**
 * Пересечения деталей модели. parts — model.parts (pid, name, outline, holes, t, m).
 * -> [{ a, b (pid), nameA, nameB, depth (мм), critical, approx (по габариту фигурной детали), at: [x, y, z] }],
 *    сначала самые глубокие
 */
export function findClashes(parts) {
  const list = (parts || []).filter(p => p && p.outline?.length >= 3 && Number(p.t) > 0 && Array.isArray(p.m))
  const obb = list.map(partObb)
  // грубый отсев по габаритам в мире
  const box = obb.map(o => {
    const e = [0, 1, 2].map(k => o.h[0] * Math.abs(o.u[0][k]) + o.h[1] * Math.abs(o.u[1][k]) + o.h[2] * Math.abs(o.u[2][k]))
    return { lo: o.c.map((c, k) => c - e[k]), hi: o.c.map((c, k) => c + e[k]) }
  })
  const order = list.map((_, i) => i).sort((i, j) => box[i].lo[0] - box[j].lo[0])
  const out = []
  for (let ii = 0; ii < order.length; ii++) {
    const i = order[ii]
    for (let jj = ii + 1; jj < order.length; jj++) {
      const j = order[jj]
      if (box[j].lo[0] > box[i].hi[0] - TOUCH) break
      if (box[j].lo[1] > box[i].hi[1] - TOUCH || box[i].lo[1] > box[j].hi[1] - TOUCH) continue
      if (box[j].lo[2] > box[i].hi[2] - TOUCH || box[i].lo[2] > box[j].hi[2] - TOUCH) continue
      const depth = sat(obb[i], obb[j])
      if (!(depth > 0)) continue
      out.push({
        a: list[i].pid, b: list[j].pid, nameA: list[i].name || 'Деталь', nameB: list[j].name || 'Деталь',
        depth: Math.round(depth * 10) / 10, critical: depth >= CLASH_CRITICAL, approx: !obb[i].rect || !obb[j].rect,
        at: overlapCenter(obb[i], obb[j]),
      })
    }
  }
  return out.sort((x, y) => (x.approx === y.approx ? y.depth - x.depth : x.approx ? 1 : -1))
}

/** Глубина врезания двух деталей ({ outline, t, m }) по их габаритам, мм — та же мера, что в просмотрщике (0 — не пересекаются) */
export function pairDepth(a, b) {
  try { return Math.round(sat(partObb(a), partObb(b)) * 10) / 10 } catch { return 0 }
}
