// Модель bCAD Мебельщик (.bdf).
//
// Файл — дерево записей «тег (LEB128) · длина (4 байта) · данные»; заголовок 12 байт. Строки — байт длины + cp1251.
// Объект — запись с подзаписью 0x7f (тип: CONTAINER, MESH3, XPLINE, ELARC, POINT2…), 0x77 (имя), 0x40b (свойства),
// 0x10 (вложенные объекты). Объекты лежат в слоях (LAYER): «3D панели», «Крепёж»…
//   - деталь — CONTAINER, внутри которого грани-сетки «Лицевая», «Тыльная», «Торец» (и стенки выреза «Отверстие»);
//     координаты — мировые (мм, Z вверх). Контур — грань «Лицевая»: её вершины записаны петлями подряд (наружная,
//     затем вырезы); где кончается петля — видно по торцам: соседние вершины петли лежат на одном торце.
//     Пазы — сечения-прямоугольники (ломаные из 4 точек) поперёк паза; паз — от первого сечения до последнего.
//     Название — имя контейнера, материал — первая строка в свойствах детали («Канадский дуб 16 мм»);
//   - крепёж — CONTAINER с сетками «Отверстие 8x16» (диаметр × глубина); ось отверстия — две точки в свойствах сетки.
// Что не удалось понять — не молчим: список «не перенесено» (как у Астры и SketchUp).
import { buildItem, groupItems, findClashes } from './basisB3d.js'

const r1 = v => Math.round(v * 10) / 10
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const vlen = v => Math.hypot(v[0], v[1], v[2])
const norm = v => { const l = vlen(v) || 1; return [v[0] / l, v[1] / l, v[2] / l] }
// bCAD (Z вверх) -> просмотр (Y вверх), как у SketchUp: (x, y, z) -> (x, z, −y)
const up = p => [p[0], p[2], -p[1]]

export const isBdf = head => head[0] === 1 && head[1] === 0 && head[2] === 0 && head[3] === 0 && head[12] === 0x80 && head[13] === 0x08

function reader(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  const cp = new TextDecoder('windows-1251')
  const leb = o => { let v = 0, s = 0; for (;;) { const b = u8[o++]; v += (b & 0x7f) * 2 ** s; s += 7; if (b < 0x80) return [v, o] } }
  const memo = new Map()
  // дети записи [o, o+l): [[tag, o, l]] или null
  const kids = (o, l) => {
    if (memo.has(o)) return memo.get(o)
    const out = [], end = o + l
    let p = o, ok = true
    while (p < end) {
      if (p + 5 > end) { ok = false; break }
      const [t, q] = leb(p)
      if (q + 4 > end) { ok = false; break }
      const ln = dv.getUint32(q, true)
      if (ln > end - q - 4) { ok = false; break }
      out.push([t, q + 4, ln]); p = q + 4 + ln
    }
    const r = ok ? out : null
    memo.set(o, r); return r
  }
  const str = (o, l) => (l >= 1 && u8[o] === l - 1 ? cp.decode(u8.subarray(o + 1, o + l)) : null)
  return { u8, dv, leb, kids, str }
}

