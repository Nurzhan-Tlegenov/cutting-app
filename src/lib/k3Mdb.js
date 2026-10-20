// Чтение заказа «К3-Мебель» прямо в браузере.
// К3 отдаёт на производство пару файлов: сцену .k3 (закрытый формат, не читаем) и базу Access (.mdb) —
// в ней есть всё, что нужно для раскроя: панели с контуром, кромка по участкам контура, пазы и присадка
// (К3 сам пересекает крепёж с панелями и пишет отверстия в системе координат каждой панели).
//
// Таблицы (К3 8.1, версия базы 21.5):
//   TElems   — дерево объектов: изделие → панели, крепёж, кромка; матрица относительно родителя (3×4, MatrA11…A34)
//   TPanels  — панели (UnitPos → TElems): Length/Width — габарит с кромкой вдоль/поперёк текстуры,
//              PlaneLength/PlaneWidth — чистый пил, Thickness, Dir — угол текстуры (0 вдоль длины, 90 поперёк)
//   TParams  — параметры: HoldTable='TPaths' — контур по участкам: Hold1 — PathID, Hold2 — тип участка
//              (0 — служебные: IDPoly, IDLine, BandUnitPos, WorkID; 1 — отрезок X1 Y1 X2 Y2; 2 — дуга + XM YM),
//              Hold3 — номер участка. IDPoly 1 — внешний контур, дальше — вырезы.
//   TPaths   — список контуров: IsPlanePath 1 — без кромки, 0 — с кромкой (габарит детали), IsTCuts — траектория паза
//   THoles   — отверстия в системе панели: столбец 3 матрицы — ось, 4-й — точка; Diameter, Depth, HolderPos — крепёж
//   TSlots   — пазы на пласти: осевая линия Beg→End, Width, Depth, Plane 0 — пласть z=0, 1 — пласть z=T
//   TBands   — кромка (UnitPos — элемент «Кромка», дитя панели; PriceID элемента — материал кромки)
//   TNNomenclature / TNPropertyValues — материалы: 10 — толщина, 18 — изотропность (без текстуры),
//              21 — ширина кромки, 45 — «кромку нужно подрезать», 280 — прифуговка под кромку
//   TOrderInfo — номер и название заказа
import { Buffer } from 'buffer'
import { buildItem, groupItems, mul } from './basisB3d.js'

if (typeof globalThis.Buffer === 'undefined') globalThis.Buffer = Buffer

const num = (v, d = 0) => { const n = typeof v === 'string' ? parseFloat(v.replace(',', '.')) : Number(v); return Number.isFinite(n) ? n : d }
const str = v => String(v ?? '').trim()

// 'Standard Jet DB' на смещении 4
export function isK3File(u8) {
  if (!u8 || u8.length < 20) return false
  const s = String.fromCharCode(...u8.subarray(4, 19))
  return s === 'Standard Jet DB' || s === 'Standard ACE DB'
}

// К3 → сцена приложения: у К3 ось Z вверх, в сцене вверх — Y (как у Астры: x, z, -y)
const UP = [1, 0, 0, 0, 0, 1, 0, -1, 0, 0, 0, 0]
const matOf = e => [e.MatrA11, e.MatrA12, e.MatrA13, e.MatrA21, e.MatrA22, e.MatrA23, e.MatrA31, e.MatrA32, e.MatrA33, e.MatrA14, e.MatrA24, e.MatrA34].map(v => num(v))

// центр дуги по трём точкам; ccw — направление обхода от a к b через m
function arcByThree(a, m, b) {
  const ax = a[0], ay = a[1], bx = b[0], by = b[1], cx = m[0], cy = m[1]
  const d = 2 * (ax * (cy - by) + cx * (by - ay) + bx * (ay - cy))
  if (Math.abs(d) < 1e-9) return null
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy
  const ux = (a2 * (cy - by) + c2 * (by - ay) + b2 * (ay - cy)) / d
  const uy = (a2 * (bx - cx) + c2 * (ax - bx) + b2 * (cx - ax)) / d
  const cross = (cx - ax) * (by - ay) - (cy - ay) * (bx - ax)      // знак поворота a→m→b
  return { c: [ux, uy], ccw: cross > 0 }
}

