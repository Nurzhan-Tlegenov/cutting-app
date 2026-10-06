// 3D-модель заказа, импортированного из Базиса или Астры.
// Детали заказа строятся из их текущего контура (contour.meta.local / inst) —
// правки в редакторе видны и в 3D. Остальное (панели других материалов,
// профили, фурнитура) берётся из сохранённой при импорте модели (scene).
import { verticesToPolygon } from './trueShapeNesting.js'
import { detailHoles } from './partHoles.js'
import { getDrillPoints } from './drillGeometry.js'
import { buildRelief } from './facadeCarve.js'
import { contourSegments, segmentSide, holeEdgeSegments } from './edgeLength.js'

const num = v => Number(v) || 0

function resolvePos(sides, offsets, panelW, panelH, itemW, itemH) {
  let x = (panelW - itemW) / 2, y = (panelH - itemH) / 2, w = itemW, h = itemH
  if (sides.includes('left') && sides.includes('right')) { x = offsets.left ?? 0; w = panelW - (offsets.left ?? 0) - (offsets.right ?? 0) }
  else if (sides.includes('left')) x = offsets.left ?? 0
  else if (sides.includes('right')) x = panelW - itemW - (offsets.right ?? 0)
  if (sides.includes('top') && sides.includes('bottom')) { y = offsets.bottom ?? 0; h = panelH - (offsets.bottom ?? 0) - (offsets.top ?? 0) }
  else if (sides.includes('bottom')) y = offsets.bottom ?? 0
  else if (sides.includes('top')) y = panelH - itemH - (offsets.top ?? 0)
  return { x, y, w, h }
}

// Постоянное имя каждой штуки в модели (pid): по нему 3D помнит, что скрыто и выбрано,
// даже когда строки заказа делятся или склеиваются после правки. Порядок обхода — как в buildModel.
export function makePidGen() {
  const seen = new Map()
  return (meta, i, di) => {
    const id = meta?.ids?.[i]
    const k = id != null ? `${meta.file || ''}#${id}` : `r${di}_${i}`
    const n = seen.get(k) || 0
    seen.set(k, n + 1)
    return n ? `${k}~${n}` : k
  }
}

