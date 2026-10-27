// Импорт деталей из DXF (2D-чертёж): внешний контур — деталь, всё, что внутри контура, — обработка этой детали.
// Что за обработка — по имени слоя, в том же формате, что наш экспорт DXF (dxfExport.js):
//   detal / контур / part        — контур детали
//   vyrez / вырез / cut          — сквозной вырез
//   D<д>_Z<г>                    — отверстие в пласть: диаметр (по окружности) и глубина Z
//   PAZ_W<ш>_Z<г> / паз          — паз (прямоугольник), глубина Z
//   TOREC_D<д>_Z<г> / торец      — отверстие в торец: прямоугольник «диаметр × глубина» от края детали
//   vyemka / выемка / pocket     — выемка (карман) на глубину Z; и любой слой с «Z<число>» без «D»
//   kromka / кромка              — кромка: линия рядом с участком контура (или прямо на нём)
//   sheet / лист, label          — лист и подписи нашего экспорта — не берутся
//   текст внутри контура         — название детали (размер в конце подписи отбрасывается)
// Слой без таких слов: замкнутый контур внутри детали — вырез, окружность до Ø20 — сквозное отверстие.
// Деталь собирается тем же построителем, что у Базиса (buildItem): контур с дугами, вырезы, присадка, пазы, кромка.
import { buildItem, groupItems } from './basisB3d'

const TOL = 0.05                     // мм — концы элементов считаются одной точкой
const IDENT = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]

// ---------- чтение файла ----------
async function readText(file) {
  const buf = new Uint8Array(await file.arrayBuffer())
  const head = new TextDecoder('latin1').decode(buf.slice(0, 22))
  if (head.startsWith('AutoCAD Binary DXF')) throw new Error('двоичный DXF не поддерживается — сохраните чертёж как DXF в текстовом виде (ASCII)')
  const probe = new TextDecoder('latin1').decode(buf.slice(0, 200000))
  const cp = (probe.match(/\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n\s*(\S+)/) || [])[1] || ''
  let text = new TextDecoder('utf-8').decode(buf)
  if (/1251|ANSI_1251/i.test(cp) || (text.includes('�') && !/utf/i.test(cp))) {
    try { text = new TextDecoder('windows-1251').decode(buf) } catch { /* остаётся utf-8 */ }
  }
  // \U+0410 — так старые DXF пишут не латинские буквы
  return text.replace(/\\U\+([0-9A-Fa-f]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
}

function pairs(text) {
  const lines = text.split(/\r\n|\r|\n/)
  const out = []
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10)
    if (Number.isNaN(code)) { i -= 1; continue }       // сбитая строка — пробуем выровняться
    out.push([code, lines[i + 1].replace(/^\s+|\s+$/g, '')])
  }
  return out
}

// сущности одной секции: [{ type, g: [[code, value]...] }]; у POLYLINE — свои VERTEX внутри
function entitiesOf(list) {
  const ents = []
  let cur = null
  for (const [c, v] of list) {
    if (c === 0) {
      if (v === 'VERTEX' && cur && cur.type === 'POLYLINE') { cur.verts.push([]); continue }
      if (v === 'SEQEND' && cur && cur.type === 'POLYLINE') { cur.closedSeq = true; continue }
      cur = { type: v, g: [], verts: [] }
      ents.push(cur)
      continue
    }
    if (!cur) continue
    if (cur.type === 'POLYLINE' && cur.verts.length && !cur.closedSeq) cur.verts[cur.verts.length - 1].push([c, v])
    else cur.g.push([c, v])
  }
  return ents
}

function parseDxf(text) {
  const P = pairs(text)
  const sections = {}
  for (let i = 0; i < P.length; i++) {
    if (P[i][0] === 0 && P[i][1] === 'SECTION' && P[i + 1]?.[0] === 2) {
      const name = P[i + 1][1], start = i + 2
      let j = start
      while (j < P.length && !(P[j][0] === 0 && P[j][1] === 'ENDSEC')) j++
      sections[name] = P.slice(start, j)
      i = j
    }
  }
  // единицы чертежа
  let unit = 1
  const H = sections.HEADER || []
  for (let i = 0; i < H.length; i++) if (H[i][0] === 9 && H[i][1] === '$INSUNITS') { const u = parseInt(H[i + 1]?.[1], 10); unit = { 1: 25.4, 2: 304.8, 5: 10, 6: 1000 }[u] || 1 }
  // блоки
  const blocks = new Map()
  const B = sections.BLOCKS || []
  let b = null
  for (let i = 0; i < B.length; i++) {
    const [c, v] = B[i]
    if (c === 0 && v === 'BLOCK') {
      b = { name: '', base: [0, 0], list: [] }
      i++
      while (i < B.length && B[i][0] !== 0) {
        if (B[i][0] === 2) b.name = B[i][1]
        if (B[i][0] === 10) b.base[0] = +B[i][1]
        if (B[i][0] === 20) b.base[1] = +B[i][1]
        i++
      }
      i--
      continue
    }
    if (c === 0 && v === 'ENDBLK') { if (b) blocks.set(b.name, { base: b.base, ents: entitiesOf(b.list) }); b = null; continue }
    if (b) b.list.push(B[i])
  }
  return { ents: entitiesOf(sections.ENTITIES || []), blocks, unit }
}

// ---------- геометрия ----------
const gv = (g, code, def = 0) => { const p = g.find(x => x[0] === code); return p ? +p[1] : def }
const gs = (g, code, def = '') => { const p = g.find(x => x[0] === code); return p ? p[1] : def }
const posmod = a => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
const near = (p, q, t = TOL) => Math.abs(p[0] - q[0]) <= t && Math.abs(p[1] - q[1]) <= t

