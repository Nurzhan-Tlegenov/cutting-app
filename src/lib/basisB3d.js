// Чтение модели Базис-Мебельщик (.b3d, формат BZ85) прямо в браузере.
// Берём панели (листовой материал): размеры, контур с вырезами, кромку,
// пазы и присадку. Присадки в файле как таковой нет — в нём лежит крепёж
// со своими отверстиями в 3D; сверловку каждой панели получаем так же, как
// сам Базис: пересечением отверстий крепежа с панелью.
//
// Формат (восстановлен по файлу версии 2025.12):
//   'BZ85', затем секции: 01 00 00 ff <флаг>; флаг 0 — дерево как есть
//   (заголовок и миниатюра), флаг 1 — zlib-поток с деревом модели.
//   Дерево: таблица имён (u64 n, затем n-1 строк: u32 длина + ASCII),
//   узел = u32 имя (1-based, ffffffff — элемент списка), u32 число детей, u8 тип:
//   0 объект, 1 false, 2 true, 3 u8, 4 i32, 5 double, 6 строка UTF-16
//   (u32 число символов), 7 блоб (u32 длина), 8 пусто, 9 дата (double).
//   Контур — блоб: u32 n, элементы: 0x10 отрезок (x1 y1 x2 y2),
//   0x11 окружность (cx cy r), 0x12 дуга (центр, начало, конец, u8 ccw).
import { inflateSync } from 'fflate'

const EPS = 0.05
const TYPE_PANEL = 4002
const TYPE_FASTENER = 3001

// ---------- Дерево ----------

function readKeys(dv, u8, p) {
  const n = dv.getUint32(p, true); p += 8
  const keys = [null]
  for (let i = 1; i < n; i++) {
    const l = dv.getUint32(p, true); p += 4
    let s = ''
    for (let j = 0; j < l; j++) s += String.fromCharCode(u8[p + j])
    keys.push(s); p += l
  }
  return { keys, p }
}

const utf16 = new TextDecoder('utf-16le')

function parseTree(u8, start, skipKeys) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  const { keys, p: p0 } = readKeys(dv, u8, start)
  let p = p0
  const node = (build) => {
    const k = dv.getUint32(p, true), n = dv.getUint32(p + 4, true), t = u8[p + 8]
    p += 9
    const key = k === 0xffffffff ? '' : keys[k]
    if (key === undefined) throw new Error('Неизвестная структура файла')
    if (t === 0) {
      const b = build && !skipKeys.has(key)
      const c = b ? [] : null
      for (let i = 0; i < n; i++) { const ch = node(b); if (b) c.push(ch) }
      return b ? { k: key, c } : null
    }
    let v = null
    switch (t) {
      case 1: v = false; break
      case 2: v = true; break
      case 3: v = u8[p]; p += 1; break
      case 4: v = dv.getInt32(p, true); p += 4; break
      case 5: case 9: v = dv.getFloat64(p, true); p += 8; break
      case 6: { const l = dv.getUint32(p, true); p += 4; if (build) v = utf16.decode(u8.subarray(p, p + 2 * l)); p += 2 * l; break }
      case 7: { const l = dv.getUint32(p, true); p += 4; if (build) v = u8.subarray(p, p + l); p += l; break }
      case 8: break
      default: throw new Error('Неизвестный тип данных в файле (' + t + ')')
    }
    return build ? { k: key, v } : null
  }
  const root = node(true)
  return { root, end: p }
}

const kid = (n, key) => { if (n && n.c) for (const c of n.c) if (c.k === key) return c; return null }
const val = (n, key, def = null) => { const c = kid(n, key); return c && c.v !== undefined && c.v !== null ? c.v : def }

// ---------- Геометрия ----------

