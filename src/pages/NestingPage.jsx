import { useState, useEffect, useLayoutEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { runNesting, computeOffcutAtPoint } from '../lib/nesting'
import { NESTING_VERSION } from '../lib/version'
import { getAllDrillPoints, rotatePointTimes, rotateEdgesTimes } from '../lib/drillGeometry'
import { buildNestingDxf } from '../lib/dxfExport'
import BottomNav from '../components/BottomNav'

const COLORS = [
  '#B5D4F4','#9FE1CB','#F5C4B3','#CECBF6','#FAC775',
  '#C0DD97','#F4C0D1','#B4B2A9','#85B7EB','#5DCAA5',
]

const PART_STROKE = 'rgba(20,20,20,0.8)'
// Заливка деталей на карте раскроя — единый светло-серый (границы деталей
// видны по тёмному контуру)
const PART_FILL = '#E6E6E6'
const EDGE_COLOR = '#185FA5'
const EDGE_GAP = 3                 // отступ линии кромки от контура детали, px
const LONG_PRESS_MS = 550
// Удержание пальца на детали, после которого её можно двигать (короткое
// касание/скольжение деталь не двигает; двойной тап — поворот)
const DRAG_HOLD_MS = 250

// ─── Проверка пересечения двух полигонов (для true-shape деталей) — обычная
// bbox-проверка слишком грубая: деталь, аккуратно уложенная в паз соседней,
// всегда "пересекается" по прямоугольнику, хотя по факту нет. Полигон уже в
// АБСОЛЮТНЫХ координатах листа (вершины + смещение x,y детали) ────────────
function segmentsIntersect(a1, a2, b1, b2) {
  const d = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
  const d1 = d(b1, b2, a1), d2 = d(b1, b2, a2), d3 = d(a1, a2, b1), d4 = d(a1, a2, b2)
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}
function pointInPolygon(pt, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y
    const cross = ((yi > pt.y) !== (yj > pt.y)) && (pt.x < (xj - xi) * (pt.y - yi) / (yj - yi) + xi)
    if (cross) inside = !inside
  }
  return inside
}
// Самый широкий отрезок материала детали вдоль горизонтальной линии y —
// нужен, чтобы поставить подпись гарантированно НА детали, а не в пустом
// пазу, если центр масс контура (из-за вогнутости) оказался вне материала.
function widestSegmentAtY(poly, y) {
  const xs = []
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]
    if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) {
      const t = (y - a.y) / (b.y - a.y)
      xs.push(a.x + t * (b.x - a.x))
    }
  }
  xs.sort((a, b) => a - b)
  let best = null, bestLen = 0
  for (let i = 0; i + 1 < xs.length; i += 2) {
    const len = xs[i + 1] - xs[i]
    if (len > bestLen) { bestLen = len; best = [xs[i], xs[i + 1]] }
  }
  return best
}
// Помещается ли прямоугольник подписи (центр cx,cy, полуразмеры hw,hh, мм)
// целиком в материал детали — проверка по сетке точек внутри полигона.
function rectInsidePoly(poly, cx, cy, hw, hh) {
  for (let i = 0; i <= 6; i++) {
    for (let j = 0; j <= 2; j++) {
      const pt = { x: cx - hw + (2 * hw * i) / 6, y: cy - hh + (2 * hh * j) / 2 }
      if (!pointInPolygon(pt, poly)) return false
    }
  }
  return true
}
// Места для размеров ВНУТРИ контура фигурной детали (локальные мм, Y вверх):
// ширина (X) — горизонтальный текст как можно ближе к верху, длина (Y) —
// вертикальный текст как можно ближе к левому краю. Если на материале
// подходящего места нет — соответствующий размер не рисуется.
function findDimSpots(poly, origX, origY, wLenMm, lLenMm, thMm) {
  const step = 3, pad = 2
  let top = null, left = null
  for (let cy = origY - thMm / 2 - pad; cy > thMm / 2; cy -= step) {
    const seg = widestSegmentAtY(poly, cy)
    if (seg && seg[1] - seg[0] >= wLenMm + 2 * pad) {
      const cx = (seg[0] + seg[1]) / 2
      if (rectInsidePoly(poly, cx, cy, wLenMm / 2 + pad / 2, thMm / 2)) { top = { x: cx, y: cy }; break }
    }
  }
  const T = poly.map(pt => ({ x: pt.y, y: pt.x }))
  for (let cx = thMm / 2 + pad; cx < origX - thMm / 2; cx += step) {
    const seg = widestSegmentAtY(T, cx)
    if (seg && seg[1] - seg[0] >= lLenMm + 2 * pad) {
      const cy = (seg[0] + seg[1]) / 2
      if (rectInsidePoly(poly, cx, cy, thMm / 2, lLenMm / 2 + pad / 2)) { left = { x: cx, y: cy }; break }
    }
  }
  return { top, left }
}
const dimSpotCache = new WeakMap() // полигон → { key, spots }, чтобы не пересчитывать при каждой перерисовке
// Интервалы материала полигона вдоль горизонтальной линии y: [[xl, xr], ...]
function intervalsAt(poly, y) {
  const xs = []
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]
    if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) xs.push(a.x + (y - a.y) / (b.y - a.y) * (b.x - a.x))
  }
  xs.sort((p, q) => p - q)
  const out = []
  for (let i = 0; i + 1 < xs.length; i += 2) out.push([xs[i], xs[i + 1]])
  return out
}
// Занятое деталью место как набор прямоугольников для расчёта обрезка.
// Прямоугольная деталь — один прямоугольник (видимая часть + зазор на рез
// со всех сторон). Фигурная (Г, П и т.п.) — набор горизонтальных полос
// по самому материалу, чтобы пустая часть внутри габарита оставалась
// свободной и в ней можно было выбрать обрезок.
function partObstacles(p, kerf) {
  if (!(Array.isArray(p.polygon) && p.polygon.length > 2)) {
    return [{ x: p.x - kerf, y: p.y - kerf, w: p.w + kerf, h: p.h + kerf }]
  }
  const poly = absolutePoly(p, kerf)
  const ys = [...new Set(poly.map(q => Math.round(q.y * 10) / 10))].sort((a, b) => a - b)
  const out = []
  const addSlab = (ya, yb, depth) => {
    if (yb - ya < 0.3) return
    const e = Math.min(0.05, (yb - ya) / 10)
    const i0 = intervalsAt(poly, ya + e), im = intervalsAt(poly, (ya + yb) / 2), i1 = intervalsAt(poly, yb - e)
    const same = i0.length === im.length && i1.length === im.length
    const straight = same && im.every((iv, k) =>
      Math.abs(iv[0] - i0[k][0]) <= 1 && Math.abs(iv[1] - i0[k][1]) <= 1 &&
      Math.abs(iv[0] - i1[k][0]) <= 1 && Math.abs(iv[1] - i1[k][1]) <= 1)
    if (!straight && depth < 1 && yb - ya > 25) {
      const n = Math.ceil((yb - ya) / 25)
      for (let k = 0; k < n; k++) addSlab(ya + (yb - ya) * k / n, ya + (yb - ya) * (k + 1) / n, 1)
      return
    }
    im.forEach((iv, k) => {
      let xl = iv[0], xr = iv[1]
      if (same) { xl = Math.min(xl, i0[k][0], i1[k][0]); xr = Math.max(xr, i0[k][1], i1[k][1]) }
      out.push({ x: xl - kerf, y: ya - kerf, w: xr - xl + 2 * kerf, h: yb - ya + 2 * kerf })
    })
  }
  for (let i = 0; i + 1 < ys.length; i++) addSlab(ys[i], ys[i + 1], 0)
  return out.length ? out : [{ x: p.x - kerf, y: p.y - kerf, w: p.w + kerf, h: p.h + kerf }]
}

