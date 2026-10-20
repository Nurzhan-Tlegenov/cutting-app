/**
 * Управляющая программа (G-код) для фрезера с ЧПУ по принятой карте раскроя.
 *
 * Координаты — как на карте раскроя и в DXF: X — ширина листа, Y — длина, (0,0) — левый нижний
 * угол листа (+ «начало обработки» из настроек станка). Z = 0 — жертвенный стол, Z растёт вверх:
 * верх материала — Z = толщина, сквозной рез — чуть ниже нуля (заглубление в стол).
 *
 * Что обрабатывается (только лицевая сторона — как на карте раскроя):
 *   отверстия в пласть, пазы, выборки (выемки), сквозные вырезы, контур детали.
 * Отверстия в торец и обработка с изнанки на раскроечном станке не делаются — о них предупреждение.
 *
 * Порядок: сначала всё «внутри» деталей (отверстия → пазы → выборки), затем вырезы и в самом конце
 * контуры деталей (мелкие — первыми, пока лист держит вакуум). Инструмент меняется только когда нужен другой.
 */
import { getAllDrillPoints, getGrooveRects, rotatePointTimes } from './drillGeometry'
import { detailHoles, placedTurns } from './partHoles'
import { smoothLoop, arcRuns } from './arcFit'
import { postView } from './postTools'

const EPS = 0.05
const ROUGH_ALLOWANCE = 2        // черновые проходы выборки не доходят до контура на 2 мм — их подчищает обход по периметру
const num = v => String(Math.round((Number(v) || 0) * 10) / 10)
const n0 = v => { const x = Number(String(v ?? '').replace(',', '.')); return isFinite(x) ? x : 0 }

// ─── разбор детали ──────────────────────────────────────────────────────────
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

export const holeKey = (d, depth, T) => `D${num(d)}_Z${num(Math.min(depth > 0 ? depth : T, T))}`
export const pocketKey = depth => `Z${num(depth)}`
export const grooveKey = (width, depth) => `W${num(width)}_Z${num(depth)}`
/** Настройка слоя пазов: своя, а если не задана — общая для всех пазов */
export const grooveOpFor = (ops, key) => ({ ...ops?.groove, ...Object.fromEntries(Object.entries(ops?.grooves?.[key] || {}).filter(([, v]) => v !== '' && v != null)) })

function bboxOf(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [x, y] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
  return { x0, y0, x1, y1 }
}
const isAxisRect = (pts, bb) => pts.length === 4 && pts.every(([x, y]) => (Math.abs(x - bb.x0) < EPS || Math.abs(x - bb.x1) < EPS) && (Math.abs(y - bb.y0) < EPS || Math.abs(y - bb.y1) < EPS))

/** Что постпроцессор не выводит в программу (вкладка «Обработка», ops.skip):
 *  contour — вырезы внутренние и наружные: деталь режется прямоугольником своего габарита;
 *  face — пазы и выемки с лицевой стороны; holes — все отверстия (присадка). */
export const skipOf = ops => ({ contour: !!ops?.skip?.contour, face: !!ops?.skip?.face, holes: !!ops?.skip?.holes })

/** Всё, что надо обработать на уложенной детали p — в её локальных координатах на листе (как p.polygon), мм, Y вверх.
 *  skip — см. skipOf; без него — вся обработка детали (так считает статистика и цена). */
export function partFeatures(p, detail, T, skip = null) {
  let outline = Array.isArray(p.polygon) && p.polygon.length > 2 ? p.polygon.map(q => [q.x, q.y]) : [[0, 0], [p.origX, 0], [p.origX, p.origY], [0, p.origY]]
  const sk = skip || {}
  let boxed = false
  if (sk.contour) {
    const bb = bboxOf(outline)
    if (!isAxisRect(outline, bb)) { outline = [[bb.x0, bb.y0], [bb.x1, bb.y0], [bb.x1, bb.y1], [bb.x0, bb.y1]]; boxed = true }
  }
  const f = { outline, boxed, pw: p.origX, ph: p.origY, cutouts: [], pockets: [], grooves: [], holes: [], skipped: { edge: 0, back: 0, odd: 0 } }
  const contour = contourOf(detail)
  if (!contour) return f
  const W = Number(detail.width) || 0, H = Number(detail.length) || 0
  const times = placedTurns(p, detail)
  const at = (x, y) => { const q = rotatePointTimes(x, y, W, H, times); return [q.x, q.y] }
  const open = bb => ({ l: bb.x0 <= EPS, r: bb.x1 >= f.pw - EPS, b: bb.y0 <= EPS, t: bb.y1 >= f.ph - EPS })

  ;(contour.holes || []).forEach(hole => {
    const poly = detailHoles({ width: W, length: H, contour: JSON.stringify({ holes: [hole] }) })[0]
    if (!poly) return
    const pts = poly.map(q => at(q.x, q.y)), bb = bboxOf(pts)
    if (hole.type === 'pocket') {
      if (sk.face) return
      if (hole.face === 'back') { f.skipped.back++; return }
      if (!isAxisRect(pts, bb)) { f.skipped.odd++; return }
      f.pockets.push({ ...bb, open: open(bb), depth: Number(hole.depth) || 10 })
      return
    }
    if (sk.contour) return
    // вырез, выходящий на край детали, уже вошёл в её контур — отдельно не режем
    if (!pts.every(q => pointInPoly(q, outline) && distToLoop(q, outline) > 0.3)) return
    if (hole.type === 'circle') f.cutouts.push({ circle: { cx: (bb.x0 + bb.x1) / 2, cy: (bb.y0 + bb.y1) / 2, r: (bb.x1 - bb.x0) / 2 } })
    else f.cutouts.push({ pts })
  })
  if (!sk.face) (contour.grooves || []).forEach(g => { if (g.face === 'back') f.skipped.back++ })
  if (!sk.face) getGrooveRects(contour, W, H, true).forEach(r => {
    const bb = bboxOf(r.pts.map(([x, y]) => at(x, y)))
    f.grooves.push({ ...bb, open: open(bb), depth: r.depth || 0, width: r.width || Math.min(bb.x1 - bb.x0, bb.y1 - bb.y0) })
  })
  if (sk.holes) return f
  ;(contour.drillings || []).forEach(dr => { if (dr.installed !== false && dr.kind !== 'edge' && dr.face === 'back') f.skipped.back++ })
  getAllDrillPoints(contour, W, H, true).forEach(pt => {
    if (pt.edge) { f.skipped.edge++; return }
    const q = at(pt.x, pt.y), d = pt.d || 8, depth = pt.depth > 0 ? pt.depth : T
    f.holes.push({ x: q[0], y: q[1], d, depth, key: holeKey(d, depth, T) })
  })
  return f
}

/** Слои обработки, которые есть на листах — для вкладки «Обработка контуров» */
export function collectLayers(sheets, details, T, skip = null) {
  const holes = new Map(), pockets = new Map(), grooves = new Map()
  const out = { holes: [], pockets: [], grooveLayers: [], grooves: 0, cutouts: 0, parts: 0, edgeHoles: 0, backOps: 0, oddPockets: 0 }
  for (const sh of sheets || []) for (const p of sh.placed || []) {
    const f = partFeatures(p, details?.[p.detailIndex], T, skip)
    out.parts++; out.cutouts += f.cutouts.length; out.grooves += f.grooves.length
    out.edgeHoles += f.skipped.edge; out.backOps += f.skipped.back; out.oddPockets += f.skipped.odd
    for (const h of f.holes) {
      const cur = holes.get(h.key) || { key: h.key, d: h.d, depth: Math.min(h.depth, T), through: h.depth >= T - EPS, count: 0 }
      cur.count++; holes.set(h.key, cur)
    }
    for (const g of f.grooves) {
      const key = grooveKey(g.width, g.depth || T)
      const cur = grooves.get(key) || { key, width: g.width, depth: g.depth || T, count: 0 }
      cur.count++; grooves.set(key, cur)
    }
    for (const k of f.pockets) {
      const key = pocketKey(k.depth)
      const cur = pockets.get(key) || { key, depth: k.depth, count: 0 }
      cur.count++; pockets.set(key, cur)
    }
  }
  out.holes = [...holes.values()].sort((a, b) => a.d - b.d || a.depth - b.depth)
  out.pockets = [...pockets.values()].sort((a, b) => a.depth - b.depth)
  out.grooveLayers = [...grooves.values()].sort((a, b) => a.width - b.width || a.depth - b.depth)
  return out
}

const toolById = (cnc, id) => (cnc.tools || []).find(t => t.id === id) || null
/** Инструмент слоя отверстий: назначенный, а если не назначали — сверло того же диаметра */
export function holeToolFor(layer, cnc) {
  const o = cnc.ops?.holes?.[layer.key]
  if (o?.tool === 'none') return null
  const d = n0(o?.d) || layer.d
  if (o?.tool) { const t = toolById(cnc, o.tool); return t && n0(t.d) > d + EPS ? null : t }   // инструмент больше отверстия — не годится
  const drill = (cnc.tools || []).find(t => t.type === 'drill' && Math.abs(n0(t.d) - d) < EPS)
  if (drill) return drill
  // сверла нужного диаметра нет — отверстие делает фреза меньшего диаметра: вход по спирали, затем разбивка до диаметра.
  // Берётся самая крупная фреза, у которой есть место на спираль (хотя бы на 1 мм меньше отверстия), иначе — любая меньше
  const mills = (cnc.tools || []).filter(t => t.type === 'mill' && n0(t.d) > 0 && n0(t.d) < d - EPS).sort((a, b) => n0(b.d) - n0(a.d))
  return mills.find(t => n0(t.d) <= d - 1 + EPS) || mills[0] || null
}