// Одна строка заказа -> панели в модели (по одной на каждую штуку).
// skipIds — ID панелей, которые уже показаны (чтобы не рисовать дважды).
// di — номер строки в заказе, pidOf — выдаёт постоянное имя штуки.
function partsOfDetail(d, inOrder, skipIds, di = -1, pidOf = null) {
  let c = d.contour
  if (typeof c === 'string') { try { c = JSON.parse(c) } catch { c = null } }
  const meta = c?.meta
  if (!meta?.inst?.length || !meta.local) return []
  const { x0, y0, dx, dy } = meta.local
  const T = num(meta.thickness) || 16
  const W = meta.turned ? dy : dx, L = meta.turned ? dx : dy
  // координаты редактора (X — ширина, Y — длина) -> система панели в модели
  const toLocal = ([X, Y]) => {
    const x = meta.flipped ? W - X : X
    return meta.turned ? [Y + x0, dy - x + y0] : [x + x0, Y + y0]
  }
  const vecLocal = (vx, vy) => {
    const x = meta.flipped ? -vx : vx
    return meta.turned ? [vy, -x] : [x, vy]
  }
  const frontZ = meta.flipped ? 0 : T            // лицевая пласть в системе панели
  const faceHole = (X, Y, face, d0, depth, out) => {
    const front = face !== 'back'
    const z = front ? frontZ : T - frontZ
    const [x, y] = toLocal([X, Y])
    out.push({ p: [x, y, z], d: [0, 0, z > T / 2 ? -1 : 1], r: d0 / 2, len: Math.min(depth, T), side: front ? 'front' : 'back' })
  }

  const verts = Array.isArray(c.vertices) && c.vertices.length > 2 ? c.vertices : [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: L }, { x: 0, y: L }]
  const outline = verticesToPolygon(verts).map(toLocal)
  const holes = detailHoles({ width: W, length: L, contour: JSON.stringify({ holes: c.holes || [] }) })
    .map(poly => poly.map(p => toLocal([p.x, p.y])))

  // торцы с кромкой: ломаные по контуру (для подсветки в 3D)
  const sides = d.edges || { top: d.edge_top, right: d.edge_right, bottom: d.edge_bottom, left: d.edge_left }
  const on = v => !!v && v !== 'false'
  const bands = []
  for (const seg of contourSegments(verts)) {
    const side = segmentSide(seg, W, L)
    if ((side && on(sides[side])) || seg.edge) bands.push(seg.pts.map(toLocal))
  }
  ;(c.holes || []).forEach((h, i) => { if (h.edge && holes[i]?.length > 2) bands.push([...holes[i], holes[i][0]]) })
  ;(c.holes || []).forEach(h => holeEdgeSegments(h).forEach(seg => bands.push(seg.pts.map(toLocal))))   // кромка на отдельных участках выреза

  const drills = []
  for (const dr of c.drillings || []) {
    if (dr.installed === false) continue
    let pts
    try { pts = getDrillPoints(dr, W, L, c.layout || []) } catch { pts = [] }
    for (const p of pts) {
      const dia = p.ehD ?? (p.isPair ? dr.pairD ?? dr.d : dr.d) ?? 8
      const depth = p.ehDepth ?? (p.isPair ? dr.pairDepth ?? dr.depth : dr.depth) ?? 13
      if (dr.kind === 'edge' && !p.isFaceType) {
        const zf = dr.offsetFace ?? T / 2
        const [x, y] = toLocal([p.x, p.y]), [vx, vy] = vecLocal(p.dx || 0, p.dy || 0)
        drills.push({ p: [x, y, meta.flipped ? zf : T - zf], d: [vx, vy, 0], r: dia / 2, len: depth })
      } else {
        const face = p.ehFace ?? (dr.kind === 'edge' || p.isPair ? dr.pairFace ?? dr.face : dr.face) ?? 'front'
        if (face === 'both') { faceHole(p.x, p.y, 'front', dia, depth, drills); faceHole(p.x, p.y, 'back', dia, depth, drills) }
        else faceHole(p.x, p.y, face, dia, depth, drills)
      }
    }
  }
  const grooves = (c.grooves || []).map(g => {
    const hor = g.dir === 'horizontal'
    const gw = hor ? (g.length || 100) : (g.width || 8), gh = hor ? (g.width || 8) : (g.length || 100)
    const r = resolvePos(g.sides || [], g.offsets || {}, W, L, gw, gh)
    const front = g.face !== 'back'
    return {
      poly: [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]].map(toLocal),
      z: front ? frontZ : T - frontZ, depth: Math.min(num(g.depth) || 0, T),
    }
  }).filter(g => g.depth > 0)
  // Фрезеровка фасада: если деталь прямоугольная — настоящий рельеф пласти по профилю фрезы
  let carve = null
  const plainRect = holes.length === 0 && verts.length === 4 && verts.every(v => !v.type && !(v.r > 0) &&
    (Math.abs(v.x) < 0.1 || Math.abs(v.x - W) < 0.1) && (Math.abs(v.y) < 0.1 || Math.abs(v.y - L) < 0.1))
  const relief = plainRect ? buildRelief(c.decor, W, L, T) : null
  if (relief) {
    const { xs, ys, depth, maxD } = relief
    const zFace = relief.face === 'front' ? frontZ : T - frontZ
    const zAt = dd => (zFace > T / 2 ? T - dd : dd)
    const nx = xs.length, ny = ys.length
    const P = (i, j) => { const q = toLocal([xs[i], ys[j]]); return [q[0], q[1], zAt(depth[j * nx + i])] }
    const B = (i, j) => { const q = toLocal([xs[i], ys[j]]); return [q[0], q[1], zAt(maxD)] }
    const pos = []
    const tri = (a, b, cc) => pos.push(a[0], a[1], a[2], b[0], b[1], b[2], cc[0], cc[1], cc[2])
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const a = P(i, j), b = P(i + 1, j), cc = P(i + 1, j + 1), dd = P(i, j + 1)
      tri(a, b, cc); tri(a, cc, dd)
    }
    // юбка по периметру — от рельефа вниз до основы, чтобы не было щелей
    const skirt = (i0, j0, i1, j1) => { const a = P(i0, j0), b = P(i1, j1), a2 = B(i0, j0), b2 = B(i1, j1); tri(a, b, b2); tri(a, b2, a2) }
    for (let i = 0; i < nx - 1; i++) { skirt(i, 0, i + 1, 0); skirt(i, ny - 1, i + 1, ny - 1) }
    for (let j = 0; j < ny - 1; j++) { skirt(0, j, 0, j + 1); skirt(nx - 1, j, nx - 1, j + 1) }
    carve = { pos: new Float32Array(pos), maxD, top: zFace > T / 2 }
  }
  // иначе фрезеровка «для вида» (выемка, V-паз) — тёмной вставкой в пласть
  for (const dc of (carve ? [] : c.decor || [])) {
    const front = dc.face !== 'back'
    for (const pl of dc.polys || []) {
      if (pl.length < 3) continue
      grooves.push({ poly: pl.map(toLocal), z: front ? frontZ : T - frontZ, depth: Math.max(0.6, Math.min(num(dc.depth) || 1, T - 0.5)), decor: true })
    }
  }

  const size = `${Math.round(num(d.w ?? d.length) * 10) / 10}×${Math.round(num(d.h ?? d.width) * 10) / 10}`
  // блок, в который входит деталь (изделие и вложенные блоки из Базиса / Астры)
  const block = [meta.product, ...(Array.isArray(meta.path) ? meta.path : [])].filter(Boolean).join(' / ')
  const out = []
  meta.inst.forEach((m, i) => {
    const id = meta.ids?.[i]
    const pid = pidOf ? pidOf(meta, i, di) : ''
    if (skipIds && id != null && skipIds.has(id)) return
    out.push({ outline, holes, drills, grooves, carve, bands, t: T, m, inOrder, anim: meta.anims?.[i] || null, texDir: meta.texDir || 0, des: meta.des || '', pos: meta.pos ? String(meta.pos) : '', name: d.name || meta.name || '', material: meta.material || '', product: meta.product || '', block, size, pid, di, ii: i })
  })
  return out
}

