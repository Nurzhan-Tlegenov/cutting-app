/**
 * "Гравитация" — финальная стяжка раскроя к началу координат листа (0,0)
 * с ТОЧНЫМ зазором реза между деталями.
 *
 * Система координат — та же, что во всех данных раскроя: X вправо, Y ВВЕРХ от
 * низа рабочей зоны (рабочая зона = лист минус отступы от края, поэтому (0,0)
 * это уже точка с учётом отступа). Деталь прижимается к нулю по X и Y, а
 * между деталями остаётся ровно kerf (ширина реза), не больше.
 *
 * Порядок осей задаёт направление укладки:
 *   along_y — сначала деталь съезжает вниз по Y (столбцы вдоль длинной
 *             стороны листа), затем влево по X;
 *   along_x — сначала влево по X (ряды вдоль ширины листа), затем вниз по Y;
 *   auto    — пробуются оба порядка, берётся тот, где детали ближе к нулю.
 *
 * Две модели зазора:
 *   - gravityRects    — детали-прямоугольники (rectangle-алгоритм): габарит уже
 *                       включает kerf (p.w/p.h = размер + kerf), зазор считается
 *                       по габаритам, как и при самой укладке;
 *   - gravityPolygons — true-shape (детали с контуром): зазор kerf — это
 *                       расстояние между реальными контурами (евклидово), а не
 *                       между прямоугольниками. Растровая укладка даёт зазор
 *                       кратный размеру ячейки (до ~2 ячеек вместо kerf) —
 *                       эта стяжка убирает лишнее с точностью до долей мм.
 *
 * Детали, помеченные мелкими при включённой опции «мелкие в центр»
 * (isSmall), не двигаются — они стоят там, где их просили поставить, но
 * остаются препятствиями для остальных.
 */

const EPS = 1e-6
const MOVE_EPS = 0.01      // мм — сдвиг меньше этого не считаем сдвигом
const MAX_PASSES = 30
const MIN_STEP = 2         // мм — минимальный шаг поиска контакта (тоньше деталей не бывает)
const MAX_CRAWL = 24       // мм — максимальный шаг при скольжении вплотную к соседу (при нарушении зазора уточняется делением пополам)

function orderFor(direction) {
  if (direction === 'along_y') return [['y', 'x']]
  if (direction === 'along_x') return [['x', 'y']]
  return [['y', 'x'], ['x', 'y']]
}

function score(items) {
  return items.reduce((a, p) => a + p.x + p.y, 0)
}

// ─── Прямоугольные габариты (rectangle-алгоритм) ────────────────────────────

function slideRect(items, idx, axis) {
  const a = items[idx]
  let target = 0
  for (let j = 0; j < items.length; j++) {
    if (j === idx) continue
    const b = items[j]
    if (axis === 'x') {
      if (a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS && b.x + b.w <= a.x + EPS) target = Math.max(target, b.x + b.w)
    } else {
      if (a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS && b.y + b.h <= a.y + EPS) target = Math.max(target, b.y + b.h)
    }
  }
  return target
}

function runRectOrder(items, order) {
  const out = items.map(p => ({ ...p }))
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let moved = false
    for (const axis of order) {
      const idxs = out.map((_, i) => i).sort((i, j) => out[i][axis] - out[j][axis])
      for (const i of idxs) {
        if (out[i].isSmall) continue
        const t = slideRect(out, i, axis)
        if (t < out[i][axis] - MOVE_EPS) { out[i][axis] = t; moved = true }
      }
    }
    if (!moved) break
  }
  return out
}

/** Возвращает новый массив placed (или исходный, если двигать нечего). */
export function gravityRects(placed, direction) {
  let best = null, bestScore = Infinity
  for (const order of orderFor(direction)) {
    const res = runRectOrder(placed, order)
    const sc = score(res)
    if (sc < bestScore) { best = res; bestScore = sc }
  }
  return best || placed
}

// ─── Реальные контуры (true-shape) ──────────────────────────────────────────

function bboxOf(poly) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const [x, y] of poly) {
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
  }
  return { minX, minY, maxX, maxY }
}

