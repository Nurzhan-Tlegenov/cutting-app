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
 *   Type 3 — фрезеровка по линиям: X, Y — начало, <Lines><Line EndX EndY Angle/></Lines>, Depth, Pocket (1 — выборка
 *            площади внутри контура), ToolOffset (右 — фреза справа от направления хода, 左 — слева, 中 — по линии), Drill.
 *            В образце: выборка в краю детали, Depth 17 при толщине 16 — сквозь. Дуги выводим мелкими отрезками (Angle 0).
 *
 * На станок уходит ВСЁ, что есть в детали, — даже то, что уже сделал фрезерный ЧПУ на раскрое (отверстия и пазы лицевой
 * пласти, фигурный контур, вырезы, выемки): лишнее оператор отключает фильтром на стойке (например, обработку Face 5).
 */
import { getDrillPoints, getGrooveRects } from './drillGeometry'
import { rawDetail, parseEdgeTypes, edgeKey } from './edgeCut'
import { detailMeta } from './partLabel'
import { toLatin, folderName } from './orderUtils'
import { detailHoles } from './partHoles'
import { parsePolygonFromDetail } from './trueShapeNesting'
import { smoothLoop } from './arcFit'

const EPS = 0.05
const n0 = v => { const x = Number(String(v ?? '').replace(',', '.')); return isFinite(x) ? x : 0 }
const f3 = v => (Math.round(n0(v) * 1000) / 1000).toFixed(3)
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const pad2 = n => String(n).padStart(2, '0')
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

const area = P => { let a = 0; for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; a += p[0] * q[1] - q[0] * p[1] } return a / 2 }
const dedupe = P => P.filter((p, i) => { const q = P[(i + 1) % P.length]; return Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.001 })
const smooth = P => { try { const s = smoothLoop(P, 0.02); return s?.length > 2 ? s : P } catch { return P } }
/**
 * Фрезеровки детали (Type 3) в координатах станка: [{ face, pts (первая — начало), depth, pocket, offset }]
 *   фигурный контур — только участки, которые не лежат на габарите детали (прямые края габарита не фрезеруются), фреза снаружи;
 *   вырезы внутри детали — замкнуто, фреза внутри, насквозь; выемки — выборка (Pocket 1) на свою глубину и пласть;
 *   фрезеровка фасада (декор из импорта) — выборки и траектории по линии.
 * ToolOffset: 右 — справа от хода. Для нижней пласти (Face 6) сторона считается как при взгляде снизу.
 */
