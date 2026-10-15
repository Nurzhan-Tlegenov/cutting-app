// Структура модели (изделия → блоки → детали) и перемещение блоков в 3D.
// Блок двигается вдоль одной оси (остальные две «закреплены») и упирается в соседние детали:
// зазор между деталями — 0, заехать деталью в деталь нельзя. Если детали уже входят друг в друга
// (ошибка в модели), их можно развести — обратно они уже не заедут.
// Здесь только расчёты — без three.js и без React.
import { contourOf, frameOf, editSingles } from './model3dEdit.js'

const EPS = 0.05
const r2 = v => Math.round(v * 100) / 100

/** Дерево блоков: узел { key, name, children, parts (детали прямо в блоке), pids (все детали внутри) } */
export function blockTree(parts) {
  const root = { key: '', name: '', children: [], parts: [], pids: [] }
  const nodes = new Map([['', root]])
  const up = key => { const i = key.lastIndexOf(' / '); return i < 0 ? '' : key.slice(0, i) }
  const node = key => {
    if (nodes.has(key)) return nodes.get(key)
    const n = { key, name: key.slice(up(key) ? up(key).length + 3 : 0), children: [], parts: [], pids: [] }
    node(up(key)).children.push(n)
    nodes.set(key, n)
    return n
  }
  for (const p of parts) {
    const key = p.block || ''
    node(key).parts.push(p)
    for (let k = key; ; k = up(k)) { nodes.get(k).pids.push(p.pid); if (!k) break }
  }
  const cmp = (a, b) => String(a).localeCompare(String(b), 'ru', { numeric: true })
  for (const n of nodes.values()) {
    n.children.sort((a, b) => cmp(a.name, b.name))
    n.parts.sort((a, b) => cmp(a.des || a.pos || '', b.des || b.pos || '') || cmp(a.name, b.name))
  }
  return root
}

/** Габарит детали в модели: { min: [x, y, z], max: [x, y, z] } */
export function partBox(p) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [x, y] of p.outline) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
  const m = p.m, min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [0, p.t]) {
    for (let k = 0; k < 3; k++) {
      const v = m[k * 3] * x + m[k * 3 + 1] * y + m[k * 3 + 2] * z + m[9 + k]
      if (v < min[k]) min[k] = v
      if (v > max[k]) max[k] = v
    }
  }
  return { min, max }
}

/**
 * Фурнитура модели по штукам: [{ pid, hi, block, near }]. block — блок из файла (если записан при импорте),
 * иначе near — ближайшая панель: фурнитура двигается вместе с ней.
 */
export function hardwareLinks(model) {
  const out = []
  let boxes = null
  let n = 0
  for (const hw of model.hardware || []) {
    let c = null
    for (const it of hw.inst) {
      const pid = 'h' + n++
      if (it.b != null) { out.push({ pid, hi: it.hi, block: it.b, near: null }); continue }
      if (!c) {                                   // середина формы фурнитуры (в её системе)
        const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
        for (const g of hw.groups) for (let k = 0; k < g.pos.length; k++) { const v = g.pos[k], a = k % 3; if (v < lo[a]) lo[a] = v; if (v > hi[a]) hi[a] = v }
        c = [0, 1, 2].map(a => (lo[a] + hi[a]) / 2)
      }
      if (!boxes) boxes = (model.parts || []).filter(p => p.outline?.length > 2).map(p => ({ pid: p.pid, ...partBox(p) }))
      const m = it.m
      const w = [0, 1, 2].map(k => m[k * 3] * c[0] + m[k * 3 + 1] * c[1] + m[k * 3 + 2] * c[2] + m[9 + k])
      let best = null, bd = Infinity
      for (const b of boxes) {
        let d = 0
        for (let k = 0; k < 3; k++) { const e = Math.max(b.min[k] - w[k], 0, w[k] - b.max[k]); d += e * e }
        if (d < bd) { bd = d; best = b.pid }
      }
      out.push({ pid, hi: it.hi, block: null, near: best })
    }
  }
  return out
}

/** Что поедет вместе с выбранными деталями: они сами и фурнитура их блоков */
export function movingSet(sel, parts, links) {
  const out = new Set(sel)
  const full = new Map()
  // фурнитура часто лежит во вложенном блоке без панелей (ручка, петля) — поднимаемся до блока с панелями
  const blockFull = b => {
    if (full.has(b)) return full.get(b)
    let res = false
    for (let k = b; ; k = k.includes(' / ') ? k.slice(0, k.lastIndexOf(' / ')) : '') {
      const inside = k ? parts.filter(p => p.block === k || String(p.block || '').startsWith(k + ' / ')) : parts
      if (inside.length) { res = inside.every(p => sel.has(p.pid)); break }
      if (!k) break
    }
    full.set(b, res)
    return res
  }
  for (const h of links) if (h.block != null ? blockFull(h.block) : sel.has(h.near)) out.add(h.pid)
  return out
}