function isAxisRect(poly) {
  if (poly.length !== 4) return false
  const e = 1e-6
  const [a, b, c, d] = poly
  return (Math.abs(a[0] - b[0]) < e && Math.abs(b[1] - c[1]) < e && Math.abs(c[0] - d[0]) < e && Math.abs(d[1] - a[1]) < e) ||
         (Math.abs(a[1] - b[1]) < e && Math.abs(b[0] - c[0]) < e && Math.abs(c[1] - d[1]) < e && Math.abs(d[0] - a[0]) < e)
}

function orient(ax, ay, bx, by, cx, cy) { return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax) }

function properCross(a, b, c, d) {
  const o1 = orient(a[0], a[1], b[0], b[1], c[0], c[1])
  const o2 = orient(a[0], a[1], b[0], b[1], d[0], d[1])
  const o3 = orient(c[0], c[1], d[0], d[1], a[0], a[1])
  const o4 = orient(c[0], c[1], d[0], d[1], b[0], b[1])
  return ((o1 > EPS && o2 < -EPS) || (o1 < -EPS && o2 > EPS)) &&
         ((o3 > EPS && o4 < -EPS) || (o3 < -EPS && o4 > EPS))
}

function pointSegDist(px, py, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1]
  const l2 = dx * dx + dy * dy
  let t = l2 > 0 ? ((px - a[0]) * dx + (py - a[1]) * dy) / l2 : 0
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy))
}

// Расстояние между контурами; отрицательное (-1), если контуры пересекаются.
// Пары рёбер, чьи габариты заведомо дальше уже найденного минимума, пропускаются.
function polyDist(A, B) {
  const na = A.length, nb = B.length
  const aMinX = new Float64Array(na), aMaxX = new Float64Array(na), aMinY = new Float64Array(na), aMaxY = new Float64Array(na)
  const bMinX = new Float64Array(nb), bMaxX = new Float64Array(nb), bMinY = new Float64Array(nb), bMaxY = new Float64Array(nb)
  for (let i = 0; i < na; i++) {
    const p = A[i], q = A[(i + 1) % na]
    aMinX[i] = Math.min(p[0], q[0]); aMaxX[i] = Math.max(p[0], q[0]); aMinY[i] = Math.min(p[1], q[1]); aMaxY[i] = Math.max(p[1], q[1])
  }
  for (let j = 0; j < nb; j++) {
    const p = B[j], q = B[(j + 1) % nb]
    bMinX[j] = Math.min(p[0], q[0]); bMaxX[j] = Math.max(p[0], q[0]); bMinY[j] = Math.min(p[1], q[1]); bMaxY[j] = Math.max(p[1], q[1])
  }
  for (let i = 0; i < na; i++) {
    const a1 = A[i], a2 = A[(i + 1) % na]
    for (let j = 0; j < nb; j++) {
      if (aMaxX[i] < bMinX[j] || bMaxX[j] < aMinX[i] || aMaxY[i] < bMinY[j] || bMaxY[j] < aMinY[i]) continue
      if (properCross(a1, a2, B[j], B[(j + 1) % nb])) return -1
    }
  }
  let best = Infinity
  for (let i = 0; i < na; i++) {
    const a1 = A[i]
    for (let j = 0; j < nb; j++) {
      const dx = Math.max(bMinX[j] - a1[0], a1[0] - bMaxX[j], 0), dy = Math.max(bMinY[j] - a1[1], a1[1] - bMaxY[j], 0)
      if (dx * dx + dy * dy >= best * best) continue
      const d = pointSegDist(a1[0], a1[1], B[j], B[(j + 1) % nb])
      if (d < best) best = d
    }
  }
  for (let j = 0; j < nb; j++) {
    const b1 = B[j]
    for (let i = 0; i < na; i++) {
      const dx = Math.max(aMinX[i] - b1[0], b1[0] - aMaxX[i], 0), dy = Math.max(aMinY[i] - b1[1], b1[1] - aMaxY[i], 0)
      if (dx * dx + dy * dy >= best * best) continue
      const d = pointSegDist(b1[0], b1[1], A[i], A[(i + 1) % na])
      if (d < best) best = d
    }
  }
  return best
}

function bboxGap(a, b) {
  const sx = Math.max(b.minX - a.maxX, a.minX - b.maxX)
  const sy = Math.max(b.minY - a.maxY, a.minY - b.maxY)
  return { sx, sy, lb: Math.hypot(Math.max(0, sx), Math.max(0, sy)) }
}

