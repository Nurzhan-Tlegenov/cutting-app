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

// Прижим: каждая деталь встаёт на самое низкое (вдоль Y — самое левое) свободное место, куда её можно переставить, —
// не только прямо вниз, но и со сдвигом вбок к краю соседа (261030_027: Д2 висела над Д4 из-за 2 мм, на которые
// заходила на соседний столбец, — сдвиг на 2 мм вправо, и она ложится на Д4). Выше / правее, чем была, деталь не уходит.
function settle(placed, right, top, yFirst) {
  const ps = placed.map(p => ({ ...p }))
  const hit = (x, y, p, q) => x < q.x + q.w - EPS && q.x < x + p.w - EPS && y < q.y + q.h - EPS && q.y < y + p.h - EPS
  const key = (x, y) => (yFirst ? [y, x] : [x, y])
  const less = (a, b) => a[0] < b[0] - EPS || (Math.abs(a[0] - b[0]) <= EPS && a[1] < b[1] - EPS)
  for (let pass = 0; pass < 6; pass++) {
    let moved = false
    for (const p of ps.slice().sort((a, b) => { const ka = key(a.x, a.y), kb = key(b.x, b.y); return ka[0] - kb[0] || ka[1] - kb[1] })) {
      const others = ps.filter(q => q !== p)
      const xs = new Set([0, p.x]), ys = new Set([0, p.y])
      for (const q of others) { xs.add(q.x + q.w); xs.add(q.x - p.w); xs.add(q.x); xs.add(q.x + q.w - p.w); ys.add(q.y + q.h); ys.add(q.y - p.h); ys.add(q.y); ys.add(q.y + q.h - p.h) }
      const X = [...xs].filter(x => x >= -EPS && x + p.w <= right + EPS)
      const Y = [...ys].filter(y => y >= -EPS && y + p.h <= top + EPS)
      let best = key(p.x, p.y), bx = p.x, by = p.y
      // перебор по «ведущей» оси: для каждого значения — самое малое свободное по другой
      const lead = yFirst ? Y : X, other = yFirst ? X : Y
      lead.sort((a, b) => a - b); other.sort((a, b) => a - b)
      for (const a of lead) {
        if (a > best[0] + EPS) break
        for (const b of other) {
          const x = yFirst ? b : a, y = yFirst ? a : b
          const k = key(x, y)
          if (!less(k, best)) break
          if (others.some(q => hit(x, y, p, q))) continue
          best = k; bx = x; by = y
          break
        }
      }
      if (bx !== p.x || by !== p.y) { p.x = Math.max(0, bx); p.y = Math.max(0, by); moved = true }
    }
    if (!moved) break
  }
  return ps
}

/** Листы после наведения порядка (те же детали, те же листы); right / top — правый и верхний край зоны укладки */
export function tidySheets(sheets, right, top, direction = 'auto') {
  // заполненные листы — к низу (как поиск), последний — под обрезок: «вдоль Y» обрезок справа — детали к левому краю
  return sheets.map((sh, si) => {
    if (!sh?.placed?.length || sh.stock === 'offcut' || sh.placed.some(p => p.polygon || p.group)) return sh
    let placed = sh.placed
    for (let k = 0; k < 3; k++) { const c = columnsOnce(placed, right); if (!c) break; placed = c }
    if (placed.length <= 150) placed = settle(placed, right, top, !(direction === 'along_y' && si === sheets.length - 1))
    return { ...sh, placed }
  })
}
