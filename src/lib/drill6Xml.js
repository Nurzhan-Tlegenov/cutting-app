/**
 * Программы для шестистороннего сверлильно-присадочного станка с ЧПУ — XML-формат SWJ (Flag="SWJ008"),
 * как в файлах, которые читает станок производства (образец: LDSP_Dub_Votan, 118 деталей).
 *
 * Один файл — одна деталь: <Root><Project Flag="SWJ008"><Panels><Panel …><Machines>…</Machines><EdgeGroup>…</EdgeGroup>
 *
 * Система координат станка (проверено по образцу и картинкам к нему):
 *   Length — размер вдоль X, Width — вдоль Y, ноль — левый нижний угол детали, Y вверх, вид сверху (на пласть 5).
 *   Пласть: Face 5 — верхняя, Face 6 — нижняя (координаты Face 6 — в той же системе, вид сверху).
 *   Торцы: Face 1 — Y = Width, Face 2 — Y = 0, Face 3 — X = Length, Face 4 — X = 0.
 *   Размеры — готовой детали с кромкой (500.8 = 500 + кромка 0.8).
 *
 * Обработки (Machining):
 *   Type 2 — отверстие в пласть: X, Y, Depth, Diameter
 *   Type 1 — отверстие в торец: X, Y (точка на торце), Z (высота от нижней пласти), Depth (вглубь детали), Diameter
 *   Type 4 — паз: X, Y → EndX, EndY (средняя линия), Width, Depth, Drill (инструмент станка, например T2)
 *            Паз в торце (Face 1–4): X, Y → EndX, EndY — отрезок на торце, Z / EndZ — высота середины паза от нижней
 *            пласти (как у отверстия в торец), Width — ширина поперёк толщины, Depth — вглубь детали.
 *   Drill — инструмент станка. Назначается в настройках станка (вкладки «Инструменты» и «Обработка», post.d6Tools /
 *            post.d6Ops, см. d6OpsOf): для каждого вида обработки — «авто» (Drill не пишется, инструмент выбирает система
 *            управления станка), один инструмент или (пазы) по ширине паза; у каждого слоя (паз ширина × глубина, выемка
 *            по глубине) можно назначить своё. Направление обхода вырезов и фигурного края — тоже в настройках.
 *   Type 3 — фрезеровка: X, Y — начало, <Lines><Line EndX EndY Angle/></Lines>, Depth, Pocket (1 — выборка внутри
 *            контура, тогда Closed 1), Closed, ToolOffset (右 — фреза справа от хода, 左 — слева, 中 — по линии; всегда вид
 *            сверху), Drill. Angle — угол дуги в градусах: > 0 по часовой, < 0 против, 0 — прямая.
 *   <Outline> — фигурный контур детали: <Point X Y Radius/> (Radius до следующей точки: > 0 против часовой, < 0 по часовой).
 * Всё по спецификации Syntec «新代Xml檔說明» v1.51 (WoodPanel CAD Xml Format) и по файлам станка производства.
 *
 * На станок уходит ВСЁ, что есть в детали, — даже то, что уже сделал фрезерный ЧПУ на раскрое (отверстия и пазы лицевой
 * пласти, фигурный контур, вырезы, выемки): лишнее оператор отключает фильтром на стойке (например, обработку Face 5).
 */
import { getDrillPoints, getGrooveRects } from './drillGeometry'
import { edgeGrooveGeom } from './edgeGrooves'
import { rawDetail, parseEdgeTypes, edgeKey } from './edgeCut'
import { detailMeta } from './partLabel'
import { toLatin, folderName } from './orderUtils'
import { detailHoles } from './partHoles'
import { parsePolygonFromDetail } from './trueShapeNesting'
import { loopElements } from './arcFit'

const EPS = 0.05
const n0 = v => { const x = Number(String(v ?? '').replace(',', '.')); return isFinite(x) ? x : 0 }
const f3 = v => (Math.round(n0(v) * 1000) / 1000).toFixed(3)
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const latin = s => toLatin(String(s ?? '')).replace(/[^\w.^-]+/g, '_').replace(/_{2,}/g, '_').replace(/^[_.-]+|[_.-]+$/g, '')

function contourOf(d) {
  const c = d?.contour
  if (!c) return null
  if (typeof c !== 'string') return c
  try { return JSON.parse(c) } catch { return null }
}

/**
 * Перевод координат детали приложения (x — ширина W, y — длина H, вид на лицевую пласть) в координаты станка.
 * turn — поворот детали в плоскости против часовой: 0, 1 (90°), 2 (180°), 3 (270°). Только поворот, без зеркала:
 * лицевая пласть всегда сверху (Face 5) — как на фрезерном ЧПУ, где по ней клеится этикетка. Деталь со стола фрезера
 * кладут на шестисторонний той же стороной вверх, сканируют — и программа сразу совпадает, переворачивать не нужно.
 * face 'back' — только для проверок.
 */
