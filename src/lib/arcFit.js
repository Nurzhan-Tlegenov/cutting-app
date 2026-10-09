/**
 * Дуги в контуре детали.
 *
 * Контур детали в раскрое хранится ломаной: скругление и дуга разбиты на равные хорды (см. verticesToPolygon).
 * Для укладки этого хватает, но резать по таким хордам нельзя — на детали видны грани.
 * Здесь дуги находятся обратно: подряд идущие РАВНЫЕ хорды, лежащие на одной окружности и поворачивающие
 * в одну сторону. Квадрат и другие многоугольники дугой не считаются — поворот между хордами дуги не больше 24°.
 */

const D = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1])

function circle3(a, b, c) {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]))
  if (Math.abs(d) < 1e-9) return null
  const A = a[0] * a[0] + a[1] * a[1], B = b[0] * b[0] + b[1] * b[1], C = c[0] * c[0] + c[1] * c[1]
  const cx = (A * (b[1] - c[1]) + B * (c[1] - a[1]) + C * (a[1] - b[1])) / d
  const cy = (A * (c[0] - b[0]) + B * (a[0] - c[0]) + C * (b[0] - a[0])) / d
  return { cx, cy, r: Math.hypot(a[0] - cx, a[1] - cy) }
}

const MAX_TURN = 24 * Math.PI / 180, MIN_TURN = 0.01 * Math.PI / 180

/**
 * Дуги в НЕзамкнутой ломаной Q (у замкнутого контура последняя точка повторяет первую).
 * -> [{ i0, i1, cx, cy, r, ccw, sweep }] — дуга идёт от Q[i0] до Q[i1], sweep — угол, рад (> 0)
 */
export function arcRuns(Q, tol = 0.02) {
  const n = Q.length, runs = []
  if (n < 4) return runs
  const len = i => D(Q[i], Q[i + 1])                       // хорда i -> i + 1
  const turn = i => {                                      // поворот в точке i (со знаком)
    const ax = Q[i][0] - Q[i - 1][0], ay = Q[i][1] - Q[i - 1][1], bx = Q[i + 1][0] - Q[i][0], by = Q[i + 1][1] - Q[i][1]
    return Math.atan2(ax * by - ay * bx, ax * bx + ay * by)
  }
  const same = (a, b) => Math.abs(a - b) <= 0.02 * Math.max(a, b) + 0.01
  let i = 0
  while (i + 3 < n) {
    // пробуем начать дугу в точке i: хорды i, i+1, i+2
    const l0 = len(i), t0 = i + 1 < n - 1 ? turn(i + 1) : 0
    const fits = (j, c) => {                               // хорда j -> j + 1 продолжает дугу
      if (!same(len(j), l0)) return false
      const t = turn(j)
      if (t * t0 <= 0 || Math.abs(t) > MAX_TURN || Math.abs(t) < MIN_TURN || Math.abs(t - t0) > Math.abs(t0) * 0.05 + 1e-4) return false
      return !c || Math.abs(D(Q[j + 1], [c.cx, c.cy]) - c.r) <= tol
    }
    if (!(l0 > 1e-6) || Math.abs(t0) > MAX_TURN || Math.abs(t0) < MIN_TURN || !fits(i + 1, null)) { i++; continue }
    const c0 = circle3(Q[i], Q[i + 1], Q[i + 2])
    if (!c0 || !(c0.r < 1e5)) { i++; continue }
    let j = i + 2                                          // последняя точка дуги
    // окружность уточняется по мере роста дуги: по крайним и средней точкам она точнее, чем по первым трём
    while (j + 1 < n && fits(j, circle3(Q[i], Q[(i + j) >> 1], Q[j]) || c0)) j++
    if (j - i < 3) { i++; continue }
    const c = circle3(Q[i], Q[(i + j) >> 1], Q[j]) || c0
    let ok = true
    for (let k = i; k <= j && ok; k++) ok = Math.abs(D(Q[k], [c.cx, c.cy]) - c.r) <= tol
    const cc = ok ? c : c0
    const step = 2 * Math.asin(Math.min(1, l0 / (2 * cc.r)))
    runs.push({ i0: i, i1: j, cx: cc.cx, cy: cc.cy, r: cc.r, ccw: t0 > 0, sweep: step * (j - i) })
    i = j
  }
  return runs
}

function dedupeClosed(P) {
  const out = []
  for (const q of P) { const l = out[out.length - 1]; if (!l || D(q, l) > 1e-6) out.push([q[0], q[1]]) }
  while (out.length > 1 && D(out[0], out[out.length - 1]) <= 1e-6) out.pop()
  return out
}

/**
 * Замкнутый контур -> отрезки и дуги: [{ a, b }] | [{ a, b, cx, cy, r, ccw, sweep }]
 * Обход начинается с настоящего угла контура (если он есть), чтобы дуга не рвалась на стыке начала и конца.
 */
export function loopElements(poly, tol = 0.02) {
  let P = dedupeClosed(poly)
  const n = P.length
  if (n < 3) return []
  // начало — в точке с самым резким изломом
  let s = 0, best = -1
  for (let i = 0; i < n; i++) {
    const a = P[(i - 1 + n) % n], b = P[i], c = P[(i + 1) % n]
    const t = Math.abs(Math.atan2((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]), (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])))
    const l = Math.abs(D(a, b) - D(b, c))                  // либо излом, либо смена длины хорды (стык прямой и дуги)
    const score = t > MAX_TURN ? 1e6 + t : l
    if (score > best) { best = score; s = i }
  }
  P = [...P.slice(s), ...P.slice(0, s)]
  const Q = [...P, P[0]], runs = arcRuns(Q, tol), out = []
  let i = 0
  for (const r of runs) {
    for (; i < r.i0; i++) out.push({ a: Q[i], b: Q[i + 1] })
    out.push({ a: Q[r.i0], b: Q[r.i1], cx: r.cx, cy: r.cy, r: r.r, ccw: r.ccw, sweep: r.sweep })
    i = r.i1
  }
  for (; i < n; i++) out.push({ a: Q[i], b: Q[i + 1] })
  return out
}

/** Точки дуги el (без первой, с последней): отклонение хорды от дуги не больше sag мм */
export function arcPoints(el, sag = 0.005) {
  const stepMax = Math.min(5 * Math.PI / 180, 2 * Math.acos(Math.max(0, 1 - sag / el.r)))
  const k = Math.max(2, Math.ceil(el.sweep / stepMax - 1e-9))
  const a0 = Math.atan2(el.a[1] - el.cy, el.a[0] - el.cx), dir = el.ccw ? 1 : -1, pts = []
  for (let i = 1; i < k; i++) { const a = a0 + dir * el.sweep * i / k; pts.push([el.cx + el.r * Math.cos(a), el.cy + el.r * Math.sin(a)]) }
  pts.push([el.b[0], el.b[1]])
  return pts
}

/**
 * Тот же замкнутый контур, но дуги разбиты так мелко, что отличить их от настоящей дуги нельзя
 * (отклонение не больше sag мм). Прямые участки и углы не меняются.
 */
export function smoothLoop(poly, sag = 0.005) {
  const els = loopElements(poly)
  if (!els.some(e => e.r)) return poly
  const out = []
  for (const e of els) { if (e.r) out.push(...arcPoints(e, sag)); else out.push([e.b[0], e.b[1]]) }
  return out
}
