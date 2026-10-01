// Внутренние вырезы детали (contour.holes) — для карты раскроя и DXF.
//
// Вырез бывает прямоугольным (4 вершины), произвольным (вершины с дугами,
// радиусами, fillet — те же типы, что и у внешнего контура) или круглым.
// Координаты — как у контура: мм, Y вверх, (0,0) — левый нижний угол детали
// в «родной» ориентации (ширина = detail.width по X, длина = detail.length по Y).
//
// placedHoles(p, detail) — те же вырезы в локальных координатах уложенной
// детали (как p.polygon) с учётом поворота на листе 0/90/180/270 — тем же
// rotatePointTimes, что и для присадки и контура.
import { rotatePointTimes } from './drillGeometry'
import { verticesToPolygon, isTurned } from './trueShapeNesting'

// Положение выреза/паза по привязке к сторонам — копия resolvePos из
// ContourEditor.jsx (там она не экспортируется)
function resolvePos(sides, offsets, panelW, panelH, itemW, itemH) {
  let x = (panelW - itemW) / 2, y = (panelH - itemH) / 2
  let w = itemW, h = itemH
  if (sides.includes('left') && sides.includes('right')) {
    x = offsets.left ?? 0
    w = panelW - (offsets.left ?? 0) - (offsets.right ?? 0)
  } else if (sides.includes('left')) x = offsets.left ?? 0
  else if (sides.includes('right')) x = panelW - itemW - (offsets.right ?? 0)
  if (sides.includes('top') && sides.includes('bottom')) {
    y = offsets.bottom ?? 0
    h = panelH - (offsets.bottom ?? 0) - (offsets.top ?? 0)
  } else if (sides.includes('bottom')) y = offsets.bottom ?? 0
  else if (sides.includes('top')) y = panelH - itemH - (offsets.top ?? 0)
  return { x, y, w, h }
}

const CACHE = new Map() // contour JSON + размеры → полигоны вырезов

/** Вырезы детали в «родной» ориентации: массив полигонов [{x, y}] */
export function detailHoles(detail) {
  if (!detail?.contour) return []
  const W = Number(detail.width) || 0, H = Number(detail.length) || 0
  const key = W + '|' + H + '|' + detail.contour
  if (CACHE.has(key)) return CACHE.get(key)
  let out = []
  try {
    const c = typeof detail.contour === 'string' ? JSON.parse(detail.contour) : detail.contour
    out = (c?.holes || []).map(hole => {
      const sides = hole.sides || [], offsets = hole.offsets || {}
      if (hole.type === 'circle') {
        const d = Number(hole.d) || 100
        const pos = resolvePos(sides, offsets, W, H, d, d)
        const cx = pos.x + d / 2, cy = pos.y + d / 2, r = d / 2
        const n = 36
        return Array.from({ length: n }, (_, i) => ({ x: cx + r * Math.cos(2 * Math.PI * i / n), y: cy + r * Math.sin(2 * Math.PI * i / n) }))
      }
      let verts = Array.isArray(hole.vertices) && hole.vertices.length > 2 ? hole.vertices : null
      if (!verts) {
        const hw = hole.hw || 200, hh = hole.hh || 100
        const pos = resolvePos(sides, offsets, W, H, hw, hh)
        verts = [
          { x: pos.x, y: pos.y }, { x: pos.x + pos.w, y: pos.y },
          { x: pos.x + pos.w, y: pos.y + pos.h }, { x: pos.x, y: pos.y + pos.h },
        ]
      }
      // дуги, радиусы, fillet — так же, как у внешнего контура
      return verticesToPolygon(verts).map(([x, y]) => ({ x, y }))
    }).filter(poly => poly.length > 2)
  } catch { out = [] }
  CACHE.set(key, out)
  if (CACHE.size > 300) CACHE.delete(CACHE.keys().next().value)
  return out
}

/** Поворот уложенной детали в шагах по 90° */
export function placedTurns(p, detail) {
  if (p.rotation != null) return Math.round(Number(p.rotation) / 90)
  return isTurned(p, Number(detail?.width) || 0) ? 1 : 0
}

/** Вырезы уложенной детали в её локальных координатах (как p.polygon) */
export function placedHoles(p, detail) {
  const holes = detailHoles(detail)
  if (!holes.length) return []
  const W = Number(detail.width) || 0, H = Number(detail.length) || 0
  const t = placedTurns(p, detail)
  return holes.map(poly => poly.map(pt => rotatePointTimes(pt.x, pt.y, W, H, t)))
}