export function machineFrame(W, H, turn = 3, face = 'front') {
  const k = ((turn % 4) + 4) % 4
  const L = k % 2 ? H : W, Wm = k % 2 ? W : H       // Length (X станка), Width (Y станка)
  const flip = face === 'back'
  const at = (x, y) => {
    let X, Y
    if (k === 0) { X = x; Y = y }
    else if (k === 1) { X = H - y; Y = x }
    else if (k === 2) { X = W - x; Y = H - y }
    else { X = y; Y = W - x }
    if (flip) Y = Wm - Y
    return [X, Y]
  }
  const faceAt = (X, Y) => (Math.abs(Y - Wm) < EPS ? 1 : Math.abs(Y) < EPS ? 2 : Math.abs(X - L) < EPS ? 3 : Math.abs(X) < EPS ? 4 : 0)
  return { L, Wm, at, faceAt, top: flip ? 6 : 5, bottom: flip ? 5 : 6, turn: k }
}

const SIDE_MID = (W, H) => ({ left: [0, H / 2], right: [W, H / 2], bottom: [W / 2, 0], top: [W / 2, H] })
/** Кромка по торцам станка { 1..4: толщина } при данном положении детали */
function edgesByFace(fr, W, H, et) {
  const out = { 1: 0, 2: 0, 3: 0, 4: 0 }
  const mid = SIDE_MID(W, H)
  for (const s of Object.keys(mid)) { const f = fr.faceAt(...fr.at(...mid[s])); if (f) out[f] = et[s] }
  return out
}
/**
 * Как положить деталь на шестисторонний станок:
 *   1) главное — длинной стороной вдоль станка (по X);
 *   2) затем — кромкой вверх (к торцу Face 1, верхний край детали), если кромка с одной из длинных сторон.
 * Если обе длинные стороны с кромкой или обе без — положение как в файлах станка (длина детали по X, поворот 270°).
 */
export function chooseTurn(W, H, et) {
  const order = W > H + EPS ? [0, 2, 1, 3] : H > W + EPS ? [3, 1, 0, 2] : [3, 1, 0, 2]
  const long = order.filter(k => { const f = machineFrame(W, H, k); return f.L >= f.Wm - EPS })
  const up = long.find(k => { const e = edgesByFace(machineFrame(W, H, k), W, H, et); return e[1] > 0 && !(e[2] > 0) })
  return up ?? long[0]
}

/** Толщина кромки на сторонах детали: { left, right, top, bottom } в мм (0 — без кромки) */
function edgeThick(d, types) {
  const meta = detailMeta(d)?.edges || {}
  const out = {}
  for (const s of ['left', 'right', 'top', 'bottom']) {
    const k = edgeKey(d['edge_' + s])
    out[s] = k ? (n0(types?.[k]?.t) || n0(meta[s]?.thick) || 0) : 0
  }
  return out
}

const DEG = 180 / Math.PI
// площадь замкнутого контура со знаком (> 0 — против часовой) с учётом дуговых сегментов
const loopArea = els => els.reduce((A, e, i) => {
  const q = els[(i + 1) % els.length].a
  let v = (e.a[0] * q[1] - q[0] * e.a[1]) / 2
  if (e.r && e.angle) { const t = Math.abs(e.angle) / DEG; v += (e.angle < 0 ? 1 : -1) * e.r * e.r * (t - Math.sin(t)) / 2 }
  return A + v
}, 0)
/**
 * Замкнутый контур (в координатах детали) -> элементы в координатах станка: [{ a, b, angle }]
 * angle — угол дуги в градусах по спецификации Syntec: > 0 — по часовой, < 0 — против, 0 — прямая.
 * Поворот детали не меняет направление обхода (зеркала нет), поэтому ccw переносится как есть.
 */
