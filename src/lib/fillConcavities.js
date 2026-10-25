// Дозаполнение вырезов и пустот после раскроя фигурных деталей.
//
// Гибридный раскрой кладёт одиночную фигурную деталь (Г-образная боковина с
// вырезом под цоколь и т. п.) по её габариту — вырез остаётся пустым, хотя туда
// входит мелочь с последних листов. Этот проход берёт прямоугольные детали с
// последних листов и пытается переложить их на более ранние листы — в вырезы
// и пустоты, проверяя зазор на рез по НАСТОЯЩЕМУ контуру соседей.
//
// Координаты — как во всём раскрое: мм, Y вверх от низа рабочей зоны,
// p.w/p.h включают рез, polygon — локальный контур детали.
import { smallEdgeReal } from './nesting'

function polyArea(P) {
  let a = 0
  for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; a += p.x * q.y - q.x * p.y }
  return Math.abs(a) / 2
}
const isRect = p => {
  if (!Array.isArray(p.polygon) || p.polygon.length < 3) return true
  if (p.polygon.length !== 4) return false
  const xs = new Set(p.polygon.map(q => Math.round(q.x * 10))), ys = new Set(p.polygon.map(q => Math.round(q.y * 10)))
  return xs.size === 2 && ys.size === 2
}
const sizeOf = (p, kerf) => [Number(p.origX) > 0 ? Number(p.origX) : p.w - kerf, Number(p.origY) > 0 ? Number(p.origY) : p.h - kerf]

function shapeOf(p, kerf) {
  const [w, h] = sizeOf(p, kerf)
  const P = Array.isArray(p.polygon) && p.polygon.length > 2
    ? p.polygon.map(q => ({ x: p.x + q.x, y: p.y + q.y }))
    : [{ x: p.x, y: p.y }, { x: p.x + w, y: p.y }, { x: p.x + w, y: p.y + h }, { x: p.x, y: p.y + h }]
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const q of P) { if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y }
  const rect = isRect(p)
  // hole — площадь вырезов: габарит минус сама деталь (сколько места в вырезах вообще есть)
  return { P, x0, y0, x1, y1, rect, hole: rect ? 0 : (x1 - x0) * (y1 - y0) - polyArea(P) }
}

// Зазор между прямоугольником [x0..x1]×[y0..y1] и многоугольником (0 — пересекаются)
function segRectDist(a, b, x0, y0, x1, y1) {
  // отрезок пересекает прямоугольник?
  const inside = q => q.x > x0 && q.x < x1 && q.y > y0 && q.y < y1
  if (inside(a) || inside(b)) return 0
  const R = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]
  const d = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
  for (let i = 0; i < 4; i++) {
    const c = R[i], e = R[(i + 1) % 4]
    const d1 = d(c, e, a), d2 = d(c, e, b), d3 = d(a, b, c), d4 = d(a, b, e)
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0
  }
  // расстояние: от концов отрезка до прямоугольника и от углов прямоугольника до отрезка
  const ptRect = q => Math.hypot(Math.max(x0 - q.x, 0, q.x - x1), Math.max(y0 - q.y, 0, q.y - y1))
  const ptSeg = q => {
    const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy
    let t = l ? ((q.x - a.x) * dx + (q.y - a.y) * dy) / l : 0
    t = Math.max(0, Math.min(1, t))
    return Math.hypot(q.x - a.x - t * dx, q.y - a.y - t * dy)
  }
  return Math.min(ptRect(a), ptRect(b), ...R.map(ptSeg))
}
function inPoly(pt, P) {
  let c = false
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    if (((P[i].y > pt.y) !== (P[j].y > pt.y)) && pt.x < (P[j].x - P[i].x) * (pt.y - P[i].y) / (P[j].y - P[i].y) + P[i].x) c = !c
  }
  return c
}

