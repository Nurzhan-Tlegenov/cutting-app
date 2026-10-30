// Наведение порядка на листах прямоугольного раскроя (фрезер) — без потери плотности.
//
// Поиск находит плотную раскладку, но порядок столбцов в ней случайный: 261030_027 — на 1-м листе столбцы
// Д1 | Д3 | Д1 | Д3, хотя ровно так же входит Д3 | Д3 | Д1 | Д1; на последнем листе самая высокая деталь стоит
// посередине и делит свободное место на два обрезка, а «лесенкой» (высокая — к краю) обрезок один.
//
// 1) Столбцы. Ищется горизонтальная линия, которую не пересекает ни одна деталь, и под ней — вертикальные линии,
//    которые не пересекает ни одна деталь: между ними столбцы. Столбцы переставляются: высокие — к краю, ниже —
//    дальше (лесенка), одинаковые по составу — рядом. Детали внутри столбца не двигаются друг относительно друга.
// 2) Прижим. Каждая деталь сдвигается вниз, затем влево, пока не упрётся в край листа или в соседнюю деталь
//    (габарит детали уже включает рез — касание габаритов и есть зазор ровно в рез).
// Результат принимается, только если он не хуже прежнего по счёту поиска (листы, мелкие у края, обрезок) — см. liveNesting.

const EPS = 0.05

// полосы: горизонтальные линии, которые не пересекает ни одна деталь; в каждой полосе — столбцы
function columnsOnce(placed, right) {
  if (placed.length < 2) return null
  const ys = [...new Set([0, ...placed.flatMap(p => [p.y, p.y + p.h])])].sort((a, b) => a - b)
  const cutsY = ys.filter(Y => !placed.some(p => p.y < Y - EPS && p.y + p.h > Y + EPS))
  const moved = new Map()
  for (let k = 0; k < cutsY.length; k++) {
    const lo = cutsY[k], hi = k + 1 < cutsY.length ? cutsY[k + 1] : Infinity
    const band = placed.filter(p => p.y >= lo - EPS && p.y + p.h <= hi + EPS)
    if (band.length < 2) continue
    const xs = [...new Set([0, ...band.flatMap(p => [p.x, p.x + p.w])])].sort((a, b) => a - b)
    const cuts = xs.filter(c => !band.some(p => p.x < c - EPS && p.x + p.w > c + EPS))
    const blocks = []
    for (let i = 0; i < cuts.length; i++) {
      const a = cuts[i], b = i + 1 < cuts.length ? cuts[i + 1] : a
      if (b - a < EPS) continue
      const parts = band.filter(p => p.x >= a - EPS && p.x + p.w <= b + EPS)
      blocks.push({ a, b, parts, top: parts.length ? Math.max(...parts.map(p => p.y + p.h)) : 0,
        sig: parts.map(p => `${p.detailIndex}:${Math.round(p.x - a)},${Math.round(p.y - lo)}`).sort().join(' ') })
    }
    if (blocks.filter(b => b.parts.length).length < 2 || blocks[blocks.length - 1].b > right + EPS) continue
    // высокие — к краю, одинаковые — рядом, пустые промежутки — в конец (к общему свободному месту)
    const order = blocks.slice().sort((p, q) => (q.parts.length ? 1 : 0) - (p.parts.length ? 1 : 0) || q.top - p.top || (p.sig < q.sig ? -1 : p.sig > q.sig ? 1 : 0))
    if (order.every((b, i) => b === blocks[i])) continue
    let x = blocks[0].a
    for (const b of order) { for (const p of b.parts) moved.set(p, x + (p.x - b.a)); x += b.b - b.a }
  }
  return moved.size ? placed.map(p => (moved.has(p) ? { ...p, x: moved.get(p) } : p)) : null
}

// вниз, затем влево — до упора (несколько проходов: сдвиг одной детали освобождает место другой)
function settle(placed) {
  const ps = placed.map(p => ({ ...p }))
  const overlapX = (p, q) => p.x < q.x + q.w - EPS && q.x < p.x + p.w - EPS
  const overlapY = (p, q) => p.y < q.y + q.h - EPS && q.y < p.y + p.h - EPS
  for (let pass = 0; pass < 4; pass++) {
    let moved = false
    for (const p of ps.slice().sort((a, b) => a.y - b.y || a.x - b.x)) {
      let y = 0
      for (const q of ps) if (q !== p && overlapX(p, q) && q.y + q.h <= p.y + EPS) y = Math.max(y, q.y + q.h)
      if (y < p.y - EPS) { p.y = y; moved = true }
      let x = 0
      for (const q of ps) if (q !== p && overlapY(p, q) && q.x + q.w <= p.x + EPS) x = Math.max(x, q.x + q.w)
      if (x < p.x - EPS) { p.x = x; moved = true }
    }
    if (!moved) break
  }
  return ps
}

/** Листы после наведения порядка (те же детали, те же листы); right — правый край зоны укладки */
export function tidySheets(sheets, right) {
  return sheets.map(sh => {
    if (!sh?.placed?.length || sh.stock === 'offcut' || sh.placed.some(p => p.polygon || p.group)) return sh
    let placed = sh.placed
    for (let k = 0; k < 3; k++) { const c = columnsOnce(placed, right); if (!c) break; placed = c }
    placed = settle(placed)
    return { ...sh, placed }
  })
}
