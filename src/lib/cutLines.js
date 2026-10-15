// Линии реза для форматно-раскроечного станка — общие для карты раскроя на экране и для статистики (длина и число резов).
// ─── Линии реза (форматно-раскроечный станок) ─────────────────────────────
// Строятся по ТЕКУЩЕЙ карте раскроя (в экранных координатах, Y сверху вниз),
// поэтому после любого редактирования (перенос, поворот) пересчитываются
// заново. Сквозной рез — линия через весь участок листа, не пересекающая
// ни одной детали. Деталь занимает [x, x+w]×[y, y+h], где w/h включают
// ширину реза на правой и нижней стороне; линия рисуется по центру пропила.
// Участок делится рекурсивно.
export function decomposeCuts(rects, usableX, usableY, kerf, pref) {
  const EPS = 0.5
  const lines = [], unsplit = []
  const queue = [{ x0: 0, y0: 0, x1: usableX, y1: usableY, parts: rects }]
  const findCut = (reg, axis) => {
    const v = axis === 'v'
    const a0 = v ? reg.x0 : reg.y0, a1 = v ? reg.x1 : reg.y1
    const cands = []
    reg.parts.forEach(o => {
      const s0 = v ? o.x : o.y, len = v ? o.w : o.h
      cands.push({ c: s0 + len, line: s0 + len - kerf / 2 })            // за правым/нижним краем детали
      if (s0 - kerf > a0 + EPS) cands.push({ c: s0 - kerf, line: s0 - kerf / 2 }) // перед левым/верхним краем (пустая полоса до детали)
    })
    cands.sort((p, q) => p.c - q.c)
    for (const cd of cands) {
      if (cd.c <= a0 + EPS || cd.c >= a1 - kerf - EPS) continue
      const crosses = reg.parts.some(o => {
        const s0 = v ? o.x : o.y, len = v ? o.w : o.h
        return s0 < cd.c - EPS && s0 + len > cd.c + EPS
      })
      if (!crosses) return cd
    }
    return null
  }
  while (queue.length) {
    const reg = queue.shift()
    if (!reg.parts.length) continue
    const order = pref === 'v' ? ['v', 'h'] : ['h', 'v']
    let done = false
    for (const axis of order) {
      const cd = findCut(reg, axis)
      if (!cd) continue
      const v = axis === 'v'
      lines.push(v
        ? { v: true, pos: cd.line, from: reg.y0, to: reg.y1 }
        : { v: false, pos: cd.line, from: reg.x0, to: reg.x1 })
      const mid = o => v ? o.x + o.w / 2 : o.y + o.h / 2
      const A = reg.parts.filter(o => mid(o) < cd.c), B = reg.parts.filter(o => mid(o) >= cd.c)
      queue.push(v ? { ...reg, x1: cd.c, parts: A } : { ...reg, y1: cd.c, parts: A })
      queue.push(v ? { ...reg, x0: cd.c, parts: B } : { ...reg, y0: cd.c, parts: B })
      done = true
      break
    }
    if (!done && reg.parts.length > 1) unsplit.push(reg)
  }
  return { lines, unsplit }
}
export function computeCutLines(items, usableX, usableY, kerf, offcuts = []) {
  const rects = items.map(p => ({ x: p.x, y: p.y, w: p.w, h: p.h }))
  // Выбранные обрезки — деловые заготовки, такие же "детали" для резов; у
  // обрезка зазор на рез идёт с каждой стороны, поэтому добавляем kerf
  // справа и снизу (как у обычной детали)
  // Обрезок хранится вместе с продлением до физического края листа — для
  // резов берём его часть в пределах рабочей зоны
  offcuts.forEach(o => {
    const x0 = Math.max(0, o.x), y0 = Math.max(0, o.y)
    const x1 = Math.min(usableX, o.x + o.w), y1 = Math.min(usableY, o.y + o.h)
    if (x1 - x0 > 1 && y1 - y0 > 1) rects.push({ x: x0, y: y0, w: x1 - x0 + kerf, h: y1 - y0 + kerf })
  })
  const a = decomposeCuts(rects, usableX, usableY, kerf, 'v')
  const b = decomposeCuts(rects, usableX, usableY, kerf, 'h')
  const len = r => r.lines.reduce((t, l) => t + (l.to - l.from), 0)
  if (a.unsplit.length !== b.unsplit.length) return a.unsplit.length < b.unsplit.length ? a : b
  return len(a) <= len(b) ? a : b
}