function arcPts(e, n = 24) {
  const r = Math.hypot(e.a[0] - e.c[0], e.a[1] - e.c[1])
  const a0 = Math.atan2(e.a[1] - e.c[1], e.a[0] - e.c[0]), a1 = Math.atan2(e.b[1] - e.c[1], e.b[0] - e.c[0])
  let sw = e.ccw ? posmod(a1 - a0) : -posmod(a0 - a1)
  if (Math.abs(sw) < 1e-9) sw = e.ccw ? 2 * Math.PI : -2 * Math.PI
  return Array.from({ length: n + 1 }, (_, k) => [e.c[0] + r * Math.cos(a0 + sw * k / n), e.c[1] + r * Math.sin(a0 + sw * k / n)])
}
// дуга по выпуклости (bulge) участка полилинии
function bulgeArc(p, q, bulge) {
  const d = (1 / bulge - bulge) / 2
  const c = [(p[0] + q[0]) / 2 - d * (q[1] - p[1]) / 2, (p[1] + q[1]) / 2 + d * (q[0] - p[0]) / 2]
  return { t: 'A', c, a: p, b: q, ccw: bulge > 0 }
}
// B-сплайн (de Boor) -> точки; веса не учитываются
function splinePts(g) {
  const deg = gv(g, 71, 3)
  const knots = g.filter(x => x[0] === 40).map(x => +x[1])
  const cx = g.filter(x => x[0] === 10).map(x => +x[1]), cy = g.filter(x => x[0] === 20).map(x => +x[1])
  const fx = g.filter(x => x[0] === 11).map(x => +x[1]), fy = g.filter(x => x[0] === 21).map(x => +x[1])
  if (cx.length < deg + 1 || knots.length !== cx.length + deg + 1) return fx.map((x, i) => [x, fy[i]])
  const ctrl = cx.map((x, i) => [x, cy[i]])
  const lo = knots[deg], hi = knots[knots.length - deg - 1], N = Math.max(16, ctrl.length * 8)
  const out = []
  for (let s = 0; s <= N; s++) {
    const t = Math.min(hi - 1e-9, lo + (hi - lo) * s / N)
    let k = deg
    while (k < knots.length - deg - 2 && t >= knots[k + 1]) k++
    const d = Array.from({ length: deg + 1 }, (_, j) => [...ctrl[j + k - deg]])
    for (let r = 1; r <= deg; r++) for (let j = deg; j >= r; j--) {
      const i = j + k - deg, den = knots[i + deg - r + 1] - knots[i]
      const al = den ? (t - knots[i]) / den : 0
      d[j] = [(1 - al) * d[j - 1][0] + al * d[j][0], (1 - al) * d[j - 1][1] + al * d[j][1]]
    }
    out.push(d[deg])
  }
  if (gv(g, 70) & 1 && out.length) out.push(out[0])
  return out
}
const polyElems = (pts, closed) => {
  const out = []
  for (let i = 0; i + 1 < pts.length; i++) out.push({ t: 'L', a: pts[i], b: pts[i + 1] })
  if (closed && pts.length > 2 && !near(pts[0], pts[pts.length - 1])) out.push({ t: 'L', a: pts[pts.length - 1], b: pts[0] })
  return out
}

// сущности -> элементы { t: 'L'|'A'|'C', layer } и подписи { text, p, layer }; блоки (INSERT) раскрываются
function flatten(ents, blocks, tf, layerOver, out, depth = 0) {
  for (const e of ents) {
    const g = e.g
    let layer = gs(g, 8, '0')
    if (layerOver && layer === '0') layer = layerOver
    const ex = gv(g, 230, 1) < 0                     // выдавливание −Z: чертёж зеркален по X
    const ocs = p => (ex ? [-p[0], p[1]] : p)
    const put = el => out.elems.push({ ...tf.el(el), layer })
    switch (e.type) {
      case 'LINE': put({ t: 'L', a: [gv(g, 10), gv(g, 20)], b: [gv(g, 11), gv(g, 21)] }); break
      case 'CIRCLE': put({ t: 'C', c: ocs([gv(g, 10), gv(g, 20)]), r: gv(g, 40) }); break
      case 'ARC': {
        const c = [gv(g, 10), gv(g, 20)], r = gv(g, 40), s = gv(g, 50) * Math.PI / 180, en = gv(g, 51) * Math.PI / 180
        let el = { t: 'A', c, a: [c[0] + r * Math.cos(s), c[1] + r * Math.sin(s)], b: [c[0] + r * Math.cos(en), c[1] + r * Math.sin(en)], ccw: true }
        if (ex) el = { t: 'A', c: ocs(el.c), a: ocs(el.a), b: ocs(el.b), ccw: false }
        put(el); break
      }
      case 'LWPOLYLINE': {
        const pts = [], bul = []
        for (const [c, v] of g) {
          if (c === 10) { pts.push([+v, 0]); bul.push(0) } else if (c === 20 && pts.length) pts[pts.length - 1][1] = +v
          else if (c === 42 && pts.length) bul[bul.length - 1] = +v
        }
        const closed = (gv(g, 70) & 1) === 1
        const n = closed ? pts.length : pts.length - 1
        for (let i = 0; i < n; i++) {
          const p = ocs(pts[i]), q = ocs(pts[(i + 1) % pts.length]), bl = ex ? -bul[i] : bul[i]
          if (near(p, q, 1e-6)) continue
          put(Math.abs(bl) > 1e-9 ? bulgeArc(p, q, bl) : { t: 'L', a: p, b: q })
        }
        break
      }
      case 'POLYLINE': {
        if (gv(g, 70) & (16 | 64)) break               // сети и грани — не контур
        const vs = e.verts.map(v => ({ p: ocs([gv(v, 10), gv(v, 20)]), b: (ex ? -1 : 1) * gv(v, 42) }))
        const closed = (gv(g, 70) & 1) === 1, n = closed ? vs.length : vs.length - 1
        for (let i = 0; i < n; i++) {
          const p = vs[i].p, q = vs[(i + 1) % vs.length].p
          if (near(p, q, 1e-6)) continue
          put(Math.abs(vs[i].b) > 1e-9 ? bulgeArc(p, q, vs[i].b) : { t: 'L', a: p, b: q })
        }
        break
      }
      case 'SPLINE': for (const el of polyElems(splinePts(g), false)) put(el); break
      case 'ELLIPSE': {
        const c = [gv(g, 10), gv(g, 20)], m = [gv(g, 11), gv(g, 21)], k = gv(g, 40, 1)
        let t0 = gv(g, 41, 0), t1 = gv(g, 42, 2 * Math.PI)
        if (t1 <= t0) t1 += 2 * Math.PI
        const pts = Array.from({ length: 65 }, (_, i) => { const t = t0 + (t1 - t0) * i / 64; return [c[0] + m[0] * Math.cos(t) - k * m[1] * Math.sin(t), c[1] + m[1] * Math.cos(t) + k * m[0] * Math.sin(t)] })
        for (const el of polyElems(pts, false)) put(el)
        break
      }
      case 'TEXT': case 'MTEXT': {
        let s = g.filter(x => x[0] === 1 || x[0] === 3).map(x => x[1]).join('')
        if (e.type === 'MTEXT') s = s.replace(/\\P/g, ' ').replace(/\\[A-Za-z][^;\\]*;/g, '').replace(/[{}]/g, '').replace(/\\~/g, ' ')
        s = s.replace(/%%[cC]/g, 'Ø').trim()
        if (s) out.texts.push({ text: s, p: tf.p([gv(g, 10), gv(g, 20)]), layer })
        break
      }
      case 'INSERT': {
        const blk = blocks.get(gs(g, 2))
        if (!blk || depth > 8) break
        const ip = [gv(g, 10), gv(g, 20)], sx = gv(g, 41, 1), sy = gv(g, 42, 1), rot = gv(g, 50) * Math.PI / 180
        const cs = Math.cos(rot), sn = Math.sin(rot)
        const local = p => { const x = (p[0] - blk.base[0]) * sx, y = (p[1] - blk.base[1]) * sy; return tf.p([ip[0] + x * cs - y * sn, ip[1] + x * sn + y * cs]) }
        const mirror = sx * sy < 0
        const sub = {
          p: local,
          el: el => (el.t === 'L' ? { t: 'L', a: local(el.a), b: local(el.b) }
            : el.t === 'C' ? { t: 'C', c: local(el.c), r: el.r * Math.abs(sx) * tf.k }
              : { t: 'A', c: local(el.c), a: local(el.a), b: local(el.b), ccw: mirror !== tf.mirror ? !el.ccw : el.ccw }),
          k: tf.k * Math.abs(sx), mirror: mirror !== tf.mirror,
        }
        // элементы блока сначала в его системе — внутри flatten tf.el применит преобразование вставки
        flatten(blk.ents, blocks, { p: sub.p, el: sub.el, k: sub.k, mirror: sub.mirror }, layer, out, depth + 1)
        break
      }
      default: break
    }
  }
}