// Минимальное расстояние от детали A (сдвинутой на shift к нулю по оси) до
// любой из others. Возвращает точное значение, если оно меньше need+5, иначе —
// нижнюю оценку (для шага поиска контакта её достаточно и она безопасна).
function minDist(A, others, axis, shift, need) {
  const bbA = { minX: A.bb.minX, maxX: A.bb.maxX, minY: A.bb.minY, maxY: A.bb.maxY }
  if (axis === 'x') { bbA.minX -= shift; bbA.maxX -= shift } else { bbA.minY -= shift; bbA.maxY -= shift }
  let shifted = null
  let m = Infinity
  for (const B of others) {
    const g = bboxGap(bbA, B.bb)
    // упрощённые контуры (pad > 0): реальное расстояние не меньше найденного минус погрешности
    const pad = (A.pad || 0) + (B.pad || 0)
    if (g.lb - pad >= m) continue
    let d
    if (A.rect && B.rect) {
      d = (g.sx < 0 && g.sy < 0) ? -1 : g.lb - pad
    } else if (g.lb - pad > need + 5) {
      d = g.lb - pad
    } else {
      if (!shifted) shifted = A.poly.map(p => axis === 'x' ? [p[0] - shift, p[1]] : [p[0], p[1] - shift])
      d = polyDist(shifted, B.poly)
      if (d >= 0) d -= pad
    }
    if (d < m) m = d
    if (m < need - EPS) return m
  }
  return m
}

// ─── Аналитический поиск контакта ───────────────────────────────────────────
// Деталь A едет по направлению d (единичный вектор вдоль оси) к нулю. Первое
// касание «зазор = kerf» — это либо вершина A встречает «капсулу» ребра B
// (ребро, раздутое на kerf: две параллельные линии + два круга на концах), либо
// вершина B встречает капсулу ребра A при обратном движении. Оба случая решаются
// в замкнутой форме — без пошагового ползания и многократных расчётов расстояния.

// Первый s >= 0, при котором точка a + s*d оказывается на расстоянии k от отрезка b1-b2.
// Infinity — если не встретит. Точка, уже находящаяся ближе k и едущая «вглубь», даёт 0.
function rayCapsule(ax, ay, dx, dy, b1, b2, k) {
  const ex = b2[0] - b1[0], ey = b2[1] - b1[1]
  const len = Math.hypot(ex, ey)
  let best = Infinity
  const circle = (cx, cy) => {
    const px = ax - cx, py = ay - cy
    const bq = px * dx + py * dy
    const c = px * px + py * py - k * k
    const disc = bq * bq - c
    if (disc < 0) return
    const r = Math.sqrt(disc)
    const s1 = -bq - r, s2 = -bq + r
    if (s2 <= 0) return          // касание позади
    const s = Math.max(s1, 0)
    if (s < best) best = s
  }
  circle(b1[0], b1[1]); circle(b2[0], b2[1])
  if (len > 1e-9) {
    const tx = ex / len, ty = ey / len
    const nx = -ty, ny = tx
    const nd = nx * dx + ny * dy
    if (Math.abs(nd) > 1e-9) {
      const sd0 = nx * (ax - b1[0]) + ny * (ay - b1[1]) // расстояние со знаком до линии ребра
      // движение «внутрь» полосы: |sd| уменьшается
      if (sd0 * nd < 0) {
        const sign = sd0 > 0 ? 1 : -1
        let s = (sign * k - sd0) / nd
        if (sd0 * sign < k) s = 0   // уже внутри полосы (в пределах допуска)
        if (s >= 0) {
          const u = tx * (ax + s * dx - b1[0]) + ty * (ay + s * dy - b1[1])
          if (u >= 0 && u <= len && s < best) best = s
        }
      }
    }
  }
  return best
}