/**
 * details — строки order_details (или детали формы); scene — сохранённая модель (или null).
 * -> { parts: [...], hardware: [{ name, groups: [{ mat, pos: Float32Array }], inst: [m] }], hasContext }
 */
export function buildModel(details, scene) {
  const parts = []
  const orderIds = new Set()
  const pidOf = makePidGen()
  ;(details || []).forEach((d, di) => {
    const ps = partsOfDetail(d, true, null, di, pidOf)
    parts.push(...ps)
    let c = d.contour
    if (typeof c === 'string') { try { c = JSON.parse(c) } catch { c = null } }
    ;(c?.meta?.ids || []).forEach(id => orderIds.add(id))
  })
  const hardware = []
  let hasContext = false
  if (scene) {
    let sn = 0
    for (const sp of scene.parts || []) for (const p of partsOfDetail(sp, false, orderIds)) { p.pid = 's' + sn++; parts.push(p) }
    for (const ex of scene.extras || []) {
      parts.push({ outline: ex.outline, holes: ex.holes || [], drills: [], grooves: [], t: ex.t, m: ex.m, inOrder: false, anim: ex.anim || null, texDir: 0, des: '', pos: '', name: ex.name || '', material: ex.material || '', product: '', block: '', size: '', pid: 'x' + sn++, di: -1, ii: 0 })
    }
    const byId = new Map()
    for (const hw of scene.hardware || []) {
      const mesh = scene.meshes?.[hw.f]
      if (!mesh?.groups?.length) continue
      if (!byId.has(hw.f)) {
        byId.set(hw.f, { name: mesh.name || '', groups: mesh.groups.map(g => ({ mat: g.mat, pos: Float32Array.from(g.pos, v => v / 10) })), inst: [] })
        hardware.push(byId.get(hw.f))
      }
      byId.get(hw.f).inst.push({ m: hw.m, anim: hw.anim || null })
    }
    hasContext = parts.some(p => !p.inOrder) || hardware.length > 0
  }
  return { parts, hardware, hasContext, colors: scene?.colors || {} }
}

export const hasModel = details => (details || []).some(d => {
  const c = d.contour
  if (!c) return false
  if (typeof c === 'string') return c.includes('"inst"')
  return !!c.meta?.inst?.length
})