// ---------- слои ----------
const numAfter = (s, letter) => { const m = s.match(new RegExp(`(?:^|[^A-ZА-Я])${letter}\\s*=?\\s*(\\d+(?:[.,]\\d+)?)`, 'i')); return m ? parseFloat(m[1].replace(',', '.')) : null }
export function layerKind(name) {
  const s = String(name || '')
  const z = numAfter(s, 'Z'), d = numAfter(s, 'D')
  if (/^sheet$|^list$|^лист|^label$/i.test(s)) return { kind: 'skip' }
  if (/NestingPartName|подпис|name/i.test(s)) return { kind: 'text' }
  if (/krom|кром|edge/i.test(s)) return { kind: 'edge' }
  if (/torec|torets|торец|торц/i.test(s)) return { kind: 'endhole', z }
  if (/^paz|паз|groove|slot/i.test(s)) return { kind: 'groove', z }
  if (/vyem|viem|выем|pocket|карман/i.test(s)) return { kind: 'pocket', z }
  if (/vyrez|вырез|cutout|^cut|through|сквозн/i.test(s)) return { kind: 'cutout' }
  if (/^detal|детал|^part|контур|contour|outline|^outer/i.test(s)) return { kind: 'part' }
  if (/^D\s*\d/i.test(s) || (d != null && z != null) || /drill|сверл|отв/i.test(s)) return { kind: 'drill', d, z }
  if (z != null) return { kind: 'pocket', z }
  return { kind: 'other' }
}
const KIND_TITLE = { part: 'контур детали', cutout: 'вырезы', drill: 'отверстия в пласть', groove: 'пазы', pocket: 'выемки', endhole: 'отверстия в торец', edge: 'кромка', text: 'подписи', skip: 'не берётся', other: 'контуры без обработки' }

// ---------- петли ----------
// Сетка для поиска соседей: концы элементов и их габариты
function makeGrid(cell) {
  const m = new Map()
  const k = (i, j) => i * 73856093 ^ j * 19349663
  return {
    add(x0, y0, x1, y1, v) {
      for (let i = Math.floor(x0 / cell); i <= Math.floor(x1 / cell); i++) for (let j = Math.floor(y0 / cell); j <= Math.floor(y1 / cell); j++) {
        const key = k(i, j); if (!m.has(key)) m.set(key, []); m.get(key).push(v)
      }
    },
    near(x0, y0, x1, y1) {
      const out = new Set()
      for (let i = Math.floor(x0 / cell); i <= Math.floor(x1 / cell); i++) for (let j = Math.floor(y0 / cell); j <= Math.floor(y1 / cell); j++) for (const v of m.get(k(i, j)) || []) out.add(v)
      return out
    },
  }
}
const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1])
const segKey = e => e.t + (e.c ? `${e.c[0].toFixed(2)},${e.c[1].toFixed(2)}` : '')
// тот же элемент (дубль): тот же вид, те же концы в любом направлении
const sameSeg = (e, f, tol) => e.t === f.t && segKey(e) === segKey(f) &&
  ((dist(e.a, f.a) <= tol && dist(e.b, f.b) <= tol && (e.t !== 'A' || e.ccw === f.ccw)) || (dist(e.a, f.b) <= tol && dist(e.b, f.a) <= tol && (e.t !== 'A' || e.ccw !== f.ccw)))

