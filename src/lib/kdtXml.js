/**
 * Шестисторонний присадочный станок KDT — XML KDTPanelFormat (как у Базис-ЧПУ, постпроцессор «KDT CNC Drill»).
 * Один файл — одна деталь, UTF-8 без BOM, строки CRLF, без строки <?xml ?>. Образец — B_268.M1.08.00.01.XML.
 *
 * Координаты — те же, что у SWJ (machineFrame в drill6Xml.js): ноль — левый нижний угол, X — по длине (PanelLength),
 * Y — по ширине (PanelWidth), вид сверху. Низ — в той же системе (не зеркалится).
 *
 *   <PANEL> PanelLength, PanelWidth, PanelThickness, PanelName, <PanelOutline> — вершины контура против часовой:
 *     <Vertex> X1 Y1 [Bulge — дуга до следующей вершины, tan(угол/4): > 0 против часовой, < 0 по часовой]
 *              [Banding 1.00, Description — толщина кромки, BandingColor, DescriptionColor — кромка на стороне,
 *               которая начинается в этой вершине]
 *   <CAD> обработки:
 *     TypeNo 1 «Vertical Hole» — отверстие в пласть сверху: X1 Y1 Depth Diameter HoleNo IntervalX IntervalY
 *     TypeNo 8 «Vertical Hole» — то же снизу (координаты — вид сверху)
 *     TypeNo 2 «Horizontal Hole» — в торец: Quadrant (какой торец), X1 Y1 — точка на торце, Z1 — от нижней пласти
 *     TypeNo 3 «Line» — паз: ToolName, BeginX/Y → EndX/Y (средняя линия), Correction 0, Width, Depth,
 *              Direction — куда идёт паз (как стрелки цифровой клавиатуры: 6 → +X, 4 → −X, 8 → +Y, 2 → −Y)
 *     Паз в торце — TypeNo 3 с Quadrant и Z1 (середина паза от нижней пласти); выемка в торце — TypeNo 7 с Quadrant и Z1
 *              у каждой точки (в образце их не было — так же, как отверстие в торец)
 *     TypeNo 7 «Path» — фрезеровка по траектории: ToolName, Width (Ø фрезы), Depth, Correction (1 — фреза слева от хода,
 *              2 — справа, 0 — по линии), <Vertexes> <Point> начало, <Line> X1 Y1, <Arc> X1 Y1 Radius Direction
 *              (1 — против часовой)
 * Пласть паза и траектории станок узнаёт по инструменту: у верхнего и нижнего шпинделя свои имена (T2 / SP4 …).
 * Что в образце не встречалось (номера торцов кроме Y = 0, дуга по часовой) — по настройкам
 * постпроцессора (post.kdt), их уточняет производство по своему станку.
 */

export const KDT_DEFAULT = () => ({
  top: [{ d: 6, name: 'T2' }, { d: 4, name: 'SP1T1' }],       // фрезы верхнего шпинделя
  bottom: [{ d: 6, name: 'SP4' }, { d: 4, name: 'SP2' }],     // фрезы нижнего шпинделя
  quad: { 4: 1, 1: 2, 3: 3, 2: 4 },   // торец станка (Face 1 — Y макс, 2 — Y 0, 3 — X макс, 4 — X 0) -> Quadrant; Y 0 = 4 — по образцу
  arcCw: 2,                           // Direction дуги по часовой (против часовой — 1, по образцу)
  bandColor: 'rgb(128,0,255)',
})
export const kdtOf = post => {
  const d = KDT_DEFAULT(), k = post?.kdt || {}
  const tools = l => (Array.isArray(l) ? l.filter(t => t && String(t.name || '').trim() && Number(t.d) > 0).map(t => ({ d: Number(t.d), name: String(t.name).trim() })) : null)
  return { ...d, ...k, top: tools(k.top) || d.top, bottom: tools(k.bottom) || d.bottom, quad: { ...d.quad, ...(k.quad || {}) } }
}
export const isKdt = post => post?.d6Fmt === 'kdt'