export function parseK3(u8, opts = {}) {
  let MDBReader
  try { MDBReader = opts.MDBReader || parseK3.MDBReader } catch { MDBReader = null }
  if (!MDBReader) throw new Error('библиотека чтения базы Access не загружена')
  let db
  try { db = new MDBReader(Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength)) } catch (e) { throw new Error('это не база данных Access (.mdb)', { cause: e }) }
  const names = new Set(db.getTableNames())
  const table = n => (names.has(n) ? db.getTable(n).getData() : [])
  if (!names.has('TPanels') || !names.has('TElems')) throw new Error('в базе нет таблиц К3-Мебель (TPanels, TElems) — это не выгрузка заказа из К3')
  const faceRule = opts.faceRule || 'holes'

  // --- справочники ---
  const elems = new Map(table('TElems').map(e => [num(e.UnitPos), e]))
  const nomen = new Map(table('TNNomenclature').map(n => [num(n.ID), n]))
  const props = new Map()                          // ID номенклатуры -> { propID: value }
  for (const pv of table('TNPropertyValues')) {
    const id = num(pv.EntityID), k = num(pv.PropertyID)
    if (!props.has(id)) props.set(id, {})
    props.get(id)[k] = pv.SValue != null && pv.SValue !== '' ? pv.SValue : (num(pv.DValue) || num(pv.IValue))
  }
  const prop = (id, k) => props.get(id)?.[k]
  const matName = id => str(nomen.get(id)?.Name)
  const works = new Map(table('TWorks').map(w => [num(w.WorkPos), w]))

  // параметры по элементу: контуры
  const paths = new Map()                          // UnitPos -> PathID -> segIdx -> { type, X1.. }
  for (const p of table('TParams')) {
    if (p.HoldTable !== 'TPaths') continue
    const u = num(p.UnitPos), pid = num(p.Hold1), kind = num(p.Hold2), si = num(p.Hold3)
    if (!paths.has(u)) paths.set(u, new Map())
    const pm = paths.get(u)
    if (!pm.has(pid)) pm.set(pid, new Map())
    const sm = pm.get(pid)
    if (!sm.has(si)) sm.set(si, { kind: 0 })
    const seg = sm.get(si)
    if (kind > 0) seg.kind = kind
    seg[p.ParamName] = p.StrValue != null && p.StrValue !== '' ? p.StrValue : num(p.NumValue)
  }
  const pathList = new Map()                       // UnitPos -> [TPaths rows]
  for (const p of table('TPaths')) {
    const u = num(p.PanelPos)
    if (!pathList.has(u)) pathList.set(u, [])
    pathList.get(u).push(p)
  }
  const holesBy = new Map()
  for (const h of table('THoles')) { const u = num(h.UnitPos); if (!holesBy.has(u)) holesBy.set(u, []); holesBy.get(u).push(h) }
  const slotsBy = new Map()
  for (const s of table('TSlots')) { const u = num(s.PanelPos); if (!slotsBy.has(u)) slotsBy.set(u, []); slotsBy.get(u).push(s) }
  const cutsBy = new Map()
  for (const c of table('TCuts')) { const u = num(c.UnitPos); if (!cutsBy.has(u)) cutsBy.set(u, []); cutsBy.get(u).push(c) }

  // матрица элемента в мире: цепочкой через родителей
  const worldCache = new Map()
  const worldOf = (u) => {
    if (worldCache.has(u)) return worldCache.get(u)
    const e = elems.get(u)
    let m = e ? matOf(e) : [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]
    const par = e ? num(e.ParentPos) : 0
    if (par > 0 && par !== u && elems.has(par)) m = mul(worldOf(par), m)
    worldCache.set(u, m)
    return m
  }
  const chainNames = (u) => {                      // названия родителей от изделия к панели (без самой панели)
    const out = []
    let e = elems.get(u), guard = 0
    while (e && num(e.ParentPos) > 0 && guard++ < 50) { e = elems.get(num(e.ParentPos)); if (e) out.unshift(str(e.Name)) }
    return out
  }

  // --- панели -> детали ---
  const makers = []
  const panels = table('TPanels')
  let noContour = 0
  for (const pn of panels) {
    const u = num(pn.UnitPos)
    const e = elems.get(u)
    if (!e) continue
    const T = num(pn.Thickness)
    if (!(T > 0)) continue
    const matId = num(e.PriceID)
    const material = matName(matId) || 'Без материала'
    makers.push(() => {
      // контур: с кромкой (габарит детали), не траектория паза; если нет — контур без кромки
      const rows = pathList.get(u) || []
      const pick = rows.find(r => !r.IsTCuts && !r.IsPlanePath && r.IsResult !== false) || rows.find(r => !r.IsTCuts && !r.IsPlanePath) || rows.find(r => !r.IsTCuts)
      const pid = pick ? num(pick.PathID) : 2
      const segs = paths.get(u)?.get(pid) || paths.get(u)?.get(1)
      if (!segs) { noContour++; return null }
      const elemsOut = [], butts = []
      const sorted = [...segs.entries()].sort((a, b) => a[0] - b[0]).map(x => x[1])
      for (const s of sorted) {
        const a = [num(s.X1), num(s.Y1)], b = [num(s.X2), num(s.Y2)]
        let el
        if (s.kind === 2 && s.XM != null) {
          const arc = arcByThree(a, [num(s.XM), num(s.YM)], b)
          el = arc ? { t: 'A', a, b, c: arc.c, ccw: arc.ccw } : { t: 'L', a, b }
        } else el = { t: 'L', a, b }
        elemsOut.push(el)
        const band = num(s.BandUnitPos)
        if (band > 0) {
          const be = elems.get(band)
          const bid = be ? num(be.PriceID) : 0
          const name = matName(bid)
          if (name) butts.push({ e: el, name, info: {
            mat: name, sign: '',
            thick: num(prop(bid, 10)) || null, width: num(prop(bid, 21)) || null,
            trim: !!num(prop(bid, 45)), joint: num(prop(bid, 280)) || 0,
            work: str(works.get(num(s.WorkID))?.Name),
          } })
        }
      }
      // отверстия К3 уже в системе панели; выравниваем вход на пласть по направлению оси
      const M = mul(UP, worldOf(u))
      const holes = []
      for (const h of holesBy.get(u) || []) {
        const D = [num(h.MatrA13), num(h.MatrA23), num(h.MatrA33)]
        const P = [num(h.MatrA14), num(h.MatrA24), num(h.MatrA34)]
        const dia = num(h.Diameter), depth = num(h.Depth)
        if (!(dia > 0) || !(depth > 0)) continue
        const onFace = Math.abs(D[2]) > 0.99
        if (onFace) P[2] = D[2] > 0 ? 0 : T
        const holder = elems.get(num(h.HolderPos))
        holes.push({ P: applyP(M, P), D: applyV(M, D), r: dia / 2, depth: onFace ? Math.min(depth, T) : depth, name: str(holder?.Name) })
      }
      // пазы на пласти
      const cutsRaw = []
      let warnCuts = 0
      for (const s of slotsBy.get(u) || []) {
        const w = num(s.Width), d = num(s.Depth)
        const x0 = num(s.BegX), y0 = num(s.BegY), x1 = num(s.EndX), y1 = num(s.EndY)
        const hor = Math.abs(x1 - x0) >= Math.abs(y1 - y0)
        if (!(w > 0) || !(d > 0) || (Math.abs(x1 - x0) > 0.05 && Math.abs(y1 - y0) > 0.05)) { warnCuts++; continue }
        const cut = (cutsBy.get(u) || []).find(c => num(c.CutPos) === num(s.CutPos))
        const top = cut ? num(cut.ExtrZ) < 0 : num(s.Plane) === 1
        cutsRaw.push({
          p: hor ? [Math.min(x0, x1), y0 - w / 2] : [x0 - w / 2, Math.min(y0, y1)],
          q: hor ? [Math.max(x0, x1), y0 + w / 2] : [x0 + w / 2, Math.max(y0, y1)],
          depth: Math.min(d, T), top, name: 'Паз',
        })
      }
      const iso = num(prop(matId, 18)) === 1
      const dir = num(pn.Dir)
      const texDir = iso ? 0 : (Math.abs(dir % 180) < 45 ? 1 : 2)
      const chain = chainNames(u)
      const product = chain[0] || ''
      const name = str(e.Name)
      return buildItem({
        T, elems: elemsOut, texDir, M, butts, cutsRaw, edgeCutsRaw: [], pocketsRaw: [], decorRaw: [], warnCuts, tol: 0.5, strict: true,
        name, prefix: product, material, rotatable: iso, anim: null,
        meta: {
          src: 'k3', ids: [u], des: '', pos: '', name, product, productDes: '', productPos: '',
          path: chain.slice(1), material, materialCode: str(nomen.get(matId)?.Article),
        },
      }, holes, faceRule)
    })
  }
  const { items, groups, skipped } = groupItems(makers)

  const oi = table('TOrderInfo')[0]
  const orderName = oi ? [str(oi.OrderNumber) && `№${str(oi.OrderNumber)}`, str(oi.OrderName)].filter(Boolean).join(' ') : ''
  for (const it of items) { it.contour.meta.order = orderName; it.contour.meta.model = '' }
  const scene = {
    v: 1, order: orderName,
    parts: items.map(it => ({ name: it.name, w: it.w, h: it.h, edges: it.edges, contour: it.contour })),
    extras: [], meshes: {}, hardware: [], colors: {},
  }
  return { orderName, scene, skipped: skipped + noContour, items, groups, k3: true }
}

// applyP/applyV здесь свои — basisB3d экспортирует их, но держим модуль независимым от порядка импорта
const applyP = (m, p) => [m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[9], m[3] * p[0] + m[4] * p[1] + m[5] * p[2] + m[10], m[6] * p[0] + m[7] * p[1] + m[8] * p[2] + m[11]]
const applyV = (m, v) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]]

export async function readK3File(file, opts) {
  const mod = await import('mdb-reader')
  parseK3.MDBReader = mod.default
  const res = parseK3(new Uint8Array(await file.arrayBuffer()), opts)
  const title = file.name.replace(/\.[^.]+$/, '')
  if (!res.orderName) { res.orderName = title; res.scene.order = title; for (const it of res.items) it.contour.meta.order = title }
  for (const it of res.items) it.contour.meta.file = file.name
  return res
}

