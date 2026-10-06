// Правка заказа прямо в 3D-модели: кромка по торцам, присадка по стыкам деталей,
// автоматические «корпуса» (группы соприкасающихся деталей).
//
// Каждая штука в модели — отдельное тело со своим положением (contour.meta.inst[i]),
// а в заказе одинаковые штуки лежат одной строкой с количеством. Поэтому правка идёт так:
// затронутые строки раскладываются на отдельные штуки, правка применяется к каждой,
// после чего одинаковые штуки снова склеиваются в строки (см. editSingles).
// Здесь только расчёты — без three.js и без React, чтобы можно было проверять отдельно.
import { contourSegments, segmentSide } from './edgeLength.js'
import { getDrillPoints } from './drillGeometry.js'
import { flipDetail } from './mirrorDetail.js'
import { makePidGen } from './model3d.js'

const num = v => Number(v) || 0
const r1 = v => Math.round(v * 10) / 10
const SIDES = ['left', 'right', 'bottom', 'top']
const SIDE_N = { left: [-1, 0], right: [1, 0], bottom: [0, -1], top: [0, 1] }

export function contourOf(d) {
  let c = d?.contour
  if (typeof c === 'string') { try { c = JSON.parse(c) } catch { c = null } }
  return c || null
}

function hash(str) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) }
  return (h >>> 0).toString(36)
}

// ─── Система координат штуки ────────────────────────────────────────────────
// Редактор: X — ширина, Y — длина, (0,0) — левый нижний угол. Панель в модели: x, y — пласть, z — толщина.
export function frameOf(d, ii = 0) {
  const c = contourOf(d), meta = c?.meta
  const m = meta?.inst?.[ii]
  if (!m || !meta.local) return null
  const { x0, y0, dx, dy } = meta.local
  const T = num(meta.thickness) || 16
  const turned = !!meta.turned, flipped = !!meta.flipped
  const W = turned ? dy : dx, L = turned ? dx : dy
  const toLocal = (X, Y) => {
    const x = flipped ? W - X : X
    return turned ? [Y + x0, dy - x + y0] : [x + x0, Y + y0]
  }
  const fromLocal = (lx, ly) => {
    const x = turned ? dy - (ly - y0) : lx - x0
    const Y = turned ? lx - x0 : ly - y0
    return [flipped ? W - x : x, Y]
  }
  const vecLocal = (vx, vy) => {
    const x = flipped ? -vx : vx
    return turned ? [vy, -x] : [x, vy]
  }
  const world = p => [m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[9], m[3] * p[0] + m[4] * p[1] + m[5] * p[2] + m[10], m[6] * p[0] + m[7] * p[1] + m[8] * p[2] + m[11]]
  const worldVec = v => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]]
  // обратное преобразование (матрица поворота ортогональна)
  const panelVec = v => [m[0] * v[0] + m[3] * v[1] + m[6] * v[2], m[1] * v[0] + m[4] * v[1] + m[7] * v[2], m[2] * v[0] + m[5] * v[1] + m[8] * v[2]]
  const panel = p => panelVec([p[0] - m[9], p[1] - m[10], p[2] - m[11]])
  return { m, T, W, L, x0, y0, dx, dy, turned, flipped, frontZ: flipped ? 0 : T, toLocal, fromLocal, vecLocal, world, worldVec, panel, panelVec }
}

const rectVerts = (W, L) => [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: L }, { x: 0, y: L }]
const vertsOf = (c, W, L) => (Array.isArray(c?.vertices) && c.vertices.length > 2 ? c.vertices : rectVerts(W, L))
const edgesOf = d => d.edges || { top: d.edge_top || null, right: d.edge_right || null, bottom: d.edge_bottom || null, left: d.edge_left || null }
const withEdges = (d, e) => (d.edges || !('edge_top' in d) ? { ...d, edges: e } : { ...d, edge_top: e.top || null, edge_right: e.right || null, edge_bottom: e.bottom || null, edge_left: e.left || null })
const edgeOn = v => !!v && v !== 'false'

function isRectVerts(verts, W, L) {
  return verts.length === 4 && verts.every(v => !v.type && !(v.r > 0) &&
    (Math.abs(v.x) < 0.1 || Math.abs(v.x - W) < 0.1) && (Math.abs(v.y) < 0.1 || Math.abs(v.y - L) < 0.1))
}

/**
 * Детали заказа по штукам: [{ pid, di, ii, f (система координат), segs, rect, name }].
 * segs — участки внешнего контура: { i, a, b, side, arc, len, n (нормаль наружу, в координатах редактора), on (стоит кромка) }.
 */