// ломаная петля -> отрезки и дуги: bCAD хранит скругления точками по дуге (шаг — несколько градусов)
const ARC_TURN = 25 * Math.PI / 180
function circle3(a, b, c) {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]))
  if (Math.abs(d) < 1e-9) return null
  const s = p => p[0] * p[0] + p[1] * p[1]
  const x = (s(a) * (b[1] - c[1]) + s(b) * (c[1] - a[1]) + s(c) * (a[1] - b[1])) / d
  const y = (s(a) * (c[0] - b[0]) + s(b) * (a[0] - c[0]) + s(c) * (b[0] - a[0])) / d
  return { c: [x, y], r: Math.hypot(a[0] - x, a[1] - y) }
}
export function arcify(L) {
  const n = L.length
  const lines = () => L.map((p, i) => ({ t: 'L', a: p, b: L[(i + 1) % n] }))
  if (n < 5) return lines()
  const turn = i => {
    const a = L[(i - 1 + n) % n], b = L[i], c = L[(i + 1) % n]
    const u = [b[0] - a[0], b[1] - a[1]], v = [c[0] - b[0], c[1] - b[1]]
    return Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1])
  }
  const tw = L.map((_, i) => turn(i))
  const soft = i => Math.abs(tw[i]) > 0.003 && Math.abs(tw[i]) < ARC_TURN
  const onC = (C, p) => Math.abs(Math.hypot(p[0] - C.c[0], p[1] - C.c[1]) - C.r) < 0.05 + C.r * 2e-4
  if (L.every((_, i) => soft(i) && Math.sign(tw[i]) === Math.sign(tw[0]))) {
    const C = circle3(L[0], L[Math.floor(n / 3)], L[Math.floor(2 * n / 3)])
    if (C && L.every(p => onC(C, p))) return [{ t: 'C', c: C.c, r: C.r }]
  }
  const sl = i => Math.hypot(L[(i + 1) % n][0] - L[i][0], L[(i + 1) % n][1] - L[i][1])
  let st = tw.findIndex((_, i) => !soft(i))
  if (st < 0) { st = 0; for (let i = 1; i < n; i++) if (sl(i) > sl(st)) st = i }      // скруглённый прямоугольник: начать с прямой
  const seg = k => Math.hypot(P[(k + 1) % n][0] - P[k][0], P[(k + 1) % n][1] - P[k][1])
  const P = [...L.slice(st), ...L.slice(0, st)], T2 = [...tw.slice(st), ...tw.slice(0, st)]
  const out = []
  let i = 0
  while (i < n) {
    // серия «мягких» вершин одного знака: i+1..j
    let j = i
    while (j + 1 < n && Math.abs(T2[j + 1]) > 0.003 && Math.abs(T2[j + 1]) < ARC_TURN && (j === i || Math.sign(T2[j + 1]) === Math.sign(T2[i + 1]))
      && (j < i + 2 || (seg(j) < seg(j - 1) * 1.6 && seg(j) * 1.6 > seg(j - 1)))) j++
    if (j - i >= 3) {
      const C = circle3(P[i + 1], P[(i + 1 + j) >> 1], P[j])
      if (C && P.slice(i + 1, j + 1).every(p => onC(C, p))) {
        const a = onC(C, P[i]) ? i : i + 1
        const e = j + 1 < n ? j + 1 : 0
        const bIdx = onC(C, P[e]) ? e : j
        if (a > i) out.push({ t: 'L', a: P[i], b: P[a] })
        out.push({ t: 'A', c: C.c, a: P[a], b: P[bIdx], ccw: T2[i + 1] > 0 })
        if (bIdx === j) { out.push({ t: 'L', a: P[j], b: P[e] }) }
        i = j + 1
        continue
      }
    }
    out.push({ t: 'L', a: P[i], b: P[(i + 1) % n] })
    i++
  }
  return out
}

