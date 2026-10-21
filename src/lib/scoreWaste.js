/**
 * Шинковка отходов: надсечки по отходам листа (не по деталям и не по деловым обрезкам), чтобы крупные куски
 * отхода легко ломались руками и укладывались в корзину. Фреза идёт одной прямой на глубину «толщина − недорез»
 * (см. ops.score в cncSettings.js и buildSheetGcode в gcode.js).
 *
 * Как считается:
 *   1. Лист (физический, с отступами) бьётся на клетки CELL мм. Занято — детали (контур, раздвинутый на радиус
 *      фрезы + зазор) и деловые обрезки (тоже с зазором); остальное — отход.
 *   2. Тонкие полоски отхода (уже MIN_W) убираются «открытием» маски: они и так ломаются рукой, а главное — без
 *      этого узкая полоска отступа по периметру сцепляла бы все отходы листа в один кусок.
 *   3. Каждый связный кусок отхода (полоса любой формы) длиннее шага делится на равные части по своему габариту:
 *      по X — вертикальными линиями, по Y — горизонтальными. Линия идёт только по отходу (по исходной маске, т.е. и через
 *      тонкую полоску отступа до самого края листа) и прерывается на деталях и обрезках.
 *
 * Координаты: как на карте и в G-коде — (0,0) — левый нижний угол ЛИСТА, X — ширина, Y — длина, Y вверх.
 * -> [{ a: [x, y], b: [x, y], dir: 'v' | 'h' }]
 */
const CELL = 5          // мм — клетка маски
const MIN_W = 15        // мм — отход уже этого не шинкуется (полоска отступа по краю листа)
const MIN_LEN = 15        // мм — короче этого надсечка не делается

