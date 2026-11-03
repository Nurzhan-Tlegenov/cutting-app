// Угол укладки — от какого угла листа идёт раскрой (там же ноль программы ЧПУ). Лист упирают в упоры этого угла:
// детали прижаты к нему, обрезок — в противоположной стороне. По умолчанию — левый нижний.
//
// Сами алгоритмы раскроя всегда укладывают от левого нижнего угла. Другой угол — зеркало готовой раскладки:
//   правый верхний — поворот всей раскладки на 180° (каждая деталь +180°, точно для любой формы);
//   левый верхний / правый нижний — зеркало по одной оси. Прямоугольная деталь при этом просто переезжает (её зеркало —
//   она же). Фигурную деталь зеркалить нельзя (вышла бы зеркальная деталь), поэтому раскрой получает её зеркальную
//   копию, а после зеркала раскладки на листе оказывается настоящая деталь — подбирается её поворот (prepCorner / flipResult).
// Группы деталей с общей текстурой переезжают блоком — порядок деталей внутри блока (стык текстуры) не меняется.
import { mirrorContour } from './mirrorDetail'
import { roughShapePolygons, hasCustomOutline } from './trueShapeNesting'
import { detailHoles, placedHoles, placedTurns } from './partHoles'

export const CORNERS = [['bl', 'Левый нижний'], ['tl', 'Левый верхний'], ['tr', 'Правый верхний'], ['br', 'Правый нижний']]
export const cornerOf = v => (CORNERS.some(([k]) => k === v) ? v : 'bl')
export const cornerLabel = v => CORNERS.find(([k]) => k === cornerOf(v))[1]
const fxOf = c => c === 'tr' || c === 'br'           // зеркало по X (угол справа)
const fyOf = c => c === 'tl' || c === 'tr'           // зеркало по Y (угол сверху)

/** Сдвиг нуля программы ЧПУ: ноль — в углу укладки, оси станка как есть (X вправо, Y от оператора) */
export function cornerShift(corner, sheetW, sheetL) {
  const c = cornerOf(corner)
  return { dx: fxOf(c) ? -(Number(sheetW) || 0) : 0, dy: fyOf(c) ? -(Number(sheetL) || 0) : 0 }
}

const parse = d => { try { return typeof d?.contour === 'string' ? JSON.parse(d.contour) : d?.contour || null } catch { return null } }
// фигурная деталь: свой контур или вырезы (по вырезам ложатся вложенные детали — им важна сторона)
function shaped(d) {
  const c = parse(d)
  if (!c) return false
  return hasCustomOutline(c, Number(d.width) || 0, Number(d.length) || 0) || detailHoles(d).length > 0
}
const oneAxis = c => fxOf(c) !== fyOf(c)

/** Параметры раскроя под угол: фигурные детали — зеркальной копией (только при зеркале по одной оси), «Продолжить» —
 *  раскладка экрана переводится обратно в укладку от левого нижнего. -> params (тот же объект, если угол левый нижний) */
export function prepCorner(params, corner) {
  const c = cornerOf(corner)
  if (c === 'bl') return params
  const details = cornerDetails(params.details, c)
  const out = { ...params, details }
  if (Array.isArray(params.seed?.sheets)) {
    const back = flipSheets(params.seed.sheets, params.details, details, c, metaOf(params))
    if (back) out.seed = { ...params.seed, sheets: back }
    else delete out.seed
  }
  return out
}
/** Детали, которые получает раскрой при угле c: при зеркале по одной оси фигурные — зеркальной копией */
export const cornerDetails = (details, c) => (oneAxis(cornerOf(c))
  ? details.map(d => (shaped(d) ? { ...d, contour: JSON.stringify(mirrorContour(parse(d), Number(d.width) || 0)) } : d))
  : details)
const metaOf = params => ({
  usableX: (Number(params.sheetW) || 0) - (Number(params.marginL) || 0) - (Number(params.marginR) || 0),
  usableY: (Number(params.sheetL) || 0) - (Number(params.marginT) || 0) - (Number(params.marginB) || 0),
})

/** Результат раскроя (от левого нижнего) -> раскладка от угла corner; details — настоящие детали заказа. Не вышло — null */
export function flipResult(res, details, corner) {
  const c = cornerOf(corner)
  if (!res?.sheets || c === 'bl') return res
  const sheets = flipSheets(res.sheets, cornerDetails(details, c), details, c, { usableX: res.usableX, usableY: res.usableY })
  if (!sheets) return null
  const out = { ...res, sheets, corner: c }
  if (Array.isArray(res.rawSheets)) delete out.rawSheets
  return out
}