/** -> { orderName, scene, items, groups, clashes, lost, ... } — как у импорта SketchUp */
export function parseBdf(u8, opts = {}) {
  if (!isBdf(u8)) throw new Error('это не файл bCAD (.bdf)')
  const R = reader(u8)
  const { dv, kids, str, leb } = R
  const [, q] = leb(12)
  const rootLen = dv.getUint32(q, true)
  const root = kids(q + 4, Math.min(rootLen, u8.length - q - 4))
  if (!root) throw new Error('не удалось прочитать модель bCAD')

  // объект: { type, name, k (подзаписи по тегу), o, l }
  const objOf = (o, l) => {
    const ks = kids(o, l); if (!ks) return null
    const k = new Map()
    for (const [t, a, ln] of ks) { if (!k.has(t)) k.set(t, []); k.get(t).push([a, ln]) }
    const tp = k.get(0x7f)?.[0]; if (!tp) return null
    return { type: str(...tp), name: (k.get(0x77)?.[0] && str(...k.get(0x77)[0])) || '', k, o, l }
  }
  // вложенные объекты: запись 0x10 — либо сам объект (в слое), либо список объектов (в контейнере)
  const childrenOf = ob => {
    const out = []
    for (const [a, ln] of ob.k.get(0x10) || []) {
      const self = objOf(a, ln)
      if (self) { out.push(self); continue }
      for (const [, a2, l2] of kids(a, ln) || []) { const c = objOf(a2, l2); if (c) out.push(c) }
    }
    return out
  }
  // вершины сетки (MESH3, вид 0x33): число вершин (LEB) + по 3 float32
  const meshVerts = ob => {
    const m = ob.k.get(0x6)?.[0]; if (!m) return []
    const mk = kids(...m) || []
    const g = mk.find(x => x[0] === 0x33); if (!g) return []
    const v = (kids(g[1], g[2]) || []).find(x => x[0] === 0); if (!v) return []
    const [n, p] = leb(v[1])
    if (p + 12 * n > v[1] + v[2]) return []
    const out = []
    for (let i = 0; i < n; i++) out.push([dv.getFloat32(p + 12 * i, true), dv.getFloat32(p + 12 * i + 4, true), dv.getFloat32(p + 12 * i + 8, true)])
    return out
  }
  const plinePts = ob => {
    const v = ob.k.get(0)?.[0]; if (!v) return []
    const out = []
    for (let i = 0; i + 12 <= v[1]; i += 12) out.push([dv.getFloat32(v[0] + i, true), dv.getFloat32(v[0] + i + 4, true), dv.getFloat32(v[0] + i + 8, true)])
    return out
  }
  // строки UTF-16 в свойствах (материал, торцы)
  const u16strings = ob => {
    const b = ob.k.get(0x40b)?.[0]; if (!b) return []
    const out = []
    const [o, l] = b
    for (let i = o; i + 4 < o + l; i++) {
      const n = dv.getUint32(i, true)                                   // число символов (4 байта), затем UTF-16
      if (n < 2 || n > 120 || i + 4 + 2 * n > o + l) continue
      let s = '', ok = true
      for (let j = 0; j < n; j++) {
        const c = dv.getUint16(i + 4 + 2 * j, true)
        if (c < 0x20 || (c > 0x7e && c < 0x400) || c > 0x4ff) { ok = false; break }
        s += String.fromCharCode(c)
      }
      if (ok && /[A-Za-zА-Яа-яЁё]{2}/.test(s)) { out.push(s); i += 3 + 2 * n }
    }
    return out
  }

  // свойства панели (запись 0x40b) — поля «ключ (4 байта) · значение»:
  //   материалы: 1000000 — начало, 1000001 — название, 1000004 — вид (0 — плита, 2 — кромка), 1000005 — толщина (double);
  //   торцы (по порядку сторон контура): 3000 — начало, 3001 — название («Гладкий торец»), 3002 — номер материала кромки (−1 — нет);
  //   код детали (позиция) — короткая строка рядом с названием панели
  const panelProps = (ob, title) => {
    const b = ob.k.get(0x40b)?.[0]; if (!b) return { mats: [], edges: [], code: '' }
    const [o, l] = b, end = o + l
    const strAt = i => {
      const n = dv.getUint32(i, true)
      if (n < 1 || n > 200 || i + 4 + 2 * n > end) return null
      let s = ''
      for (let j = 0; j < n; j++) { const c = dv.getUint16(i + 4 + 2 * j, true); if (c < 0x20 || (c > 0x7e && c < 0x400) || c > 0x4ff) return null; s += String.fromCharCode(c) }
      return s
    }
    const mats = [], edges = [], strs = []
    for (let i = o; i + 8 <= end; i++) {
      const key = dv.getUint32(i, true)
      if (key === 1000001) {
        const s = strAt(i + 4); if (s == null) continue
        const m = { name: s.trim(), type: 0, thick: 0 }
        let q = i + 8 + 2 * s.length
        for (let g = 0; g < 80 && q + 8 <= end; g++, q++) {
          const k2 = dv.getUint32(q, true)
          if (k2 === 1000004) m.type = dv.getUint32(q + 4, true)
          else if (k2 === 1000005) { m.thick = dv.getFloat64(q + 4, true); break }
        }
        mats.push(m); i += 7 + 2 * s.length; continue
      }
      if (key === 3001) {
        const s = strAt(i + 4); if (s == null) continue
        const q = i + 8 + 2 * s.length
        const mi = q + 8 <= end && dv.getUint32(q, true) === 3002 ? dv.getInt32(q + 4, true) : -1
        edges.push({ name: s, mat: mi }); i += 7 + 2 * s.length; continue
      }
      if (key >= 0x3e0 && key <= 0x3ff) { const s = strAt(i + 4); if (s != null) { strs.push({ key, s }); i += 7 + 2 * s.length } }
    }
    const ti = strs.findIndex(x => x.s === title)
    const near = ti >= 0 ? [strs[ti - 1], strs[ti + 1]].filter(x => x && Math.abs(x.key - strs[ti].key) === 1) : []
    const code = (near.find(x => x.s.trim().length <= 24) || {}).s?.trim() || ''
    return { mats, edges, code }
  }

  // ── обход: детали и крепёж ──
  const panels = [], fasteners = []
  const walk = (ob, layer, depth) => {
    if (depth > 30) return
    const ch = childrenOf(ob)
    if (ob.type === 'CONTAINER') {
      const names = ch.filter(c => c.type === 'MESH3').map(c => c.name)
      if (names.includes('Лицевая') && names.includes('Тыльная')) { panels.push({ ob, ch, layer }); return }
      const holes = ch.filter(c => c.type === 'MESH3' && /^Отверстие\s*\d/i.test(c.name))
      if (holes.length) fasteners.push({ ob, holes, layer })
    }
    for (const c of ch) walk(c, layer, depth + 1)
  }
  for (const [, a, l] of root) {
    const ob = objOf(a, l)
    if (ob && ob.type === 'LAYER') walk(ob, (ob.k.get(0x400)?.[0] && str(...ob.k.get(0x400)[0])) || '', 0)
  }
  if (!panels.length) throw new Error('в модели bCAD не найдено панелей (контейнеров с гранями «Лицевая» и «Тыльная»)')

  // ── отверстия крепежа: ось — две точки (6 чисел double) в свойствах сетки; диаметр и глубина — из имени ──
  const holes = []
  const lost = []
  const lostAdd = (name, why, n = 1) => { const x = lost.find(l => l.name === name && l.why === why); if (x) x.count += n; else lost.push({ name, why, count: n, parts: [] }) }
  const holeName = (fx, dia) => (/еврик|конфирм/i.test(fx) ? 'Конфирмат' : /эксцентр|минификс/i.test(fx) ? (dia >= 13 ? 'Эксцентрик' : 'Минификс')
    : /петл|чашк/i.test(fx) ? 'Петля' : /шкант/i.test(fx) ? 'Шкант' : /шуруп/i.test(fx) ? 'Шуруп' : /полкодерж/i.test(fx) ? 'Полкодержатель' : `Ø${dia}`)
  const holePairs = []
  for (const f of fasteners) {
    for (const h of f.holes) {
      const m = /(\d+(?:[.,]\d+)?)\s*[xхX×*]\s*(\d+(?:[.,]\d+)?)/.exec(h.name)
      const dia = m ? Number(m[1].replace(',', '.')) : 0, len = m ? Number(m[2].replace(',', '.')) : 0
      const b = h.k.get(0x40b)?.[0]
      let A = null, B = null
      if (b && dia > 0) {
        const [o, l] = b
        for (let i = o; i + 48 <= o + l; i++) {
          const v = []
          for (let j = 0; j < 6; j++) v.push(dv.getFloat64(i + 8 * j, true))
          if (v.some(x => !Number.isFinite(x) || Math.abs(x) > 1e5)) continue
          const L = Math.hypot(v[3] - v[0], v[4] - v[1], v[5] - v[2])
          if (len > 0 ? Math.abs(L - len) < 0.05 : L > 0.5) { A = v.slice(0, 3); B = v.slice(3); break }
        }
      }
      const nm = holeName(f.ob.name + ' ' + h.name, dia)
      if (!A) { lostAdd(`${f.ob.name}: ${h.name}`, 'size'); continue }
      const P = up(A), Q = up(B), D = norm(sub(Q, P)), depth = r1(vlen(sub(Q, P)))
      const h1 = { P, D, r: dia / 2, depth, name: nm }, h2 = { P: Q, D: D.map(x => -x), r: dia / 2, depth, name: nm }
      holes.push(h1, h2); holePairs.push([h1, h2, `${f.ob.name}: ${h.name}`])
    }
  }

  // ── детали ──
  const makers = [], srcs = []
  const keep = src => { srcs.push(src); return src }
  let pid = 0
  for (const pn of panels) {
    const id = pid++
    const face = pn.ch.find(c => c.type === 'MESH3' && c.name === 'Лицевая'), back = pn.ch.find(c => c.type === 'MESH3' && c.name === 'Тыльная')
    const F0 = meshVerts(face).map(up), B0 = meshVerts(back).map(up)
    if (F0.length < 3 || B0.length < 3) { lostAdd(pn.ob.name, 'notPart'); continue }
    // нормаль пласти (Ньюэлл) и толщина
    const newell = P => { const n = [0, 0, 0]; for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; n[0] += (a[1] - b[1]) * (a[2] + b[2]); n[1] += (a[2] - b[2]) * (a[0] + b[0]); n[2] += (a[0] - b[0]) * (a[1] + b[1]) } return n }
    let n = norm(newell(F0))
    if (!vlen(newell(F0))) { lostAdd(pn.ob.name, 'notPart'); continue }
    let T = dot(sub(B0[0], F0[0]), n)
    if (T < 0) { n = n.map(x => -x); T = -T }
    T = r1(T)
    if (!(T > 1 && T < 80)) { lostAdd(pn.ob.name, 'notPart'); continue }
    // контур — по большей из двух пластей (у детали с четвертью одна пласть меньше)
    const area2 = P => { let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]; for (const p of P) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p[k]); mx[k] = Math.max(mx[k], p[k]) } return (mx[0] - mn[0] + 1) * (mx[1] - mn[1] + 1) * (mx[2] - mn[2] + 1) }
    const useBack = area2(B0) > area2(F0) * 1.001
    const base = useBack ? B0 : F0
    const o = useBack ? B0[0] : F0[0]
    if (useBack) n = n.map(x => -x)
    // торцы и стенки вырезов — по ним видно, где кончается петля контура
    const strips = pn.ch.filter(c => c.type === 'MESH3' && c !== face && c !== back).map(c => meshVerts(c).map(up))
    const proj = p => { const d = dot(sub(p, o), n); return [p[0] - n[0] * d, p[1] - n[1] * d, p[2] - n[2] * d] }
    const stripsP = strips.map(S => S.map(proj))
    const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 0.2
    const edgeOK = (a, b) => stripsP.some(S => S.some(p => near(p, a)) && S.some(p => near(p, b)))
    const loopsW = []
    let s0 = 0
    for (let i = 0; i < base.length; i++) {
      const last = i === base.length - 1
      if (last || !edgeOK(base[i], base[i + 1])) { loopsW.push(base.slice(s0, i + 1)); s0 = i + 1 }
    }
    // локальная система: u — вдоль самой длинной стороны наружной петли, v = n × u
    const area = L => { let s = 0; for (let i = 0; i < L.length; i++) { const a = L[i], b = L[(i + 1) % L.length]; s += dot(cross(a, b), n) } return Math.abs(s) / 2 }
    loopsW.sort((a, b) => area(b) - area(a))
    const outerW = loopsW[0]
    let u = null, best = 0
    for (let i = 0; i < outerW.length; i++) { const d = sub(outerW[(i + 1) % outerW.length], outerW[i]), L = vlen(d); if (L > best) { best = L; u = d } }
    u = norm(u.map((c, k) => c - dot(u, n) * n[k]))
    const v = cross(n, u)
    const toL = p => { const d = sub(p, o); return [dot(d, u), dot(d, v), dot(d, n)] }
    const loops = [outerW.map(p => toL(p).slice(0, 2))]
    // вырезы: внутренние петли, стенки которых проходят всю толщину, — сквозь; иначе — выемка с пласти
    const pocketsRaw = []
    for (const lp of loopsW.slice(1)) {
      if (lp.length < 3 || area(lp) < 1) continue
      const walls = strips.filter((S, si) => lp.some(p => stripsP[si].some(q => near(p, q))))
      const zs = walls.flat().map(p => toL(p)[2])
      const L2 = lp.map(p => toL(p).slice(0, 2))
      if (!zs.length) { lostAdd(`${pn.ob.name}: вырез`, 'cut'); continue }
      const z0 = Math.min(...zs), z1 = Math.max(...zs)
      if (z0 < 0.5 && z1 > T - 0.5) loops.push(L2)
      else if (z0 < 0.5) pocketsRaw.push({ elems: arcify(L2), depth: r1(z1), top: false, name: 'Выемка' })
      else lostAdd(`${pn.ob.name}: выемка`, 'cut')
    }
    const elems = loops.flatMap(arcify)
    // четверть: торец ступенькой (пласть отступает от края на ширину четверти) -> выборка вдоль края
    const outerC = loops[0].reduce((s, p) => [s[0] + p[0] / loops[0].length, s[1] + p[1] / loops[0].length], [0, 0])
    const rebates = []
    for (const S of strips) {
      if (S.length < 6 || S.length % 2) continue
      const L = S.map(toL)
      if (!L.some(p => p[2] > 0.3 && p[2] < T - 0.3)) continue
      const ends = [L.slice(0, L.length / 2), L.slice(L.length / 2)].map(h => ({
        b: h.find(p => p[2] < 0.3), t: h.find(p => p[2] > T - 0.3), mid: h.filter(p => p[2] > 0.3 && p[2] < T - 0.3).map(p => p[2]),
      }))
      if (ends.some(e => !e.b || !e.t || !e.mid.length)) continue
      const d = [ends[1].b[0] - ends[0].b[0], ends[1].b[1] - ends[0].b[1]], dl = Math.hypot(d[0], d[1])
      if (dl < 1) continue
      const nn = [-d[1] / dl, d[0] / dl]
      const off = e => (e.t[0] - e.b[0]) * nn[0] + (e.t[1] - e.b[1]) * nn[1]
      const w0 = off(ends[0]), w1 = off(ends[1])
      if (Math.abs(w0) < 0.3 || Math.abs(w0 - w1) > 0.3) continue
      // какая пласть отступила: та, что ближе к середине детали
      const inward = ((outerC[0] - ends[0].b[0]) * nn[0] + (outerC[1] - ends[0].b[1]) * nn[1]) * w0 > 0
      const zs = r1(ends[0].mid[0])
      const top = inward
      const depth = top ? r1(T - zs) : zs
      const pts = ends.flatMap(e => [e.b, e.t])
      const axis = Math.abs(d[0]) < 0.05 || Math.abs(d[1]) < 0.05
      if (!axis) { lostAdd(`${pn.ob.name}: четверть по наклонному краю`, 'cut'); continue }
      const p = [Math.min(...pts.map(x => x[0])), Math.min(...pts.map(x => x[1]))], q = [Math.max(...pts.map(x => x[0])), Math.max(...pts.map(x => x[1]))]
      rebates.push({ p, q, depth, top, name: 'Четверть' })
    }
    const xs = loops[0].map(p => p[0]), ys = loops[0].map(p => p[1])
    const U0 = Math.min(...xs), U1 = Math.max(...xs), W0 = Math.min(...ys), W1 = Math.max(...ys)

    // пазы: сечения — ломаные из 4 точек поперёк паза; одинаковые сечения вдоль одной оси -> паз от первого до последнего
    const secs = []
    for (const c of pn.ch) {
      if (c.type !== 'XPLINE' || c.k.has(0x40b)) continue
      const P = plinePts(c).map(up)
      if (P.length !== 4) continue
      const L = P.map(toL)
      const mn = [0, 1, 2].map(k => Math.min(...L.map(p => p[k]))), mx = [0, 1, 2].map(k => Math.max(...L.map(p => p[k])))
      const ax = mx[0] - mn[0] < 0.5 ? 0 : mx[1] - mn[1] < 0.5 ? 1 : -1
      if (ax < 0) continue
      const cr = 1 - ax
      if (!(mn[2] < 0.3 || mx[2] > T - 0.3)) continue                  // сечение не выходит на пласть — не паз
      secs.push({ ax, at: mn[ax], c0: mn[cr], c1: mx[cr], z0: Math.max(0, mn[2]), z1: Math.min(T, mx[2]) })
    }
    const cutsRaw = [...rebates]
    const used = new Set()
    for (const sc of secs) {
      if (used.has(sc)) continue
      const same = secs.filter(x => !used.has(x) && x.ax === sc.ax && Math.abs(x.c0 - sc.c0) < 0.3 && Math.abs(x.c1 - sc.c1) < 0.3 && Math.abs(x.z0 - sc.z0) < 0.3 && Math.abs(x.z1 - sc.z1) < 0.3)
      same.forEach(x => used.add(x))
      if (same.length < 2) { lostAdd(`${pn.ob.name}: паз`, 'cut'); continue }
      const a0 = Math.min(...same.map(x => x.at)), a1 = Math.max(...same.map(x => x.at))
      const top = sc.z1 >= T - 0.3
      const p = sc.ax === 0 ? [a0, sc.c0] : [sc.c0, a0], qq = sc.ax === 0 ? [a1, sc.c1] : [sc.c1, a1]
      cutsRaw.push({ p: [Math.max(p[0], U0), Math.max(p[1], W0)], q: [Math.min(qq[0], U1), Math.min(qq[1], W1)], depth: r1(sc.z1 - sc.z0), top, name: 'Паз' })
    }

    const strs = u16strings(pn.ob)
    const props = panelProps(pn.ob, pn.ob.name)
    const material = (props.mats.find(m => m.type === 0)?.name || strs.find(x => /\d\s*мм/i.test(x)) || strs[0] || '').trim()
    // кромка: у каждого торца — номер материала из списка материалов панели (−1 — без кромки). Торцы идут по порядку сторон
    // контура, как сетки «Торец» внутри панели: участок контура — проекция своей сетки на пласть
    const butts = []
    const torecs = pn.ch.filter(c => c.type === 'MESH3' && c.name === 'Торец')
    const banded = props.edges.filter(e => e.mat >= 0 && props.mats[e.mat])
    if (banded.length) {
      if (torecs.length !== props.edges.length) lostAdd(`${pn.ob.name}: кромка`, 'edge', banded.length)
      else props.edges.forEach((e, k) => {
        const m = e.mat >= 0 ? props.mats[e.mat] : null
        if (!m) return
        const P = meshVerts(torecs[k]).map(up).map(p => toL(p)).filter(p => p[2] < T / 2).map(p => [p[0], p[1]])
        if (P.length < 2) { lostAdd(`${pn.ob.name}: кромка`, 'edge'); return }
        let a = P[0], b = P[0], best = -1
        for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) { const d = Math.hypot(P[i][0] - P[j][0], P[i][1] - P[j][1]); if (d > best) { best = d; a = P[i]; b = P[j] } }
        // по дуге: участок — та дуга контура, что начинается и кончается в этих точках
        const curved = P.some(p => Math.abs((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) / (best || 1) > 0.5)
        const thick = m.thick > 0 ? r1(m.thick) : null
        const nm = thick && !/мм|mm/i.test(m.name) ? `${m.name} (${thick} мм)` : m.name
        butts.push({ e: { t: curved ? 'A' : 'L', a, b }, name: nm, info: { mat: m.name, thick } })
      })
    }
    const Mp = [u[0], v[0], n[0], u[1], v[1], n[1], u[2], v[2], n[2], o[0], o[1], o[2]]
    // «Шкаф. Прав. ст.» — изделие «Шкаф», деталь «Прав. ст.»; «Стойка лев.» — просто деталь
    const pm = /^([^.]{1,30})\.\s+(\S.{2,})$/.exec(pn.ob.name)
    const name = (pm ? pm[2] : pn.ob.name).trim() || 'Панель'
    const product = pm ? pm[1].trim() : ''
    const texDir = U1 - U0 >= W1 - W0 ? 1 : 2
    makers.push(() => buildItem(keep({
      T, elems, texDir, M: Mp, butts, cutsRaw, decorRaw: [], pocketsRaw, edgeCutsRaw: [], warnCuts: 0, anyEnd: true,
      name, prefix: '', material, rotatable: false, anim: null,
      meta: { src: 'bcad', ids: [id], des: '', pos: props.code, name, product, productDes: '', productPos: '', path: [], material, materialCode: '' },
    }), holes, opts.faceRule))
  }

  const { items, groups, skipped } = groupItems(makers)
  for (const [h, h2, nm] of holePairs) if (!h.hit && !h2.hit) lostAdd(nm, 'place')
  let clashes
  try { clashes = findClashes(srcs) } catch { clashes = [] }
  const byId = new Map()
  for (const it of items) for (const i of (it.contour.meta.ids || [])) byId.set(i, it)
  for (const c of clashes) for (const sd of [c.a, c.b]) { const it = byId.get(sd.id); if (it) { it.warn.clash++; sd.groupKey = it.groupKey } }
  clashes.sort((x, y) => y.depth - x.depth)
  if (!items.length) throw new Error('в модели bCAD не удалось собрать ни одной детали')
  const scene = { v: 1, order: '', parts: items.map(it => ({ name: it.name, w: it.w, h: it.h, edges: it.edges, contour: it.contour })), extras: [], meshes: {}, hardware: [], colors: {} }
  return { orderName: '', scene, skipped, items, groups, clashes, bcad: true, lost, other: 0, hidden: 0,
    holesUsed: holePairs.filter(([h, h2]) => h.hit || h2.hit).length }
}

export async function readBdfFile(file, opts) {
  const res = parseBdf(new Uint8Array(await file.arrayBuffer()), opts)
  const title = file.name.replace(/\.[^.]+$/, '')
  res.orderName = title
  res.scene.order = title
  for (const it of res.items) { it.contour.meta.file = file.name; it.contour.meta.order = title }
  return res
}
