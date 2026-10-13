// Модель SketchUp (.skp, формат SketchUp 2021+: внутри zip-архив с model.dat).
//
// model.dat — дерево записей «тег (2 байта) · длина (4 байта) · данные»: определения компонентов (вершины, рёбра,
// грани), вставки компонентов с матрицей, слои (теги), материалы, атрибуты. Здесь читается то, что нужно для заказа:
//   - каждая панель — тело «Essence» внутри компонента мебельного плагина (SUF): размеры и положение — по геометрии,
//     название, материал, кромка по сторонам и направление текстуры — из атрибутов компонента (a03_name, a06_mat_panel,
//     edge_y1 / edge_y2 / edge_z1 / edge_z2, a05_napr);
//   - всё остальное с гранями (фурнитура, вешалки, петли, ручки…) — в 3D как «фурнитура»: одинаковые формы — один раз.
// Служебные слои плагина (размеры, габаритные рамки, направляющие, метки, крепёж Z_…) и скрытые объекты пропускаются.
// Единицы SketchUp — дюймы; ось Z вверх -> мир просмотра (Y вверх).

import { unzipSync } from 'fflate'
import { ShapeUtils, Vector2 } from 'three'
import { buildItem, groupItems } from './basisB3d.js'

const IN = 25.4
const r1 = v => Math.round(v * 10) / 10

// ── дерево записей ──
function reader(m) {
  const dv = new DataView(m.buffer, m.byteOffset, m.byteLength)
  // дети записи [o, o+l): [[tag, o, l]] или null, если это не список записей
  const kids = (off, end) => {
    const out = []
    while (off < end) {
      if (off + 6 > end) return null
      const tag = dv.getUint16(off, true), ln = dv.getUint32(off + 2, true)
      if (ln > end - off - 6) return null
      out.push([tag, off + 6, ln]); off += 6 + ln
    }
    return out
  }
  const memo = new Map()
  const kidsOf = (o, l) => { let k = memo.get(o); if (k === undefined) { k = kids(o, o + l); memo.set(o, k) } return k }
  const child = (o, l, tag) => { const k = kidsOf(o, l); if (!k) return null; for (const x of k) if (x[0] === tag) return [x[1], x[2]]; return null }
  const children = (o, l, tag) => (kidsOf(o, l) || []).filter(x => x[0] === tag).map(x => [x[1], x[2]])
  const bytes = (o, l) => m.subarray(o, o + l)
  const num = (o, l) => { let v = 0; for (let i = l - 1; i >= 0; i--) v = v * 256 + m[o + i]; return v }   // ссылка — число little-endian
  const utf = new TextDecoder('utf-8')
  const str = (o, l) => utf.decode(bytes(o, l))
  const sval = (o, l, tag) => { const r = child(o, l, tag); return r ? str(r[0], r[1]) : null }
  const nval = (o, l, tag) => { const r = child(o, l, tag); return r ? num(r[0], r[1]) : null }
  const dbl = (o, i = 0) => dv.getFloat64(o + i * 8, true)
  return { dv, kids, kidsOf, child, children, bytes, num, str, sval, nval, dbl }
}

// zip внутри .skp: начинается после заголовка «SketchUp Model {версия}»
function unpack(u8) {
  let at = -1
  for (let i = 0; i < Math.min(u8.length - 4, 4096); i++) if (u8[i] === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 3 && u8[i + 3] === 4) { at = i; break }
  if (at < 0) throw new Error('это файл старой версии SketchUp (до 2021) — откройте его в SketchUp и сохраните заново, затем импортируйте')
  const files = unzipSync(u8.subarray(at), { filter: f => f.name === 'model.dat' || /(^|\/)material\.xml$/.test(f.name) })
  if (!files['model.dat']) throw new Error('в файле SketchUp нет модели (model.dat)')
  return files
}