function loopToMachine(poly, fr) {
  let els
  try { els = loopElements(poly, 0.02) } catch { els = [] }
  // целая окружность распознаётся одной-двумя дугами — выводим её четырьмя четвертями
  if (els.length < 3 && els.some(e => e.r)) {
    const e = els.find(q => q.r), { cx, cy, r, ccw } = e
    els = [{ a: [cx + r, cy], b: [cx + r, cy], cx, cy, r, ccw, sweep: 2 * Math.PI }]
  }
  if (els.length < 2 && !els.some(e => e.r)) els = poly.map((p, i) => ({ a: p, b: poly[(i + 1) % poly.length] }))
  // дуга больше 90° делится на равные части: полудугу 180° станок и его просмотрщик строят неоднозначно
  // (центр по двум точкам и углу 180° лежит на хорде) — круг выходил овалом
  els = els.flatMap(e => {
    if (!e.r || !(e.sweep > Math.PI / 2 + 1e-6)) return [e]
    const n = Math.ceil(e.sweep / (Math.PI / 2) - 1e-6), st = e.sweep / n, dir = e.ccw ? 1 : -1
    const a0 = Math.atan2(e.a[1] - e.cy, e.a[0] - e.cx)
    const pt = k => (k === 0 ? e.a : k === n ? e.b : [e.cx + e.r * Math.cos(a0 + dir * st * k), e.cy + e.r * Math.sin(a0 + dir * st * k)])
    return Array.from({ length: n }, (_, k) => ({ ...e, a: pt(k), b: pt(k + 1), sweep: st }))
  })
  // угол дуги, подогнанной по точкам, чуть мимо целого (89.958° вместо 90°) — округляем: радиус выходит ровным
  const ang = v => (Math.abs(v - Math.round(v)) < 0.05 ? Math.round(v) : v)
  return els.map(e => ({ a: fr.at(e.a[0], e.a[1]), b: fr.at(e.b[0], e.b[1]), angle: e.r ? ang((e.ccw ? -1 : 1) * e.sweep * DEG) : 0, r: e.r || 0 }))
}
/**
 * Фрезеровки детали (Type 3) в координатах станка: [{ face, start, segs: [{ to, angle }], closed, depth, pocket, offset }]
 *   вырезы на краю (участки контура не по габариту: U-образный вырез, угловая вырубка) — замкнуто по краю и габариту,
 *   фреза внутри, за габарит детали не выходит; деталь целиком фигурная (круг) — замкнуто, фреза снаружи;
 *   вырезы внутри детали — замкнуто, фреза внутри, насквозь; выемки — выборка (Pocket 1, Closed 1) на свою глубину и пласть;
 *   фрезеровка фасада (декор из импорта) — выборки и траектории по линии.
 * ToolOffset (Syntec): сторона от направления хода, всегда при взгляде сверху (Z+ → Z−), и для нижней пласти тоже.
 * 右 — фреза справа (остаётся то, что слева), 左 — слева. Обход против часовой: снаружи — справа, внутри — слева.
 * Ещё -> outline: точки контура детали для <Outline> (X, Y, Radius: > 0 — против часовой, < 0 — по часовой).
 */
