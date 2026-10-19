// Вложение деталей в сквозные вырезы других деталей (фрезер).
//
// Кольцо борта 1088×2388 с вырезом 936×2236 — внутрь входит основание 920×2220; кольцо поменьше — в кольцо побольше.
// Раскрой сам такого не видит: деталь для него — её наружный контур, вырез — не свободное место. Здесь это делается
// закономерно, до поиска: для каждого выреза (от большого к малому) подбирается самая крупная деталь заказа, которая
// входит в него с зазором не меньше реза (поворот 0°, а если деталь можно вращать — и 90°), и так по кругу, пока
// в вырез что-то входит: каждая деталь — как можно ближе к нулю выреза (ниже, затем левее), с зазором ≥ реза до
// выреза и до соседей. Вложенная деталь выбывает из раскроя, а к детали-хозяину «пристёгивается» и после укладки встаёт
// внутрь её выреза (с тем же поворотом). Цепочки — тоже: кольцо → полоса → панель.
//
// Проверка и ручные правки (validateNesting, карта): деталь внутри выреза другой — не пересечение, если контур целиком в
// вырезе с зазором ≥ реза (nestedInHole). G-код: сначала контур вложенной детали, потом вырез хозяина, потом его контур.
//
// Координаты: мм, Y вверх, как у p.polygon и detailHoles. Все отступы — по настоящим контурам (дуги — ломаной).
import { detailHoles, placedTurns, edgeHole } from './partHoles'
import { roughShapePolygons } from './trueShapeNesting'
import { rotatePointTimes } from './drillGeometry'

const TOL = 0.05

function segDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy
  let t = l ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l : 0
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy)
}
function inPoly(pt, P) {
  let c = false
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    if (((P[i].y > pt.y) !== (P[j].y > pt.y)) && pt.x < (P[j].x - P[i].x) * (pt.y - P[i].y) / (P[j].y - P[i].y) + P[i].x) c = !c
  }
  return c
}
function segsCross(a1, a2, b1, b2) {
  const d = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
  const d1 = d(b1, b2, a1), d2 = d(b1, b2, a2), d3 = d(a1, a2, b1), d4 = d(a1, a2, b2)
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}
const bboxOf = P => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const q of P) { if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y }
  return { x0, y0, x1, y1 }
}

/** Контур inner целиком внутри контура outer, и между ними зазор не меньше gap */
export function polyInsideWithGap(inner, outer, gap) {
  if (!inner?.length || !outer?.length) return false
  const bi = bboxOf(inner), bo = bboxOf(outer)
  if (bi.x0 < bo.x0 + gap - TOL || bi.y0 < bo.y0 + gap - TOL || bi.x1 > bo.x1 - gap + TOL || bi.y1 > bo.y1 - gap + TOL) return false
  for (const q of inner) if (!inPoly(q, outer)) return false
  for (let i = 0; i < inner.length; i++) for (let j = 0; j < outer.length; j++) {
    if (segsCross(inner[i], inner[(i + 1) % inner.length], outer[j], outer[(j + 1) % outer.length])) return false
  }
  const need = gap - TOL
  for (const q of inner) for (let j = 0; j < outer.length; j++) if (segDist(q, outer[j], outer[(j + 1) % outer.length]) < need) return false
  for (const q of outer) for (let i = 0; i < inner.length; i++) if (segDist(q, inner[i], inner[(i + 1) % inner.length]) < need) return false
  return true
}

/** Сквозные вырезы детали, в которые можно вложить другую деталь: не выемки (pocket), не выходящие на край */
export function throughHoles(detail) {
  if (!detail?.contour) return []
  let c
  try { c = typeof detail.contour === 'string' ? JSON.parse(detail.contour) : detail.contour } catch { return [] }
  const holes = Array.isArray(c?.holes) ? c.holes : []
  if (!holes.length) return []
  const W = Number(detail.width) || 0, H = Number(detail.length) || 0
  const out = []
  holes.forEach((hole, idx) => {
    if (hole.type === 'pocket') return
    const poly = detailHoles({ width: W, length: H, contour: JSON.stringify({ holes: [hole] }) })[0]
    if (!poly || poly.length < 3) return
    if (edgeHole(poly, { origX: W, origY: H })) return
    out.push({ idx, poly })
  })
  return out
}

/** Абсолютный контур уложенной детали (мм, Y вверх, как в данных раскроя) */
export function absOutline(p, kerf = 0) {
  if (Array.isArray(p.polygon) && p.polygon.length > 2) return p.polygon.map(q => ({ x: p.x + q.x, y: p.y + q.y }))
  const w = Number(p.origX) > 0 ? Number(p.origX) : p.w - kerf, h = Number(p.origY) > 0 ? Number(p.origY) : p.h - kerf
  return [{ x: p.x, y: p.y }, { x: p.x + w, y: p.y }, { x: p.x + w, y: p.y + h }, { x: p.x, y: p.y + h }]
}