// Очистка отрезков одного слоя перед сборкой петель:
//  · отрезок делится в точке, где в него упирается конец другого (Т-стык, наложение «внахлёст»);
//  · пересечение у самого конца («ус» — линия заехала за угол) — тоже делится, а хвост длиной до tail отрезается
function cleanLines(segs, tail, stats) {
  const lines = segs.filter(e => e.t === 'L'), rest = segs.filter(e => e.t !== 'L')
  if (lines.length < 2) return segs
  const g = makeGrid(50)
  lines.forEach((e, i) => g.add(Math.min(e.a[0], e.b[0]) - 1, Math.min(e.a[1], e.b[1]) - 1, Math.max(e.a[0], e.b[0]) + 1, Math.max(e.a[1], e.b[1]) + 1, i))
  const cuts = lines.map(() => [])
  lines.forEach((e, i) => {
    const dx = e.b[0] - e.a[0], dy = e.b[1] - e.a[1], len = Math.hypot(dx, dy)
    if (len < 1e-6) return
    for (const j of g.near(Math.min(e.a[0], e.b[0]) - 1, Math.min(e.a[1], e.b[1]) - 1, Math.max(e.a[0], e.b[0]) + 1, Math.max(e.a[1], e.b[1]) + 1)) {
      if (j === i) continue
      const f = lines[j]
      // конец f лежит внутри e
      for (const q of [f.a, f.b]) {
        const t = ((q[0] - e.a[0]) * dx + (q[1] - e.a[1]) * dy) / (len * len)
        if (t * len > TOL && (1 - t) * len > TOL && segDist(q, e.a, e.b) <= TOL) cuts[i].push(t)
      }
      // пересечение у конца одного из отрезков — «ус»
      const fx = f.b[0] - f.a[0], fy = f.b[1] - f.a[1], den = dx * fy - dy * fx
      if (Math.abs(den) < 1e-9) continue
      const t = ((f.a[0] - e.a[0]) * fy - (f.a[1] - e.a[1]) * fx) / den
      const u = ((f.a[0] - e.a[0]) * dy - (f.a[1] - e.a[1]) * dx) / den
      const fl = Math.hypot(fx, fy)
      if (t * len <= TOL || (1 - t) * len <= TOL || u * fl < -TOL || (1 - u) * fl < -TOL) continue
      const nearEnd = Math.min(t * len, (1 - t) * len) <= tail || Math.min(u * fl, (1 - u) * fl) <= tail
      if (nearEnd) cuts[i].push(t)
    }
  })
  let out = []
  lines.forEach((e, i) => {
    const ts = [...new Set(cuts[i].map(t => Math.round(t * 1e6) / 1e6))].sort((a, b) => a - b)
    if (!ts.length) { out.push(e); return }
    stats.split += ts.length
    let prev = e.a
    for (const t of [...ts, 1]) {
      const q = t === 1 ? e.b : [e.a[0] + (e.b[0] - e.a[0]) * t, e.a[1] + (e.b[1] - e.a[1]) * t]
      if (dist(prev, q) > 1e-6) out.push({ ...e, a: prev, b: q })
      prev = q
    }
  })
  // хвосты: короткий отрезок, у которого один конец свободен, а другой — в узле, где сходятся ещё два и больше
  for (let pass = 0; pass < 3; pass++) {
    const ends = makeGrid(Math.max(tail, 1))
    const all = [...out, ...rest]
    all.forEach((e, i) => { for (const q of [e.a, e.b]) ends.add(q[0] - TOL, q[1] - TOL, q[0] + TOL, q[1] + TOL, i) })
    const deg = q => [...ends.near(q[0] - TOL, q[1] - TOL, q[0] + TOL, q[1] + TOL)].filter(i => dist(all[i].a, q) <= TOL || dist(all[i].b, q) <= TOL).length
    const keep = out.filter(e => {
      if (dist(e.a, e.b) > tail) return true
      const da = deg(e.a), db = deg(e.b)
      if ((da === 1 && db >= 3) || (db === 1 && da >= 3)) { stats.tails++; return false }
      return true
    })
    if (keep.length === out.length) break
    out = keep
  }
  return [...out, ...rest]
}

