/**
 * Точная укладка «как в тетрисе» — по реальным контурам, без растровой сетки.
 *
 * Растровая укладка (trueShapeNesting) работает на сетке ячеек ~7 мм и
 * закладывает зазор реза через ячейки, поэтому каждая пара деталей занимает
 * лишние 5–10 мм, а на листе, где рядом умещается 3 пары Г-образных деталей,
 * это стоит целой детали. Здесь деталь ставится с миллиметровой точностью:
 *
 *   1. деталь в каждом допустимом повороте (0/180 всегда, 90/270 — если
 *      вращение включено у детали) "роняется" сверху листа в разных
 *      столбцах (X-кандидаты: сетка + привязка к краям и вершинам уже
 *      уложенных деталей — так находятся пазы и ниши);
 *   2. съезжает к нулю по осям в порядке, заданном направлением укладки, до
 *      контакта с зазором ровно kerf между КОНТУРАМИ;
 *   3. из всех кандидатов выбирается тот, что меньше всего увеличивает
 *      занятый габарит листа (плотность), при равенстве — ближе к нулю.
 *
 * Порядок деталей перебирается (по убыванию площади/габарита + случайные
 * перестановки) до дедлайна; побеждает раскладка с меньшим числом листов,
 * при равенстве — где на последний лист ушло меньше материала (первые листы
 * забиты плотнее, остаток — одним крупным обрезком).
 */

import { makeEntry, slideEntry, entryClear, bboxOf, orderFor } from './gravity'

const GRID_STEP = 60   // мм, шаг сетки X-кандидатов
const BUCKET = 20      // мм, округление X-кандидатов (дубли не считаем)
const CELL = 10        // мм, ячейка растра «пустот» (только для оценки, не для самой укладки)
const TOP_PER_VARIANT = 3   // сколько лучших по габариту кандидатов каждого поворота проверяем на «запертые пустоты»
const TRAPPED_WEIGHT = 1.5  // штраф за запертую пустоту относительно занятого габарита

function polyArea(poly) {
  let a = 0
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length]
    a += x1 * y2 - x2 * y1
  }
  return Math.abs(a) / 2
}

function pointInPoly(px, py, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j]
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside
  }
  return inside
}

// Ячейки растра, занятые контуром (по центру ячейки).
function polyCells(poly, cols, rows) {
  const bb = bboxOf(poly)
  const c0 = Math.max(0, Math.floor(bb.minX / CELL)), c1 = Math.min(cols - 1, Math.floor(bb.maxX / CELL))
  const r0 = Math.max(0, Math.floor(bb.minY / CELL)), r1 = Math.min(rows - 1, Math.floor(bb.maxY / CELL))
  const out = []
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      if (pointInPoly((c + 0.5) * CELL, (r + 0.5) * CELL, poly)) out.push(r * cols + c)
    }
  }
  return out
}

// «Запертая» пустота: свободные ячейки, до которых уже нельзя добраться со
// стороны верха и правого края листа (детали ставятся, падая сверху, и
// съезжают к нулю — в замкнутый карман никто больше не попадёт). Именно такой
// карман остаётся, если Г-образную деталь положить в угол листа «пустой
// стороной» — её вогнутость оказывается закрыта краями листа.
function trappedArea(sheet, extraCells, topRow) {
  const { grid, cols } = sheet
  // выше topRow (габарит занятого + деталь) всё свободно и открыто — считаем
  // только нижнюю часть листа
  const rows = Math.min(sheet.rows, topRow + 2)
  const occ = grid.slice(0, cols * rows)
  for (const i of extraCells) if (i < occ.length) occ[i] = 1
  const seen = new Uint8Array(cols * rows)
  const stack = []
  const push = i => { if (!occ[i] && !seen[i]) { seen[i] = 1; stack.push(i) } }
  for (let c = 0; c < cols; c++) push((rows - 1) * cols + c)
  for (let r = 0; r < rows; r++) push(r * cols + cols - 1)
  while (stack.length) {
    const i = stack.pop()
    const c = i % cols, r = (i - c) / cols
    if (c > 0) push(i - 1)
    if (c < cols - 1) push(i + 1)
    if (r > 0) push(i - cols)
    if (r < rows - 1) push(i + cols)
  }
  let free = 0
  for (let i = 0; i < occ.length; i++) if (!occ[i] && !seen[i]) free++
  return free * CELL * CELL
}

function candidateXs(sheet, bw, usableX, kerf) {
  const maxX = usableX - bw
  const set = new Set()
  const add = v => { if (v >= -1e-9 && v <= maxX + 1e-9) set.add(Math.round(Math.max(0, Math.min(maxX, v)) / BUCKET) * BUCKET) }
  for (let x = 0; x <= maxX; x += GRID_STEP) add(x)
  add(0); add(maxX)
  for (const o of sheet.entries) {
    add(o.bb.maxX + kerf); add(o.bb.minX - kerf - bw)
    add(o.bb.minX); add(o.bb.maxX - bw)
    for (const [vx] of o.poly) { add(vx + kerf); add(vx - kerf - bw) }
  }
  return [...set].sort((a, b) => a - b)
}

