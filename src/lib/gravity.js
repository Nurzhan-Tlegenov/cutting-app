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
  const xs = new Set(poly.map(p => Math.round(p[0] * 1000)))
  const ys = new Set(poly.map(p => Math.round(p[1] * 1000)))
  return xs.size === 2 && ys.size === 2
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
function polyDist(A, B, cutoff) {
  let best = Infinity
  const na = A.length, nb = B.length
  for (let i = 0; i < na; i++) {
    const a1 = A[i], a2 = A[(i + 1) % na]
    for (let j = 0; j < nb; j++) {
      const b1 = B[j], b2 = B[(j + 1) % nb]
      if (properCross(a1, a2, b1, b2)) return -1
    }
  }
  for (let i = 0; i < na; i++) {
    const a = A[i]
    for (let j = 0; j < nb; j++) {
      const d = pointSegDist(a[0], a[1], B[j], B[(j + 1) % nb])
      if (d < best) best = d
    }
  }
  for (let j = 0; j < nb; j++) {
    const b = B[j]
    for (let i = 0; i < na; i++) {
      const d = pointSegDist(b[0], b[1], A[i], A[(i + 1) % na])
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

// Расстояние между двумя деталями A (сдвинутой на shift по оси) и B.
function pairDist(A, B, shiftAxis, shift, need) {
  const bbA = { minX: A.bb.minX, maxX: A.bb.maxX, minY: A.bb.minY, maxY: A.bb.maxY }
  if (shiftAxis === 'x') { bbA.minX -= shift; bbA.maxX -= shift } else { bbA.minY -= shift; bbA.maxY -= shift }
  const g = bboxGap(bbA, B.bb)
  if (A.rect && B.rect) {
    // прямоугольник-прямоугольник: точная формула
    if (g.sx < 0 && g.sy < 0) return -1
    return g.lb
  }
  if (g.lb > need + 5) return g.lb // заведомо далеко — точное значение не нужно (нижняя оценка безопасна)
  const shifted = A.poly.map(p => shiftAxis === 'x' ? [p[0] - shift, p[1]] : [p[0], p[1] - shift])
  return polyDist(shifted, B.poly)
}

function minDist(A, others, axis, shift, need) {
  let m = Infinity
  for (const B of others) {
    const d = pairDist(A, B, axis, shift, need)
    if (d < m) m = d
    if (m < need - EPS) return m
  }
  return m
}

// Максимальный сдвиг детали A к нулю по оси, при котором до каждой другой
// детали остаётся расстояние >= kerf.
function maxSlide(A, all, axis, kerf) {
  const lo = axis === 'x' ? A.bb.minX : A.bb.minY
  const limit = lo // до нуля
  if (limit <= MOVE_EPS) return 0
  const need = kerf - 0.005
  // препятствия: те, что пересекают полосу движения (с запасом kerf) и лежат в сторону нуля
  const others = all.filter(B => {
    if (B === A) return false
    if (axis === 'x') {
      if (!(A.bb.minY - kerf < B.bb.maxY && B.bb.minY < A.bb.maxY + kerf)) return false
      return B.bb.minX < A.bb.maxX && B.bb.maxX > A.bb.minX - limit - kerf
    }
    if (!(A.bb.minX - kerf < B.bb.maxX && B.bb.minX < A.bb.maxX + kerf)) return false
    return B.bb.minY < A.bb.maxY && B.bb.maxY > A.bb.minY - limit - kerf
  })
  if (!others.length) return limit
  if (minDist(A, others, axis, 0, need) < need - EPS) return 0 // уже теснее kerf — не трогаем

  let t = 0
  for (let guard = 0; guard < 20000; guard++) {
    const f = minDist(A, others, axis, t, need)
    const step = Math.max(f - kerf, MIN_STEP)
    const nt = Math.min(t + step, limit)
    const fn = minDist(A, others, axis, nt, need)
    if (fn < need - EPS) {
      let a = t, b = nt
      for (let k = 0; k < 24; k++) {
        const m = (a + b) / 2
        if (minDist(A, others, axis, m, need) < need - EPS) b = m; else a = m
      }
      return Math.floor(a * 100) / 100
    }
    t = nt
    if (t >= limit - EPS) return limit
  }
  return t
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

export function makeEntry(poly) {
  return { poly, bb: bboxOf(poly), rect: isAxisRect(poly), fixed: false, dx: 0, dy: 0 }
}

/** Сдвигает деталь к нулю по оси до контакта (с зазором kerf). true — если сдвинулась. */
export function slideEntry(e, entries, axis, kerf) {
  const t = maxSlide(e, entries, axis, kerf)
  if (t > MOVE_EPS) { applyMove(e, axis, t); return true }
  return false
}

/** true, если деталь не пересекает другие и держит с ними зазор >= kerf. */
export function entryClear(e, entries, kerf) {
  const need = kerf - 0.02
  for (const B of entries) {
    if (B === e) continue
    const g = bboxGap(e.bb, B.bb)
    if (g.lb > kerf + 1) continue
    const d = (e.rect && B.rect) ? ((g.sx < 0 && g.sy < 0) ? -1 : g.lb) : polyDist(e.poly, B.poly)
    if (d < need) return false
  }
  return true
}

export { bboxOf, orderFor }