// элементы одного слоя -> замкнутые петли { elems, poly, area, box }; незамкнутые цепочки — openChains.
// snap — до какого разрыва концы сшиваются; close — ключи цепочек, которые пользователь велел замкнуть прямой
function loopsOf(elems, { snap = 0.5, tail = 2, close = null, stats = { gaps: 0, maxGap: 0, dups: 0, split: 0, tails: 0 } } = {}) {
  const loops = [], circles = []
  let segs = []
  for (const e of elems) {
    if (e.t === 'C') {
      if (circles.some(c => dist(c.c, e.c) <= TOL && Math.abs(c.r - e.r) <= TOL)) { stats.dups++; continue }
      circles.push(e)
      const poly = Array.from({ length: 32 }, (_, k) => [e.c[0] + e.r * Math.cos(k * Math.PI / 16), e.c[1] + e.r * Math.sin(k * Math.PI / 16)])
      loops.push({ elems: [e], circle: e, poly })
      continue
    }
    if (e.t === 'L' && dist(e.a, e.b) < 1e-6) continue
    segs.push(e)
  }
  segs = cleanLines(segs, tail, stats)
  const sn = Math.max(TOL, snap)
  const grid = makeGrid(Math.max(sn, 1))
  segs.forEach((e, i) => { for (const q of [e.a, e.b]) grid.add(q[0] - sn, q[1] - sn, q[0] + sn, q[1] + sn, i) })
  const used = new Array(segs.length).fill(false)
  const usedList = []
  const rev = e => (e.t === 'L' ? { ...e, a: e.b, b: e.a } : { ...e, a: e.b, b: e.a, ccw: !e.ccw })
  const openChains = []
  const isDup = e => [...grid.near(e.a[0] - sn, e.a[1] - sn, e.a[0] + sn, e.a[1] + sn)].some(j => used[j] && sameSeg(segs[j], e, Math.max(TOL, Math.min(sn, 0.5))))
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue
    if (isDup(segs[i])) { used[i] = true; stats.dups++; continue }
    used[i] = true; usedList.push(i)
    const chain = [segs[i]]
    let closed = segs[i].t === 'A' && dist(segs[i].a, segs[i].b) <= TOL
    for (let guard = 0; guard < segs.length && !closed; guard++) {
      const last = chain[chain.length - 1], cur = last.b
      let j = -1, flip = false, bd = Infinity
      for (const k of grid.near(cur[0] - sn, cur[1] - sn, cur[0] + sn, cur[1] + sn)) {
        if (used[k]) continue
        const s2 = segs[k]
        if (sameSeg(s2, last, TOL)) continue            // дубль только что пройденного — не разворачиваемся назад
        const da = dist(s2.a, cur), db = dist(s2.b, cur)
        if (da <= sn && da < bd) { bd = da; j = k; flip = false }
        if (db <= sn && db < bd) { bd = db; j = k; flip = true }
      }
      const ds = dist(cur, chain[0].a)
      if (ds <= sn && (chain.length > 1 || chain[0].t === 'A') && ds <= bd + 1e-9) {
        closed = true
        if (ds > TOL) { stats.gaps++; stats.maxGap = Math.max(stats.maxGap, ds) }
        break
      }
      if (j < 0) break
      if (bd > TOL) { stats.gaps++; stats.maxGap = Math.max(stats.maxGap, bd) }
      used[j] = true; usedList.push(j)
      chain.push(flip ? rev(segs[j]) : segs[j])
    }
    if (!closed) {
      // цепочка могла начаться с середины: достраиваем назад от начала
      for (let guard = 0; guard < segs.length; guard++) {
        const cur = chain[0].a
        let j = -1, flip = false, bd = Infinity
        for (const k of grid.near(cur[0] - sn, cur[1] - sn, cur[0] + sn, cur[1] + sn)) {
          if (used[k]) continue
          const s2 = segs[k]
          if (sameSeg(s2, chain[0], TOL)) continue
          const da = dist(s2.b, cur), db = dist(s2.a, cur)
          if (da <= sn && da < bd) { bd = da; j = k; flip = false }
          if (db <= sn && db < bd) { bd = db; j = k; flip = true }
        }
        if (j < 0) break
        if (bd > TOL) { stats.gaps++; stats.maxGap = Math.max(stats.maxGap, bd) }
        used[j] = true; usedList.push(j)
        chain.unshift(flip ? rev(segs[j]) : segs[j])
      }
      const key = chainKey(chain)
      if (close && close.has(key) && (chain.length > 1 || chain[0].t === 'A')) {
        chain.push({ t: 'L', a: chain[chain.length - 1].b, b: chain[0].a })   // замкнуть прямой — по решению пользователя
      } else { openChains.push({ chain, key }); continue }
    }
    // концы — ровно в одной точке (построитель контура требует точного совпадения)
    for (let k = 0; k < chain.length; k++) chain[(k + 1) % chain.length] = { ...chain[(k + 1) % chain.length], a: chain[k].b }
    const poly = []
    for (const e of chain) { if (e.t === 'L') poly.push(e.a); else poly.push(...arcPts(e, 16).slice(0, -1)) }
    // петля нулевой площади (линия туда и обратно) — это не контур
    let sa = 0
    for (let q = 0; q < poly.length; q++) { const a = poly[q], b = poly[(q + 1) % poly.length]; sa += a[0] * b[1] - b[0] * a[1] }
    if (Math.abs(sa) < 0.01) { stats.dups += chain.length; continue }
    loops.push({ elems: chain, poly })
  }
  for (const lp of loops) {
    let s = 0
    for (let i = 0; i < lp.poly.length; i++) { const a = lp.poly[i], b = lp.poly[(i + 1) % lp.poly.length]; s += a[0] * b[1] - b[0] * a[1] }
    lp.area = Math.abs(s / 2)
    lp.box = boxOf(lp.poly)
  }
  return { loops, open: openChains.length, openChains, stats }
}
const boxOf = pts => { const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]); return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) } }
const chainPts = chain => { const pts = []; for (const e of chain) { if (e.t === 'L') pts.push(e.a); else pts.push(...arcPts(e, 8).slice(0, -1)) } pts.push(chain[chain.length - 1].b); return pts }
const rk = p => `${Math.round(p[0] * 10)},${Math.round(p[1] * 10)}`
// ключ незамкнутой цепочки — по её концам (в любом порядке), чтобы решение пользователя пережило пересчёт
function chainKey(chain) { const a = rk(chain[0].a), b = rk(chain[chain.length - 1].b); return 'o|' + (a < b ? a + '|' + b : b + '|' + a) }
// паз, нарисованный одной линией (траекторией): полоса шириной w вокруг неё -> замкнутый контур из отрезков
function pathBand(pts, w) {
  const h = w / 2, L = [], R = []
  const nrm = (a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [-dy / l, dx / l] }
  for (let i = 0; i < pts.length; i++) {
    let n
    if (i === 0) n = nrm(pts[0], pts[1])
    else if (i === pts.length - 1) n = nrm(pts[i - 1], pts[i])
    else {
      const n1 = nrm(pts[i - 1], pts[i]), n2 = nrm(pts[i], pts[i + 1])
      const m = [n1[0] + n2[0], n1[1] + n2[1]], ml = Math.hypot(m[0], m[1]) || 1, cos = Math.max(0.3, (m[0] * n1[0] + m[1] * n1[1]) / ml)
      n = [m[0] / ml / cos, m[1] / ml / cos]
    }
    L.push([pts[i][0] + n[0] * h, pts[i][1] + n[1] * h]); R.push([pts[i][0] - n[0] * h, pts[i][1] - n[1] * h])
  }
  const ring = [...L, ...R.reverse()]
  const elems = ring.map((p, i) => ({ t: 'L', a: p, b: ring[(i + 1) % ring.length] }))
  return { elems, poly: ring, box: boxOf(ring), area: Math.abs(ring.reduce((s, a, i) => { const b = ring[(i + 1) % ring.length]; return s + a[0] * b[1] - b[0] * a[1] }, 0) / 2) }
}
function inPoly(pt, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j]
    if ((a[1] > pt[1]) !== (b[1] > pt[1]) && pt[0] < (b[0] - a[0]) * (pt[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside
  }
  return inside
}
const segDist = (p, a, b) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
}
const polyDist = (p, poly) => { let m = Infinity; for (let i = 0; i < poly.length; i++) m = Math.min(m, segDist(p, poly[i], poly[(i + 1) % poly.length])); return m }
const boxIn = (a, b, t = 0.5) => a.x0 >= b.x0 - t && a.y0 >= b.y0 - t && a.x1 <= b.x1 + t && a.y1 <= b.y1 + t
const centerOf = lp => [(lp.box.x0 + lp.box.x1) / 2, (lp.box.y0 + lp.box.y1) / 2]
// петля a внутри петли b: габарит внутри и точки a (кроме лежащих на контуре b) — внутри b
function loopInside(a, b) {
  if (a === b || !(b.area > a.area) || !boxIn(a.box, b.box)) return false
  const probe = [...a.poly.filter((_, i) => i % Math.max(1, Math.floor(a.poly.length / 8)) === 0), centerOf(a)]
  let inside = 0, out = 0
  for (const p of probe) { if (polyDist(p, b.poly) < 0.3) continue; if (inPoly(p, b.poly)) inside++; else out++ }
  return inside > 0 && out === 0
}

// ---------- сборка ----------
const stripSize = s => String(s || '').replace(/\s+\d+(?:[.,]\d+)?\s*[xх×*]\s*\d+(?:[.,]\d+)?\s*$/i, '').trim()

// разобранный файл — один раз: при смене допуска или решений пользователя пересчитывается только сборка
const parsedCache = new WeakMap()
async function parsedOf(file) {
  if (!parsedCache.has(file)) parsedCache.set(file, parseDxf(await readText(file)))
  return parsedCache.get(file)
}
const partKey = lp => `p|${Math.round(lp.box.x0)}|${Math.round(lp.box.y0)}|${Math.round(lp.box.x1 - lp.box.x0)}|${Math.round(lp.box.y1 - lp.box.y0)}`
// пересекаются ли контуры двух деталей (рёбра режут друг друга)
function polysCross(a, b) {
  for (let i = 0; i < a.length; i++) {
    const p1 = a[i], p2 = a[(i + 1) % a.length]
    for (let j = 0; j < b.length; j++) {
      const q1 = b[j], q2 = b[(j + 1) % b.length]
      const d = (p2[0] - p1[0]) * (q2[1] - q1[1]) - (p2[1] - p1[1]) * (q2[0] - q1[0])
      if (Math.abs(d) < 1e-9) continue
      const t = ((q1[0] - p1[0]) * (q2[1] - q1[1]) - (q1[1] - p1[1]) * (q2[0] - q1[0])) / d
      const u = ((q1[0] - p1[0]) * (p2[1] - p1[1]) - (q1[1] - p1[1]) * (p2[0] - p1[0])) / d
      if (t > 1e-3 && t < 1 - 1e-3 && u > 1e-3 && u < 1 - 1e-3) return true
    }
  }
  return false
}
const r1v = v => Math.round(v * 10) / 10
const thin = pts => pts.map(q => [r1v(q[0]), r1v(q[1])])