// ─── Линии реза (форматно-раскроечный станок) ─────────────────────────────
// Строятся по ТЕКУЩЕЙ карте раскроя (в экранных координатах, Y сверху вниз),
// поэтому после любого редактирования (перенос, поворот) пересчитываются
// заново. Сквозной рез — линия через весь участок листа, не пересекающая
// ни одной детали. Деталь занимает [x, x+w]×[y, y+h], где w/h включают
// ширину реза на правой и нижней стороне; линия рисуется по центру пропила.
// Участок делится рекурсивно.
function decomposeCuts(rects, usableX, usableY, kerf, pref) {
  const EPS = 0.5
  const lines = [], unsplit = []
  const queue = [{ x0: 0, y0: 0, x1: usableX, y1: usableY, parts: rects }]
  const findCut = (reg, axis) => {
    const v = axis === 'v'
    const a0 = v ? reg.x0 : reg.y0, a1 = v ? reg.x1 : reg.y1
    const cands = []
    reg.parts.forEach(o => {
      const s0 = v ? o.x : o.y, len = v ? o.w : o.h
      cands.push({ c: s0 + len, line: s0 + len - kerf / 2 })            // за правым/нижним краем детали
      if (s0 - kerf > a0 + EPS) cands.push({ c: s0 - kerf, line: s0 - kerf / 2 }) // перед левым/верхним краем (пустая полоса до детали)
    })
    cands.sort((p, q) => p.c - q.c)
    for (const cd of cands) {
      if (cd.c <= a0 + EPS || cd.c >= a1 - kerf - EPS) continue
      const crosses = reg.parts.some(o => {
        const s0 = v ? o.x : o.y, len = v ? o.w : o.h
        return s0 < cd.c - EPS && s0 + len > cd.c + EPS
      })
      if (!crosses) return cd
    }
    return null
  }
  while (queue.length) {
    const reg = queue.shift()
    if (!reg.parts.length) continue
    const order = pref === 'v' ? ['v', 'h'] : ['h', 'v']
    let done = false
    for (const axis of order) {
      const cd = findCut(reg, axis)
      if (!cd) continue
      const v = axis === 'v'
      lines.push(v
        ? { v: true, pos: cd.line, from: reg.y0, to: reg.y1 }
        : { v: false, pos: cd.line, from: reg.x0, to: reg.x1 })
      const mid = o => v ? o.x + o.w / 2 : o.y + o.h / 2
      const A = reg.parts.filter(o => mid(o) < cd.c), B = reg.parts.filter(o => mid(o) >= cd.c)
      queue.push(v ? { ...reg, x1: cd.c, parts: A } : { ...reg, y1: cd.c, parts: A })
      queue.push(v ? { ...reg, x0: cd.c, parts: B } : { ...reg, y0: cd.c, parts: B })
      done = true
      break
    }
    if (!done && reg.parts.length > 1) unsplit.push(reg)
  }
  return { lines, unsplit }
}
function computeCutLines(items, usableX, usableY, kerf, offcuts = []) {
  const rects = items.map(p => ({ x: p.x, y: p.y, w: p.w, h: p.h }))
  // Выбранные обрезки — деловые заготовки, такие же "детали" для резов; у
  // обрезка зазор на рез идёт с каждой стороны, поэтому добавляем kerf
  // справа и снизу (как у обычной детали)
  // Обрезок хранится вместе с продлением до физического края листа — для
  // резов берём его часть в пределах рабочей зоны
  offcuts.forEach(o => {
    const x0 = Math.max(0, o.x), y0 = Math.max(0, o.y)
    const x1 = Math.min(usableX, o.x + o.w), y1 = Math.min(usableY, o.y + o.h)
    if (x1 - x0 > 1 && y1 - y0 > 1) rects.push({ x: x0, y: y0, w: x1 - x0 + kerf, h: y1 - y0 + kerf })
  })
  const a = decomposeCuts(rects, usableX, usableY, kerf, 'v')
  const b = decomposeCuts(rects, usableX, usableY, kerf, 'h')
  const len = r => r.lines.reduce((t, l) => t + (l.to - l.from), 0)
  if (a.unsplit.length !== b.unsplit.length) return a.unsplit.length < b.unsplit.length ? a : b
  return len(a) <= len(b) ? a : b
}
function polygonsOverlap(polyA, polyB) {
  for (let i = 0; i < polyA.length; i++) {
    const a1 = polyA[i], a2 = polyA[(i + 1) % polyA.length]
    for (let j = 0; j < polyB.length; j++) {
      const b1 = polyB[j], b2 = polyB[(j + 1) % polyB.length]
      if (segmentsIntersect(a1, a2, b1, b2)) return true
    }
  }
  return pointInPolygon(polyA[0], polyB) || pointInPolygon(polyB[0], polyA)
}
// Абсолютный полигон детали на листе: свой polygon (если true-shape) со
// смещением на x,y, иначе — прямоугольник по w/h (минус kerf, как и рисуем).
// ВАЖНО: тот же переворот по Y, что и в отрисовке/DXF-экспорте — локальные
// точки контура (pt.y) заданы "снизу вверх", а p.y — это позиция "сверху
// вниз" (от верха рабочей зоны). Без этого переворота при перетаскивании
// двух контурных деталей друг НАД другом (разная p.y) проверка пересечения
// сравнивает их в несовместимых системах координат — отсюда ложные
// срабатывания именно при вертикальном совмещении и отсутствие проблемы
// при горизонтальном (там p.y одинаковый у обеих, ошибка не проявляется).
function absolutePoly(p, kerf) {
  if (Array.isArray(p.polygon) && p.polygon.length > 2) {
    return p.polygon.map(pt => ({ x: p.x + pt.x, y: p.y + (p.origY - pt.y) }))
  }
  const w = p.w - kerf, h = p.h - kerf
  return [{ x: p.x, y: p.y }, { x: p.x + w, y: p.y }, { x: p.x + w, y: p.y + h }, { x: p.x, y: p.y + h }]
}

// Минимальный зазор между двумя полигонами (0, если пересекаются). Для
// непересекающихся многоугольников кратчайшее расстояние достигается между
// вершиной одного и ребром другого.
function pointSegDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy
  let t = l ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l : 0
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}
function polyGap(A, B) {
  if (polygonsOverlap(A, B)) return 0
  let m = Infinity
  for (let i = 0; i < A.length; i++) {
    for (let j = 0; j < B.length; j++) {
      const b1 = B[j], b2 = B[(j + 1) % B.length]
      m = Math.min(m, pointSegDist(A[i], b1, b2))
    }
  }
  for (let j = 0; j < B.length; j++) {
    for (let i = 0; i < A.length; i++) {
      const a1 = A[i], a2 = A[(i + 1) % A.length]
      m = Math.min(m, pointSegDist(B[j], a1, a2))
    }
  }
  return m
}
const hasShapeOf = p => Array.isArray(p.polygon) && p.polygon.length > 2

// Конфликт двух деталей. Прямоугольные — пересечение (зазор на рез уже
// заложен в размеры). Если хотя бы одна деталь фигурная (Г, П...) —
// требуем зазор НЕ МЕНЬШЕ ширины реза по самому контуру, в том числе во
// внутренней части (вложенные друг в друга детали).
function piecesConflict(a, b, kerf) {
  if (!hasShapeOf(a) && !hasShapeOf(b)) {
    if (a.x >= b.x + b.w - kerf || b.x >= a.x + a.w - kerf ||
        a.y >= b.y + b.h - kerf || b.y >= a.y + a.h - kerf) return false
    return polygonsOverlap(absolutePoly(a, kerf), absolutePoly(b, kerf))
  }
  // габариты (с учётом kerf) разнесены дальше kerf — конфликта нет
  if (a.x >= b.x + b.w || b.x >= a.x + a.w || a.y >= b.y + b.h || b.y >= a.y + a.h) return false
  return polyGap(absolutePoly(a, kerf), absolutePoly(b, kerf)) < kerf - 0.5
}

// Магнит по контуру: фигурная деталь притягивается к соседям так, чтобы зазор
// между контурами был ровно kerf. Притяжение работает по обеим осям сразу —
// деталь встаёт в угол между двумя сторонами (в т.ч. внутри выреза Г-образной).
// Если рядом только одна сторона — притягивается к ней по одной оси, а вдоль
// неё деталь свободно скользит (пока не появится вторая сторона в пределах snap).
function snapPolygonGap(m, sx, sy, items, idx, kerf, snap) {
  const mShape = hasShapeOf(m)
  const step = 4, TOL = 0.005
  const R = snap * 2 + kerf
  const near = []
  for (let i = 0; i < items.length; i++) {
    if (i === idx) continue
    const o = items[i]
    if (!mShape && !hasShapeOf(o)) continue
    if (sx >= o.x + o.w + R || o.x >= sx + m.w + R || sy >= o.y + o.h + R || o.y >= sy + m.h + R) continue
    near.push({ poly: absolutePoly(o, kerf), x0: o.x, y0: o.y, x1: o.x + o.w - kerf, y1: o.y + o.h - kerf })
  }
  if (!near.length) return { x: sx, y: sy }

  // Зазор до ВСЕХ соседей не меньше kerf в положении (x, y)?
  const clearAt = (x, y) => {
    const bx1 = x + m.w - kerf, by1 = y + m.h - kerf
    let mp = null
    for (const n of near) {
      const gx = Math.max(n.x0 - bx1, x - n.x1), gy = Math.max(n.y0 - by1, y - n.y1)
      if (Math.hypot(Math.max(0, gx), Math.max(0, gy)) >= kerf) continue // габариты далеко — заведомо ок
      if (!mp) mp = absolutePoly({ ...m, x, y }, kerf)
      if (polyGap(mp, n.poly) < kerf - TOL) return false
    }
    return true
  }
  // Ближайший по оси сдвиг (в пределах snap), при котором деталь касается
  // какой-либо стороны соседа с зазором ровно kerf
  const findRoot = (axis, x, y) => {
    const at = d => axis === 'x' ? clearAt(x + d, y) : clearAt(x, y + d)
    const c0 = at(0)
    let best = null
    for (const dir of [1, -1]) {
      let prevClear = c0, pd = 0
      for (let d = step; d <= snap; d += step) {
        const c = at(dir * d)
        if (c !== prevClear) {
          let a = prevClear ? pd : d, b = prevClear ? d : pd // a — сторона с зазором ≥ kerf, b — нарушение
          for (let it = 0; it < 9; it++) { const mid = (a + b) / 2; if (at(dir * mid)) a = mid; else b = mid }
          const root = dir * a
          if (best === null || Math.abs(root) < Math.abs(best)) best = root
          break
        }
        prevClear = c; pd = d
      }
    }
    return best
  }
  // Обе оси подряд; порядок осей влияет на результат, берём тот, где сдвиг меньше
  const tryOrder = order => {
    let x = sx, y = sy
    for (const axis of order) {
      const r = findRoot(axis, x, y)
      if (r !== null) { if (axis === 'x') x += r; else y += r }
    }
    return { x, y }
  }
  const cands = [tryOrder(['x', 'y']), tryOrder(['y', 'x'])].filter(c => clearAt(c.x, c.y))
  if (!cands.length) return { x: sx, y: sy }
  cands.sort((p, q) => (Math.abs(p.x - sx) + Math.abs(p.y - sy)) - (Math.abs(q.x - sx) + Math.abs(q.y - sy)))
  return cands[0]
}

// Деталь выходит за границы рабочей зоны листа
// (p.w/p.h включают kerf, а реально видимая деталь на kerf меньше — как и в
// отрисовке; автораскрой ставит детали именно так, поэтому проверяем по
// видимому размеру, иначе "правильная" укладка окажется красной)
function outOfSheet(p, usableX, usableY, kerf) {
  return p.x < -0.5 || p.y < -0.5 ||
    p.x + p.w - kerf > usableX + 0.5 || p.y + p.h - kerf > usableY + 0.5
}

// Индексы деталей, которые пересекаются с другой деталью или вылезли за лист
function conflictSet(items, kerf, usableX, usableY) {
  const bad = new Set()
  for (let i = 0; i < items.length; i++) {
    if (outOfSheet(items[i], usableX, usableY, kerf)) bad.add(i)
    for (let j = i + 1; j < items.length; j++) {
      if (piecesConflict(items[i], items[j], kerf)) { bad.add(i); bad.add(j) }
    }
  }
  return bad
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.w - 1 && a.x + a.w - 1 > b.x &&
         a.y < b.y + b.h - 1 && a.y + a.h - 1 > b.y
}

