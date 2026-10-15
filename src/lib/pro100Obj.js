// Модель из PRO100, сохранённая как Wavefront OBJ (Файл → Экспорт → OBJ).
//
// В OBJ есть только геометрия: каждый объект (`o N_`) — набор вершин и граней. Панель из листа —
// это прямоугольный брусок: по нему берём габарит, толщину и положение в модели (для 3D).
// Названий деталей, материала, кромки, присадки и направления текстуры в файле нет:
//   - название подставляем по положению (горизонтальная — «Полка», вертикальная — «Стойка» / «Планка»);
//   - длиной считаем большую сторону (текстура вдоль неё), поворот на листе запрещён;
//   - материал — по толщине (название материала в OBJ условное: material_0).
// Всё, что не брусок листовой толщины (техника, ручки, фигурные тела), идёт в 3D как «фурнитура».
// Единицы — метры (PRO100) или миллиметры: определяем по габариту модели.

import { buildItem, groupItems } from './basisB3d.js'

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const len = a => Math.hypot(a[0], a[1], a[2])
const r1 = v => Math.round(v * 10) / 10

const T_MIN = 2.5, T_MAX = 60        // толщина листового материала, мм

export const looksLikeObj = text => /^\s*(?:#[^\n]*\n\s*|mtllib[^\n]*\n\s*)*(?:o|g|v)\s/m.test(text) && /^v\s+-?[\d.]/m.test(text) && /^f\s/m.test(text)

function readObj(text) {
  const V = []
  const objs = []
  let cur = null, mtl = ''
  const start = name => { cur = { name, faces: [], mtl: '' }; objs.push(cur) }
  let hasO = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line[0] === '#') continue
    const sp = line.indexOf(' ')
    const key = sp < 0 ? line : line.slice(0, sp), rest = sp < 0 ? '' : line.slice(sp + 1).trim()
    if (key === 'v') { const p = rest.split(/\s+/); V.push([+p[0], +p[1], +p[2]]) }
    else if (key === 'o') { hasO = true; start(rest) }
    else if (key === 'g') { if (!hasO) start(rest) }
    else if (key === 'usemtl') { mtl = rest; if (cur && !cur.mtl) cur.mtl = rest }
    else if (key === 'f') {
      if (!cur) start('')
      if (!cur.mtl) cur.mtl = mtl
      const idx = rest.split(/\s+/).map(t => { const i = parseInt(t, 10); return i < 0 ? V.length + i : i - 1 })
      if (idx.length >= 3 && idx.every(i => i >= 0 && i < V.length)) cur.faces.push(idx)
    }
  }
  return { V, objs: objs.filter(o => o.faces.length) }
}

// Брусок? -> { u, v, n, o, du, dv, T } (оси, угол, размеры в мм); иначе null
function boxOf(pts, faces) {
  const axes = []                    // до трёх взаимно перпендикулярных направлений граней
  for (const f of faces) {
    const n = cross(sub(pts[f[1]], pts[f[0]]), sub(pts[f[2]], pts[f[0]]))
    const l = len(n)
    if (l < 1e-6) continue
    const d = [n[0] / l, n[1] / l, n[2] / l]
    if (axes.some(a => Math.abs(dot(a, d)) > 0.9995)) continue
    if (axes.some(a => Math.abs(dot(a, d)) > 0.02)) return null       // грань под углом — не брусок
    axes.push(d)
    if (axes.length > 3) return null
  }
  if (axes.length !== 3) return null
  const ext = axes.map(a => { let lo = Infinity, hi = -Infinity; for (const f of faces) for (const i of f) { const t = dot(a, pts[i]); if (t < lo) lo = t; if (t > hi) hi = t } return { a, lo, hi, d: hi - lo } })
  // все вершины — в углах бруска
  for (const f of faces) for (const i of f) for (const e of ext) { const t = dot(e.a, pts[i]); if (Math.min(t - e.lo, e.hi - t) > 0.05) return null }
  ext.sort((p, q) => q.d - p.d)
  const [eu, ev, en] = ext
  const u = eu.a, v = ev.a
  const n = cross(u, v)
  const sN = dot(n, en.a) > 0 ? 1 : -1                                 // n = ±ось толщины
  const nLo = sN > 0 ? en.lo : -en.hi
  const o = [0, 1, 2].map(k => u[k] * eu.lo + v[k] * ev.lo + n[k] * nLo)
  return { u, v, n, o, du: eu.d, dv: ev.d, T: en.d }
}