/**
 * Запретные интервалы сдвига вдоль оси axis (0 — X, 1 — Y, 2 — Z): при сдвиге внутри интервала
 * движущееся тело входит в неподвижное. Тела, которые только касаются по другим осям, не мешают.
 */
export function sweepLimits(moving, fixed, axis) {
  const other = [0, 1, 2].filter(k => k !== axis)
  const out = []
  for (const m of moving) for (const s of fixed) {
    if (other.some(k => Math.min(m.max[k], s.max[k]) - Math.max(m.min[k], s.min[k]) <= EPS)) continue
    const lo = s.min[axis] - m.max[axis], hi = s.max[axis] - m.min[axis]
    if (hi - lo > 2 * EPS) out.push([lo, hi, s])
  }
  return out
}

/**
 * Сдвиг из cur в target с упором: в запретный интервал заехать нельзя, выехать из него — можно.
 * -> { t (куда можно доехать), stop (неподвижное тело, в которое упёрлись, или null) }
 */
export function clampMove(limits, cur, target) {
  let t = target, stop = null
  const fwd = target > cur
  for (const [lo, hi, s] of limits) {
    if (fwd) {
      // впереди — тело, которое начинается не раньше текущего положения
      if (lo >= cur - EPS && t > lo) { t = Math.max(lo, cur); stop = s }
    } else if (hi <= cur + EPS && t < hi) { t = Math.min(hi, cur); stop = s }
  }
  return { t, stop }
}

const shiftM = (m, d) => m.map((v, i) => (i >= 9 ? r2(v + d[i - 9]) : v))

// Общая часть: применить преобразование положения (матрица m -> m) и точек (оси анимации) к отмеченным объектам.
// mv: { parts: Set('di:ii'), ids: Set(ID панелей), sceneParts: Set('si:ii'), extras: Set(xi), hardware: Set(hi) }
function transformModel(details, scene, mv, fm, fp) {
  const fa = a => (a ? { ...a, a: fp(a.a), b: fp(a.b) } : a)
  const moveMeta = (meta, hit) => {
    if (!meta?.inst?.some((_, ii) => hit(ii))) return null
    return {
      ...meta,
      inst: meta.inst.map((m, ii) => (hit(ii) ? fm(m) : m)),
      ...(meta.anims ? { anims: meta.anims.map((a, ii) => (hit(ii) ? fa(a) : a)) } : {}),
    }
  }
  const nextDetails = (details || []).map((row, di) => {
    const c = contourOf(row)
    const meta = moveMeta(c?.meta, ii => mv.parts.has(`${di}:${ii}`))
    if (!meta) return row
    const nc = { ...c, meta }
    return { ...row, contour: typeof row.contour === 'string' ? JSON.stringify(nc) : nc }
  })
  let nextScene = scene
  if (scene) {
    nextScene = {
      ...scene,
      parts: (scene.parts || []).map((sp, si) => {
        const c = contourOf(sp)
        const meta = moveMeta(c?.meta, ii => mv.sceneParts.has(`${si}:${ii}`) || (c.meta.ids?.[ii] != null && mv.ids.has(c.meta.ids[ii])))
        return meta ? { ...sp, contour: { ...c, meta } } : sp
      }),
      extras: (scene.extras || []).map((ex, xi) => (mv.extras.has(xi) ? { ...ex, m: fm(ex.m), ...(ex.anim ? { anim: fa(ex.anim) } : {}) } : ex)),
      hardware: (scene.hardware || []).map((hw, hi) => (mv.hardware.has(hi) ? { ...hw, m: fm(hw.m), ...(hw.anim ? { anim: fa(hw.anim) } : {}) } : hw)),
    }
  }
  return { details: nextDetails, scene: nextScene }
}

/** Сдвинуть отмеченные объекты модели на вектор d (мм). -> { details, scene } */
export function moveModel(details, scene, mv, d) {
  return transformModel(details, scene, mv, m => shiftM(m, d), p => p.map((v, k) => r2(v + d[k])))
}