function SheetCanvas({ sheet, usableX, usableY, sheetL, sheetW, marginL, marginT, kerf, colorMap, details, onMove, interactive, showOffcuts, offcutMode, manualOffcuts, onManualOffcuts }) {
  const canvasRef = useRef(null)
  const draggingRef = useRef(null)
  // Масштаб карты — щипком двух пальцев (как в редакторе контура), с
  // фокусом в точке между пальцами, как при просмотре фотографии
  const [zoom, setZoom] = useState(1)
  const [pinching, setPinching] = useState(false)
  const wrapRef = useRef(null)
  const zoomRef = useRef(1)
  zoomRef.current = zoom
  const anchorRef = useRef(null) // { fracX, fracY, midX, midY } — точка листа под пальцами
  const pinchRef = useRef({ active: false, dist: 0, zoom: 1 })
  // СИСТЕМА КООРДИНАТ. Во ВСЕХ данных раскроя (placed, freeRects, ручные
  // обрезки, DXF) Y отсчитывается ВВЕРХ от низа рабочей зоны — как в DXF/CAD.
  // Контур polygon (Y вверх, как в редакторе) кладётся в ту же ось без
  // переворота: именно так true-shape укладка проверяла пересечения и
  // вложение деталей друг в друга. Канвас рисует «сверху вниз», поэтому внутри
  // SheetCanvas все координаты по Y переводятся в экранные (от верха) на входе
  // и обратно на выходе (onMove / onManualOffcuts). Сохранённые данные при этом
  // не меняются. Преобразование — инволюция: применённое дважды даёт исходное.
  const flipY = list => list.map(p => ({ ...p, y: usableY - p.y - (p.h - kerf) }))
  const flipRects = list => (list || []).map(o => ({ ...o, y: usableY - o.y - o.h }))
  // Обрезок, стороной касающийся края рабочей зоны, продолжается до
  // ФИЗИЧЕСКОГО края листа (на размер отступа от кромки): его потом отрезают
  // по тем же резам. Прямоугольник — в экранных координатах (Y сверху вниз).
  const marginR = sheetW - usableX - marginL
  const marginB = sheetL - usableY - marginT
  function extendToSheetEdge(r) {
    const e = 0.5
    let { x, y, w, h } = r
    const atL = x <= e, atR = x + w >= usableX - e, atT = y <= e, atB = y + h >= usableY - e
    if (atL) { x -= marginL; w += marginL }
    if (atR) w += marginR
    if (atT) { y -= marginT; h += marginT }
    if (atB) h += marginB
    return { ...r, x, y, w, h }
  }
  const placedRef = useRef(sheet.placed)
  const lastTap = useRef({ idx: -1, time: 0 })
  const lastTouchRef = useRef(0) // время последнего touch-события: браузер после касания шлёт ещё и эмулированные mouse-события
  const longPressRef = useRef(null)

  // useLayoutEffect: при смене масштаба холст пересоздаётся — перерисовываем
  // до показа на экране, чтобы не мигал пустым
  useLayoutEffect(() => {
    placedRef.current = flipY(sheet.placed)
    redraw(placedRef.current)
  }, [sheet.placed, showOffcuts, offcutMode, manualOffcuts, zoom, pinching])

  const PADDING = 8
  const canvasW = (typeof window !== 'undefined' ? Math.min(window.innerWidth - 32, 480) : 360) * zoom
  const sc = (canvasW - PADDING * 2) / sheetW
  const canvasH = Math.round(sc * sheetL) + PADDING * 2
  // При увеличении холст большой — ограничиваем плотность пикселей, чтобы не упереться в лимит памяти телефона
  const DPR = pinching ? 1 : Math.min(typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1, Math.sqrt(12e6 / (canvasW * canvasH)))

  const toC = v => v * sc
  const fromC = v => v / sc

  function redraw(items, dragIdx = -1) {
    const canvas = canvasRef.current
    if (!canvas) return
    if (canvas.width !== Math.round(canvasW * DPR) || canvas.height !== Math.round(canvasH * DPR)) {
      canvas.width = Math.round(canvasW * DPR)
      canvas.height = Math.round(canvasH * DPR)
    }
    const ctx = canvas.getContext('2d')
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
    ctx.clearRect(0, 0, canvasW, canvasH)

    // Фон листа
    ctx.fillStyle = '#F1EFE8'
    ctx.fillRect(0, 0, canvasW, canvasH)

    // Рабочая зона: X=usableX (горизонталь), Y=usableY (вертикаль)
    const rx = PADDING + toC(marginL), ry = PADDING + toC(marginT)
    const rw = toC(usableX), rh = toC(usableY)
    ctx.fillStyle = '#fff'
    ctx.fillRect(rx, ry, rw, rh)

    // Обрезки, выбранные вручную (удержанием пальца) — деловые обрезки,
    // можно выбрать несколько; повторное удержание на уже выбранном — снимает его
    if (showOffcuts && (offcutMode === 'manual' || offcutMode === 'cuts') && manualOffcuts && manualOffcuts.length) {
      flipRects(manualOffcuts).forEach(o => {
        const ox = rx + toC(o.x), oy = ry + toC(o.y)
        const ow = toC(o.w), oh = toC(o.h)
        ctx.fillStyle = 'rgba(230,126,34,0.14)'
        ctx.fillRect(ox, oy, ow, oh)
        ctx.strokeStyle = '#B85C00'
        ctx.lineWidth = 1.5
        ctx.strokeRect(ox, oy, ow, oh)
        ctx.fillStyle = '#B85C00'
        ctx.font = `bold ${Math.max(9, Math.min(11, ow / 8))}px sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(`${o.h}×${o.w}`, ox + ow / 2, oy + oh / 2)
      })
    }

    // Детали — заливка/контур/кромка/присадка. Подписи рисуются ОТДЕЛЬНЫМ
    // проходом ниже: при плотной укладке (детали реально соприкасаются друг
    // с другом, не просто стоят в клетках сетки с запасом) деталь,
    // нарисованная позже, может закрасить своей заливкой подпись соседней,
    // нарисованной раньше — раньше это было незаметно, пока детали не
    // начали по-настоящему стыковаться вплотную.
    const conflicts = conflictSet(items, kerf, usableX, usableY)
    items.forEach((p, i) => {
      // p.x,p.w = X-координаты; p.y,p.h = Y-координаты
      const x = rx + toC(p.x), y = ry + toC(p.y)
      const w = toC(p.w) - toC(kerf), h = toC(p.h) - toC(kerf)
      const isDragging = i === dragIdx

      // Проверяем коллизии (по полигону, если есть — bbox слишком грубый для
      // true-shape деталей, уложенных вплотную в паз соседней)
      const hasCollision = conflicts.has(i)

      // Деталь — если есть реальный контур (true-shape нестинг для фрезера),
      // рисуем именно его; иначе — прямоугольник, как раньше
      const hasShape = Array.isArray(p.polygon) && p.polygon.length > 2
      const baseFill = PART_FILL
      ctx.fillStyle = hasCollision ? 'rgba(226,75,74,0.35)' : (isDragging ? 'rgba(24,95,165,0.12)' : baseFill)
      ctx.strokeStyle = hasCollision ? '#E24B4A' : PART_STROKE
      ctx.lineWidth = hasCollision ? 2.5 : 1.4
      if (hasShape) {
        ctx.beginPath()
        p.polygon.forEach((pt, vi) => {
          const sx = x + pt.x * sc, sy = y + h - pt.y * sc
          if (vi === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy)
        })
        ctx.closePath()
        ctx.fill()
        ctx.stroke()
      } else {
        ctx.fillRect(x, y, w, h)
        ctx.strokeRect(x, y, w, h)
      }

      // Кромка — рисуется НЕ по самому контуру, а с небольшим отступом внутрь,
      // чтобы контур детали и линия кромки не сливались, но было видно, на
      // какой стороне кромка
      ctx.strokeStyle = EDGE_COLOR
      ctx.lineWidth = 2
      const g = EDGE_GAP
      if (p.edgeTop) { ctx.beginPath(); ctx.moveTo(x + g, y + g); ctx.lineTo(x + w - g, y + g); ctx.stroke() }
      if (p.edgeBottom) { ctx.beginPath(); ctx.moveTo(x + g, y + h - g); ctx.lineTo(x + w - g, y + h - g); ctx.stroke() }
      if (p.edgeLeft) { ctx.beginPath(); ctx.moveTo(x + g, y + g); ctx.lineTo(x + g, y + h - g); ctx.stroke() }
      if (p.edgeRight) { ctx.beginPath(); ctx.moveTo(x + w - g, y + g); ctx.lineTo(x + w - g, y + h - g); ctx.stroke() }

      // Присадка — реальные точки сверления детали, повёрнутые вместе с ней
      const detail = details && details[p.detailIndex]
      if (detail && detail.contour) {
        let contour = detail._parsedContour
        if (contour === undefined) {
          try { contour = detail.contour ? JSON.parse(detail.contour) : null } catch { contour = null }
          detail._parsedContour = contour
        }
        if (contour) {
          const panelW = Number(detail.width) || 0   // X, "родная" ориентация
          const panelH = Number(detail.length) || 0  // Y, "родная" ориентация
          const pts = getAllDrillPoints(contour, panelW, panelH)
          if (pts.length) {
            const times = Math.round((p.rotation ?? (p.rotated ? 90 : 0)) / 90)
            ctx.fillStyle = '#6A4A17'
            pts.forEach(pt => {
              // Точка в "родной" ориентации детали → в текущей (с учётом поворота на листе, 0/90/180/270)
              const { x: fx, y: fy } = rotatePointTimes(pt.x, pt.y, panelW, panelH, times)
              const sx = x + fx * sc
              const sy = y + h - fy * sc
              const r = Math.max(1.3, (pt.d || 8) * sc / 2)
              ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill()
            })
          }
        }
      }
    })

    // Подписи — отдельным проходом ПОСЛЕ всех заливок, чтобы заливка
    // соседней (плотно прилегающей) детали не закрашивала уже нарисованный
    // текст.
    items.forEach(p => {
      const x = rx + toC(p.x), y = ry + toC(p.y)
      const w = toC(p.w) - toC(kerf), h = toC(p.h) - toC(kerf)
      const hasShape = Array.isArray(p.polygon) && p.polygon.length > 2

      // Метка — точка для подписи ищется на самом материале, а не в центре
      // габарита: для детали с вырезом центр габарита может попасть прямо в
      // пустой паз (не на деталь). Если есть контур — берём центр масс
      // полигона, а если он (из-за вогнутости) оказался вне детали —
      // берём середину самого широкого отрезка материала по центральной
      // горизонтали.
      let labelLX = w / (2 * sc), labelLY = h / (2 * sc) // локальные мм-координаты (0..origX, 0..origY), по умолчанию — центр габарита
      if (hasShape) {
        let cx = 0, cy = 0
        p.polygon.forEach(pt => { cx += pt.x; cy += pt.y })
        cx /= p.polygon.length; cy /= p.polygon.length
        if (pointInPolygon({ x: cx, y: cy }, p.polygon)) {
          labelLX = cx; labelLY = cy
        } else {
          const scanY = p.origY / 2
          const seg = widestSegmentAtY(p.polygon, scanY)
          if (seg) { labelLX = (seg[0] + seg[1]) / 2; labelLY = scanY }
        }
      }
      const lx = x + labelLX * sc, ly = y + h - labelLY * sc

      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'

      // Название детали — в центре
      ctx.fillStyle = 'rgba(0,0,0,0.6)'
      ctx.font = `${Math.max(7, Math.min(10, w / 7))}px sans-serif`
      const lbl = (p.prefix ? p.prefix.slice(0,3) + ' ' : '') + p.label.replace(/Деталь\s*/, 'Д')
      if (h > 14) ctx.fillText(lbl, lx, ly - (p.rotation ? 5 : 0))
      // Угол поворота — под названием, внутри контура детали
      if (p.rotation && h > 26) {
        ctx.fillStyle = 'rgba(0,0,0,0.45)'
        ctx.font = `${Math.max(6, Math.min(8, w / 9))}px sans-serif`
        ctx.fillText('↻' + p.rotation + '°', lx, ly + 6)
      }

      // Размеры — по сторонам: Ширина (X) вдоль верхней стороны,
      // Длина (Y) вдоль левой стороны (текст повёрнут вдоль стороны)
      ctx.fillStyle = 'rgba(0,0,0,0.7)'
      ctx.font = '8px sans-serif'
      const wTxt = String(Math.round(p.origX)), lTxt = String(Math.round(p.origY))
      const wPx = ctx.measureText(wTxt).width, lPx = ctx.measureText(lTxt).width
      if (hasShape) {
        // Фигурная деталь: размеры ставим на сам материал внутри контура
        const key = `${sc}|${wTxt}|${lTxt}`
        let cached = dimSpotCache.get(p.polygon)
        if (!cached || cached.key !== key) {
          cached = { key, spots: findDimSpots(p.polygon, p.origX, p.origY, wPx / sc, lPx / sc, 10 / sc) }
          dimSpotCache.set(p.polygon, cached)
        }
        const { top, left } = cached.spots
        if (top) ctx.fillText(wTxt, x + top.x * sc, y + h - top.y * sc)
        if (left) {
          ctx.save()
          ctx.translate(x + left.x * sc, y + h - left.y * sc)
          ctx.rotate(-Math.PI / 2)
          ctx.fillText(lTxt, 0, 0)
          ctx.restore()
        }
      } else {
        if (h > 16 && wPx < w - 6) ctx.fillText(wTxt, x + w / 2, y + 7)
        if (w > 16 && lPx < h - 6) {
          ctx.save()
          ctx.translate(x + 7, y + h / 2)
          ctx.rotate(-Math.PI / 2)
          ctx.fillText(lTxt, 0, 0)
          ctx.restore()
        }
      }
    })

    // Линии реза — по текущему расположению деталей (пересчитываются при
    // любом редактировании карты)
    if (showOffcuts && offcutMode === 'cuts') {
      const { lines, unsplit } = computeCutLines(items, usableX, usableY, kerf, flipRects(manualOffcuts || []))
      // Участки, которые нельзя разрезать насквозь (после ручной правки)
      unsplit.forEach(r => {
        ctx.strokeStyle = '#E24B4A'
        ctx.lineWidth = 1.2
        ctx.setLineDash([2, 3])
        ctx.strokeRect(rx + toC(r.x0), ry + toC(r.y0), toC(r.x1 - r.x0), toC(r.y1 - r.y0))
        ctx.setLineDash([])
      })
      ctx.strokeStyle = '#7B1FA2'
      ctx.lineWidth = 1.5
      ctx.setLineDash([6, 3])
      const ext = (a0, a1, lo, hi, mLo, mHi) => [a0 <= 0.5 ? a0 - mLo : a0, a1 >= hi - 0.5 ? a1 + mHi : a1]
      lines.forEach(l => {
        let x1, y1, x2, y2
        if (l.v) {
          const [ya, yb] = ext(l.from, l.to, 0, usableY, marginT, marginB)
          x1 = x2 = rx + toC(l.pos); y1 = ry + toC(ya); y2 = ry + toC(yb)
        } else {
          const [xa, xb] = ext(l.from, l.to, 0, usableX, marginL, marginR)
          y1 = y2 = ry + toC(l.pos); x1 = rx + toC(xa); x2 = rx + toC(xb)
        }
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke()
      })
      ctx.setLineDash([])
    }

    // Рамка: X=sheetW(горизонталь), Y=sheetL(вертикаль)
    ctx.strokeStyle = '#888780'
    ctx.lineWidth = 1
    ctx.setLineDash([])
    ctx.strokeRect(PADDING, PADDING, toC(sheetW), toC(sheetL))
  }

  function getPointer(e) {
    const rect = canvasRef.current.getBoundingClientRect()
    const scaleX = rect.width ? canvasW / rect.width : 1
    const touch = e.touches?.[0] || e.changedTouches?.[0] || e
    return {
      x: (touch.clientX - rect.left) * scaleX,
      y: (touch.clientY - rect.top) * scaleX
    }
  }

  function findPiece(cx, cy) {
    const items = placedRef.current
    const rx2 = PADDING + toC(marginL), ry2 = PADDING + toC(marginT)
    for (let i = items.length - 1; i >= 0; i--) {
      const p = items[i]
      const px = rx2 + toC(p.x), py = ry2 + toC(p.y)
      const pw = toC(p.w - kerf), ph = toC(p.h - kerf)
      if (cx >= px && cx <= px + pw && cy >= py && cy <= py + ph) {
        // Фигурная деталь (Г, П...): выбирается только сама деталь, а не
        // пустая часть внутри её габарита — там можно выбрать обрезок
        if (Array.isArray(p.polygon) && p.polygon.length > 2) {
          if (pointInPolygon({ x: fromC(cx - rx2), y: fromC(cy - ry2) }, absolutePoly(p, kerf))) return i
          continue
        }
        return i
      }
    }
    return -1
  }

  // Магнит: деталь притягивается к соседям и краям. Размеры p.w/p.h уже
  // включают ширину реза (kerf), поэтому стык "o.x + o.w" даёт зазор ровно
  // в kerf между видимыми контурами. Берём БЛИЖАЙШУЮ точку притяжения по
  // каждой оси, а к соседям притягиваемся только если они рядом по
  // перпендикулярной оси (иначе деталь "прилипала" к далёким).
  function applyMagnet(nx, ny, pw, ph, idx, items) {
    const SNAP = 50
    const pick = (val, cands) => {
      let best = val, bestD = SNAP
      for (const c of cands) {
        const d = Math.abs(val - c)
        if (d < bestD) { bestD = d; best = c }
      }
      return best
    }
    const cx = [0, usableX - pw], cy = [0, usableY - ph]
    for (let i = 0; i < items.length; i++) {
      if (i === idx) continue
      const o = items[i]
      const nearY = ny < o.y + o.h + SNAP && ny + ph > o.y - SNAP
      const nearX = nx < o.x + o.w + SNAP && nx + pw > o.x - SNAP
      if (nearY) cx.push(o.x + o.w, o.x - pw, o.x, o.x + o.w - pw)
      if (nearX) cy.push(o.y + o.h, o.y - ph, o.y, o.y + o.h - ph)
    }
    return { x: pick(nx, cx), y: pick(ny, cy) }
  }

  function clearLongPress() {
    if (longPressRef.current) { clearTimeout(longPressRef.current); longPressRef.current = null }
  }

  function onPointerDown(e) {
    if (!interactive) return
    const { x, y } = getPointer(e)
    const idx = findPiece(x, y)
    if (idx === -1) {
      // Пустое место на листе: в режиме "Вручную" удержание пальца задаёт
      // деловой обрезок, растущий из этой точки до ближайших деталей/краёв.
      // Удержание на уже выбранном обрезке — снимает именно его, остальные
      // выбранные обрезки не трогает.
      if (showOffcuts && offcutMode === 'manual' && onManualOffcuts) {
        clearLongPress()
        longPressRef.current = setTimeout(() => {
          const mx = fromC(x - (PADDING + toC(marginL)))
          const my = fromC(y - (PADDING + toC(marginT)))
          const list = manualOffcuts || []            // хранится в системе «Y от низа»
          const hitIdx = flipRects(list).findIndex(o => mx >= o.x && mx <= o.x + o.w && my >= o.y && my <= o.y + o.h)
          if (hitIdx !== -1) {
            onManualOffcuts(sheet.index, list.filter((_, i) => i !== hitIdx))
          } else {
            // Обрезок — честная заготовка: с каждой стороны, где он граничит
            // с деталью или другим обрезком, оставляем зазор на ширину реза
            // (kerf). У края листа зазора нет — там обрезок потом отрезают
            // по тем же резам.
            // Деталь: видимая часть — (w-kerf)×(h-kerf), справа и снизу зазор
            // уже входит в p.w/p.h, поэтому добавляем его слева и сверху.
            const busyParts = placedRef.current.flatMap(p => partObstacles(p, kerf))
            // Ранее выбранные обрезки — такая же занятая часть листа, зазор со всех сторон
            const taken = flipRects(list).map(o => ({ x: o.x - kerf, y: o.y - kerf, w: o.w + 2 * kerf, h: o.h + 2 * kerf }))
            const rect = computeOffcutAtPoint(mx, my, [...busyParts, ...taken], usableX, usableY)
            if (rect) onManualOffcuts(sheet.index, [...list, flipRects([extendToSheetEdge(rect)])[0]])
          }
        }, LONG_PRESS_MS)
      }
      return
    }
    e.preventDefault()
    const p = placedRef.current[idx]
    const wasConflict = conflictSet(placedRef.current, kerf, usableX, usableY).has(idx)
    const drag = { idx, startX: x, startY: y, origX: p.x, origY: p.y, wasConflict, active: false, moved: false, startTime: Date.now() }
    draggingRef.current = drag
    // Двигать деталь можно только после удержания пальца на ней
    clearLongPress()
    longPressRef.current = setTimeout(() => {
      longPressRef.current = null
      if (draggingRef.current === drag && !drag.moved) {
        drag.active = true
        if (navigator.vibrate) navigator.vibrate(15)
        redraw(placedRef.current, idx) // подсветить: деталь "взята"
      }
    }, DRAG_HOLD_MS)
  }

  function onPointerMove(e) {
    if (!draggingRef.current) {
      clearLongPress()
      return
    }
    e.preventDefault()
    const { x, y } = getPointer(e)
    const drag0 = draggingRef.current
    if (!drag0.active) {
      // Ещё не удержали — палец уехал: это не перетаскивание, отменяем
      if (Math.hypot(x - drag0.startX, y - drag0.startY) > 16) { drag0.moved = true; clearLongPress() }
      return
    }
    const { idx, startX, startY, origX, origY } = drag0
    const p = placedRef.current[idx]
    const dx = fromC(x - startX), dy = fromC(y - startY)
    let nx = Math.max(0, Math.min(usableX - p.w, origX + dx))
    let ny = Math.max(0, Math.min(usableY - p.h, origY + dy))
    const snapped = applyMagnet(nx, ny, p.w, p.h, idx, placedRef.current)
    // Точный магнит по контуру для фигурных деталей: зазор ровно kerf, в том числе внутри Г-образной
    const refined = snapPolygonGap(p, snapped.x, snapped.y, placedRef.current, idx, kerf, 50)
    nx = Math.max(0, Math.min(usableX - p.w, refined.x))
    ny = Math.max(0, Math.min(usableY - p.h, refined.y))
    const updated = placedRef.current.map((item, i) => i === idx ? { ...item, x: nx, y: ny } : item)
    placedRef.current = updated
    redraw(updated, idx)
  }

  function onPointerUp(e) {
    clearLongPress()
    const drag = draggingRef.current
    if (!drag) return
    const { x, y } = getPointer(e)
    const dist = Math.hypot(x - drag.startX, y - drag.startY)

    if (!drag.active && !drag.moved && dist < 8 && interactive && (Date.now() - drag.startTime) < DRAG_HOLD_MS) {
      const now = Date.now()
      const isDoubleTap = lastTap.current.idx === drag.idx && (now - lastTap.current.time) < 400
      lastTap.current = { idx: drag.idx, time: now }
      if (isDoubleTap) {
        const p = placedRef.current[drag.idx]
        const newRotation = ((p.rotation ?? (p.rotated ? 90 : 0)) + 90) % 360
        const edges = rotateEdgesTimes({ top: p.edgeTop, right: p.edgeRight, bottom: p.edgeBottom, left: p.edgeLeft }, 1)
        const rotated = {
          ...p, w: p.h, h: p.w,
          origX: p.origY, origY: p.origX,
          rotation: newRotation, rotated: newRotation === 90 || newRotation === 270,
          edgeTop: edges.top, edgeRight: edges.right, edgeBottom: edges.bottom, edgeLeft: edges.left,
          polygon: Array.isArray(p.polygon) ? p.polygon.map(pt => rotatePointTimes(pt.x, pt.y, p.origX, p.origY, 1)) : p.polygon,
        }
        // Поворот разрешён всегда. Если после поворота деталь пересекается
        // с соседями или выходит за лист — она подсветится красным, и
        // пользователь сам сдвинет её.
        const updated = placedRef.current.map((item, i) => i === drag.idx ? rotated : item)
        placedRef.current = updated
        redraw(updated)
        if (onMove) onMove(sheet.index, flipY(updated))
        draggingRef.current = null
        return
      }
    }

    // Это было касание/скольжение без удержания — деталь не двигаем
    if (!drag.active) {
      draggingRef.current = null
      redraw(placedRef.current)
      return
    }

    // Проверяем коллизии — если есть, возвращаем на место (по полигону, а не
    // по прямоугольнику — см. причину выше)
    const p = placedRef.current[drag.idx]
    const hasCollision = placedRef.current.some((o, j) => j !== drag.idx &&
      piecesConflict(p, o, kerf))

    // Возвращаем на место только если до перетаскивания деталь стояла
    // корректно. Если она уже была "в красном" (после поворота) — оставляем
    // где отпустили, красная подсветка покажет, что конфликт остался.
    if (hasCollision && !drag.wasConflict) {
      const restored = placedRef.current.map((item, i) => i === drag.idx ? { ...item, x: drag.origX, y: drag.origY } : item)
      placedRef.current = restored
      redraw(restored)
      if (onMove) onMove(sheet.index, flipY(restored))
    } else {
      redraw(placedRef.current)
      if (onMove) onMove(sheet.index, flipY(placedRef.current))
    }
    draggingRef.current = null
  }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    redraw(placedRef.current)
  }, [])

  // При увеличении холст прокручивается пальцем. Когда деталь "взята"
  // (удержание), скольжение должно двигать деталь, а не прокручивать —
  // для этого нужен не-passive слушатель touchmove.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const block = e => { if (draggingRef.current?.active && e.cancelable) e.preventDefault() }
    canvas.addEventListener('touchmove', block, { passive: false })
    return () => canvas.removeEventListener('touchmove', block)
  }, [])

  // Pinch-zoom двумя пальцами
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const st = pinchRef.current
    const dist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)
    const setAnchor = (t, fresh) => {
      const cv = canvasRef.current
      if (!cv) return
      const wr = el.getBoundingClientRect()
      const midX = (t[0].clientX + t[1].clientX) / 2 - wr.left
      const midY = (t[0].clientY + t[1].clientY) / 2 - wr.top
      if (fresh || !anchorRef.current) {
        anchorRef.current = {
          fracX: (el.scrollLeft + midX) / (cv.offsetWidth || 1),
          fracY: (el.scrollTop + midY) / (cv.offsetHeight || 1), midX, midY,
        }
      } else { anchorRef.current.midX = midX; anchorRef.current.midY = midY }
    }
    const applyAnchor = () => {
      const a = anchorRef.current, cv = canvasRef.current
      if (!a || !cv) return
      el.scrollLeft = Math.max(0, a.fracX * cv.offsetWidth - a.midX)
      el.scrollTop = Math.max(0, a.fracY * cv.offsetHeight - a.midY)
    }
    const onStart = e => {
      if (e.touches.length !== 2) return
      st.active = true
      st.dist = dist(e.touches)
      st.zoom = zoomRef.current
      // второй палец — это не перетаскивание детали и не выбор обрезка
      if (longPressRef.current) { clearTimeout(longPressRef.current); longPressRef.current = null }
      draggingRef.current = null
      setPinching(true)
      setAnchor(e.touches, true)
    }
    const onMove = e => {
      if (!st.active || e.touches.length !== 2) return
      if (e.cancelable) e.preventDefault()
      if (st.dist <= 0) return
      let nz = Math.max(1, Math.min(4, st.zoom * dist(e.touches) / st.dist))
      if (nz < 1.04) nz = 1
      setAnchor(e.touches, false)
      if (Math.abs(nz - zoomRef.current) < 0.001) applyAnchor() // только сдвиг двумя пальцами
      else setZoom(nz)
    }
    const onEnd = e => {
      if (e.touches.length < 2 && st.active) {
        st.active = false
        setPinching(false)
        setTimeout(() => { anchorRef.current = null }, 150)
      }
    }
    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd, { passive: true })
    el.addEventListener('touchcancel', onEnd, { passive: true })
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onEnd)
    }
  }, [])

  // После смены масштаба возвращаем под пальцы ту же точку листа
  useLayoutEffect(() => {
    const a = anchorRef.current, el = wrapRef.current, cv = canvasRef.current
    if (!a || !el || !cv) return
    el.scrollLeft = Math.max(0, a.fracX * cv.offsetWidth - a.midX)
    el.scrollTop = Math.max(0, a.fracY * cv.offsetHeight - a.midY)
  }, [zoom])

  return (
    <div style={{ position: 'relative' }}>
      <div ref={wrapRef}
        style={{ overflow: zoom > 1 ? 'auto' : 'visible', maxHeight: zoom > 1 ? '70vh' : 'none', borderRadius: 8 }}>
        <canvas ref={canvasRef} width={Math.round(canvasW * DPR)} height={Math.round(canvasH * DPR)}
          style={{ width: canvasW, height: canvasH, maxWidth: zoom > 1 ? 'none' : '100%', borderRadius: 8, display: 'block', touchAction: interactive ? (zoom > 1 ? 'pan-x pan-y' : 'none') : 'auto' }}
          onMouseDown={e => { if (Date.now() - lastTouchRef.current < 800) return; onPointerDown(e) }}
          onMouseMove={e => { if (Date.now() - lastTouchRef.current < 800) return; onPointerMove(e) }}
          onMouseUp={e => { if (Date.now() - lastTouchRef.current < 800) return; onPointerUp(e) }}
          onTouchStart={e => { lastTouchRef.current = Date.now(); if (e.touches.length > 1) return; onPointerDown(e) }}
          onTouchMove={e => { lastTouchRef.current = Date.now(); if (e.touches.length > 1) return; onPointerMove(e) }}
          onTouchEnd={e => { lastTouchRef.current = Date.now(); onPointerUp(e) }}
          onTouchCancel={() => { clearLongPress(); draggingRef.current = null }}
        />
      </div>
      {zoom > 1.02 && (
        <button type="button" onClick={() => { setZoom(1); if (wrapRef.current) { wrapRef.current.scrollLeft = 0; wrapRef.current.scrollTop = 0 } }}
          style={{ position: 'absolute', top: 6, right: 6, fontSize: 10, padding: '3px 8px', border: '0.5px solid var(--border-md)',
            borderRadius: 6, background: 'rgba(255,255,255,0.92)', color: 'var(--text-muted)', cursor: 'pointer' }}>
          {Math.round(zoom * 100)}% · сброс
        </button>
      )}
    </div>
  )
}

export default function NestingPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [order, setOrder] = useState(null)
  const [details, setDetails] = useState([])
  const [result, setResult] = useState(null)
  const [running, setRunning] = useState(false)
  const [nestError, setNestError] = useState('')
  const [elapsedSec, setElapsedSec] = useState(0)
  const [showDebugExport, setShowDebugExport] = useState(false)
  const [copyStatus, setCopyStatus] = useState('')
  const [showResultExport, setShowResultExport] = useState(false)
  const [resultCopyStatus, setResultCopyStatus] = useState('')
  const [activeSheet, setActiveSheet] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [sheetsData, setSheetsData] = useState([])
  const [nestDir, setNestDir] = useState('auto')
  const [cuttingMethod, setCuttingMethod] = useState('nesting')
  const [showOffcuts, setShowOffcuts] = useState(false)
  const [offcutMode, setOffcutMode] = useState('manual') // 'manual' | 'cuts'
  const [smallPartsToCenter, setSmallPartsToCenter] = useState(false)
  const [smallPartsMaxSquareSideMm, setSmallPartsMaxSquareSideMm] = useState('') // мм, заполнится глобальным дефолтом заказа
  const [smallPartsMaxSideMm, setSmallPartsMaxSideMm] = useState('')   // мм, заполнится глобальным дефолтом заказа
  const [optimizeSeconds, setOptimizeSeconds] = useState('')          // сек, заполнится глобальным дефолтом заказа

  const colorMap = {}
  details.forEach((d, i) => { colorMap[i] = COLORS[i % COLORS.length] })

  useEffect(() => { fetchOrder() }, [id])

  async function fetchOrder() {
    const { data: o } = await supabase.from('orders').select('*').eq('id', id).single()
    const { data: d } = await supabase.from('order_details').select('*').eq('order_id', id).order('sort_order')
    setOrder(o); setDetails(d || [])
    if (o) {
      setSmallPartsToCenter(!!o.small_parts_to_center)
      setSmallPartsMaxSquareSideMm(o.small_parts_max_square_side ? String(o.small_parts_max_square_side) : '')
      setSmallPartsMaxSideMm(o.small_parts_max_side ? String(o.small_parts_max_side) : '')
      setOptimizeSeconds(o.optimize_seconds != null ? String(o.optimize_seconds) : '12')
      setCuttingMethod(o.cutting_method || 'nesting')
    }
    if (o?.nesting_result) {
      const saved = JSON.parse(o.nesting_result)
      setResult(saved); setSheetsData(saved.sheets)
    }
  }

  async function doNesting() {
    if (!details.length || !order) return
    setRunning(true)
    setNestError('')
    setElapsedSec(0)
    const timerId = setInterval(() => setElapsedSec(s => s + 1), 1000)
    // Вернулись на старый растровый алгоритм по умолчанию — NFP пока хуже
    // укладывает обычные прямоугольные детали и, что важно, не должен был
    // вообще касаться форматно-раскроечного станка (это отдельно исправлено
    // в nesting.js). ?nfp=1 — намеренно прогнать ЭТОТ заказ через NFP для
    // сравнения (имеет смысл только для фрезера, не для гильотины).
    const useNfp = new URLSearchParams(window.location.search).get('nfp') === '1'
    setTimeout(async () => {
      try {
        const res = await runNesting({
          details, direction: nestDir,
          sheetL: order.sheet_length, sheetW: order.sheet_width,
          marginT: order.margin_top, marginR: order.margin_right,
          marginB: order.margin_bottom, marginL: order.margin_left,
          kerf: order.kerf_width,
          smallPartsToCenter,
          smallPartsMaxSquareSide: smallPartsMaxSquareSideMm === '' ? 0 : Number(smallPartsMaxSquareSideMm),
          smallPartsMaxSide: smallPartsMaxSideMm === '' ? 0 : Number(smallPartsMaxSideMm),
          optimizeSeconds: optimizeSeconds === '' ? 12 : Number(optimizeSeconds),
          cuttingMethod,
          algo: useNfp ? 'nfp' : 'raster',
        })
        res.algoVersion = NESTING_VERSION // версия алгоритма запишется вместе с результатом
        setResult(res)
        setSheetsData(res.sheets.map(s => ({ ...s, freeRects: s.freeRects || [] })))
        setActiveSheet(0)
      } catch (err) {
        console.error('Ошибка раскроя:', err)
        setNestError('Не удалось выполнить раскрой: ' + (err?.message || 'неизвестная ошибка') + '. Попробуйте ещё раз или уменьшите время оптимизации.')
      } finally {
        setRunning(false)
        clearInterval(timerId)
      }
    }, 100)
  }

  async function saveSmallPartsSettings(patch) {
    await supabase.from('orders').update(patch).eq('id', id)
  }

  async function saveNesting() {
    if (!result) return
    const toSave = { ...result, sheets: sheetsData }
    await supabase.from('orders').update({ nesting_result: JSON.stringify(toSave) }).eq('id', id)
  }

  async function submitOrder() {
    setSubmitting(true)
    await saveNesting()
    await supabase.from('orders').update({ status: 'new', submitted_at: new Date().toISOString() }).eq('id', id)
    navigate(`/orders/${id}`)
  }

  function onMove(sheetIdx, newPlaced) {
    setSheetsData(prev => prev.map((s, i) => i === sheetIdx ? { ...s, placed: newPlaced } : s))
  }

  function onManualOffcuts(sheetIdx, list) {
    setSheetsData(prev => prev.map((s, i) => i === sheetIdx ? { ...s, manualOffcuts: list } : s))
  }

  const debugExportText = JSON.stringify(
    details.filter(d => d.contour).map(d => ({
      name: d.display_name || d.name, width: d.width, length: d.length, qty: d.qty, rotatable: d.rotatable,
      contour: (() => { try { return JSON.parse(d.contour) } catch { return d.contour } })(),
    })),
    null, 2
  )
  async function copyDebugExport() {
    try {
      await navigator.clipboard.writeText(debugExportText)
      setCopyStatus('Скопировано ✓')
    } catch {
      setCopyStatus('Не удалось скопировать — выделите текст вручную')
    }
    setTimeout(() => setCopyStatus(''), 2500)
  }

  // Экспорт РЕЗУЛЬТАТА укладки — не что было на входе, а что реально сейчас
  // разложено на листах (координаты, поворот, точный полигон каждой детали).
  // Именно это нужно смотреть, если входные контуры верны, а на экране всё
  // равно видно пересечение или неплотную укладку — тут видно ТОЧНО то,
  // что сейчас показывает карта раскроя.
  const resultExportText = JSON.stringify({
    usableX: result?.usableX, usableY: result?.usableY,
    sheetsCount: sheetsData.length,
    sheets: sheetsData.map(s => ({
      index: s.index,
      placed: s.placed.map(p => ({
        detailIndex: p.detailIndex, label: p.label, prefix: p.prefix,
        x: p.x, y: p.y, w: p.w, h: p.h, origX: p.origX, origY: p.origY,
        rotated: p.rotated, rotation: p.rotation,
        polygon: p.polygon,
      })),
    })),
  }, null, 2)
  async function copyResultExport() {
    try {
      await navigator.clipboard.writeText(resultExportText)
      setResultCopyStatus('Скопировано ✓')
    } catch {
      setResultCopyStatus('Не удалось скопировать — выделите текст вручную')
    }
    setTimeout(() => setResultCopyStatus(''), 2500)
  }

  // Скачать DXF раскроя — все листы в ряд, чтобы визуально сравнить с
  // эталонным DXF: контур листа и контур каждой детали настоящими линиями
  // (полигон уже с сэмплированными дугами/радиусами, если они есть), плюс
  // подписи. Так пересечение/неплотная укладка видны глазами в любом
  // CAD-просмотрщике, а не только по цифрам.
  function downloadNestingDxf() {
    const dxf = buildNestingDxf(sheetsData, order)
    const blob = new Blob([dxf], { type: 'application/dxf' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${order.order_number || 'raskroy'}.dxf`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  // ─── Экспорт РЕЗУЛЬТАТА раскроя в DXF — не пересчитанная заново геометрия,
  // а РОВНО то, что сейчас лежит в sheetsData (те же координаты, что и на
  // экране): если детали накладываются друг на друга, это будет видно и в
  // DXF, открытом в любой CAD-программе — сверка "как есть" против образца.
  function polygonToDxfEntity(points, layer) {
    let s = `0\r\nLWPOLYLINE\r\n8\r\n${layer}\r\n90\r\n${points.length}\r\n70\r\n1\r\n`
    points.forEach(([x, y]) => { s += `10\r\n${x.toFixed(2)}\r\n20\r\n${y.toFixed(2)}\r\n` })
    return s
  }
  function textToDxfEntity(text, x, y, height, layer) {
    return `0\r\nTEXT\r\n8\r\n${layer}\r\n10\r\n${x.toFixed(2)}\r\n20\r\n${y.toFixed(2)}\r\n40\r\n${height.toFixed(2)}\r\n1\r\n${text}\r\n`
  }
  function buildSheetDxf(sheetIdx) {
    const sheet = sheetsData[sheetIdx]
    if (!sheet || !order) return ''
    const sheetW = order.sheet_width, sheetL = order.sheet_length, kerf = order.kerf_width || 0
    let entities = polygonToDxfEntity([[0, 0], [sheetW, 0], [sheetW, sheetL], [0, sheetL]], 'sheet')
    sheet.placed.forEach(p => {
      const hasShape = Array.isArray(p.polygon) && p.polygon.length > 2
      // Система координат — как у укладки (trueShapeNesting): Y вверх от низа
      // рабочей зоны, контур polygon кладётся БЕЗ переворота; плюс отступы
      // листа (левый и нижний). Канвас переводит в экранные координаты сам
      // (см. flipY в SheetCanvas), поэтому экран и DXF показывают одно и то же.
      const ox = Number(order.margin_left) || 0, oy = Number(order.margin_bottom) || 0
      const poly = hasShape
        ? p.polygon.map(pt => [ox + p.x + pt.x, oy + p.y + pt.y])
        : (() => { const w = p.w - kerf, h = p.h - kerf; return [[ox + p.x, oy + p.y], [ox + p.x + w, oy + p.y], [ox + p.x + w, oy + p.y + h], [ox + p.x, oy + p.y + h]] })()
      entities += polygonToDxfEntity(poly, 'detal')

      // Подпись — та же логика, что и на карте (по контуру детали, не по
      // центру габарита, чтобы не попасть в пустой паз у криволинейной детали)
      let labelLX = p.origX / 2, labelLY = p.origY / 2
      if (hasShape) {
        let cx = 0, cy = 0
        p.polygon.forEach(pt => { cx += pt.x; cy += pt.y })
        cx /= p.polygon.length; cy /= p.polygon.length
        if (pointInPolygon({ x: cx, y: cy }, p.polygon)) { labelLX = cx; labelLY = cy }
        else {
          const scanY = p.origY / 2
          const seg = widestSegmentAtY(p.polygon, scanY)
          if (seg) { labelLX = (seg[0] + seg[1]) / 2; labelLY = scanY }
        }
      }
      const label = ((p.prefix ? p.prefix + ' ' : '') + (p.label || '').replace(/Деталь\s*/, 'Д') + ` ${Math.round(p.origY)}x${Math.round(p.origX)}`).trim()
      const textHeight = Math.max(15, Math.min(40, Math.min(p.origX, p.origY) / 8))
      // Тот же переворот по Y, что и у контура выше — иначе подпись у
      // контурных деталей уедет не туда (для прямоугольных labelLY=origY/2,
      // переворот не меняет результат, поэтому там расхождения не было).
      entities += textToDxfEntity(label, ox + p.x + labelLX, oy + p.y + labelLY, textHeight, 'Solid Edge 2D NestingPartName')
    })
    return `0\r\nSECTION\r\n2\r\nHEADER\r\n9\r\n$ACADVER\r\n1\r\nAC1009\r\n0\r\nENDSEC\r\n`
      + `0\r\nSECTION\r\n2\r\nENTITIES\r\n${entities}0\r\nENDSEC\r\n0\r\nEOF\r\n`
  }
  function downloadSheetDxf(sheetIdx) {
    const content = buildSheetDxf(sheetIdx)
    if (!content) return
    const blob = new Blob([content], { type: 'application/dxf' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${order?.order_number || 'раскрой'}_лист${sheetIdx + 1}.dxf`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  if (!order) return <div className="page"><p style={{ color: 'var(--text-hint)', paddingTop: 40, textAlign: 'center' }}>Загрузка...</p></div>

  const totalQty = details.reduce((s, d) => s + (Number(d.qty) || 1), 0)
  const edgeByType = details.reduce((acc, d) => {
    const qty = Number(d.qty) || 1
    const add = (name, len) => {
      if (!name || name === 'false') return
      const k = name === 'default' ? 'Кромка' : name
      acc[k] = (acc[k] || 0) + len * qty
    }
    add(d.edge_top, d.length / 1000); add(d.edge_bottom, d.length / 1000)
    add(d.edge_left, d.width / 1000); add(d.edge_right, d.width / 1000)
    return acc
  }, {})
  const totalEdge = Object.values(edgeByType).reduce((s, v) => s + v, 0)
  const sheetsCount = sheetsData.length
  const usableArea = result ? (result.usableW / 1000) * (result.usableH / 1000) : 0
  const totalArea = sheetsCount * usableArea

  return (
    <div className="page" style={{ paddingBottom: 100 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, paddingTop: 8 }}>
        <button onClick={() => navigate(`/orders/${id}`)}
          style={{ background: 'none', border: 'none', color: 'var(--blue)', fontSize: 22, padding: 0, cursor: 'pointer' }}>←</button>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 500 }}>Раскрой</div>
          <div style={{ fontSize: 12, color: 'var(--text-hint)', fontFamily: 'monospace' }}>{order.order_number}</div>
        </div>
      </div>

      {/* Статистика */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
        {[['Листов', sheetsCount || '—'],['Деталей', totalQty],['Кромка (п.м.)', totalEdge.toFixed(1)],['Площадь (м²)', totalArea ? totalArea.toFixed(2) : '—']].map(([label, val]) => (
          <div key={label} style={{ background: 'var(--bg2)', borderRadius: 'var(--radius)', padding: '10px 12px' }}>
            <div style={{ fontSize: 11, color: 'var(--text-hint)' }}>{label}</div>
            <div style={{ fontSize: 20, fontWeight: 500, marginTop: 2 }}>{val}</div>
          </div>
        ))}
      </div>

      {/* Кромка по типам */}
      {Object.keys(edgeByType).length > 0 && (
        <div className="card" style={{ marginBottom: 12 }}>
          <p className="section-title">Метраж кромки</p>
          {Object.entries(edgeByType).map(([name, len]) => (
            <div key={name} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '0.5px solid var(--border)' }}>
              <span style={{ fontSize: 13 }}>{name}</span>
              <span style={{ fontSize: 13, fontWeight: 500 }}>{len.toFixed(1)} п.м.</span>
            </div>
          ))}
        </div>
      )}

      {/* Тип станка */}
      <div style={{ marginBottom: 12 }}>
        <p className="section-title">Станок</p>
        <div style={{ display: 'flex', gap: 8 }}>
          {[['nesting', 'Фрезер (ЧПУ)'], ['guillotine', 'Форматно-раскроечный (пила)']].map(([val, label]) => (
            <div key={val} onClick={() => { setCuttingMethod(val); saveSmallPartsSettings({ cutting_method: val }) }}
              style={{ flex: 1, padding: '8px 6px', borderRadius: 'var(--radius)', textAlign: 'center',
                fontSize: 13, cursor: 'pointer',
                background: cuttingMethod === val ? 'var(--blue)' : 'var(--bg2)',
                color: cuttingMethod === val ? 'white' : 'var(--text-muted)', fontWeight: cuttingMethod === val ? 500 : 400 }}>
              {label}
            </div>
          ))}
        </div>
        <p style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 4 }}>
          {cuttingMethod === 'guillotine'
            ? 'Только сквозные резы через весь лист/полосу — раскладка гарантированно режется на пиле.'
            : 'Свободная укладка без ограничения на сквозной рез — для резки фрезой по любому контуру.'}
        </p>
      </div>

      {/* Направление укладки */}
      <div style={{ marginBottom: 12 }}>
        <p className="section-title">Направление укладки</p>
        <div style={{ display: 'flex', gap: 6 }}>
          {[['auto','Авто'],['along_y','Вдоль длины (Y)'],['along_x','Вдоль ширины (X)']].map(([val, label]) => (
            <button key={val} onClick={() => setNestDir(val)}
              style={{ flex: 1, padding: '8px 4px', borderRadius: 'var(--radius)', border: 'none', fontSize: 12,
                background: nestDir === val ? 'var(--blue)' : 'var(--bg2)',
                color: nestDir === val ? 'white' : 'var(--text-muted)', cursor: 'pointer', fontWeight: nestDir === val ? 500 : 400 }}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Мелкие детали */}
      <div style={{ marginBottom: 12 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: smallPartsToCenter ? 8 : 0 }}>
          <input type="checkbox" checked={smallPartsToCenter}
            onChange={e => {
              const v = e.target.checked
              setSmallPartsToCenter(v)
              saveSmallPartsSettings({ small_parts_to_center: v })
            }}
            style={{ width: 18, height: 18 }} />
          <span className="section-title" style={{ margin: 0 }}>Мелкие детали — в середину листа</span>
        </label>
        {smallPartsToCenter && (
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Площадь до (квадрат), мм</span>
              <input
                type="text" inputMode="numeric" pattern="[0-9]*"
                value={smallPartsMaxSquareSideMm} placeholder="напр. 400"
                onChange={e => setSmallPartsMaxSquareSideMm(e.target.value.replace(/[^0-9]/g, ''))}
                onBlur={e => saveSmallPartsSettings({ small_parts_max_square_side: e.target.value === '' ? 0 : Number(e.target.value) })}
                style={{ width: '100%', fontSize: 14, padding: '5px 6px', boxSizing: 'border-box' }} />
            </div>
            <div style={{ flex: 1 }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Сторона до, мм</span>
              <input
                type="text" inputMode="numeric" pattern="[0-9]*"
                value={smallPartsMaxSideMm} placeholder="напр. 350"
                onChange={e => setSmallPartsMaxSideMm(e.target.value.replace(/[^0-9]/g, ''))}
                onBlur={e => saveSmallPartsSettings({ small_parts_max_side: e.target.value === '' ? 0 : Number(e.target.value) })}
                style={{ width: '100%', fontSize: 14, padding: '5px 6px', boxSizing: 'border-box' }} />
            </div>
          </div>
        )}
        {smallPartsToCenter && smallPartsMaxSquareSideMm !== '' && (
          <p style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 4 }}>
            Мелкая — это деталь, которая уместилась бы в квадрат {smallPartsMaxSquareSideMm}×{smallPartsMaxSquareSideMm} мм (по площади).
          </p>
        )}
        {smallPartsToCenter && smallPartsMaxSquareSideMm === '' && smallPartsMaxSideMm === '' && (
          <p style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 4 }}>
            Задайте хотя бы один порог — иначе ни одна деталь не будет считаться мелкой.
          </p>
        )}
      </div>

      {/* Время оптимизации плотности */}
      <div style={{ marginBottom: 12 }}>
        <p className="section-title">Время оптимизации, сек</p>
        <input
          type="text" inputMode="numeric" pattern="[0-9]*"
          value={optimizeSeconds} placeholder="напр. 12"
          onChange={e => setOptimizeSeconds(e.target.value.replace(/[^0-9]/g, ''))}
          onBlur={e => saveSmallPartsSettings({ optimize_seconds: e.target.value === '' ? 12 : Number(e.target.value) })}
          style={{ width: '100%', fontSize: 14, padding: '5px 6px', boxSizing: 'border-box' }} />
        <p style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 4 }}>
          Больше времени — плотнее укладка на первых листах и меньше остаётся на последнем. 0 — без доп. оптимизации (быстрый расчёт).
        </p>
      </div>

      {/* Экспорт контуров для отладки — скопировать точные координаты детали разработчику */}
      {details.some(d => d.contour) && (
        <div style={{ marginBottom: 12 }}>
          <button onClick={() => setShowDebugExport(v => !v)}
            style={{ width: '100%', padding: '8px 10px', borderRadius: 'var(--radius)', border: '0.5px solid var(--border-md)',
              background: 'transparent', color: 'var(--text-hint)', fontSize: 12, cursor: 'pointer', textAlign: 'left' }}>
            {showDebugExport ? '▼' : '▶'} Экспорт контуров деталей (для отладки)
          </button>
          {showDebugExport && (
            <div style={{ marginTop: 6 }}>
              <textarea readOnly value={debugExportText}
                style={{ width: '100%', height: 160, fontSize: 11, fontFamily: 'monospace', padding: 6, boxSizing: 'border-box' }}
                onFocus={e => e.target.select()} />
              <button onClick={copyDebugExport}
                style={{ marginTop: 6, width: '100%', padding: 8, borderRadius: 'var(--radius)', border: 'none',
                  background: 'var(--bg2)', color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer' }}>
                {copyStatus || 'Скопировать'}
              </button>
              <p style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 4 }}>
                Нажмите в поле выше, чтобы выделить текст, или на кнопку — чтобы скопировать. Это точные координаты контура детали, которые можно прислать разработчику.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Экспорт РЕЗУЛЬТАТА укладки — что реально сейчас на листах (координаты,
          повороты, точные полигоны). Показывается только после того, как
          раскрой посчитан */}
      {result && (
        <div style={{ marginBottom: 12 }}>
          <button onClick={downloadNestingDxf}
            style={{ width: '100%', padding: 10, borderRadius: 'var(--radius)', border: '0.5px solid var(--teal)',
              background: 'var(--teal-light)', color: 'var(--teal)', fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>
            ⬇ Скачать DXF раскроя (для сверки)
          </button>
          <p style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 4 }}>
            Все листы в ряд, контур каждой детали настоящими линиями — пересечения и неплотная укладка видны в любой CAD-программе.
          </p>
        </div>
      )}

      {/* Экспорт РЕЗУЛЬТАТА укладки — что реально сейчас на листах (координаты,
          повороты, точные полигоны). Показывается только после того, как
          раскрой посчитан */}
      {result && (
        <div style={{ marginBottom: 12 }}>
          <button onClick={() => setShowResultExport(v => !v)}
            style={{ width: '100%', padding: '8px 10px', borderRadius: 'var(--radius)', border: '0.5px solid var(--border-md)',
              background: 'transparent', color: 'var(--text-hint)', fontSize: 12, cursor: 'pointer', textAlign: 'left' }}>
            {showResultExport ? '▼' : '▶'} Экспорт результата раскроя (для отладки)
          </button>
          {showResultExport && (
            <div style={{ marginTop: 6 }}>
              <textarea readOnly value={resultExportText}
                style={{ width: '100%', height: 160, fontSize: 11, fontFamily: 'monospace', padding: 6, boxSizing: 'border-box' }}
                onFocus={e => e.target.select()} />
              <button onClick={copyResultExport}
                style={{ marginTop: 6, width: '100%', padding: 8, borderRadius: 'var(--radius)', border: 'none',
                  background: 'var(--bg2)', color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer' }}>
                {resultCopyStatus || 'Скопировать'}
              </button>
              <p style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 4 }}>
                Это координаты и полигоны того, что сейчас реально показано на листах — если сверить их не по картинке, а по цифрам, видно точное расхождение.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Кнопка раскроя */}
      <button onClick={doNesting} disabled={running}
        style={{ width: '100%', padding: 12, background: running ? 'var(--bg2)' : 'var(--blue)',
          color: running ? 'var(--text-hint)' : 'white', border: 'none', borderRadius: 'var(--radius)',
          fontSize: 15, fontWeight: 500, cursor: running ? 'default' : 'pointer', marginBottom: running ? 8 : 16,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
        {running && (
          <span style={{
            display: 'inline-block', width: 14, height: 14, borderRadius: '50%',
            border: '2px solid var(--text-hint)', borderTopColor: 'transparent',
            animation: 'nesting-spin 0.8s linear infinite',
          }} />
        )}
        {running ? `Считаю раскрой... ${elapsedSec} сек` : result ? '🔄 Пересчитать раскрой' : '▶ Выполнить раскрой'}
      </button>
      <div style={{ fontSize: 11, color: 'var(--text-hint)', textAlign: 'center', margin: '-8px 0 12px' }}>
        Алгоритм раскроя v{NESTING_VERSION}
        {result && (result.algoVersion || 'до версионирования') !== NESTING_VERSION
          ? ` · этот раскрой посчитан: ${result.algoVersion ? 'v' + result.algoVersion : 'до версионирования'}`
          : ''}
      </div>
      <style>{`@keyframes nesting-spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }`}</style>
      {running && (
        <p style={{ fontSize: 12, color: 'var(--text-hint)', textAlign: 'center', marginTop: -4, marginBottom: 16 }}>
          Идёт поиск более плотной укладки, страница остаётся отзывчивой — можно подождать.
        </p>
      )}
      {nestError && (
        <div style={{ padding: 10, marginBottom: 16, borderRadius: 'var(--radius)', background: 'rgba(220,53,69,0.1)', color: '#dc3545', fontSize: 13 }}>
          {nestError}
        </div>
      )}

      {/* Карты */}
      {sheetsData.length > 0 && (
        <div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 12, overflowX: 'auto', paddingBottom: 4 }}>
            {sheetsData.map((s, i) => (
              <button key={i} onClick={() => setActiveSheet(i)}
                style={{ flexShrink: 0, padding: '6px 14px', borderRadius: 20, border: 'none',
                  background: activeSheet === i ? 'var(--blue)' : 'var(--bg2)',
                  color: activeSheet === i ? 'white' : 'var(--text-muted)', fontSize: 13, cursor: 'pointer' }}>
                Лист {i + 1} · {s.placed.length}
              </button>
            ))}
          </div>

          <div className="card" style={{ padding: 8, marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 500 }}>
                Лист {activeSheet + 1} из {sheetsData.length}
                {new URLSearchParams(window.location.search).get('nfp') === '1' && (
                  <span style={{ marginLeft: 6, fontSize: 10, color: '#b45309', background: '#fef3c7', padding: '1px 6px', borderRadius: 8 }}>
                    NFP (эксперимент)
                  </span>
                )}
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 11, color: 'var(--text-hint)' }}>{sheetsData[activeSheet]?.placed.length} дет.</span>
                <button onClick={() => downloadSheetDxf(activeSheet)}
                  style={{ padding: '4px 10px', borderRadius: 20, border: '0.5px solid var(--border-md)',
                    background: 'transparent', color: 'var(--text-hint)', fontSize: 11, cursor: 'pointer' }}>
                  DXF
                </button>
                <button onClick={() => setShowOffcuts(v => !v)}
                  style={{ padding: '4px 10px', borderRadius: 20, border: `0.5px solid ${showOffcuts ? 'var(--teal)' : 'var(--border-md)'}`,
                    background: showOffcuts ? 'var(--teal-light)' : 'transparent',
                    color: showOffcuts ? 'var(--teal)' : 'var(--text-hint)', fontSize: 11, cursor: 'pointer' }}>
                  {showOffcuts ? '✓ Обрезки' : 'Обрезки'}
                </button>
              </div>
            </div>
            {showOffcuts && (
              <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                <button onClick={() => setOffcutMode('cuts')}
                  style={{ flex: 1, padding: '5px 4px', borderRadius: 'var(--radius)', border: 'none', fontSize: 11,
                    background: offcutMode === 'cuts' ? '#7B1FA2' : 'var(--bg2)',
                    color: offcutMode === 'cuts' ? 'white' : 'var(--text-muted)', cursor: 'pointer' }}>
                  Линии реза
                </button>
                <button onClick={() => setOffcutMode('manual')}
                  style={{ flex: 1, padding: '5px 4px', borderRadius: 'var(--radius)', border: 'none', fontSize: 11,
                    background: offcutMode === 'manual' ? '#B85C00' : 'var(--bg2)',
                    color: offcutMode === 'manual' ? 'white' : 'var(--text-muted)', cursor: 'pointer' }}>
                  Вручную
                </button>
                {offcutMode === 'manual' && sheetsData[activeSheet]?.manualOffcuts?.length > 0 && (
                  <button onClick={() => onManualOffcuts(activeSheet, [])}
                    style={{ padding: '5px 10px', borderRadius: 'var(--radius)', border: '0.5px solid var(--border-md)',
                      background: 'transparent', color: 'var(--text-hint)', fontSize: 11, cursor: 'pointer' }}>
                    Очистить ({sheetsData[activeSheet].manualOffcuts.length})
                  </button>
                )}
              </div>
            )}
            <SheetCanvas
              sheet={sheetsData[activeSheet]}
              usableX={result.usableX} usableY={result.usableY}
              sheetL={order.sheet_length} sheetW={order.sheet_width}
              marginL={order.margin_left} marginT={order.margin_top}
              kerf={order.kerf_width} colorMap={colorMap} details={details}
              onMove={onMove} interactive={true} showOffcuts={showOffcuts}
              offcutMode={offcutMode} manualOffcuts={sheetsData[activeSheet]?.manualOffcuts}
              onManualOffcuts={onManualOffcuts}
            />
            <p style={{ fontSize: 11, color: 'var(--text-hint)', textAlign: 'center', marginTop: 6 }}>
              {showOffcuts && offcutMode === 'manual'
                ? 'Удержи палец на свободном месте — обрезок · удержи на выбранном — снять его'
                : (showOffcuts && offcutMode === 'cuts'
                  ? 'Линии реза учитывают детали и выбранные обрезки и пересчитываются по текущей карте · красный пунктир — участок без сквозного реза'
                  : 'Двойной тап — повернуть деталь · Удержи и тяни — переместить · Двумя пальцами — масштаб')}
            </p>
          </div>

          {/* Легенда */}
          <div className="card" style={{ marginBottom: 12 }}>
            <p className="section-title">Детали на листе {activeSheet + 1}</p>
            {sheetsData[activeSheet]?.placed.map((p, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, padding: '4px 0', borderBottom: '0.5px solid var(--border)' }}>
                <div style={{ width: 12, height: 12, borderRadius: 3, background: colorMap[p.detailIndex], flexShrink: 0 }} />
                <span style={{ flex: 1 }}>{p.label}</span>
                <span style={{ color: 'var(--text-hint)' }}>{Math.round(p.origY)}×{Math.round(p.origX)}</span>
                {(p.rotation || p.rotated) && <span style={{ color: 'var(--teal)', fontSize: 11 }}>↻{p.rotation ?? 90}°</span>}
              </div>
            ))}
          </div>

          <button onClick={submitOrder} disabled={submitting}
            style={{ width: '100%', padding: 12, background: 'var(--teal)', color: 'white',
              border: 'none', borderRadius: 'var(--radius)', fontSize: 15, fontWeight: 500, cursor: submitting ? 'default' : 'pointer' }}>
            {submitting ? 'Отправка...' : '✓ Оформить заказ'}
          </button>
          <p style={{ fontSize: 12, color: 'var(--text-hint)', textAlign: 'center', marginTop: 8, marginBottom: 16 }}>
            Раскрой сохранится и заказ уйдёт на производство
          </p>
        </div>
      )}
      <BottomNav />
    </div>
  )
}