function millPaths(raw, c, W, H, T, fr) {
  const out = [], through = T + 1
  const sideOf = (P, outside, face) => {          // P — в координатах станка, замкнутый
    let ccw = area(P) > 0
    if (face === fr.bottom) ccw = !ccw
    return (ccw === outside) ? '右' : '左'      // обход против часовой: снаружи — справа
  }
  const onBox = ([x, y]) => x < EPS || y < EPS || x > fr.L - EPS || y > fr.Wm - EPS
  // 1) фигурный контур детали
  let outer = null
  try { const r = parsePolygonFromDetail(raw); if (r?.custom) outer = r.polygon } catch { outer = null }
  if (outer?.length > 2) {
    const P = dedupe(smooth(outer.map(q => (Array.isArray(q) ? q : [q.x, q.y]))).map(([x, y]) => fr.at(x, y)))
    const off = sideOf(P, true, fr.top), n = P.length
    const sameSide = (a, b) => (Math.abs(a[0] - b[0]) < EPS && (a[0] < EPS || a[0] > fr.L - EPS)) || (Math.abs(a[1] - b[1]) < EPS && (a[1] < EPS || a[1] > fr.Wm - EPS))
    const cut = i => !sameSide(P[i], P[(i + 1) % n])          // ребро i (P[i] -> P[i+1]) не лежит на габарите
    const start = [...Array(n).keys()].find(i => !cut(i))
    if (start == null) out.push({ face: fr.top, pts: [...P, P[0]], depth: through, pocket: false, offset: off })   // вся деталь фигурная
    else {
      let run = null
      for (let k = 1; k <= n; k++) {
        const i = (start + k) % n
        if (cut(i)) { if (!run) run = [P[i]]; run.push(P[(i + 1) % n]) }
        else if (run) { out.push({ face: fr.top, pts: run, depth: through, pocket: false, offset: off }); run = null }
      }
      if (run) out.push({ face: fr.top, pts: run, depth: through, pocket: false, offset: off })
    }
  }
  // 2) вырезы и выемки
  ;(c.holes || []).forEach(hole => {
    const poly = detailHoles({ width: W, length: H, contour: JSON.stringify({ holes: [hole] }) })[0]
    if (!poly) return
    const P = dedupe(smooth(poly.map(q => [q.x, q.y])).map(([x, y]) => fr.at(x, y)))
    if (P.length < 3) return
    if (hole.type === 'pocket') {
      const face = hole.face === 'back' ? fr.bottom : fr.top
      out.push({ face, pts: [...P, P[0]], depth: Math.min(n0(hole.depth) || 10, T), pocket: true, offset: sideOf(P, false, face) })
      return
    }
    if (P.some(onBox)) return                    // вырез до края — уже в фигурном контуре
    out.push({ face: fr.top, pts: [...P, P[0]], depth: through, pocket: false, offset: sideOf(P, false, fr.top) })
  })
  // 3) фрезеровка фасада из импорта (выборки и профильные траектории)
  ;(c.decor || []).forEach(dc => {
    const face = dc.face === 'back' ? fr.bottom : fr.top
    if (dc.kind === 'pocket') {
      ;(dc.polys || []).forEach(pl => {
        const P = dedupe(pl.map(([x, y]) => fr.at(x, y)))
        if (P.length > 2 && n0(dc.depth) > 0) out.push({ face, pts: [...P, P[0]], depth: Math.min(n0(dc.depth), T), pocket: true, offset: sideOf(P, false, face) })
      })
    } else if (Array.isArray(dc.path) && dc.path.length > 1) {
      const depth = Math.max(0, ...(dc.profile || []).map(q => n0(q?.[1])))
      if (depth > 0) out.push({ face, pts: dc.path.map(([x, y]) => fr.at(x, y)), depth: Math.min(depth, T), pocket: false, offset: '中' })
    }
  })
  return out
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
  const top = [], bottom = [], edge = [], grooves = []

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
    grooves.push({ face: g.back ? fr.bottom : fr.top, line, width, depth: n0(g.depth) > 0 ? n0(g.depth) : T })
  })

  const mills = millPaths(raw, c, W, H, T, fr)
  const ops = top.length + bottom.length + edge.length + grooves.length + mills.length
  if (!ops && !post.d6All) return null

  // порядок — как в образце: пласть сверху (по Y, затем по X), торцы, пазы, пласть снизу
  const byYX = (a, b) => a.Y - b.Y || a.X - b.X
  top.sort(byYX); bottom.sort(byYX)
  edge.sort((a, b) => a.face - b.face || a.X - b.X || a.Y - b.Y)
  const tool = latin(post.d6Tool || 'T2') || 'T2'
  let mid = 1000
  const nextId = () => { const v = mid; mid += 10; return v }
  const lines = []
  const hole = h => lines.push(`\t\t\t\t\t<Machining ID="${nextId()}" Type="2" IsGenCode="2" Face="${h.face}" X="${f3(h.X)}" Y="${f3(h.Y)}" Depth="${f3(h.depth)}" Diameter="${f3(h.dia)}" />`)
  top.forEach(hole)
  edge.forEach(h => lines.push(`\t\t\t\t\t<Machining ID="${nextId()}" Type="1" IsGenCode="2" Face="${h.face}" X="${f3(h.X)}" Y="${f3(h.Y)}" Z="${f3(h.Z)}" Depth="${f3(h.depth)}" Diameter="${f3(h.dia)}" />`))
  const mill = m => {
    lines.push(`\t\t\t\t\t<Machining ID="${nextId()}" Type="3" IsGenCode="2" Face="${m.face}" Depth="${f3(m.depth)}" X="${f3(m.pts[0][0])}" Y="${f3(m.pts[0][1])}" Pocket="${m.pocket ? 1 : 0}" ToolOffset="${m.offset}" Drill="${esc(tool)}">`)
    lines.push('\t\t\t\t\t\t<Lines>')
    m.pts.slice(1).forEach(([X, Y], i) => lines.push(`\t\t\t\t\t\t\t<Line LineID="${i + 1}" EndX="${f3(X)}" EndY="${f3(Y)}" Angle="0.000000" />`))
    lines.push('\t\t\t\t\t\t</Lines>', '\t\t\t\t\t</Machining>')
  }
  mills.filter(m => m.face === fr.top).forEach(mill)
  grooves.forEach(g => lines.push(`\t\t\t\t\t<Machining ID="${nextId()}" Type="4" IsGenCode="2" Face="${g.face}" X="${f3(g.line[0])}" Y="${f3(g.line[1])}" EndX="${f3(g.line[2])}" EndY="${f3(g.line[3])}" Width="${f3(g.width)}" Depth="${f3(g.depth)}" Drill="${esc(tool)}" />`))
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
    '\t\t\t\t<Outline></Outline>',
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
  return { xml, ops, warnings }
}

