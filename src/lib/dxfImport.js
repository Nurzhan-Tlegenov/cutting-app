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
// элементы одного слоя -> замкнутые петли { elems, poly, area, box }, незамкнутые цепочки — open
function loopsOf(elems) {
  const loops = [], segs = []
  for (const e of elems) {
    if (e.t === 'C') { const poly = Array.from({ length: 32 }, (_, k) => [e.c[0] + e.r * Math.cos(k * Math.PI / 16), e.c[1] + e.r * Math.sin(k * Math.PI / 16)]); loops.push({ elems: [e], circle: e, poly }); continue }
    if (near(e.a, e.b, 1e-6) && e.t === 'L') continue
    segs.push(e)
  }
  const used = new Array(segs.length).fill(false)
  const rev = e => (e.t === 'L' ? { ...e, a: e.b, b: e.a } : { ...e, a: e.b, b: e.a, ccw: !e.ccw })
  let open = 0
  const openChains = []
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue
    used[i] = true
    const chain = [segs[i]]
    let closed = near(segs[i].a, segs[i].b) && segs[i].t === 'A'
    for (let guard = 0; guard < segs.length && !closed; guard++) {
      const cur = chain[chain.length - 1].b
      if (near(cur, chain[0].a)) { closed = true; break }
      let j = -1, flip = false
      for (let k = 0; k < segs.length; k++) {
        if (used[k]) continue
        if (near(segs[k].a, cur)) { j = k; break }
        if (near(segs[k].b, cur)) { j = k; flip = true; break }
      }
      if (j < 0) break
      used[j] = true
      chain.push(flip ? rev(segs[j]) : segs[j])
    }
    if (!closed) { open++; openChains.push(chain); continue }
    // концы — ровно в одной точке (построитель контура требует точного совпадения)
    for (let k = 0; k < chain.length; k++) chain[(k + 1) % chain.length] = { ...chain[(k + 1) % chain.length], a: chain[k].b }
    const poly = []
    for (const e of chain) { if (e.t === 'L') poly.push(e.a); else poly.push(...arcPts(e, 16).slice(0, -1)) }
    loops.push({ elems: chain, poly })
  }
  for (const lp of loops) {
    let s = 0
    for (let i = 0; i < lp.poly.length; i++) { const a = lp.poly[i], b = lp.poly[(i + 1) % lp.poly.length]; s += a[0] * b[1] - b[0] * a[1] }
    lp.area = Math.abs(s / 2)
    const xs = lp.poly.map(p => p[0]), ys = lp.poly.map(p => p[1])
    lp.box = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
  }
  return { loops, open, openChains }
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

export async function readDxfFile(file, { thickness = 16 } = {}) {
  const T = Number(thickness) > 0 ? Number(thickness) : 16
  const { ents, blocks, unit } = parseDxf(await readText(file))
  const out = { elems: [], texts: [] }
  const k = unit
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
    const { loops, open } = loopsOf(els)
    if (info.kind !== 'other') openTotal += open
    for (const lp of loops) all.push({ ...lp, layer: name, info, L })
    L.count = loops.length
  }

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
  if (!parts.length) throw new Error('не нашлось замкнутых контуров деталей — проверьте, что контуры замкнуты')
  for (const p of parts) if (!cutsOf.has(p)) cutsOf.set(p, [])

  // обработка -> наименьшая деталь, внутри которой она лежит
  const owner = lp => {
    let best = null
    for (const p of parts) if (p !== lp && (loopInside(lp, p) || (boxIn(lp.box, p.box, 0.5) && inPoly(centerOf(lp), p.poly))) && (!best || p.area < best.area)) best = p
    return best
  }
  const work = new Map(parts.map(p => [p, { drills: [], grooves: [], pockets: [], ends: [], cuts: [...(cutsOf.get(p) || [])], edges: [], names: [] }]))
  let lost = 0
  for (const lp of all) {
    const kd = lp.info.kind
    if (kd === 'part' || (kd === 'other' && !hasPartLayer) || (kd === 'cutout' && !hasPartLayer)) continue
    const p = owner(lp)
    if (!p) { lost++; continue }
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
  const makers = parts.map(p => () => {
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
  return {
    orderName: String(file.name || '').replace(/\.dxf$/i, ''), scene: null, skipped, items, groups,
    dxf: {
      pieces: items.reduce((a, it) => a + it.qty, 0), T, open: openTotal, lost,
      layers: layers.sort((a, b) => a.name.localeCompare(b.name)).map(l => ({ name: l.name, title: l.title, kind: l.kind, count: l.count })),
    },
  }
}

export const isDxfText = head => /^\s*0\s*\r?\n\s*SECTION/.test(head) || head.startsWith('AutoCAD Binary DXF')