export function parsePro100Obj(text, opts = {}) {
  const { V, objs } = readObj(text)
  if (!objs.length) throw new Error('в файле OBJ нет объектов')
  let max = 0
  for (const p of V) for (const c of p) if (Math.abs(c) > max) max = Math.abs(c)
  const k = max < 100 ? 1000 : 1                                       // метры -> мм
  const P = V.map(p => [p[0] * k, p[1] * k, p[2] * k])
  const generic = m => !m || /^material[_ ]?\d*$/i.test(m) || /^default/i.test(m)

  const makers = [], meshes = {}, hardware = []
  const I = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]
  objs.forEach((ob, oi) => {
    const b = boxOf(P, ob.faces)
    if (!b || b.T < T_MIN || b.T > T_MAX || b.dv < 5) {
      const pos = []
      for (const f of ob.faces) for (let i = 1; i + 1 < f.length; i++) for (const j of [f[0], f[i], f[i + 1]]) pos.push(Math.round(P[j][0] * 10), Math.round(P[j][1] * 10), Math.round(P[j][2] * 10))
      meshes[oi] = { name: ob.name, groups: [{ mat: generic(ob.mtl) ? '' : ob.mtl, pos }] }
      hardware.push({ f: oi, m: I })
      return
    }
    makers.push(() => {
      const T = r1(b.T), L = r1(Math.round(b.du * 2) / 2), W = r1(Math.round(b.dv * 2) / 2)
      const { u, v, n, o } = b
      const M = [u[0], v[0], n[0], u[1], v[1], n[1], u[2], v[2], n[2], o[0], o[1], o[2]]
      const c = [[0, 0], [L, 0], [L, W], [0, W]]
      const elems = c.map((a, i) => ({ t: 'L', a, b: c[(i + 1) % 4] }))
      // в PRO100 высота — ось Y
      const name = Math.abs(n[1]) > 0.9 ? 'Полка' : Math.abs(u[1]) > 0.9 ? 'Стойка' : 'Планка'
      const material = generic(ob.mtl) ? '' : ob.mtl
      return buildItem({
        T, elems, texDir: 1, M, butts: [], cutsRaw: [], decorRaw: [], warnCuts: 0,
        name, prefix: '', material, rotatable: false, anim: null,
        meta: { src: 'pro100', ids: [oi], des: '', pos: '', name, product: '', productDes: '', productPos: '', path: [], material, materialCode: '' },
      }, [], opts.faceRule)
    })
  })
  const { items, groups, skipped } = groupItems(makers)
  if (!items.length) throw new Error('в модели не найдено панелей (прямоугольных деталей листовой толщины)')
  const orderName = ''
  for (const it of items) { it.contour.meta.order = orderName; it.contour.meta.model = '' }
  const scene = {
    v: 1, order: orderName,
    parts: items.map(it => ({ name: it.name, w: it.w, h: it.h, edges: it.edges, contour: it.contour })),
    extras: [], meshes, hardware, colors: {},
  }
  return { orderName, scene, skipped, items, groups, bare: true, other: hardware.length }
}

export async function readPro100Obj(file, opts) {
  const res = parsePro100Obj(new TextDecoder('utf-8').decode(new Uint8Array(await file.arrayBuffer())), opts)
  const title = file.name.replace(/\.[^.]+$/, '')
  res.orderName = title
  res.scene.order = title
  for (const it of res.items) { it.contour.meta.file = file.name; it.contour.meta.order = title }
  return res
}
