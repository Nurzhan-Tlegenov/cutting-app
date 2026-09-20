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

const GRID_STEP = 40   // мм, шаг сетки X-кандидатов
const BUCKET = 10      // мм, округление X-кандидатов (дубли не считаем)

function polyArea(poly) {
  let a = 0
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length]
    a += x1 * y2 - x2 * y1
  }
  return Math.abs(a) / 2
}

function candidateXs(sheet, lbw, bw, usableX, kerf) {
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

// Лучшее место для детали на листе или null.
function tryInsert(sheet, inst, usableX, usableY, kerf, direction) {
  const orders = orderFor(direction)[0]
  let best = null, bestKey = Infinity
  for (const variant of inst.variants) {
    const lb = bboxOf(variant.polygon)
    const bw = lb.maxX - lb.minX, bh = lb.maxY - lb.minY
    if (bw > usableX + 1e-6 || bh > usableY + 1e-6) continue
    for (const x0 of candidateXs(sheet, lb.minX, bw, usableX, kerf)) {
      const tx = x0 - lb.minX, ty = usableY - lb.maxY
      const e = makeEntry(variant.polygon.map(p => [p[0] + tx, p[1] + ty]))
      if (!entryClear(e, sheet.entries, kerf)) continue
      for (let pass = 0; pass < 8; pass++) {
        let moved = false
        for (const axis of orders) moved = slideEntry(e, sheet.entries, axis, kerf) || moved
        if (!moved) break
      }
      if (e.bb.minX < -0.01 || e.bb.minY < -0.01 || e.bb.maxX > usableX + 0.01 || e.bb.maxY > usableY + 0.01) continue
      if (!entryClear(e, sheet.entries, kerf)) continue
      const envX = Math.max(sheet.envX, e.bb.maxX), envY = Math.max(sheet.envY, e.bb.maxY)
      const key = envX * envY * 1000 + (e.bb.minX + e.bb.minY)
      if (key < bestKey) { bestKey = key; best = { variant, entry: e, tx: tx + e.dx, ty: ty + e.dy } }
    }
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
      const r = tryInsert(sheet, inst, usableX, usableY, kerf, direction)
      if (r) { commit(sheet, inst, r); placed = true; break }
    }
    if (!placed) {
      const sheet = { entries: [], meta: [], envX: 0, envY: 0, used: 0 }
      const r = tryInsert(sheet, inst, usableX, usableY, kerf, direction)
      if (!r) return null // деталь не влезает даже на пустой лист
      commit(sheet, inst, r)
      sheets.push(sheet)
    }
    if (++counter % 2 === 0) await new Promise(res => setTimeout(res, 0))
  }
  return sheets
}

function commit(sheet, inst, r) {
  sheet.entries.push(r.entry)
  sheet.meta.push({ inst, variant: r.variant, x: r.tx, y: r.ty })
  sheet.envX = Math.max(sheet.envX, r.entry.bb.maxX)
  sheet.envY = Math.max(sheet.envY, r.entry.bb.maxY)
  sheet.used += polyArea(r.variant.polygon)
}

function stat(sheets) {
  return { count: sheets.length, lastUsed: sheets.length ? sheets[sheets.length - 1].used : 0 }
}
export function exactBetter(a, b) {
  if (!b) return true
  if (a.count !== b.count) return a.count < b.count
  return a.lastUsed < b.lastUsed
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
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
  const orders = [
    instances.slice().sort((a, b) => b.area - a.area),
    instances.slice().sort((a, b) => Math.max(b.variants[0].w, b.variants[0].h) - Math.max(a.variants[0].w, a.variants[0].h)),
  ]
  let best = null, bestStat = null, bestOrder = null
  const consider = async order => {
    const sheets = await packOrder(order, usableX, usableY, kerf, direction, deadline)
    if (!sheets) return
    const st = stat(sheets)
    if (exactBetter(st, bestStat)) { best = sheets; bestStat = st; bestOrder = order }
  }
  for (const o of orders) { if (Date.now() < deadline) await consider(o) }
  let guard = 0
  while (Date.now() < deadline && bestOrder && instances.length > 1 && guard++ < 500) {
    await consider(Math.random() < 0.25 ? shuffle(instances.slice()) : perturb(bestOrder))
  }
  return best ? { sheets: best, stat: bestStat } : null
}