export function orderParts(details) {
  const pidOf = makePidGen()
  const out = []
  ;(details || []).forEach((d, di) => {
    const c = contourOf(d), meta = c?.meta
    if (!meta?.inst?.length || !meta.local) return
    const f0 = frameOf(d, 0)
    const verts = vertsOf(c, f0.W, f0.L)
    let area = 0
    const poly = verts.filter(v => v.type !== 'arc')
    poly.forEach((v, k) => { const w = poly[(k + 1) % poly.length]; area += num(v.x) * num(w.y) - num(w.x) * num(v.y) })
    const ccw = area >= 0
    const sides = edgesOf(d)
    const segs = contourSegments(verts).map(s => {
      const a = s.pts[0], b = s.pts[s.pts.length - 1]
      const ex = b[0] - a[0], ey = b[1] - a[1], l = Math.hypot(ex, ey) || 1
      const side = segmentSide(s, f0.W, f0.L)
      return { i: s.key, a, b, pts: s.pts, side, arc: s.arc, len: s.len, n: ccw ? [ey / l, -ex / l] : [-ey / l, ex / l], on: (side && edgeOn(sides[side])) || !!s.edge }
    })
    meta.inst.forEach((_, ii) => {
      const pid = pidOf(meta, ii, di)
      out.push({ pid, di, ii, f: ii ? frameOf(d, ii) : f0, segs, rect: isRectVerts(verts, f0.W, f0.L), holes: (c.holes || []).length, name: d.name || meta.name || '', block: [meta.product, ...(Array.isArray(meta.path) ? meta.path : [])].filter(Boolean).join(' / ') })
    })
  })
  return out
}

/** Торец участка в модели: 4 угла (мир), центр, нормаль наружу (мир), up — направление толщины (мир) */
export function segFace(part, seg) {
  const { f } = part
  const [ax, ay] = f.toLocal(seg.a[0], seg.a[1]), [bx, by] = f.toLocal(seg.b[0], seg.b[1])
  const nl = f.vecLocal(seg.n[0], seg.n[1])
  const quad = [f.world([ax, ay, 0]), f.world([bx, by, 0]), f.world([bx, by, f.T]), f.world([ax, ay, f.T])]
  const center = f.world([(ax + bx) / 2, (ay + by) / 2, f.T / 2])
  return { quad, center, normal: f.worldVec([nl[0], nl[1], 0]), up: f.worldVec([0, 0, 1]) }
}

/** Что под пальцем: ближайший участок контура (или вырез) к точке в системе панели. -> { seg } | { hole } | null */
export function edgeTargetAt(detail, ii, local) {
  const f = frameOf(detail, ii)
  if (!f) return null
  const c = contourOf(detail)
  const [X, Y] = f.fromLocal(local[0], local[1])
  const dist = pts => {
    let best = Infinity
    for (let k = 1; k < pts.length; k++) {
      const [ax, ay] = pts[k - 1], [bx, by] = pts[k]
      const ex = bx - ax, ey = by - ay, l2 = ex * ex + ey * ey || 1
      const t = Math.max(0, Math.min(1, ((X - ax) * ex + (Y - ay) * ey) / l2))
      best = Math.min(best, Math.hypot(X - ax - ex * t, Y - ay - ey * t))
    }
    return best
  }
  let best = null
  for (const s of contourSegments(vertsOf(c, f.W, f.L))) {
    const dd = dist(s.pts)
    if (!best || dd < best.d) best = { d: dd, seg: s.key }
  }
  ;(c.holes || []).forEach((h, k) => {
    let pts
    if (h.type === 'circle') {
      const pos = holeBox(h, f.W, f.L)
      const r = (num(h.d) || 100) / 2
      const dd = Math.abs(Math.hypot(X - (pos.x + r), Y - (pos.y + r)) - r)
      if (!best || dd < best.d) best = { d: dd, hole: k }
      return
    }
    if (Array.isArray(h.vertices) && h.vertices.length > 2) pts = [...h.vertices, h.vertices[0]].filter(v => v.type !== 'arc').map(v => [num(v.x), num(v.y)])
    else { const b = holeBox(h, f.W, f.L); pts = [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h], [b.x, b.y]] }
    const dd = dist(pts)
    if (!best || dd < best.d) best = { d: dd, hole: k }
  })
  if (!best || best.d > 3) return null
  return best.hole != null ? { hole: best.hole } : { seg: best.seg }
}
function holeBox(h, W, L) {
  const w = h.type === 'circle' ? num(h.d) || 100 : num(h.hw) || 200, hh = h.type === 'circle' ? num(h.d) || 100 : num(h.hh) || 100
  const sides = h.sides || [], o = h.offsets || {}
  let x = (W - w) / 2, y = (L - hh) / 2
  if (sides.includes('left')) x = o.left ?? 0; else if (sides.includes('right')) x = W - w - (o.right ?? 0)
  if (sides.includes('bottom')) y = o.bottom ?? 0; else if (sides.includes('top')) y = L - hh - (o.top ?? 0)
  return { x, y, w, h: hh }
}

// ─── Раскладка строк на штуки и обратная склейка ────────────────────────────
const clone = v => (v == null ? v : JSON.parse(JSON.stringify(v)))
const stripKey = (k, v) => (k === 'ids' || k === 'inst' || k === 'anims' ? undefined : v)

