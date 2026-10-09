// Проверка раскроя перед сохранением / оформлением заказа.
//
// Не доверяет ни алгоритму, ни ручным правкам (перенос, поворот, буфер) —
// проверяет итоговую раскладку заново, по координатам:
//   1. все детали заказа на листах, ни одна не потеряна и не задвоена;
//   2. ни одна деталь не выходит за рабочую зону (отступы от края листа);
//   3. между деталями выдержан зазор на рез (у фигурных — по реальному контуру);
//   4. размеры деталей совпадают с заказом, запрет поворота соблюдён;
//   5. для пилы (форматника) — каждый лист режется сквозными резами.
//
// Координаты — как во всех данных раскроя: мм, Y вверх от низа рабочей зоны;
// p.w/p.h включают ширину реза (справа и сверху), контур polygon — локальный.

import { smallAtEdge, SMALL_EDGE_MIN } from './nesting'

const EPS = 0.5 // мм — допуск на округления

function polyOf(p, kerf) {
  if (Array.isArray(p.polygon) && p.polygon.length > 2) return p.polygon.map(q => ({ x: p.x + q.x, y: p.y + q.y }))
  // размер детали — её собственный (origX/origY), а не «габарит с резом минус рез»: если раскрой считали
  // с одним резом, а проверяют с другим, деталь не должна «менять размер»
  const w = Number(p.origX) > 0 ? Number(p.origX) : p.w - kerf, h = Number(p.origY) > 0 ? Number(p.origY) : p.h - kerf
  return [{ x: p.x, y: p.y }, { x: p.x + w, y: p.y }, { x: p.x + w, y: p.y + h }, { x: p.x, y: p.y + h }]
}
const hasShape = p => Array.isArray(p.polygon) && p.polygon.length > 2

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
// Минимальный зазор между контурами (0 — пересекаются или один внутри другого)
function polyGap(A, B) {
  for (let i = 0; i < A.length; i++) for (let j = 0; j < B.length; j++) {
    if (segsCross(A[i], A[(i + 1) % A.length], B[j], B[(j + 1) % B.length])) return 0
  }
  if (inPoly(A[0], B) || inPoly(B[0], A)) return 0
  let m = Infinity
  for (const p of A) for (let j = 0; j < B.length; j++) m = Math.min(m, segDist(p, B[j], B[(j + 1) % B.length]))
  for (const p of B) for (let j = 0; j < A.length; j++) m = Math.min(m, segDist(p, A[j], A[(j + 1) % A.length]))
  return m
}

// Режется ли набор прямоугольников сквозными резами (рекурсивно)
function guillotineOk(rects, kerf) {
  if (rects.length <= 1) return true
  for (const [lo, hi] of [['x0', 'x1'], ['y0', 'y1']]) {
    const cands = [...new Set(rects.map(r => r[hi]))].sort((a, b) => a - b)
    for (const c of cands) {
      const A = rects.filter(r => r[hi] <= c + 0.01)
      const B = rects.filter(r => r[lo] >= c + kerf - 0.01)
      if (A.length && B.length && A.length + B.length === rects.length) return guillotineOk(A, kerf) && guillotineOk(B, kerf)
    }
  }
  return false
}

/**
 * sheets — листы раскроя (как sheetsData), details — детали заказа.
 * Возвращает { ok, errors: [строки], stats }.
 */