// ─── геометрия ──────────────────────────────────────────────────────────────
const signedArea = P => { let a = 0; for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; a += p[0] * q[1] - q[0] * p[1] } return a / 2 }
function pointInPoly([x, y], P) {
  let inside = false
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const [xi, yi] = P[i], [xj, yj] = P[j]
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
}
function distToLoop(p, P) { let d = Infinity; for (let i = 0; i < P.length; i++) d = Math.min(d, segDist(p, P[i], P[(i + 1) % P.length])); return d }
function dedupe(P) {
  const out = []
  for (const q of P) { const l = out[out.length - 1]; if (!l || Math.hypot(q[0] - l[0], q[1] - l[1]) > 1e-6) out.push([q[0], q[1]]) }
  while (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= 1e-6) out.pop()
  return out
}
function segX(a, b, c, d) {
  const r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]]
  const den = r[0] * s[1] - r[1] * s[0]
  if (Math.abs(den) < 1e-12) return null
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den, u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den
  if (t <= 1e-9 || t >= 1 - 1e-9 || u <= 1e-9 || u >= 1 - 1e-9) return null
  return [a[0] + t * r[0], a[1] + t * r[1]]
}
// самопересекающийся контур -> простые петли
function splitLoops(P, depth = 0) {
  const n = P.length
  if (n < 3) return []
  if (depth < 40) for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
    if (i === 0 && j === n - 1) continue
    const x = segX(P[i], P[(i + 1) % n], P[j], P[(j + 1) % n])
    if (!x) continue
    const A = [...P.slice(0, i + 1), x, ...P.slice(j + 1)], B = [x, ...P.slice(i + 1, j + 1)]
    return [...splitLoops(dedupe(A), depth + 1), ...splitLoops(dedupe(B), depth + 1)]
  }
  return [P]
}
/**
 * Эквидистанта замкнутого контура: delta > 0 — наружу, delta < 0 — внутрь. Острые углы остаются острыми.
 * Возвращает контур (против часовой) или null, если инструмент туда не проходит.
 */
export function offsetLoop(poly, delta) {
  let P = dedupe(poly)
  if (P.length < 3) return null
  if (signedArea(P) < 0) P.reverse()
  if (Math.abs(delta) < 1e-9) return P
  const n = P.length, out = []
  const nrm = (a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [dy / l, -dx / l] }
  for (let i = 0; i < n; i++) {
    const prev = P[(i - 1 + n) % n], cur = P[i], next = P[(i + 1) % n]
    const n1 = nrm(prev, cur), n2 = nrm(cur, next)
    const cos = n1[0] * n2[0] + n1[1] * n2[1]
    if (cos > 1 - 1e-6) { out.push([cur[0] + n1[0] * delta, cur[1] + n1[1] * delta]); continue }
    const k = 1 + cos                                   // вершина эквидистанты: cur + (n1 + n2) * delta / (1 + cos)
    if (k < 0.12) { out.push([cur[0] + n1[0] * delta, cur[1] + n1[1] * delta], [cur[0] + n2[0] * delta, cur[1] + n2[1] * delta]); continue }
    out.push([cur[0] + (n1[0] + n2[0]) * delta / k, cur[1] + (n1[1] + n2[1]) * delta / k])
  }
  const need = Math.abs(delta) - 0.02
  const ok = L => signedArea(L) > 1e-6 && L.every((q, i) => {
    const m = [(q[0] + L[(i + 1) % L.length][0]) / 2, (q[1] + L[(i + 1) % L.length][1]) / 2]
    return distToLoop(q, P) >= need && distToLoop(m, P) >= need && pointInPoly(m, P) === (delta < 0)
  })
  const loops = splitLoops(dedupe(out)).filter(ok).sort((a, b) => signedArea(b) - signedArea(a))
  return loops[0] || null
}
const circleLoop = (cx, cy, r) => { const n = Math.max(24, Math.ceil(2 * Math.PI * r / 1.5)); return Array.from({ length: n }, (_, i) => [cx + r * Math.cos(2 * Math.PI * i / n), cy + r * Math.sin(2 * Math.PI * i / n)]) }

/** Замкнутый контур в нужном направлении, начиная с правого верхнего угла */
function orientLoop(L, dir) {
  let P = L.slice()
  if ((signedArea(P) > 0) !== (dir !== 'cw')) P.reverse()
  let s = 0
  for (let i = 1; i < P.length; i++) if (P[i][0] + P[i][1] > P[s][0] + P[s][1] + 1e-9) s = i
  return [...P.slice(s), ...P.slice(0, s)]
}

/**
 * Траектория центра фрезы в прямоугольной выборке / пазу.
 * open — стороны, лежащие на краю детали: там центр фрезы выходит на саму линию контура.
 * -> { point } | { line: [a, b] } | { rough: ломаная | null, finish: замкнутый контур по часовой } | null (фреза шире)
 */
export function rectPaths(x0, y0, x1, y1, open, r, step, spiral = null) {
  let cx0 = open.l ? x0 : x0 + r, cx1 = open.r ? x1 : x1 - r, cy0 = open.b ? y0 : y0 + r, cy1 = open.t ? y1 : y1 - r
  if (cx0 > cx1 + 0.3 || cy0 > cy1 + 0.3) return null
  if (cx0 > cx1 - 0.3) cx0 = cx1 = (cx0 + cx1) / 2
  if (cy0 > cy1 - 0.3) cy0 = cy1 = (cy0 + cy1) / 2
  const w = cx1 - cx0, h = cy1 - cy0
  if (w === 0 && h === 0) return { point: [cx0, cy0] }
  if (w === 0 || h === 0) return { line: [[cx0, cy0], [cx1, cy1]] }
  const finish = [[cx0, cy0], [cx0, cy1], [cx1, cy1], [cx1, cy0]]         // по часовой
  if (spiral) {
    // от центра выборки к контуру: вложенные прямоугольники, каждый следующий — на шаг шире; последний — сам контур
    const st = Math.max(0.5, Math.min(step > 0 ? step : r, 2 * r * 0.7))
    const half = Math.min(w, h) / 2, N = Math.max(1, Math.ceil(half / st - 1e-9))
    const ring = ins => [[cx0 + ins, cy0 + ins], [cx0 + ins, cy1 - ins], [cx1 - ins, cy1 - ins], [cx1 - ins, cy0 + ins]]
    const pts = w >= h ? [[cx0 + half, cy0 + half], [cx1 - half, cy0 + half]] : [[cx0 + half, cy0 + half], [cx0 + half, cy1 - half]]
    if (Math.abs(w - h) < 1e-6) pts.pop()
    for (let i = N - 1; i >= 0; i--) {
      let R = ring(half * i / N)
      if (spiral === 'ccw') R = [R[0], R[3], R[2], R[1]]
      pts.push(...R, R[0])
    }
    return { spiral: pts }
  }
  const alongX = (x1 - x0) >= (y1 - y0)                                    // черновые проходы — вдоль длинной стороны
  // черновая зона: от закрытых сторон — припуск внутрь
  const rx0 = open.l ? cx0 : cx0 + ROUGH_ALLOWANCE, rx1 = open.r ? cx1 : cx1 - ROUGH_ALLOWANCE
  const ry0 = open.b ? cy0 : cy0 + ROUGH_ALLOWANCE, ry1 = open.t ? cy1 : cy1 - ROUGH_ALLOWANCE
  const [a0, a1, l0, l1] = alongX ? [ry0, ry1, rx0, rx1] : [rx0, rx1, ry0, ry1]   // поперёк / вдоль
  const across = alongX ? h : w
  if (across <= 2 * r + 0.01) return { rough: null, finish }               // обход по периметру снимает всё
  const st = Math.max(0.5, Math.min(step > 0 ? step : r, 2 * r * 0.95))
  let pos
  if (a1 <= a0) pos = [(a0 + a1) / 2]
  else { const k = Math.max(1, Math.ceil((a1 - a0) / st - 1e-9)); pos = Array.from({ length: k + 1 }, (_, i) => a0 + (a1 - a0) * i / k) }
  const [m0, m1] = l1 >= l0 ? [l0, l1] : [(l0 + l1) / 2, (l0 + l1) / 2]
  const rough = []
  pos.forEach((a, i) => {
    const [s, e] = i % 2 ? [m1, m0] : [m0, m1]
    rough.push(alongX ? [s, a] : [a, s]); if (m1 > m0) rough.push(alongX ? [e, a] : [a, e])
  })
  return { rough, finish }
}

