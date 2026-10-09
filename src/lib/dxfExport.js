/**
 * Экспорт результата раскроя в DXF — простой текстовый DXF (совместимый с
 * R12, читается любым CAD-просмотрщиком), без внешних библиотек.
 *
 * Один файл — ВСЕ листы заказа, разложенные в ряд по горизонтали с зазором
 * между ними (у DXF нет понятия "страница").
 *
 * В файле то же, что на карте раскроя, каждый тип — на своём слое:
 *   sheet            — контур листа
 *   detal            — контур детали (реальный полигон или прямоугольник)
 *   vyrez            — внутренние вырезы (сквозные)
 *   PAZ_W<ш>_Z<г>    — пазы: ширина и глубина (прямоугольник)
 *   D<д>_Z<г>        — отверстия в пласть с лицевой стороны: диаметр и глубина (окружность)
 *   TOREC_D<д>_Z<г>  — отверстия в торец: прямоугольник «диаметр × глубина» от кромки вглубь детали
 *   kromka           — стороны и участки контура с кромкой (линия с отступом внутрь детали)
 *   Solid Edge 2D NestingPartName — подпись детали, label — подпись листа
 * Обработка с изнанки (как и на карте) не выводится — она появляется после переворота детали.
 * Слои объявлены в таблице слоёв (у каждого свой цвет) и идут по порядку; объекты в файле
 * тоже сгруппированы по слоям.
 */

import { partLabel } from './partLabel'
import { placedHoles, placedTurns } from './partHoles'
import { getAllDrillPoints, getGrooveRects, rotatePointTimes } from './drillGeometry'
import { contourSegments, segmentSide, holeEdgeSegments } from './edgeLength'
import { loopElements } from './arcFit'

const GAP_BETWEEN_SHEETS = 200 // мм, зазор между листами на чертеже
const EDGE_INSET = 3           // мм, линия кромки — с отступом внутрь, чтобы не лежала на контуре
const NAME_LAYER = 'Solid Edge 2D NestingPartName'

const f = v => String(Math.round(v * 1000) / 1000)
const num = v => String(Math.round((Number(v) || 0) * 10) / 10)

function line(x1, y1, x2, y2, layer) {
  return `0\nLINE\n8\n${layer}\n10\n${f(x1)}\n20\n${f(y1)}\n30\n0\n11\n${f(x2)}\n21\n${f(y2)}\n31\n0\n`
}
function circle(x, y, r, layer) {
  return `0\nCIRCLE\n8\n${layer}\n10\n${f(x)}\n20\n${f(y)}\n30\n0\n40\n${f(r)}\n`
}
// дуга в DXF всегда идёт против часовой стрелки от начального угла к конечному (градусы)
function arc(cx, cy, r, a0, a1, layer) {
  const deg = a => { let d = a * 180 / Math.PI % 360; if (d < 0) d += 360; return Math.round(d * 1e6) / 1e6 }
  return `0\nARC\n8\n${layer}\n10\n${f(cx)}\n20\n${f(cy)}\n30\n0\n40\n${f(r)}\n50\n${deg(a0)}\n51\n${deg(a1)}\n`
}
function text(x, y, s, layer, height) {
  // не-ASCII символы кодируются как \U+XXXX — это понимает любой CAD, независимо от кодовой страницы файла
  const safe = String(s).replace(/[\r\n]/g, ' ').replace(/[^\x00-\x7F]/g, ch => `\\U+${ch.codePointAt(0).toString(16).padStart(4, '0').toUpperCase()}`)
  return `0\nTEXT\n8\n${layer}\n10\n${f(x)}\n20\n${f(y)}\n30\n0\n40\n${height}\n1\n${safe}\n`
}

function piecePolygonLocal(p) {
  if (Array.isArray(p.polygon) && p.polygon.length > 2) return p.polygon.map(pt => [pt.x, pt.y])
  const w = p.origX, h = p.origY
  return [[0, 0], [w, 0], [w, h], [0, h]]
}

const parsed = new WeakMap()
function contourOf(detail) {
  if (!detail?.contour) return null
  if (typeof detail.contour !== 'string') return detail.contour
  if (parsed.has(detail)) return parsed.get(detail)
  let c
  try { c = JSON.parse(detail.contour) } catch { c = null }
  parsed.set(detail, c)
  return c
}