const reverseEls = els => [...els].reverse().map(e => ({ ...e, a: e.b, b: e.a, angle: -e.angle }))
function millPaths(raw, c, W, H, T, fr, dirs = {}) {
  const out = [], through = T + 1
  const edgeCw = dirs.edge === 'cw', cutCcw = dirs.cutout === 'ccw'
  let outline = null
  const sideOf = (els, outside) => {
    const ccw = loopArea(els) > 0
    return ccw === outside ? '右' : '左'
  }
  const closedPath = (els, extra) => ({ start: els[0].a, segs: els.map(e => ({ to: e.b, angle: e.angle })), closed: true, ...extra })
  const onBox = ([x, y]) => x < EPS || y < EPS || x > fr.L - EPS || y > fr.Wm - EPS
  // 1) фигурный контур детали
  let outer = null
  try { const r = parsePolygonFromDetail(raw); if (r?.custom) outer = r.polygon } catch { outer = null }
  if (outer?.length > 2) {
    let els = loopToMachine(outer.map(q => (Array.isArray(q) ? q : [q.x, q.y])), fr)
    if (els.length > 2) {
      outline = els.map(e => ({ X: e.a[0], Y: e.a[1], R: e.r ? (e.angle < 0 ? 1 : -1) * e.r : 0 }))
      // контур детали — против часовой (материал слева)
      if (loopArea(els) < 0) els = reverseEls(els)
      const n = els.length
      const sameSide = (a, b) => (Math.abs(a[0] - b[0]) < EPS && (a[0] < EPS || a[0] > fr.L - EPS)) || (Math.abs(a[1] - b[1]) < EPS && (a[1] < EPS || a[1] > fr.Wm - EPS))
      const cut = i => els[i].angle !== 0 || !sameSide(els[i].a, els[i].b)       // элемент не лежит на габарите
      const start = [...Array(n).keys()].find(i => !cut(i))
      if (start == null) {
        // вся деталь фигурная (круг, овал): замкнутый контур, фреза снаружи
        const loop = edgeCw ? reverseEls(els) : els
        out.push(closedPath(loop, { face: fr.top, depth: through, pocket: false, offset: sideOf(loop, true), cat: 'edge' }))
      } else {
        // Вырез на краю (U-образный, угловая вырубка, скругление угла) — как вырез: замкнутый контур убираемого
        // материала, фреза внутри, как у фрезера. Контур = участок края детали от A до B + путь по габариту от B
        // обратно к A (через углы габарита). Так траектория не выходит за габарит детали, а станок получает
        // замкнутую фрезеровку, как у круглого выреза (открытую, начатую на краю детали, он не обрабатывал).
        const P = 2 * (fr.L + fr.Wm)
        const tOf = ([x, y]) => (y < EPS ? x : x > fr.L - EPS ? fr.L + y : y > fr.Wm - EPS ? fr.L + fr.Wm + (fr.L - x) : 2 * fr.L + fr.Wm + (fr.Wm - y))
        const corners = [[0, [0, 0]], [fr.L, [fr.L, 0]], [fr.L + fr.Wm, [fr.L, fr.Wm]], [2 * fr.L + fr.Wm, [0, fr.Wm]]]
        let run = null
        const flush = () => {
          if (!run) return
          const A = run[0].a, B = run[run.length - 1].b
          // от B к A по габариту по часовой (t убывает): углы, лежащие между ними
          const tA = tOf(A), tB = tOf(B), span = ((tB - tA) % P + P) % P
          const back = corners.map(([t, q]) => ({ d: ((tB - t) % P + P) % P, q })).filter(c => c.d > EPS && c.d < span - EPS).sort((u, v) => u.d - v.d).map(c => c.q)
          const pts = [B, ...back, A]
          const close = pts.slice(1).map((q, k) => ({ a: pts[k], b: q, angle: 0, r: 0 })).filter(e => Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]) > EPS)
          let loop = [...run, ...close]                    // убираемый материал справа — обход по часовой
          if (!edgeCw) loop = reverseEls(loop)
          out.push(closedPath(loop, { face: fr.top, depth: through, pocket: false, offset: sideOf(loop, false), cat: 'edge' }))
          run = null
        }
        for (let k = 1; k <= n; k++) { const i = (start + k) % n; if (cut(i)) (run ||= []).push(els[i]); else flush() }
        flush()
      }
    }
  }
  // 2) вырезы и выемки
  ;(c.holes || []).forEach(hole => {
    const poly = detailHoles({ width: W, length: H, contour: JSON.stringify({ holes: [hole] }) })[0]
    if (!poly) return
    let els = loopToMachine(poly.map(q => [q.x, q.y]), fr)
    if (els.length < 2) return
    if (hole.type === 'pocket') {
      const face = hole.face === 'back' ? fr.bottom : fr.top
      out.push(closedPath(els, { face, depth: Math.min(n0(hole.depth) || 10, T), pocket: true, offset: sideOf(els, false), cat: 'pocket' }))
      return
    }
    if (els.some(e => onBox(e.a))) return       // вырез до края — уже в фигурном контуре
    if ((loopArea(els) > 0) !== cutCcw) els = reverseEls(els)       // обход выреза — как в настройках (по умолчанию по часовой)
    out.push(closedPath(els, { face: fr.top, depth: through, pocket: false, offset: sideOf(els, false), cat: 'cutout' }))
  })
  // 3) фрезеровка фасада из импорта (выборки и профильные траектории)
  ;(c.decor || []).forEach(dc => {
    const face = dc.face === 'back' ? fr.bottom : fr.top
    if (dc.kind === 'pocket') {
      ;(dc.polys || []).forEach(pl => {
        const els = pl.length > 2 ? loopToMachine(pl, fr) : []
        if (els.length > 2 && n0(dc.depth) > 0) out.push(closedPath(els, { face, depth: Math.min(n0(dc.depth), T), pocket: true, offset: sideOf(els, false), cat: 'pocket' }))
      })
    } else if (Array.isArray(dc.path) && dc.path.length > 1) {
      const depth = Math.max(0, ...(dc.profile || []).map(q => n0(q?.[1])))
      const pts = dc.path.map(([x, y]) => fr.at(x, y))
      if (depth > 0) out.push({ face, start: pts[0], segs: pts.slice(1).map(to => ({ to, angle: 0 })), closed: false, depth: Math.min(depth, T), pocket: false, offset: '中', cat: 'decor' })
    }
  })
  return { mills: out, outline }
}