// То же по Y — для боковой подачи (деталь заезжает в проём сбоку).
function candidateYs(sheet, bh, usableY, kerf) {
  const maxY = usableY - bh
  const set = new Set()
  const add = v => { if (v >= -1e-9 && v <= maxY + 1e-9) set.add(Math.round(Math.max(0, Math.min(maxY, v)) / BUCKET) * BUCKET) }
  for (let y = 0; y <= maxY; y += GRID_STEP) add(y)
  add(0); add(maxY)
  for (const o of sheet.entries) {
    add(o.bb.maxY + kerf); add(o.bb.minY - kerf - bh)
    add(o.bb.minY); add(o.bb.maxY - bh)
    for (const [, vy] of o.poly) { add(vy + kerf); add(vy - kerf - bh) }
  }
  return [...set].sort((a, b) => a - b)
}

// Лучшее место для детали на листе или null.
// Два способа подачи: сверху (деталь падает в столбец, затем съезжает к нулю)
// и справа (заезжает в горизонтальные проёмы, недоступные сверху).
function tryInsert(sheet, inst, usableX, usableY, kerf, direction) {
  const dropOrder = orderFor(direction)[0]
  const sideOrder = dropOrder.slice().reverse()
  const shortlist = []
  const settle = (e, order) => {
    for (let pass = 0; pass < 8; pass++) {
      let moved = false
      for (const axis of order) moved = slideEntry(e, sheet.entries, axis, kerf) || moved
      if (!moved) break
    }
  }
  for (const variant of inst.variants) {
    const lb = bboxOf(variant.polygon)
    const bw = lb.maxX - lb.minX, bh = lb.maxY - lb.minY
    if (bw > usableX + 1e-6 || bh > usableY + 1e-6) continue
    const found = []
    const consider = (tx, ty, order) => {
      const e = makeEntry(variant.polygon.map(p => [p[0] + tx, p[1] + ty]))
      if (!entryClear(e, sheet.entries, kerf)) return
      settle(e, order)
      if (e.bb.minX < -0.01 || e.bb.minY < -0.01 || e.bb.maxX > usableX + 0.01 || e.bb.maxY > usableY + 0.01) return
      if (!entryClear(e, sheet.entries, kerf)) return
      const envX = Math.max(sheet.envX, e.bb.maxX), envY = Math.max(sheet.envY, e.bb.maxY)
      found.push({ variant, entry: e, tx: tx + e.dx, ty: ty + e.dy, env: envX * envY, key: envX * envY * 1000 + (e.bb.minX + e.bb.minY) })
    }
    for (const x0 of candidateXs(sheet, bw, usableX, kerf)) consider(x0 - lb.minX, usableY - lb.maxY, dropOrder)
    if (sheet.entries.length) {
      for (const y0 of candidateYs(sheet, bh, usableY, kerf)) consider(usableX - lb.maxX, y0 - lb.minY, sideOrder)
    }
    found.sort((a, b) => a.key - b.key)
    // одинаковые итоговые позиции (разные старты сошлись в одну точку) не дублируем
    const uniq = []
    for (const f of found) {
      if (!uniq.some(u => Math.abs(u.entry.bb.minX - f.entry.bb.minX) < 0.5 && Math.abs(u.entry.bb.minY - f.entry.bb.minY) < 0.5)) uniq.push(f)
      if (uniq.length >= TOP_PER_VARIANT) break
    }
    shortlist.push(...uniq)
  }
  if (!shortlist.length) return null

  // Итоговый выбор — среди лучших по габариту кандидатов ВСЕХ поворотов:
  // занятый габарит + штраф за запертую пустоту. Так при равном габарите
  // деталь встаёт тем поворотом, который заполняет угол листа своим телом, а
  // вогнутость оставляет открытой для следующих деталей.
  let best = null, bestCost = Infinity
  const minEnv = Math.min(...shortlist.map(c => c.env))
  for (const c of shortlist) {
    if (c.env > minEnv * 1.15) continue // заметно больший габарит — пустоты не спасут
    const topRow = Math.min(sheet.rows - 1, Math.ceil(Math.max(sheet.envY, c.entry.bb.maxY) / CELL))
    const trapped = trappedArea(sheet, polyCells(c.entry.poly, sheet.cols, sheet.rows), topRow)
    const cost = c.env + TRAPPED_WEIGHT * trapped + (c.entry.bb.minX + c.entry.bb.minY) * 1e-3
    if (cost < bestCost) { bestCost = cost; best = c }
  }
  return best
}

