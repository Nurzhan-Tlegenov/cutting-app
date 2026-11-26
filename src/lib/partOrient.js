// Положение отдельной детали на фрезере «к упору» (программы на отдельные детали, PartPrograms.jsx): правила с
// приоритетами — как у шестистороннего присадочного (drill6Xml.js, D6B_RULES), только вместо лап и упора — Г-образный
// упор у нуля станка: сторона вдоль X (верх или низ — по углу укладки постпроцессора) и боковая (лево или право).
// Перебираются 4 поворота (и переворот изнанкой вверх, если разрешён); лучший — по правилам сверху вниз.
import { partFeatures } from './gcode'
import { cornerOf } from './sheetCorner'

export const PO_RULES = {
  faceUp: 'Обработка сверху — больше отверстий, пазов и выемок с той стороны, что сверху (при перевороте)',
  shaped: 'Фигурный контур (радиусы, улыбки, вырезы по краю) — к упорам прямыми сторонами',
  cutouts: 'Вырезы и выемки',
  holes: 'Отверстия в пласть',
  grooves: 'Пазы — вдоль',
  long: 'Длинная сторона — вдоль',
}
export const PO_DEFAULT = () => ({ order: ['faceUp', 'shaped', 'cutouts', 'holes', 'grooves', 'long'], on: { faceUp: true, shaped: true, cutouts: true, holes: true, grooves: false, long: true },
  dir: { cutouts: 'away', holes: 'away', grooves: 'x', long: 'y' }, allowFlip: false })
export const poOf = v => { const d = PO_DEFAULT(); return { ...d, ...(v || {}), on: { ...d.on, ...(v?.on || {}) }, dir: { ...d.dir, ...(v?.dir || {}) }, order: [...new Set([...(v?.order || []), ...d.order])].filter(k => PO_RULES[k]) } }

const n0 = v => Number(v) || 0
const avg = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null)

/** Оценки положения по правилам: { правило: 0…1 | null (правилу всё равно) } */
export function poScores(p, det, T, corner, po) {
  let f
  try { f = partFeatures(p, det, T) } catch { return {} }
  const pw = n0(p.origX) || 1, ph = n0(p.origY) || 1, c = cornerOf(corner)
  const bottom = c[0] === 'b', left = c[1] === 'l'
  // насколько точка далеко от упоров: 0 — в углу упоров, 1 — в дальнем углу
  const far = (x, y) => ((bottom ? y : ph - y) / ph + (left ? x : pw - x) / pw) / 2
  const dirScore = (v, k) => (v == null ? null : po.dir[k] === 'to' ? 1 - v : v)
  const out = {}
  out.faceUp = f.holes.length + f.grooves.length + f.pockets.length
  // прямые стороны у упоров: доля стороны габарита, лежащая на контуре детали
  const onSide = (y0, alongX) => {
    let len = 0
    const L = f.outline
    for (let i = 0; i < L.length; i++) {
      const a = L[i], b = L[(i + 1) % L.length]
      if (alongX ? Math.abs(a[1] - y0) < 0.5 && Math.abs(b[1] - y0) < 0.5 : Math.abs(a[0] - y0) < 0.5 && Math.abs(b[0] - y0) < 0.5) len += Math.hypot(b[0] - a[0], b[1] - a[1])
    }
    return Math.min(1, len / (alongX ? pw : ph))
  }
  out.shaped = f.outline.length > 4 ? (onSide(bottom ? 0 : ph, true) + onSide(left ? 0 : pw, false)) / 2 : null
  const cut = [...f.cutouts.map(cu => (cu.circle ? [cu.circle.cx, cu.circle.cy] : [avg(cu.pts.map(q => q[0])), avg(cu.pts.map(q => q[1]))])), ...f.pockets.map(q => [(q.x0 + q.x1) / 2, (q.y0 + q.y1) / 2])]
  out.cutouts = dirScore(avg(cut.map(([x, y]) => far(x, y))), 'cutouts')
  out.holes = dirScore(avg(f.holes.map(h => far(h.x, h.y))), 'holes')
  const gr = f.grooves.filter(g => g.x0 != null)
  out.grooves = gr.length ? gr.filter(g => ((g.x1 - g.x0) >= (g.y1 - g.y0)) === (po.dir.grooves !== 'y')).length / gr.length : null
  out.long = Math.abs(pw - ph) < 0.5 ? null : ((pw > ph) === (po.dir.long === 'x') ? 1 : 0)
  return out
}

/** Лучшее положение детали по правилам -> { rot, flip }. place(o) -> { p, det } (как ownPlace) */
export function poBest(place, T, corner, po0) {
  const po = poOf(po0)
  const cands = []
  for (const flip of po.allowFlip ? [false, true] : [false]) for (let rot = 0; rot < 4; rot++) {
    const { p, det } = place({ rot, flip })
    cands.push({ rot, flip, s: poScores(p, det, T, corner, po) })
  }
  // сравнение сверху вниз: первое правило, где положения различаются заметно, решает
  const keys = po.order.filter(k => po.on[k])
  const norm = k => { const m = Math.max(...cands.map(c => c.s[k] ?? 0)); return m > 1 ? m : 1 }
  const N = Object.fromEntries(keys.map(k => [k, norm(k)]))
  cands.sort((a, b) => {
    for (const k of keys) {
      const x = a.s[k], y = b.s[k]
      if (x == null || y == null) continue
      const d = y / N[k] - x / N[k]
      if (Math.abs(d) > 0.02) return d
    }
    return (a.flip - b.flip) || (a.rot - b.rot)
  })
  return { rot: cands[0].rot, flip: cands[0].flip }
}