/** Абсолютные контуры сквозных вырезов уложенной детали (с поворотом на листе, как placedHoles) */
export function absHoles(p, detail) {
  return placedThroughHoles(p, detail).map(hp => hp.map(q => ({ x: p.x + q.x, y: p.y + q.y })))
}
/** Сквозные вырезы уложенной детали в её локальных координатах (как p.polygon), с поворотом на листе */
export function placedThroughHoles(p, detail) {
  if (!detail) return []
  const W = Number(detail.width) || 0, H = Number(detail.length) || 0
  const t = placedTurns(p, detail)
  return throughHoles(detail).map(h => h.poly.map(q => rotatePointTimes(q.x, q.y, W, H, t)))
}

/** Деталь inner лежит внутри сквозного выреза детали host с зазором ≥ реза (обе — уложенные, абсолютные координаты) */
export function nestedInHole(inner, host, details, kerf) {
  if (!host || !inner || host === inner) return false
  const hd = details?.[host.detailIndex]
  if (!hd?.contour) return false
  const bi = bboxOf(absOutline(inner, kerf)), bh = bboxOf(absOutline(host, kerf))
  if (bi.x0 < bh.x0 - TOL || bi.y0 < bh.y0 - TOL || bi.x1 > bh.x1 + TOL || bi.y1 > bh.y1 + TOL) return false
  const ip = absOutline(inner, kerf)
  return absHoles(host, hd).some(hp => polyInsideWithGap(ip, hp, kerf))
}