// ── Инструменты и обработка шестистороннего станка (свои у каждого станка: номера инструментов у всех разные) ──
// post.d6Tools: [{ id, name — как в станке (T2), kind: 'mill' | 'saw' (фреза | диск), d — диаметр фрезы / толщина диска }]
// post.d6Ops: по видам обработки { mode: 'auto' | 'tool' | 'width', tool, rules: [{ upTo, tool }], dir } и layers — свой
// инструмент слоя: ключ слоя -> id инструмента или 'auto'
export const D6_CATS = ['groove', 'edgeGroove', 'pocket', 'cutout', 'edge']
export const D6_OPS_DEFAULT = () => ({
  groove: { mode: 'auto', tool: '', rules: [] },          // пазы в пласти
  edgeGroove: { mode: 'auto', tool: '', rules: [] },      // пазы в торце
  pocket: { mode: 'auto', tool: '' },                     // выемки (выборки)
  cutout: { mode: 'auto', tool: '', dir: 'cw' },          // вырезы внутри детали: фреза внутри, по часовой — как у фрезера
  edge: { mode: 'auto', tool: '', dir: 'cw' },            // вырезы на краю (U-образный, угловая вырубка): как вырез — фреза внутри, по часовой
  layers: {},
})
export function d6OpsOf(post) {
  const d = D6_OPS_DEFAULT(), o = post?.d6Ops || {}
  const ops = { layers: { ...(o.layers || {}) } }
  for (const k of D6_CATS) ops[k] = { ...d[k], ...(o[k] || {}) }
  let tools = Array.isArray(post?.d6Tools) ? post.d6Tools.filter(t => t && t.id) : []
  // раньше был один инструмент на всё (d6Tool при снятой галочке «авто»)
  if (!post?.d6Ops && post?.d6ToolAuto === false && post?.d6Tool) {
    tools = [...tools, { id: 'legacy', name: post.d6Tool, kind: 'mill', d: 0 }]
    for (const k of D6_CATS) ops[k] = { ...ops[k], mode: 'tool', tool: 'legacy' }
  }
  return { ops, tools }
}
export const layerKey = (cat, width, depth) => (cat === 'pocket' ? `p${r1(depth)}` : `${cat === 'edgeGroove' ? 'e' : 'g'}${r1(width)}x${r1(depth)}`)
const r1 = v => Math.round(n0(v) * 10) / 10
/** Какой инструмент у обработки: { tool (null — авто), how: 'layer' | 'tool' | 'width' | 'auto', missing } */
export function resolveD6Tool(o6, cat, width, key) {
  const byId = id => o6.tools.find(t => t.id === id) || null
  const ov = key ? o6.ops.layers?.[key] : null
  if (ov === 'auto') return { tool: null, how: 'layer' }
  if (ov && byId(ov)) return { tool: byId(ov), how: 'layer' }
  const op = o6.ops[cat] || { mode: 'auto' }
  if (op.mode === 'tool') { const t = byId(op.tool); return { tool: t, how: 'tool', missing: !t } }
  if (op.mode === 'width' && width > 0) {
    const r = (op.rules || []).filter(q => n0(q.upTo) > 0).sort((a, b) => n0(a.upTo) - n0(b.upTo)).find(q => width <= n0(q.upTo) + 0.001)
    const t = r ? byId(r.tool) : null
    return { tool: t, how: 'width', missing: !t }
  }
  return { tool: null, how: 'auto' }
}

/**
 * Одна деталь -> { xml, ops, warnings } или null (нет никакой обработки и d6All выключен).
 * d — строка order_details (по готовой детали), T — толщина, id — имя детали в файле.
 */