const EPS = 0.05
const n0 = v => { const x = Number(String(v ?? '').replace(',', '.')); return isFinite(x) ? x : 0 }
const f2 = v => { const r = Math.round(n0(v) * 100) / 100; return (Object.is(r, -0) ? 0 : r).toFixed(2) }
const f3 = v => { const r = Math.round(n0(v) * 1000) / 1000; return (Object.is(r, -0) ? 0 : r).toFixed(3) }
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const r1 = v => Math.round(n0(v) * 10) / 10
const thickText = v => String(r1(v))

/** Инструмент шпинделя: want — Ø (ближайший), maxD — не шире паза (самый широкий из подходящих) */
export function kdtTool(k, bottom, { want = 0, maxD = 0 } = {}) {
  const list = [...(bottom ? k.bottom : k.top)].sort((a, b) => b.d - a.d)
  if (!list.length) return null
  if (maxD > 0) return list.find(t => t.d <= maxD + 0.01) || list[list.length - 1]
  if (want > 0) return list.reduce((b, t) => (Math.abs(t.d - want) < Math.abs(b.d - want) ? t : b), list[0])
  return list[0]
}

/**
 * Деталь -> текст файла KDT.
 * g — собранное panelCore: { fr, T, name, outlineEls (элементы контура станка или null — прямоугольник), faceEdge,
 *   top, bottom, edge, grooves, edgeGrooves, edgeMills, mills, pocketPath(m, D) }
 * -> { text, warnings }
 */