// ─── вывод ──────────────────────────────────────────────────────────────────
const fmt = v => { let r = Math.round(v * 1000) / 1000; if (Object.is(r, -0)) r = 0; return Number.isInteger(r) ? r + '.0' : String(r) }
class Out {
  constructor(zOff = 0) { this.zOff = zOff; this.lines = []; this.kinds = []; this.opIds = []; this.tag = null; this.f = null; this.pos = [null, null, null] }
  push(line) { this.lines.push(line); this.kinds.push(this.tag ? this.tag[0] : null); this.opIds.push(this.tag ? this.tag[1] : 0) }
  raw(text) { String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean).forEach(s => this.push(s)); this.f = null }
  move(g, x, y, z, feed) {
    let s = g
    if (x != null && y != null && (x !== this.pos[0] || y !== this.pos[1])) { s += ` X${fmt(x)} Y${fmt(y)}`; this.pos[0] = x; this.pos[1] = y }
    if (z != null && z !== this.pos[2]) { s += ` Z${fmt(z - this.zOff)}`; this.pos[2] = z }
    if (s === g) return
    if (feed && Math.round(feed) !== this.f) { s += ` F${Math.round(feed)}`; this.f = Math.round(feed) }
    this.push(s)
  }
  g0(x, y, z) { this.move('G0', x, y, z) }
  g1(x, y, z, feed) { this.move('G1', x, y, z, feed) }
  /**
   * Дуга G2 (по часовой) / G3 (против) в плоскости XY от текущей точки вокруг центра (cx, cy) в сторону точки (x, y).
   * I, J — смещение центра от НАЧАЛА дуги. Конец ставится на ту же окружность, что и начало — радиусы
   * в начале и в конце совпадают с точностью вывода, стойка не выдаст ошибку дуги.
   */
  arc(ccw, x, y, cx, cy, feed) {
    const x0 = this.pos[0], y0 = this.pos[1]
    if (x0 == null || y0 == null) { this.g1(x, y, null, feed); return }
    const r3 = v => Math.round(v * 1000) / 1000
    const sx = r3(x0), sy = r3(y0), i = r3(cx - sx), j = r3(cy - sy), r = Math.hypot(i, j)
    const ox = sx + i, oy = sy + j, d = Math.hypot(x - ox, y - oy)
    if (!(r > 0.05) || !(d > 1e-6)) { this.g1(x, y, null, feed); return }
    const ex = ox + (x - ox) * r / d, ey = oy + (y - oy) * r / d
    if (Math.hypot(ex - sx, ey - sy) < 0.002) return
    let s = `${ccw ? 'G3' : 'G2'} X${fmt(ex)} Y${fmt(ey)} I${fmt(i)} J${fmt(j)}`
    this.pos[0] = ex; this.pos[1] = ey
    if (feed && Math.round(feed) !== this.f) { s += ` F${Math.round(feed)}`; this.f = Math.round(feed) }
    this.push(s)
  }
}
function levels(top, bottom, maxPass) {
  const n = Math.max(1, Math.ceil((top - bottom) / (maxPass > 0 ? maxPass : 1e9) - 1e-9))
  return Array.from({ length: n }, (_, i) => top - (top - bottom) * (i + 1) / n)
}
// Присадочная голова: свёрла меняются на ходу, поэтому порядок отверстий — только по пути. Берётся кратчайший маршрут
// от X0 Y0: стартовые варианты (ближайший сосед, «змейка» полосами по X и по Y) улучшаются разворотами участков (2-opt)
// и переносом отверстий в лучшее место (or-opt); из них выбирается самый короткий. На реальном листе (138 отверстий)
// это ~18 м холостого пути головы против ~37 м у змейки с узкой полосой.
function snakeOrder(list, band, ax = 1) {
  const a = 1 - ax, by = [...list].sort((p, q) => p.at[ax] - q.at[ax] || p.at[a] - q.at[a])
  const bands = []
  for (const j of by) {
    const b = bands[bands.length - 1]
    if (b && j.at[ax] - b.v <= band) b.jobs.push(j)
    else bands.push({ v: j.at[ax], jobs: [j] })
  }
  return bands.flatMap((b, i) => b.jobs.sort((p, q) => (i % 2 ? q.at[a] - p.at[a] : p.at[a] - q.at[a])))
}
const pathLen = (list, from) => { let t = 0, c = from; for (const j of list) { t += Math.hypot(j.at[0] - c[0], j.at[1] - c[1]); c = j.at } return t }
// перенос отверстия (и цепочек из 2–3) в место, где маршрут короче
function orOpt(items, from, until = Infinity) {
  const R = items.slice(), n = R.length, d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]), pt = i => (i < 0 ? from : R[i].at)
  for (let round = 0, better = true; better && round < 20; round++) {
    better = false
    for (let k = 1; k <= 3; k++) for (let i = 0; i + k <= n; i++) {
      if ((i & 15) === 0 && Date.now() > until) return R
      const prev = pt(i - 1), first = R[i].at, last = R[i + k - 1].at, next = i + k < n ? R[i + k].at : null
      const gain = d(prev, first) + (next ? d(last, next) - d(prev, next) : 0)
      let best = 1e-6, at = -1, rev = false, found = false
      for (let j = -1; j < n; j++) {
        if (j >= i - 1 && j <= i + k - 1) continue
        const a = pt(j), b = j + 1 < n ? R[j + 1].at : null
        const base = b ? d(a, b) : 0
        const c1 = d(a, first) + (b ? d(last, b) : 0) - base, c2 = d(a, last) + (b ? d(first, b) : 0) - base
        if (gain - c1 > best) { best = gain - c1; at = j; rev = false; found = true }
        if (gain - c2 > best) { best = gain - c2; at = j; rev = true; found = true }
      }
      if (!found) continue
      const seg = R.splice(i, k); if (rev) seg.reverse()
      R.splice(at < i ? at + 1 : at + 1 - k, 0, ...seg); better = true
    }
  }
  return R
}
export function headOrder(list, from = [0, 0], budgetMs = 1500) {
  if (list.length < 3) return nearestOrder(list, from)
  // на большом листе — один старт (ближайший сосед), и улучшение не дольше budgetMs: программа не должна ждать
  const starts = list.length > 400 ? [nearestOrder(list, from)] : [nearestOrder(list, from), snakeOrder(list, 200, 1), snakeOrder(list, 200, 0)]
  const until = Date.now() + budgetMs
  let best = null, bl = Infinity
  for (const s0 of starts) {
    const per = Date.now() + Math.max(50, (until - Date.now()) / Math.max(1, starts.length - starts.indexOf(s0)))
    let r = shortenTravel(s0, from, 0, per)
    r = orOpt(r, from, per); r = shortenTravel(r, from, 0, per)
    const l = pathLen(r, from)
    if (l < bl) { bl = l; best = r }
  }
  return best
}
/**
 * Заглубление сверла от безопасной высоты до z. Если у сверла задана подача врезания (inFeed) меньше основной и
 * глубина врезания (inLen): до верха материала — на основной, первые inLen мм в материале — ступенями от подачи
 * врезания к основной (чтобы не сколоть пласть), остальное — на основной. Без них — одним ходом на основной (как было).
 */
function drillPlunge(out, t, T, z) {
  const feed = n0(t.feed) || 1000, fIn = n0(t.inFeed), lIn = n0(t.inLen)
  if (!(fIn > 0 && fIn < feed && lIn > 0 && T - z > EPS)) { out.g1(null, null, z, feed); return }
  out.g1(null, null, T, feed)                                   // до пласти — по воздуху, на основной
  const L = Math.min(lIn, T - z), n = Math.max(2, Math.min(5, Math.round(L)))
  for (let k = 0; k < n; k++) out.g1(null, null, T - L * (k + 1) / n, Math.round(fIn + (feed - fIn) * k / n))
  if (z < T - L - EPS) out.g1(null, null, z, feed)
}

// сверло стоит в присадочной голове станка (у постпроцессора включена голова, у сверла — «в присадочной голове»)
export const inHead = (post, t) => !!post?.drillHead && t?.type === 'drill' && !!t.inHead
const tpl = (s, tool) => String(s || '').replace(/\{T\}/gi, String(Math.round(n0(tool.t)))).replace(/\{S\}/gi, String(Math.round(n0(tool.rpm))))

function loopMetric(loop) {
  const n = loop.length, seg = [], cum = [0]
  for (let i = 0; i < n; i++) { seg.push(Math.hypot(loop[(i + 1) % n][0] - loop[i][0], loop[(i + 1) % n][1] - loop[i][1])); cum.push(cum[i] + seg[i]) }
  const per = cum[n]
  const at = d => {                                     // точка контура на расстоянии d от его начала
    const dd = Math.max(0, Math.min(per, d))
    let i = 0
    while (i < n - 1 && cum[i + 1] <= dd) i++
    const t = seg[i] ? (dd - cum[i]) / seg[i] : 0, a = loop[i], b = loop[(i + 1) % n]
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
  }
  return { n, cum, per, at }
}

/**
 * Обход замкнутых контуров (уже в координатах станка). passes: [{ loop, z }] — проходы сверху вниз;
 * у проходов может быть свой контур (первый проход с припуском).
 * Контур начинается и ЗАКАНЧИВАЕТСЯ в своей первой точке (угол) — за угол фреза не заходит, ни один отрезок
 * дважды не проходится. Вход под наклоном: фреза встаёт на первом отрезке на длину захода от угла и
 * опускается, двигаясь к углу; оттуда идёт полный обход. Следующий проход по тому же контуру — заход
 * «туда-обратно» по первому отрезку.
 * Подача: вход — подача входа. Промежуточные проходы — основная подача. Последний проход — по настройкам фрезы:
 * плавный разгон от подачи входа до основной на длине разгона и плавное снижение до подачи выхода перед концом.
 */
