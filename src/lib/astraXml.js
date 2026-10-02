// Импорт из XML-экспорта «Астра Конструктор Мебели» (Файл → Экспорт XML).
// Запасной путь к файлу проекта .add: в XML есть детали, кромка, контур, вырезы,
// пазы и присадка, но нет положения деталей в изделии — 3D-модели не будет.
//
// Формат (описан в exim.pdf Астры, присадка и контуры — по самим файлам):
//   data / data_order | data_assembly / list_materials / material[name] / list_parts / part
//   part: name «Название-Изделие-Номер», number, length, width, thick, quantity, rotate, assembly
//     edge ×4 — кромка: верх (y = width), низ (y = 0), лево (x = 0), право (x = length);
//       внутри — bore: отверстия в этом торце: diam, depth, t (от пласти), x — от «базы»:
//       base 1 — у верха и низа от x = length, у левой стороны от y = 0, у правой от y = width
//     bores/bore — отверстия в пласть: x, y, diam, depth (0 — сквозное), side (2 — та пласть, с которой смотрим)
//     contour — фигурный контур: line / arc из двух point; у arc h — стрелка, знак — сторона выпуклости
//     holeinner — вырез: x, y — начало его контура; type 1 — прямоугольник со скруглением, 2 — круг
//     mortise — паз: face, depth, width, distance (от кромки), bind (от какой), bylength (на всю длину)
//   Система детали: x — по длине, y — по ширине, смотрим со стороны side 2.
import { buildItem, groupItems } from './basisB3d.js'

// ---------- Мини-разбор XML (без DOM — чтобы работало и в тестах) ----------

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const unesc = s => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => (e[0] === '#'
  ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
  : ENT[e] ?? m))

export function parseXml(text) {
  const root = { tag: '', attr: {}, kids: [], text: '' }
  const stack = [root]
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g
  let m
  while ((m = re.exec(text))) {
    const top = stack[stack.length - 1]
    if (m[1] != null) top.text += m[1]
    else if (m[2]) { if (stack.length > 1) stack.pop() }
    else if (m[3]) {
      const node = { tag: m[3], attr: {}, kids: [], text: '' }
      const ar = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
      let a
      while ((a = ar.exec(m[4] || ''))) node.attr[a[1]] = unesc(a[2] ?? a[3] ?? '')
      top.kids.push(node)
      if (!m[5]) stack.push(node)
    } else if (m[6] && m[6].trim()) top.text += unesc(m[6])
  }
  return root
}
const kids = (n, tag) => (n ? n.kids.filter(k => k.tag === tag) : [])
const kid = (n, tag) => (n ? n.kids.find(k => k.tag === tag) || null : null)
const walk = (n, tag, out = []) => { for (const k of n.kids) { if (k.tag === tag) out.push(k); else walk(k, tag, out) } return out }
const num = (v, d = 0) => { const x = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(x) ? x : d }

// ---------- Контур ----------

const pt = p => [num(p.attr.x), num(p.attr.y)]
// Дуга по хорде и стрелке: h > 0 — против часовой
function arcOf(a, b, h) {
  const cx = b[0] - a[0], cy = b[1] - a[1], c = Math.hypot(cx, cy), ah = Math.abs(h)
  if (c < 1e-6 || ah < 1e-6) return { t: 'L', a, b }
  const r = (c * c / 4 + ah * ah) / (2 * ah)
  const left = [-cy / c, cx / c], mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
  const k = (r - ah) * (h > 0 ? 1 : -1)
  return { t: 'A', c: [mid[0] + left[0] * k, mid[1] + left[1] * k], a, b, ccw: h > 0 }
}
function contourElems(node, ox = 0, oy = 0) {
  const out = []
  for (const e of node?.kids || []) {
    const ps = kids(e, 'point').map(pt).map(p => [p[0] + ox, p[1] + oy])
    if (ps.length < 2) continue
    if (e.tag === 'line') out.push({ t: 'L', a: ps[0], b: ps[1] })
    else if (e.tag === 'arc') out.push(arcOf(ps[0], ps[1], num(e.attr.h)))
  }
  return out
}

// ---------- Деталь ----------