function transOf(obj) {
  const tr = kid(obj, 'Trans')
  if (!tr) return [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]
  let x = val(tr, 'Rx', 0), y = val(tr, 'Ry', 0), z = val(tr, 'Rz', 0), w = val(tr, 'Rw', 1)
  const n = Math.hypot(x, y, z, w) || 1
  x /= n; y /= n; z /= n; w /= n
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
    val(tr, 'X', 0), val(tr, 'Y', 0), val(tr, 'Z', 0),
  ]
}
// M = [R(9, по строкам), t(3)];  p' = R·p + t
function mul(a, b) {
  const o = new Array(12)
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]
    o[9 + r] = a[r * 3] * b[9] + a[r * 3 + 1] * b[10] + a[r * 3 + 2] * b[11] + a[9 + r]
  }
  return o
}
const applyP = (m, p) => [
  m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[9],
  m[3] * p[0] + m[4] * p[1] + m[5] * p[2] + m[10],
  m[6] * p[0] + m[7] * p[1] + m[8] * p[2] + m[11],
]
const applyV = (m, v) => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
]
function inverse(m) { // жёсткое преобразование: R^T, -R^T·t
  const r = [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]
  const t = applyV(r, [m[9], m[10], m[11]])
  return [...r, -t[0], -t[1], -t[2]]
}

function contourElems(b) {
  if (!b || b.length < 4) return []
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const n = dv.getUint32(0, true)
  let p = 4
  const out = []
  const f = () => { const v = dv.getFloat64(p, true); p += 8; return v }
  for (let i = 0; i < n; i++) {
    const t = b[p]; p += 1
    if (t === 0x10) out.push({ t: 'L', a: [f(), f()], b: [f(), f()] })
    else if (t === 0x11) out.push({ t: 'C', c: [f(), f()], r: f() })
    else if (t === 0x12) { out.push({ t: 'A', c: [f(), f()], a: [f(), f()], b: [f(), f()], ccw: b[p] === 1 }); p += 1 }
    else throw new Error('Неизвестный элемент контура')
  }
  return out
}

const near = (p, q, tol = EPS) => Math.abs(p[0] - q[0]) <= tol && Math.abs(p[1] - q[1]) <= tol
const posmod = a => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)

function arcInfo(e) {
  const r = Math.hypot(e.a[0] - e.c[0], e.a[1] - e.c[1])
  const a0 = Math.atan2(e.a[1] - e.c[1], e.a[0] - e.c[0])
  const a1 = Math.atan2(e.b[1] - e.c[1], e.b[0] - e.c[0])
  let sweep = e.ccw ? posmod(a1 - a0) : -posmod(a0 - a1)
  if (Math.abs(sweep) < 1e-9) sweep = e.ccw ? 2 * Math.PI : -2 * Math.PI
  const at = k => [e.c[0] + r * Math.cos(a0 + sweep * k), e.c[1] + r * Math.sin(a0 + sweep * k)]
  return { r, at }
}

// Элементы -> замкнутые петли. Петля: { pts: [{p, arc}], circle? }
function buildLoops(elems) {
  const segs = []
  const loops = []
  for (const e of elems) {
    if (e.t === 'C') loops.push({ circle: { c: e.c, r: e.r }, pts: null })
    else if (e.t === 'L') { if (!near(e.a, e.b, 1e-6)) segs.push({ a: e.a, b: e.b }) }
    else { const ai = arcInfo(e); segs.push({ a: e.a, b: e.b, mid: ai.at(0.5), ext: Array.from({ length: 17 }, (_, k) => ai.at(k / 16)) }) }
  }
  const used = new Array(segs.length).fill(false)
  let open = 0
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue
    used[i] = true
    const pts = [{ p: segs[i].a }]
    const ext = []
    if (segs[i].mid) { pts.push({ p: segs[i].mid, arc: true }); ext.push(...segs[i].ext) }
    const startP = segs[i].a
    let cur = segs[i].b, closed = false
    for (let guard = 0; guard <= segs.length; guard++) {
      if (near(cur, startP)) { closed = true; break }
      let found = -1, rev = false
      for (let j = 0; j < segs.length; j++) {
        if (used[j]) continue
        if (near(segs[j].a, cur)) { found = j; break }
        if (near(segs[j].b, cur)) { found = j; rev = true; break }
      }
      if (found < 0) break
      used[found] = true
      pts.push({ p: cur })
      if (segs[found].mid) { pts.push({ p: segs[found].mid, arc: true }); ext.push(...segs[found].ext) }
      cur = rev ? segs[found].a : segs[found].b
    }
    if (closed && pts.length >= 2) loops.push({ pts, ext })
    else open++
  }
  return { loops, open }
}