function cutLoop(out, passes, top, tool, op, safeZ, arcs = false) {
  const feed = n0(tool.feed) || 1000, inFeed = n0(tool.inFeed) || feed, outFeed = n0(tool.outFeed) || feed
  const ramp = op.entry !== 'straight'
  const tan = Math.tan(Math.max(1, Math.min(89, n0(op.angle) || 45)) * Math.PI / 180)
  let cur = null, M = null, zPrev = 0, R = []
  passes.forEach((ps, k) => {
    const last = k === passes.length - 1, z = ps.z
    if (ps.loop !== cur) {
      const m = loopMetric(ps.loop)
      if (!(m.per > 0)) return
      if (cur) out.g0(null, null, safeZ)
      cur = ps.loop; M = m
      // дуги контура: участки пути [d0, d1], которые идут одной командой G2 / G3 (не больше четверти окружности каждая)
      R = arcs ? arcRuns([...cur, cur[0]]).map(a => ({ ...a, d0: M.cum[a.i0], d1: M.cum[a.i1] })) : []
      zPrev = top + 1
      const L = ramp ? Math.min(M.per / 2, (zPrev - z) / tan) : 0
      const s = M.at(L)
      out.g0(s[0], s[1], safeZ)
      out.g1(null, null, zPrev, inFeed)
      if (L > 0) [...M.cum.filter(d => d > 1e-6 && d < L - 1e-6).reverse(), 0].forEach(d => { const q = M.at(d); out.g1(q[0], q[1], z + (zPrev - z) * d / L, inFeed) })
      else out.g1(null, null, z, inFeed)
    } else if (ramp) {
      const h = Math.min(M.per / 2, (zPrev - z) / tan / 2), zm = (zPrev + z) / 2
      const ds = M.cum.filter(d => d > 1e-6 && d < h - 1e-6)
      ;[...ds, h].forEach(d => { const q = M.at(d); out.g1(q[0], q[1], zPrev + (zm - zPrev) * d / h, inFeed) })
      ;[...ds.slice().reverse(), 0].forEach(d => { const q = M.at(d); out.g1(q[0], q[1], z + (zm - z) * d / h, inFeed) })
    } else out.g1(null, null, z, inFeed)
    // полный обход от угла до угла
    const D = M.per
    let inLen = last ? Math.max(0, n0(tool.inLen)) : 0, outLen = last ? Math.max(0, n0(tool.outLen)) : 0
    if (inLen + outLen > D) { const sc = D / (inLen + outLen); inLen *= sc; outLen *= sc }
    const kIn = inFeed !== feed && inLen > 0 ? Math.max(2, Math.min(8, Math.round(inLen / 6))) : 0
    const kOut = outFeed !== feed && outLen > 0 ? Math.max(2, Math.min(8, Math.round(outLen / 6))) : 0
    const stops = new Set([D])
    const inArc = new Set()
    for (const a of R) {
      const parts = Math.max(1, Math.ceil(a.sweep / (Math.PI / 2) - 1e-6)), keep = new Set()
      for (let m = 1; m < parts; m++) keep.add(a.i0 + Math.round((a.i1 - a.i0) * m / parts))
      for (let i = a.i0 + 1; i < a.i1; i++) if (!keep.has(i)) inArc.add(i)
    }
    for (let i = 1; i < M.n; i++) if (!inArc.has(i)) stops.add(M.cum[i])
    for (let i = 1; i <= kIn; i++) stops.add(inLen * i / kIn)
    for (let i = 0; i < kOut; i++) stops.add(D - outLen + outLen * i / kOut)
    let prev = 0
    for (const d of [...stops].filter(d => d > 1e-6).sort((a, b) => a - b)) {
      if (d - prev < 1e-6) continue
      const mid = (d + prev) / 2
      let f = feed
      if (kIn && mid < inLen) f = inFeed + (feed - inFeed) * (Math.floor(mid / (inLen / kIn)) + 1) / (kIn + 1)
      else if (kOut && mid > D - outLen) f = feed + (outFeed - feed) * (Math.floor((mid - (D - outLen)) / (outLen / kOut)) + 1) / kOut
      const q = M.at(d), a = R.find(a => mid > a.d0 && mid < a.d1)
      if (a) { if (out.pos[2] !== z) out.g1(null, null, z, f); out.arc(a.ccw, q[0], q[1], a.cx, a.cy, f) }
      else out.g1(q[0], q[1], z, f)
      prev = d
    }
    zPrev = z
  })
  out.g0(null, null, safeZ)
}

/**
 * Незамкнутый рез по ломаной (сторона обрезка): проход за проходом туда и обратно, без холостых перебегов.
 * Вход — как у контура детали (op.entry / op.angle): наклонный по линии реза или прямой.
 */
function cutOpen(out, pts, zs, tool, safeZ, top, op = {}) {
  const feed = n0(tool.feed) || 1000, inFeed = n0(tool.inFeed) || feed
  const ramp = op.entry !== 'straight'
  const tan = Math.tan(Math.max(1, Math.min(89, n0(op.angle) || 45)) * Math.PI / 180)
  // точка на ломаной seq на расстоянии d от её начала и вершины, лежащие ближе d
  const walk = seq => {
    const cum = [0]
    for (let i = 1; i < seq.length; i++) cum.push(cum[i - 1] + Math.hypot(seq[i][0] - seq[i - 1][0], seq[i][1] - seq[i - 1][1]))
    const at = d => {
      let i = 1
      while (i < seq.length - 1 && cum[i] < d) i++
      const l = cum[i] - cum[i - 1] || 1, k = Math.max(0, Math.min(1, (d - cum[i - 1]) / l))
      return [seq[i - 1][0] + (seq[i][0] - seq[i - 1][0]) * k, seq[i - 1][1] + (seq[i][1] - seq[i - 1][1]) * k]
    }
    return { len: cum[cum.length - 1], at, inner: d => cum.filter(c => c > 1e-6 && c < d - 1e-6) }
  }
  let fwd = true, zPrev = top + 1
  zs.forEach((z, k) => {
    const seq = fwd ? pts : [...pts].reverse(), W = walk(seq)
    if (!(W.len > 0)) return
    if (k === 0) {
      // первый вход: опускаемся над линией реза и по наклонной возвращаемся в начало
      const L = ramp ? Math.min(W.len, (zPrev - z) / tan) : 0, s = W.at(L)
      out.g0(s[0], s[1], safeZ)
      out.g1(null, null, zPrev, inFeed)
      if (L > 0) [...W.inner(L).reverse(), 0].forEach(d => { const q = W.at(d); out.g1(q[0], q[1], z + (zPrev - z) * d / L, inFeed) })
      else out.g1(null, null, z, inFeed)
    } else if (ramp) {
      // следующие проходы: наклонно вперёд до половины заглубления и обратно — до полной глубины
      const h = Math.min(W.len, (zPrev - z) / tan / 2), zm = (zPrev + z) / 2, ds = W.inner(h)
      ;[...ds, h].forEach(d => { const q = W.at(d); out.g1(q[0], q[1], zPrev + (zm - zPrev) * d / h, inFeed) })
      ;[...ds.slice().reverse(), 0].forEach(d => { const q = W.at(d); out.g1(q[0], q[1], z + (zm - z) * d / h, inFeed) })
    } else out.g1(null, null, z, inFeed)
    seq.slice(1).forEach(q => out.g1(q[0], q[1], z, feed))
    zPrev = z
    fwd = !fwd
  })
  out.g0(null, null, safeZ)
}

/**
 * Контур детали в нужном направлении, начатый с угла, который ближе всех к ЦЕНТРУ листа: рез начинается
 * изнутри листа, и последний отрезок (он приходит в этот же угол) отделяет деталь от основной части листа.
 */
function orientFromInside(L, dir, rect) {
  const P = L.slice()
  if ((signedArea(P) > 0) !== (dir !== 'cw')) P.reverse()
  const n = P.length, cx = (rect.x0 + rect.x1) / 2, cy = (rect.y0 + rect.y1) / 2
  const isCorner = i => {                                  // настоящий угол, а не точка на дуге
    const a = P[(i - 1 + n) % n], b = P[i], c = P[(i + 1) % n]
    const u = [b[0] - a[0], b[1] - a[1]], v = [c[0] - b[0], c[1] - b[1]], lu = Math.hypot(u[0], u[1]), lv = Math.hypot(v[0], v[1])
    return lu > 1e-6 && lv > 1e-6 && (u[0] * v[0] + u[1] * v[1]) / (lu * lv) < 0.94
  }
  let st = -1, bd = Infinity
  for (const cornersOnly of [true, false]) {
    for (let i = 0; i < n; i++) {
      if (cornersOnly && !isCorner(i)) continue
      const d = Math.hypot(P[i][0] - cx, P[i][1] - cy)
      if (d < bd) { bd = d; st = i }
    }
    if (st >= 0) break
  }
  return [...P.slice(st), ...P.slice(0, st)]
}

/**
 * Прямоугольная выборка / паз на глубины zs. op.entry === 'ramp' — вход под углом op.angle:
 * фреза опускается, двигаясь «туда-обратно» по первому отрезку своей траектории.
 */
function cutRect(out, paths, zs, tool, safeZ, top, op = {}) {
  const feed = n0(tool.feed) || 1000, inFeed = n0(tool.inFeed) || feed
  const path = paths.point ? [paths.point] : paths.line ? paths.line : paths.spiral ? paths.spiral
    : [...(paths.rough || []), ...paths.finish, paths.finish[0]]
  const start = path[0], next = path.find(q => Math.hypot(q[0] - start[0], q[1] - start[1]) > 0.5) || null
  const ramp = op.entry === 'ramp' && next
  const tan = Math.tan(Math.max(1, Math.min(89, n0(op.angle) || 45)) * Math.PI / 180)
  out.g0(start[0], start[1], safeZ)
  let zPrev = top + 1
  zs.forEach((z, k) => {
    if (k) out.g1(start[0], start[1], null, feed)
    if (ramp) {
      out.g1(null, null, zPrev, inFeed)
      const len = Math.hypot(next[0] - start[0], next[1] - start[1]), h = Math.min(len, (zPrev - z) / tan / 2), t = h / len
      out.g1(start[0] + (next[0] - start[0]) * t, start[1] + (next[1] - start[1]) * t, (zPrev + z) / 2, inFeed)
      out.g1(start[0], start[1], z, inFeed)
    } else out.g1(null, null, z, inFeed)
    path.slice(1).forEach(q => out.g1(q[0], q[1], null, feed))
    zPrev = z
  })
  out.g0(null, null, safeZ)
}

// порядок обхода — каждый раз ближайшее
function nearestOrder(items, from = [0, 0]) {
  const left = items.slice(), out = []
  let cur = from
  while (left.length) {
    let bi = 0, bd = Infinity
    left.forEach((it, i) => { const d = Math.hypot(it.at[0] - cur[0], it.at[1] - cur[1]); if (d < bd) { bd = d; bi = i } })
    const it = left.splice(bi, 1)[0]
    out.push(it); cur = it.at
  }
  return out
}
// Сокращение холостых переездов: разворот участков маршрута (2-opt), пока суммарный путь уменьшается.
// from — откуда приезжает фреза; fixed — сколько первых операций остаются на своих местах.
function shortenTravel(items, from, fixed = 0, until = Infinity) {
  const n = items.length
  if (n - fixed < 3) return items
  const R = items.slice(), pt = i => (i < 0 ? from : R[i].at), d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1])
  for (let round = 0, better = true; better && round < 60; round++) {
    better = false
    for (let i = fixed; i < n - 1; i++) {
      if (until !== Infinity && (i & 31) === 0 && Date.now() > until) return R      // время вышло — что успели
      for (let j = i + 1; j < n; j++) {
      const a = pt(i - 1), b = pt(i), c = pt(j), e = j + 1 < n ? pt(j + 1) : null
      if (d(a, c) + (e ? d(b, e) : 0) < d(a, b) + (e ? d(c, e) : 0) - 1e-6) {
        for (let l = i, r = j; l < r; l++, r--) { const t = R[l]; R[l] = R[r]; R[r] = t }
        better = true
      }
      }
    }
  }
  return R
}