export function kdtPanel(g, post) {
  const k = kdtOf(post)
  const { fr, T } = g
  const warnings = []
  const L = []
  const tab = n => '\t'.repeat(n)
  const tag = (n, t, v) => L.push(`${tab(n)}<${t}>${v}</${t}>`)

  L.push('<KDTPanelFormat>', `${tab(1)}<PANEL>`)
  tag(2, 'PanelLength', f2(fr.L)); tag(2, 'PanelWidth', f2(fr.Wm)); tag(2, 'PanelThickness', f2(T)); tag(2, 'PanelName', esc(g.name))
  // контур: против часовой, начиная с вершины ближе всего к нулю
  let els = g.outlineEls?.length > 2 ? g.outlineEls : [[0, 0], [fr.L, 0], [fr.L, fr.Wm], [0, fr.Wm]].map((a, i, A) => ({ a, b: A[(i + 1) % 4], angle: 0, r: 0 }))
  const area = els.reduce((s, e) => s + (e.a[0] * e.b[1] - e.b[0] * e.a[1]) / 2, 0)
  if (area < 0) els = [...els].reverse().map(e => ({ ...e, a: e.b, b: e.a, angle: -e.angle }))
  let s0 = 0
  els.forEach((e, i) => { if (Math.hypot(...e.a) < Math.hypot(...els[s0].a) - 1e-6) s0 = i })
  els = [...els.slice(s0), ...els.slice(0, s0)]
  const onSide = e => {                                   // сторона лежит на габарите -> торец станка 1..4
    const same = (u, v, c) => Math.abs(u - c) < EPS && Math.abs(v - c) < EPS
    if (e.angle) return 0
    if (same(e.a[1], e.b[1], 0)) return 2
    if (same(e.a[1], e.b[1], fr.Wm)) return 1
    if (same(e.a[0], e.b[0], 0)) return 4
    if (same(e.a[0], e.b[0], fr.L)) return 3
    return 0
  }
  L.push(`${tab(2)}<PanelOutline>`)
  for (const e of els) {
    L.push(`${tab(3)}<Vertex>`)
    tag(4, 'X1', f2(e.a[0])); tag(4, 'Y1', f2(e.a[1]))
    // угол дуги (Syntec): > 0 — по часовой, < 0 — против; Bulge — наоборот, > 0 против часовой
    if (e.angle) tag(4, 'Bulge', f3(-Math.sign(e.angle) * Math.tan(Math.abs(e.angle) * Math.PI / 720)))
    const side = onSide(e), bySide = side ? n0(g.faceEdge?.[side]) : 0
    const own = g.edgeAt ? g.edgeAt(e.a, e.b, !e.angle) : null          // по участку контура детали (дуга, скос — тоже)
    const th = own != null ? n0(own) : bySide
    if (th > 0) { tag(4, 'Banding', '1.00'); tag(4, 'Description', thickText(th)); tag(4, 'BandingColor', k.bandColor); tag(4, 'DescriptionColor', k.bandColor) }
    L.push(`${tab(3)}</Vertex>`)
  }
  L.push(`${tab(2)}</PanelOutline>`, `${tab(1)}</PANEL>`)

  // торец: фреза из «Обработки» (имя как на станке); не назначена — верхняя самая широкая (станок поправит на стойке)
  const edgeTool = t => (t && String(t.name || '').trim() ? { name: String(t.name).trim(), d: n0(t.d) || 0 } : kdtTool(k, false))
  const cad = (fields, inner = null) => {
    L.push(`${tab(1)}<CAD>`)
    for (const [t, v] of fields) tag(2, t, v)
    if (inner) inner()
    L.push(`${tab(1)}</CAD>`)
  }
  const hole = (h, typeNo) => cad([['TypeNo', typeNo], ['TypeName', 'Vertical Hole'], ['X1', f2(h.X)], ['Y1', f2(h.Y)], ['Depth', f2(h.depth)], ['Diameter', f2(h.dia)], ['HoleNo', 1], ['IntervalX', '0.00'], ['IntervalY', '0.00']])
  // траектория: start + segs [{ to, angle }] — angle по Syntec (> 0 по часовой); радиус — из хорды и угла
  const path = (m, bottom) => {
    const z3 = (m.start?.length || 0) > 2            // на торце: точки X, Y на торце + Z1 от нижней пласти
    const t = m.kdtTool || (z3 ? edgeTool(m.tool) : kdtTool(k, bottom, { want: n0(m.tool?.d) }))
    if (!t) { warnings.push('нет фрез для траектории (настройки KDT)'); return true }
    const corr = m.offset === '左' ? 1 : m.offset === '右' ? 2 : 0
    const depth = z3 ? n0(m.depth) : Math.min(n0(m.depth), T)       // на торце глубина — вглубь детали, не по толщине
    cad([['TypeNo', 7], ['TypeName', 'Path'], ...(z3 ? [['Quadrant', n0(k.quad[m.face]) || m.face]] : []), ['ToolName', esc(t.name)], ['Width', f2(t.d)], ['Depth', f2(depth)], ['Correction', corr]], () => {
      L.push(`${tab(2)}<Vertexes>`)
      L.push(`${tab(3)}<Point>`); tag(4, 'X1', f2(m.start[0])); tag(4, 'Y1', f2(m.start[1])); if (z3) tag(4, 'Z1', f2(m.start[2])); L.push(`${tab(3)}</Point>`)
      let cur = m.start
      for (const s of m.segs) {
        if (s.angle) {
          const ch = Math.hypot(s.to[0] - cur[0], s.to[1] - cur[1]), th = Math.abs(s.angle) * Math.PI / 180
          const R = ch / (2 * Math.sin(th / 2))
          L.push(`${tab(3)}<Arc>`); tag(4, 'X1', f2(s.to[0])); tag(4, 'Y1', f2(s.to[1])); tag(4, 'Radius', f2(R)); tag(4, 'Direction', s.angle < 0 ? 1 : n0(k.arcCw) || 2); L.push(`${tab(3)}</Arc>`)
        } else { L.push(`${tab(3)}<Line>`); tag(4, 'X1', f2(s.to[0])); tag(4, 'Y1', f2(s.to[1])); if (z3) tag(4, 'Z1', f2(s.to[2])); L.push(`${tab(3)}</Line>`) }
        cur = s.to
      }
      L.push(`${tab(2)}</Vertexes>`)
    })
    return true
  }
  // выемка: своя выборка от центра (фреза шпинделя); не вышло — обход контура изнутри
  const millOut = (m, bottom) => {
    if ((m.cat === 'pocket' || m.cat === 'groovePath') && m.pocket) {
      const t = kdtTool(k, bottom, { want: n0(m.tool?.d) })
      const sp = t && g.pocketPath ? g.pocketPath(m, t.d) : null
      if (sp) return path({ ...m, ...sp, offset: '中', kdtTool: t }, bottom)
      warnings.push('выемка не выпуклая или меньше фрезы — в программе только обход по контуру')
    }
    path(m, bottom)
  }

  const top = g.top.slice().sort((a, b) => b.Y - a.Y || a.X - b.X)
  const bottom = g.bottom.slice().sort((a, b) => b.Y - a.Y || a.X - b.X)
  top.forEach(h => hole(h, 1))
  g.mills.filter(m => m.face === fr.top).forEach(m => millOut(m, false))
  g.edge.slice().sort((a, b) => a.face - b.face || a.X - b.X || a.Y - b.Y).forEach(h => cad([
    ['TypeNo', 2], ['TypeName', 'Horizontal Hole'], ['Quadrant', n0(k.quad[h.face]) || h.face], ['X1', f2(h.X)], ['Y1', f2(h.Y)], ['Z1', f2(h.Z)],
    ['Depth', f2(h.depth)], ['Diameter', f2(h.dia)], ['HoleNo', 1], ['IntervalX', '0.00'], ['IntervalY', '0.00']]))
  // паз в торце — как паз (Line) на торце: Quadrant, отрезок на торце, Z1 — середина паза от нижней пласти
  for (const eg of g.edgeGrooves) {
    const t = edgeTool(eg.tool)
    let [ax, ay, bx, by] = eg.line
    if (ax > bx + EPS || (Math.abs(ax - bx) <= EPS && ay > by)) [ax, ay, bx, by] = [bx, by, ax, ay]
    cad([['TypeNo', 3], ['TypeName', 'Line'], ['Quadrant', n0(k.quad[eg.face]) || eg.face], ...(t ? [['ToolName', esc(t.name)]] : []),
      ['BeginX', f2(ax)], ['BeginY', f2(ay)], ['EndX', f2(bx)], ['EndY', f2(by)], ['Z1', f2(eg.Z)],
      ['Correction', 0], ['Width', f2(eg.width)], ['Depth', f2(eg.depth)], ['Direction', Math.abs(bx - ax) >= Math.abs(by - ay) ? 6 : 8]])
  }
  // выемка в торце — траектория на торце (Quadrant, точки с Z1)
  for (const m of g.edgeMills) {
    if (m.pocket) warnings.push('выемка в торце: фреза не назначена в «Обработке» — в программе только обход контура выемки')
    path(m, false)
  }
  for (const gr of g.grooves) {
    const bot = gr.face !== fr.top
    const t = kdtTool(k, bot, { maxD: gr.width })
    if (!t) { warnings.push('нет фрез для паза (настройки KDT)'); continue }
    let [x0, y0, x1, y1] = gr.rect
    const alongX = x1 - x0 >= y1 - y0
    // средняя линия; конец внутри детали — короче на радиус фрезы (фреза центром не доходит до конца паза)
    const r = t.d / 2, open = gr.ends || [true, true]
    let a = alongX ? [x0, (y0 + y1) / 2] : [(x0 + x1) / 2, y0], b = alongX ? [x1, (y0 + y1) / 2] : [(x0 + x1) / 2, y1]
    if (!open[0]) a = alongX ? [a[0] + r, a[1]] : [a[0], a[1] + r]
    if (!open[1]) b = alongX ? [b[0] - r, b[1]] : [b[0], b[1] - r]
    if (t.d > gr.width + 0.05) warnings.push(`паз ${r1(gr.width)} мм уже самой узкой фрезы Ø${r1(t.d)}`)
    cad([['TypeNo', 3], ['TypeName', 'Line'], ['ToolName', esc(t.name)], ['BeginX', f2(a[0])], ['BeginY', f2(a[1])], ['EndX', f2(b[0])], ['EndY', f2(b[1])],
      ['Correction', 0], ['Width', f2(gr.width)], ['Depth', f2(Math.min(gr.depth, T))], ['Direction', alongX ? 6 : 8]])
  }
  bottom.forEach(h => hole(h, 8))
  g.mills.filter(m => m.face !== fr.top).forEach(m => millOut(m, true))
  L.push('</KDTPanelFormat>', '')
  return { text: L.join('\r\n'), warnings }
}
