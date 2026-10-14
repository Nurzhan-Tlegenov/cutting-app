// Пазы в торце детали (например, «Паз от лицевой» из шаблонов торцов Астры).
// Хранятся в contour.edgeGrooves отдельно от пазов в пласти (contour.grooves), чтобы фрезер, карты раскроя
// и прочее, что работает только с пластью, их не трогали.
//
// Паз: { edgeSide, gapLow, gapHigh, fromFace, width, depth, note }
//   edgeSide — сторона детали в координатах редактора (X — ширина W, Y — длина L): 'bottom' | 'top' | 'left' | 'right'
//   gapLow / gapHigh — сколько паз не доходит до концов стороны (от меньшей и от большей координаты), 0 — во всю длину
//   fromFace — от лицевой пласти до ближнего края паза, width — ширина паза (поперёк толщины), depth — вглубь детали

const num = v => { const x = Number(String(v ?? '').replace(',', '.')); return isFinite(x) ? x : 0 }
const r1 = v => Math.round(v * 10) / 10

export const SIDE_NAMES = { bottom: 'нижний', top: 'верхний', left: 'левый', right: 'правый' }
const alongX = side => side === 'bottom' || side === 'top'

/** Положение паза на детали W×L: отрезок на торце (line) и полоса, которую паз занимает в плане (rect).
 *  out — насколько полосу вынести наружу за торец (для 3D, чтобы вставка не сливалась с торцом). */
export function edgeGrooveGeom(g, W, L, out = 0) {
  const side = g.edgeSide
  const total = alongX(side) ? W : L
  const a0 = Math.max(0, num(g.gapLow)), a1 = Math.min(total, total - Math.max(0, num(g.gapHigh)))
  const dep = Math.max(0, num(g.depth)), o = out
  let line, rect
  if (side === 'bottom') { line = [[a0, 0], [a1, 0]]; rect = [[a0, -o], [a1, -o], [a1, dep], [a0, dep]] }
  else if (side === 'top') { line = [[a0, L], [a1, L]]; rect = [[a0, L - dep], [a1, L - dep], [a1, L + o], [a0, L + o]] }
  else if (side === 'left') { line = [[0, a0], [0, a1]]; rect = [[-o, a0], [dep, a0], [dep, a1], [-o, a1]] }
  else if (side === 'right') { line = [[W, a0], [W, a1]]; rect = [[W - dep, a0], [W + o, a0], [W + o, a1], [W - dep, a1]] }
  else return null
  if (!(a1 - a0 > 0.5)) return null
  return { side, a0, a1, length: a1 - a0, line, rect }
}

/** Подпись для списков: «Паз в торце (нижний): 450 × 3.5 × 10, 3.8 от лицевой» */
export function edgeGrooveLabel(g, W, L) {
  const geo = edgeGrooveGeom(g, W, L)
  const len = geo ? r1(geo.length) : '—'
  return `Паз в торце (${SIDE_NAMES[g.edgeSide] || g.edgeSide}): ${len} × ${r1(num(g.width))} × ${r1(num(g.depth))}, ${r1(num(g.fromFace))} от лицевой`
}

/** Деталь отзеркалена лево ↔ право (по ширине X) */
export function mirrorEdgeGroove(g) {
  if (g.edgeSide === 'left') return { ...g, edgeSide: 'right' }
  if (g.edgeSide === 'right') return { ...g, edgeSide: 'left' }
  return { ...g, gapLow: g.gapHigh ?? 0, gapHigh: g.gapLow ?? 0 }
}

/** Деталь перевёрнута другой пластью вверх (уже отзеркаленная): отсчёт от лицевой — с другой стороны */
export function flipEdgeGroove(g, T) {
  return { ...g, fromFace: r1(Math.max(0, num(T) - num(g.fromFace) - num(g.width))) }
}

/** Заготовка меньше готовой детали на k = { l, r, b, t } (подрезка под кромку) */
export function trimEdgeGroove(g, k) {
  const lo = alongX(g.edgeSide) ? num(k.l) : num(k.b), hi = alongX(g.edgeSide) ? num(k.r) : num(k.t)
  return { ...g, gapLow: r1(Math.max(0, num(g.gapLow) - lo)), gapHigh: r1(Math.max(0, num(g.gapHigh) - hi)) }
}