export function panelXml(d, { T, id, post = {}, types = {} }) {
  const raw = rawDetail(d)
  const W = n0(raw.width), H = n0(raw.length)
  const c = contourOf(raw) || {}
  // лицевая — сверху, как на фрезерном ЧПУ; длинная сторона — вдоль станка, кромка — вверх
  const et = edgeThick(raw, types)
  const fr = machineFrame(W, H, chooseTurn(W, H, et), 'front')
  const warnings = []
  const o6 = d6OpsOf(post)
  const layers = []                                  // слои детали (для настроек: какие пазы и выемки есть в заказе)
  const toolOf = (cat, width, depth, what) => {
    const key = cat === 'groove' || cat === 'edgeGroove' || cat === 'pocket' ? layerKey(cat, width, depth) : null
    if (key) layers.push({ key, cat, width: r1(width), depth: r1(depth) })
    const r = resolveD6Tool(o6, cat, width, key)
    if (r.missing) warnings.push(`${what}: инструмент не назначен — в программе «авто»`)
    else if (r.tool && r.tool.kind !== 'saw' && width > 0 && n0(r.tool.d) > width + 0.05) warnings.push(`${what}: фреза ${r.tool.name} Ø${r1(r.tool.d)} шире паза`)
    return r.tool
  }
  const drillAttr = t => (t ? ` Drill="${esc(latin(t.name) || t.name)}"` : '')
  const top = [], bottom = [], edge = [], grooves = [], edgeGrooves = []

  // присадка — по тем же правилам, что 3D-модель детали: у каждого отверстия своя пласть (лицевая, обратная или обе),
  // у торцевого — высота от лицевой пласти (offsetFace). Размеры — готовой детали, без подрезки под кромку.
  const faceHole = (x, y, face, dia, depth) => {
    const [X, Y] = fr.at(x, y), back = face === 'back'
    ;(back ? bottom : top).push({ X, Y, depth: depth > 0 ? Math.min(depth, T) : T, dia, face: back ? fr.bottom : fr.top })
  }
  ;(c.drillings || []).forEach(dr => {
    if (dr.installed === false) return
    let pts
    try { pts = getDrillPoints(dr, W, H, c.layout || []) } catch { pts = [] }
    for (const p of pts) {
      const dia = n0(p.ehD ?? (p.isPair ? dr.pairD ?? dr.d : dr.d)) || 8
      const depth = n0(p.ehDepth ?? (p.isPair ? dr.pairDepth ?? dr.depth : dr.depth) ?? 13)
      if (dr.kind === 'edge' && !p.isFaceType) {
        const [X, Y] = fr.at(p.x, p.y), face = fr.faceAt(X, Y)
        if (!face) { warnings.push('отверстие в торец не на краю детали (в вырезе) — пропущено'); continue }
        const zf = dr.offsetFace != null && dr.offsetFace !== '' ? n0(dr.offsetFace) : T / 2   // от лицевой пласти
        edge.push({ face, X, Y, Z: T - zf, depth, dia })   // на станке Z — от нижней пласти, лицевая сверху
        continue
      }
      const face = p.ehFace ?? (dr.kind === 'edge' || p.isPair ? dr.pairFace ?? dr.face : dr.face) ?? 'front'
      if (face === 'both') { faceHole(p.x, p.y, 'front', dia, depth); faceHole(p.x, p.y, 'back', dia, depth) }
      else faceHole(p.x, p.y, face, dia, depth)
    }
  })

  getGrooveRects(c, W, H, false).forEach(g => {
    const pts = g.pts.map(([x, y]) => fr.at(x, y))
    const xs = pts.map(q => q[0]), ys = pts.map(q => q[1])
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys)
    const alongX = x1 - x0 >= y1 - y0
    const width = n0(g.width) || Math.min(x1 - x0, y1 - y0)
    const line = alongX ? [x1, (y0 + y1) / 2, x0, (y0 + y1) / 2] : [(x0 + x1) / 2, y0, (x0 + x1) / 2, y1]
    const gd = n0(g.depth) > 0 ? n0(g.depth) : T
    grooves.push({ face: g.back ? fr.bottom : fr.top, line, width, depth: gd, tool: toolOf('groove', width, gd, `паз ${r1(width)} × ${r1(gd)}`) })
  })

  // пазы в торце — на торец Face 1–4, высота от нижней пласти (лицевая сверху)
  ;(c.edgeGrooves || []).forEach(g => {
    const geo = edgeGrooveGeom(g, W, H)
    const width = n0(g.width), depth = n0(g.depth)
    if (!geo || !(width > 0) || !(depth > 0)) return
    const p0 = fr.at(...geo.line[0]), p1 = fr.at(...geo.line[1])
    const face = fr.faceAt((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2)
    if (!face) { warnings.push('паз в торце не на краю детали — пропущен'); return }
    edgeGrooves.push({ face, line: [...p0, ...p1], Z: T - n0(g.fromFace) - width / 2, width, depth, tool: toolOf('edgeGroove', width, depth, `паз в торце ${r1(width)} × ${r1(depth)}`) })
  })

  const { mills, outline } = millPaths(raw, c, W, H, T, fr, { edge: o6.ops.edge.dir, cutout: o6.ops.cutout.dir })
  const MILL_WHAT = { edge: 'фигурный край', cutout: 'вырез', pocket: 'выемка' }
  mills.forEach(m => { m.tool = m.cat === 'decor' ? null : toolOf(m.cat, 0, m.cat === 'pocket' ? m.depth : 0, m.cat === 'pocket' ? `выемка глубиной ${r1(m.depth)}` : MILL_WHAT[m.cat]) })
  mills.forEach(m => { if (m.cat === 'cutout' || m.cat === 'edge') layers.push({ key: m.cat, cat: m.cat }) })
  const ops = top.length + bottom.length + edge.length + grooves.length + edgeGrooves.length + mills.length
  if (!ops && !post.d6All) return null

  // порядок — как в образце: пласть сверху (по Y, затем по X), торцы, пазы, пласть снизу
  const byYX = (a, b) => a.Y - b.Y || a.X - b.X
  top.sort(byYX); bottom.sort(byYX)
  edge.sort((a, b) => a.face - b.face || a.X - b.X || a.Y - b.Y)
  let mid = 1000
  const nextId = () => { const v = mid; mid += 10; return v }
  const lines = []
  const hole = h => lines.push(`\t\t\t\t\t<Machining ID="${nextId()}" Type="2" IsGenCode="2" Face="${h.face}" X="${f3(h.X)}" Y="${f3(h.Y)}" Depth="${f3(h.depth)}" Diameter="${f3(h.dia)}" />`)
  top.forEach(hole)
  edge.forEach(h => lines.push(`\t\t\t\t\t<Machining ID="${nextId()}" Type="1" IsGenCode="2" Face="${h.face}" X="${f3(h.X)}" Y="${f3(h.Y)}" Z="${f3(h.Z)}" Depth="${f3(h.depth)}" Diameter="${f3(h.dia)}" />`))
  const mill = m => {
    lines.push(`\t\t\t\t\t<Machining ID="${nextId()}" Type="3" IsGenCode="2" Face="${m.face}" Depth="${f3(m.depth)}" X="${f3(m.start[0])}" Y="${f3(m.start[1])}" Pocket="${m.pocket ? 1 : 0}" Closed="${m.closed ? 1 : 0}" ToolOffset="${m.offset}"${drillAttr(m.tool)}>`)
    lines.push(`\t\t\t\t\t\t<Lines${m.closed ? ' Closed="1"' : ''}>`)
    m.segs.forEach((g, i) => lines.push(`\t\t\t\t\t\t\t<Line LineID="${i + 1}" EndX="${f3(g.to[0])}" EndY="${f3(g.to[1])}" Angle="${(Math.round(g.angle * 1e6) / 1e6).toFixed(6)}" />`))
    lines.push('\t\t\t\t\t\t</Lines>', '\t\t\t\t\t</Machining>')
  }
  mills.filter(m => m.face === fr.top).forEach(mill)
  grooves.forEach(g => lines.push(`\t\t\t\t\t<Machining ID="${nextId()}" Type="4" IsGenCode="2" Face="${g.face}" X="${f3(g.line[0])}" Y="${f3(g.line[1])}" EndX="${f3(g.line[2])}" EndY="${f3(g.line[3])}" Width="${f3(g.width)}" Depth="${f3(g.depth)}"${drillAttr(g.tool)} />`))
  edgeGrooves.forEach(g => lines.push(`\t\t\t\t\t<Machining ID="${nextId()}" Type="4" IsGenCode="2" Face="${g.face}" X="${f3(g.line[0])}" Y="${f3(g.line[1])}" Z="${f3(g.Z)}" EndX="${f3(g.line[2])}" EndY="${f3(g.line[3])}" EndZ="${f3(g.Z)}" Width="${f3(g.width)}" Depth="${f3(g.depth)}"${drillAttr(g.tool)} />`))
  bottom.forEach(hole)
  mills.filter(m => m.face !== fr.top).forEach(mill)

  const faceEdge = edgesByFace(fr, W, H, et)
  const eth = v => (v > 0 ? f3(v) : '0.000000')

  const name = String(raw.name || '').trim() || 'Деталь'
  const xml = [
    '<?xml version="1.0" encoding="utf-8" ?>',
    '<Root>',
    '\t<Project Name="" Flag="SWJ008">',
    '\t\t<Panels>',
    `\t\t\t<Panel ID="${esc(id)}" Name="${esc(name)}" Width="${f3(fr.Wm)}" Length="${f3(fr.L)}" Material="" Thickness="${f3(T)}" IsProduce="true" MachiningPoint="1" Type="1" Face5ID="" Face6ID="" Grain="L">`,
    outline ? ['\t\t\t\t<Outline>', ...outline.map(p => `\t\t\t\t\t<Point X="${f3(p.X)}" Y="${f3(p.Y)}"${p.R ? ` Radius="${f3(p.R)}"` : ''} />`), '\t\t\t\t</Outline>'].join('\r\n') : '\t\t\t\t<Outline></Outline>',
    '\t\t\t\t<Machines>',
    ...lines,
    '\t\t\t\t</Machines>',
    '\t\t\t\t<EdgeGroup>',
    ...[1, 2, 3, 4].map(f => `\t\t\t\t\t<Edge Face="${f}" Thickness="${eth(faceEdge[f])}" />`),
    '\t\t\t\t</EdgeGroup>',
    '\t\t\t</Panel>',
    '\t\t</Panels>',
    '\t</Project>',
    '</Root>',
    '',
  ].join('\r\n')
  // сколько чего у детали (для списков деталей на рабочих постах): лицевая — сверху (fr.top), обратная — снизу
  const counts = { top: top.length, bottom: bottom.length, edge: edge.length, edgeGrooves: edgeGrooves.length,
    groovesTop: grooves.filter(g => g.face === fr.top).length, groovesBottom: grooves.filter(g => g.face !== fr.top).length,
    millsTop: mills.filter(m => m.face === fr.top).length, millsBottom: mills.filter(m => m.face !== fr.top).length }
  return { xml, ops, warnings, counts, layers }
}