// порядок слоёв: лист, деталь, вырезы, пазы, отверстия в пласть, в торец, кромка, подписи
function layerRank(name) {
  if (name === 'sheet') return 0
  if (name === 'detal') return 1
  if (name === 'vyrez') return 2
  if (name.startsWith('PAZ_')) return 3
  if (name.startsWith('D')) return 4
  if (name.startsWith('TOREC_')) return 5
  if (name === 'kromka') return 6
  if (name === NAME_LAYER) return 7
  return 8
}
function layerColor(name) {
  return [7, 7, 6, 30, 1, 5, 3, 8, 8][layerRank(name)]   // ACI: белый, пурпурный, оранжевый, красный, синий, зелёный, серый
}
const nums = name => (name.match(/-?\d+(?:\.\d+)?/g) || []).map(Number)

export function buildNestingDxf(sheetsData, order, details = [], labelMode = 'name') {
  const sheetWAll = Number(order.sheet_width) || 0
  const sheetLAll = Number(order.sheet_length) || 0
  const marginLAll = Number(order.margin_left) || 0
  const marginBAll = Number(order.margin_bottom) || 0
  const thickAll = Number(order.material_thickness) || 0

  const layers = new Map()   // слой -> текст его объектов
  const put = (layer, ent) => layers.set(layer, (layers.get(layer) || '') + ent)
  const poly = (pts, layer) => { for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; put(layer, line(a[0], a[1], b[0], b[1], layer)) } }

  // контур со скруглениями: прямые — отрезками, скругления и дуги — настоящими дугами (а не хордами)
  const shape = (pts, layer) => {
    const els = loopElements(pts)
    if (!els.some(e => e.r)) { poly(pts, layer); return }
    for (const e of els) {
      if (!e.r) { put(layer, line(e.a[0], e.a[1], e.b[0], e.b[1], layer)); continue }
      if (e.sweep > 2 * Math.PI - 1e-6) { put(layer, circle(e.cx, e.cy, e.r, layer)); continue }
      const a0 = Math.atan2(e.a[1] - e.cy, e.a[0] - e.cx), a1 = Math.atan2(e.b[1] - e.cy, e.b[0] - e.cx)
      put(layer, e.ccw ? arc(e.cx, e.cy, e.r, a0, a1, layer) : arc(e.cx, e.cy, e.r, a1, a0, layer))
    }
  }

  let offsetX = 0
  sheetsData.forEach((sheet, si) => {
    // ВАЖНО: тут только sheetWAll — sheetW ниже объявлен через const
    if (si > 0) offsetX += (Number(sheetsData[si - 1].sheetW) || sheetWAll) + GAP_BETWEEN_SHEETS
    // лист-обрезок — со своими размерами и отступом
    const offcut = sheet.stock === 'offcut'
    const sheetW = Number(sheet.sheetW) || sheetWAll, sheetL = Number(sheet.sheetL) || sheetLAll
    const marginL = sheet.marginL ?? marginLAll, marginB = sheet.marginB ?? marginBAll

    // Контур листа целиком (не только рабочая зона — так виднее, где отступы)
    poly([[offsetX, 0], [offsetX + sheetW, 0], [offsetX + sheetW, sheetL], [offsetX, sheetL]], 'sheet')
    put('label', text(offsetX, sheetL + 60, `${offcut ? `Обрезок ${sheetL}x${sheetW}, лист` : 'Лист'} ${si + 1} (${sheet.placed.length} дет.)`, 'label', 50))

    sheet.placed.forEach(p => {
      const baseX = offsetX + marginL + p.x
      const baseY = marginB + p.y
      const detail = details[p.detailIndex]
      const outline = piecePolygonLocal(p)
      shape(outline.map(([x, y]) => [baseX + x, baseY + y]), 'detal')
      placedHoles(p, detail).forEach(hp => shape(hp.map(q => [baseX + q.x, baseY + q.y]), 'vyrez'))

      // кромка по прямым сторонам габарита
      const w = p.origX, h = p.origY, g = EDGE_INSET
      if (p.edgeBottom) put('kromka', line(baseX + g, baseY + g, baseX + w - g, baseY + g, 'kromka'))
      if (p.edgeTop) put('kromka', line(baseX + g, baseY + h - g, baseX + w - g, baseY + h - g, 'kromka'))
      if (p.edgeLeft) put('kromka', line(baseX + g, baseY + g, baseX + g, baseY + h - g, 'kromka'))
      if (p.edgeRight) put('kromka', line(baseX + w - g, baseY + g, baseX + w - g, baseY + h - g, 'kromka'))

      const contour = contourOf(detail)
      if (contour) {
        const panelW = Number(detail.width) || 0, panelH = Number(detail.length) || 0
        const times = placedTurns(p, detail)
        const at = (x, y) => { const q = rotatePointTimes(x, y, panelW, panelH, times); return [baseX + q.x, baseY + q.y] }
        const T = Number(contour.meta?.thickness) || thickAll

        // кромка на фигурных участках контура — по самой линии
        const native = { left: detail.edge_left, right: detail.edge_right, top: detail.edge_top, bottom: detail.edge_bottom }
        contourSegments(contour.vertices).forEach(seg => {
          if (!seg.edge) return
          const side = segmentSide(seg, panelW, panelH)
          if (side && native[side]) return
          for (let k = 0; k + 1 < seg.pts.length; k++) { const a = at(seg.pts[k][0], seg.pts[k][1]), b = at(seg.pts[k + 1][0], seg.pts[k + 1][1]); put('kromka', line(a[0], a[1], b[0], b[1], 'kromka')) }
        })
        // кромка на отдельных участках вырезов
        ;(contour.holes || []).forEach(hh => holeEdgeSegments(hh).forEach(seg => {
          for (let k = 0; k + 1 < seg.pts.length; k++) { const a = at(seg.pts[k][0], seg.pts[k][1]), b = at(seg.pts[k + 1][0], seg.pts[k + 1][1]); put('kromka', line(a[0], a[1], b[0], b[1], 'kromka')) }
        }))

        // пазы лицевой стороны
        getGrooveRects(contour, panelW, panelH, true).forEach(r => {
          const depth = T > 0 ? Math.min(r.depth, T) : r.depth
          poly(r.pts.map(([x, y]) => at(x, y)), `PAZ_W${num(r.width)}_Z${num(depth)}`)
        })

        // присадка лицевой стороны
        getAllDrillPoints(contour, panelW, panelH, true).forEach(pt => {
          const d = pt.d || 8
          if (pt.edge) {
            if (!(pt.depth > 0)) return
            // отверстие в торец: прямоугольник «диаметр × глубина» от кромки вглубь детали
            const nx = -pt.dy, ny = pt.dx, r = d / 2
            const ex = pt.x + pt.dx * pt.depth, ey = pt.y + pt.dy * pt.depth
            poly([at(pt.x + nx * r, pt.y + ny * r), at(ex + nx * r, ey + ny * r), at(ex - nx * r, ey - ny * r), at(pt.x - nx * r, pt.y - ny * r)],
              `TOREC_D${num(d)}_Z${num(pt.depth)}`)
            return
          }
          const depth = T > 0 ? Math.min(pt.depth || T, T) : (pt.depth || 0)
          const c = at(pt.x, pt.y)
          const layer = `D${num(d)}_Z${num(depth)}`
          put(layer, circle(c[0], c[1], d / 2, layer))
        })
      }

      const label = (partLabel(p, details, labelMode) + ` ${Math.round(p.origY)}x${Math.round(p.origX)}`).trim()
      put(NAME_LAYER, text(baseX + outline[0][0] + 10, baseY + outline[0][1] + 10, label, NAME_LAYER, 25))
    })
  })

  const names = [...layers.keys()].sort((a, b) => {
    const ra = layerRank(a), rb = layerRank(b)
    if (ra !== rb) return ra - rb
    const na = nums(a), nb = nums(b)
    for (let i = 0; i < Math.max(na.length, nb.length); i++) { const d = (na[i] ?? 0) - (nb[i] ?? 0); if (d) return d }
    return a < b ? -1 : a > b ? 1 : 0
  })
  const tables = `0\nSECTION\n2\nTABLES\n`
    + `0\nTABLE\n2\nLTYPE\n70\n1\n0\nLTYPE\n2\nCONTINUOUS\n70\n0\n3\nSolid line\n72\n65\n73\n0\n40\n0.0\n0\nENDTAB\n`
    + `0\nTABLE\n2\nLAYER\n70\n${names.length}\n`
    + names.map(n => `0\nLAYER\n2\n${n}\n70\n0\n62\n${layerColor(n)}\n6\nCONTINUOUS\n`).join('')
    + `0\nENDTAB\n0\nENDSEC\n`
  return `${tables}0\nSECTION\n2\nENTITIES\n${names.map(n => layers.get(n)).join('')}0\nENDSEC\n0\nEOF\n`
}