/**
 * opts: thickness — толщина из заказа; snap — до какого разрыва (мм) концы сшиваются сами; close — ключи незамкнутых
 * контуров, которые замкнуть прямой; skip — ключи деталей, которые не брать; scale — множитель единиц (×25,4 — дюймы)
 */
export async function readDxfFile(file, { thickness = 16, snap = 0.5, close = [], skip = [], scale = 1 } = {}) {
  const T = Number(thickness) > 0 ? Number(thickness) : 16
  const { ents, blocks, unit } = await parsedOf(file)
  const out = { elems: [], texts: [] }
  const k = unit * (Number(scale) > 0 ? Number(scale) : 1)
  const closeSet = new Set(close), skipSet = new Set(skip)
  const stats = { gaps: 0, maxGap: 0, dups: 0, split: 0, tails: 0 }
  const problems = []
  const ghosts = []                                // что на чертеже есть, но в детали не попало (лист, незамкнутое) — для картинки
  const sc = p => [p[0] * k, p[1] * k]
  flatten(ents, blocks, {
    p: sc,
    el: el => (el.t === 'L' ? { t: 'L', a: sc(el.a), b: sc(el.b) } : el.t === 'C' ? { t: 'C', c: sc(el.c), r: el.r * k } : { t: 'A', c: sc(el.c), a: sc(el.a), b: sc(el.b), ccw: el.ccw }),
    k, mirror: false,
  }, null, out)
  if (!out.elems.length) throw new Error('в чертеже нет линий, дуг и окружностей')

  // слои: что в каждом
  const byLayer = new Map()
  for (const e of out.elems) { if (!byLayer.has(e.layer)) byLayer.set(e.layer, []); byLayer.get(e.layer).push(e) }
  const layers = []
  const all = []                                   // все петли: { ...loop, layer, info }
  const edgeEls = []                               // элементы кромки
  let openTotal = 0
  for (const [name, els] of byLayer) {
    const info = layerKind(name)
    const L = { name, kind: info.kind, title: KIND_TITLE[info.kind], count: 0, used: 0 }
    layers.push(L)
    if (info.kind === 'skip' || info.kind === 'text') continue
    if (info.kind === 'edge') { edgeEls.push(...els.map(e => ({ ...e, L }))); L.count = els.length; continue }
    const { loops, openChains } = loopsOf(els, { snap, close: closeSet, stats })
    for (const lp of loops) all.push({ ...lp, layer: name, info, L })
    // паз или выемка одной линией: полоса шириной W из имени слоя
    const w = numAfter(name, 'W')
    for (const oc of openChains) {
      const pts = chainPts(oc.chain)
      if ((info.kind === 'groove' || info.kind === 'pocket') && w > 0) {
        const band = pathBand(pts, w)
        all.push({ ...band, layer: name, info, L, path: true }); stats.paths = (stats.paths || 0) + 1
        continue
      }
      openTotal++
      const a = oc.chain[0].a, b = oc.chain[oc.chain.length - 1].b
      const box = boxOf(pts)
      ghosts.push({ k: 'open', pts: thin(pts) })
      problems.push({
        id: oc.key, kind: 'open', layer: name, box, at: [r1v(b[0]), r1v(b[1])], at2: [r1v(a[0]), r1v(a[1])], gap: r1v(dist(a, b)),
        part: info.kind === 'part' || info.kind === 'other' || info.kind === 'cutout',
        text: (info.kind === 'groove' || info.kind === 'pocket') && !(w > 0)
          ? `${KIND_TITLE[info.kind]} одной линией, но в имени слоя «${name}» нет ширины W — назовите слой, например, PAZ_W4_Z8`
          : `Контур не замкнут (слой «${name}»): разрыв ${String(r1v(dist(a, b))).replace('.', ',')} мм`,
        canClose: oc.chain.length > 1 || oc.chain[0].t === 'A',
      })
    }
    L.count = loops.length
  }
  const fixed = { ...stats, maxGap: r1v(stats.maxGap) }

  // детали: петли слоя контура; если такого слоя нет — внешние петли (чёт-нечет: деталь, вырез, деталь в вырезе…)
  const hasPartLayer = all.some(l => l.info.kind === 'part')
  const cand = all.filter(l => (hasPartLayer ? l.info.kind === 'part' : l.info.kind === 'other' || l.info.kind === 'cutout'))
  // родитель — наименьшая объемлющая петля
  for (const l of cand) {
    l.parent = null
    for (const m of cand) if (loopInside(l, m) && (!l.parent || m.area < l.parent.area)) l.parent = m
    l.kids = []
  }
  for (const l of cand) if (l.parent) l.parent.kids.push(l)
  const parts = []
  const cutsOf = new Map()
  // контейнер (лист раскроя с деталями): внутри него хотя бы две петли, и в них самих есть содержимое или они занимают большую часть
  const isContainer = l => {
    if (l.kids.length < 2) return false
    const kidArea = l.kids.reduce((a, c) => a + c.area, 0)
    const busy = l.kids.some(c => c.kids.length || all.some(o => o !== c && o.info.kind !== 'other' && o.info.kind !== 'part' && loopInside(o, c)))
    return busy || kidArea / l.area > 0.4
  }
  const walk = (l, asPart) => {
    if (hasPartLayer) { parts.push(l); return }
    if (asPart && l.info.kind === 'cutout') asPart = false
    if (asPart && !l.parent && isContainer(l)) { l.kids.forEach(c => walk(c, true)); return }
    if (asPart) { parts.push(l); cutsOf.set(l, []) } else if (l.parent && cutsOf.has(l.parent)) cutsOf.get(l.parent).push(l)
    l.kids.forEach(c => walk(c, !asPart))
  }
  for (const l of cand) if (!l.parent || hasPartLayer) walk(l, true)
  for (const p of parts) if (!cutsOf.has(p)) cutsOf.set(p, [])
  for (const p of parts) p.key = partKey(p)
  // детали, наложенные друг на друга (контуры пересекаются)
  for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
    const a = parts[i], b = parts[j]
    if (a.box.x1 < b.box.x0 || b.box.x1 < a.box.x0 || a.box.y1 < b.box.y0 || b.box.y1 < a.box.y0) continue
    if (skipSet.has(a.key) || skipSet.has(b.key) || !polysCross(a.poly, b.poly)) continue
    problems.push({ id: `x|${a.key}|${b.key}`, kind: 'overlap', box: { x0: Math.min(a.box.x0, b.box.x0), y0: Math.min(a.box.y0, b.box.y0), x1: Math.max(a.box.x1, b.box.x1), y1: Math.max(a.box.y1, b.box.y1) },
      text: 'Две детали наложены друг на друга — контуры пересекаются', keys: [a.key, b.key], sizes: [a, b].map(q => `${Math.round(q.box.y1 - q.box.y0)}×${Math.round(q.box.x1 - q.box.x0)}`) })
  }
  // единицы: все детали подозрительно мелкие — чертёж, похоже, в дюймах или сантиметрах
  if (parts.length && scale === 1) {
    const big = Math.max(...parts.map(q => Math.max(q.box.x1 - q.box.x0, q.box.y1 - q.box.y0)))
    if (big < 120) problems.push({ id: 'units', kind: 'units', box: null, text: `Самая большая деталь — ${String(r1v(big)).replace('.', ',')} мм. Похоже, чертёж не в миллиметрах`, big })
  }

  // обработка -> наименьшая деталь, внутри которой она лежит
  const owner = lp => {
    let best = null
    for (const p of parts) if (p !== lp && (loopInside(lp, p) || (boxIn(lp.box, p.box, 0.5) && inPoly(centerOf(lp), p.poly))) && (!best || p.area < best.area)) best = p
    return best
  }
  const work = new Map(parts.map(p => [p, { drills: [], grooves: [], pockets: [], ends: [], cuts: [...(cutsOf.get(p) || [])], edges: [], names: [] }]))
  let lost = 0
  const inPart = new Set([...parts, ...[...cutsOf.values()].flat()])
  for (const lp of all) {
    const kd = lp.info.kind
    if (kd === 'part' || (kd === 'other' && !hasPartLayer) || (kd === 'cutout' && !hasPartLayer)) { if (!inPart.has(lp)) ghosts.push({ k: 'ghost', pts: thin(lp.poly), closed: true }); continue }
    const p = owner(lp)
    if (!p) {
      lost++
      ghosts.push({ k: 'lost', pts: thin(lp.poly), closed: true })
      if (lost <= 30) problems.push({ id: `l|${partKey(lp)}|${lp.layer}`, kind: 'lost', box: lp.box, text: `${(t => t.charAt(0).toUpperCase() + t.slice(1))(KIND_TITLE[kd] || 'обработка')} (слой «${lp.layer}») — вне деталей, не взята` })
      continue
    }
    lp.owner = p
    const w = work.get(p)
    lp.L.used++
    if (kd === 'drill') w.drills.push(lp)
    else if (kd === 'groove') w.grooves.push(lp)
    else if (kd === 'pocket') w.pockets.push(lp)
    else if (kd === 'endhole') w.ends.push(lp)
    else w.cuts.push(lp)                          // вырез (и «прочие» контуры внутри детали, когда есть слой контура)
  }
  for (const p of parts) { p.L.used++; for (const c of cutsOf.get(p) || []) c.L.used++ }
  for (const e of edgeEls) {
    const mid = e.t === 'L' ? [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2] : e.t === 'A' ? arcPts(e, 2)[1] : e.c
    let best = null, bd = Infinity
    for (const p of parts) {
      const d = polyDist(mid, p.poly)
      if ((inPoly(mid, p.poly) || d < 1) && d < 8 && (d < bd - 1e-6 || (Math.abs(d - bd) < 1e-6 && p.area < best.area))) { best = p; bd = d }
    }
    if (best) { work.get(best).edges.push(e); e.L.used++ }
  }
  for (const t of out.texts) {
    if (layerKind(t.layer).kind === 'skip') continue
    let best = null
    for (const p of parts) if (inPoly(t.p, p.poly) && (!best || p.area < best.area)) best = p
    if (best) work.get(best).names.push(t.text)
  }

  // ---------- деталь -> построитель (как у Базиса) ----------
  let seq = 0
  const makers = parts.filter(p => !skipSet.has(p.key)).map(p => () => {
    const w = work.get(p)
    const outerEls = p.elems.map(e => ({ ...e }))
    const elems = [...outerEls, ...w.cuts.flatMap(c => c.elems)]
    const holes = []
    const pocketsRaw = [], cutsRaw = []
    for (const d of w.drills) {
      const dep = d.info.z != null ? Math.min(d.info.z, T) : T
      if (d.circle) holes.push({ P: [d.circle.c[0], d.circle.c[1], T], D: [0, 0, -1], r: d.circle.r, depth: dep, name: d.layer })
      else pocketsRaw.push({ elems: d.elems, depth: dep, top: true, through: dep >= T - 0.05, name: d.layer })
    }
    // прочие окружности внутри детали без обработки в имени слоя: мелкие — сквозное отверстие, крупные — вырез
    for (let i = elems.length - 1; i >= outerEls.length; i--) {
      const e = elems[i]
      if (e.t === 'C' && e.r * 2 <= 20 + 1e-6) { holes.push({ P: [e.c[0], e.c[1], T], D: [0, 0, -1], r: e.r, depth: T, name: '' }); elems.splice(i, 1) }
    }
    const rectOf = lp => {
      if (lp.circle || lp.elems.length !== 4 || lp.elems.some(e => e.t !== 'L')) return null
      const axis = lp.elems.every(e => Math.abs(e.a[0] - e.b[0]) < 0.01 || Math.abs(e.a[1] - e.b[1]) < 0.01)
      return axis ? lp.box : null
    }
    for (const g of w.grooves) {
      const dep = g.info.z != null ? Math.min(g.info.z, T) : Math.min(8, T / 2)
      const r = rectOf(g)
      if (r) cutsRaw.push({ p: [r.x0, r.y0], q: [r.x1, r.y1], depth: dep, top: true, name: g.layer })
      else pocketsRaw.push({ elems: g.elems, depth: dep, top: true, through: dep >= T - 0.05, name: g.layer })
    }
    for (const pk of w.pockets) {
      const dep = pk.info.z != null ? Math.min(pk.info.z, T) : Math.min(5, T / 2)
      pocketsRaw.push({ elems: pk.elems, depth: dep, top: true, through: dep >= T - 0.05, name: pk.layer })
    }
    // отверстие в торец: прямоугольник от края детали вглубь — ширина по краю = диаметр, длина = глубина
    for (const eh of w.ends) {
      const r = rectOf(eh)
      if (!r) continue
      const sides = [
        { m: [r.x0, (r.y0 + r.y1) / 2], d: [1, 0], dia: r.y1 - r.y0, dep: r.x1 - r.x0 },
        { m: [r.x1, (r.y0 + r.y1) / 2], d: [-1, 0], dia: r.y1 - r.y0, dep: r.x1 - r.x0 },
        { m: [(r.x0 + r.x1) / 2, r.y0], d: [0, 1], dia: r.x1 - r.x0, dep: r.y1 - r.y0 },
        { m: [(r.x0 + r.x1) / 2, r.y1], d: [0, -1], dia: r.x1 - r.x0, dep: r.y1 - r.y0 },
      ]
      const s = sides.map(x => ({ ...x, dist: polyDist(x.m, p.poly) })).sort((a, b) => a.dist - b.dist)[0]
      if (!s || s.dist > 1) continue
      holes.push({ P: [s.m[0], s.m[1], T / 2], D: [s.d[0], s.d[1], 0], r: s.dia / 2, depth: s.dep, name: eh.layer })
    }
    // кромка: элемент контура детали, вдоль которого идёт линия кромки (с отступом внутрь или прямо по нему)
    const butts = [], seen = new Set()
    const contourEls = [...outerEls, ...w.cuts.flatMap(c => c.elems)]
    for (const e of w.edges) {
      const pts = e.t === 'L' ? [e.a, e.b, [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2]] : e.t === 'A' ? arcPts(e, 4) : null
      if (!pts) continue
      let best = -1, bd = Infinity
      contourEls.forEach((c, i) => {
        let d
        if (c.t === 'L') {
          const dx = c.b[0] - c.a[0], dy = c.b[1] - c.a[1], len = Math.hypot(dx, dy)
          if (e.t === 'L') { const ex = e.b[0] - e.a[0], ey = e.b[1] - e.a[1]; if (Math.abs(dx * ey - dy * ex) > 0.02 * len * Math.hypot(ex, ey)) return }
          d = Math.max(...pts.map(q => segDist(q, c.a, c.b)))
          // проекция линии кромки должна ложиться на этот участок
          const t = q => ((q[0] - c.a[0]) * dx + (q[1] - c.a[1]) * dy) / (len * len)
          const mid = pts[pts.length - 1]
          if (t(mid) < -0.01 || t(mid) > 1.01) return
        } else if (c.t === 'A') {
          const r = Math.hypot(c.a[0] - c.c[0], c.a[1] - c.c[1])
          d = Math.max(...pts.map(q => Math.abs(Math.hypot(q[0] - c.c[0], q[1] - c.c[1]) - r)))
          const ap = arcPts(c, 24)
          if (Math.min(...ap.map(q => Math.hypot(q[0] - pts[pts.length - 1][0], q[1] - pts[pts.length - 1][1]))) > Math.max(6, r * 0.3)) return
        } else return
        if (d < bd) { bd = d; best = i }
      })
      if (best < 0 || bd > 6 || seen.has(best)) continue
      seen.add(best)
      const c = contourEls[best]
      butts.push({ e: c.t === 'L' ? { t: 'L', a: c.a, b: c.b } : { t: 'A', a: c.a, b: c.b, c: c.c }, name: 'default', info: {} })
    }
    const name = stripSize(w.names.sort((a, b) => b.length - a.length)[0] || '') || 'Деталь'
    const dx = p.box.x1 - p.box.x0, dy = p.box.y1 - p.box.y0
    const it = buildItem({
      T, elems, texDir: dx > dy + 0.5 ? 1 : 0, M: IDENT, butts, cutsRaw, decorRaw: [], pocketsRaw, edgeCutsRaw: [], warnCuts: 0,
      frontFace: 0, name, prefix: '', material: '', rotatable: true, meta: { src: 'dxf', ids: [`dxf${++seq}`] },
    }, holes, ['model'])
    if (!it) return null
    // положение на чертеже и 3D не нужны (и мешали бы сложить одинаковые детали в одну строку)
    delete it.contour.meta.local; delete it.contour.meta.inst; delete it.contour.meta.anims
    it.material = ''; it.thickness = null; it.groupKey = '|'
    return it
  })
  const { items, groups, skipped } = groupItems(makers)
  for (const it of items) delete it.contour.meta.ids        // повторный импорт другого DXF не должен считаться «тем же файлом»
  // картинка чертежа для окна проверки: детали (взятые и отложенные), их обработка, прочее
  const draw = []
  for (const p of parts) {
    draw.push({ k: skipSet.has(p.key) ? 'skipped' : 'part', pts: thin(p.poly), closed: true, key: p.key })
    const w = work.get(p)
    for (const lp of [...w.cuts, ...w.drills, ...w.grooves, ...w.pockets, ...w.ends]) draw.push({ k: 'work', pts: thin(lp.poly), closed: true })
    for (const e of w.edges) draw.push({ k: 'edge', pts: thin(e.t === 'L' ? [e.a, e.b] : e.t === 'A' ? arcPts(e, 8) : []) })
  }
  draw.push(...ghosts)
  const allPts = draw.flatMap(d => d.pts)
  const view = allPts.length ? boxOf(allPts) : { x0: 0, y0: 0, x1: 1, y1: 1 }
  if (!parts.length && !problems.length) throw new Error('не нашлось замкнутых контуров деталей — проверьте, что контуры замкнуты')
  return {
    orderName: String(file.name || '').replace(/\.dxf$/i, ''), scene: null, skipped, items, groups,
    dxf: {
      pieces: items.reduce((a, it) => a + it.qty, 0), T, open: openTotal, lost, fixed, problems, draw, view, snap,
      parts: parts.length, skippedParts: parts.filter(p => skipSet.has(p.key)).length,
      layers: layers.sort((a, b) => a.name.localeCompare(b.name)).map(l => ({ name: l.name, title: l.title, kind: l.kind, count: l.count })),
    },
  }
}

export const isDxfText = head => /^\s*0\s*\r?\n\s*SECTION/.test(head) || head.startsWith('AutoCAD Binary DXF')