// ─── Имена файлов и папки ───────────────────────────────────────────────────
// Главное — код на бирке: на станке бирку сканируют, и станок открывает файл с этим именем (у шестистороннего
// станка код = ID детали = имя файла). Поэтому по умолчанию имя файла — это код QR с бирки (шаблон бирок).
// Можно и своё имя — тем же конструктором, что QR бирки (например, когда бирки и программы делает другая программа,
// а у нас только раскрой — или наоборот). Папка — свой шаблон, вложенные папки через «/».
// заказ + обозначение детали (без номера карты и номера на листе); имя клиента — только в папке, не в имени файла
export const D6_QR_DEFAULT = { parts: ['order', 'des'], sep: '_', text: '', latin: true }
export const D6_FOLDER_DEFAULT = '{ZAKAZ}/XML'
/** Папки XML шестистороннего станка по умолчанию (матрёшка, см. DirPathEditor) */
export const DRILL_DIR_DEFAULT = '{ZAKAZ}_CNC_6side/{MAT}'
const BAD_CHARS = /[\\/:*?"<>|]/g                      // в имени файла недопустимы (Windows, флешки станков)

/** Настройки кода для имени файла: код бирки или свой конструктор (ссылка на 3D в имени файла невозможна) */
export function drill6Qr(post, labelTpl) {
  const q = post?.d6Name === 'own' ? { ...D6_QR_DEFAULT, ...post.d6Qr } : { ...D6_QR_DEFAULT, ...labelTpl?.qr }
  return { ...q, parts: (q.parts || []).filter(k => k !== 'link') }
}
/** Вложенные папки для сохранения: шаблон «{ZAKAZ}/XML» -> ['Kuhnya', 'XML'] */
export function drill6Folders(post, ctx) {
  return String(post?.dirPath ?? DRILL_DIR_DEFAULT).split('/').map(t => t.trim()).filter(Boolean)
    .map(t => folderName(t, ctx)).filter(Boolean)
}

/**
 * Слои обработки заказа для настроек шестистороннего станка: пазы в пласти и в торце (ширина × глубина), выемки (по глубине),
 * а также сколько вырезов и фигурных краёв. details — строки заказа, T — толщина материала.
 * -> { groove: [{ key, width, depth, count }], edgeGroove: [...], pocket: [...], cutout, edge }
 */
export function drill6Layers(details, T, post = {}, types = {}) {
  const out = { groove: new Map(), edgeGroove: new Map(), pocket: new Map(), cutout: 0, edge: 0 }
  for (const d of details || []) {
    let r
    try { r = panelXml(d, { T: n0(T) || 16, id: 'x', post: { ...post, d6All: true }, types }) } catch { r = null }
    if (!r) continue
    const pcs = Math.max(1, n0(rawDetail(d).qty) || 1)
    for (const l of r.layers || []) {
      if (!out[l.cat]?.set) { if (l.cat === 'cutout' || l.cat === 'edge') out[l.cat] += pcs; continue }
      const was = out[l.cat].get(l.key)
      out[l.cat].set(l.key, { ...l, count: (was?.count || 0) + pcs })
    }
  }
  const list = m => [...m.values()].sort((a, b) => a.width - b.width || a.depth - b.depth)
  return { groove: list(out.groove), edgeGroove: list(out.edgeGroove), pocket: list(out.pocket), cutout: out.cutout, edge: out.edge }
}

/**
 * Файлы для шестистороннего станка — по каждой детали на картах раскроя (у каждой своя бирка).
 * Имя файла и ID детали — код (как в QR бирки, см. drill6Qr). Одинаковый код у одной и той же детали — один файл;
 * у разных деталей — к коду добавляется _2, _3 и предупреждение (код не уникален, сканер не различит детали).
 * makeCode(si, pi, q) -> строка кода (labelQr(labelInfo(...)) — передаётся снаружи, чтобы не тянуть сюда бирки).
 * -> { files: [{ name, data, detail, code }], skipped, warnings }
 */
export function buildDrill6Files({ mat, order, post = {}, labelTpl, makeCode }) {
  const types = parseEdgeTypes(order?.edge_types)
  const T = n0(mat?.thickness) || 16
  const ext = latin(post.ext || 'XML') || 'XML'
  const q = drill6Qr(post, labelTpl)
  const files = [], warnings = new Set(), byCode = new Map(), body = new Map(), skippedDi = new Set()
  ;(mat?.sheets || []).forEach((sh, si) => (sh.placed || []).forEach((p, pi) => {
    const di = p.detailIndex, d = mat.details?.[di]
    if (!d) return
    if (!body.has(di)) body.set(di, panelXml(d, { T, id: '\u0000ID\u0000', post, types }))
    const r = body.get(di)
    if (!r) { skippedDi.add(di); return }
    let code = String(makeCode?.(si, pi, q) || '').trim()
    if (!code) { code = `L${si + 1}_N${pi + 1}`; warnings.add('код детали пуст — выберите части кода (QR бирки или своё имя файла); пока имя: L<лист>_N<деталь>') }
    if (BAD_CHARS.test(code)) { code = code.replace(BAD_CHARS, '-'); warnings.add('в коде есть символы, недопустимые в имени файла (\\ / : * ? " < > |) — заменены на «-», имя файла не совпадёт с кодом на бирке; уберите их из кода') }
    BAD_CHARS.lastIndex = 0
    if (/[^\x20-\x7E]/.test(code)) warnings.add('в коде есть не латинские буквы — по спецификации станка код только из латиницы и цифр: включите «Перевести в латиницу»')
    const was = byCode.get(code)
    if (was === di) return                                // та же деталь с тем же кодом — один файл
    if (was != null) {
      let k = 2
      while (byCode.has(`${code}_${k}`) && byCode.get(`${code}_${k}`) !== di) k++
      warnings.add('код на бирке повторяется у разных деталей — сканер станка их не различит: у деталей нет обозначений (или они одинаковые). Присвойте деталям обозначения в заказе или добавьте в код наименование и размер')
      code = `${code}_${k}`
      if (byCode.get(code) === di) return
    }
    byCode.set(code, di)
    r.warnings.forEach(w => warnings.add(`${rawDetail(d).name || 'Деталь'}: ${w}`))
    files.push({ name: `${code}.${ext}`, code, data: r.xml.replace('\u0000ID\u0000', esc(code)), detail: rawDetail(d).name || '', ops: r.ops })
  }))
  return { files, skipped: skippedDi.size, warnings: [...warnings] }
}