export function validateNesting({ sheets, details, usableX, usableY, kerf, cuttingMethod = 'nesting' }) {
  const errors = []
  const name = p => ((p.prefix ? p.prefix + ' ' : '') + String(p.label || details[p.detailIndex]?.display_name || details[p.detailIndex]?.name || 'деталь')).trim()
  const cap = 30 // не заваливаем экран — показываем первые ошибки
  const push = s => { if (errors.length < cap) errors.push(s) }

  // 1. Количество каждой детали
  const cnt = new Array(details.length).fill(0)
  let unknown = 0
  sheets.forEach(sh => sh.placed.forEach(p => {
    if (p.detailIndex >= 0 && p.detailIndex < details.length) cnt[p.detailIndex]++
    else unknown++
  }))
  details.forEach((d, i) => {
    const need = Number(d.qty) || 1
    if (cnt[i] < need) push(`Потеряны детали: «${d.display_name || d.name}» — на листах ${cnt[i]} из ${need}`)
    if (cnt[i] > need) push(`Лишние детали: «${d.display_name || d.name}» — на листах ${cnt[i]}, в заказе ${need}`)
  })
  if (unknown) push(`На листах ${unknown} дет., которых нет в заказе`)

  sheets.forEach((sh, si) => {
    const L = sh.stock === 'offcut' ? `Лист ${si + 1} (обрезок)` : `Лист ${si + 1}`
    // у листа-обрезка своя рабочая зона
    const uX = sh.usableX ?? usableX, uY = sh.usableY ?? usableY
    const polys = sh.placed.map(p => polyOf(p, kerf))
    sh.placed.forEach((p, i) => {
      const d = details[p.detailIndex]
      // 2. Выход за рабочую зону (отступы от края листа)
      const P = polys[i]
      const minX = Math.min(...P.map(q => q.x)), maxX = Math.max(...P.map(q => q.x))
      const minY = Math.min(...P.map(q => q.y)), maxY = Math.max(...P.map(q => q.y))
      if (minX < -EPS || minY < -EPS || maxX > uX + EPS || maxY > uY + EPS) {
        push(`${L}: «${name(p)}» заходит на отступ от края листа`)
      }
      // 4. Размеры и поворот
      if (d) {
        const W = Number(d.width), H = Number(d.length)
        const sameDims = (Math.abs(p.origX - W) <= EPS && Math.abs(p.origY - H) <= EPS)
        const turned = (Math.abs(p.origX - H) <= EPS && Math.abs(p.origY - W) <= EPS)
        if (!sameDims && !turned) push(`${L}: «${name(p)}» ${Math.round(p.origY)}×${Math.round(p.origX)} не совпадает с заказом ${H}×${W}`)
        else if (!d.rotatable && !sameDims && W !== H) push(`${L}: «${name(p)}» повёрнута, хотя вращать её нельзя (текстура)`)
      }
    })
    // 3. Пересечения и зазор на рез — по настоящим координатам деталей. Между любыми двумя деталями должен быть
    // зазор не меньше ширины реза хотя бы по одной оси (так кладёт детали и сам раскрой); у фигурных — по контуру.
    const TOL = 0.05                                    // мм — только на погрешность сложения дробных чисел
    const box = polys.map(P => ({ x0: Math.min(...P.map(q => q.x)), x1: Math.max(...P.map(q => q.x)), y0: Math.min(...P.map(q => q.y)), y1: Math.max(...P.map(q => q.y)) }))
    for (let i = 0; i < sh.placed.length; i++) {
      const a = sh.placed[i], A = box[i]
      for (let j = i + 1; j < sh.placed.length; j++) {
        const b = sh.placed[j], B = box[j]
        const gx = Math.max(B.x0 - A.x1, A.x0 - B.x1), gy = Math.max(B.y0 - A.y1, A.y0 - B.y1)   // зазоры между габаритами
        if (gx >= kerf - TOL || gy >= kerf - TOL) continue                                        // разнесены на рез — ок
        if (!hasShape(a) && !hasShape(b)) {
          if (gx < -0.01 && gy < -0.01) push(`${L}: пересекаются «${name(a)}» и «${name(b)}»`)
          else push(`${L}: между «${name(a)}» и «${name(b)}» зазор ${Math.max(0, Math.max(gx, gy)).toFixed(1)} мм — меньше реза ${kerf} мм`)
          continue
        }
        const g = polyGap(polys[i], polys[j])
        if (g <= 0.01) push(`${L}: пересекаются «${name(a)}» и «${name(b)}»`)
        else if (g < kerf - EPS) push(`${L}: между «${name(a)}» и «${name(b)}» зазор ${g.toFixed(1)} мм — меньше реза ${kerf} мм`)
      }
    }
    // 5. Пила — только сквозные резы
    if (cuttingMethod === 'guillotine' && sh.placed.length > 1) {
      if (!guillotineOk(box.map(r => ({ ...r })), kerf)) push(`${L}: не раскраивается сквозными резами — пилой его не разрезать`)
    }
    if (!sh.placed.length) push(`${L} пустой`)
  })

  // Предупреждение (не ошибка): «мелкие — в центр», но мелкая деталь у края листа
  // (у края = ближе SMALL_EDGE_MIN мм к краю листа через отход, см. nesting.smallEdgeSides)
  const warnings = []
  const edge = smallAtEdge(sheets, usableX, usableY, true)
  const gap = sheets.flatMap(sh => sh.placed).find(p => p.isSmall)?.edgeMin || SMALL_EDGE_MIN
  if (edge) warnings.push(`⚠ мелких/узких деталей у края листа: ${edge} (ближе ${gap} мм через отход)`)

  const total = details.reduce((a, d) => a + (Number(d.qty) || 1), 0)
  const placed = cnt.reduce((a, b) => a + b, 0)
  return { ok: errors.length === 0, errors, warnings, stats: { total, placed, sheets: sheets.length } }
}