function isPlain(d) {
  const c = contourOf(d), f = frameOf(d, 0)
  if (!c || !f) return false
  const verts = vertsOf(c, f.W, f.L)
  return isRectVerts(verts, f.W, f.L) && !verts.some(v => v.edge) && !(c.holes || []).length && !(c.grooves || []).length &&
    !(c.drillings || []).length && !(c.layout || []).length && !(c.decor || []).length
}

// Прямоугольная деталь без обработки симметрична: её можно «положить» четырьмя способами.
// Выбираем тот, при котором кромка записана одинаково у одинаковых штук — тогда они остаются одной строкой.
const SYM = [[1, 1, 1], [-1, -1, 1], [1, -1, -1], [-1, 1, -1]]
function canonFrame(d) {
  if (!isPlain(d)) return d
  const f = frameOf(d, 0), edges = edgesOf(d)
  if (!SIDES.some(s => edgeOn(edges[s]))) return d
  const nl = {}
  for (const s of SIDES) nl[s] = f.vecLocal(SIDE_N[s][0], SIDE_N[s][1])
  let best = null
  for (const S of SYM) {
    const e = {}
    for (const s of SIDES) {
      const v = [nl[s][0] * S[0], nl[s][1] * S[1]]
      const q = SIDES.find(k => nl[k][0] * v[0] + nl[k][1] * v[1] > 0.9)
      e[s] = edges[q] || null
    }
    const key = ['left', 'bottom', 'right', 'top'].map(s => (edgeOn(e[s]) ? String(e[s]) : '￿')).join('|')
    if (!best || key < best.key) best = { key, S, e }
  }
  if (best.S === SYM[0]) return d
  const { m } = f, S = best.S
  const s0 = [(1 - S[0]) * (f.x0 + f.dx / 2), (1 - S[1]) * (f.y0 + f.dy / 2), (1 - S[2]) * f.T / 2]
  const t = f.world(s0)
  const m2 = [m[0] * S[0], m[1] * S[1], m[2] * S[2], m[3] * S[0], m[4] * S[1], m[5] * S[2], m[6] * S[0], m[7] * S[1], m[8] * S[2], t[0], t[1], t[2]]
    .map((v, i) => (i < 9 ? Math.round(v * 1e6) / 1e6 : Math.round(v * 100) / 100))
  const c = contourOf(d)
  return withEdges({ ...d, contour: { ...c, meta: { ...c.meta, inst: [m2] } } }, best.e)
}

/**
 * Правка по штукам. pids — какие штуки затронуты; fn(singles) — singles: Map pid -> деталь из одной штуки
 * (её можно заменять: singles.set(pid, новая)). Возвращает новый список деталей заказа.
 * Новые строки (когда строка разделилась) приходят без uid — страница заказа выдаёт им свой.
 */
export function editSingles(details, pids, fn) {
  const pidOf = makePidGen()
  const rows = []                 // { d, pids: [...] } по строкам заказа
  ;(details || []).forEach((d, di) => {
    const meta = contourOf(d)?.meta
    const list = meta?.inst?.length && meta.local ? meta.inst.map((_, ii) => pidOf(meta, ii, di)) : []
    rows.push({ d, pids: list })
  })
  const singles = new Map()
  const touched = rows.filter(r => r.pids.some(p => pids.has(p)))
  for (const r of touched) {
    const c = clone(contourOf(r.d))
    r.pids.forEach((pid, ii) => {
      const meta = { ...c.meta, inst: [c.meta.inst[ii]], ids: c.meta.ids ? [c.meta.ids[ii]] : undefined, anims: c.meta.anims ? [c.meta.anims[ii] ?? null] : undefined }
      if (!meta.ids) delete meta.ids
      if (!meta.anims) delete meta.anims
      singles.set(pid, { ...r.d, ...(r.d.edges ? { edges: { ...r.d.edges } } : {}), qty: 1, contour: { ...clone({ ...c, meta: undefined }), meta } })
    })
  }
  fn(singles)
  const out = []
  for (const r of rows) {
    if (!touched.includes(r)) { out.push(r.d); continue }
    const groups = new Map()
    for (const pid of r.pids) {
      const s = canonFrame(singles.get(pid))
      const c = contourOf(s)
      const key = JSON.stringify([s.w ?? s.length, s.h ?? s.width, edgesOf(s), c], stripKey)
      const g = groups.get(key)
      if (!g) { groups.set(key, { s, c, n: 1 }); continue }
      g.n++
      const gm = g.c.meta, sm = c.meta
      gm.inst.push(...sm.inst)
      if (gm.ids || sm.ids) gm.ids = [...(gm.ids || []), ...(sm.ids || [])]
      if (gm.anims || sm.anims) gm.anims = [...(gm.anims || []), ...(sm.anims || [])]
    }
    const extra = Math.max(0, num(r.d.qty) - r.pids.length)      // количество в заказе больше, чем штук в модели
    let first = true
    for (const g of groups.values()) {
      const stored = typeof r.d.contour === 'string' ? JSON.stringify(g.c) : g.c
      const row = { ...g.s, contour: stored, qty: g.n + (first ? extra : 0) }
      if (!first) { delete row.uid; delete row.id; if ('dbId' in row) row.dbId = null }
      out.push(row)
      first = false
    }
  }
  return out
}