function partSrc(part, material) {
  const L = num(part.attr.length), W = num(part.attr.width), T = num(part.attr.thick, 16)
  if (!(L > 0) || !(W > 0)) return null
  const EPS = 0.05
  const cn = kid(part, 'contour')
  let elems = cn ? contourElems(cn) : []
  if (elems.length < 3) elems = [
    { t: 'L', a: [0, 0], b: [L, 0] }, { t: 'L', a: [L, 0], b: [L, W] },
    { t: 'L', a: [L, W], b: [0, W] }, { t: 'L', a: [0, W], b: [0, 0] },
  ]
  const outerCount = elems.length

  // кромка по четырём сторонам габарита: [верх, низ, лево, право]
  const edges = kids(part, 'edge')
  const onSide = [
    e => Math.abs(e.a[1] - W) < EPS && Math.abs(e.b[1] - W) < EPS,
    e => Math.abs(e.a[1]) < EPS && Math.abs(e.b[1]) < EPS,
    e => Math.abs(e.a[0]) < EPS && Math.abs(e.b[0]) < EPS,
    e => Math.abs(e.a[0] - L) < EPS && Math.abs(e.b[0] - L) < EPS,
  ]
  const butts = []
  edges.slice(0, 4).forEach((ed, i) => {
    const name = (ed.attr.name || '').trim()
    if (!name) return
    for (let k = 0; k < outerCount; k++) if (elems[k].t === 'L' && onSide[i](elems[k])) butts.push({ e: elems[k], name, info: { mat: name, sign: ed.attr.code || '', thick: num(ed.attr.thick) || null, width: null } })
  })

  // вырезы
  for (const h of kids(part, 'holeinner')) {
    const x = num(h.attr.x), y = num(h.attr.y)
    if (h.attr.type === '2' && num(h.attr.value1) > 0) { const r = num(h.attr.value1); elems.push({ t: 'C', c: [x + r, y + r], r }) }
    else elems.push(...contourElems(kid(h, 'contour'), x, y))
  }

  // присадка — как отверстия «в модели»: деталь лежит в своей системе, пласть side 2 — сверху (z = T)
  const holes = []
  for (const b of walk(kid(part, 'bores') || { kids: [] }, 'bore')) {
    const d = num(b.attr.diam), depth = num(b.attr.depth)
    if (!(d > 0)) continue
    const top = b.attr.side !== '1'
    holes.push({ P: [num(b.attr.x), num(b.attr.y), top ? T : 0], D: [0, 0, top ? -1 : 1], r: d / 2, depth: depth > 0 ? depth : T, name: '', only: 'face' })
  }
  // Торцы. У левой и правой стороны «база» однозначна. У верха и низа она зависит от того, с какой
  // пласти Астра показывает деталь, а этого в файле нет: выбираем вариант, при котором торцевые
  // отверстия встают напротив своих отверстий в пласти (эксцентрик минификса, полкодержатель).
  const faceX = edgeY => holes.filter(h => Math.abs(h.P[1] - edgeY) <= 40).map(h => h.P[0])
  const tb = [0, 1].map(i => kids(edges[i], 'bore').map(b => ({ x: num(b.attr.x), b1: b.attr.base !== '2', d: num(b.attr.diam), depth: num(b.attr.depth), t: num(b.attr.t, T / 2) })).filter(b => b.d > 0 && b.depth > 0))
  // вариант A: верх — база 1 от x = 0, низ — от x = length; вариант B — наоборот
  const posOf = (b, i, A) => ((i === 0) === A ? (b.b1 ? b.x : L - b.x) : (b.b1 ? L - b.x : b.x))
  let ambiguousEnds = 0, useA = true
  if (tb[0].length || tb[1].length) {
    const key = A => [0, 1].map(i => tb[i].map(b => `${Math.round(posOf(b, i, A) * 5)}|${b.d}|${b.depth}`).sort().join(',')).join('/')
    if (key(true) !== key(false)) {
      const score = A => [0, 1].reduce((n, i) => { const xs = faceX(i === 0 ? W : 0); return n + tb[i].filter(b => xs.some(x => Math.abs(x - posOf(b, i, A)) < 0.2)).length }, 0)
      const sa = score(true), sb = score(false)
      if (sa === sb) ambiguousEnds = tb[0].length + tb[1].length
      else useA = sa > sb
    }
  }
  tb.forEach((list, i) => list.forEach(b => holes.push({ P: [posOf(b, i, useA), i === 0 ? W : 0, T - b.t], D: [0, i === 0 ? -1 : 1, 0], r: b.d / 2, depth: b.depth, name: '', only: 'edge' })))
  edges.slice(2, 4).forEach((ed, k) => {
    for (const b of kids(ed, 'bore')) {
      const d = num(b.attr.diam), depth = num(b.attr.depth), x = num(b.attr.x), b1 = b.attr.base !== '2'
      if (!(d > 0) || !(depth > 0)) continue
      const z = T - num(b.attr.t, T / 2)
      // лево — база 1 от y = 0, право — от y = width
      if (k === 0) holes.push({ P: [0, b1 ? x : W - x, z], D: [1, 0, 0], r: d / 2, depth, name: '', only: 'edge' })
      else holes.push({ P: [L, b1 ? W - x : x, z], D: [-1, 0, 0], r: d / 2, depth, name: '', only: 'edge' })
    }
  })

  // пазы
  const cutsRaw = []
  let warnCuts = 0
  for (const m of kids(part, 'mortise')) {
    const depth = num(m.attr.depth), wd = num(m.attr.width), dist = num(m.attr.distance)
    if (!(depth > 0) || !(wd > 0)) { warnCuts++; continue }
    const alongX = m.attr.direct !== '1'                 // 0 — вдоль длины
    const span = alongX ? L : W, across = alongX ? W : L
    const full = m.attr.bylength === '1' || !(num(m.attr.length) > 0)
    let a0 = 0, a1 = span
    if (!full) {
      const len = num(m.attr.length), db = num(m.attr.distancebegin)
      a0 = m.attr.bindbegin === '1' ? span - db - len : db
      a1 = a0 + len
    }
    const c0 = m.attr.bind === '1' ? across - dist - wd : dist     // bind 0 — от нижней (левой) кромки, 1 — от противоположной
    const p = alongX ? [a0, c0] : [c0, a0], q = alongX ? [a1, c0 + wd] : [c0 + wd, a1]
    cutsRaw.push({ p, q, depth: Math.min(depth, T), top: m.attr.face !== '1', name: 'Паз' })
  }

  const number = (part.attr.number || '').trim(), assembly = (part.attr.assembly || '').trim()
  let name = (part.attr.name || '').trim()
  if (number && name.endsWith('-' + number)) name = name.slice(0, -number.length - 1)
  if (assembly) { const i = name.lastIndexOf('-' + assembly); if (i > 0) name = name.slice(0, i) }
  return {
    src: {
      T, elems, texDir: 1, M: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], butts, cutsRaw, decorRaw: [], warnCuts,
      tol: 0.05, strict: true,
      name, prefix: assembly, material, rotatable: part.attr.rotate === '1', anim: null,
      meta: {
        src: 'astra-xml', ids: [],
        des: number && assembly ? `${number}(${assembly})` : number,
        pos: number, name, product: assembly, productDes: '', productPos: '', path: [],
        material, materialCode: '',
      },
    },
    holes, ambiguousEnds, qty: Math.max(1, Math.round(num(part.attr.quantity, 1))),
  }
}