/** Повернуть отмеченные объекты на turns×90° вокруг оси axis (0 — X, 1 — Y, 2 — Z), проходящей через точку center */
export function rotateModel(details, scene, mv, axis, turns, center) {
  const n = ((Math.round(turns) % 4) + 4) % 4
  if (!n) return { details, scene }
  const co = [1, 0, -1, 0][n], si = [0, 1, 0, -1][n]
  const u = (axis + 1) % 3, w = (axis + 2) % 3       // поворот в плоскости (u, w): u -> w
  const Q = [1, 0, 0, 0, 1, 0, 0, 0, 1]
  Q[u * 3 + u] = co; Q[u * 3 + w] = -si; Q[w * 3 + u] = si; Q[w * 3 + w] = co
  const rot = v => [0, 1, 2].map(r => Q[r * 3] * v[0] + Q[r * 3 + 1] * v[1] + Q[r * 3 + 2] * v[2])
  const pt = p => rot(p.map((v, k) => v - center[k])).map((v, k) => r2(v + center[k]))
  const fm = m => {
    const o = new Array(12)
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = Q[r * 3] * m[c] + Q[r * 3 + 1] * m[3 + c] + Q[r * 3 + 2] * m[6 + c]
    const t = pt([m[9], m[10], m[11]])
    o[9] = t[0]; o[10] = t[1]; o[11] = t[2]
    return o
  }
  return transformModel(details, scene, mv, fm, pt)
}

// ─── Изменение размера блока (растяжение) ───────────────────────────────────
// Блок режется плоскостью поперёк оси (посередине отмеченного). Всё, что целиком по «подвижную» сторону
// плоскости, сдвигается на величину изменения; детали, которые плоскость пересекает и которые лежат вдоль оси
// (полки при изменении ширины, стойки при изменении высоты), становятся длиннее или короче; остальное стоит.
// dir: +1 — закреплён «минус» (левый / нижний / задний край), двигается «плюс»; −1 — наоборот.

/** Что делать с каждым объектом: -> { move: Set(pid), stretch: Set(pid) } */
export function planStretch(boxes, pids, hw, axis, plane, dir) {
  const move = new Set(), stretch = new Set()
  for (const b of boxes) {
    if (!pids.has(b.pid)) continue
    const lo = b.min[axis], hi = b.max[axis]
    const along = Math.abs(b.p.m[axis * 3 + 2]) > 0.9            // пласть поперёк оси: растягивать нельзя (это толщина)
    const extra = b.p.xi != null
    if (lo < plane - 0.5 && hi > plane + 0.5 && (extra || !along)) { stretch.add(b.pid); continue }
    if (((lo + hi) / 2 - plane) * dir > 0) move.add(b.pid)
  }
  for (const h of hw) if (pids.has(h.pid) && (h.c[axis] - plane) * dir > 0) move.add(h.pid)
  return { move, stretch }
}

function reAnchor(it, lowS, highS, total, size, sh, newTotal) {
  const sides = it.sides || [], off = it.offsets || {}
  const lo = sides.includes(lowS), hi = sides.includes(highS)
  const a0 = lo ? (off[lowS] ?? 0) : hi ? total - (off[highS] ?? 0) - size : (total - size) / 2
  const a1 = lo && hi ? total - (off[highS] ?? 0) : a0 + size
  const b0 = sh(a0), b1 = sh(a1)
  // как встанет сам, если привязку не трогать
  const sizeNow = lo && hi ? null : size
  const c0 = lo ? (off[lowS] ?? 0) : hi ? newTotal - (off[highS] ?? 0) - size : (newTotal - size) / 2
  const c1 = lo && hi ? newTotal - (off[highS] ?? 0) : c0 + sizeNow
  if (Math.abs(c0 - b0) < 0.01 && Math.abs(c1 - b1) < 0.01) return { it, size: r2(b1 - b0) }
  const o = { ...off }
  delete o[highS]
  o[lowS] = r2(b0)
  return { it: { ...it, sides: [...sides.filter(x => x !== lowS && x !== highS), lowS], offsets: o }, size: r2(b1 - b0) }
}