/**
 * Насколько мелкая деталь далека от опоры — крупной детали: 1 — прилегает к крупной, 2 — к такой мелкой, и т. д.
 * В группе соседей без крупных деталей опорой считается самая большая из них. Крупные — 0.
 */
function supportDepth(list, gap, near) {
  const depth = new Map(), nb = j => list.filter(k => k !== j && gap(j, k) <= near)
  const spread = roots => {
    let wave = roots
    roots.forEach(j => depth.set(j, j.small ? 1 : 0))
    while (wave.length) {
      const next = []
      for (const j of wave) for (const k of nb(j)) if (!depth.has(k)) { depth.set(k, depth.get(j) + 1); next.push(k) }
      wave = next
    }
  }
  spread(list.filter(j => !j.small))
  // группы мелких, не связанные ни с одной крупной
  for (;;) {
    const rest = list.filter(j => !depth.has(j))
    if (!rest.length) break
    spread([rest.reduce((b, j) => ((j.area || 0) > (b.area || 0) ? j : b))])
  }
  return depth
}

/**
 * Любая деталь, мелкая и крупная: контур начинается так, чтобы ПОСЛЕДНИЙ отрезок (на нём подача снижается до подачи выхода)
 * шёл по стороне, вдоль которой ещё НЕ БЫЛО реза соседних деталей, и отделял деталь от самого крупного
 * нетронутого куска — неотрезанной соседней детали или свободного листа. Стороны, где сосед уже отрезан,
 * проходятся раньше. route — контуры в порядке реза, rect — лист. Если все стороны уже прорезаны соседями —
 * начало остаётся как было.
 */
function lastCutToSupport(route, rect, extra = []) {
  const NEAR = 40
  route.forEach((j, pos) => {
    if (!j.L || j.L.length < 3) return
    const P = j.L, n = P.length, [x0, y0, x1, y1] = j.box, e = j.reach || 4
    const earlier = route.slice(0, pos), later = [...route.slice(pos + 1), ...extra]   // extra — деловые обрезки: режутся после всех деталей
    const vert = side => side === 'l' || side === 'r'
    // какая часть стороны прилегает к деталям из списка: [доля длины, сумма «длина общей стороны, м × площадь соседа, м²», длина стороны]
    const along = (side, list) => {
      const len = Math.max(1, vert(side) ? y1 - y0 : x1 - x0)
      let cover = 0, mass = 0
      for (const k of list) {
        const [a0, b0, a1, b1] = k.box
        const d = side === 'l' ? x0 - a1 : side === 'r' ? a0 - x1 : side === 'b' ? y0 - b1 : b0 - y1
        if (d < -1 || d > NEAR) continue
        const ov = vert(side) ? Math.min(y1, b1) - Math.max(y0, b0) : Math.min(x1, a1) - Math.max(x0, a0)
        if (ov > 1) { cover += ov; mass += ov * (k.area || 0) }
      }
      return [Math.min(1, cover / len), mass / 1000, len]
    }
    // Оценка стороны как места ПОСЛЕДНЕГО реза: вдоль неё ещё не резали (соседи с этой стороны не отрезаны),
    // и за ней — как можно более крупный нетронутый кусок: неотрезанная деталь или свободный лист до края.
    const rate = side => {
      const [cut] = along(side, earlier), [kept, mass, len] = along(side, later)
      const free = 1 - cut                                // доля стороны, вдоль которой реза ещё не было
      if (free < 0.5) return 0
      const toEdge = rect ? Math.max(0, side === 'l' ? x0 - rect.x0 : side === 'r' ? rect.x1 - x1 : side === 'b' ? y0 - rect.y0 : rect.y1 - y1) : 0
      // свободный лист за стороной считается так же — длина × площадь, но вдвое дешевле: что там на самом деле, неизвестно
      const wl = Math.max(0, free - kept) * len, waste = wl / 1000 * (wl * Math.min(toEdge, 400) / 1e6) * 0.5
      return free * (0.001 + mass + waste)
    }
    const score = { l: rate('l'), r: rate('r'), b: rate('b'), t: rate('t') }
    let best = -1, bs = 0
    for (let i = 0; i < n; i++) {
      const a = P[(i - 1 + n) % n], b = P[i], c = P[(i + 1) % n]
      const u = [b[0] - a[0], b[1] - a[1]], v = [c[0] - b[0], c[1] - b[1]], lu = Math.hypot(u[0], u[1]), lv = Math.hypot(v[0], v[1])
      if (!(lu > 1e-6 && lv > 1e-6) || (u[0] * v[0] + u[1] * v[1]) / (lu * lv) >= 0.94) continue          // не угол
      // последний отрезок приходит в точку i: на какой стороне габарита он лежит
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, flatX = Math.abs(u[0]) < 0.01 * lu, flatY = Math.abs(u[1]) < 0.01 * lu
      const side = flatX && Math.abs(mx - x0) <= e ? 'l' : flatX && Math.abs(mx - x1) <= e ? 'r' : flatY && Math.abs(my - y0) <= e ? 'b' : flatY && Math.abs(my - y1) <= e ? 't' : null
      const sc = side ? score[side] * Math.min(1, lu / 50) : 0
      if (sc > bs + 1e-9) { bs = sc; best = i }
    }
    if (best > 0) j.restart(best)
  })
}

/**
 * Порядок реза контуров деталей — без пробегов из конца в конец листа.
 * list: [{ at: [x, y] — точка входа, box: [x0, y0, x1, y1], edgeDist, small }], from — где сейчас фреза.
 *  • начинаем с детали у края листа, ближайшей к фрезе, и идём от соседа к соседу (каждый раз ближайшая деталь);
 *  • самая большая деталь листа режется последней; из двух соседних крупных раньше — та, что заметно меньше;
 *  • smallFirst: мелкая деталь режется раньше своих соседей — пока лист вокруг неё цел и её держит вакуум;
 *  • затем маршрут укорачивается разворотами участков (2-opt), не нарушая этих правил.
 */
// Вложенные детали в маршруте контуров: контур вложенной → вырез хозяина (как только все его вложенные вырезаны) →
// контур хозяина (не раньше его вырезов с вложениями). Остальной порядок маршрута сохраняется.
// Вырез режется до контура хозяина, пока хозяин ещё цел и держится на листе; вложенная деталь — первой, пока её держит
// материал хозяина вокруг
// state — { done, cutoutsDone } общее на все вызовы (контуры разных инструментов идут отдельными маршрутами)
export function withNestedOrder(route, heldCutouts, state = { done: new Set(), cutoutsDone: new Set() }) {
  if (!heldCutouts?.size) return route
  const { done, cutoutsDone } = state
  const out = [], deferred = []
  const tryCutouts = () => {
    for (const c of heldCutouts) if (!cutoutsDone.has(c) && c.holds.every(j => done.has(j))) { cutoutsDone.add(c); out.push(c) }
  }
  const ready = j => (j.ownHeld || []).every(c => cutoutsDone.has(c))   // контур хозяина — после его вырезов с вложениями
  const emit = j => { out.push(j); done.add(j); tryCutouts() }
  const flush = () => { let moved = true; while (moved) { moved = false; for (let i = 0; i < deferred.length; i++) if (ready(deferred[i])) { emit(deferred.splice(i, 1)[0]); moved = true; break } } }
  for (const j of route) {
    if (!ready(j)) { deferred.push(j); continue }
    emit(j); flush()
  }
  // осталось — контуры, чьи вырезы ждут вложений с другого маршрута (другой инструмент): как есть
  out.push(...deferred)
  return out
}

