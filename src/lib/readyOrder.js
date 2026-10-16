// Порядок «по готовности» для пилы (форматно-раскроечный станок): на всех уровнях резов сначала куски, готовые
// сразу после реза (деталь ровно по ширине заготовки), от большого к малому; в конце заготовки — куски, которые ещё
// подрезаются (сначала с меньшей доработкой). Отрезал полосу, развернул: деталь — готова, следующая — готова, …,
// в конце полосы — то, что ещё подрезать.
// Это последний шаг после раскроя: карта раскладывается на дерево сквозных резов (beamSawXml.derive) и куски
// переставляются внутри своих заготовок — детали остаются в своих полосах, занятая область, остаток и число листов
// те же. Если карта не раскладывается на сквозные резы или после перестановки что-то не так — лист остаётся как был.
import { derive, depthOf } from './beamSawXml'

const EPS = 0.5
const slotDepth = sl => (sl.item ? 0 : depthOf(sl.child))
const byReady = slots => [...slots].sort((p, q) => slotDepth(p) - slotDepth(q) || q.a - p.a)

function place(node, ox, oy, moved) {
  node.slots = byReady(node.slots)
  let pos = (node.axis === 'x' ? ox : oy) + node.trim
  for (const sl of node.slots) {
    const sx = node.axis === 'x' ? pos : ox, sy = node.axis === 'x' ? oy : pos
    if (sl.item) moved.set(sl.item.part, { x: sx, y: sy })
    else {
      // дочерний регион строился от начала своего слота — сдвигаем его целиком
      place(sl.child, sx, sy, moved)
    }
    pos += sl.a
  }
}

function okSheet(placed, X, Y) {
  for (const p of placed) if (p.x < -0.01 || p.y < -0.01 || p.x + p.w > X + 0.01 || p.y + p.h > Y + 0.01) return false
  for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) {
    const a = placed[i], b = placed[j]
    if (a.x < b.x + b.w - 0.01 && b.x < a.x + a.w - 0.01 && a.y < b.y + b.h - 0.01 && b.y < a.y + a.h - 0.01) return false
  }
  return true
}

/** Один лист: usableX/usableY — рабочая зона без реза (как в результате), kerf — рез. -> лист (новый или тот же) */
export function readyOrderSheet(sheet, usableX, usableY, kerf) {
  const placed = sheet?.placed || []
  if (placed.length < 2) return sheet
  const k = Number(kerf) || 0
  const X = (sheet.usableX ?? usableX) + k, Y = (sheet.usableY ?? usableY) + k
  const items = placed.map(p => ({ x: p.x, y: p.y, w: p.w, h: p.h, part: p }))
  let best = null
  for (const ax of ['x', 'y']) {
    try {
      const t = derive(items, ax, 0, 0, ax === 'x' ? X : Y, ax === 'x' ? Y : X)
      if (!best || depthOf(t) < depthOf(best)) best = t
    } catch { /* по этой оси сквозных резов нет */ }
  }
  if (!best) return sheet
  const moved = new Map()
  place(best, 0, 0, moved)
  if (moved.size !== placed.length) return sheet
  let changed = false
  const next = placed.map(p => {
    const m = moved.get(p)
    if (Math.abs(m.x - p.x) > EPS / 10 || Math.abs(m.y - p.y) > EPS / 10) changed = true
    return { ...p, x: +m.x.toFixed(2), y: +m.y.toFixed(2) }
  })
  if (!changed || !okSheet(next, X, Y)) return sheet
  return { ...sheet, placed: next, freeRects: [] }
}

/** Результат раскроя целиком (листы-обрезки — со своей рабочей зоной) */
export function readyOrderResult(res) {
  if (!res?.sheets?.length) return res
  return { ...res, sheets: res.sheets.map(sh => readyOrderSheet(sh, res.usableX, res.usableY, res.kerf)) }
}
