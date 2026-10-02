// 3D-модель заказа, импортированного из Базиса: из свойств деталей
// (contour.meta.local / inst) восстанавливаем панели в положении, в каком они
// стоят в изделии. Форма берётся из текущего контура детали — правки в
// редакторе контура видны и в 3D.
import { verticesToPolygon } from './trueShapeNesting.js'
import { detailHoles } from './partHoles.js'

const num = v => Number(v) || 0

/** details — строки order_details или детали формы. -> [{ outline, holes, t, m, des, name, material, size }] */
export function buildModelParts(details) {
  const parts = []
  for (const d of details || []) {
    let c = d.contour
    if (typeof c === 'string') { try { c = JSON.parse(c) } catch { c = null } }
    const meta = c?.meta
    if (!meta?.inst?.length || !meta.local) continue
    const { x0, y0, dx, dy } = meta.local
    const W = meta.turned ? dy : dx, L = meta.turned ? dx : dy
    // координаты редактора (X — ширина, Y — длина) -> система панели в модели
    const toLocal = ([X, Y]) => {
      const x = meta.flipped ? W - X : X
      return meta.turned ? [Y + x0, dy - x + y0] : [x + x0, Y + y0]
    }
    const verts = Array.isArray(c.vertices) && c.vertices.length > 2 ? c.vertices : [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: L }, { x: 0, y: L }]
    const outline = verticesToPolygon(verts).map(toLocal)
    const holes = detailHoles({ width: W, length: L, contour: JSON.stringify({ holes: c.holes || [] }) })
      .map(poly => poly.map(p => toLocal([p.x, p.y])))
    const size = `${Math.round(num(d.w ?? d.length) * 10) / 10}×${Math.round(num(d.h ?? d.width) * 10) / 10}`
    for (const m of meta.inst) {
      parts.push({ outline, holes, t: num(meta.thickness) || 16, m, des: meta.des || '', name: d.name || meta.name || '', material: meta.material || '', product: meta.product || '', size })
    }
  }
  return parts
}

export const hasModel = details => (details || []).some(d => {
  const c = d.contour
  if (!c) return false
  if (typeof c === 'string') return c.includes('"inst"')
  return !!c.meta?.inst?.length
})
