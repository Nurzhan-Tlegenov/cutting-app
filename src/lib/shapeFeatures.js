// Элементы фигурной детали для «По габаритам → Выборочно»: что из формы резать сразу, а что убрать в габарит (потом).
// Силуэт детали (контур со скруглениями, косыми срезами, вырезами на краю — parsePolygonFromDetail) разбирается на
// участки, которые уходят с габаритного прямоугольника: каждый — свой элемент (скругление угла, косой срез, вырез на
// краю, фигурный край). Внутренние сквозные вырезы — отдельные элементы. «Убрать в габарит» участок контура — заменить
// его краем габарита (углом или прямой); внутренний вырез — не резать. Всё в «родных» координатах детали:
// x — ширина W, y — длина H, (0, 0) — левый нижний угол, вид на лицевую пласть (как на бирке).
import { parsePolygonFromDetail } from './trueShapeNesting'
import { detailHoles } from './partHoles'

const E = 0.3
const r1 = v => Math.round(v * 10) / 10
const contourObj = d => { const c = d?.contour; if (!c) return null; if (typeof c !== 'string') return c; try { return JSON.parse(c) } catch { return null } }
const asStr = d => ({ ...d, contour: typeof d.contour === 'string' ? d.contour : d.contour ? JSON.stringify(d.contour) : null })

const cache = new WeakMap()

/**
 * -> { W, H, sil: [[x, y]], feats: [{ id, kind: 'corner' | 'edge' | 'shape' | 'hole', title, from, to, bb, hole? }] } | null
 * from / to — индексы вершин силуэта (участок контура from…to по ходу), bb — габарит элемента.
 */
export function shapeFeatures(d) {
  if (!d) return null
  const hit = cache.get(d)
  if (hit && hit.src === d.contour) return hit.val
  const val = compute(d)
  cache.set(d, { src: d.contour, val })
  return val
}

function compute(d) {
  let pr
  try { pr = parsePolygonFromDetail(asStr(d)) } catch { pr = null }
  const W = Number(d.width) || 0, H = Number(d.length) || 0
  const c = contourObj(d) || {}
  const holes = []
  ;(c.holes || []).forEach((h, i) => {
    if (h?.type === 'pocket') return                            // выемка — не сквозной вырез
    let poly
    try { poly = detailHoles({ width: W, length: H, contour: JSON.stringify({ holes: [h] }) })[0] } catch { poly = null }
    if (!poly) return
    const pts = poly.map(q => [q.x, q.y]), xs = pts.map(q => q[0]), ys = pts.map(q => q[1])
    const bb = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
    const edge = bb.x0 <= E || bb.y0 <= E || bb.x1 >= W - E || bb.y1 >= H - E
    holes.push({ i, pts, bb, edge, circle: h.type === 'circle' })
  })
  const inner = holes.filter(h => !h.edge)
  if (!pr?.custom && !inner.length) return null
  const sil = (pr?.polygon || [[0, 0], [W, 0], [W, H], [0, H]]).map(q => (Array.isArray(q) ? [q[0], q[1]] : [q.x, q.y]))
  const of = pr?.custom ? outlineFeats(sil, W, H) : { feats: [], start: 0 }
  const feats = of.feats
  inner.forEach(h => {
    const w = h.bb.x1 - h.bb.x0, l = h.bb.y1 - h.bb.y0
    feats.push({ id: 'h' + h.i, kind: 'hole', hole: h.i, bb: h.bb, title: h.circle ? `Внутренний вырез Ø${r1(w)}` : `Внутренний вырез ${r1(l)} × ${r1(w)}` })
  })
  // вырезы на краю (инструмент «Вырезы»): относятся к участку контура, который их накрывает
  const edgeHoles = holes.filter(h => h.edge)
  return { W, H, sil, feats, edgeHoles, start: of.start }
}

const on = (x, y, W, H) => Math.abs(x) <= E || Math.abs(y) <= E || Math.abs(x - W) <= E || Math.abs(y - H) <= E
const segOnBorder = (a, b, W, H) => (Math.abs(a[0]) <= E && Math.abs(b[0]) <= E) || (Math.abs(a[0] - W) <= E && Math.abs(b[0] - W) <= E)
  || (Math.abs(a[1]) <= E && Math.abs(b[1]) <= E) || (Math.abs(a[1] - H) <= E && Math.abs(b[1] - H) <= E)
/** положение точки на краю габарита: от (0, 0) против часовой — низ, право, верх, лево */
const perim = ([x, y], W, H) => (Math.abs(y) <= E ? x : Math.abs(x - W) <= E ? W + y : Math.abs(y - H) <= E ? W + H + (W - x) : 2 * W + H + (H - y))
const sideOf = ([x, y], W, H) => [Math.abs(y) <= E && 'b', Math.abs(x - W) <= E && 'r', Math.abs(y - H) <= E && 't', Math.abs(x) <= E && 'l'].filter(Boolean)
const SIDE = { b: 'нижняя сторона', r: 'правая сторона', t: 'верхняя сторона', l: 'левая сторона' }
const CORNER = { bl: 'левый нижний угол', br: 'правый нижний угол', tr: 'правый верхний угол', tl: 'левый верхний угол' }
const area = pts => pts.reduce((a, p, i) => { const q = pts[(i + 1) % pts.length]; return a + p[0] * q[1] - q[0] * p[1] }, 0) / 2

