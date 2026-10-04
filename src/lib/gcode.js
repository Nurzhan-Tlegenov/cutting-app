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

function bboxOf(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [x, y] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
  return { x0, y0, x1, y1 }
}
const isAxisRect = (pts, bb) => pts.length === 4 && pts.every(([x, y]) => (Math.abs(x - bb.x0) < EPS || Math.abs(x - bb.x1) < EPS) && (Math.abs(y - bb.y0) < EPS || Math.abs(y - bb.y1) < EPS))

/** Всё, что надо обработать на уложенной детали p — в её локальных координатах на листе (как p.polygon), мм, Y вверх */
export function partFeatures(p, detail, T) {
  const outline = Array.isArray(p.polygon) && p.polygon.length > 2 ? p.polygon.map(q => [q.x, q.y]) : [[0, 0], [p.origX, 0], [p.origX, p.origY], [0, p.origY]]
  const f = { outline, pw: p.origX, ph: p.origY, cutouts: [], pockets: [], grooves: [], holes: [], skipped: { edge: 0, back: 0, odd: 0 } }
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
      if (hole.face === 'back') { f.skipped.back++; return }
      if (!isAxisRect(pts, bb)) { f.skipped.odd++; return }
      f.pockets.push({ ...bb, open: open(bb), depth: Number(hole.depth) || 10 })
      return
    }
    // вырез, выходящий на край детали, уже вошёл в её контур — отдельно не режем
    if (!pts.every(q => pointInPoly(q, outline) && distToLoop(q, outline) > 0.3)) return
    if (hole.type === 'circle') f.cutouts.push({ circle: { cx: (bb.x0 + bb.x1) / 2, cy: (bb.y0 + bb.y1) / 2, r: (bb.x1 - bb.x0) / 2 } })
    else f.cutouts.push({ pts })
  })
  ;(contour.grooves || []).forEach(g => { if (g.face === 'back') f.skipped.back++ })
  getGrooveRects(contour, W, H, true).forEach(r => {
    const bb = bboxOf(r.pts.map(([x, y]) => at(x, y)))
    f.grooves.push({ ...bb, open: open(bb), depth: r.depth || 0, width: r.width })
  })
  ;(contour.drillings || []).forEach(dr => { if (dr.installed !== false && dr.kind !== 'edge' && dr.face === 'back') f.skipped.back++ })
  getAllDrillPoints(contour, W, H, true).forEach(pt => {
    if (pt.edge) { f.skipped.edge++; return }
    const q = at(pt.x, pt.y), d = pt.d || 8, depth = pt.depth > 0 ? pt.depth : T
    f.holes.push({ x: q[0], y: q[1], d, depth, key: holeKey(d, depth, T) })
  })
  return f
}

/** Слои обработки, которые есть на листах — для вкладки «Обработка контуров» */
export function collectLayers(sheets, details, T) {
  const holes = new Map(), pockets = new Map()
  const out = { holes: [], pockets: [], grooves: 0, cutouts: 0, parts: 0, edgeHoles: 0, backOps: 0, oddPockets: 0 }
  for (const sh of sheets || []) for (const p of sh.placed || []) {
    const f = partFeatures(p, details?.[p.detailIndex], T)
    out.parts++; out.cutouts += f.cutouts.length; out.grooves += f.grooves.length
    out.edgeHoles += f.skipped.edge; out.backOps += f.skipped.back; out.oddPockets += f.skipped.odd
    for (const h of f.holes) {
      const cur = holes.get(h.key) || { key: h.key, d: h.d, depth: Math.min(h.depth, T), through: h.depth >= T - EPS, count: 0 }
      cur.count++; holes.set(h.key, cur)
    }
    for (const k of f.pockets) {
      const key = pocketKey(k.depth)
      const cur = pockets.get(key) || { key, depth: k.depth, count: 0 }
      cur.count++; pockets.set(key, cur)
    }
  }
  out.holes = [...holes.values()].sort((a, b) => a.d - b.d || a.depth - b.depth)
  out.pockets = [...pockets.values()].sort((a, b) => a.depth - b.depth)
  return out
}