// Встаёт ли прямоугольник w×h в точку (x, y) с зазором kerf от всех деталей листа:
// true — встаёт; прямоугольная деталь-помеха (по ней можно перескочить) или false
function fits(x, y, w, h, shapes, kerf) {
  const x1 = x + w, y1 = y + h, need = kerf - 0.01
  for (const s of shapes) {
    const gx = Math.max(s.x0 - x1, x - s.x1), gy = Math.max(s.y0 - y1, y - s.y1)
    if (gx >= need || gy >= need) continue
    if (s.rect) return s                           // габариты ближе реза, а деталь — прямоугольник
    if (inPoly({ x: x + w / 2, y: y + h / 2 }, s.P)) return false
    const P = s.P
    for (let i = 0; i < P.length; i++) {
      if (segRectDist(P[i], P[(i + 1) % P.length], x, y, x1, y1) < need) return false
    }
  }
  return true
}
const r1 = v => Math.round(v * 1000) / 1000   // только чтобы убрать дубли — округление не должно съедать рез

// Поворот прямоугольной детали на 90° (как в nesting.js)
function turned(p) {
  return {
    ...p, rotated: !p.rotated, rotation: ((p.rotation || 0) + 90) % 360,
    w: p.h, h: p.w, origX: p.origY, origY: p.origX,
    polygon: Array.isArray(p.polygon) ? (([w, h]) => [{ x: 0, y: 0 }, { x: h, y: 0 }, { x: h, y: w }, { x: 0, y: w }])([Number(p.origX) || p.w, Number(p.origY) || p.h]) : p.polygon,
    edgeTop: p.edgeLeft, edgeRight: p.edgeTop, edgeBottom: p.edgeRight, edgeLeft: p.edgeBottom,
  }
}

// Место для детали w×h — только в вырезах фигурных деталей листа: кандидаты — вплотную через рез к вершинам
// фигурной детали и к соседям, которые заходят в её габарит; сама деталь должна лечь внутрь этого габарита.
// Весь лист не перебираем: это дорого (поиск шёл на каждом улучшении и подвешивал телефон), а пустоты вне
// вырезов и так заполняет основной раскрой.
function tryPlace(sh, p, kerf, uX, uY) {
  const [w, h] = sizeOf(p, kerf)
  if (w > uX + 0.01 || h > uY + 0.01) return null
  const shapes = sh._shapes
  for (const c of shapes) {
    if (c.rect || c.x1 - c.x0 < w || c.y1 - c.y0 < h || (c.hole || 0) < w * h) continue
    const near = shapes.filter(s => s !== c && s.x0 < c.x1 + kerf && s.x1 > c.x0 - kerf && s.y0 < c.y1 + kerf && s.y1 > c.y0 - kerf)
    const xs = new Set([c.x0, c.x1 - w]), ys = new Set([c.y0, c.y1 - h])
    for (const s of [c, ...near]) for (const q of s.P) { xs.add(q.x + kerf); xs.add(q.x - kerf - w); ys.add(q.y + kerf); ys.add(q.y - kerf - h) }
    const X = [...new Set([...xs].map(r1))].filter(v => v >= Math.max(0, c.x0) - 0.01 && v + w <= Math.min(uX, c.x1) + 0.01).sort((a, b) => a - b)
    const Y = [...new Set([...ys].map(r1))].filter(v => v >= Math.max(0, c.y0) - 0.01 && v + h <= Math.min(uY, c.y1) + 0.01).sort((a, b) => a - b)
    for (const y of Y) for (let k = 0, skip = -Infinity; k < X.length; k++) {
      const x = X[k]
      if (x < skip) continue
      const f = fits(x, y, w, h, shapes, kerf)
      if (f !== true) { if (f) skip = f.x1 + kerf - 0.05; continue }
      const q = { ...p, x: Math.max(0, x), y: Math.max(0, y) }
      if (q.isSmall && smallEdgeReal(q, sh.placed, uX, uY) > 0) continue
      return q
    }
  }
  return null
}

/**
 * Перекладывает прямоугольные детали с последних листов в пустоты (в т. ч.
 * вырезы фигурных деталей) более ранних листов. Возвращает новый массив листов
 * (исходный не меняется) или null, если ничего не переложено.
 */