// поворот подписей кромок на k четвертей (как turnPlaced в beamSawLabels)
function turnEdges(p, k) {
  const q = { ...p }
  for (let i = 0; i < ((k % 4) + 4) % 4; i++) [q.edgeTop, q.edgeRight, q.edgeBottom, q.edgeLeft] = [q.edgeLeft, q.edgeTop, q.edgeRight, q.edgeBottom]
  return q
}
// контур + вырезы детали в положении t (локально, в габарите) — для сравнения форм
function shapeAt(d, t, p) {
  const outl = roughShapePolygons(d)[t * 90].map(([x, y]) => ({ x, y }))
  return [outl, ...placedHoles({ ...p, rotation: t * 90 }, d)]
}
function segD(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy
  const t = l ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l)) : 0
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy)
}
const onLoop = (p, L, tol) => L.some((a, i) => segD(p, a, L[(i + 1) % L.length]) <= tol)
// одна и та же форма (точки каждой — на контуре другой; вырезы — попарно)
function sameShape(A, B, tol = 0.6) {
  if (A.length !== B.length) return false
  const used = new Set()
  return A.every(la => {
    const j = B.findIndex((lb, k) => !used.has(k) && la.every(p => onLoop(p, lb, tol)) && lb.every(p => onLoop(p, la, tol)))
    if (j < 0) return false
    used.add(j); return true
  })
}

/** Листы -> зеркало раскладки по углу c (отражение — само себе обратное: годится и туда, и обратно). from — детали, как
 *  они лежат на листах сейчас, to — детали, которые должны лечь (настоящие или зеркальные копии). Не вышло — null */
export function flipSheets(sheets, from, to, c, meta) {
  const details = to
  const fx = fxOf(c), fy = fyOf(c)
  if (!fx && !fy) return sheets
  const out = []
  for (const sh of sheets) {
    if (!sh) { out.push(sh); continue }
    const R = Number(sh.usableX ?? meta.usableX) || 0, V = Number(sh.usableY ?? meta.usableY) || 0
    const mx = (x, w) => (fx ? R - x - w : x), my = (y, h) => (fy ? V - y - h : y)
    const rect = r => ({ ...r, x: mx(r.x, r.w), y: my(r.y, r.h) })
    // группы с общей текстурой — блоком (габарит блока зеркалится, детали внутри едут вместе)
    const groupOf = p => { const g = details?.[p.detailIndex]?.part_group; return typeof g === 'string' && g.trim() ? g.trim() : '' }
    const blocks = new Map()
    for (const p of sh.placed || []) {
      const g = groupOf(p)
      if (!g) continue
      const b = blocks.get(g) || { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, n: 0 }
      b.x0 = Math.min(b.x0, p.x); b.y0 = Math.min(b.y0, p.y); b.x1 = Math.max(b.x1, p.x + p.origX); b.y1 = Math.max(b.y1, p.y + p.origY); b.n++
      blocks.set(g, b)
    }
    const placed = []
    for (const p of sh.placed || []) {
      const g = groupOf(p), b = g && blocks.get(g)
      if (b && b.n > 1) {
        const dx = mx(b.x0, b.x1 - b.x0) - b.x0, dy = my(b.y0, b.y1 - b.y0) - b.y0
        placed.push({ ...p, x: p.x + dx, y: p.y + dy })
        continue
      }
      const W = Number(p.origX) || 0, H = Number(p.origY) || 0
      const q = { ...p, x: mx(p.x, W), y: my(p.y, H) }
      const mp = v => ({ x: fx ? W - v.x : v.x, y: fy ? H - v.y : v.y })
      if (Array.isArray(p.polygon)) { q.polygon = p.polygon.map(mp); if (fx !== fy) q.polygon.reverse() }
      const d = details?.[p.detailIndex]
      if (d && shaped(d)) {
        const t0 = ((placedTurns(p, d) % 4) + 4) % 4
        let t
        if (fx && fy) t = (t0 + 2) % 4                // 180°: та же деталь, повёрнутая
        else {                                         // зеркало по оси: какой поворот настоящей детали даёт эту форму
          const f = from?.[p.detailIndex] || d
          const want = [p.polygon?.length ? q.polygon : shapeAt(f, t0, p)[0].map(mp), ...placedHoles(p, f).map(h => h.map(mp))]
          t = [0, 1, 2, 3].filter(k => k % 2 === t0 % 2).find(k => sameShape(want, shapeAt(d, k, p)))
          if (t == null) return null
        }
        q.rotation = t * 90; q.rotated = t % 2 === 1
        Object.assign(q, turnEdges(q, t - t0))
      }                                                // прямоугольник — та же деталь в том же положении, на новом месте
      placed.push(q)
    }
    const o = { ...sh, placed }
    if (Array.isArray(sh.freeRects)) o.freeRects = sh.freeRects.map(rect)
    if (Array.isArray(sh.manualOffcuts)) o.manualOffcuts = sh.manualOffcuts.map(rect)
    if (Array.isArray(sh.offcuts)) o.offcuts = sh.offcuts.map(r => (r && r.w != null ? rect(r) : r))
    out.push(o)
  }
  return out
}

/** Раскладка от угла a -> от угла b одним зеркалом: какой «угол» его задаёт (тр — поворот на 180°, тл / пн — зеркало по оси) */
export function cornerBetween(a, b) {
  const fx = fxOf(cornerOf(a)) !== fxOf(cornerOf(b)), fy = fyOf(cornerOf(a)) !== fyOf(cornerOf(b))
  return fx ? (fy ? 'tr' : 'br') : (fy ? 'tl' : 'bl')
}
/** Готовые листы (от угла from) -> от угла to без пересчёта; фигурную деталь не отзеркалить — null */
export function moveCorner(sheets, details, from, to, meta) {
  const c = cornerBetween(from, to)
  return c === 'bl' ? sheets : flipSheets(sheets, details, details, c, meta)
}