// ─── План вложения до раскроя ───────────────────────────────────────────────
// Возвращает null, если вкладывать нечего, иначе { details: детали для раскроя (qty вложенных уменьшено),
// plan: Map<detailIndex, [{ hole, slots: [{ child, rot, ox, oy, count }] }]> } — для каждой детали-хозяина и каждого её
// выреза: раскладка вложений (деталь, поворот 0/90 относительно хозяина, левый нижний угол габарита в «родных»
// координатах хозяина) и сколько экземпляров хозяина получают это место (остальные — пустые).
// В один вырез кладётся несколько деталей: от крупной к мелкой, каждая — как можно ближе к нулю выреза (ниже, затем
// левее), внутри контура выреза и с зазором ≥ реза до выреза и до соседей по вырезу.
const polyAreaXY = P => { let a = 0; for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; a += p.x * q.y - q.x * p.y } return Math.abs(a) / 2 }
// минимальный зазор между двумя контурами (0 — пересекаются / один в другом)
function polyGap(A, B) {
  for (let i = 0; i < A.length; i++) for (let j = 0; j < B.length; j++) if (segsCross(A[i], A[(i + 1) % A.length], B[j], B[(j + 1) % B.length])) return 0
  if (inPoly(A[0], B) || inPoly(B[0], A)) return 0
  let m = Infinity
  for (const p of A) for (let j = 0; j < B.length; j++) m = Math.min(m, segDist(p, B[j], B[(j + 1) % B.length]))
  for (const p of B) for (let j = 0; j < A.length; j++) m = Math.min(m, segDist(p, A[j], A[(j + 1) % A.length]))
  return m
}
// Место для контура poly (локальные [x,y], габарит cw×ch) в вырезе hole рядом с уже положенными taken (абсолютные контуры
// в координатах хозяина): кандидаты — угол выреза, у правых/верхних сторон соседей, центр, сетка; берётся самый нижний,
// потом самый левый
function spotInHole(poly, pb, cw, ch, hole, taken, k) {
  const { bb } = hole
  const xs = new Set([bb.x0 + k, (bb.x0 + bb.x1) / 2 - cw / 2]), ys = new Set([bb.y0 + k, (bb.y0 + bb.y1) / 2 - ch / 2])
  for (const t of taken) { const tb = bboxOf(t); xs.add(tb.x1 + k); ys.add(tb.y1 + k); xs.add(tb.x0); ys.add(tb.y0) }
  const stepX = Math.max(8, (bb.x1 - bb.x0 - cw) / 24), stepY = Math.max(8, (bb.y1 - bb.y0 - ch) / 24)
  for (let x = bb.x0 + k; x + cw <= bb.x1 - k + TOL; x += stepX) xs.add(x)
  for (let y = bb.y0 + k; y + ch <= bb.y1 - k + TOL; y += stepY) ys.add(y)
  const X = [...xs].filter(x => x >= bb.x0 + k - TOL && x + cw <= bb.x1 - k + TOL).sort((a, b) => a - b)
  const Y = [...ys].filter(y => y >= bb.y0 + k - TOL && y + ch <= bb.y1 - k + TOL).sort((a, b) => a - b)
  for (const y of Y) for (const x of X) {
    // быстрый отсев по габаритам соседей
    let clash = false
    for (const t of taken) { const tb = t._bb; if (x < tb.x1 + k - TOL && tb.x0 < x + cw + k - TOL && y < tb.y1 + k - TOL && tb.y0 < y + ch + k - TOL) { clash = true; break } }
    const abs = poly.map(([px, py]) => ({ x: x + (px - pb.x0), y: y + (py - pb.y0) }))
    if (!polyInsideWithGap(abs, hole.poly, k)) continue
    if (clash && taken.some(t => polyGap(abs, t) < k - TOL)) continue
    return { ox: x, oy: y, abs }
  }
  return null
}
export function planNestInHoles(details, kerf) {
  const k = Number(kerf) || 0
  const qty = details.map(d => Math.max(0, Math.floor(Number(d.qty) || 0)))
  const inst = details.map(d => Math.max(0, Math.floor(Number(d.qty) || 0)))   // экземпляров — по заказу (хозяин сам мог быть вложен)
  const polys = details.map(d => { try { return roughShapePolygons(d) } catch { return null } })
  const areaOf = P => polyAreaXY(P.map(([x, y]) => ({ x, y })))
  // все вырезы всех деталей — от большого к малому
  const holes = []
  details.forEach((d, di) => { if (qty[di] > 0) throughHoles(d).forEach(h => holes.push({ di, idx: h.idx, poly: h.poly, area: polyAreaXY(h.poly), bb: bboxOf(h.poly) })) })
  if (!holes.length) return null
  holes.sort((a, b) => b.area - a.area)
  // кандидаты — от крупной к мелкой (по площади контура)
  const cands = details.map((d, di) => ({ di, area: polys[di] ? areaOf(polys[di][0]) : 0 })).filter(c => c.area > 0).sort((a, b) => b.area - a.area)
  const plan = new Map()
  // кто в кого вложен — чтобы не получить кольцо (A в B, B в A); цепочки разрешены
  const parentOf = new Map()
  const ancestorIs = (di, anc) => { let x = di; for (let g = 0; g < 50 && x != null; g++) { x = parentOf.get(x); if (x === anc) return true } return false }
  for (const h of holes) {
    if (inst[h.di] <= 0) continue
    const slots = [], taken = []
    // по кругу: каждый раз — самая крупная деталь, которая ещё входит (одна и та же деталь — сколько влезет)
    for (let guard = 0; guard < 200; guard++) {
      let put = false
      for (const c of cands) {
        if (c.di === h.di || qty[c.di] <= 0 || c.area >= h.area) continue
        if (ancestorIs(h.di, c.di)) continue   // хозяин уже лежит внутри кандидата (или его потомка)
        const P = polys[c.di]
        if (!P) continue
        const rots = details[c.di].rotatable ? [0, 90] : [0]
        let fit = null
        for (const rot of rots) {
          const poly = P[rot]
          if (!poly) continue
          const pb = bboxOf(poly.map(([x, y]) => ({ x, y })))
          const cw = pb.x1 - pb.x0, ch = pb.y1 - pb.y0
          if (cw + 2 * k > h.bb.x1 - h.bb.x0 + TOL || ch + 2 * k > h.bb.y1 - h.bb.y0 + TOL) continue
          const sp = spotInHole(poly, pb, cw, ch, h, taken, k)
          if (sp) { fit = { rot, ...sp }; break }
        }
        if (!fit) continue
        const count = Math.min(inst[h.di], qty[c.di])
        slots.push({ child: c.di, rot: fit.rot, ox: fit.ox, oy: fit.oy, count })
        const abs = fit.abs; abs._bb = bboxOf(abs); taken.push(abs)
        qty[c.di] -= count
        parentOf.set(c.di, h.di)
        put = true
        break
      }
      if (!put) break
    }
    if (!slots.length) continue
    if (!plan.has(h.di)) plan.set(h.di, [])
    plan.get(h.di).push({ hole: h.idx, slots })
  }
  if (!plan.size) return null
  // Вложенная деталь поворачивается вместе с хозяином. Если её вращать нельзя (текстура), хозяин в раскрое тоже
  // не вращается — иначе вложение встанет против текстуры. По цепочке — вверх до самого внешнего хозяина
  const locked = new Set()
  for (let pass = 0; pass < 50; pass++) {
    let changed = false
    for (const [di, list] of plan) {
      if (locked.has(di)) continue
      if (list.some(e => e.slots.some(sl => !details[sl.child].rotatable || locked.has(sl.child)))) { locked.add(di); changed = true }
    }
    if (!changed) break
  }
  return {
    details: details.map((d, di) => {
      const q = qty[di] !== (Number(d.qty) || 0)
      const lock = locked.has(di) && d.rotatable
      return q || lock ? { ...d, ...(q ? { qty: qty[di] } : {}), ...(lock ? { rotatable: false } : {}) } : d
    }),
    plan,
  }
}