const toolById = (cnc, id) => (cnc.tools || []).find(t => t.id === id) || null
/** Инструмент слоя отверстий: назначенный, а если не назначали — сверло того же диаметра */
export function holeToolFor(layer, cnc) {
  const o = cnc.ops?.holes?.[layer.key]
  if (o?.tool === 'none') return null
  if (o?.tool) return toolById(cnc, o.tool)
  const d = n0(o?.d) || layer.d
  return (cnc.tools || []).find(t => t.type === 'drill' && Math.abs(n0(t.d) - d) < EPS) || null
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
export function rectPaths(x0, y0, x1, y1, open, r, step) {
  let cx0 = open.l ? x0 : x0 + r, cx1 = open.r ? x1 : x1 - r, cy0 = open.b ? y0 : y0 + r, cy1 = open.t ? y1 : y1 - r
  if (cx0 > cx1 + 0.3 || cy0 > cy1 + 0.3) return null
  if (cx0 > cx1 - 0.3) cx0 = cx1 = (cx0 + cx1) / 2
  if (cy0 > cy1 - 0.3) cy0 = cy1 = (cy0 + cy1) / 2
  const w = cx1 - cx0, h = cy1 - cy0
  if (w === 0 && h === 0) return { point: [cx0, cy0] }
  if (w === 0 || h === 0) return { line: [[cx0, cy0], [cx1, cy1]] }
  const finish = [[cx0, cy0], [cx0, cy1], [cx1, cy1], [cx1, cy0]]         // по часовой
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
  constructor() { this.lines = []; this.kinds = []; this.opIds = []; this.tag = null; this.f = null; this.pos = [null, null, null] }
  push(line) { this.lines.push(line); this.kinds.push(this.tag ? this.tag[0] : null); this.opIds.push(this.tag ? this.tag[1] : 0) }
  raw(text) { String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean).forEach(s => this.push(s)); this.f = null }
  move(g, x, y, z, feed) {
    let s = g
    if (x != null && y != null && (x !== this.pos[0] || y !== this.pos[1])) { s += ` X${fmt(x)} Y${fmt(y)}`; this.pos[0] = x; this.pos[1] = y }
    if (z != null && z !== this.pos[2]) { s += ` Z${fmt(z)}`; this.pos[2] = z }
    if (s === g) return
    if (feed && Math.round(feed) !== this.f) { s += ` F${Math.round(feed)}`; this.f = Math.round(feed) }
    this.push(s)
  }
  g0(x, y, z) { this.move('G0', x, y, z) }
  g1(x, y, z, feed) { this.move('G1', x, y, z, feed) }
}
function levels(top, bottom, maxPass) {
  const n = Math.max(1, Math.ceil((top - bottom) / (maxPass > 0 ? maxPass : 1e9) - 1e-9))
  return Array.from({ length: n }, (_, i) => top - (top - bottom) * (i + 1) / n)
}
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
function cutLoop(out, passes, top, tool, op, safeZ) {
  const feed = n0(tool.feed) || 1000, inFeed = n0(tool.inFeed) || feed, outFeed = n0(tool.outFeed) || feed
  const ramp = op.entry !== 'straight'
  const tan = Math.tan(Math.max(1, Math.min(89, n0(op.angle) || 45)) * Math.PI / 180)
  let cur = null, M = null, zPrev = 0
  passes.forEach((ps, k) => {
    const last = k === passes.length - 1, z = ps.z
    if (ps.loop !== cur) {
      const m = loopMetric(ps.loop)
      if (!(m.per > 0)) return
      if (cur) out.g0(null, null, safeZ)
      cur = ps.loop; M = m
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
    for (let i = 1; i < M.n; i++) stops.add(M.cum[i])
    for (let i = 1; i <= kIn; i++) stops.add(inLen * i / kIn)
    for (let i = 0; i < kOut; i++) stops.add(D - outLen + outLen * i / kOut)
    let prev = 0
    for (const d of [...stops].filter(d => d > 1e-6).sort((a, b) => a - b)) {
      if (d - prev < 1e-6) continue
      const mid = (d + prev) / 2
      let f = feed
      if (kIn && mid < inLen) f = inFeed + (feed - inFeed) * (Math.floor(mid / (inLen / kIn)) + 1) / (kIn + 1)
      else if (kOut && mid > D - outLen) f = feed + (outFeed - feed) * (Math.floor((mid - (D - outLen)) / (outLen / kOut)) + 1) / kOut
      const q = M.at(d)
      out.g1(q[0], q[1], z, f)
      prev = d
    }
    zPrev = z
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

/** Прямоугольная выборка / паз на глубины zs */
function cutRect(out, paths, zs, tool, safeZ) {
  const feed = n0(tool.feed) || 1000, inFeed = n0(tool.inFeed) || feed
  const start = paths.point || paths.line?.[0] || paths.rough?.[0] || paths.finish[0]
  out.g0(start[0], start[1], safeZ)
  zs.forEach((z, k) => {
    if (k) out.g1(start[0], start[1], null, feed)
    out.g1(null, null, z, inFeed)
    if (paths.line) out.g1(paths.line[1][0], paths.line[1][1], null, feed)
    if (paths.rough) paths.rough.forEach(q => out.g1(q[0], q[1], null, feed))
    if (paths.finish) [...paths.finish, paths.finish[0]].forEach(q => out.g1(q[0], q[1], null, feed))
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
function shortenTravel(items, from, fixed = 0) {
  const n = items.length
  if (n - fixed < 3) return items
  const R = items.slice(), pt = i => (i < 0 ? from : R[i].at), d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1])
  for (let round = 0, better = true; better && round < 60; round++) {
    better = false
    for (let i = fixed; i < n - 1; i++) for (let j = i + 1; j < n; j++) {
      const a = pt(i - 1), b = pt(i), c = pt(j), e = j + 1 < n ? pt(j + 1) : null
      if (d(a, c) + (e ? d(b, e) : 0) < d(a, b) + (e ? d(c, e) : 0) - 1e-6) {
        for (let l = i, r = j; l < r; l++, r--) { const t = R[l]; R[l] = R[r]; R[r] = t }
        better = true
      }
    }
  }
  return R
}

/**
 * G-код одного листа.
 * sheet — лист из раскроя, geo — геометрия листа (sheetGeo), details — детали материала, thickness — толщина,
 * cnc — настройки (см. cncSettings.js).  -> { text, lines, warnings, tools }
 */
export function buildSheetGcode({ sheet, geo, details, thickness, cnc }) {
  const post = cnc.posts.find(p => p.id === cnc.post) || cnc.posts[0]
  const T = Number(thickness) || 16
  const warn = new Set()
  const ox = n0(post.originX) + (geo.marginL || 0), oy = n0(post.originY) + (geo.marginB || 0)
  let safeZ = n0(post.safeZ) || 25
  if (safeZ < T + 5) { warn.add(`Высота безопасности Z${num(safeZ)} ниже верха материала ${num(T)} мм + 5 мм — в программе поднята до Z${num(T + 5)}.`); safeZ = T + 5 }
  if (n0(post.fieldX) && n0(post.originX) + geo.sheetW > n0(post.fieldX) + EPS) warn.add(`Лист по X (${num(n0(post.originX) + geo.sheetW)} мм) выходит за рабочее поле станка ${num(post.fieldX)} мм.`)
  if (n0(post.fieldY) && n0(post.originY) + geo.sheetL > n0(post.fieldY) + EPS) warn.add(`Лист по Y (${num(n0(post.originY) + geo.sheetL)} мм) выходит за рабочее поле станка ${num(post.fieldY)} мм.`)
  const millOver = Math.max(0, n0(post.millOver)), drillOver = Math.max(0, n0(post.drillOver))
  const ops = cnc.ops
  const smallArea = n0(ops.outer?.smallArea) > 0 ? n0(ops.outer.smallArea) : 0.12      // мельче — «мелкая деталь», режется первой
  const sheetRect = { x0: n0(post.originX), y0: n0(post.originY), x1: n0(post.originX) + geo.sheetW, y1: n0(post.originY) + geo.sheetL }
  const tool = id => toolById(cnc, id)
  const jobs = []                    // { stage, rank, tool, at: [x, y], area, run(out) }
  const miss = {}                    // на что не назначен инструмент -> сколько раз
  const noTool = what => { miss[what] = (miss[what] || 0) + 1 }
  let edge = 0, back = 0, odd = 0

  for (const p of sheet.placed || []) {
    const f = partFeatures(p, details?.[p.detailIndex], T)
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
        jobs.push({ stage: 0, rank: 0, tool: t, at: c, run: out => { out.g0(c[0], c[1], safeZ); out.g1(null, null, z, n0(t.feed) || 1000); out.g0(null, null, safeZ) } })
      } else {
        const R = (d - n0(t.d)) / 2
        if (R < -EPS) { warn.add(`Фреза Ø${num(t.d)} больше отверстия Ø${num(d)} — ${label} пропущены.`); continue }
        const zs = levels(T, through ? -millOver : T - depth, n0(t.maxPass))
        const st = Math.max(0.5, Math.min(n0(t.step) || n0(t.d) / 2, n0(t.d) * 0.95))
        const rings = Math.max(1, Math.ceil(R / st - 1e-9))
        const radii = R <= EPS ? [] : through ? [R] : Array.from({ length: rings }, (_, i) => R * (i + 1) / rings)
        jobs.push({ stage: 0, rank: 1, tool: t, at: c, run: out => {
          const feed = n0(t.feed) || 1000, inFeed = n0(t.inFeed) || feed
          const s = through && radii.length ? [c[0] + R, c[1]] : c
          out.g0(s[0], s[1], safeZ)
          zs.forEach((z, k) => {
            if (k) out.g1(s[0], s[1], null, feed)
            out.g1(null, null, z, inFeed)
            radii.forEach(r => { const L = circleLoop(c[0], c[1], r); [...L, L[0]].forEach(q => out.g1(q[0], q[1], null, feed)) })
          })
          out.g0(null, null, safeZ)
        } })
      }
    }
    // пазы и выборки
    const rects = [...f.grooves.map(g => ({ ...g, t: tool(ops.groove?.tool), rank: 2, label: 'пазы' })),
      ...f.pockets.map(k => ({ ...k, t: tool(ops.pockets?.[pocketKey(k.depth)]?.tool), rank: 3, label: `выемки глубиной ${num(k.depth)}` }))]
    for (const k of rects) {
      if (!k.t) { noTool(k.label); continue }
      if (k.t.type !== 'mill') { warn.add(`На ${k.label} назначено сверло — нужна фреза.`); continue }
      const paths = rectPaths(bx + k.x0, by + k.y0, bx + k.x1, by + k.y1, k.open, n0(k.t.d) / 2, n0(k.t.step))
      if (!paths) { warn.add(`Фреза Ø${num(k.t.d)} шире, чем ${k.label} (${num(Math.min(k.x1 - k.x0, k.y1 - k.y0))} мм) — пропущено.`); continue }
      const zs = levels(T, k.depth >= T - EPS ? -millOver : T - k.depth, n0(k.t.maxPass))
      jobs.push({ stage: 0, rank: k.rank, tool: k.t, at: [bx + k.x0, by + k.y0], run: out => cutRect(out, paths, zs, k.t, safeZ) })
    }
    // вырезы — фреза идёт внутри контура
    for (const c of f.cutouts) {
      const t = tool(ops.cutout?.tool)
      if (!t) { noTool('контур выреза'); continue }
      if (t.type !== 'mill') { warn.add('На контур выреза назначено сверло — нужна фреза.'); continue }
      const r = n0(t.d) / 2
      const loop = c.circle ? (c.circle.r - r > 0.2 ? circleLoop(c.circle.cx, c.circle.cy, c.circle.r - r) : null) : offsetLoop(c.pts, -r)
      if (!loop) { warn.add(`Фреза Ø${num(t.d)} не проходит в вырез — он пропущен.`); continue }
      const L = orientLoop(loop.map(G), ops.cutout.dir)
      const zs = levels(T, -millOver, n0(t.maxPass))
      jobs.push({ stage: 1, rank: 4, tool: t, at: L[0], run: out => cutLoop(out, zs.map(z => ({ loop: L, z })), T, t, ops.cutout, safeZ) })
    }
    // контур детали — фреза идёт снаружи
    {
      const t = tool(ops.outer?.tool), o = ops.outer
      if (!t) noTool('контур детали')
      else if (t.type !== 'mill') warn.add('На контур детали назначено сверло — нужна фреза.')
      else {
        const r = n0(t.d) / 2, base = offsetLoop(f.outline, r)
        if (!base) warn.add('Не удалось построить обход контура одной из деталей — она пропущена.')
        else {
          const L = orientFromInside(base.map(G), o.dir, sheetRect)
          const area = Math.abs(signedArea(f.outline)) / 1e6, small = area <= smallArea
          const N = Math.max(1, Math.round(n0(o.passes) || 1))
          let passes
          if (N > 1 && (!o.smallOnly || small)) {
            // первые проходы — с припуском по контуру и остатком по глубине, последний — начисто
            const allow = Math.max(0, n0(o.sideAllow)), left = Math.max(0, Math.min(T - 0.5, n0(o.leftover)))
            const rough = allow > 0 ? offsetLoop(f.outline, r + allow) : null
            const Lr = rough ? orientFromInside(rough.map(G), o.dir, sheetRect) : L
            passes = [...levels(T, left, Math.min(n0(t.maxPass) || 1e9, (T - left) / (N - 1) + 1e-6)).map(z => ({ loop: Lr, z })), { loop: L, z: -millOver }]
          } else passes = levels(T, -millOver, n0(t.maxPass)).map(z => ({ loop: L, z }))
          const bb = bboxOf(f.outline)
          const edgeDist = Math.min(geo.marginL + p.x + bb.x0, geo.sheetW - (geo.marginL + p.x + bb.x1), geo.marginB + p.y + bb.y0, geo.sheetL - (geo.marginB + p.y + bb.y1))
          jobs.push({ stage: 1, rank: 5, tool: t, at: L[0], small, edgeDist, run: out => cutLoop(out, passes, T, t, o, safeZ) })
        }
      }
    }
  }
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
  const stage0 = jobs.filter(j => j.stage === 0)
  ;[...new Set(stage0.map(j => j.tool))].sort((a, b) => toolRank(a) - toolRank(b)).forEach(t => {
    [0, 1, 2, 3].forEach(rank => add(stage0.filter(j => j.tool === t && j.rank === rank)))
  })
  const stage1 = jobs.filter(j => j.stage === 1)
  const prevTool = seq[seq.length - 1]?.tool
  const cutTools = [...new Set(stage1.map(j => j.tool))].sort((a, b) => (b === prevTool) - (a === prevTool))
  cutTools.forEach(t => add(stage1.filter(j => j.tool === t && j.rank === 4)))
  // Контуры деталей. Обработка всегда начинается с детали у края листа.
  // Мелкие — первыми, от края листа внутрь (сначала все, что у самого края, затем следующий ряд).
  // Остальные — по кратчайшему маршруту, без переездов из конца в конец станка.
  const EDGE_BAND = 3                                    // мм: детали на таком же расстоянии от края — «один ряд»
  const atEdgeFirst = list => {                          // ближайшая к фрезе деталь из тех, что у самого края
    if (!list.length) return list
    const me = Math.min(...list.map(j => j.edgeDist))
    let bi = 0, bd = Infinity
    list.forEach((j, i) => { if (j.edgeDist > me + EDGE_BAND) return; const d = Math.hypot(j.at[0] - cur[0], j.at[1] - cur[1]); if (d < bd) { bd = d; bi = i } })
    return [list[bi], ...list.filter((_, i) => i !== bi)]
  }
  const fromEdge = list => {
    let left = list.slice()
    while (left.length) {
      const me = Math.min(...left.map(j => j.edgeDist))
      const band = left.filter(j => j.edgeDist <= me + EDGE_BAND)
      left = left.filter(j => !band.includes(j))
      add(band)
    }
  }
  cutTools.forEach(t => {
    const outer = stage1.filter(j => j.tool === t && j.rank === 5)
    fromEdge(outer.filter(j => j.small))
    const big = atEdgeFirst(outer.filter(j => !j.small))
    if (big.length) {
      const startsHere = !seq.some(j => j.rank === 5)      // мелких не было — начинаем с детали у края
      const o = startsHere ? [big[0], ...nearestOrder(big.slice(1), big[0].at)] : nearestOrder(big, cur)
      const r = shortenTravel(o, cur, startsHere ? 1 : 0)
      seq.push(...r); cur = r[r.length - 1].at
    }
  })

  const out = new Out()
  out.raw(post.cmdStart)
  let active = null, opId = 0
  const KIND = ['hole', 'hole', 'groove', 'pocket', 'cutout', 'outer']
  const used = []
  for (const j of seq) {
    if (j.tool !== active) {
      out.raw(tpl(post.cmdToolStart, j.tool)); out.raw(tpl(post.cmdToolEnd, j.tool))
      out.pos = [null, null, null]
      active = j.tool
      if (!used.includes(j.tool)) used.push(j.tool)
    }
    out.tag = [KIND[j.rank], ++opId]
    j.run(out)
    out.tag = null
  }
  out.raw(post.cmdEnd)
  if (!seq.length) warn.add('На листе нечего обрабатывать: не назначены инструменты.')
  return { text: out.lines.join('\n') + '\n', lines: out.lines.length, warnings: [...warn], tools: used, empty: !seq.length, kinds: out.kinds, opIds: out.opIds }
}
