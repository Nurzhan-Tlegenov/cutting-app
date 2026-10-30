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

// Самый большой свободный прямоугольник листа (деловой остаток): углы — у края листа или у краёв деталей
export function maxEmptyRect(placed, right, top) {
  const xs0 = [0, ...placed.map(p => p.x + p.w)].filter(x => x < right - EPS)
  const ys0 = [...new Set([0, ...placed.map(p => p.y + p.h)])].filter(y => y < top - EPS)
  const xr = [...new Set([...placed.map(p => p.x), right])].sort((a, b) => a - b)
  let best = 0
  for (const x0 of new Set(xs0)) for (const y0 of ys0) {
    // угол не внутри детали
    if (placed.some(p => p.x <= x0 + EPS && p.x + p.w > x0 + EPS && p.y <= y0 + EPS && p.y + p.h > y0 + EPS)) continue
    let ceil = top
    let prev = x0
    for (const x1 of xr) {
      if (x1 <= x0 + EPS) continue
      // детали в полосе [prev, x1) выше y0 ограничивают высоту; деталь, накрывающая y0, — обрывает ширину
      let blocked = false
      for (const p of placed) {
        if (p.x + p.w <= prev + EPS || p.x >= x1 - EPS) continue
        if (p.y + p.h <= y0 + EPS) continue
        if (p.y <= y0 + EPS) { blocked = true; break }
        if (p.y < ceil) ceil = p.y
      }
      if (blocked) break
      const area = (x1 - x0) * (ceil - y0)
      if (area > best) best = area
      prev = x1
    }
  }
  return best
}

// Прижим: каждая деталь переставляется ниже / левее — в место, где упирается в край листа или в соседа (со сдвигом
// вбок к краю соседа: 261030_027 — Д2 висела над Д4 из-за 2 мм, на которые заходила на соседний столбец). Из таких
// мест выбирается то, где деловой остаток листа (самый большой свободный прямоугольник) не меньше — иначе деталь
// «падает» в ближайшую щель и делит остаток на два (Д5 и Д4 уходили на другую сторону верхнего ряда).
// Выше / правее, чем была, деталь не уходит.
function settle(placed, right, top, yFirst) {
  const ps = placed.map(p => ({ ...p }))
  const hit = (x, y, p, q) => x < q.x + q.w - EPS && q.x < x + p.w - EPS && y < q.y + q.h - EPS && q.y < y + p.h - EPS
  const key = (x, y) => (yFirst ? [y, x] : [x, y])
  const less = (a, b) => a[0] < b[0] - EPS || (Math.abs(a[0] - b[0]) <= EPS && a[1] < b[1] - EPS)
  const judge = ps.length <= 40                      // считать остаток — на небольших листах (на больших — просто прижим)
  let rest = judge ? maxEmptyRect(ps, right, top) : 0
  for (let pass = 0; pass < 6; pass++) {
    let moved = false
    for (const p of ps.slice().sort((a, b) => { const ka = key(a.x, a.y), kb = key(b.x, b.y); return ka[0] - kb[0] || ka[1] - kb[1] })) {
      const others = ps.filter(q => q !== p)
      const xs = new Set([0, p.x]), ys = new Set([0, p.y])
      for (const q of others) { xs.add(q.x + q.w); xs.add(q.x - p.w); xs.add(q.x); xs.add(q.x + q.w - p.w); ys.add(q.y + q.h); ys.add(q.y - p.h); ys.add(q.y); ys.add(q.y + q.h - p.h) }
      const X = [...xs].filter(x => x >= -EPS && x + p.w <= right + EPS).sort((a, b) => a - b)
      const Y = [...ys].filter(y => y >= -EPS && y + p.h <= top + EPS).sort((a, b) => a - b)
      const lead = yFirst ? Y : X, other = yFirst ? X : Y
      const cur = key(p.x, p.y)
      // свободные места ниже/левее: для каждого значения ведущей оси — самое малое по другой
      const cands = []
      for (const a of lead) {
        if (a > cur[0] + EPS) break
        for (const b of other) {
          const x = yFirst ? b : a, y = yFirst ? a : b
          if (!less(key(x, y), cur)) break
          if (others.some(q => hit(x, y, p, q))) continue
          cands.push([x, y]); break
        }
        if (cands.length >= 12) break
      }
      if (!cands.length) continue
      let pick = null
      if (!judge) pick = cands[0]
      else {
        const ox = p.x, oy = p.y
        let bestRest = rest - 1e3
        for (const [x, y] of cands) {
          p.x = x; p.y = y
          const r = maxEmptyRect(ps, right, top)
          if (r > bestRest + 1e3 || (!pick && r >= bestRest)) { bestRest = r; pick = [x, y] }
        }
        p.x = ox; p.y = oy
        if (pick) rest = Math.max(rest, bestRest)
      }
      if (pick) { p.x = Math.max(0, pick[0]); p.y = Math.max(0, pick[1]); moved = true }
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