export function routeContours(list, from, sheetRect, smallFirst = true) {
  const n = list.length
  if (n < 2) return list.slice()
  const NEAR = 40                                        // мм: зазор, при котором детали — соседи
  const gap = (a, b) => Math.max(a.box[0] - b.box[2], b.box[0] - a.box[2], a.box[1] - b.box[3], b.box[1] - a.box[3], 0)
  const D = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1])
  // Последней режется самая большая деталь листа: пока идут остальные, она цела и держит лист, а каждая деталь
  // поменьше отделяется от куска крупнее себя. (Раньше последней была деталь в середине листа.)
  const mid = j => [(j.box[0] + j.box[2]) / 2, (j.box[1] + j.box[3]) / 2]
  const cx = (sheetRect.x0 + sheetRect.x1) / 2, cy = (sheetRect.y0 + sheetRect.y1) / 2
  const pool = smallFirst && list.some(j => !j.small) ? list.filter(j => !j.small) : list
  const centre = pool.reduce((b, j) => (!b || (j.area || 0) > (b.area || 0) * 1.02 || (Math.abs((j.area || 0) - (b.area || 0)) <= (b.area || 0) * 0.02 && D(mid(j), [cx, cy]) < D(mid(b), [cx, cy])) ? j : b), null)
  // кто кого ждёт: крупная деталь — ВСЕ мелкие листа; центральная — всех.
  // Среди мелких: сначала те, что дальше от крупных деталей (считая по соседям), последними — прилегающие к крупной.
  // Так мелкая деталь в момент реза ещё держится за нетронутого соседа, а фреза не возвращается в россыпь уже отрезанных.
  const before = new Map(list.map(j => [j, []]))
  if (smallFirst) {
    const depth = supportDepth(list, gap, NEAR)
    // какой долей своей длины мелкая деталь прилегает к крупным: из двух соседних мелких на одном удалении
    // первой режется та, что держится за крупную слабее, — пока её держит и сосед
    const hold = new Map(list.map(j => {
      const [x0, y0, x1, y1] = j.box
      let len = 0
      for (const k of list) {
        if (k === j || k.small || gap(j, k) > NEAR) continue
        const ox = Math.min(x1, k.box[2]) - Math.max(x0, k.box[0]), oy = Math.min(y1, k.box[3]) - Math.max(y0, k.box[1])
        len += Math.max(ox, oy, 0)
      }
      return [j, len / Math.max(x1 - x0, y1 - y0, 1)]
    }))
    for (const s of list) if (s.small) for (const b of list) {
      if (b === s) continue
      if (!b.small) before.get(b).push(s)
      else if (gap(s, b) <= NEAR && (depth.get(s) > depth.get(b) || (depth.get(s) === depth.get(b) && hold.get(s) < hold.get(b) - 0.05))) before.get(b).push(s)
    }
  }
  // и среди крупных: из двух соседей раньше режется та, что заметно меньше, — она отделяется от большей
  if (smallFirst) for (const s of list) if (!s.small) for (const b of list) {
    if (b !== s && !b.small && gap(s, b) <= NEAR && (s.area || 0) < (b.area || 0) * 0.6) before.get(b).push(s)
  }
  if (centre) for (const j of list) if (j !== centre && !before.get(j).includes(centre)) before.get(centre).push(j)
  const valid = R => { const pos = new Map(R.map((j, i) => [j, i])); return R.every(j => before.get(j).every(q => pos.get(q) < pos.get(j))) }
  // жадный обход: ближайшая из доступных; первая — у края листа
  const me = Math.min(...list.map(j => j.edgeDist)), done = new Set(), R = []
  let cur = from
  while (R.length < n) {
    let free = list.filter(j => !done.has(j) && before.get(j).every(q => done.has(q)))
    if (!free.length) free = list.filter(j => !done.has(j))                       // на всякий случай: правила не должны запирать маршрут
    if (!R.length) { const edge = free.filter(j => j.edgeDist <= me + NEAR); if (edge.length) free = edge }
    const next = free.reduce((b, j) => (!b || D(j.at, cur) < D(b.at, cur) ? j : b), null)
    R.push(next); done.add(next); cur = next.at
  }
  // 2-opt: разворот участка, если путь короче и правила целы
  const pt = i => (i < 0 ? from : R[i].at)
  for (let round = 0, better = true; better && round < 40; round++) {
    better = false
    for (let i = 0; i < n - 1; i++) for (let k = i + 1; k < n; k++) {
      const a = pt(i - 1), b = pt(i), c = pt(k), e = k + 1 < n ? pt(k + 1) : null
      if (D(a, c) + (e ? D(b, e) : 0) >= D(a, b) + (e ? D(c, e) : 0) - 1e-6) continue
      const rev = () => { for (let l = i, r = k; l < r; l++, r--) { const t = R[l]; R[l] = R[r]; R[r] = t } }
      rev()
      if (valid(R)) better = true; else rev()
    }
  }
  return R
}

/**
 * G-код одного листа.
 * sheet — лист из раскроя, geo — геометрия листа (sheetGeo), details — детали материала, thickness — толщина,
 * cnc — настройки (см. cncSettings.js).  -> { text, lines, warnings, tools }
 */