// Максимальный сдвиг A к нулю по оси до касания с зазором kerf (с учётом
// погрешности упрощения контуров) — по всем препятствиям.
function contactDistance(A, others, axis, kerf) {
  const dx = axis === 'x' ? -1 : 0, dy = axis === 'y' ? -1 : 0
  let best = Infinity
  for (const B of others) {
    const k = kerf + (A.pad || 0) + (B.pad || 0)
    const nA = A.poly.length, nB = B.poly.length
    // грубая отсечка по габаритам: B должна пересекать полосу движения A (с запасом k)
    if (axis === 'x') {
      if (B.bb.minY - k >= A.bb.maxY || B.bb.maxY + k <= A.bb.minY) continue
    } else {
      if (B.bb.minX - k >= A.bb.maxX || B.bb.maxX + k <= A.bb.minX) continue
    }
    for (let i = 0; i < nA; i++) {
      const a = A.poly[i]
      for (let j = 0; j < nB; j++) {
        const s = rayCapsule(a[0], a[1], dx, dy, B.poly[j], B.poly[(j + 1) % nB], k)
        if (s < best) best = s
      }
    }
    for (let j = 0; j < nB; j++) {
      const b = B.poly[j]
      for (let i = 0; i < nA; i++) {
        const s = rayCapsule(b[0], b[1], -dx, -dy, A.poly[i], A.poly[(i + 1) % nA], k)
        if (s < best) best = s
      }
    }
  }
  return best
}

// Максимальный сдвиг детали A к нулю по оси, при котором до каждой другой
// детали остаётся расстояние >= kerf.
function maxSlide(A, all, axis, kerf) {
  const limit = axis === 'x' ? A.bb.minX : A.bb.minY // до нуля
  if (limit <= MOVE_EPS) return 0
  const others = all.filter(B => {
    if (B === A) return false
    const k = kerf + (A.pad || 0) + (B.pad || 0)
    if (axis === 'x') {
      if (!(A.bb.minY - k < B.bb.maxY && B.bb.minY < A.bb.maxY + k)) return false
      return B.bb.minX < A.bb.maxX && B.bb.maxX > A.bb.minX - limit - k
    }
    if (!(A.bb.minX - k < B.bb.maxX && B.bb.minX < A.bb.maxX + k)) return false
    return B.bb.minY < A.bb.maxY && B.bb.maxY > A.bb.minY - limit - k
  })
  if (!others.length) return limit
  const t = Math.min(limit, contactDistance(A, others, axis, kerf))
  if (t <= MOVE_EPS) return 0
  return t >= limit ? limit : Math.floor((t - 0.005) * 100) / 100
}

function buildEntries(placed) {
  return placed.map((p, i) => {
    const poly = (Array.isArray(p.polygon) && p.polygon.length > 2
      ? p.polygon.map(pt => [p.x + pt.x, p.y + pt.y])
      : [[p.x, p.y], [p.x + p.origX, p.y], [p.x + p.origX, p.y + p.origY], [p.x, p.y + p.origY]])
    return { i, poly, bb: bboxOf(poly), rect: isAxisRect(poly), fixed: !!p.isSmall, dx: 0, dy: 0 }
  })
}

function applyMove(e, axis, t) {
  const sh = axis === 'x' ? [-t, 0] : [0, -t]
  e.poly = e.poly.map(p => [p[0] + sh[0], p[1] + sh[1]])
  e.bb = bboxOf(e.poly)
  if (axis === 'x') e.dx -= t; else e.dy -= t
}

function runPolyOrder(placed, order, kerf) {
  const entries = buildEntries(placed)
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let moved = false
    for (const axis of order) {
      const idxs = entries.map((_, i) => i).sort((a, b) =>
        (axis === 'x' ? entries[a].bb.minX - entries[b].bb.minX : entries[a].bb.minY - entries[b].bb.minY))
      for (const k of idxs) {
        const e = entries[k]
        if (e.fixed) continue
        const t = maxSlide(e, entries, axis, kerf)
        if (t > MOVE_EPS) { applyMove(e, axis, t); moved = true }
      }
    }
    if (!moved) break
  }
  return entries
}

function isValid(entries, kerf) {
  const need = kerf - 0.02
  for (let a = 0; a < entries.length; a++) {
    for (let b = a + 1; b < entries.length; b++) {
      const A = entries[a], B = entries[b]
      const g = bboxGap(A.bb, B.bb)
      if (g.lb > kerf + 1) continue
      const d = (A.rect && B.rect) ? ((g.sx < 0 && g.sy < 0) ? -1 : g.lb) : polyDist(A.poly, B.poly)
      if (d < need) return false
    }
  }
  return true
}