export const looksLikeAstraXml = text => /<data[\s>]/.test(text) && /<list_parts[\s>]/.test(text)

export function parseAstraXml(text, opts = {}) {
  const doc = parseXml(text)
  const data = kid(doc, 'data')
  if (!data) throw new Error('Это не XML-экспорт Астры')
  const faceRule = opts.faceRule || 'holes'
  const makers = []
  let orderName = ''
  for (const ord of data.kids.filter(k => k.tag === 'data_order' || k.tag === 'data_assembly')) {
    if (!orderName) orderName = (ord.attr.name || '').trim()
    for (const mat of walk(ord, 'material')) {
      const material = (mat.attr.name || '').trim()
      for (const part of kids(kid(mat, 'list_parts'), 'part')) {
        makers.push(() => {
          const ps = partSrc(part, material)
          if (!ps) return null
          const it = buildItem(ps.src, ps.holes, faceRule)
          if (!it) return null
          it.qty = ps.qty
          it.warn.ends = ps.ambiguousEnds        // торцевые отверстия, сторону отсчёта которых не удалось определить
          // положения в изделии в XML нет — 3D по этим деталям не строится
          delete it.contour.meta.inst; delete it.contour.meta.anims; delete it.contour.meta.local
          return it
        })
      }
    }
  }
  if (!makers.length) throw new Error('В файле нет деталей')
  const { items, groups, skipped } = groupItems(makers)
  for (const it of items) { it.contour.meta.order = orderName; it.contour.meta.model = '' }
  return { orderName, scene: null, skipped, items, groups }
}

export async function readAstraXmlFile(file, opts) {
  const u8 = new Uint8Array(await file.arrayBuffer())
  const head = new TextDecoder('latin1').decode(u8.subarray(0, 200))
  const enc = /encoding\s*=\s*["']([^"']+)["']/i.exec(head)?.[1] || 'utf-8'
  let text
  try { text = new TextDecoder(enc).decode(u8) } catch { text = new TextDecoder().decode(u8) }
  const res = parseAstraXml(text, opts)
  if (!res.orderName) res.orderName = file.name.replace(/\.[^.]+$/, '')
  for (const it of res.items) { it.contour.meta.file = file.name; it.contour.meta.order = res.orderName }
  return res
}