function loopBox(loop) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  const add = p => { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]) }
  if (loop.circle) { const { c, r } = loop.circle; add([c[0] - r, c[1] - r]); add([c[0] + r, c[1] + r]) }
  else { loop.pts.forEach(v => add(v.p)); loop.ext.forEach(add) }
  return { x0, y0, x1, y1 }
}

const signedArea = pts => {
  let s = 0
  for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; s += a[0] * b[1] - b[0] * a[1] }
  return s / 2
}
function pointInPoly(pt, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j]
    if ((a[1] > pt[1]) !== (b[1] > pt[1]) && pt[0] < (b[0] - a[0]) * (pt[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside
  }
  return inside
}

const r1 = v => Math.round(v * 10) / 10
const r2 = v => Math.round(v * 100) / 100
const cleanName = s => String(s || '').split(/[\r\n]/)[0].trim()

// Привязка точки к ближайшим сторонам (как при ручном вводе в редакторе)
function sideOffsets(X, Y, W, L, itemW = 0, itemH = 0) {
  const sides = [], offsets = {}
  if (X + itemW / 2 <= W / 2 + 1e-6) { sides.push('left'); offsets.left = r1(X) } else { sides.push('right'); offsets.right = r1(W - X - itemW) }
  if (Y + itemH / 2 <= L / 2 + 1e-6) { sides.push('bottom'); offsets.bottom = r1(Y) } else { sides.push('top'); offsets.top = r1(L - Y - itemH) }
  return { sides, offsets }
}

// Отверстия на одной линии с равным шагом (3 и более) — в один «ряд», как при ручном вводе
function groupRows(drillings, W, L) {
  const pos = d => ({
    x: d.offsets.left != null ? d.offsets.left : W - d.offsets.right,
    y: d.offsets.bottom != null ? d.offsets.bottom : L - d.offsets.top,
  })
  for (const axis of ['y', 'x']) {            // сначала столбцы (шаг по Y), потом строки
    const other = axis === 'y' ? 'x' : 'y'
    const buckets = new Map()
    drillings.forEach(d => {
      if (d.kind !== 'face' || d.row) return
      const p = pos(d)
      const key = `${d.face}|${d.d}|${d.depth}|${Math.round(p[other] * 10)}`
      if (!buckets.has(key)) buckets.set(key, [])
      buckets.get(key).push({ d, p })
    })
    for (const list of buckets.values()) {
      if (list.length < 3) continue
      list.sort((a, b) => a.p[axis] - b.p[axis])
      let i = 0
      while (i < list.length - 2) {
        const step = list[i + 1].p[axis] - list[i].p[axis]
        let j = i + 1
        while (j + 1 < list.length && Math.abs(list[j + 1].p[axis] - list[j].p[axis] - step) <= 0.11) j++
        const n = j - i + 1
        if (n >= 3 && step >= 1) {
          const first = list[i], last = list[j]
          const c = { x: (first.p.x + last.p.x) / 2, y: (first.p.y + last.p.y) / 2 }
          Object.assign(first.d, sideOffsets(c.x, c.y, W, L), { row: true, rowDir: axis, rowStep: r1(step), rowCount: n })
          for (let k = i + 1; k <= j; k++) drillings.splice(drillings.indexOf(list[k].d), 1)
          i = j + 1
        } else i++
      }
    }
  }
}

let drillSeq = 0
const drillId = () => 'b' + Date.now().toString(36) + (drillSeq++).toString(36)

// ---------- Панель -> деталь ----------

function convertPanel(panel, holes, faceRule) {
  const o = panel.obj
  const T = val(o, 'Thick', 16)
  const elems = contourElems(val(o, 'Contour'))
  const { loops, open } = buildLoops(elems)
  if (!loops.length) return null
  // внешний контур — петля с наибольшим габаритом
  let outer = null, outerBox = null
  for (const lp of loops) {
    const b = loopBox(lp)
    if (!outer || (b.x1 - b.x0) * (b.y1 - b.y0) > (outerBox.x1 - outerBox.x0) * (outerBox.y1 - outerBox.y0)) { outer = lp; outerBox = b }
  }
  const { x0, y0 } = outerBox
  const dx = outerBox.x1 - x0, dy = outerBox.y1 - y0
  if (!(dx > 0.5) || !(dy > 0.5)) return null
  const texDir = val(o, 'TexDir', 0)
  const rot = texDir === 1          // текстура вдоль X детали -> это её длина
  const W = rot ? dy : dx, L = rot ? dx : dy
  const warn = { open, edgeHoles: 0, edges: 0, cuts: 0 }

  // --- отверстия крепежа в системе панели (до выбора лицевой стороны) ---
  const Mi = inverse(panel.M)
  const face = [], edge = []
  const outerLocal = outer.circle ? null : outer.pts.map(v => v.p)
  for (const h of holes) {
    const q = applyP(Mi, h.P), d = applyV(Mi, h.D)
    if (Math.abs(d[2]) > 0.99) {
      const za = Math.min(q[2], q[2] + d[2] * h.depth), zb = Math.max(q[2], q[2] + d[2] * h.depth)
      const ov = Math.min(zb, T) - Math.max(za, 0)
      if (ov < 0.3) continue
      if (q[0] < x0 - EPS || q[0] > x0 + dx + EPS || q[1] < y0 - EPS || q[1] > y0 + dy + EPS) continue
      if (outerLocal && outerLocal.length > 4 && !pointInPoly(q, outerLocal)) continue
      // крепёж в модели стоит не идеально: отверстие может начинаться на десятые доли мм в глубине
      const top = zb >= T - 0.5, bottom = za <= 0.5
      if (!top && !bottom) continue
      face.push({ x: q[0], y: q[1], d: 2 * h.r, depth: top && bottom ? T : top ? T - Math.max(za, 0) : Math.min(zb, T), through: top && bottom, top, name: h.name })
    } else if (Math.abs(d[2]) < 0.01 && q[2] > 0.5 && q[2] < T - 0.5) {
      edge.push({ q, d, z: q[2], dia: 2 * h.r, depth: h.depth, name: h.name })
    }
  }

  // --- пазы (Cuts с прямоугольным профилем) ---
  const cutsRaw = []
  for (const cut of (kid(o, 'Cuts')?.c || [])) {
    const prof = contourElems(val(cut, 'Contour')), traj = contourElems(val(cut, 'Trajectory'))
    if (traj.length !== 1 || traj[0].t !== 'L' || prof.length !== 4 || prof.some(e => e.t !== 'L')) { warn.cuts++; continue }
    const us = prof.flatMap(e => [e.a[0], e.b[0]]), zs = prof.flatMap(e => [e.a[1], e.b[1]])
    const u0 = Math.min(...us), u1 = Math.max(...us), z0 = Math.min(...zs), z1 = Math.max(...zs)
    const top = z1 >= T - EPS, bottom = z0 <= EPS
    if (top === bottom) { warn.cuts++; continue }       // сквозной или «внутренний» — не паз
    const { a, b } = traj[0]
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (len < 0.5) { warn.cuts++; continue }
    const n = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len]     // левая нормаль к траектории
    if (Math.abs(n[0]) > 0.01 && Math.abs(n[1]) > 0.01) { warn.cuts++; continue }  // наклонный паз
    cutsRaw.push({
      p: [a[0] + n[0] * u0, a[1] + n[1] * u0], q: [b[0] + n[0] * u1, b[1] + n[1] * u1],
      depth: z1 - z0, top, name: cleanName(val(cut, 'Name')),
    })
  }

  // --- какая пласть «лицевая» (смотрит вверх на станке): та, где больше глухой обработки ---
  const holesTop = face.filter(f => !f.through && f.top).length, holesBottom = face.filter(f => !f.through && !f.top).length
  const cutsTop = cutsRaw.filter(c => c.top).length, cutsBottom = cutsRaw.filter(c => !c.top).length
  // Правило выбирает пользователь при импорте (FACE_RULES)
  let flip = false
  if (faceRule === 'holes') flip = holesBottom !== holesTop ? holesBottom > holesTop : cutsBottom > cutsTop
  else if (faceRule === 'groove') flip = cutsBottom !== cutsTop ? cutsBottom > cutsTop : holesBottom > holesTop
  else if (faceRule === 'sum') flip = holesBottom + cutsBottom > holesTop + cutsTop
  // 'model' — как в модели Базиса, не переворачиваем

  const tf = (p) => {
    const u = p[0] - x0, v = p[1] - y0
    let X = rot ? dy - v : u
    const Y = rot ? u : v
    if (flip) X = W - X
    return [X, Y]
  }
  const tfv = (vx, vy) => {
    let X = rot ? -vy : vx
    const Y = rot ? vx : vy
    if (flip) X = -X
    return [X, Y]
  }

  // --- контур ---
  const toVerts = (loop) => {
    let vs = loop.pts.map(v => ({ p: tf(v.p), arc: !!v.arc }))
    if (signedArea(vs.map(v => v.p)) < 0) vs = vs.reverse()
    // начинаем с нижней левой обычной (не дуговой) вершины
    let best = -1
    vs.forEach((v, i) => {
      if (v.arc) return
      if (best < 0 || v.p[1] < vs[best].p[1] - EPS || (Math.abs(v.p[1] - vs[best].p[1]) <= EPS && v.p[0] < vs[best].p[0])) best = i
    })
    if (best > 0) vs = vs.slice(best).concat(vs.slice(0, best))
    return vs.map(v => (v.arc ? { x: r2(v.p[0]), y: r2(v.p[1]), r: 0, type: 'arc' } : { x: r2(v.p[0]), y: r2(v.p[1]), r: 0 }))
  }
  let vertices
  if (outer.circle) {
    const r = outer.circle.r
    vertices = [
      { x: r2(r), y: 0, r: 0 }, { x: r2(2 * r), y: r2(r), r: 0, type: 'arc' },
      { x: r2(r), y: r2(2 * r), r: 0 }, { x: 0, y: r2(r), r: 0, type: 'arc' },
    ]
  } else vertices = toVerts(outer)
  const isRect = !outer.circle && vertices.length === 4 && vertices.every(v => !v.type &&
    (Math.abs(v.x) <= EPS || Math.abs(v.x - W) <= EPS) && (Math.abs(v.y) <= EPS || Math.abs(v.y - L) <= EPS))

  // --- вырезы ---
  const cutouts = []
  for (const lp of loops) {
    if (lp === outer) continue
    if (lp.circle) {
      const c = tf(lp.circle.c), r = lp.circle.r
      cutouts.push({ type: 'circle', d: r1(2 * r), ...sideOffsets(c[0] - r, c[1] - r, W, L, 2 * r, 2 * r) })
    } else {
      const vs = toVerts(lp)
      const xs = vs.map(v => v.x), ys = vs.map(v => v.y)
      const hx = Math.min(...xs), hy = Math.min(...ys), hw = Math.max(...xs) - hx, hh = Math.max(...ys) - hy
      cutouts.push({ type: 'rect', hw: r1(hw), hh: r1(hh), ...sideOffsets(hx, hy, W, L, hw, hh), vertices: vs, _verticesEdited: true })
    }
  }

  // --- кромка: Elem — номер элемента контура ---
  const edges = { top: null, right: null, bottom: null, left: null }
  const edgeInfo = {}
  for (const butt of (kid(o, 'Butts')?.c || [])) {
    const e = elems[val(butt, 'Elem', -1)]
    const name = cleanName(val(butt, 'Mat')) || cleanName(val(butt, 'Sign')) || 'default'
    if (!e || e.t !== 'L') { warn.edges++; continue }
    const a = tf(e.a), b = tf(e.b)
    let side = null
    if (Math.abs(a[0]) <= EPS && Math.abs(b[0]) <= EPS) side = 'left'
    else if (Math.abs(a[0] - W) <= EPS && Math.abs(b[0] - W) <= EPS) side = 'right'
    else if (Math.abs(a[1]) <= EPS && Math.abs(b[1]) <= EPS) side = 'bottom'
    else if (Math.abs(a[1] - L) <= EPS && Math.abs(b[1] - L) <= EPS) side = 'top'
    if (!side) { warn.edges++; continue }
    edges[side] = name
    edgeInfo[side] = { mat: String(val(butt, 'Mat', '')).replace(/[\r\n]+/g, ' / '), sign: val(butt, 'Sign', ''), thick: val(butt, 'Thick'), width: val(butt, 'Width') }
  }

  // --- присадка ---
  const drillings = []
  const seen = new Map()
  for (const f of face) {
    const [X, Y] = tf([f.x, f.y])
    const front = f.through ? true : (f.top !== flip)
    const key = `${Math.round(X * 10)}|${Math.round(Y * 10)}|${Math.round(f.d * 10)}|${f.through ? 't' : front ? 'f' : 'b'}`
    const prev = seen.get(key)
    if (prev) { if (f.depth > prev.depth) prev.depth = r1(f.depth); continue }
    const dr = {
      id: drillId(), installed: true, kind: 'face', face: front ? 'front' : 'back',
      d: r1(f.d), depth: r1(f.depth), ...sideOffsets(X, Y, W, L), attachTo: [],
      row: false, rowDir: 'x', rowStep: 32, rowCount: 2, note: cleanName(f.name),
    }
    seen.set(key, dr); drillings.push(dr)
  }
  // глухое отверстие там же, где сквозное того же диаметра — лишнее
  const through = new Set(drillings.filter(d => d.depth >= T - EPS).map(d => JSON.stringify([d.sides, d.offsets, d.d])))
  for (let i = drillings.length - 1; i >= 0; i--) {
    const d = drillings[i]
    if (d.depth < T - EPS && through.has(JSON.stringify([d.sides, d.offsets, d.d]))) drillings.splice(i, 1)
  }
  groupRows(drillings, W, L)

  // Торцевые: ищем, где ось отверстия входит в материал через прямой край контура.
  // Край может быть и внутри габарита (вырез, ступенька) — тогда edgeInset > 0.
  const poly = vertices.map(v => [v.x, v.y])
  const seenEdge = new Set()
  for (const e of (outer.circle ? [] : edge)) {
    const P = tf([e.q[0], e.q[1]]), [vx, vy] = tfv(e.d[0], e.d[1])
    const horiz = Math.abs(vx) > 0.99, vert = Math.abs(vy) > 0.99
    if (!horiz && !vert) { warn.edgeHoles++; continue }
    const sgn = horiz ? Math.sign(vx) : Math.sign(vy)
    const ts = []
    for (let i = 0; i < vertices.length; i++) {
      const a = vertices[i], b = vertices[(i + 1) % vertices.length]
      if (a.type === 'arc' || b.type === 'arc') continue
      if (horiz) {
        if (Math.abs(a.x - b.x) > EPS) continue
        if (P[1] < Math.min(a.y, b.y) - 0.01 || P[1] > Math.max(a.y, b.y) + 0.01) continue
        ts.push((a.x - P[0]) * sgn)
      } else {
        if (Math.abs(a.y - b.y) > EPS) continue
        if (P[0] < Math.min(a.x, b.x) - 0.01 || P[0] > Math.max(a.x, b.x) + 0.01) continue
        ts.push((a.y - P[1]) * sgn)
      }
    }
    ts.sort((m, n) => m - n)
    const at = t => (horiz ? [P[0] + sgn * t, P[1]] : [P[0], P[1] + sgn * t])
    const tIn = ts.find(t => t >= -0.5 && t < e.depth - 0.5 && pointInPoly(at(t + 0.3), poly) && !pointInPoly(at(t - 0.3), poly))
    if (tIn === undefined) continue          // отверстие не входит в эту деталь через торец
    const tOut = ts.find(t => t > tIn + 0.3)
    const depth = Math.min(e.depth, tOut ?? e.depth) - Math.max(tIn, 0)
    if (depth < 0.5) continue
    const [X, Y] = at(tIn)
    const side = horiz ? (sgn > 0 ? 'left' : 'right') : (sgn > 0 ? 'bottom' : 'top')
    const inset = side === 'left' ? X : side === 'right' ? W - X : side === 'bottom' ? Y : L - Y
    const along = horiz ? Y : X
    const key = `${side}|${Math.round(inset * 10)}|${Math.round(along * 10)}|${Math.round(e.dia * 10)}|${Math.round(e.z * 10)}`
    if (seenEdge.has(key)) continue
    seenEdge.add(key)
    drillings.push({
      id: drillId(), installed: true, kind: 'edge', edgeSide: side, alongFrom: 'start',
      offsetAlong: r1(along), offsetFace: r1(flip ? e.z : T - e.z), d: r1(e.dia), depth: r1(depth),
      ...(inset > 0.05 ? { edgeInset: r1(inset) } : {}),
      row: false, rowStep: 32, rowCount: 2, note: cleanName(e.name),
    })
  }

  const holeCount = drillings.reduce((n, d) => n + (d.row ? d.rowCount : 1), 0)

  // --- пазы ---
  const grooves = cutsRaw.map(c => {
    const p = tf(c.p), q = tf(c.q)
    const gx = Math.min(p[0], q[0]), gy = Math.min(p[1], q[1])
    const gw = Math.abs(p[0] - q[0]), gh = Math.abs(p[1] - q[1])
    const horizontal = gw >= gh
    return {
      dir: horizontal ? 'horizontal' : 'vertical',
      length: r1(horizontal ? gw : gh), width: r1(horizontal ? gh : gw), depth: r1(c.depth),
      ...sideOffsets(gx, gy, W, L, gw, gh), face: c.top !== flip ? 'front' : 'back', note: c.name,
    }
  })

  // Свойства детали из Базиса — целиком, для бирки и подписи на карте раскроя
  const matFull = String(val(o, 'Mat', '')).split(/[\r\n]+/).map(x => x.trim()).filter(Boolean)
  const meta = {
    src: 'basis',
    ids: [val(o, 'ID')],                       // ID панелей в модели (по одному на каждую штуку)
    des: cleanName(val(o, 'Des')),             // обозначение, напр. 01.02
    pos: cleanName(val(o, 'ArtPos')),          // позиция
    name: cleanName(val(o, 'Name')),
    product: panel.ctx.product, productDes: panel.ctx.productDes, productPos: panel.ctx.productPos,
    path: panel.ctx.path,                      // блоки, в которые вложена деталь
    material: matFull[0] || '', materialCode: matFull.slice(1).join(' / '),
    thickness: T, texDir,
    edges: edgeInfo,
    flipped: flip, turned: rot,                // как деталь повёрнута относительно модели
    // для 3D-просмотра: габарит контура в системе панели и положение каждой штуки в модели
    local: { x0: r2(x0), y0: r2(y0), dx: r2(dx), dy: r2(dy) },
    inst: [panel.M.map((v, i) => (i < 9 ? Math.round(v * 1e6) / 1e6 : r2(v)))],
  }
  const contour = {
    vertices: isRect ? [{ x: 0, y: 0, r: 0 }, { x: r1(W), y: 0, r: 0 }, { x: r1(W), y: r1(L), r: 0 }, { x: 0, y: r1(L), r: 0 }] : vertices,
    holes: cutouts, grooves, drillings, layout: [], meta,
  }

  const material = cleanName(val(o, 'Mat'))
  return {
    name: cleanName(val(o, 'Name')), prefix: panel.ctx.product || '',
    w: r1(L), h: r1(W), qty: 1, edges, material, thickness: T,
    rotatable: texDir === 0, contour,
    groupKey: `${material}|${T}`,
    info: { shaped: !isRect, cutouts: cutouts.length, holes: holeCount, grooves: grooves.length,
      back: drillings.filter(d => d.kind === 'face' && d.face === 'back').length + grooves.filter(g => g.face === 'back').length },
    warn,
  }
}