/**
 * Стяжка контурных деталей. Возвращает новый массив placed (x/y обновлены);
 * если результат не прошёл проверку зазоров — исходный.
 */
export function gravityPolygons(placed, direction, kerf) {
  if (!placed.length) return placed
  let best = null, bestScore = Infinity
  for (const order of orderFor(direction)) {
    const entries = runPolyOrder(placed, order, kerf)
    const res = placed.map((p, i) => ({ ...p, x: p.x + entries[i].dx, y: p.y + entries[i].dy }))
    if (!isValid(entries, kerf)) continue
    const sc = score(res)
    if (sc < bestScore) { best = res; bestScore = sc }
  }
  return best || placed
}

// ─── Примитивы для точной укладки (exactPack.js) ────────────────────────────

export function makeEntry(poly, pad = 0) {
  return { poly, bb: bboxOf(poly), rect: isAxisRect(poly), pad, fixed: false, dx: 0, dy: 0 }
}

// Упрощение контура (Дуглас—Пекер) для быстрой геометрии: дуги в десятки
// вершин заменяются несколькими отрезками. pad — реальная погрешность
// (макс. расстояние исходных вершин до упрощённого контура); она вычитается
// из расстояния до соседа, так что настоящие контуры не сближаются меньше kerf.
export function simplifyPoly(poly, eps) {
  const n = poly.length
  if (n <= 8) return { poly, pad: 0 }
  const distSeg = (p, a, b) => pointSegDist(p[0], p[1], a, b)
  const keep = new Uint8Array(n)
  let i0 = 0, i1 = 0
  for (let i = 1; i < n; i++) { if (poly[i][0] < poly[i0][0]) i0 = i; if (poly[i][0] > poly[i1][0]) i1 = i }
  if (i0 === i1) return { poly, pad: 0 }
  keep[i0] = 1; keep[i1] = 1
  const rec = (s, e) => {
    let idx = -1, md = eps
    for (let k = (s + 1) % n; k !== e; k = (k + 1) % n) {
      const d = distSeg(poly[k], poly[s], poly[e])
      if (d > md) { md = d; idx = k }
    }
    if (idx >= 0) { keep[idx] = 1; rec(s, idx); rec(idx, e) }
  }
  rec(i0, i1); rec(i1, i0)
  const out = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(poly[i])
  if (out.length < 3) return { poly, pad: 0 }
  let pad = 0
  for (const p of poly) {
    let m = Infinity
    for (let i = 0; i < out.length; i++) m = Math.min(m, distSeg(p, out[i], out[(i + 1) % out.length]))
    if (m > pad) pad = m
  }
  return { poly: out, pad }
}

/** Сдвигает деталь к нулю по оси до контакта (с зазором kerf). true — если сдвинулась. */
export function slideEntry(e, entries, axis, kerf) {
  const t = maxSlide(e, entries, axis, kerf)
  if (t > MOVE_EPS) { applyMove(e, axis, t); return true }
  return false
}

/** true, если деталь не пересекает другие и держит с ними зазор >= kerf. */
function pointInPolyXY(pt, poly) {
  const px = pt[0], py = pt[1]
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1]
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside
  }
  return inside
}

export function entryClear(e, entries, kerf) {
  const need = kerf - 0.02
  for (const B of entries) {
    if (B === e) continue
    const g = bboxGap(e.bb, B.bb)
    const pad = (e.pad || 0) + (B.pad || 0)
    if (g.lb - pad > kerf + 1) continue
    let d = (e.rect && B.rect) ? ((g.sx < 0 && g.sy < 0) ? -1 : g.lb) : polyDist(e.poly, B.poly)
    // polyDist видит только пересечение/сближение КОНТУРОВ: если один контур
    // целиком лежит внутри другого (например, составная деталь-пара 704×1036
    // накрыла мелкие детали), границы не пересекаются и расстояние выходит
    // положительным — раньше это давало наложение деталей друг на друга
    // (случалось при «дожиме» листа). Проверяем вложенность явно.
    if (d >= 0 && g.sx < 0 && g.sy < 0 && (pointInPolyXY(B.poly[0], e.poly) || pointInPolyXY(e.poly[0], B.poly))) return false
    if (d >= 0) d -= pad
    if (d < need) return false
  }
  return true
}

export { bboxOf, orderFor }
