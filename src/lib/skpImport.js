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
  if (at < 0) throw new Error('это файл старой версии SketchUp (до 2021). Пересохраните его в новом формате: бесплатно в браузере — app.sketchup.com → открыть файл → «Сохранить как» / «Скачать» (.skp), или в SketchUp 2021 и новее, — затем импортируйте')
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
  const walk = (ent, M, path, product, parentAttrs, depth, chain = '') => {
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
      if (isPanelBody) { panels.push({ M: W, ent: def.ent, own: dyn, parent: parentAttrs || {}, product: prod, layer: ln, path, chain }); continue }
      const g = geomOf(def.ent)
      if (g.F.length && !/^holes/i.test(def.name)) others.push({ M: W, ent: def.ent, name: cleanName(sval(o, l, 0x1965) || dyn.a03_name || def.name), product: prod, layer: ln, mat: bi.mat })
      walk(def.ent, W, [...path, cleanName(dyn.a03_name || def.name)], prod, dyn.a03_name ? dyn : parentAttrs, depth + 1, chain + '/' + o)
    }
  }
  // грани прямо в корне модели (редко) — тоже в 3D
  const rootM = UP
  if (geomOf(rootEnt).F.length) others.push({ M: rootM, ent: rootEnt, name: 'Модель', product: '', layer: 'Layer0' })
  walk(rootEnt, rootM, [], '', null, 0)

  // ── обычная модель (без мебельного плагина): панель — тело-«плита» ──
  // Панели нарисованы компонентами / группами с именами («Шкаф дно полки#9»). Плита — все вершины тела лежат на двух
  // параллельных плоскостях (пласти) на расстоянии толщины 2,5–60 мм, а пласть не меньше 20 мм по каждой стороне и
  // заметно больше толщины. Ось толщины — нормаль самой большой грани (плита может стоять в модели под любым углом).
  // Название — имя вставки или компонента без «#номер», изделие — верхний компонент, материал — материал SketchUp.
  const plain = []
  if (!panels.length) {
    others.length = 0
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
    const slabMemo = new Map()
    // плита в координатах определения: { nl, ul, vl, lo, hi } (lo/hi — по осям u, v, n) или null
    const areaN = P => { let nx = 0, ny = 0, nz = 0; for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; nx += (a[1] - b[1]) * (a[2] + b[2]); ny += (a[2] - b[2]) * (a[0] + b[0]); nz += (a[0] - b[0]) * (a[1] + b[1]) } return [nx / 2, ny / 2, nz / 2] }
    // Плита: самая большая грань задаёт ось толщины n; пласти — грани, параллельные ей, у крайних плоскостей тела
    // (лицо и оборот). Обе пласти занимают большую часть габарита — это плита, а не ручка или фигурная фурнитура.
    // Вершины между пластями допустимы: отверстия, выемки, фрезерованный профиль фасада.
    const slabOf = ent => {
      if (slabMemo.has(ent[0])) return slabMemo.get(ent[0])
      const { V, F } = geomOf(ent)
      let res = null
      if (V.size >= 6 && F.length >= 4) {
        const fa = []
        let big = null, bigA = 0
        for (const f of F) {
          const P = f.loops[0].map(id => V.get(id)).filter(Boolean)
          if (P.length < 3) continue
          const an = areaN(P), A = vlen(an)
          fa.push({ f, P, A, n: norm(an) })
          if (A > bigA) { bigA = A; big = fa[fa.length - 1] }
        }
        if (big) {
          const nl = big.n
          let ul = null, ulL = 0
          for (let i = 0; i < big.P.length; i++) { const a = big.P[i], b = big.P[(i + 1) % big.P.length]; const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], L = vlen(d); if (L > ulL) { ulL = L; ul = d } }
          if (ul) {
            ul = norm(ul.map((c, k) => c - dot(ul, nl) * nl[k]))
            const vl = cross(nl, ul)
            const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
            for (const p of V.values()) { const q = [dot(p, ul), dot(p, vl), dot(p, nl)]; for (let k = 0; k < 3; k++) { if (q[k] < lo[k]) lo[k] = q[k]; if (q[k] > hi[k]) hi[k] = q[k] } }
            const tol = 0.3 / IN, box = (hi[0] - lo[0]) * (hi[1] - lo[1])
            let top = 0, bot = 0
            for (const x of fa) {
              if (Math.abs(dot(x.n, nl)) < 0.999) continue
              const z = dot(x.P[0], nl)
              if (Math.abs(z - hi[2]) < tol) top += x.A; else if (Math.abs(z - lo[2]) < tol) bot += x.A
            }
            if (box > 0 && Math.max(top, bot) >= 0.6 * box && Math.min(top, bot) >= 0.3 * box) res = { nl, ul, vl, lo, hi }
          }
        }
      }
      slabMemo.set(ent[0], res); return res
    }
    const walkPlain = (ent, M, path, product, depth) => {
      if (depth > 40) return
      for (const [o, l] of instancesOf(ent)) {
        const bi = baseInfo(o, l)
        if (bi.flags & 1) { hiddenSkipped++; continue }
        const ln = layers.get(bi.layer) || 'Layer0'
        const def = defs.get(nval(o, l, 0x1967)); if (!def) continue
        const W = mul(M, tfOf(o, l))
        const iname = sval(o, l, 0x1965) || ''
        const nm = cleanName(iname || def.name)
        const prod = product || nm
        const sl = slabOf(def.ent)
        if (sl) {
          const su = vlen(applyV(W, sl.ul)) * IN, sv = vlen(applyV(W, sl.vl)) * IN, sn = vlen(applyV(W, sl.nl)) * IN
          const T = (sl.hi[2] - sl.lo[2]) * sn, A = (sl.hi[0] - sl.lo[0]) * su, B = (sl.hi[1] - sl.lo[1]) * sv
          if (T >= 2.5 && T <= 60 && Math.min(A, B) >= 20 && T <= 0.5 * Math.min(A, B)) {
            const { F } = geomOf(def.ent)
            const fm = F.map(f => f.mat).find(Boolean)
            plain.push({ M: W, ent: def.ent, sl, name: nm, product: depth ? prod : '', layer: ln, path, mat: cleanMat(materials.get(bi.mat) || materials.get(fm) || '') })
            continue
          }
        }
        const g = geomOf(def.ent)
        if (g.F.length) others.push({ M: W, ent: def.ent, name: nm, product: prod, layer: ln, mat: bi.mat })
        walkPlain(def.ent, W, [...path, nm], prod, depth + 1)
      }
    }
    walkPlain(rootEnt, rootM, [], '', 0)
  }

  // ── присадка: цилиндры крепежа плагина (слой Z_fastener: конфирмат, шкант, эксцентрик, полкодержатель) и чашки петель ──
  // Отверстие в модели — тело-цилиндр: две круглые грани одного диаметра на одной оси. Передаём оба направления оси —
  // какой торец входит в деталь (пласть или торец), решает разбор детали.
  const cylMemo = new Map()
  const cylindersOf = ent => {
    let cs = cylMemo.get(ent[0]); if (cs) return cs
    const { V, F } = geomOf(ent)
    const circ = []
    for (const f of F) {
      const lp = f.loops[0]; if (lp.length < 10 || !f.n) continue
      const P = lp.map(id => V.get(id)).filter(Boolean)
      const c = [0, 1, 2].map(k => P.reduce((a, p) => a + p[k], 0) / P.length)
      const ds = P.map(p => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]))
      const r = ds.reduce((a, b) => a + b, 0) / ds.length
      if (!(r > 0) || ds.some(d => Math.abs(d - r) > r * 0.04)) continue
      circ.push({ c, n: norm(f.n), r })
    }
    cs = []
    const used = new Set()
    for (let i = 0; i < circ.length; i++) for (let j = i + 1; j < circ.length; j++) {
      if (used.has(i) || used.has(j)) continue
      const a = circ[i], b = circ[j]
      if (Math.abs(a.r - b.r) > a.r * 0.04 || Math.abs(a.n[0] * b.n[0] + a.n[1] * b.n[1] + a.n[2] * b.n[2]) < 0.995) continue
      const d = [b.c[0] - a.c[0], b.c[1] - a.c[1], b.c[2] - a.c[2]], L = vlen(d)
      if (L < 1e-6) continue
      const along = Math.abs(d[0] * a.n[0] + d[1] * a.n[1] + d[2] * a.n[2])
      if (L - along > a.r * 0.1) continue                      // центры не на одной оси
      used.add(i); used.add(j); cs.push({ a: a.c, b: b.c, r: a.r })
    }
    cylMemo.set(ent[0], cs); return cs
  }
  const HOLE_NAME = { 35: 'Петля', 15: 'Эксцентрик', 8: 'Шкант', 7: 'Конфирмат', 4.5: 'Конфирмат', 5: 'Полкодержатель' }
  const holes = [], cups = [], grooves = []
  const walkHoles = (ent, M, depth, chain = '', owner = '') => {
    if (depth > 40) return
    for (const [o, l] of instancesOf(ent)) {
      const bi = baseInfo(o, l)
      if (bi.flags & 1) continue
      const def = defs.get(nval(o, l, 0x1967)); if (!def) continue
      const W = mul(M, tfOf(o, l))
      const ln = layers.get(bi.layer) || ''
      // пазы плагина — компоненты groove… (тело-брусок): габарит в мире
      if (/^groove/i.test(def.name)) {
        const { V } = geomOf(def.ent)
        if (V.size) {
          const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
          for (const p of V.values()) for (let k = 0; k < 3; k++) { if (p[k] < lo[k]) lo[k] = p[k]; if (p[k] > hi[k]) hi[k] = p[k] }
          const pts = []
          for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) pts.push(apply(W, [x, y, z]).map(c => c * IN))
          grooves.push(pts)
        }
      }
      const cupHere = /hinge cup/i.test(def.name)
      if (ln === 'Z_fastener' || cupHere) {
        for (const cy of cylindersOf(def.ent)) {
          const A = apply(W, cy.a).map(v => v * IN), B = apply(W, cy.b).map(v => v * IN)
          const dvec = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], depthMm = vlen(dvec)
          const r = Math.round(cy.r * IN * 20) / 20
          if (depthMm < 0.5 || r < 0.5 || r > 30) continue
          const D = norm(dvec), dia = Math.round(r * 20) / 10
          const name = HOLE_NAME[dia] || `Ø${dia}`
          const h = { P: A, D, r, depth: depthMm, name }, h2 = { P: B, D: D.map(v => -v), r, depth: depthMm, name }
          if (cupHere) { h.owner = h2.owner = owner; cups.push(h, h2) } else holes.push(h, h2)
        }
      }
      const ch = chain + '/' + o
      // хозяин чашки — ближайший компонент плагина, который не фурнитура (фасад, а не сама петля)
      const dy = attrs(o, l).dynamic_attributes || {}
      walkHoles(def.ent, W, depth + 1, ch, dy.a03_name && dy.a09_su_type !== 'furniture' && !/Петл|hinge/i.test(def.name) ? ch : owner)
    }
  }
  walkHoles(rootEnt, rootM, 0)

  // рамка панели: толщина вдоль X тела Essence, пласть — Y×Z; размеры в мм
  const frameOf = pnl => {
    if (pnl.fr !== undefined) return pnl.fr
    const { V } = geomOf(pnl.ent)
    if (!V.size) return (pnl.fr = null)
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
    for (const p of V.values()) for (let k = 0; k < 3; k++) { if (p[k] < lo[k]) lo[k] = p[k]; if (p[k] > hi[k]) hi[k] = p[k] }
    const ax = applyV(pnl.M, [1, 0, 0]), ay = applyV(pnl.M, [0, 1, 0]), az = applyV(pnl.M, [0, 0, 1])
    const sx = vlen(ax) * IN, sy = vlen(ay) * IN, sz = vlen(az) * IN
    const T = r1((hi[0] - lo[0]) * sx)
    const u = norm(ay), v = norm(az), n = norm(ax)
    const o = apply(pnl.M, [lo[0], 0, 0]).map(c => c * IN)
    const toL = P => { const d = [P[0] - o[0], P[1] - o[1], P[2] - o[2]]; return [d[0] * u[0] + d[1] * u[1] + d[2] * u[2], d[0] * v[0] + d[1] * v[1] + d[2] * v[2], d[0] * n[0] + d[1] * n[1] + d[2] * n[2]] }
    return (pnl.fr = { lo, hi, T, u, v, n, o, sy, sz, Y0: lo[1] * sy, Y1: hi[1] * sy, Z0: lo[2] * sz, Z1: hi[2] * sz, toL })
  }
  // чашки петель -> фасады: каждая чашка — одному фасаду того же изделия, к кромке которого она ближе всего
  const facades = panels.filter(p => /Фасад/i.test(p.layer))
  for (let i = 0; i + 1 < cups.length; i += 2) {
    const a = cups[i], b = cups[i + 1]
    const mid = [0, 1, 2].map(k => (a.P[k] + b.P[k]) / 2)
    let best = null, bestD = 60
    for (const f of facades) {
      if (!a.owner || !f.chain.startsWith(a.owner)) continue
      const fr = frameOf(f); if (!fr) continue
      const q = fr.toL(mid)
      // петля повёрнута вокруг кромки у начала координат фасада (Y = 0): чашка за ней — отражаем
      const x = q[0] < fr.Y0 ? 2 * fr.Y0 - q[0] : q[0]
      if (!(x > fr.Y0 && x < fr.Y1 && q[1] > fr.Z0 && q[1] < fr.Z1)) continue
      const dd = Math.abs(q[2] - fr.T / 2)
      if (dd < bestD) { bestD = dd; best = f }
    }
    if (best) (best.cups = best.cups || []).push({ ...a, mid })
  }

  // ── панели -> детали заказа ──
  const makers = []
  let pid = 0
  for (const pnl of panels) {
    const id = pid++
    const { V, F } = geomOf(pnl.ent)
    const fr = frameOf(pnl)
    if (!fr) continue
    const { lo, hi, T, u, v, n, o, sy, sz, toL } = fr
    if (!(T > 1 && T < 80)) continue
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
    const { Y0, Y1, Z0, Z1 } = fr
    const butts = []
    const side = (code, a, b) => { const mm = EDGE_MM[Math.round(Number(code))]; if (mm) butts.push({ e: { t: 'L', a, b }, name: `${krom ? krom + ' ' : ''}${mm} мм`.trim(), info: { mat: krom, thick: Number(mm) } }) }
    side(pa.edge_y1, [Y0, Z1], [Y1, Z1]); side(pa.edge_y2, [Y0, Z0], [Y1, Z0])
    side(pa.edge_z1, [Y0, Z0], [Y0, Z1]); side(pa.edge_z2, [Y1, Z0], [Y1, Z1])
    const material = cleanMat(pa.a06_mat_panel || pa.material || pnl.own.material)
    const name = cleanName(pa.a03_name) || (/(1_Фасад)/.test(pnl.layer) ? 'Фасад' : 'Панель')
    // направление текстуры: 1 — по длине (вдоль Z тела), 2 — по ширине
    const napr = String(pa.a05_napr ?? pa.napr_texture ?? '1')
    const texDir = napr === '2' ? 1 : 2
    // чашки петель: в модели плагина петля стоит повёрнутой на 180° вокруг кромки фасада у его начала координат —
    // чашка оказывается за этой кромкой и перед фасадом. Ставим её зеркально, на внутреннюю пласть (дальнюю от зрителя).
    const own = []
    const toW = q => [0, 1, 2].map(k => o[k] + q[0] * u[k] + q[1] * v[k] + q[2] * n[k])
    const toWv = q => [0, 1, 2].map(k => q[0] * u[k] + q[1] * v[k] + q[2] * n[k])
    const innerAtZero = n[2] >= 0
    for (const h of pnl.cups || []) {
      const c = toL(h.mid)
      if (c[0] < Y0) c[0] = 2 * Y0 - c[0]
      if (!(c[0] > Y0 && c[0] < Y1 && c[1] > Z0 && c[1] < Z1)) continue
      c[2] = innerAtZero ? 0 : T
      own.push({ ...h, P: toW(c), D: toWv([0, 0, innerAtZero ? 1 : -1]) })
    }
    const pHoles = own.length ? [...holes, ...own] : holes
    // пазы: брусок паза в системе панели — прямоугольник на пласти и глубина от неё
    const cutsRaw = []
    for (const g of grooves) {
      const L = g.map(toL)
      const mn = [0, 1, 2].map(k => Math.min(...L.map(p => p[k]))), mx = [0, 1, 2].map(k => Math.max(...L.map(p => p[k])))
      const x0 = Math.max(mn[0], Y0), x1 = Math.min(mx[0], Y1), y0 = Math.max(mn[1], Z0), y1 = Math.min(mx[1], Z1)
      const z0 = Math.max(mn[2], 0), z1 = Math.min(mx[2], T)
      if (Math.min(x1 - x0, y1 - y0) < 2 || z1 - z0 < 1) continue          // брусок лишь касается панели
      const top = z1 >= T - 0.3, bottom = z0 <= 0.3
      if (top === bottom) continue                              // насквозь или внутри — не паз
      cutsRaw.push({ p: [x0, y0], q: [x1, y1], depth: r1(z1 - z0), top, name: 'Паз' })
    }
    makers.push(() => buildItem({
      T, elems, texDir, M: Mp, butts, cutsRaw, decorRaw: [], warnCuts: 0,
      name, prefix: '', material, rotatable: false, anim: null,
      meta: { src: 'sketchup', ids: [id], des: pa.itemcode || '', pos: '', name, product: pnl.product, productDes: '', productPos: '', path: pnl.path.slice(1), material, materialCode: pa.type_material || '' },
    }, pHoles, opts.faceRule))
  }

  // обычная модель: плиты -> детали (контур — большая пласть, кромки и присадки в такой модели нет)
  for (const pl of plain) {
    const id = pid++
    const { V, F } = geomOf(pl.ent)
    const { nl, lo, hi } = pl.sl
    let { ul, vl } = pl.sl
    let uw = applyV(pl.M, ul), vw = applyV(pl.M, vl)
    const nw = applyV(pl.M, nl)
    // система панели должна быть правой (u × v = n в мире), иначе контур зеркалится
    const cr = [uw[1] * vw[2] - uw[2] * vw[1], uw[2] * vw[0] - uw[0] * vw[2], uw[0] * vw[1] - uw[1] * vw[0]]
    let flip = cr[0] * nw[0] + cr[1] * nw[1] + cr[2] * nw[2] < 0
    if (flip) { vl = vl.map(c => -c); vw = vw.map(c => -c) }
    const su = vlen(uw) * IN, sv = vlen(vw) * IN, sn = vlen(nw) * IN
    const u = norm(uw), v = norm(vw), n = norm(nw)
    const T = r1((hi[2] - lo[2]) * sn)
    const lu = p => p[0] * ul[0] + p[1] * ul[1] + p[2] * ul[2], lv = p => p[0] * vl[0] + p[1] * vl[1] + p[2] * vl[2]
    const o = apply(pl.M, nl.map(c => c * lo[2])).map(c => c * IN)
    const Mp = [u[0], v[0], n[0], u[1], v[1], n[1], u[2], v[2], n[2], o[0], o[1], o[2]]
    // Контур — пласть с наибольшей площадью (у фрезерованного фасада — оборот, полный прямоугольник). Внутренние петли:
    // сквозной вырез — только если такая же петля есть и на другой пласти; круглые до Ø40 — отверстия (ниже), остальное
    // (открытие глухой выемки) в контур не идёт
    const dotL = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    const toUV = id => { const p = V.get(id); return p ? [lu(p) * su, lv(p) * sv] : null }
    const circleOf = P => {
      if (P.length < 10) return null
      const c = [0, 1, 2].map(k => P.reduce((a, p) => a + p[k], 0) / P.length)
      const ds = P.map(p => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]))
      const r = ds.reduce((a, b) => a + b, 0) / ds.length
      return r > 0 && ds.every(d => Math.abs(d - r) <= r * 0.04) ? { c, r } : null
    }
    const pf = []
    for (const f of F) {
      if (!f.n || Math.abs(dotL(norm(f.n), nl)) < 0.999) continue
      const P0 = f.loops[0].map(id => V.get(id)).filter(Boolean)
      if (P0.length < 3) continue
      const z = dotL(P0[0], nl), tolZ = 0.3 / IN
      const side = Math.abs(z - hi[2]) < tolZ ? 'hi' : Math.abs(z - lo[2]) < tolZ ? 'lo' : null
      let ax = 0
      const pu = P0.map(p => [lu(p) * su, lv(p) * sv])
      for (let i = 0; i < pu.length; i++) { const a = pu[i], b = pu[(i + 1) % pu.length]; ax += a[0] * b[1] - b[0] * a[1] }
      pf.push({ f, side, A: Math.abs(ax) / 2 })
    }
    const outerF = pf.filter(x => x.side).sort((a, b) => b.A - a.A)[0]
    const key = lp => { const P = lp.map(id => V.get(id)).filter(Boolean); const c = [0, 1].map(k => P.reduce((a, p) => a + (k ? lv(p) * sv : lu(p) * su), 0) / P.length); return c.map(x => Math.round(x)).join(',') + ':' + P.length }
    const otherKeys = new Set(pf.filter(x => x.side && outerF && x.side !== outerF.side).flatMap(x => x.f.loops.slice(1).map(key)))
    const holesW = []
    const toW = p => apply(pl.M, p).map(c => c * IN)
    let loops = []
    if (outerF) {
      loops.push(outerF.f.loops[0].map(toUV).filter(Boolean))
      for (const lp of outerF.f.loops.slice(1)) {
        const P = lp.map(id => V.get(id)).filter(Boolean)
        const ci = circleOf(P), through = otherKeys.has(key(lp))
        if (ci && ci.r * IN <= 20) {
          if (through) {   // сквозное отверстие: от этой пласти насквозь
            const sgn = outerF.side === 'hi' ? -1 : 1
            const P0 = toW(ci.c), D = norm(applyV(pl.M, nl.map(c => c * sgn)))
            holesW.push({ P: P0, D, r: Math.round(ci.r * IN * 20) / 20, depth: T, name: `Ø${Math.round(ci.r * IN * 20) / 10}` })
          }
          continue
        }
        if (through) loops.push(lp.map(toUV).filter(Boolean))
      }
    }
    // глухие отверстия: дно — круглая грань внутри тела; открытие — на пласти или торце в сторону её нормали
    for (const f of F) {
      if (!f.n) continue
      const P = f.loops[0].map(id => V.get(id)).filter(Boolean)
      const ci = circleOf(P)
      if (!ci || ci.r * IN > 20) continue
      const m = norm(f.n)
      const zc = dotL(ci.c, m)
      let zmax = -Infinity
      for (const p of V.values()) zmax = Math.max(zmax, dotL(p, m))
      const depthIn = zmax - zc
      if (!(depthIn > 0.3 / IN)) continue            // грань на поверхности тела — не дно отверстия
      const open = ci.c.map((c, k) => c + m[k] * depthIn)
      holesW.push({ P: toW(open), D: norm(applyV(pl.M, m.map(c => -c))), r: Math.round(ci.r * IN * 20) / 20, depth: Math.round(depthIn * vlen(applyV(pl.M, m)) * IN * 10) / 10, name: `Ø${Math.round(ci.r * IN * 20) / 10}` })
    }
    const U0 = Math.min(...[...V.values()].map(p => lu(p) * su)), U1 = Math.max(...[...V.values()].map(p => lu(p) * su))
    const W0 = Math.min(...[...V.values()].map(p => lv(p) * sv)), W1 = Math.max(...[...V.values()].map(p => lv(p) * sv))
    if (!loops.length || loops[0].length < 3) loops = [[[U0, W0], [U1, W0], [U1, W1], [U0, W1]]]
    const elems = []
    for (const lp of loops) for (let i = 0; i < lp.length; i++) elems.push({ t: 'L', a: lp[i], b: lp[(i + 1) % lp.length] })
    // текстура — вдоль длинной стороны (в обычной модели направления нет); поворот детали — как у остальных импортов
    const texDir = U1 - U0 >= W1 - W0 ? 1 : 2
    const name = pl.name || 'Панель'
    makers.push(() => buildItem({
      T, elems, texDir, M: Mp, butts: [], cutsRaw: [], decorRaw: [], warnCuts: 0,
      name, prefix: '', material: pl.mat, rotatable: false, anim: null,
      meta: { src: 'sketchup', ids: [id], des: '', pos: '', name, product: pl.product, productDes: '', productPos: '', path: pl.path.slice(1), material: pl.mat, materialCode: '' },
    }, holesW, opts.faceRule))
  }

  // ── остальное с гранями -> 3D «фурнитура»; одинаковые формы — одна сетка ──
  // Упрощение формы фурнитуры для памяти и скорости: тяжёлые сетки (вешалки, ручки сложной формы) — слиянием вершин
  // в ячейки сетки (около 1/24 габарита); вырожденные треугольники выбрасываются. Вид остаётся узнаваемым.
  const simplify = pos => {
    const tris = pos.length / 9
    if (tris <= 240) return pos
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { if (pos[i + k] < lo[k]) lo[k] = pos[i + k]; if (pos[i + k] > hi[k]) hi[k] = pos[i + k] }
    const cell = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 24 || 1
    const q = (i) => [0, 1, 2].map(k => Math.round(lo[k] + Math.round((pos[i + k] - lo[k]) / cell) * cell))
    const out = [], seen = new Set()
    for (let i = 0; i < pos.length; i += 9) {
      const a = q(i), b = q(i + 3), c = q(i + 6)
      const ka = a.join(), kb = b.join(), kc = c.join()
      if (ka === kb || kb === kc || ka === kc) continue
      const key = [ka, kb, kc].sort().join('|')
      if (seen.has(key)) continue
      seen.add(key); out.push(...a, ...b, ...c)
    }
    pos.length = 0; pos.push(...out)
    return pos
  }
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
    simplify(pos)
    const key = pos.length + ':' + pos.slice(0, 60).join(',') + ':' + pos.slice(-30).join(',')
    let f = byShape.get(key)
    if (f == null) { f = 's' + byShape.size; byShape.set(key, f); meshes[f] = { name: ob.name, groups: [{ mat: cleanMat(materials.get(ob.mat) || ''), pos }] } }
    const W = ob.M
    hardware.push({ f, m: [W[0], W[1], W[2], W[4], W[5], W[6], W[8], W[9], W[10], W[3] * IN, W[7] * IN, W[11] * IN].map((v, i) => (i < 9 ? Math.round(v * 1e6) / 1e6 : Math.round(v * 10) / 10)), b: ob.product })
  }

  // мелкие отверстия (насечки 1–1,5 мм под саморез) и соосные Ø4,5 под Ø7 — оставляем как в модели
  const { items, groups, skipped } = groupItems(makers)
  if (!items.length) throw new Error('в модели SketchUp не найдено панелей: ни компонентов мебельного плагина, ни тел-плит (две параллельные пласти, толщина 2,5–60 мм)')
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
