// Фигурный контур и размер детали.
// Контур (contour.vertices) хранится в мм самой детали: X — ширина, Y — длина. Если у детали с фигурным контуром
// поменять длину/ширину в карточке заказа, контур остаётся старого размера — и в раскрой уходит деталь, у которой
// размер один, а форма другая (детали налезают друг на друга). Правило: размер изменили — фигурный контур
// сбрасывается до прямоугольника нового размера, пользователь видит предупреждение и может вернуть как было.
// Присадка, пазы, выемки и вырезы внутри детали не трогаются — их пользователь проверяет сам.
import { verticesToPolygon, hasCustomOutline } from './trueShapeNesting'

const parse = c => {
  if (typeof c !== 'string') return c || null
  try { return JSON.parse(c) } catch { return null }
}
const r1 = v => Math.round(v * 10) / 10

// фигурный ли внешний контур (а не просто прямоугольник): форма из вершин или старый формат «углы»
export function isShapedOutline(contour, width, length) {
  const c = parse(contour)
  if (!c) return false
  if (Object.values(c.corners || {}).some(k => k?.type && k.type !== 'none')) return true
  return hasCustomOutline(c, Number(width) || 0, Number(length) || 0)
}

// прямоугольник width × length; свойства вершин прямоугольного контура (кромка на участке и т.п.) сохраняются
function rectVertices(width, length, old) {
  const pts = [[0, 0], [width, 0], [width, length], [0, length]]
  const keep = Array.isArray(old) && old.length === 4 ? old : null
  return pts.map(([x, y], i) => ({ ...(keep ? keep[i] : {}), x, y, r: 0 }))
}

/**
 * Габарит контура не совпадает с размером детали (больше допуска) — контур остался от другого размера.
 * -> null | { w, l } — габарит контура (ширина, длина), мм
 */
export function contourMismatch(contour, width, length, tol = 2) {
  const c = parse(contour), v = c?.vertices
  const W = Number(width) || 0, L = Number(length) || 0
  if (!Array.isArray(v) || v.length < 3 || !(W > 0) || !(L > 0)) return null
  let poly
  try { poly = verticesToPolygon(v) } catch { return null }
  const pts = (poly || []).map(p => (Array.isArray(p) ? p : [p.x, p.y])).filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]))
  if (pts.length < 3) return null
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1])
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys)
  const bad = Math.abs(x1 - x0 - W) > tol || Math.abs(y1 - y0 - L) > tol || Math.abs(x0) > tol || Math.abs(y0) > tol
  return bad ? { w: r1(x1 - x0), l: r1(y1 - y0) } : null
}

/** Внешний контур — прямоугольник width × length (всё остальное в контуре сохраняется) */
export function resetOutline(contour, width, length) {
  const c = parse(contour) || {}
  const { corners, ...rest } = c          // eslint-disable-line no-unused-vars
  return { ...rest, vertices: rectVertices(Number(width) || 0, Number(length) || 0, null) }
}

/**
 * Правка детали в карточке заказа (detail.w — длина, detail.h — ширина, contour — объект).
 * Размер изменился:
 *  — контур фигурный → сброс до прямоугольника нового размера, reset: true (показать предупреждение);
 *  — контур прямоугольный → его углы просто переезжают на новый размер (иначе старый прямоугольник
 *    считался бы «фигурой» другого размера), без предупреждения.
 * -> { detail, reset }
 */
export function applyResize(prev, next) {
  const c = next?.contour
  if (!prev || !c || typeof c !== 'object') return { detail: next, reset: false }
  if (String(prev.w) === String(next.w) && String(prev.h) === String(next.h)) return { detail: next, reset: false }
  const W = Number(next.h) || 0, L = Number(next.w) || 0
  if (!(W > 0) || !(L > 0)) return { detail: next, reset: false }        // поле стёрто — ждём новое число
  const pW = Number(prev.h) || 0, pL = Number(prev.w) || 0
  if (isShapedOutline(c, pW, pL)) return { detail: { ...next, contour: resetOutline(c, W, L) }, reset: true }
  if (!Array.isArray(c.vertices)) return { detail: next, reset: false }
  return { detail: { ...next, contour: { ...c, vertices: rectVertices(W, L, c.vertices) } }, reset: false }
}