export function buildSheetGcode({ sheet, geo, details, thickness, cnc: cncAll }) {
  // инструменты и обработка — те, что видит этот постпроцессор (свой набор у настроенного по чужой программе, см. postTools.js)
  const cnc = postView(cncAll)
  const post = cnc.posts.find(p => p.id === cnc.post) || cnc.posts[0]
  const T = Number(thickness) || 16
  const warn = new Set()
  const ox = n0(post.originX) + (geo.marginL || 0), oy = n0(post.originY) + (geo.marginB || 0)
  const zTop = post.zRef === 'top'                       // ноль Z — верхняя пласть листа (иначе — стол)
  let safeZ = (n0(post.safeZ) || 25) + (zTop ? T : 0)
  if (safeZ < T + 5) { warn.add(`Высота безопасности Z${num(safeZ)} ниже верха материала ${num(T)} мм + 5 мм — в программе поднята до Z${num(T + 5)}.`); safeZ = T + 5 }
  if (n0(post.fieldX) && n0(post.originX) + geo.sheetW > n0(post.fieldX) + EPS) warn.add(`Лист по X (${num(n0(post.originX) + geo.sheetW)} мм) выходит за рабочее поле станка ${num(post.fieldX)} мм.`)
  if (n0(post.fieldY) && n0(post.originY) + geo.sheetL > n0(post.fieldY) + EPS) warn.add(`Лист по Y (${num(n0(post.originY) + geo.sheetL)} мм) выходит за рабочее поле станка ${num(post.fieldY)} мм.`)
  // заглубление ниже стола: в настройках его вводят и «0,5», и «−0,5» (как Z) — знак не важен.
  // Раньше минус отбрасывался (max(0, …)) и сквозной рез выходил на Z0 — деталь не прорезалась.
  const millOver = Math.abs(n0(post.millOver)), drillOver = Math.abs(n0(post.drillOver))
  if (!millOver) warn.add('Заглубление фрезы в стол — 0: сквозной рез идёт ровно до стола, деталь может не прорезаться. Задайте его в ЧПУ → Обработка → «Контур детали» (обычно 0,2–0,5 мм).')
  const ops = cnc.ops
  const arcs = post.arcs === 'ij'                        // дуги — командами G2 / G3 (иначе — мелкими отрезками, см. smoothLoop)
  const smallArea = n0(ops.outer?.smallArea) > 0 ? n0(ops.outer.smallArea) : 0.12      // мельче — «мелкая деталь», режется первой
  const smallSide = ops.outer?.smallSide === '' || ops.outer?.smallSide == null ? 150 : Math.max(0, n0(ops.outer.smallSide))   // уже — тоже «мелкая»
  const sheetRect = { x0: n0(post.originX), y0: n0(post.originY), x1: n0(post.originX) + geo.sheetW, y1: n0(post.originY) + geo.sheetL }
  const tool = id => toolById(cnc, id)
  // Высота режущей кромки фрезы (tool.edgeH): глубже неё фреза не режет — хвостовик трётся о материал. Проверяем
  // каждую обработку; программа всё равно выпускается, пользователь видит предупреждение. Пусто/0 — без проверки.
  const edgeOk = (t, depth, what) => {
    const h = n0(t.edgeH)
    if (h > 0 && depth > h + EPS) warn.add(`Фреза «${t.name}» (T${Math.round(n0(t.t))}): высота режущей кромки ${num(h)} мм, а ${what} — ${num(depth)} мм. Глубже кромки фреза не режет.`)
  }
  const jobs = []                    // { stage, rank, tool, at: [x, y], area, run(out) }
  const miss = {}                    // на что не назначен инструмент -> сколько раз
  const noTool = what => { miss[what] = (miss[what] || 0) + 1 }
  let edge = 0, back = 0, odd = 0

  const skip = skipOf(ops)
  const boxes = []                   // габариты деталей на листе — для проверки «только прямоугольники»
  // Вложенные детали (деталь лежит в сквозном вырезе другой — см. nestInHoles.js): для каждой детали — её контур на
  // листе, её вырезы и работы по ним. Порядок резов для них: контур вложенной детали → вырез хозяина → контур хозяина
  const parts = []                   // { outline: [[x,y]] на листе, contour: job|null, cutouts: [{ job, pts }] }
  for (const p of sheet.placed || []) {
    const f = partFeatures(p, details?.[p.detailIndex], T, skip)
    const part = { outline: f.outline.map(([x, y]) => [ox + p.x + x, oy + p.y + y]), contour: null, cutouts: [] }
    parts.push(part)
    if (skip.contour) { const b = bboxOf(f.outline); boxes.push({ x0: p.x + b.x0, y0: p.y + b.y0, x1: p.x + b.x1, y1: p.y + b.y1, boxed: f.boxed }) }
    const bx = ox + p.x, by = oy + p.y
    const G = ([x, y]) => [bx + x, by + y]
    edge += f.skipped.edge; back += f.skipped.back; odd += f.skipped.odd

    // отверстия
    for (const h of f.holes) {
      const layer = { key: h.key, d: h.d }, o = ops.holes?.[h.key] || {}
      const t = holeToolFor(layer, cnc)
      const d = n0(o.d) || h.d, depth = n0(o.depth) || h.depth
      const label = `отверстия Ø${num(h.d)} × ${num(Math.min(h.depth, T))}`
      if (!t) { noTool(label); continue }
      const through = depth >= T - EPS
      const c = G([h.x, h.y])
      if (t.type === 'drill') {
        if (Math.abs(n0(t.d) - d) > EPS) warn.add(`На ${label} назначено сверло Ø${num(t.d)} — диаметр не совпадает.`)
        const z = through ? -drillOver : T - depth
        jobs.push({ stage: 0, rank: 0, tool: t, at: c, run: out => { out.g0(c[0], c[1], safeZ); drillPlunge(out, t, T, z); out.g0(null, null, safeZ) } })
      } else {
        // Отверстие фрезой. Фреза не сверло — прямо вниз не врезается (горит), поэтому вход по спирали: на диаметре
        // на 2 мм меньше отверстия (по 1 мм на сторону), но не меньше «фреза + 1 мм»; дошла до низа — разбивает
        // отверстие кольцами до нужного диаметра, последний круг — по самому диаметру.
        const dt = n0(t.d), R = (d - dt) / 2
        if (R < -EPS) { warn.add(`Фреза Ø${num(dt)} больше отверстия Ø${num(d)} — ${label} пропущены.`); continue }
        if (!o.tool) warn.add(`Сверла Ø${num(d)} нет — ${label} делает фреза Ø${num(dt)} (T${Math.round(n0(t.t))}): вход по спирали и разбивка до диаметра.`)
        const zBot = through ? -millOver : T - depth
        edgeOk(t, T - zBot, label)
        const de = Math.min(d, Math.max(dt + 1, d - 2))
        const Re = Math.max(0, Math.min(R, (de - dt) / 2))           // радиус спирали входа (по центру фрезы)
        const st = Math.max(0.3, Math.min(n0(t.step) || dt / 2, dt * 0.9))
        const tan = Math.tan(Math.max(1, Math.min(89, n0(ops.outer?.angle) || 45)) * Math.PI / 180)
        if (Re < 0.2) warn.add(`Фреза Ø${num(dt)} почти равна отверстию Ø${num(d)} — места на спираль нет, вход прямой на пониженной подаче (${label}).`)
        const cw = (ops.cutout?.dir || 'cw') !== 'ccw'                   // как у вырезов: по умолчанию по часовой
        const ring = (r, z0, z1) => {                                    // один оборот радиуса r, z — от z0 к z1
          const L = circleLoop(c[0], c[1], r), pts = cw ? [L[0], ...L.slice(1).reverse(), L[0]] : [...L, L[0]]
          return pts.map((q, k) => [q[0], q[1], z0 + (z1 - z0) * k / (pts.length - 1)])
        }
        jobs.push({ stage: 0, rank: 1, tool: t, at: c, run: out => {
          const feed = n0(t.feed) || 1000, inFeed = n0(t.inFeed) || feed
          const top = T + 1
          if (Re < 0.2) {
            out.g0(c[0], c[1], safeZ); out.g1(null, null, top, inFeed)
            levels(top, zBot, n0(t.maxPass) || dt / 2).forEach(z => out.g1(null, null, z, Math.max(100, Math.round(inFeed / 3))))
          } else {
            // спираль: за оборот — не глубже угла входа и не больше макс. глубины за проход
            const pitch = Math.max(0.2, Math.min(2 * Math.PI * Re * tan, n0(t.maxPass) > 0 ? n0(t.maxPass) : dt * 0.75))
            const turns = Math.max(1, Math.ceil((top - zBot) / pitch - 1e-9))
            out.g0(c[0] + Re, c[1], safeZ); out.g1(null, null, top, inFeed)
            for (let k = 0; k < turns; k++) {
              const z0 = top - (top - zBot) * k / turns, z1 = top - (top - zBot) * (k + 1) / turns
              ring(Re, z0, z1).slice(1).forEach(q => out.g1(q[0], q[1], q[2], inFeed))
            }
            ring(Re, zBot, zBot).slice(1).forEach(q => out.g1(q[0], q[1], null, feed))        // круг по дну
          }
          // глухое отверстие: середина, которую спираль не задела, выбирается кольцами внутрь
          if (!through && Re > dt * 0.45) {
            for (let r = Re - st; r > 0.05; r -= st) { out.g1(c[0] + r, c[1], null, feed); ring(r, zBot, zBot).slice(1).forEach(q => out.g1(q[0], q[1], null, feed)) }
            out.g1(c[0], c[1], null, feed); out.g1(c[0] + Math.max(Re, 0), c[1], null, feed)
          }
          // разбивка до диаметра: кольца наружу с шагом перекрытия, последнее — точно по диаметру
          const rs = []
          for (let r = Math.max(Re, 0) + st; r < R - 1e-6; r += st) rs.push(r)
          if (R > Math.max(Re, 0) + 1e-6) rs.push(R)
          rs.forEach(r => { out.g1(c[0] + r, c[1], null, feed); ring(r, zBot, zBot).slice(1).forEach(q => out.g1(q[0], q[1], null, feed)) })
          out.g1(c[0] + Math.max(0, R - Math.min(0.5, R)), c[1], null, feed)     // отойти от стенки перед подъёмом
          out.g0(null, null, safeZ)
        } })
      }
    }
    // пазы и выборки
    const rects = [...f.grooves.map(g => { const d = g.depth || T, op = grooveOpFor(ops, grooveKey(g.width, d)); return { ...g, depth: d, op, t: tool(op.tool), rank: 2, label: `пазы ${num(g.width)} × ${num(d)}` } }),
      ...f.pockets.map(k => { const op = ops.pockets?.[pocketKey(k.depth)] || {}; return { ...k, op, spiral: op.mode === 'spiral' ? (op.dir === 'ccw' ? 'ccw' : 'cw') : null, t: tool(op.tool), rank: 3, label: `выемки глубиной ${num(k.depth)}` } })]
    for (const k of rects) {
      if (!k.t) { noTool(k.label); continue }
      if (k.t.type !== 'mill') { warn.add(`На ${k.label} назначено сверло — нужна фреза.`); continue }
      const paths = rectPaths(bx + k.x0, by + k.y0, bx + k.x1, by + k.y1, k.open, n0(k.t.d) / 2, n0(k.t.step), k.spiral)
      if (!paths) { warn.add(`Фреза Ø${num(k.t.d)} шире, чем ${k.label} (${num(Math.min(k.x1 - k.x0, k.y1 - k.y0))} мм) — пропущено.`); continue }
      edgeOk(k.t, k.depth >= T - EPS ? T + millOver : k.depth, k.label)
      const zs = levels(T, k.depth >= T - EPS ? -millOver : T - k.depth, n0(k.t.maxPass))
      jobs.push({ stage: 0, rank: k.rank, tool: k.t, at: [bx + k.x0, by + k.y0], run: out => cutRect(out, paths, zs, k.t, safeZ, T, k.op) })
    }
    // вырезы — фреза идёт внутри контура
    for (const c of f.cutouts) {
      const t = tool(ops.cutout?.tool)
      if (!t) { noTool('контур выреза'); continue }
      if (t.type !== 'mill') { warn.add('На контур выреза назначено сверло — нужна фреза.'); continue }
      const r = n0(t.d) / 2
      const loop = c.circle ? (c.circle.r - r > 0.2 ? circleLoop(c.circle.cx, c.circle.cy, c.circle.r - r) : null) : offsetLoop(smoothLoop(c.pts), -r)
      if (!loop) { warn.add(`Фреза Ø${num(t.d)} не проходит в вырез — он пропущен.`); continue }
      const L = orientLoop(loop.map(G), ops.cutout.dir)
      edgeOk(t, T + millOver, 'сквозной рез выреза')
      const zs = levels(T, -millOver, n0(t.maxPass))
      const job = { stage: 1, rank: 4, tool: t, at: L[0], holds: [], run: out => cutLoop(out, zs.map(z => ({ loop: L, z })), T, t, ops.cutout, safeZ, arcs) }
      jobs.push(job)
      part.cutouts.push({ job, pts: c.circle ? circleLoop(c.circle.cx, c.circle.cy, c.circle.r).map(G) : c.pts.map(G) })
    }
    // контур детали — фреза идёт снаружи
    {
      const t = tool(ops.outer?.tool), o = ops.outer
      if (!t) noTool('контур детали')
      else if (t.type !== 'mill') warn.add('На контур детали назначено сверло — нужна фреза.')
      else {
        edgeOk(t, T + millOver, 'сквозной рез контура детали')
        const r = n0(t.d) / 2, smooth = smoothLoop(f.outline), base = offsetLoop(smooth, r)
        if (!base) warn.add('Не удалось построить обход контура одной из деталей — она пропущена.')
        else {
          const L = orientFromInside(base.map(G), o.dir, sheetRect)
          const bb = bboxOf(f.outline)
          // мелкая деталь: по площади или узкая полоса — вакуум держит её плохо при любой длине
          const area = Math.abs(signedArea(f.outline)) / 1e6, small = area <= smallArea || Math.min(bb.x1 - bb.x0, bb.y1 - bb.y0) <= smallSide
          const N = Math.max(1, Math.round(n0(o.passes) || 1))
          let mk                                         // проходы по контуру L (и черновому Lr)
          let Lr = null
          if (N > 1 && (!o.smallOnly || small)) {
            // первые проходы — с припуском по контуру и остатком по глубине, последний — начисто
            const allow = Math.max(0, n0(o.sideAllow)), left = Math.max(0, Math.min(T - 0.5, n0(o.leftover)))
            const rough = allow > 0 ? offsetLoop(smooth, r + allow) : null
            Lr = rough ? orientFromInside(rough.map(G), o.dir, sheetRect) : null
            mk = (A, B) => [...levels(T, left, Math.min(n0(t.maxPass) || 1e9, (T - left) / (N - 1) + 1e-6)).map(z => ({ loop: B || A, z })), { loop: A, z: -millOver }]
          } else mk = A => levels(T, -millOver, n0(t.maxPass)).map(z => ({ loop: A, z }))
          const edgeDist = Math.min(geo.marginL + p.x + bb.x0, geo.sheetW - (geo.marginL + p.x + bb.x1), geo.marginB + p.y + bb.y0, geo.sheetL - (geo.marginB + p.y + bb.y1))
          const job = { stage: 1, rank: 5, tool: t, at: L[0], small, area, edgeDist, mid: [bx + (bb.x0 + bb.x1) / 2, by + (bb.y0 + bb.y1) / 2], box: [bx + bb.x0, by + bb.y0, bx + bb.x1, by + bb.y1],
            L, Lr, reach: r + 1.5, passes: mk(L, Lr),
            // начать контур с другой его точки (см. lastCutToSupport): черновой контур — с ближайшей к ней
            restart(i) {
              this.L = [...this.L.slice(i), ...this.L.slice(0, i)]
              if (this.Lr) { const q = this.L[0]; let k = 0, bd = Infinity; this.Lr.forEach((v, n) => { const d = Math.hypot(v[0] - q[0], v[1] - q[1]); if (d < bd) { bd = d; k = n } }); this.Lr = [...this.Lr.slice(k), ...this.Lr.slice(0, k)] }
              this.at = this.L[0]; this.passes = mk(this.L, this.Lr)
            },
            run: out => cutLoop(out, job.passes, T, t, o, safeZ, arcs) }
          jobs.push(job)
          part.contour = job
        }
      }
    }
  }
  // Кто в чьём вырезе: контур детали j целиком внутри выреза детали i → вырез «держит» j (режется после её контура)
  for (let i = 0; i < parts.length; i++) for (const c of parts[i].cutouts) for (let j = 0; j < parts.length; j++) {
    if (j === i || !parts[j].contour || !parts[j].outline.length) continue
    if (parts[j].outline.every(q => pointInPoly(q, c.pts))) { c.job.holds.push(parts[j].contour); if (parts[i].contour) parts[i].contour.ownHeld = [...(parts[i].contour.ownHeld || []), c.job] }
  }
  const heldCutouts = new Set(jobs.filter(j => j.rank === 4 && j.holds?.length))
  // Деловые обрезки, отмеченные в раскрое: режутся прямоугольником, фреза идёт снаружи. По краю листа инструмент
  // не идёт — только по сторонам внутри листа; обрезок, окружённый деталями, обходится по всему периметру.
  for (const of of sheet.manualOffcuts || []) {
    const t = tool(ops.outer?.tool)
    if (!t) { noTool('контур обрезка'); continue }
    if (t.type !== 'mill') { warn.add('На контур детали назначено сверло — обрезки не отрезаются.'); continue }
    const r = n0(t.d) / 2, e = 0.5
    const x0 = ox + of.x, y0 = oy + of.y, x1 = x0 + of.w, y1 = y0 + of.h
    const X0 = x0 - r, X1 = x1 + r, Y0 = y0 - r, Y1 = y1 + r
    // стороны по кругу: низ, право, верх, лево; skip — сторона лежит на краю листа
    const sides = [
      { a: [X0, Y0], b: [X1, Y0], skip: y0 <= sheetRect.y0 + e }, { a: [X1, Y0], b: [X1, Y1], skip: x1 >= sheetRect.x1 - e },
      { a: [X1, Y1], b: [X0, Y1], skip: y1 >= sheetRect.y1 - e }, { a: [X0, Y1], b: [X0, Y0], skip: x0 <= sheetRect.x0 + e },
    ]
    const zs = levels(T, -millOver, n0(t.maxPass))
    if (sides.every(s => s.skip)) continue                         // обрезок — весь лист: резать нечего
    if (!sides.some(s => s.skip)) {
      const L = orientFromInside(sides.map(s => s.a), ops.outer.dir, sheetRect)
      jobs.push({ stage: 2, rank: 6, tool: t, at: L[0], run: out => cutLoop(out, zs.map(z => ({ loop: L, z })), T, t, ops.outer, safeZ) })
      continue
    }
    // незамкнутые цепочки из идущих подряд сторон; концы у края листа прижимаются к самому краю
    const clamp = q => [Math.max(sheetRect.x0, Math.min(sheetRect.x1, q[0])), Math.max(sheetRect.y0, Math.min(sheetRect.y1, q[1]))]
    const start = sides.findIndex((s, i) => !s.skip && sides[(i + 3) % 4].skip)
    let chain = null
    for (let k = 0; k < 4; k++) {
      const s = sides[(start + k) % 4]
      if (s.skip) { chain = null; continue }
      if (!chain) { chain = [clamp(s.a)]; const pts = chain; jobs.push({ stage: 2, rank: 6, tool: t, at: pts[0], run: out => cutOpen(out, pts, zs, t, safeZ, T, ops.outer) }) }
      chain.push(clamp(s.b))
    }
  }
  // «Резать только прямоугольники» на раскрое, сделанном по контуру: сцепленные фигурные детали вписаны друг
  // в друга, их габариты перекрываются — прямоугольный рез заденет соседа
  if (skip.contour && boxes.some(b => b.boxed)) {
    const gap = n0(tool(ops.outer?.tool)?.d) - 0.05
    let bad = 0
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j]
      if (!a.boxed && !b.boxed) continue
      const dx = Math.max(a.x0 - b.x1, b.x0 - a.x1), dy = Math.max(a.y0 - b.y1, b.y0 - a.y1)
      if (Math.max(dx, dy) < gap) bad++
    }
    if (bad) warn.add(`Резать только прямоугольники: габариты фигурных деталей перекрываются или стоят ближе диаметра фрезы (${bad} пар) — раскрой сделан по контуру. Прямоугольный рез заденет соседние детали.`)
  }
  if (skip.contour || skip.face || skip.holes) warn.add('Отключено в настройках «Обработка»: ' + [skip.contour && 'вырезы (детали — прямоугольником по габариту)', skip.face && 'пазы и выемки с лица', skip.holes && 'отверстия'].filter(Boolean).join(', ') + '.')
  Object.entries(miss).forEach(([what, cnt]) => warn.add(`Не назначен инструмент: ${what} (${cnt} шт.) — в программу не попали.`))
  if (edge) warn.add(`Отверстия в торец (${edge} шт.) на этом станке не сверлятся — в программу не попали.`)
  if (back) warn.add(`Обработка с изнанки (${back} шт.) в программу не попала — деталь нужно перевернуть.`)
  if (odd) warn.add(`Выемки сложной формы (${odd} шт.) пока не обрабатываются — в программу не попали.`)

  // порядок: сначала всё внутри деталей (по инструментам), потом вырезы и контуры
  const lastTool = jobs.find(j => j.rank === 5)?.tool || jobs.find(j => j.rank === 4)?.tool || null
  const toolRank = t => (t.type === 'drill' ? 0 : t === lastTool ? 2 : 1) * 1000 + n0(t.t)
  const seq = []
  let cur = [0, 0]
  const add = list => { const o = shortenTravel(nearestOrder(list, cur), cur); seq.push(...o); if (o.length) cur = o[o.length - 1].at }
  // Присадочная голова (если у станка она есть и сверло стоит в ней): свёрла меняются на ходу, поэтому все отверстия
  // головы — одним проходом по листу, без группировки по диаметру (портал не ездит туда-сюда). Потом — шпиндель.
  const headJobs = jobs.filter(j => j.stage === 0 && inHead(post, j.tool))
  if (headJobs.length) { const o = headOrder(headJobs, cur); seq.push(...o); cur = o[o.length - 1].at }
  if (headJobs.length && !String(post.cmdHeadStart || '').trim()) warn.add('Команды смены инструмента для присадочной головы не заданы (Команды → «Присадочная голова»): свёрла головы в программе не включатся.')
  const stage0 = jobs.filter(j => j.stage === 0 && !inHead(post, j.tool))
  ;[...new Set(stage0.map(j => j.tool))].sort((a, b) => toolRank(a) - toolRank(b)).forEach(t => {
    add(stage0.filter(j => j.tool === t))          // инструмент проходит всё своё одним кратчайшим маршрутом, потом — смена
  })
  const stage1 = jobs.filter(j => j.stage === 1)
  const prevTool = seq[seq.length - 1]?.tool
  const cutTools = [...new Set(stage1.map(j => j.tool))].sort((a, b) => (b === prevTool) - (a === prevTool))
  cutTools.forEach(t => add(stage1.filter(j => j.tool === t && j.rank === 4 && !heldCutouts.has(j))))
  // Контуры деталей — одним кратчайшим маршрутом, см. routeContours
  const smallFirst = ops.outer?.smallFirst !== false
  const nestedState = { done: new Set(), cutoutsDone: new Set() }
  cutTools.forEach(t => {
    const own = stage1.filter(j => j.tool === t && j.rank === 5)
    const offcuts = (sheet.manualOffcuts || []).map(of => ({ box: [ox + of.x, oy + of.y, ox + of.x + of.w, oy + of.y + of.h], area: of.w * of.h / 1e6 }))
    // Последний рез каждой детали — по стороне, где ещё не резали, у самого крупного нетронутого куска (деталь или обрезок).
    // От этого меняются точки входа, поэтому маршрут строится ещё раз уже по ним — холостые переезды остаются короткими.
    let r = []
    for (let pass = 0; pass < 3; pass++) {
      r = routeContours(own, cur, sheetRect, smallFirst)
      lastCutToSupport(r, sheetRect, offcuts)
    }
    r = withNestedOrder(r, heldCutouts, nestedState)
    if (r.length) { seq.push(...r); cur = r[r.length - 1].at }
  })
  // вырезы с вложениями, которые так и не вышли (вложенная деталь без контура в программе) — в конце
  add([...heldCutouts].filter(c => !nestedState.cutoutsDone.has(c)))

  // обрезки отрезаются последними — когда все детали уже вырезаны
  cutTools.forEach(t => add(jobs.filter(j => j.stage === 2 && j.tool === t)))
  add(jobs.filter(j => j.stage === 2 && !cutTools.includes(j.tool)))

  const out = new Out(zTop ? T : 0)
  out.raw(post.cmdStart)
  let active = null, opId = 0
  const KIND = ['hole', 'hole', 'groove', 'pocket', 'cutout', 'outer', 'outer']
  const used = []
  for (const j of seq) {
    if (j.tool !== active) {
      if (inHead(post, j.tool)) { out.raw(tpl(post.cmdHeadStart, j.tool)); out.raw(tpl(post.cmdHeadEnd, j.tool)) }   // своя команда — включается голова, а не шпиндель
      else { out.raw(tpl(post.cmdToolStart, j.tool)); out.raw(tpl(post.cmdToolEnd, j.tool)) }
      out.pos = [null, null, null]
      active = j.tool
      if (!used.includes(j.tool)) used.push(j.tool)
    }
    out.tag = [KIND[j.rank], ++opId]
    j.run(out)
    out.tag = null
  }
  // конечное положение: шпиндель уходит в точку парковки на безопасной высоте
  if (seq.length && post.endX !== '' && post.endY !== '' && post.endX != null && post.endY != null) { out.g0(null, null, safeZ); out.g0(n0(post.endX), n0(post.endY), null) }
  out.raw(post.cmdEnd)
  if (!seq.length) warn.add('На листе нечего обрабатывать: не назначены инструменты.')
  return { text: out.lines.join('\n') + '\n', zShift: zTop ? T : 0, lines: out.lines.length, warnings: [...warn], tools: used, empty: !seq.length, kinds: out.kinds, opIds: out.opIds }
}