function pointInPoly(x, y, P) {
  let inside = false
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const [xi, yi] = P[i], [xj, yj] = P[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/**
 * geo — sheetGeo (sheetW, sheetL, marginL, marginB); outlines — контуры деталей на листе [[x, y]…] (уже раздвинутые
 * на радиус фрезы + зазор); offcuts — деловые обрезки { x, y, w, h } в координатах рабочей зоны (Y вверх);
 * gap — отступ линии от обрезка (радиус фрезы + зазор); stepX / stepY — шаг деления, мм (0 / пусто — не делить по этой оси).
 */
export function scoreLines({ geo, outlines = [], offcuts = [], gap = 4, stepX = 400, stepY = 400 }) {
  const W = Number(geo.sheetW) || 0, L = Number(geo.sheetL) || 0
  if (!(W > 0 && L > 0)) return []
  const nx = Math.ceil(W / CELL), ny = Math.ceil(L / CELL)
  const free = new Uint8Array(nx * ny).fill(1)
  const cx = i => (i + 0.5) * CELL, cy = j => (j + 0.5) * CELL
  const ci = x => Math.max(0, Math.min(nx - 1, Math.floor(x / CELL))), cj = y => Math.max(0, Math.min(ny - 1, Math.floor(y / CELL)))
  // детали
  for (const P of outlines) {
    if (!P || P.length < 3) continue
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const [x, y] of P) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
    for (let j = cj(y0); j <= cj(y1); j++) for (let i = ci(x0); i <= ci(x1); i++) {
      if (!free[j * nx + i]) continue
      if (pointInPoly(cx(i), cy(j), P)) free[j * nx + i] = 0
    }
  }
  // деловые обрезки (с зазором)
  const mL = Number(geo.marginL) || 0, mB = Number(geo.marginB) || 0
  for (const o of offcuts) {
    const x0 = mL + o.x - gap, x1 = mL + o.x + o.w + gap, y0 = mB + o.y - gap, y1 = mB + o.y + o.h + gap
    for (let j = cj(y0); j <= cj(y1); j++) for (let i = ci(x0); i <= ci(x1); i++) {
      if (cx(i) > x0 && cx(i) < x1 && cy(j) > y0 && cy(j) < y1) free[j * nx + i] = 0
    }
  }
  // «открытие»: убираем полоски уже MIN_W (эрозия + дилатация квадратом) — это узкая полоска отступа по краю листа,
  // она сама отламывается и без неё не сцепляет все отходы листа в один кусок
  const K = Math.max(1, Math.round((MIN_W / CELL - 1) / 2))
  const erode = (src, val) => {                          // val = 1: эрозия единиц; val = 0: дилатация (эрозия нулей)
    const t = new Uint8Array(nx * ny), out = new Uint8Array(nx * ny)
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {        // по X
      let ok = 1
      for (let d = -K; d <= K && ok; d++) { const ii = i + d; if (ii < 0 || ii >= nx) continue; if (src[j * nx + ii] !== val) ok = 0 }
      t[j * nx + i] = ok ? val : 1 - val
    }
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {        // по Y
      let ok = 1
      for (let d = -K; d <= K && ok; d++) { const jj = j + d; if (jj < 0 || jj >= ny) continue; if (t[jj * nx + i] !== val) ok = 0 }
      out[j * nx + i] = ok ? val : 1 - val
    }
    return out
  }
  const opened = erode(erode(free, 1), 0)
  // связные куски отхода (полоса любой формы — один кусок)
  const reg = new Int32Array(nx * ny).fill(-1)
  const regions = [], stack = []
  for (let s0 = 0; s0 < nx * ny; s0++) {
    if (!opened[s0] || reg[s0] >= 0) continue
    const id = regions.length, R = { i0: nx, i1: -1, j0: ny, j1: -1 }
    regions.push(R); reg[s0] = id; stack.push(s0)
    while (stack.length) {
      const c = stack.pop(), i = c % nx, j = (c - i) / nx
      if (i < R.i0) R.i0 = i; if (i > R.i1) R.i1 = i; if (j < R.j0) R.j0 = j; if (j > R.j1) R.j1 = j
      if (i > 0 && opened[c - 1] && reg[c - 1] < 0) { reg[c - 1] = id; stack.push(c - 1) }
      if (i < nx - 1 && opened[c + 1] && reg[c + 1] < 0) { reg[c + 1] = id; stack.push(c + 1) }
      if (j > 0 && opened[c - nx] && reg[c - nx] < 0) { reg[c - nx] = id; stack.push(c - nx) }
      if (j < ny - 1 && opened[c + nx] && reg[c + nx] < 0) { reg[c + nx] = id; stack.push(c + nx) }
    }
  }
  const sx = Number(stepX) || 0, sy = Number(stepY) || 0
  const out = []
  // протяжённость куска id поперёк линии в клетке (i, j): длина сплошного отхода этого куска вдоль оси деления
  const span = (i, j, id, alongX) => {
    let a = alongX ? i : j, b = a
    const at = k => (alongX ? j * nx + k : k * nx + i), n = alongX ? nx : ny
    while (a > 0 && reg[at(a - 1)] === id) a--
    while (b < n - 1 && reg[at(b + 1)] === id) b++
    return (b - a + 1) * CELL
  }
  // линия по столбцу idx (vertical) / строке idx через кусок id: каждый отрезок свободного отхода, задевающий кусок,
  // если в этом месте кусок длиннее шага (маленький выступ большого куска лишний раз не режется)
  const runs = (idx, vertical, id, step) => {
    const n = vertical ? ny : nx
    const at = k => (vertical ? k * nx + idx : idx * nx + k)
    let k = 0
    while (k < n) {
      if (!free[at(k)]) { k++; continue }
      let e = k, best = 0
      while (e < n && free[at(e)]) {
        if (reg[at(e)] === id) best = Math.max(best, vertical ? span(idx, e, id, true) : span(e, idx, id, false))
        e++
      }
      if (best > step + 1e-6) {
        // концы: до края листа, если отрезок упирается в край сетки, иначе — на клетку короче (запас до детали)
        const a = k === 0 ? 0 : (k + 1) * CELL, b = e === n ? (vertical ? L : W) : (e - 1) * CELL
        if (b - a >= MIN_LEN) out.push(vertical ? { a: [cx(idx), a], b: [cx(idx), b], dir: 'v' } : { a: [a, cy(idx)], b: [b, cy(idx)], dir: 'h' })
      }
      k = e
    }
  }
  // каждый кусок длиннее шага делится на равные части по своему габариту: по X — вертикальными линиями, по Y — горизонтальными
  regions.forEach((R, id) => {
    const w = (R.i1 - R.i0 + 1) * CELL, h = (R.j1 - R.j0 + 1) * CELL
    if (sx > 0 && w > sx + 1e-6) {
      const n = Math.ceil(w / sx - 1e-9)
      for (let k = 1; k < n; k++) runs(Math.min(R.i1, Math.max(R.i0, Math.round(R.i0 + (R.i1 - R.i0 + 1) * k / n - 0.5))), true, id, sx)
    }
    if (sy > 0 && h > sy + 1e-6) {
      const n = Math.ceil(h / sy - 1e-9)
      for (let k = 1; k < n; k++) runs(Math.min(R.j1, Math.max(R.j0, Math.round(R.j0 + (R.j1 - R.j0 + 1) * k / n - 0.5))), false, id, sy)
    }
  })
  // одна и та же линия — один раз
  const uniq = new Map()
  for (const s of out) {
    const key = `${s.dir}:${s.a[0].toFixed(1)},${s.a[1].toFixed(1)}-${s.b[0].toFixed(1)},${s.b[1].toFixed(1)}`
    if (!uniq.has(key)) uniq.set(key, s)
  }
  return [...uniq.values()]
}