// ─── Кромка ─────────────────────────────────────────────────────────────────
/** ops: [{ pid, seg (номер начальной вершины участка) | hole (номер выреза), value: название | null }] */
export function applyEdgeOps(details, ops) {
  if (!ops.length) return details
  const byPid = new Map()
  for (const op of ops) { if (!byPid.has(op.pid)) byPid.set(op.pid, []); byPid.get(op.pid).push(op) }
  return editSingles(details, new Set(byPid.keys()), singles => {
    for (const [pid, list] of byPid) {
      let d = singles.get(pid)
      if (!d) continue
      const c = contourOf(d), f = frameOf(d, 0)
      const explicit = Array.isArray(c.vertices) && c.vertices.length > 2
      const verts = vertsOf(c, f.W, f.L)
      const segs = contourSegments(verts)
      const edges = { ...edgesOf(d) }
      for (const op of list) {
        const val = op.value || null
        if (op.hole != null) { if (c.holes?.[op.hole]) { if (val) c.holes[op.hole].edge = val; else delete c.holes[op.hole].edge } continue }
        const s = segs.find(x => x.key === op.seg)
        if (!s) continue
        const side = segmentSide(s, f.W, f.L)
        if (side) {
          edges[side] = val
          if (explicit && !val) delete c.vertices[s.i][s.prop]
        } else if (explicit) { if (val) c.vertices[s.i][s.prop] = val; else delete c.vertices[s.i][s.prop] }
      }
      d = withEdges({ ...d, contour: c }, edges)
      singles.set(pid, d)
    }
  })
}

// ─── Стыки: торец одной детали прилегает к пласти другой ────────────────────

/**
 * parts — из orderParts. tol — допустимый зазор между торцом и пластью, мм.
 * -> [{ key, a (pid), seg, side, b (pid), face ('front'|'back'), rect {X1,X2,Y1,Y2} (в координатах редактора детали b),
 *       kind ('shelf' — полоса вдоль X, 'upright' — вдоль Y), quad (мир, 4 угла пятна), ok (можно ставить присадку),
 *       thin (одна из деталей тоньше 10 мм — задняя стенка и т. п.) }]
 */
export function findJoints(parts, tol = 0.6) {
  const out = []
  // габариты в мире — чтобы не сравнивать далёкие детали
  const boxes = parts.map(p => {
    const { f } = p, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
    for (const x of [f.x0, f.x0 + f.dx]) for (const y of [f.y0, f.y0 + f.dy]) for (const z of [0, f.T]) {
      const w = f.world([x, y, z])
      for (let k = 0; k < 3; k++) { if (w[k] < lo[k]) lo[k] = w[k]; if (w[k] > hi[k]) hi[k] = w[k] }
    }
    return { lo, hi }
  })
  const near = (i, j) => { for (let k = 0; k < 3; k++) if (boxes[i].lo[k] > boxes[j].hi[k] + tol || boxes[j].lo[k] > boxes[i].hi[k] + tol) return false; return true }
  parts.forEach((A, ia) => {
    for (const seg of A.segs) {
      if (seg.arc || seg.len < 10) continue
      const face = segFace(A, seg)
      parts.forEach((B, ib) => {
        if (ia === ib || !near(ia, ib)) return
        const fb = B.f
        const nb = fb.panelVec(face.normal)
        if (Math.abs(nb[2]) < 0.999) return
        const q = face.quad.map(fb.panel)
        const z = q[0][2]
        if (q.some(p => Math.abs(p[2] - z) > 0.3)) return
        const atTop = Math.abs(z - fb.T) <= tol, atBottom = Math.abs(z) <= tol
        if (!atTop && !atBottom) return
        // торец должен смотреть В пласть (детали снаружи друг от друга, а не одна в другой)
        if (atTop ? nb[2] > 0 : nb[2] < 0) return
        const e = q.map(p => fb.fromLocal(p[0], p[1]))
        let X1 = Math.min(...e.map(p => p[0])), X2 = Math.max(...e.map(p => p[0]))
        let Y1 = Math.min(...e.map(p => p[1])), Y2 = Math.max(...e.map(p => p[1]))
        const fullLen = Math.max(X2 - X1, Y2 - Y1)
        // пятно должно быть вдоль оси детали b (косые стыки не размечаем)
        if (Math.abs(fullLen - seg.len) > 0.5 || Math.abs(Math.min(X2 - X1, Y2 - Y1) - A.f.T) > 0.5) return
        X1 = Math.max(0, X1); Y1 = Math.max(0, Y1); X2 = Math.min(fb.W, X2); Y2 = Math.min(fb.L, Y2)
        const w = X2 - X1, h = Y2 - Y1
        if (Math.max(w, h) < 10 || Math.min(w, h) < A.f.T * 0.5) return
        const zf = atTop ? fb.T : 0
        const quad = [[X1, Y1], [X2, Y1], [X2, Y2], [X1, Y2]].map(([X, Y]) => { const l = fb.toLocal(X, Y); return fb.world([l[0], l[1], zf]) })
        const sideLen = seg.side === 'left' || seg.side === 'right' ? A.f.L : A.f.W
        const whole = !!seg.side && Math.abs(seg.len - sideLen) < 1          // торец — вся сторона детали
        const clipped = Math.max(w, h) < fullLen - 1                          // торец выходит за деталь b
        out.push({
          key: `${A.pid}|${seg.i}>${B.pid}`, a: A.pid, seg: seg.i, side: seg.side, b: B.pid,
          face: Math.abs(zf - fb.frontZ) < 0.01 ? 'front' : 'back',
          rect: { X1: r1(X1), X2: r1(X2), Y1: r1(Y1), Y2: r1(Y2) }, kind: w >= h ? 'shelf' : 'upright',
          quad, ta: A.f.T, thin: A.f.T < 10 || fb.T < 10, ok: whole && !clipped, why: !whole ? 'фигурный торец' : clipped ? 'торец выходит за деталь' : '',
        })
      })
    }
  })
  return out
}

