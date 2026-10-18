// Полоса вдоль незамкнутой траектории (паз по траектории из Базиса и т. п.).
// path — ломаная [[x, y], …]; lo / hi — смещения краёв полосы от траектории по левой нормали
// (как профиль фрезы в Базисе: u < 0 — справа от хода, u > 0 — слева). Углы — со срезом (митра, не длиннее 4×).

const unit = (dx, dy) => { const l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l] }

/** Убрать совпадающие подряд точки */
export function cleanPath(path, eps = 0.01) {
  const out = []
  for (const p of path || []) if (!out.length || Math.hypot(p[0] - out[out.length - 1][0], p[1] - out[out.length - 1][1]) > eps) out.push([p[0], p[1]])
  return out
}

/** Полоса lo…hi вдоль ломаной -> многоугольник (левый край по ходу, правый — обратно) */
export function bandPolygon(path, lo, hi) {
  const P = cleanPath(path)
  if (P.length < 2) return null
  const n = P.length
  const nrm = i => { const t = unit(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]); return [-t[1], t[0]] }
  const miter = i => {
    if (i === 0) return nrm(0)
    if (i === n - 1) return nrm(n - 2)
    const a = nrm(i - 1), b = nrm(i)
    const m = unit(a[0] + b[0], a[1] + b[1]), c = m[0] * a[0] + m[1] * a[1]
    const k = 1 / Math.max(0.25, c)
    return [m[0] * k, m[1] * k]
  }
  const left = [], right = []
  for (let i = 0; i < n; i++) {
    const m = miter(i)
    left.push([P[i][0] + m[0] * hi, P[i][1] + m[1] * hi])
    right.push([P[i][0] + m[0] * lo, P[i][1] + m[1] * lo])
  }
  return [...left, ...right.reverse()]
}

/** Продлить конец траектории (end: 0 — начало, 1 — конец) по касательной на d мм */
export function extendEnd(path, end, d) {
  const P = cleanPath(path)
  if (P.length < 2 || !(d > 0)) return P
  if (end === 0) { const t = unit(P[0][0] - P[1][0], P[0][1] - P[1][1]); P[0] = [P[0][0] + t[0] * d, P[0][1] + t[1] * d] }
  else { const k = P.length - 1, t = unit(P[k][0] - P[k - 1][0], P[k][1] - P[k - 1][1]); P[k] = [P[k][0] + t[0] * d, P[k][1] + t[1] * d] }
  return P
}

// ── Полоса из отрезков и НАСТОЯЩИХ дуг (для станка: дуга — одна строка, а не десятки хорд) ──

const D2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1])

function circle3(a, b, c) {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]))
  if (Math.abs(d) < 1e-9) return null
  const A = a[0] * a[0] + a[1] * a[1], B = b[0] * b[0] + b[1] * b[1], C = c[0] * c[0] + c[1] * c[1]
  const cx = (A * (b[1] - c[1]) + B * (c[1] - a[1]) + C * (a[1] - b[1])) / d
  const cy = (A * (c[0] - b[0]) + B * (a[0] - c[0]) + C * (b[0] - a[0])) / d
  return { cx, cy, r: Math.hypot(a[0] - cx, a[1] - cy) }
}
const crossAt = (P, k) => (P[k][0] - P[k - 1][0]) * (P[k + 1][1] - P[k][1]) - (P[k][1] - P[k - 1][1]) * (P[k + 1][0] - P[k][0])

/**
 * Дуги в ломаной P (точки дуги могут быть округлены — до ~tol): участок i…j — дуга, если все его точки лежат на
 * окружности через крайние и среднюю точки (± tol), поворот в одну сторону, радиус не огромный (иначе это прямая).
 * -> [{ i0, i1, cx, cy, r, ccw, sweep }]
 */
function fitArcs(P, tol) {
  const n = P.length, runs = []
  const ok = (i, j) => {
    const c = circle3(P[i], P[(i + j) >> 1], P[j])
    if (!c || !(c.r < 3000) || c.r < 0.5) return null
    let sg = 0
    for (let k = i; k <= j; k++) if (Math.abs(Math.hypot(P[k][0] - c.cx, P[k][1] - c.cy) - c.r) > tol) return null
    for (let k = i + 1; k < j; k++) {
      const x = crossAt(P, k)
      if (Math.abs(x) < 1e-9) return null
      const s = Math.sign(x)
      if (sg && s !== sg) return null
      sg = s
      // хорды дуги короткие: излом больше 30° — это угол, а не дуга
      const ax = P[k][0] - P[k - 1][0], ay = P[k][1] - P[k - 1][1], bx = P[k + 1][0] - P[k][0], by = P[k + 1][1] - P[k][1]
      if (Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by)) > Math.PI / 6) return null
    }
    return { ...c, ccw: sg > 0 }
  }
  let i = 0
  while (i + 3 < n) {
    let best = null, bj = -1
    for (let j = i + 3; j < n; j++) { const c = ok(i, j); if (c) { best = c; bj = j } else if (bj > 0) break }
    if (!best) { i++; continue }
    const a0 = Math.atan2(P[i][1] - best.cy, P[i][0] - best.cx), a1 = Math.atan2(P[bj][1] - best.cy, P[bj][0] - best.cx)
    let sw = best.ccw ? a1 - a0 : a0 - a1
    while (sw <= 0) sw += 2 * Math.PI
    runs.push({ i0: i, i1: bj, cx: best.cx, cy: best.cy, r: best.r, ccw: best.ccw, sweep: sw })
    i = bj
  }
  return runs
}