export function fillConcavities({ sheets, details = [], kerf = 0, usableX, usableY }) {
  if (!sheets?.length) return null
  // есть ли вообще вырезы/фигуры — иначе раскрой уже прямоугольный, нечего дозаполнять
  if (!sheets.some(sh => sh.placed.some(p => !isRect(p)))) return null
  const out = sheets.map(sh => ({ ...sh, placed: sh.placed.slice() }))
  for (const sh of out) sh._shapes = sh.placed.map(p => shapeOf(p, kerf))
  let moved = 0
  // с последнего листа к первому; на листе — крупные первыми. Второй круг —
  // в пустоты, освободившиеся на средних листах.
  // Последний лист — ещё и в вырезы фигурных деталей его самого (Г-образная деталь на последнем листе с пустым
  // вырезом, а рядом лежит деталь, которая туда входит; 261018_002 вдоль X): освободившееся место потом стягивается к нулю
  const lastI = out.length - 1
  for (let pass = 0; pass < 2; pass++) for (let si = out.length - 1; si >= 0; si--) {
    const src = out[si]
    const order = src.placed.map((p, i) => i).filter(i => src._shapes[i].rect)
      .sort((a, b) => { const [wa, ha] = sizeOf(src.placed[a], kerf), [wb, hb] = sizeOf(src.placed[b], kerf); return wb * hb - wa * ha })
    const gone = new Set()
    for (const i of order) {
      const p = src.placed[i]
      const d = details[p.detailIndex]
      const variants = [p]
      if (d?.rotatable) variants.push(turned(p))
      let done = false
      for (let ti = 0; ti <= si && !done; ti++) {
        if (ti === si && si !== lastI) break
        let dst = out[ti]
        // тот же лист: сама деталь (и уже переложенные) — не помеха
        const self = ti === si
        if (self) {
          const keep = (_, j) => j !== i && !gone.has(j)
          dst = { ...dst, placed: dst.placed.filter(keep), _shapes: dst._shapes.filter(keep), _free: null }
        }
        // обрезки и листы другого размера не трогаем
        if (dst.stock === 'offcut' || src.stock === 'offcut') continue
        const uX = dst.usableX ?? usableX, uY = dst.usableY ?? usableY
        const [mw, mh] = sizeOf(p, kerf)
        // на листе должен быть вырез, куда деталь хотя бы по площади влезет
        if (dst._free == null) dst._free = Math.max(0, ...dst._shapes.map(s => s.hole || 0))
        if (mw * mh > dst._free) continue
        for (const v of variants) {
          // Не влезла деталь этого размера на этот лист — и такая же не влезет, пока лист не изменился
          // (tryPlace зависит только от листа, размера и признака мелкой): на заказах из сотен одинаковых деталей с
          // пазами перебор занимал ~16 с (250911Ajbibi_k1, 346 дет.) — черновик и онлайн-показ стояли
          const fk = self ? null : sizeOf(v, kerf).join('x') + (v.isSmall ? 's' : '')
          if (fk && dst._fail?.has(fk)) continue
          const q = tryPlace(dst, v, kerf, uX, uY)
          if (!q) { if (fk) (dst._fail || (dst._fail = new Set())).add(fk); continue }
          if (self && v === p && Math.abs(q.x - p.x) < 0.01 && Math.abs(q.y - p.y) < 0.01) { done = true; break }   // уже стоит в вырезе
          const real = out[ti]
          real.placed.push(q); real._shapes.push(shapeOf(q, kerf)); real._free = null; real._fail = null
          gone.add(i); moved++; done = true
          break
        }
      }
    }
    if (gone.size) {
      src._free = null                               // пересчитается при следующем обращении
      src._fail = null                               // лист изменился — неудачи пересчитываются
      src.placed = src.placed.filter((_, i) => !gone.has(i))
      src._shapes = src._shapes.filter((_, i) => !gone.has(i))
    }
  }
  if (!moved) return null
  return out.filter(sh => sh.placed.length).map(sh => { const rest = { ...sh }; delete rest._shapes; delete rest._free; delete rest._fail; return rest })
}