const turnEdges = (p, times) => {
  let top = p.edgeTop, right = p.edgeRight, bottom = p.edgeBottom, left = p.edgeLeft
  for (let i = 0; i < times; i++) { const nTop = left, nRight = top, nBottom = right, nLeft = bottom; top = nTop; right = nRight; bottom = nBottom; left = nLeft }
  return { edgeTop: top, edgeRight: right, edgeBottom: bottom, edgeLeft: left }
}

/** Раскладка с вложенными деталями: к каждому уложенному хозяину добавляются его вложения (по плану, рекурсивно).
 *  Хозяева получают вложения в порядке листов; когда экземпляров хозяина больше, чем вложений, — остальные пустые. */
export function expandNested(sheets, details, plan, kerf) {
  if (!plan?.size || !sheets?.length) return sheets
  const k = Number(kerf) || 0
  const left = new Map()   // `${di}|${hole}|${slot}` → сколько ещё вложить
  for (const [di, list] of plan) list.forEach(e => e.slots.forEach((sl, si) => left.set(`${di}|${e.hole}|${si}`, sl.count)))
  let seq = 0
  const polyCache = new Map()
  const polysOf = di => { if (!polyCache.has(di)) { try { polyCache.set(di, roughShapePolygons(details[di])) } catch { polyCache.set(di, null) } } return polyCache.get(di) }
  const place = (host, out) => {
    const list = plan.get(host.detailIndex)
    if (!list) return
    const hd = details[host.detailIndex]
    const W = Number(hd.width) || 0, H = Number(hd.length) || 0
    const t = host.rotation != null ? ((Math.round(Number(host.rotation) / 90) % 4) + 4) % 4 : (host.rotated ? 1 : 0)
    for (const e of list) for (const [si, sl] of e.slots.entries()) {
      const key = `${host.detailIndex}|${e.hole}|${si}`
      if (!(left.get(key) > 0)) continue
      const cd = details[sl.child], P = polysOf(sl.child)
      if (!P) continue
      const rot = (sl.rot + 90 * t) % 360
      const poly = P[rot]
      if (!poly) continue
      const cw0 = sl.rot % 180 ? Number(cd.length) : Number(cd.width), ch0 = sl.rot % 180 ? Number(cd.width) : Number(cd.length)
      // габарит вложения в «родных» координатах хозяина → поворот вместе с хозяином
      const corners = [[sl.ox, sl.oy], [sl.ox + cw0, sl.oy], [sl.ox + cw0, sl.oy + ch0], [sl.ox, sl.oy + ch0]].map(([x, y]) => rotatePointTimes(x, y, W, H, t))
      const nx = Math.min(...corners.map(q => q.x)), ny = Math.min(...corners.map(q => q.y))
      const origX = rot % 180 ? Number(cd.length) : Number(cd.width), origY = rot % 180 ? Number(cd.width) : Number(cd.length)
      const child = {
        id: `${sl.child}_n${seq++}`, detailIndex: sl.child, label: cd.display_name || cd.name, prefix: cd.prefix,
        x: host.x + nx, y: host.y + ny, w: origX + k, h: origY + k, origX, origY,
        rotated: rot % 180 !== 0, rotation: rot, rotatable: !!cd.rotatable, isSmall: false, kf: k,
        polygon: poly.map(([x, y]) => ({ x, y })),
        ...turnEdges({ edgeTop: cd.edge_top, edgeRight: cd.edge_right, edgeBottom: cd.edge_bottom, edgeLeft: cd.edge_left }, rot / 90),
        nestedIn: host.id,
      }
      left.set(key, left.get(key) - 1)
      out.push(child)
      place(child, out)
    }
  }
  return sheets.map(sh => {
    const add = []
    for (const p of sh.placed) if (!p.nestedIn) place(p, add)
    return add.length ? { ...sh, placed: [...sh.placed, ...add] } : sh
  })
}

/** Убрать вложенные детали из раскладки (для «Продолжить»: поиск идёт без них, они вернутся при развёртке) */
export const stripNested = sheets => (sheets || []).map(sh => ({ ...sh, placed: (sh.placed || []).filter(p => !p.nestedIn) }))