/** Контур детали W×L растянуть вдоль оси редактора ax ('x' — ширина, 'y' — длина): всё дальше cut сдвигается на delta */
export function stretchContour(c, W, L, ax, cut, delta) {
  const sh = v => (v > cut + 1e-6 ? r2(v + delta) : v)
  const X = ax === 'x'
  const pt = v => (X ? { ...v, x: sh(Number(v.x) || 0) } : { ...v, y: sh(Number(v.y) || 0) })
  const pair = q => (X ? [sh(q[0]), q[1]] : [q[0], sh(q[1])])
  const lowS = X ? 'left' : 'bottom', highS = X ? 'right' : 'top'
  const total = X ? W : L, newTotal = total + delta
  const out = { ...c }
  if (Array.isArray(c.vertices) && c.vertices.length > 2) out.vertices = c.vertices.map(pt)
  if (Array.isArray(c.holes)) {
    out.holes = c.holes.map(h => {
      if (h.type === 'circle') {
        const d = Number(h.d) || 100
        const mid = reAnchor(h, lowS, highS, total, d, v => v, newTotal)        // круг не растягивается — только едет
        const sides = h.sides || [], off = h.offsets || {}
        const a0 = sides.includes(lowS) ? (off[lowS] ?? 0) : sides.includes(highS) ? total - (off[highS] ?? 0) - d : (total - d) / 2
        if (a0 + d / 2 > cut) return reAnchor(h, lowS, highS, total, d, v => r2(v + delta), newTotal).it
        return reAnchor(h, lowS, highS, total, d, v => v, newTotal).it || mid.it
      }
      const size = X ? (h.hw || 200) : (h.hh || 100)
      const r = reAnchor(h, lowS, highS, total, size, sh, newTotal)
      return { ...r.it, ...(X ? { hw: r.size } : { hh: r.size }), ...(Array.isArray(h.vertices) && h.vertices.length > 2 ? { vertices: h.vertices.map(pt) } : {}) }
    })
  }
  if (Array.isArray(c.grooves)) {
    out.grooves = c.grooves.map(g => {
      const hor = g.dir === 'horizontal'
      const alongGroove = hor === X                       // ось растяжения идёт вдоль паза — меняется его длина
      const size = alongGroove ? (g.length || 100) : (g.width || 8)
      if (alongGroove) { const r = reAnchor(g, lowS, highS, total, size, sh, newTotal); return { ...r.it, length: r.size } }
      // паз поперёк оси: целиком едет или стоит
      const sides = g.sides || [], off = g.offsets || {}
      const a0 = sides.includes(lowS) ? (off[lowS] ?? 0) : sides.includes(highS) ? total - (off[highS] ?? 0) - size : (total - size) / 2
      return reAnchor(g, lowS, highS, total, size, a0 + size / 2 > cut ? v => r2(v + delta) : v => v, newTotal).it
    })
  }
  if (Array.isArray(c.layout)) out.layout = c.layout.map(g => (((g.kind === 'upright') === X) && (Number(g.pos) || 0) > cut ? { ...g, pos: r2(g.pos + delta) } : g))
  if (Array.isArray(c.decor)) out.decor = c.decor.map(dc => ({ ...dc, polys: (dc.polys || []).map(pl => pl.map(pair)), ...(dc.path ? { path: dc.path.map(pair) } : {}) }))
  return out
}

/** Одну штуку (деталь с одним положением в модели) растянуть вдоль оси мира. Не получилось — вернётся та же деталь */
export function stretchDetail(d, axis, plane, dir, delta) {
  const f = frameOf(d, 0), c = contourOf(d)
  if (!f || !c) return d
  const a = [0, 0, 0]; a[axis] = 1
  const l = f.panelVec(a)                                      // ось мира в системе панели
  const xp = f.turned ? -l[1] : l[0]
  const e = [f.flipped ? -xp : xp, f.turned ? l[0] : l[1]]     // ...и в координатах редактора (X — ширина, Y — длина)
  const ax = Math.abs(e[0]) > 0.99 ? 'x' : Math.abs(e[1]) > 0.99 ? 'y' : null
  if (!ax) return d
  const P = [0, 0, 0]; P[axis] = plane
  const q = f.panel(P), ed = f.fromLocal(q[0], q[1])
  const cut = ax === 'x' ? ed[0] : ed[1]
  const total = ax === 'x' ? f.W : f.L
  if (!(total + delta > 1) || cut <= 0 || cut >= total) return d
  const highMoves = (ax === 'x' ? e[0] : e[1]) * dir > 0       // двигается дальний от начала координат редактора край
  const W2 = ax === 'x' ? f.W + delta : f.W, L2 = ax === 'y' ? f.L + delta : f.L
  const local = { ...c.meta.local }
  if ((ax === 'x') !== f.turned) local.dx = r2(local.dx + delta); else local.dy = r2(local.dy + delta)
  // в редакторе начало координат всегда в левом нижнем углу: тянется дальний край, а деталь при необходимости сдвигается в модели
  const nc = { ...stretchContour(c, f.W, f.L, ax, cut, delta), meta: { ...c.meta, local } }
  const form = 'w' in d || 'h' in d
  let nd = { ...d, ...(form ? { w: r2(L2), h: r2(W2) } : { length: r2(L2), width: r2(W2) }), contour: typeof d.contour === 'string' ? JSON.stringify(nc) : nc }
  const f2 = frameOf(nd, 0)
  const A = highMoves ? [0, 0] : [f.W, f.L], A2 = highMoves ? [0, 0] : [W2, L2]
  const w0 = f.world([...f.toLocal(A[0], A[1]), 0]), w1 = f2.world([...f2.toLocal(A2[0], A2[1]), 0])
  const sh = [w0[0] - w1[0], w0[1] - w1[1], w0[2] - w1[2]]
  if (sh.some(v => Math.abs(v) > 1e-6)) {
    const meta = { ...nc.meta, inst: [shiftM(nc.meta.inst[0], sh)] }
    const nc2 = { ...nc, meta }
    nd = { ...nd, contour: typeof d.contour === 'string' ? JSON.stringify(nc2) : nc2 }
  }
  return nd
}