// ─── Корпуса: группы деталей, соединённых стыками ───────────────────────────
/**
 * -> Map pid -> номер группы. Большие детали, которые связывают между собой отдельные корпуса
 * (столешница, цоколь, стеновая панель), в корпус не входят — каждая из них сама по себе.
 */
export function partGroups(parts, joints) {
  const n = parts.length, idx = new Map(parts.map((p, i) => [p.pid, i]))
  const adj = parts.map(() => new Set())
  for (const j of joints) { const a = idx.get(j.a), b = idx.get(j.b); if (a != null && b != null) { adj[a].add(b); adj[b].add(a) } }
  const label = (excl) => {
    const lab = new Array(n).fill(-1), size = []
    for (let s = 0; s < n; s++) {
      if (lab[s] >= 0 || excl.has(s)) continue
      const id = size.length; let cnt = 0
      const st = [s]; lab[s] = id
      while (st.length) { const v = st.pop(); cnt++; for (const w of adj[v]) if (lab[w] < 0 && !excl.has(w)) { lab[w] = id; st.push(w) } }
      size.push(cnt)
    }
    return { lab, size }
  }
  // деталь p — «связка», если без неё её соседи распадаются на несколько корпусов (от 3 деталей)
  const splits = (excl, p) => {
    const { lab, size } = label(new Set([...excl, p]))
    const seen = new Set()
    for (const w of adj[p]) if (lab[w] >= 0 && size[lab[w]] >= 3) seen.add(lab[w])
    return seen.size >= 2
  }
  const big = parts.map(p => Math.hypot(p.f.dx, p.f.dy))
  const med = [...big].sort((a, b) => a - b)[Math.floor(n / 2)] || 0
  const cand = big.map((v, i) => i).filter(i => big[i] > med * 1.3 && adj[i].size >= 2).sort((a, b) => big[b] - big[a]).slice(0, 14)
  const removed = new Set()
  for (const p of cand) if (splits(removed, p)) removed.add(p)
  for (let a = 0; a < cand.length; a++) for (let b = a + 1; b < cand.length; b++) {
    const p = cand[a], q = cand[b]
    if (removed.has(p) || removed.has(q)) continue
    if (splits(new Set([...removed, q]), p) && splits(new Set([...removed, p]), q)) { removed.add(p); removed.add(q) }
  }
  const { lab, size } = label(removed)
  const res = new Map()
  let next = size.length
  parts.forEach((p, i) => res.set(p.pid, removed.has(i) ? next++ : lab[i]))
  return res
}

// ─── Присадка по стыкам ─────────────────────────────────────────────────────
// Встроенные схемы — на случай, когда своих в базе фурнитуры ещё нет
export const BUILTIN_SCHEMES = [
  { id: 'builtin:confirmat', name: 'Конфирмат 7×50 (отступ 50)', builtin: true,
    face: { d: 7, depth: 100, faceSide: 'front', sides: ['left'], offsets: { left: 50 }, mirrorX: true },
    edge: { d: 5, depth: 40, edgeSide: 'left', alongFrom: 'start', offsetAlong: 50, mirrorY: true } },
  { id: 'builtin:dowel', name: 'Шкант 8×30 (отступ 50)', builtin: true,
    face: { d: 8, depth: 12, faceSide: 'front', sides: ['left'], offsets: { left: 50 }, mirrorX: true },
    edge: { d: 8, depth: 20, edgeSide: 'left', alongFrom: 'start', offsetAlong: 50, mirrorY: true } },
  { id: 'builtin:pair', name: 'Конфирмат + шкант (отступ 50, шаг 32)', builtin: true,
    face: { d: 7, depth: 100, faceSide: 'front', sides: ['left'], offsets: { left: 50 }, mirrorX: true, pairEnabled: true, pairD: 8, pairDepth: 12, pairAxis: 'x', pairGap: 32, pairMirrorSwap: false },
    edge: { d: 5, depth: 40, edgeSide: 'left', alongFrom: 'start', offsetAlong: 50, mirrorY: true, pairEnabled: true, pairD: 8, pairDepth: 20, pairGap: 32, pairMirrorSwap: false } },
]
// старые записи базы фурнитуры — плоские { d, depth }
export const schemeFace = hp => hp.face || (hp.d != null && !hp.edge ? { d: hp.d, depth: hp.depth, faceSide: 'front' } : null)
export const schemeEdge = hp => hp.edge || (hp.d != null && !hp.face ? { d: hp.d, depth: hp.depth } : null)