async function packOrder(order, usableX, usableY, kerf, direction, deadline) {
  const sheets = []
  let counter = 0
  for (const inst of order) {
    if (Date.now() > deadline) return null
    let placed = false
    for (const sheet of sheets) {
      if (usableX * usableY - sheet.used < inst.polyArea) continue // по площади заведомо не влезает
      const r = tryInsert(sheet, inst, usableX, usableY, kerf, direction)
      if (r) { commit(sheet, inst, r); placed = true; break }
    }
    if (!placed) {
      const sheet = newSheet(usableX, usableY)
      const r = tryInsert(sheet, inst, usableX, usableY, kerf, direction)
      if (!r) return null // деталь не влезает даже на пустой лист
      commit(sheet, inst, r)
      sheets.push(sheet)
    }
    if (++counter % 2 === 0) await new Promise(res => setTimeout(res, 0))
  }
  return sheets
}

function newSheet(usableX, usableY) {
  const cols = Math.max(1, Math.ceil(usableX / CELL)), rows = Math.max(1, Math.ceil(usableY / CELL))
  return { entries: [], meta: [], envX: 0, envY: 0, used: 0, cols, rows, grid: new Uint8Array(cols * rows) }
}

function commit(sheet, inst, r) {
  for (const i of polyCells(r.entry.poly, sheet.cols, sheet.rows)) sheet.grid[i] = 1
  sheet.entries.push(r.entry)
  sheet.meta.push({ inst, variant: r.variant, x: r.tx, y: r.ty })
  sheet.envX = Math.max(sheet.envX, r.entry.bb.maxX)
  sheet.envY = Math.max(sheet.envY, r.entry.bb.maxY)
  sheet.used += polyArea(r.variant.polygon)
}

function stat(sheets) {
  const last = sheets[sheets.length - 1]
  return { count: sheets.length, lastUsed: last ? last.used : 0, lastEnv: last ? last.envX * last.envY : 0 }
}
// Меньше листов; при равенстве — меньше материала на последнем листе;
// при равенстве и этого — меньший занятый габарит последнего листа.
// Полное равенство — в пользу первого аргумента (точной укладки).
export function exactBetter(a, b) {
  if (!b) return true
  if (a.count !== b.count) return a.count < b.count
  const tol = Math.max(1, b.lastUsed * 1e-4)
  if (Math.abs(a.lastUsed - b.lastUsed) > tol) return a.lastUsed < b.lastUsed
  return a.lastEnv <= b.lastEnv + 1
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}
// Мутация «дожать первый лист»: деталь с более позднего листа переносится
// ближе к началу порядка — тогда она первой претендует на место на ранних
// листах, а вместо неё туда встаёт то, что раньше их занимало впустую.
function promote(order, laterIds) {
  const a = order.slice()
  const cand = a.map((x, i) => i).filter(i => laterIds.has(a[i].id))
  if (!cand.length) return perturb(order)
  const from = cand[Math.floor(Math.random() * cand.length)]
  const [piece] = a.splice(from, 1)
  const to = Math.floor(Math.random() * Math.max(1, Math.ceil(a.length * 0.6)))
  a.splice(to, 0, piece)
  return a
}
function perturb(order) {
  const a = order.slice()
  const swaps = 1 + Math.floor(Math.random() * 3)
  for (let s = 0; s < swaps; s++) {
    const i = Math.floor(Math.random() * a.length), j = Math.floor(Math.random() * a.length);
    [a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/**
 * Возвращает { sheets, stat } или null, если не успели уложить все детали.
 * sheets[i].meta[k] = { inst, variant, x, y } (x,y — сдвиг локального контура).
 */
export async function packExact({ instances, kerf, usableX, usableY, direction, deadline }) {
  instances.forEach(i => { i.polyArea = polyArea(i.variants[0].polygon) })
  const orders = [
    instances.slice().sort((a, b) => b.area - a.area),
    instances.slice().sort((a, b) => Math.max(b.variants[0].w, b.variants[0].h) - Math.max(a.variants[0].w, a.variants[0].h)),
  ]
  let best = null, bestStat = null, bestOrder = null
  let laterIds = new Set()
  const consider = async order => {
    const sheets = await packOrder(order, usableX, usableY, kerf, direction, deadline)
    if (!sheets) return
    const st = stat(sheets)
    if (exactBetter(st, bestStat)) {
      best = sheets; bestStat = st; bestOrder = order
      laterIds = new Set(sheets.slice(1).flatMap(sh => sh.meta.map(m => m.inst.id)))
    }
  }
  for (const o of orders) { if (Date.now() < deadline) await consider(o) }
  let guard = 0
  // Всё уложено на один лист — лучше уже некуда, дальше искать незачем.
  while (Date.now() < deadline && bestOrder && instances.length > 1 && guard++ < 500 && bestStat.count > 1) {
    const r = Math.random()
    await consider(r < 0.1 ? shuffle(instances.slice()) : r < 0.6 ? promote(bestOrder, laterIds) : perturb(bestOrder))
  }
  return best ? { sheets: best, stat: bestStat } : null
}