function outlineFeats(sil, W, H) {
  const n = sil.length
  const segB = sil.map((p, i) => segOnBorder(p, sil[(i + 1) % n], W, H))
  if (!segB.some(Boolean)) return { start: 0, feats: [{ id: 'o0', kind: 'shape', from: 0, to: 0, all: true, bb: { x0: 0, y0: 0, x1: W, y1: H }, title: 'Фигурный контур целиком' }] }
  const start = segB.indexOf(true)
  const feats = []
  let k = 0
  while (k < n) {
    const i = (start + k) % n
    if (segB[i]) { k++; continue }
    const from = i
    let m = k
    while (m < n && !segB[(start + m) % n]) m++
    const to = (start + m) % n
    const run = []
    for (let t = k; t <= m; t++) run.push(sil[(start + t) % n])
    k = m
    const S = run[0], T = run[run.length - 1]
    if (!on(S[0], S[1], W, H) || !on(T[0], T[1], W, H)) continue
    const xs = run.map(q => q[0]), ys = run.map(q => q[1])
    const bb = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
    const sS = sideOf(S, W, H), sT = sideOf(T, W, H), same = sS.find(s => sT.includes(s))
    let title, kind
    if (same) {
      kind = 'edge'
      const along = same === 'b' || same === 't' ? bb.x1 - bb.x0 : bb.y1 - bb.y0
      const deep = same === 'b' ? bb.y1 : same === 't' ? H - bb.y0 : same === 'l' ? bb.x1 : W - bb.x0
      title = `Вырез на краю ${r1(along)} × ${r1(deep)} · ${SIDE[same]}`
    } else {
      kind = 'corner'
      const cx = bb.x0 <= E ? 'l' : bb.x1 >= W - E ? 'r' : '', cy = bb.y0 <= E ? 'b' : bb.y1 >= H - E ? 't' : ''
      const where = CORNER[cy + cx] || 'угол'
      const w = bb.x1 - bb.x0, l = bb.y1 - bb.y0
      if (run.length === 2) title = `Косой срез ${r1(l)} × ${r1(w)} · ${where}`
      else if (run.length > 4 && Math.abs(w - l) < Math.max(1, 0.05 * Math.max(w, l))) title = `Скругление R${r1(w)} · ${where}`
      else title = `Фигурный угол ${r1(l)} × ${r1(w)} · ${where}`
    }
    feats.push({ id: 'o' + feats.length, kind, from, to, bb, title })
  }
  return { feats, start }
}

/**
 * Силуэт, которым деталь режется, когда элементы off убраны в габарит: участки контура заменены краем габарита.
 * -> [[x, y]] в «родных» координатах
 */
export function cutSilhouette(d, off) {
  const f = shapeFeatures(d)
  if (!f) return null
  const { W, H, sil } = f
  const offSet = new Set(off || [])
  const outl = f.feats.filter(x => x.kind !== 'hole' && offSet.has(x.id))
  if (!outl.length) return sil
  if (outl.some(x => x.all)) return [[0, 0], [W, 0], [W, H], [0, H]]
  const n = sil.length, P = 2 * (W + H), ccw = area(sil) > 0
  const CORN = [[0, [0, 0]], [W, [W, 0]], [W + H, [W, H]], [2 * W + H, [0, H]]]
  const skip = new Map(outl.map(x => [x.from, x]))
  const out = []
  // обход — от начала отрезка по краю габарита: эта вершина не лежит внутри ни одного участка
  let at = f.start, guard = 0
  do {
    const x = skip.get(at)
    if (!x) { out.push(sil[at]); at = (at + 1) % n; continue }
    const S = sil[x.from], T = sil[x.to]
    out.push(S)
    const tS = perim(S, W, H)
    let tT = perim(T, W, H)
    if (ccw) { if (tT < tS) tT += P; CORN.forEach(([t, q]) => { for (const tt of [t, t + P]) if (tt > tS + E && tt < tT - E) out.push(q) }) }
    else {
      if (tT > tS) tT -= P
      ;[...CORN].reverse().forEach(([t, q]) => { for (const tt of [t, t - P]) if (tt < tS - E && tt > tT + E) out.push(q) })
    }
    at = x.to
  } while (at !== f.start && ++guard < n * 2)
  // соседние точки-дубли
  return out.filter((q, j) => { const p = out[(j + out.length - 1) % out.length]; return Math.hypot(q[0] - p[0], q[1] - p[1]) > 1e-6 })
}

/** Внутренние и краевые вырезы, которые при этих убранных элементах не режутся: индексы contour.holes */
export function offHoles(d, off) {
  const f = shapeFeatures(d)
  if (!f) return []
  const offSet = new Set(off || [])
  const res = f.feats.filter(x => x.kind === 'hole' && offSet.has(x.id)).map(x => x.hole)
  const outl = f.feats.filter(x => x.kind !== 'hole' && offSet.has(x.id))
  const hit = (a, b) => a.x0 < b.x1 + E && b.x0 < a.x1 + E && a.y0 < b.y1 + E && b.y0 < a.y1 + E
  f.edgeHoles.forEach(h => { if (outl.some(x => x.all || hit(x.bb, h.bb))) res.push(h.i) })
  return res
}

/** Контур детали для раскроя с убранными элементами (JSON-строка) — силуэт вершинами, без убранных вырезов */
export function cutContour(d, off) {
  const c = contourObj(d) || {}
  const sil = cutSilhouette(d, off)
  const gone = new Set(offHoles(d, off))
  const out = { ...c, holes: (c.holes || []).filter((_, i) => !gone.has(i)) }
  if (sil) out.vertices = sil.map(([x, y]) => ({ x, y }))
  return JSON.stringify(out)
}

/** Элементы контура (без внутренних вырезов) — «по габариту» целиком */
export const outlineIds = d => (shapeFeatures(d)?.feats || []).filter(x => x.kind !== 'hole').map(x => x.id)