// вдоль какой оси записана схема для пласти: 'x' — как у полки, 'y' — как у стойки
function specAxis(fs) {
  const s = fs.sides || []
  const hx = s.includes('left') || s.includes('right'), hy = s.includes('top') || s.includes('bottom')
  if (hx && !hy) return 'x'
  if (hy && !hx) return 'y'
  if (fs.mirrorX && !fs.mirrorY) return 'x'
  if (fs.mirrorY && !fs.mirrorX) return 'y'
  if (fs.row) return fs.rowDir === 'y' ? 'y' : 'x'
  return 'x'
}
const SWAP = { left: 'bottom', right: 'top', bottom: 'left', top: 'right' }
function swapAxes(fs) {
  const o = { ...fs }
  o.sides = (fs.sides || []).map(s => SWAP[s] || s)
  o.offsets = {}
  for (const [k, v] of Object.entries(fs.offsets || {})) o.offsets[SWAP[k] || k] = v
  o.mirrorX = fs.mirrorY; o.mirrorY = fs.mirrorX
  o.baseFixedX = fs.baseFixedY; o.baseFixedY = fs.baseFixedX
  o.mirrorMinX = fs.mirrorMinY; o.mirrorMinY = fs.mirrorMinX
  if (fs.rowDir) o.rowDir = fs.rowDir === 'y' ? 'x' : 'y'
  if (fs.pairAxis) o.pairAxis = fs.pairAxis === 'y' ? 'x' : 'y'
  if (Array.isArray(fs.extraHoles)) o.extraHoles = fs.extraHoles.map(eh => (eh.kind === 'face' && eh.axis ? { ...eh, axis: eh.axis === 'y' ? 'x' : 'y' } : eh))
  return o
}
const defined = o => { const r = {}; for (const [k, v] of Object.entries(o)) if (v !== undefined) r[k] = v; return r }

function guideOf(j) {
  const { X1, X2, Y1, Y2 } = j.rect
  return j.kind === 'shelf'
    ? { kind: 'shelf', pos: r1(Y1), thickness: r1(Y2 - Y1), insetLeft: r1(X1), insetRight: 0, _far: X2 }
    : { kind: 'upright', pos: r1(X1), thickness: r1(X2 - X1), insetBottom: r1(Y1), insetTop: 0, _far: Y2 }
}
const sameGuide = (g, q) => (g.kind === 'upright') === (q.kind === 'upright') && Math.abs(num(g.pos) - q.pos) < 0.3 && Math.abs(num(g.thickness) - q.thickness) < 0.3 &&
  (q.kind === 'upright' ? Math.abs(num(g.insetBottom) - q.insetBottom) < 0.3 && Math.abs(num(g.insetTop) - q.insetTop) < 0.3
    : Math.abs(num(g.insetLeft) - q.insetLeft) < 0.3 && Math.abs(num(g.insetRight) - q.insetRight) < 0.3)

// точки отверстий присадки в мире: торцевые — на торце, в пласть — на пласти
function edgeHolesWorld(d, dr) {
  const f = frameOf(d, 0)
  let pts
  try { pts = getDrillPoints(dr, f.W, f.L, []) } catch { pts = [] }
  const zf = dr.offsetFace ?? f.T / 2
  return pts.filter(p => !p.isFaceType).map(p => { const l = f.toLocal(p.x, p.y); return f.world([l[0], l[1], f.flipped ? zf : f.T - zf]) })
}
function faceHolesWorld(d, dr, z) {
  const f = frameOf(d, 0), c = contourOf(d)
  let pts
  try { pts = getDrillPoints(dr, f.W, f.L, c.layout || []) } catch { pts = [] }
  return pts.map(p => { const l = f.toLocal(p.x, p.y); return f.world([l[0], l[1], z]) })
}
// сколько отверстий не нашли пары на другой детали
function mismatch(A, B, plane) {
  // сравниваем в плоскости стыка: проекции на пласть детали b
  const flat = p => { const q = plane.panel(p); return [q[0], q[1]] }
  const a = A.map(flat), b = B.map(flat)
  const used = new Set()
  let miss = 0
  for (const p of a) {
    let hit = -1
    b.forEach((q, k) => { if (hit < 0 && !used.has(k) && Math.hypot(p[0] - q[0], p[1] - q[1]) <= 1.2) hit = k })
    if (hit < 0) miss++; else used.add(hit)
  }
  return miss + (b.length - used.size)
}

