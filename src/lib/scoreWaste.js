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
 *   3. Отход раскладывается на прямоугольники (самый большой — первым); каждый делится на равные части: по X, если его габарит длиннее шага по X
 *      (вертикальные линии), по Y — горизонтальные. Линия идёт только по отходу (по исходной маске, т.е. и через
 *      тонкую полоску отступа до самого края листа) и прерывается на деталях и обрезках.
 *
 * Координаты: как на карте и в G-коде — (0,0) — левый нижний угол ЛИСТА, X — ширина, Y — длина, Y вверх.
 * -> [{ a: [x, y], b: [x, y], dir: 'v' | 'h' }]
 */
const CELL = 5          // мм — клетка маски
const MIN_W = 40        // мм — отход уже этого не шинкуется
const MIN_LEN = 60      // мм — короче этого надсечка не делается

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
  // «открытие»: убираем полоски уже MIN_W (эрозия + дилатация квадратом)
  const K = Math.max(1, Math.round(MIN_W / CELL / 2))
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
  // куски отхода — прямоугольники: из маски по очереди вынимается самый большой прямоугольник (гистограммный поиск),
  // пока остаются куски шире MIN_W. Так Г-образный отход делится как две полосы, а не по общему габариту
  const work = Uint8Array.from(opened)
  const rects = []
  const minCells = Math.max(1, Math.round(MIN_W / CELL))
  const hgt = new Int32Array(nx)
  for (let iter = 0; iter < 400; iter++) {
    let best = null
    hgt.fill(0)
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) hgt[i] = work[j * nx + i] ? hgt[i] + 1 : 0
      const st = []                                        // стек индексов с возрастающей высотой
      for (let i = 0; i <= nx; i++) {
        const h = i < nx ? hgt[i] : 0
        while (st.length && hgt[st[st.length - 1]] >= h) {
          const top = st.pop(), hh = hgt[top], left = st.length ? st[st.length - 1] + 1 : 0, ww = i - left
          if (hh >= minCells && ww >= minCells && (!best || ww * hh > best.area)) best = { area: ww * hh, i0: left, i1: i - 1, j0: j - hh + 1, j1: j }
        }
        st.push(i)
      }
    }
    if (!best) break
    rects.push(best)
    for (let j = best.j0; j <= best.j1; j++) for (let i = best.i0; i <= best.i1; i++) work[j * nx + i] = 0
  }
  const owner = new Int32Array(nx * ny).fill(-1)
  rects.forEach((R, n) => { R.n = n; for (let j = R.j0; j <= R.j1; j++) for (let i = R.i0; i <= R.i1; i++) owner[j * nx + i] = n })
  const sx = Number(stepX) || 0, sy = Number(stepY) || 0
  const out = []
  const push = (vertical, idx, a, b) => { if (b - a >= MIN_LEN) out.push(vertical ? { a: [cx(idx), a], b: [cx(idx), b], dir: 'v' } : { a: [a, cy(idx)], b: [b, cy(idx)], dir: 'h' }) }
  // линия по столбцу idx (vertical) / строке idx через прямоугольник R: по всему R и дальше по отходу, не занятому
  // другими прямоугольниками (тонкие полоски отступа — до самого края листа); в соседний прямоугольник не заходит
  const line = (idx, vertical, R) => {
    const n = vertical ? ny : nx, lo = vertical ? R.j0 : R.i0, hi = vertical ? R.j1 : R.i1
    const at = k => (vertical ? k * nx + idx : idx * nx + k)
    const ok = k => free[at(k)] && (owner[at(k)] < 0 || owner[at(k)] === R.n)
    let k = lo, e = hi + 1
    while (k > 0 && ok(k - 1)) k--
    while (e < n && ok(e)) e++
    // концы: до края листа, если пробег упирается в край сетки, иначе — на клетку короче (запас до детали)
    push(vertical, idx, k === 0 ? 0 : (k + 1) * CELL, e === n ? (vertical ? L : W) : (e - 1) * CELL)
  }
  for (const R of rects) {
    const w = (R.i1 - R.i0 + 1) * CELL, h = (R.j1 - R.j0 + 1) * CELL
    if (sx > 0 && w > sx + 1e-6) {
      const n = Math.ceil(w / sx - 1e-9)
      for (let k = 1; k < n; k++) line(Math.min(R.i1, Math.max(R.i0, Math.round(R.i0 + (R.i1 - R.i0 + 1) * k / n - 0.5))), true, R)
    }
    if (sy > 0 && h > sy + 1e-6) {
      const n = Math.ceil(h / sy - 1e-9)
      for (let k = 1; k < n; k++) line(Math.min(R.j1, Math.max(R.j0, Math.round(R.j0 + (R.j1 - R.j0 + 1) * k / n - 0.5))), false, R)
    }
    // граница с соседним прямоугольником отхода (Г-образный отход): надсечка по стыку, иначе две полосы останутся
    // одним куском. Правая и верхняя стороны — каждый стык один раз
    const side = (vertical, idx, nbr, lo, hi) => {
      let k = lo
      while (k <= hi) {
        const o = owner[vertical ? k * nx + nbr : nbr * nx + k]
        if (o < 0 || o === R.n) { k++; continue }
        let e = k
        while (e <= hi && owner[vertical ? e * nx + nbr : nbr * nx + e] === o) e++
        // оба куска вместе короче шага — ломаются как один, стык не нужен
        const Q = rects[o], span = vertical ? (R.i1 - R.i0 + Q.i1 - Q.i0 + 2) * CELL : (R.j1 - R.j0 + Q.j1 - Q.j0 + 2) * CELL, step = vertical ? sx : sy
        if (step > 0 && span <= step + 1e-6) { k = e; continue }
        push(vertical, idx, k === 0 ? 0 : (k + 1) * CELL, e === (vertical ? ny : nx) ? (vertical ? L : W) : (e - 1) * CELL)
        k = e
      }
    }
    if (R.i1 + 1 < nx) side(true, R.i1, R.i1 + 1, R.j0, R.j1)
    if (R.j1 + 1 < ny) side(false, R.j1, R.j1 + 1, R.i0, R.i1)
  }
  // одна и та же линия из двух прямоугольников — один раз
  const uniq = new Map()
  for (const s of out) {
    const key = `${s.dir}:${s.a[0].toFixed(1)},${s.a[1].toFixed(1)}-${s.b[0].toFixed(1)},${s.b[1].toFixed(1)}`
    if (!uniq.has(key)) uniq.set(key, s)
  }
  return [...uniq.values()]
}