const mat4 = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]     // по строкам
const mul = (A, B) => { const C = new Array(16).fill(0); for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) { let s = 0; for (let k = 0; k < 4; k++) s += A[r * 4 + k] * B[k * 4 + c]; C[r * 4 + c] = s } return C }
const apply = (M, p) => [M[0] * p[0] + M[1] * p[1] + M[2] * p[2] + M[3], M[4] * p[0] + M[5] * p[1] + M[6] * p[2] + M[7], M[8] * p[0] + M[9] * p[1] + M[10] * p[2] + M[11]]
const applyV = (M, v) => [M[0] * v[0] + M[1] * v[1] + M[2] * v[2], M[4] * v[0] + M[5] * v[1] + M[6] * v[2], M[8] * v[0] + M[9] * v[1] + M[10] * v[2]]
const vlen = v => Math.hypot(v[0], v[1], v[2])
const norm = v => { const l = vlen(v) || 1; return [v[0] / l, v[1] / l, v[2] / l] }
// SketchUp (Z вверх, перед — к −Y) -> просмотр (Y вверх): (x, y, z) -> (x, z, −y)
const UP = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1]

// служебные слои мебельного плагина — не мебель
const SERVICE = /^(Z_|7_|0_|8_|03_|1_Фасад_опции|1_Фасад_открывание|2_Петли_метка)/
const EDGE_MM = { 2: '0.4', 3: '0.4', 4: '1', 5: '1', 6: '2', 7: '2' }
const cleanMat = s => String(s || '').replace(/_\d+(\.\d+)?$/, '').replace(/_/g, ' ').trim()
const cleanName = s => String(s || '').replace(/#\d+$/, '').replace(/_/g, ' ').trim()

export function parseSkp(u8, opts = {}) {
  const files = unpack(u8)
  const m = files['model.dat']
  const R = reader(m)
  const { kidsOf, child, children, sval, nval, dbl, dv } = R
  const top = R.kids(6, m.length)
  if (!top) throw new Error('не удалось прочитать модель SketchUp')
  const topOf = tag => { const x = top.find(t => t[0] === tag); return x ? [x[1], x[2]] : null }

  // id сущности: запись 0x7d0 (основа) -> 0x5dc -> 0x5de
  const baseOf = (o, l) => child(o, l, 0x7d0)
  const idOf = (o, l) => { const b = baseOf(o, l) || [o, l]; const r = child(b[0], b[1], 0x5dc); if (!r) return null; return nval(r[0], r[1], 0x5de) }
  const baseInfo = (o, l) => { const b = baseOf(o, l); if (!b) return {}; return { mat: nval(b[0], b[1], 0x7d1), layer: nval(b[0], b[1], 0x7d2), flags: nval(b[0], b[1], 0x7d3) || 0 } }
  // атрибуты сущности: { словарь: { ключ: значение } }
  const attrs = (o, l) => {
    const b = baseOf(o, l) || [o, l]
    const r = child(b[0], b[1], 0x5dc); if (!r) return {}
    const a = child(r[0], r[1], 0x5dd); if (!a) return {}
    const a1 = child(a[0], a[1], 0x36b1); const a2 = a1 && child(a1[0], a1[1], 0x36b2)
    const out = {}
    if (!a2) return out
    for (const [o3, l3] of children(a2[0], a2[1], 0x36b3)) {
      const name = sval(o3, l3, 0x36b4) || ''
      const p = child(o3, l3, 0x36b5); const d = {}
      let key = null
      for (const [t4, o4, l4] of (p ? kidsOf(p[0], p[1]) || [] : [])) {
        if (t4 === 0x36b6) key = R.str(o4, l4)
        else if (t4 === 0x38a4 && key != null) {
          let v = null
          for (const [t5, o5, l5] of kidsOf(o4, l4) || []) {
            if (t5 === 0x38a9 && l5 === 8) v = dbl(o5)
            else if (t5 === 0x38ad) v = R.str(o5, l5)
            else if (t5 === 0x38a7 && l5 === 4) v = dv.getInt32(o5, true)
          }
          d[key] = v
        }
      }
      out[name] = d
    }
    return out
  }

  // слои и материалы
  const layers = new Map()
  { const t = topOf(0x1f8); const a0 = t && child(t[0], t[1], 0x3a98); const a = a0 && child(a0[0], a0[1], 0x3a99)
    for (const [o, l] of a ? children(a[0], a[1], 0x3c8c) : []) layers.set(idOf(o, l), sval(o, l, 0x3c8d) || '') }
  const materials = new Map()
  { const t = topOf(0x1f7); const a = t && child(t[0], t[1], 0x30d4); const b = a && child(a[0], a[1], 0x30d5)
    for (const [o, l] of b ? children(b[0], b[1], 0x32c8) : []) materials.set(idOf(o, l), sval(o, l, 0x32cc) || '') }

  // определения компонентов: id сущностей -> { name, ent }
  const defs = new Map()
  { const t = topOf(0x1f9); const a = t && child(t[0], t[1], 0x1770); const b = a && child(a[0], a[1], 0x1771)
    for (const [o, l] of b ? children(b[0], b[1], 0x157c) : []) {
      const ent = child(o, l, 0x1388); if (!ent) continue
      defs.set(idOf(ent[0], ent[1]), { name: sval(o, l, 0x157e) || '', ent })
    } }
  const rootEnt = (() => { const t = topOf(0x1f6); return t && child(t[0], t[1], 0x1388) })()
  if (!rootEnt) throw new Error('в модели SketchUp не найдено содержимое')

  // вставки компонентов и групп в наборе сущностей
  const instancesOf = ent => {
    const out = []
    const c = child(ent[0], ent[1], 0x138c)
    if (c) for (const [o, l] of children(c[0], c[1], 0x1964)) out.push([o, l])
    const g = child(ent[0], ent[1], 0x138d)
    if (g) for (const [o, l] of children(g[0], g[1], 0x1d4c)) { const i = child(o, l, 0x1964); if (i) out.push(i) }
    return out
  }
  const tfOf = (o, l) => {
    const r = child(o, l, 0x1966); if (!r || r[1] < 104) return mat4()
    const a = []; for (let i = 0; i < 13; i++) a.push(dbl(r[0], i))
    const w = a[12] || 1
    return [a[0] / w, a[3] / w, a[6] / w, a[9] / w, a[1] / w, a[4] / w, a[7] / w, a[10] / w, a[2] / w, a[5] / w, a[8] / w, a[11] / w, 0, 0, 0, 1]
  }
  // геометрия набора сущностей: вершины, рёбра, грани (петли вершин)
  const geomMemo = new Map()
  const geomOf = ent => {
    let g = geomMemo.get(ent[0]); if (g) return g
    const V = new Map(), E = new Map(), F = []
    const vs = child(ent[0], ent[1], 0x1389)
    if (vs) for (const [o, l] of children(vs[0], vs[1], 0x9c4)) { const p = child(o, l, 0x9c5); if (p) V.set(idOf(o, l), [dbl(p[0], 0), dbl(p[0], 1), dbl(p[0], 2)]) }
    const es = child(ent[0], ent[1], 0x138a)
    if (es) for (const [o, l] of children(es[0], es[1], 0xbb8)) E.set(idOf(o, l), [nval(o, l, 0xbb9), nval(o, l, 0xbba)])
    const fs = child(ent[0], ent[1], 0x138b)
    if (fs) for (const [o, l] of children(fs[0], fs[1], 0xdac)) {
      const pl = child(o, l, 0xdad), lp = child(o, l, 0xdae)
      const n = pl && pl[1] >= 24 ? [dbl(pl[0], 0), dbl(pl[0], 1), dbl(pl[0], 2)] : null
      const loops = []
      for (const [o2, l2] of lp ? children(lp[0], lp[1], 0x1194) : []) {
        const u = child(o2, l2, 0x1195); if (!u) continue
        const seq = []
        for (const [o3, l3] of children(u[0], u[1], 0xfa0)) {
          const e = E.get(nval(o3, l3, 0xfa1)); const rv = child(o3, l3, 0xfa2)
          if (e) seq.push(rv && m[rv[0]] ? e[1] : e[0])
        }
        if (seq.length >= 3) loops.push(seq)
      }
      if (loops.length) F.push({ n, loops, mat: baseInfo(o, l).mat })
    }
    g = { V, F }; geomMemo.set(ent[0], g); return g
  }

  // ── обход модели ──
  const panels = []          // { M (мир), ent, parent: attrs, product, path }
  const others = []          // { M, ent, name, product }
  let hiddenSkipped = 0
  const walk = (ent, M, path, product, parentAttrs, depth) => {
    if (depth > 40) return
    for (const [o, l] of instancesOf(ent)) {
      const bi = baseInfo(o, l)
      if (bi.flags & 1) { hiddenSkipped++; continue }
      const ln = layers.get(bi.layer) || 'Layer0'
      if (SERVICE.test(ln)) continue
      const def = defs.get(nval(o, l, 0x1967)); if (!def) continue
      const W = mul(M, tfOf(o, l))
      const at = attrs(o, l)
      const dyn = at.dynamic_attributes || {}
      const prod = product || def.name.replace(/#/g, '').trim()
      // тело панели — «Essence» плагина; у фурнитуры (штанги, держатели) тело тоже «Essence», но это не листовая деталь
      const isPanelBody = /^Essence/.test(def.name) && !/(Фурнитур|Ручк|Металл|Accessor)/i.test(ln) && (parentAttrs || {}).a09_su_type !== 'furniture'
      if (isPanelBody) { panels.push({ M: W, ent: def.ent, own: dyn, parent: parentAttrs || {}, product: prod, layer: ln, path }); continue }
      const g = geomOf(def.ent)
      if (g.F.length) others.push({ M: W, ent: def.ent, name: cleanName(sval(o, l, 0x1965) || dyn.a03_name || def.name), product: prod, layer: ln, mat: bi.mat })
      walk(def.ent, W, [...path, cleanName(dyn.a03_name || def.name)], prod, dyn.a03_name ? dyn : parentAttrs, depth + 1)
    }
  }
  // грани прямо в корне модели (редко) — тоже в 3D
  const rootM = UP
  if (geomOf(rootEnt).F.length) others.push({ M: rootM, ent: rootEnt, name: 'Модель', product: '', layer: 'Layer0' })
  walk(rootEnt, rootM, [], '', null, 0)

  // ── панели -> детали заказа ──
  const makers = []
  let pid = 0
  for (const pnl of panels) {
    const id = pid++
    const { V, F } = geomOf(pnl.ent)
    if (!V.size) continue
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
    for (const p of V.values()) for (let k = 0; k < 3; k++) { if (p[k] < lo[k]) lo[k] = p[k]; if (p[k] > hi[k]) hi[k] = p[k] }
    // тело Essence: толщина — по X, пласть — Y×Z
    const ax = applyV(pnl.M, [1, 0, 0]), ay = applyV(pnl.M, [0, 1, 0]), az = applyV(pnl.M, [0, 0, 1])
    const sx = vlen(ax) * IN, sy = vlen(ay) * IN, sz = vlen(az) * IN
    const T = r1((hi[0] - lo[0]) * sx)
    if (!(T > 1 && T < 80)) continue
    const u = norm(ay), v = norm(az), n = norm(ax)
    const o = apply(pnl.M, [lo[0], 0, 0]).map(c => c * IN)
    const Mp = [u[0], v[0], n[0], u[1], v[1], n[1], u[2], v[2], n[2], o[0], o[1], o[2]]
    // контур — пласть (грань с нормалью вдоль X): петли вершин в координатах Y, Z
    let face = null
    for (const f of F) if (f.n && Math.abs(f.n[0]) > 0.99 && (!face || f.loops[0].length > face.loops[0].length)) face = f
    const toUV = id => { const p = V.get(id); return p ? [p[1] * sy, p[2] * sz] : null }
    let loops = face ? face.loops.map(lp => lp.map(toUV).filter(Boolean)) : []
    if (!loops.length || loops[0].length < 3) loops = [[[lo[1] * sy, lo[2] * sz], [hi[1] * sy, lo[2] * sz], [hi[1] * sy, hi[2] * sz], [lo[1] * sy, hi[2] * sz]]]
    const elems = []
    for (const lp of loops) for (let i = 0; i < lp.length; i++) elems.push({ t: 'L', a: lp[i], b: lp[(i + 1) % lp.length] })
    // кромка по сторонам: y1 — у края Z=max, y2 — Z=min, z1 — Y=min (перед), z2 — Y=max
    const pa = pnl.parent
    const krom = cleanMat(pa.a07_mat_krom || pa.a00_mat_krom || pa.a06_mat_panel || pnl.own.material)
    const Y0 = lo[1] * sy, Y1 = hi[1] * sy, Z0 = lo[2] * sz, Z1 = hi[2] * sz
    const butts = []
    const side = (code, a, b) => { const mm = EDGE_MM[Math.round(Number(code))]; if (mm) butts.push({ e: { t: 'L', a, b }, name: `${krom ? krom + ' ' : ''}${mm} мм`.trim(), info: { mat: krom, thick: Number(mm) } }) }
    side(pa.edge_y1, [Y0, Z1], [Y1, Z1]); side(pa.edge_y2, [Y0, Z0], [Y1, Z0])
    side(pa.edge_z1, [Y0, Z0], [Y0, Z1]); side(pa.edge_z2, [Y1, Z0], [Y1, Z1])
    const material = cleanMat(pa.a06_mat_panel || pa.material || pnl.own.material)
    const name = cleanName(pa.a03_name) || (/(1_Фасад)/.test(pnl.layer) ? 'Фасад' : 'Панель')
    // направление текстуры: 1 — по длине (вдоль Z тела), 2 — по ширине
    const napr = String(pa.a05_napr ?? pa.napr_texture ?? '1')
    const texDir = napr === '2' ? 1 : 2
    makers.push(() => buildItem({
      T, elems, texDir, M: Mp, butts, cutsRaw: [], decorRaw: [], warnCuts: 0,
      name, prefix: '', material, rotatable: false, anim: null,
      meta: { src: 'sketchup', ids: [id], des: pa.itemcode || '', pos: '', name, product: pnl.product, productDes: '', productPos: '', path: pnl.path.slice(1), material, materialCode: pa.type_material || '' },
    }, [], opts.faceRule))
  }

  // ── остальное с гранями -> 3D «фурнитура»; одинаковые формы — одна сетка ──
  const meshes = {}, hardware = []
  const byShape = new Map()
  for (const ob of others) {
    const { V, F } = geomOf(ob.ent)
    const pos = []
    for (const f of F) {
      const pts = f.loops.map(lp => lp.map(id => V.get(id)).filter(Boolean))
      if (!pts[0] || pts[0].length < 3) continue
      // плоскость грани -> 2D для триангуляции
      const nrm = f.n ? norm(f.n) : [0, 0, 1]
      const ref = Math.abs(nrm[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
      const e1 = norm([nrm[1] * ref[2] - nrm[2] * ref[1], nrm[2] * ref[0] - nrm[0] * ref[2], nrm[0] * ref[1] - nrm[1] * ref[0]])
      const e2 = [nrm[1] * e1[2] - nrm[2] * e1[1], nrm[2] * e1[0] - nrm[0] * e1[2], nrm[0] * e1[1] - nrm[1] * e1[0]]
      const to2 = p => new Vector2(p[0] * e1[0] + p[1] * e1[1] + p[2] * e1[2], p[0] * e2[0] + p[1] * e2[1] + p[2] * e2[2])
      const flat = pts.flat()
      let tris
      try { tris = ShapeUtils.triangulateShape(pts[0].map(to2), pts.slice(1).filter(h => h.length >= 3).map(h => h.map(to2))) } catch { tris = [] }
      for (const t of tris) for (const i of t) { const p = flat[i]; if (p) pos.push(Math.round(p[0] * IN * 10), Math.round(p[1] * IN * 10), Math.round(p[2] * IN * 10)) }
    }
    if (!pos.length) continue
    const key = pos.length + ':' + pos.slice(0, 60).join(',') + ':' + pos.slice(-30).join(',')
    let f = byShape.get(key)
    if (f == null) { f = 's' + byShape.size; byShape.set(key, f); meshes[f] = { name: ob.name, groups: [{ mat: cleanMat(materials.get(ob.mat) || ''), pos }] } }
    const W = ob.M
    hardware.push({ f, m: [W[0], W[1], W[2], W[4], W[5], W[6], W[8], W[9], W[10], W[3] * IN, W[7] * IN, W[11] * IN].map((v, i) => (i < 9 ? Math.round(v * 1e6) / 1e6 : Math.round(v * 10) / 10)), b: ob.product })
  }

  const { items, groups, skipped } = groupItems(makers)
  if (!items.length) throw new Error('в модели SketchUp не найдено панелей мебельного плагина (тела «Essence»)')
  const scene = {
    v: 1, order: '',
    parts: items.map(it => ({ name: it.name, w: it.w, h: it.h, edges: it.edges, contour: it.contour })),
    extras: [], meshes, hardware, colors: {},
  }
  return { orderName: '', scene, skipped, items, groups, skp: true, other: hardware.length, hidden: hiddenSkipped }
}

export async function readSkpFile(file, opts) {
  const res = parseSkp(new Uint8Array(await file.arrayBuffer()), opts)
  const title = file.name.replace(/\.[^.]+$/, '')
  res.orderName = title
  res.scene.order = title
  for (const it of res.items) { it.contour.meta.file = file.name; it.contour.meta.order = title }
  return res
}

export const isSkp = head => head[0] === 0xff && head[1] === 0xfe && head[2] === 0xff