/**
 * Растянуть: st — { parts: Set(pid деталей заказа), sceneParts: Set('si:ii'), extras: Set(xi) }.
 * Сдвиг «подвижной» стороны делается отдельно (moveModel) — до растяжения.
 */
export function stretchModel(details, scene, st, axis, plane, dir, delta) {
  let nextDetails = details
  if (st.parts.size) {
    nextDetails = editSingles(details, st.parts, singles => {
      for (const pid of st.parts) { const d = singles.get(pid); if (d) singles.set(pid, stretchDetail(d, axis, plane, dir, delta)) }
    })
  }
  let nextScene = scene
  if (scene && (st.sceneParts.size || st.extras.size)) {
    const parts = []
    ;(scene.parts || []).forEach((sp, si) => {
      const c = contourOf(sp), n = c?.meta?.inst?.length || 0
      if (![...Array(n).keys()].some(ii => st.sceneParts.has(`${si}:${ii}`))) { parts.push(sp); return }
      // строка делится на штуки: растянутые становятся отдельными строками
      const keep = []
      for (let ii = 0; ii < n; ii++) {
        if (!st.sceneParts.has(`${si}:${ii}`)) { keep.push(ii); continue }
        const meta = { ...c.meta, inst: [c.meta.inst[ii]], ...(c.meta.ids ? { ids: [c.meta.ids[ii]] } : {}), ...(c.meta.anims ? { anims: [c.meta.anims[ii] ?? null] } : {}) }
        parts.push(stretchDetail({ ...sp, qty: 1, contour: { ...c, meta } }, axis, plane, dir, delta))
      }
      if (keep.length) {
        const meta = { ...c.meta, inst: keep.map(i => c.meta.inst[i]), ...(c.meta.ids ? { ids: keep.map(i => c.meta.ids[i]) } : {}), ...(c.meta.anims ? { anims: keep.map(i => c.meta.anims[i] ?? null) } : {}) }
        parts.push({ ...sp, contour: { ...c, meta } })
      }
    })
    const extras = (scene.extras || []).map((ex, xi) => {
      if (!st.extras.has(xi)) return ex
      const m = ex.m
      const l = [m[axis * 3], m[axis * 3 + 1], m[axis * 3 + 2]]      // ось мира в системе профиля (R^T · a)
      const o = [m[9], m[10], m[11]]
      const cutL = k => { const P = [0, 0, 0]; P[axis] = plane; return m[0 * 3 + k] * (P[0] - o[0]) + m[1 * 3 + k] * (P[1] - o[1]) + m[2 * 3 + k] * (P[2] - o[2]) }
      if (Math.abs(l[2]) > 0.99) {                             // профиль вытянут вдоль оси: меняется его длина
        if (!(ex.t + delta > 1)) return ex
        const originMoves = dir * Math.sign(l[2]) < 0          // двигается тот конец, где начало профиля
        const d3 = [0, 0, 0]; d3[axis] = dir * delta
        return { ...ex, t: r2(ex.t + delta), m: originMoves ? shiftM(m, d3) : m }
      }
      const k = Math.abs(l[0]) > 0.99 ? 0 : Math.abs(l[1]) > 0.99 ? 1 : -1
      if (k < 0) return ex
      const c = cutL(k), sgn = Math.sign(l[k]) * dir             // в какую сторону по местной оси лежит подвижная часть
      const mv = q => { const v = [...q]; if ((v[k] - c) * sgn > 1e-6) v[k] = r2(v[k] + sgn * delta); return v }
      return { ...ex, outline: ex.outline.map(mv), holes: (ex.holes || []).map(h => h.map(mv)) }
    })
    nextScene = { ...scene, parts, extras }
  }
  return { details: nextDetails, scene: nextScene }
}