// ---------- Файл -> детали ----------

export function isBasisFile(u8) {
  return u8.length > 9 && u8[0] === 0x42 && u8[1] === 0x5A && u8[2] === 0x38 && u8[3] === 0x35   // 'BZ85'
}

// Какую пласть считать лицевой (она смотрит вверх на станке)
export const FACE_RULES = [
  ['holes', 'Где больше глухих отверстий, затем — где паз'],
  ['groove', 'Где паз, затем — где больше глухих отверстий'],
  ['sum', 'Где больше обработки всего (отверстия + пазы)'],
  ['model', 'Как в модели Базиса (не переворачивать)'],
]

export function parseBasis(u8, opts = {}) {
  const faceRule = FACE_RULES.some(r => r[0] === opts.faceRule) ? opts.faceRule : 'holes'
  if (u8.length < 4 || u8[0] !== 0x42 || u8[1] !== 0x5A) throw new Error('Это не файл модели Базис-Мебельщик')
  if (!isBasisFile(u8)) throw new Error('Эта версия файла Базис пока не поддерживается (нужен формат BZ85 — пересохраните модель в свежей версии Базиса)')
  const skip = new Set(['Undo', 'TriData', 'Thumbnail'])
  let p = 4, header = null, doc = null
  while (p + 5 <= u8.length && !doc) {
    const flag = u8[p + 4]
    p += 5
    if (flag === 0) { const r = parseTree(u8, p, skip); header = r.root; p = r.end }
    else if (flag === 1) { const raw = inflateSync(u8.subarray(p + 2)); doc = parseTree(raw, 0, skip).root }
    else throw new Error('Неизвестная структура файла')
  }
  const model = kid(doc, 'Model')
  if (!model) throw new Error('В файле нет модели')

  const furn = new Map()
  for (const f of (kid(doc, 'FurnList')?.c || [])) furn.set(val(f, 'FastID'), f)

  const panels = [], holes = []
  const walk = (obj, M, ctx) => {
    const type = val(obj, 'Type')
    const Mo = mul(M, transOf(obj))
    if (type === TYPE_PANEL) panels.push({ obj, M: Mo, ctx })
    else if (type === TYPE_FASTENER) {
      const f = furn.get(val(obj, 'FastID'))
      for (const h of (kid(f, 'Holes')?.c || [])) {
        const r = val(h, 'Radius', 0), depth = val(h, 'Depth', 0)
        if (!(r > 0) || !(depth > 0)) continue
        holes.push({
          P: applyP(Mo, [val(h, 'X', 0), val(h, 'Y', 0), val(h, 'Z', 0)]),
          D: applyV(Mo, [val(h, 'DirX', 0), val(h, 'DirY', 0), val(h, 'DirZ', 0)]),
          r, depth, name: val(f, 'Name', ''),
        })
      }
    }
    for (const c of (obj.c || [])) {
      if (!c.c) continue
      const list = c.k === 'Obj' ? [c] : c.c
      const sub = type === 1005 && ctx.depth > 0 ? { ...ctx, path: [...ctx.path, cleanName(val(obj, 'Name'))], depth: ctx.depth + 1 } : { ...ctx, depth: ctx.depth + 1 }
      for (const cc of list) if (cc.c && cc.k === 'Obj' && kid(cc, 'Type')) walk(cc, Mo, sub)
    }
  }
  const I = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]
  for (const top of model.c) {
    if (top.k !== 'Obj' || !top.c) continue
    walk(top, I, { product: cleanName(val(top, 'Name')), productDes: cleanName(val(top, 'Des')), productPos: cleanName(val(top, 'ArtPos')), path: [], depth: 0 })
  }

  // одинаковые детали одного изделия — в одну строку с количеством
  const strip = c => JSON.stringify(c, (k, v) => (k === 'id' || k === 'ids' || k === 'inst' ? undefined : v))
  const map = new Map()
  for (const p of panels) {
    const it = convertPanel(p, holes, faceRule)
    if (!it) continue
    const key = [it.prefix, it.name, it.w, it.h, it.groupKey, JSON.stringify(it.edges), strip(it.contour)].join('§')
    const prev = map.get(key)
    if (prev) { prev.qty++; prev.contour.meta.ids.push(...it.contour.meta.ids); prev.contour.meta.inst.push(...it.contour.meta.inst); for (const k of Object.keys(it.warn)) prev.warn[k] += it.warn[k] }
    else map.set(key, it)
  }
  const items = [...map.values()]

  const groups = new Map()
  for (const it of items) {
    const g = groups.get(it.groupKey) || { key: it.groupKey, material: it.material, thickness: it.thickness, count: 0, pieces: 0 }
    g.count++; g.pieces += it.qty
    groups.set(it.groupKey, g)
  }
  const article = kid(kid(header, 'Header') || header, 'Article')
  const orderName = cleanName(val(article, 'OrderName')) || cleanName(val(article, 'Name'))
  for (const it of items) { it.contour.meta.order = orderName; it.contour.meta.model = cleanName(val(article, 'Name')) }
  return {
    orderName,
    items,
    groups: [...groups.values()].sort((a, b) => b.pieces - a.pieces),
  }
}

export async function readBasisFile(file, opts) {
  const res = parseBasis(new Uint8Array(await file.arrayBuffer()), opts)
  for (const it of res.items) it.contour.meta.file = file.name
  return res
}