/** Начало названия файлов (и кода детали на бирке): по шаблону присадочного постпроцессора, без имени клиента */
export function drill6Prefix(post, order, mat) {
  const ctx = { order, material: mat?.name || order?.material_name || '', thickness: mat?.thickness, total: mat?.sheets?.length || 0 }
  return latin(folderName(post?.nameTpl || '{ZAKAZ}', ctx)) || 'zakaz'
}
/**
 * Код каждой детали материала: «начало^номер» — это и имя файла (без расширения), и Panel ID, и то, что пишется в QR
 * бирки: на шестистороннем станке деталь сканируют — и открывается её программа. Номер — позиция из модели
 * (Базис / Астра), иначе порядковый номер в списке; не зависит от того, есть ли у детали присадка.
 */
export function drill6Ids(details, prefix) {
  const used = new Set()
  return (details || []).map((d, i) => {
    const meta = detailMeta(rawDetail(d))
    let num = meta?.pos != null && String(meta.pos).trim() ? latin(String(meta.pos).trim()) : pad2(i + 1)
    while (used.has(num)) num += '_'
    used.add(num)
    return `${prefix}^${num}`
  })
}

/**
 * Файлы для шестистороннего станка по деталям материала.
 * details — детали материала (как в раскрое; размеры берутся по готовой детали), mat — материал (для названия файлов).
 * -> { files: [{ name, data, detail, qty, ops }], skipped (без присадки), warnings }
 */
export function buildDrill6Files({ details, thickness, order, post = {}, mat = null }) {
  const types = parseEdgeTypes(order?.edge_types)
  const ids = drill6Ids(details, drill6Prefix(post, order, mat))
  const ext = latin(post.ext || 'XML') || 'XML'
  const files = [], warnings = new Set()
  let skipped = 0
  ;(details || []).forEach((d, i) => {
    const id = ids[i]
    const r = panelXml(d, { T: n0(thickness) || 16, id, post, types })
    if (!r) { skipped++; return }
    r.warnings.forEach(w => warnings.add(`${rawDetail(d).name || 'Деталь ' + (i + 1)}: ${w}`))
    files.push({ name: `${id}.${ext}`, data: r.xml, detail: rawDetail(d).name || '', qty: n0(d.qty) || 1, ops: r.ops })
  })
  return { files, skipped, warnings: [...warnings] }
}
