/**
 * Торцевой сверлильно-присадочный станок PMSK PT2-28 (β): G-код .nc — одна программа на деталь, только отверстия в торец.
 * Образцы: родной постпроцессор Базиса «PMSK 2» и Horizontal Drill (newwoodart). Спецификация — claude/pmsk-edge-drill-spec.md.
 *
 *   M601          ← сторона 1…4 (подсказка оператору: какой торец поставить к упору)
 *   T1            ← шпиндель (Ø задаёт пользователь)
 *   G00 Z8.000    ← высота отверстия от НИЖНЕЙ пласти
 *   G00 X144.000  ← позиция вдоль торца
 *   G01 Y28.000   ← сверление на глубину
 *   G00 Y-5.00    ← безопасный отскок (в Базисе 0 — сверло царапает торец при переезде)
 *   M00           ← пауза: оператор поворачивает деталь к следующему торцу
 *   …  G00 X0.000  M30
 *
 * Станок: деталь перед оператором, упор и сверлильные головы сзади. Положение по X станок находит сам (измеряет деталь),
 * X — слева направо. Деталь всегда лицевой пластью (биркой) вверх, только поворачивается в плоскости.
 * Стороны (вид сверху, бирка читается прямо): 1 — левая, 2 — верхняя, 3 — правая, 4 — нижняя — по часовой.
 * Торец повёрнут назад, к голове, — X от его левого (для оператора) конца, т. е. по часовой вдоль контура детали.
 */
export const isPmsk = post => post?.d6Fmt === 'pmsk'
export const PMSK_DEFAULT = () => ({ t1: 8, t2: 5, retract: -5, endX0: true, ccw: false })
export const pmskOf = post => ({ ...PMSK_DEFAULT(), ...(post?.pmsk || {}) })
/** торец станка (Face 1 — Y макс, 2 — Y 0, 3 — X макс, 4 — X 0, при положении детали без поворота) -> номер стороны */
export const PMSK_SIDE = { 4: 1, 1: 2, 3: 3, 2: 4 }

const n0 = v => { const x = Number(String(v ?? '').replace(',', '.')); return isFinite(x) ? x : 0 }
const fx = (v, k) => { const r = Math.round(n0(v) * 10 ** k) / 10 ** k; return (Object.is(r, -0) ? 0 : r).toFixed(k) }
const r1 = v => Math.round(n0(v) * 10) / 10

/**
 * fr — machineFrame детали без поворота (turn 0: X станка = ширина детали, Y = длина), edge — отверстия в торец
 * из drill6Xml: { face, X, Y, Z (от нижней пласти), depth, dia }.
 * -> { text, warnings, sides: [номера сторон в программе] } ; text = null — отверстий в торец нет
 */
export function pmskNc({ fr, edge }, post) {
  const k = pmskOf(post), warnings = []
  const tools = [['T1', n0(k.t1)], ['T2', n0(k.t2)]].filter(([, d]) => d > 0)
  // X вдоль торца: по часовой вдоль контура (голова сзади); ccw — страховка, если станок окажется зеркальным
  const along = h => {
    const L = fr.L, Wm = fr.Wm
    const cw = h.face === 4 ? h.Y : h.face === 1 ? h.X : h.face === 3 ? Wm - h.Y : L - h.X
    const len = h.face === 1 || h.face === 2 ? L : Wm
    return k.ccw ? len - cw : cw
  }
  const bySide = new Map()
  for (const h of edge || []) {
    const side = PMSK_SIDE[h.face]
    if (!side) continue
    const t = tools.find(([, d]) => Math.abs(d - n0(h.dia)) < 0.05)
    if (!t) { const w = `отверстие в торец Ø${r1(h.dia)} — нет такого сверла (T1 Ø${r1(k.t1)}, T2 Ø${r1(k.t2)}), в программу не попало`; if (!warnings.includes(w)) warnings.push(w); continue }
    if (!bySide.has(side)) bySide.set(side, [])
    bySide.get(side).push({ tool: t[0], x: along(h), z: n0(h.Z), depth: n0(h.depth) })
  }
  const sides = [...bySide.keys()].sort((a, b) => a - b)
  if (!sides.length) return { text: null, warnings, sides }
  const out = [], back = `G00 Y${fx(k.retract, 2)}`
  sides.forEach((s, i) => {
    if (i) out.push('M00')
    out.push(`M60${s}`)
    for (const [tn] of tools) {
      const hs = bySide.get(s).filter(h => h.tool === tn).sort((a, b) => a.x - b.x || a.z - b.z)
      if (!hs.length) continue
      out.push(tn)
      let z = null
      for (const h of hs) {
        if (z == null || Math.abs(h.z - z) > 0.0005) { out.push(`G00 Z${fx(h.z, 3)}`); z = h.z }
        out.push(`G00 X${fx(h.x, 3)}`, `G01 Y${fx(h.depth, 3)}`, back)
      }
    }
  })
  if (k.endX0 !== false) out.push('G00 X0.000')
  out.push('M30', '')
  return { text: out.join('\r\n'), warnings, sides }
}
