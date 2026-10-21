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
 *   4. Г-образные куски надсекаются по стыку, концы надсечек доводятся до реза детали / обрезка или за край листа.
 * -> [{ a: [x, y], b: [x, y], dir: 'v' | 'h', openA, openB }] — open: конец в резе / за листом (вход прямой)
 */
const CELL = 5          // мм — клетка маски
const MIN_W = 15        // мм — отход уже этого не шинкуется (полоска отступа по краю листа)
const MIN_LEN = 15        // мм — короче этого надсечка не делается
const FILL = 0.85        // кусок, заполняющий свой габарит меньше, — не прямоугольный (Г-образный)

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
 * paths — обходы контуров деталей по центру фрезы (туда доводятся концы надсечек), r — радиус фрезы;
 * gap — отступ линии от обрезка (радиус фрезы + зазор); stepX / stepY — шаг деления, мм (0 / пусто — не делить по этой оси).
 */
export function scoreLines({ geo, outlines = [], paths = [], offcuts = [], r = 3, gap = 4, stepX = 400, stepY = 400 }) {
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
  // за краем листа при эрозии — «не отход»: иначе узкая полоска у самого края листа не убиралась бы
  const erode = (src, val) => {                          // val = 1: эрозия единиц; val = 0: дилатация (эрозия нулей)
    const t = new Uint8Array(nx * ny), out = new Uint8Array(nx * ny)
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {        // по X
      let ok = 1
      for (let d = -K; d <= K && ok; d++) { const ii = i + d; if (ii < 0 || ii >= nx) { if (val) ok = 0; continue } if (src[j * nx + ii] !== val) ok = 0 }
      t[j * nx + i] = ok ? val : 1 - val
    }
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {        // по Y
      let ok = 1
      for (let d = -K; d <= K && ok; d++) { const jj = j + d; if (jj < 0 || jj >= ny) { if (val) ok = 0; continue } if (t[jj * nx + i] !== val) ok = 0 }
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
  // ── Г-образные куски не оставляем ──
  // Куски отхода после надсечек: если кусок не прямоугольный (Г, Т, П — заполняет свой габарит меньше чем на FILL),
  // в нём ищется самый большой прямоугольник, и по его сторонам, где кусок продолжается дальше, — надсечка по стыку.
  // Повторяется, пока непрямоугольных кусков не останется.
  const cut = new Uint8Array(nx * ny)
  const mark = sg => {
    // концы линии укорочены на клетку (запас до детали) — режем маску и по этим клеткам, иначе куски остаются сцеплены
    if (sg.dir === 'v') { const i = ci(sg.a[0]); for (let j = Math.max(0, cj(Math.min(sg.a[1], sg.b[1])) - 1); j <= Math.min(ny - 1, cj(Math.max(sg.a[1], sg.b[1])) + 1); j++) cut[j * nx + i] = 1 }
    else { const j = cj(sg.a[1]); for (let i = Math.max(0, ci(Math.min(sg.a[0], sg.b[0])) - 1); i <= Math.min(nx - 1, ci(Math.max(sg.a[0], sg.b[0])) + 1); i++) cut[j * nx + i] = 1 }
  }
  out.forEach(mark)
  // надсечка по линии (по столбцу / строке idx), проходящая через клетки lo..hi, — продлевается по свободному отходу
  // idx — столбец / строка выступа (сразу за прямоугольником): по нему линия продлевается только поперёк выступа,
  // а не вдоль всей полосы
  // ok(c) — куда линию можно продлевать: свой кусок и узкие полоски, не попавшие в куски (зазор у детали, отступ у края)
  const seam = (vertical, pos, lo, hi, idx, ok = c => free[c]) => {
    const n = vertical ? ny : nx
    const at = k => (vertical ? k * nx + idx : idx * nx + k)
    let k = lo, e = hi + 1
    while (k > 0 && ok(at(k - 1))) k--
    while (e < n && ok(at(e))) e++
    const a0 = k === 0 ? 0 : (k + 1) * CELL, b0 = e === n ? (vertical ? L : W) : (e - 1) * CELL
    if (b0 - a0 < MIN_LEN) return null
    const sg = vertical ? { a: [pos, a0], b: [pos, b0], dir: 'v' } : { a: [a0, pos], b: [b0, pos], dir: 'h' }
    out.push(sg); mark(sg); return sg
  }
  const LEG = 6                                          // клеток — меньший выступ (30 мм) Г-образным не считается
  for (let round = 0; round < 8; round++) {
    const comp = new Int32Array(nx * ny).fill(-1), list = []
    for (let s0 = 0; s0 < nx * ny; s0++) {
      if (!opened[s0] || cut[s0] || comp[s0] >= 0) continue
      const C = { id: list.length, cells: [], i0: nx, i1: -1, j0: ny, j1: -1 }
      list.push(C); comp[s0] = C.id; stack.push(s0)
      while (stack.length) {
        const c = stack.pop(), i = c % nx, j = (c - i) / nx
        C.cells.push(c)
        if (i < C.i0) C.i0 = i; if (i > C.i1) C.i1 = i; if (j < C.j0) C.j0 = j; if (j > C.j1) C.j1 = j
        for (const q of [i > 0 ? c - 1 : -1, i < nx - 1 ? c + 1 : -1, j > 0 ? c - nx : -1, j < ny - 1 ? c + nx : -1]) {
          if (q >= 0 && opened[q] && !cut[q] && comp[q] < 0) { comp[q] = C.id; stack.push(q) }
        }
      }
    }
    let added = 0
    for (const C of list) {
      const bw = C.i1 - C.i0 + 1, bh = C.j1 - C.j0 + 1
      if (bw < LEG || bh < LEG || C.cells.length >= FILL * bw * bh) continue
      // самый большой прямоугольник внутри куска (гистограммы по строкам)
      const hg = new Int32Array(bw)
      let best = null
      for (let j = C.j0; j <= C.j1; j++) {
        for (let x = 0; x < bw; x++) hg[x] = comp[j * nx + C.i0 + x] === C.id ? hg[x] + 1 : 0
        const st = []
        for (let x = 0; x <= bw; x++) {
          const h = x < bw ? hg[x] : 0
          while (st.length && hg[st[st.length - 1]] >= h) {
            const top = st.pop(), hh = hg[top], left = st.length ? st[st.length - 1] + 1 : 0, ww = x - left
            if (!best || ww * hh > best.area) best = { area: ww * hh, i0: C.i0 + left, i1: C.i0 + x - 1, j0: j - hh + 1, j1: j }
          }
          st.push(x)
        }
      }
      if (!best) continue
      // стороны прямоугольника, за которыми кусок продолжается «ножкой»: выступ глубже своей ширины (и не мельче LEG).
      // Широкий неглубокий выступ — это ступенька полосы (полоса стала толще), он не отделяется
      const inC = (i, j) => i >= 0 && i < nx && j >= 0 && j < ny && comp[j * nx + i] === C.id
      const depth = (i, j, di, dj) => { let d = 0; while (inC(i, j)) { d++; i += di; j += dj } return d }
      const sides = [
        { v: false, lo: best.i0, hi: best.i1, nb: k => [k, best.j0 - 1], d: [0, -1] },
        { v: false, lo: best.i0, hi: best.i1, nb: k => [k, best.j1 + 1], d: [0, 1] },
        { v: true, lo: best.j0, hi: best.j1, nb: k => [best.i0 - 1, k], d: [-1, 0] },
        { v: true, lo: best.j0, hi: best.j1, nb: k => [best.i1 + 1, k], d: [1, 0] },
      ]
      for (const sd of sides) {
        // клетки сразу за стороной: глубина выступа в каждой; участки с близкой глубиной — отдельно
        // (ступенька полосы и узкая ножка рядом с ней — разные участки)
        const cells = []
        for (let k = sd.lo; k <= sd.hi; k++) { const [i, j] = sd.nb(k); cells.push(inC(i, j) ? depth(i, j, sd.d[0], sd.d[1]) : 0) }
        let k = 0
        while (k < cells.length) {
          if (!cells[k]) { k++; continue }
          let e = k + 1
          while (e < cells.length && cells[e] && Math.abs(cells[e] - cells[e - 1]) <= 2) e++
          const w = e - k, dmin = Math.min(...cells.slice(k, e))
          if (dmin >= Math.max(LEG, w + 1)) {
            // надсечка — там, где ножка с обеих сторон уже зажата (не продолжается кусок), и ещё клетка вглубь
            const [i0, j0] = sd.nb(sd.lo + k), [i1, j1] = sd.nb(sd.lo + e - 1)
            const along = sd.v ? [0, 1] : [1, 0]
            let st = 0
            for (; st < dmin - 2; st++) {
              const ax = i0 + sd.d[0] * st - along[0], ay = j0 + sd.d[1] * st - along[1]
              const bx = i1 + sd.d[0] * st + along[0], by = j1 + sd.d[1] * st + along[1]
              if (!inC(ax, ay) && !inC(bx, by)) break
            }
            st = Math.min(dmin - 2, st + 1)
            const ti = i0 + sd.d[0] * st, tj = j0 + sd.d[1] * st
            const ok = c => free[c] && (!opened[c] || cut[c])                 // продлевать только по зазору, не по соседним кускам
            const lo = sd.lo + k, hi = sd.lo + e - 1
            if (sd.v ? seam(true, cx(ti), lo, hi, ti, ok) : seam(false, cy(tj), lo, hi, tj, ok)) added++
          }
          k = e
        }
      }
    }
    if (!added) break
  }

  // ── концы надсечек — в рез ──
  // Конец надсечки доводится до уже прорезанного реза (обход контура детали или обрезка — по центру фрезы) или
  // выводится за край листа: там фреза опускается прямо, в пустоту, и перемычки у детали не остаётся.
  // Конец, который не дошёл до реза (open: false), — в материале: там вход под наклоном.
  const segs = []
  for (const P of paths) for (let i = 0; i < P.length; i++) segs.push([P[i], P[(i + 1) % P.length]])
  for (const o of offcuts) {
    const x0 = mL + o.x - r, x1 = mL + o.x + o.w + r, y0 = mB + o.y - r, y1 = mB + o.y + o.h + r
    segs.push([[x0, y0], [x1, y0]], [[x1, y0], [x1, y1]], [[x1, y1], [x0, y1]], [[x0, y1], [x0, y0]])
  }
  const REACH = gap + 3 * CELL                           // насколько можно продлить конец до реза
  const hitT = (E, u) => {
    let t = Infinity
    for (const [p, q] of segs) {
      const ex = q[0] - p[0], ey = q[1] - p[1], den = u[0] * ey - u[1] * ex
      if (Math.abs(den) < 1e-9) continue
      const wx = p[0] - E[0], wy = p[1] - E[1]
      const tt = (wx * ey - wy * ex) / den, ss = (wx * u[1] - wy * u[0]) / den
      if (tt >= -1e-6 && ss >= -1e-6 && ss <= 1 + 1e-6 && tt < t) t = tt
    }
    return t
  }
  const snap = (E, u) => {
    const tEdge = u[0] > 0 ? W - E[0] : u[0] < 0 ? E[0] : u[1] > 0 ? L - E[1] : E[1]
    const t = hitT(E, u)
    if (tEdge <= REACH && tEdge <= t) return { p: [E[0] + u[0] * (tEdge + r + 1), E[1] + u[1] * (tEdge + r + 1)], open: true }
    if (t <= REACH) return { p: [E[0] + u[0] * t, E[1] + u[1] * t], open: true }
    return { p: E, open: false }
  }
  for (const sg of out) {
    const d = [sg.b[0] - sg.a[0], sg.b[1] - sg.a[1]], len = Math.hypot(d[0], d[1]) || 1, u = [d[0] / len, d[1] / len]
    const A = snap(sg.a, [-u[0], -u[1]]), B = snap(sg.b, u)
    sg.a = A.p; sg.b = B.p; sg.openA = A.open; sg.openB = B.open
  }
  // одна и та же линия — один раз
  const uniq = new Map()
  for (const s of out) {
    const key = `${s.dir}:${s.a[0].toFixed(1)},${s.a[1].toFixed(1)}-${s.b[0].toFixed(1)},${s.b[1].toFixed(1)}`
    if (!uniq.has(key)) uniq.set(key, s)
  }
  return [...uniq.values()]
}