/** Незамкнутая ломаная -> отрезки и дуги по ходу: [{ a, b }] | [{ a, b, cx, cy, r, ccw, sweep }] */
export function pathElements(path, tol = 0.05) {
  const P = cleanPath(path)
  if (P.length < 2) return []
  const out = []
  let i = 0
  for (const r of fitArcs(P, tol)) {
    for (; i < r.i0; i++) out.push({ a: P[i], b: P[i + 1] })
    // радиус — ровный, если он почти целый (R100, а не R99.996)
    const rr = Math.abs(r.r - Math.round(r.r)) < 0.02 ? Math.round(r.r) : r.r
    out.push({ a: P[r.i0], b: P[r.i1], cx: r.cx, cy: r.cy, r: rr, ccw: r.ccw, sweep: r.sweep })
    i = r.i1
  }
  for (; i < P.length - 1; i++) out.push({ a: P[i], b: P[i + 1] })
  // подряд идущие отрезки на одной прямой — одним отрезком
  const merged = []
  for (const e of out) {
    const l = merged[merged.length - 1]
    if (l && !l.r && !e.r) {
      const ux = l.b[0] - l.a[0], uy = l.b[1] - l.a[1], vx = e.b[0] - e.a[0], vy = e.b[1] - e.a[1]
      if (Math.abs(ux * vy - uy * vx) <= 1e-3 * Math.hypot(ux, uy) * Math.hypot(vx, vy) && ux * vx + uy * vy > 0) { l.b = e.b; continue }
    }
    merged.push({ ...e })
  }
  return merged
}

// касательная (единичная, по ходу) в начале / конце элемента
function tan(e, atStart) {
  if (!e.r) { const l = D2(e.a, e.b) || 1; return [(e.b[0] - e.a[0]) / l, (e.b[1] - e.a[1]) / l] }
  const p = atStart ? e.a : e.b, rx = p[0] - e.cx, ry = p[1] - e.cy, l = Math.hypot(rx, ry) || 1
  return e.ccw ? [-ry / l, rx / l] : [ry / l, -rx / l]
}
// элемент, сдвинутый на d по левой нормали
function offsetEl(e, d) {
  if (!e.r) { const t = tan(e, true), n = [-t[1], t[0]]; return { a: [e.a[0] + n[0] * d, e.a[1] + n[1] * d], b: [e.b[0] + n[0] * d, e.b[1] + n[1] * d] } }
  const r2 = e.ccw ? e.r - d : e.r + d                     // у дуги против часовой левая нормаль смотрит в центр
  if (!(r2 > 0.05)) return null
  const at = p => { const rx = p[0] - e.cx, ry = p[1] - e.cy, l = Math.hypot(rx, ry) || 1; return [e.cx + rx / l * r2, e.cy + ry / l * r2] }
  return { a: at(e.a), b: at(e.b), cx: e.cx, cy: e.cy, r: r2, ccw: e.ccw, sweep: e.sweep }
}
const rev = e => (e.r ? { ...e, a: e.b, b: e.a, ccw: !e.ccw } : { a: e.b, b: e.a })
// пересечение прямых p + t·u и q + s·v
function cross(p, u, q, v) {
  const den = u[0] * v[1] - u[1] * v[0]
  if (Math.abs(den) < 1e-9) return null
  const t = ((q[0] - p[0]) * v[1] - (q[1] - p[1]) * v[0]) / den
  return [p[0] + u[0] * t, p[1] + u[1] * t]
}
// цепочка элементов одной стороны: стыки — встык (касание), отрезок к отрезку — до пересечения, иначе — перемычка
function joinSide(list) {
  const out = []
  for (const e of list) {
    const l = out[out.length - 1]
    if (!l) { out.push(e); continue }
    if (D2(l.b, e.a) <= 0.01) { e.a = l.b; out.push(e); continue }
    if (!l.r && !e.r) {
      const x = cross(l.a, tan(l, false), e.a, tan(e, true))
      if (x) { l.b = x; e.a = x; out.push(e); continue }
    }
    out.push({ a: l.b, b: e.a }, e)
  }
  return out
}

/**
 * Замкнутый контур полосы lo…hi вдоль траектории из отрезков и дуг -> [{ a, b, cx?, cy?, r?, ccw?, sweep? }]
 * ext0 / ext1 — продлить начало / конец траектории по касательной (мм), например за край детали.
 */
export function bandElements(path, lo, hi, ext0 = 0, ext1 = 0) {
  const els = pathElements(path)
  if (!els.length) return null
  if (ext0 > 0) { const t = tan(els[0], true), p = els[0].a; els.unshift({ a: [p[0] - t[0] * ext0, p[1] - t[1] * ext0], b: p }) }
  if (ext1 > 0) { const k = els.length - 1, t = tan(els[k], false), p = els[k].b; els.push({ a: p, b: [p[0] + t[0] * ext1, p[1] + t[1] * ext1] }) }
  const L = els.map(e => offsetEl(e, hi)), R = els.map(e => offsetEl(e, lo))
  if (L.some(e => !e) || R.some(e => !e)) return null
  const left = joinSide(L), right = joinSide(R.reverse().map(rev))
  return [...left, { a: left[left.length - 1].b, b: right[0].a }, ...right, { a: right[right.length - 1].b, b: left[0].a }]
}
