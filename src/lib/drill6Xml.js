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
 *   Type 3 — фрезеровка по линиям (в образце — выборки в краю детали) — пока не выводим.
 */
import { getDrillPoints, getGrooveRects } from './drillGeometry'
import { rawDetail, parseEdgeTypes, edgeKey } from './edgeCut'
import { detailMeta } from './partLabel'
import { toLatin, folderName } from './orderUtils'

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

/**
 * Одна деталь -> { xml, ops, warnings } или null (нет присадки и includeEmpty выключен).
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

  const pockets = (c.holes || []).length
  if (pockets) warnings.push('выемки и вырезы в XML шестистороннего станка пока не выводятся')
  if (Array.isArray(c.vertices) && (c.vertices.length > 4 || c.vertices.some(v => v?.type === 'arc'))) warnings.push('фигурный контур детали в XML не передаётся — только прямоугольник')

  const ops = top.length + bottom.length + edge.length + grooves.length
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
  grooves.forEach(g => lines.push(`\t\t\t\t\t<Machining ID="${nextId()}" Type="4" IsGenCode="2" Face="${g.face}" X="${f3(g.line[0])}" Y="${f3(g.line[1])}" EndX="${f3(g.line[2])}" EndY="${f3(g.line[3])}" Width="${f3(g.width)}" Depth="${f3(g.depth)}" Drill="${esc(tool)}" />`))
  bottom.forEach(hole)

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

/**
 * Файлы для шестистороннего станка по деталям материала.
 * details — детали материала (как в раскрое; размеры берутся по готовой детали), ctx — для названия файлов.
 * -> { files: [{ name, data, detail, qty, ops }], skipped (без присадки), warnings }
 */
export function buildDrill6Files({ details, thickness, order, post = {}, ctx = {} }) {
  const types = parseEdgeTypes(order?.edge_types)
  const prefix = latin(folderName(post.nameTpl || '{ZAKAZ}', ctx)) || 'zakaz'
  const ext = latin(post.ext || 'XML') || 'XML'
  const files = [], warnings = new Set()
  let skipped = 0
  const used = new Set()
  ;(details || []).forEach((d, i) => {
    const meta = detailMeta(rawDetail(d))
    // номер детали: позиция из модели (Базис / Астра), иначе — порядковый номер в списке
    let num = meta?.pos != null && String(meta.pos).trim() ? latin(String(meta.pos).trim()) : pad2(i + 1)
    while (used.has(num)) num += '_'
    const id = `${prefix}^${num}`
    const r = panelXml(d, { T: n0(thickness) || 16, id, post, types })
    if (!r) { skipped++; return }
    used.add(num)
    r.warnings.forEach(w => warnings.add(`${rawDetail(d).name || 'Деталь ' + (i + 1)}: ${w}`))
    files.push({ name: `${id}.${ext}`, data: r.xml, detail: rawDetail(d).name || '', qty: n0(d.qty) || 1, ops: r.ops })
  })
  return { files, skipped, warnings: [...warnings] }
}
