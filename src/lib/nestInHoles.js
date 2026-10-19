// Вложение деталей в сквозные вырезы других деталей (фрезер).
//
// Кольцо борта 1088×2388 с вырезом 936×2236 — внутрь входит основание 920×2220; кольцо поменьше — в кольцо побольше.
// Раскрой сам такого не видит: деталь для него — её наружный контур, вырез — не свободное место. Здесь это делается
// закономерно, до поиска: для каждого выреза (от большого к малому) подбирается самая крупная деталь заказа, которая
// входит в него с зазором не меньше реза (поворот 0°, а если деталь можно вращать — и 90°; деталь ставится в центр
// выреза). Вложенная деталь выбывает из раскроя, а к детали-хозяину «пристёгивается» и после укладки встаёт внутрь её
// выреза (с тем же поворотом). Цепочки — тоже: кольцо → полоса → панель. Один вырез — одна деталь.
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
// plan: Map<detailIndex, [{ hole, child, rot, ox, oy, count }]> } — для каждой детали-хозяина: в какой вырез, какая
// деталь, с каким поворотом (0/90 — относительно хозяина) и на каком месте (левый нижний угол габарита в «родных»
// координатах хозяина), и сколько экземпляров хозяина получают вложение (остальные — пустые).
export function planNestInHoles(details, kerf) {
  const k = Number(kerf) || 0
  const qty = details.map(d => Math.max(0, Math.floor(Number(d.qty) || 0)))
  const polys = details.map(d => { try { return roughShapePolygons(d) } catch { return null } })
  const area = P => { let a = 0; for (let i = 0; i < P.length; i++) { const [x1, y1] = P[i], [x2, y2] = P[(i + 1) % P.length]; a += x1 * y2 - x2 * y1 } return Math.abs(a) / 2 }
  const polyArea = P => { let a = 0; for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; a += p.x * q.y - q.x * p.y } return Math.abs(a) / 2 }
  // все вырезы всех деталей — от большого к малому
  const holes = []
  details.forEach((d, di) => { if (qty[di] > 0) throughHoles(d).forEach(h => holes.push({ di, idx: h.idx, poly: h.poly, area: polyArea(h.poly), bb: bboxOf(h.poly) })) })
  if (!holes.length) return null
  holes.sort((a, b) => b.area - a.area)
  // кандидаты — от крупной к мелкой (по площади контура)
  const cands = details.map((d, di) => ({ di, area: polys[di] ? area(polys[di][0]) : 0 })).filter(c => c.area > 0).sort((a, b) => b.area - a.area)
  const plan = new Map()
  // сколько экземпляров хозяина ещё без вложения в этом вырезе
  const freeInst = new Map()   // `${di}|${idx}` → число
  // кто в кого вложен — чтобы не получить кольцо (A в B, B в A); цепочки разрешены
  const parentOf = new Map()
  const ancestorIs = (di, anc) => { let x = di; for (let g = 0; g < 50 && x != null; g++) { x = parentOf.get(x); if (x === anc) return true } return false }
  for (const h of holes) {
    const key = `${h.di}|${h.idx}`
    if (!freeInst.has(key)) freeInst.set(key, Math.max(0, Math.floor(Number(details[h.di].qty) || 0)))   // экземпляров хозяина — по заказу (сам он мог быть вложен)
    let free = freeInst.get(key)
    if (free <= 0) continue
    for (const c of cands) {
      if (c.di === h.di || qty[c.di] <= 0 || free <= 0) continue
      if (c.area >= h.area) continue
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
        // по центру выреза, затем по углам (левый нижний, правый верхний и т. д.) с зазором на рез
        const anchors = [
          [(h.bb.x0 + h.bb.x1) / 2 - cw / 2, (h.bb.y0 + h.bb.y1) / 2 - ch / 2],
          [h.bb.x0 + k, h.bb.y0 + k], [h.bb.x1 - k - cw, h.bb.y0 + k], [h.bb.x0 + k, h.bb.y1 - k - ch], [h.bb.x1 - k - cw, h.bb.y1 - k - ch],
        ]
        for (const [ox, oy] of anchors) {
          const abs = poly.map(([x, y]) => ({ x: ox + (x - pb.x0), y: oy + (y - pb.y0) }))
          if (polyInsideWithGap(abs, h.poly, k)) { fit = { rot, ox, oy }; break }
        }
        if (fit) break
      }
      if (!fit) continue
      const count = Math.min(free, qty[c.di])
      if (!plan.has(h.di)) plan.set(h.di, [])
      plan.get(h.di).push({ hole: h.idx, child: c.di, rot: fit.rot, ox: fit.ox, oy: fit.oy, count })
      qty[c.di] -= count
      free -= count
      freeInst.set(key, free)
      parentOf.set(c.di, h.di)
      break   // один вырез — одна деталь
    }
  }
  if (!plan.size) return null
  // Вложенная деталь поворачивается вместе с хозяином. Если её вращать нельзя (текстура), хозяин в раскрое тоже
  // не вращается — иначе вложение встанет против текстуры. По цепочке — вверх до самого внешнего хозяина
  const locked = new Set()
  for (let pass = 0; pass < 50; pass++) {
    let changed = false
    for (const [di, list] of plan) {
      if (locked.has(di)) continue
      if (list.some(e => !details[e.child].rotatable || locked.has(e.child))) { locked.add(di); changed = true }
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
  const left = new Map()   // `${di}|${hole}` → сколько ещё вложить
  for (const [di, list] of plan) list.forEach(e => left.set(`${di}|${e.hole}`, e.count))
  let seq = 0
  const polyCache = new Map()
  const polysOf = di => { if (!polyCache.has(di)) { try { polyCache.set(di, roughShapePolygons(details[di])) } catch { polyCache.set(di, null) } } return polyCache.get(di) }
  const place = (host, out) => {
    const list = plan.get(host.detailIndex)
    if (!list) return
    const hd = details[host.detailIndex]
    const W = Number(hd.width) || 0, H = Number(hd.length) || 0
    const t = host.rotation != null ? ((Math.round(Number(host.rotation) / 90) % 4) + 4) % 4 : (host.rotated ? 1 : 0)
    for (const e of list) {
      const key = `${host.detailIndex}|${e.hole}`
      if (!(left.get(key) > 0)) continue
      const cd = details[e.child], P = polysOf(e.child)
      if (!P) continue
      const rot = (e.rot + 90 * t) % 360
      const poly = P[rot]
      if (!poly) continue
      const cw0 = e.rot % 180 ? Number(cd.length) : Number(cd.width), ch0 = e.rot % 180 ? Number(cd.width) : Number(cd.length)
      // габарит вложения в «родных» координатах хозяина → поворот вместе с хозяином
      const corners = [[e.ox, e.oy], [e.ox + cw0, e.oy], [e.ox + cw0, e.oy + ch0], [e.ox, e.oy + ch0]].map(([x, y]) => rotatePointTimes(x, y, W, H, t))
      const nx = Math.min(...corners.map(q => q.x)), ny = Math.min(...corners.map(q => q.y))
      const origX = rot % 180 ? Number(cd.length) : Number(cd.width), origY = rot % 180 ? Number(cd.width) : Number(cd.length)
      const child = {
        id: `${e.child}_n${seq++}`, detailIndex: e.child, label: cd.display_name || cd.name, prefix: cd.prefix,
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