/**
 * Поставить присадку на стыки по схеме из базы фурнитуры.
 * joints — из findJoints (только ok); scheme — { id, name, face, edge }.
 * -> { details, joints (сколько стыков), holes (отверстий), unmatched (стыков, где отверстия не сошлись), flipped }
 */
export function applyJoints(details, joints, scheme) {
  const fsRaw = scheme ? schemeFace(scheme) : null, es = scheme ? schemeEdge(scheme) : null
  const use = joints.filter(j => j.ok)
  const pids = new Set()
  for (const j of use) { pids.add(j.a); pids.add(j.b) }
  const stat = { joints: 0, holes: 0, unmatched: 0, flipped: 0 }
  const next = editSingles(details, pids, singles => {
    const facePids = new Set()
    for (const j of use) {
      let A = singles.get(j.a), B = singles.get(j.b)
      if (!A || !B) continue
      const ca = contourOf(A), cb = contourOf(B), fa = frameOf(A, 0), fb = frameOf(B, 0)
      ca.drillings = ca.drillings || []; cb.drillings = cb.drillings || []; cb.layout = cb.layout || []
      const mine = dr => !!dr.j3d && dr.kind === 'edge' && dr.edgeSide === j.side      // присадка 3D в этом торце
      // прежняя присадка 3D на этом стыке заменяется новой
      const q = guideOf(j)
      if (q.kind === 'shelf') q.insetRight = r1(fb.W - q._far); else q.insetTop = r1(fb.L - q._far)
      delete q._far
      const old = cb.layout.filter(g => g.j3d && sameGuide(g, q)).map(g => g.id)
      cb.layout = cb.layout.filter(g => !old.includes(g.id))
      cb.drillings = cb.drillings.filter(dr => !(dr.j3d && (dr.attachTo || []).some(id => old.includes(id))))
      const hadEdge = ca.drillings.some(mine)
      ca.drillings = ca.drillings.filter(dr => !mine(dr))
      if (!scheme) { if (old.length || hadEdge) stat.joints++; continue }       // только убрать

      // — деталь b: линия разметки по пятну стыка + присадка в пласть, привязанная к ней —
      let drB = null
      const gid = 'g3' + hash(JSON.stringify(q))
      if (fsRaw) {
        const along = q.kind === 'shelf' ? 'x' : 'y'
        const fs = specAxis(fsRaw) === along ? fsRaw : swapAxes(fsRaw)
        const through = num(fs.depth) >= fb.T - 0.05
        cb.layout.unshift({ id: gid, ...q, j3d: 1 })
        drB = defined({
          id: 'd3' + hash(gid + '|' + scheme.id), installed: true, kind: 'face',
          face: through ? 'front' : j.face, d: fs.d ?? 8, depth: through ? fb.T : fs.depth ?? 13,
          sides: fs.sides || [], offsets: fs.offsets || {}, attachTo: [gid], gap: fs.gap ?? 0, gapDir: fs.gapDir || 'pos',
          row: !!fs.row, rowDir: fs.rowDir || along, rowStep: fs.rowStep ?? 32, rowCount: fs.rowCount ?? 2,
          mirrorX: fs.mirrorX, mirrorY: fs.mirrorY, pitchEnabled: fs.pitchEnabled, pitchStep: fs.pitchStep,
          baseFixedX: fs.baseFixedX, baseFixedY: fs.baseFixedY, mirrorMinX: fs.mirrorMinX, mirrorMinY: fs.mirrorMinY,
          pairEnabled: fs.pairEnabled, pairD: fs.pairD, pairDepth: fs.pairDepth, pairAxis: fs.pairAxis, pairGap: fs.pairGap, pairMirrorSwap: fs.pairMirrorSwap,
          pairFace: fs.pairEnabled ? j.face : undefined,         // сквозное сверлится с лица, глухое парное — со стороны стыка
          extraHoles: fs.extraHoles?.length ? fs.extraHoles.map(eh => (eh.kind === 'face' ? { ...eh, face: j.face } : eh)) : undefined,
          hardwareId: scheme.builtin ? undefined : scheme.id, note: scheme.name, j3d: 1,
        })
        cb.drillings.unshift(drB)
        facePids.add(j.b)
      }
      // — деталь a: присадка в торец —
      if (es) {
        const alongIsX = j.side === 'top' || j.side === 'bottom'
        const wasX = es.edgeSide === 'top' || es.edgeSide === 'bottom'
        const mirrorAlong = wasX ? !!es.mirrorX : !!es.mirrorY
        const centered = !num(fsRaw?.gap)
        let drA = defined({
          id: 'd3' + hash('e:' + j.side + '|' + scheme.id), installed: true, kind: 'edge', edgeSide: j.side,
          alongFrom: es.alongFrom || 'start', offsetAlong: es.offsetAlong ?? 50,
          offsetFace: centered || es.offsetFace == null || es.offsetFace >= fa.T ? r1(fa.T / 2) : es.offsetFace,
          d: es.d ?? 5, depth: es.depth ?? 35, row: !!es.row, rowStep: es.rowStep ?? 32, rowCount: es.rowCount ?? 2,
          mirrorX: alongIsX ? mirrorAlong : false, mirrorY: alongIsX ? false : mirrorAlong,
          pitchEnabled: es.pitchEnabled, pitchStep: es.pitchStep, baseFixed: es.baseFixed, mirrorMinAlong: es.mirrorMinAlong,
          pairEnabled: es.pairEnabled, pairD: es.pairD, pairDepth: es.pairDepth, pairGap: es.pairGap, pairMirrorSwap: es.pairMirrorSwap,
          pairKind: es.pairKind, pairFace: es.pairFace, pairFaceOffsetIn: es.pairFaceOffsetIn,
          extraHoles: es.extraHoles?.length ? es.extraHoles : undefined,
          hardwareId: scheme.builtin ? undefined : scheme.id, note: scheme.name, j3d: 1,
        })
        // отверстия торца должны попасть в отверстия пласти: если не сходятся — пробуем отсчёт с другого конца
        if (drB) {
          B = { ...B, contour: cb }
          const zb = j.face === 'front' ? fb.frontZ : fb.T - fb.frontZ
          const hb = faceHolesWorld(B, drB, zb)
          // несимметричная схема: отсчёт может идти с другого конца торца, а парное отверстие — в другую сторону
          const other = drA.alongFrom === 'end' ? 'start' : 'end'
          const variants = [drA, { ...drA, alongFrom: other }]
          if (drA.pairEnabled && drA.pairKind !== 'face') variants.push({ ...drA, pairGap: -(drA.pairGap ?? 32) }, { ...drA, alongFrom: other, pairGap: -(drA.pairGap ?? 32) })
          let best = Infinity
          for (const v of variants) {
            const mm = mismatch(edgeHolesWorld({ ...A, contour: ca }, v), hb, fb)
            if (mm < best) { best = mm; drA = v }
            if (!mm) break
          }
          if (best) stat.unmatched++
          stat.holes += hb.length
        } else stat.holes += edgeHolesWorld({ ...A, contour: ca }, drA).length
        ca.drillings.unshift(drA)
      } else if (drB) stat.holes += faceHolesWorld({ ...B, contour: cb }, drB, 0).length
      stat.joints++
      singles.set(j.a, { ...A, contour: ca })
      singles.set(j.b, { ...singles.get(j.b), contour: cb })
    }
    // Лицевой становится пласть с глухой присадкой: если вся она с изнанки — деталь переворачивается
    for (const pid of facePids) {
      const d = singles.get(pid), c = contourOf(d), f = frameOf(d, 0)
      let front = 0, back = 0
      const add = (face, depth) => { if (num(depth) >= f.T - 0.05 || face === 'both') return; if (face === 'back') back++; else front++ }
      for (const dr of c.drillings || []) {
        if (dr.kind === 'edge' || dr.installed === false) continue
        add(dr.face, dr.depth)
        if (dr.pairEnabled) add(dr.pairFace ?? dr.face, dr.pairDepth ?? dr.depth)
        for (const eh of dr.extraHoles || []) if (eh.kind === 'face') add(eh.face, eh.depth)
      }
      for (const g of c.grooves || []) { if (g.face === 'back') back++; else front++ }
      if (back > front) { singles.set(pid, flipDetail({ ...d, edges: edgesOf(d) }, f.T)); stat.flipped++ }
    }
  })
  return { details: next, ...stat }
}

/** Убрать присадку, поставленную в 3D, со стыков */
export const clearJoints = (details, joints) => applyJoints(details, joints, null)

/** На каких стыках уже стоит присадка из 3D: Set ключей */
export function jointsDone(details, parts, joints) {
  const byPid = new Map(parts.map(p => [p.pid, p]))
  const done = new Set()
  for (const j of joints) {
    const A = byPid.get(j.a), B = byPid.get(j.b)
    if (!A || !B) continue
    const ca = contourOf(details[A.di]), cb = contourOf(details[B.di])
    const q = guideOf(j)
    if (q.kind === 'shelf') q.insetRight = r1(B.f.W - q._far); else q.insetTop = r1(B.f.L - q._far)
    if ((ca?.drillings || []).some(dr => dr.j3d && dr.kind === 'edge' && dr.edgeSide === j.side) || (cb?.layout || []).some(g => g.j3d && sameGuide(g, q))) done.add(j.key)
  }
  return done
}
