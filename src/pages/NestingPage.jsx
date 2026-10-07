import { useState, useEffect, useLayoutEffect, useRef, useMemo, lazy, Suspense } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { computeOffcutAtPoint, smallAtEdge, smallEdgeReal } from '../lib/nesting'
import { runLiveNesting, liveScore, liveBetter } from '../lib/liveNesting'
import SheetsOverview from '../components/SheetsOverview'
import { newHistory, recordEvent, recordIsland, recordStats, buildHistoryExport } from '../lib/nestingHistory'
import { validateNesting } from '../lib/validateNesting'
import { NESTING_VERSION } from '../lib/version'
import { getAllDrillPoints, getGrooveRects, rotatePointTimes, rotateEdgesTimes } from '../lib/drillGeometry'
import { buildNestingDxf } from '../lib/dxfExport'
import { placedHoles, placedTurns } from '../lib/partHoles'
import { partLabel, LABEL_MODES } from '../lib/partLabel'
import { edgeTotals, contourSegments, segmentSide, holeEdgeSegments } from '../lib/edgeLength'
import { isTwoSided } from '../lib/partInfo'
import { useLabelMode, rememberOrderDefaults, getUserSettings, saveUserSettings } from '../lib/userSettings'
import { useAuth } from '../context/AuthContext'
import { productionSaveNesting } from '../lib/productionApi'
import BottomNav from '../components/BottomNav'
import ContourEditor from '../components/ContourEditor'
import Model3DButton from '../components/Model3DButton'
import ProductionForm from '../components/ProductionForm'
import { myProduction } from '../lib/productionApi'
import { loadOrderModel } from '../lib/orderModel'
import { hasModel } from '../lib/model3d'
import { parsePolygonFromDetail } from '../lib/trueShapeNesting'
import { detailHoles } from '../lib/partHoles'
import { cutDetails, rawDetail, parseEdgeTypes } from '../lib/edgeCut'
import { detailMatKey, materialsOf } from '../lib/detailMaterial'
import { flipDetail } from '../lib/mirrorDetail'
import { detailMeta } from '../lib/partLabel'
import { orderTitle, orderFileName } from '../lib/orderUtils'
import { sortDetails, SORT_MODES } from '../lib/sortDetails'
import CncLoader from '../components/CncLoader'
import SendToMaster from '../components/SendToMaster'
import { lazyRetry } from '../lib/lazyRetry'
const Model3D = lazyRetry(() => import('../components/Model3D'))   // 3D-вид одной детали — по удержанию на карте

const COLORS = [
  '#B5D4F4','#9FE1CB','#F5C4B3','#CECBF6','#FAC775',
  '#C0DD97','#F4C0D1','#B4B2A9','#85B7EB','#5DCAA5',
]

const PART_STROKE = 'rgba(20,20,20,0.8)'
// Заливка деталей на карте раскроя — единый светло-серый (границы деталей
// видны по тёмному контуру)
const PART_FILL = '#E6E6E6'
const SHEET_FILL = '#fff'
const EDGE_COLOR = '#185FA5'
const EDGE_GAP = 3                 // отступ линии кромки от контура детали, px
const LONG_PRESS_MS = 550
// Удержание пальца на детали, после которого её можно двигать (короткое
// касание/скольжение деталь не двигает; двойной тап — поворот)
const DRAG_HOLD_MS = 250
const EDIT_HOLD_MS = 1100   // держим палец на детали не двигая — открыть 3D-вид этой детали (лицом к нам)

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

// Поворот детали на 90° (с кромкой и контуром) — как двойной тап на карте
function rotatePart(p) {
  const newRotation = ((p.rotation ?? (p.rotated ? 90 : 0)) + 90) % 360
  const edges = rotateEdgesTimes({ top: p.edgeTop, right: p.edgeRight, bottom: p.edgeBottom, left: p.edgeLeft }, 1)
  return {
    ...p, w: p.h, h: p.w,
    origX: p.origY, origY: p.origX,
    rotation: newRotation, rotated: newRotation === 90 || newRotation === 270,
    edgeTop: edges.top, edgeRight: edges.right, edgeBottom: edges.bottom, edgeLeft: edges.left,
    polygon: Array.isArray(p.polygon) ? p.polygon.map(pt => rotatePointTimes(pt.x, pt.y, p.origX, p.origY, 1)) : p.polygon,
  }
}

// Данные раскроя (Y вверх от низа) ↔ экранные координаты (Y сверху вниз);
// преобразование — инволюция, как flipY внутри SheetCanvas
const flipPlaced = (list, usableY, kerf) => list.map(p => ({ ...p, y: usableY - p.y - (p.h - kerf) }))

// ─── Буфер: найти свободное место на листе для детали из буфера ─────────────
// Кандидаты — углы у краёв листа и у соседних деталей (x: 0 / правее соседа /
// у правого края; y — аналогично). Берём место ниже всего и левее (как укладка —
// от нижнего левого угла). Если деталь можно вращать и так не влезает —
// пробуем повёрнутую. Возвращает деталь в координатах ДАННЫХ или null.
function findFreeSpot(sheetPlaced, part, usableX, usableY, kerf, canRotate) {
  const items = flipPlaced(sheetPlaced, usableY, kerf) // экранные координаты
  const variants = [part]
  if (canRotate) variants.push(rotatePart(part))
  for (const v of variants) {
    const vw = v.w - kerf, vh = v.h - kerf
    const xs = new Set([0, usableX - vw]), ys = new Set([0, usableY - vh])
    items.forEach(o => {
      xs.add(o.x + o.w); xs.add(o.x - v.w)
      ys.add(o.y + o.h); ys.add(o.y - v.h)
    })
    let best = null
    for (const y of ys) {
      for (const x of xs) {
        const cand = { ...v, x, y }
        if (outOfSheet(cand, usableX, usableY, kerf)) continue
        if (items.some(o => piecesConflict(cand, o, kerf))) continue
        if (!best || y > best.y + 0.5 || (Math.abs(y - best.y) <= 0.5 && x < best.x)) best = cand
      }
    }
    if (best) return flipPlaced([best], usableY, kerf)[0]
  }
  return null
}

function SheetCanvas({ sheet, usableX, usableY, sheetL, sheetW, marginL, marginT, kerf, colorMap, details, labelMode = 'name', showEdges = true, onMove, interactive, showOffcuts, offcutMode, manualOffcuts, onManualOffcuts, selectedIdx = -1, onSelect, onEditPart }) {
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
  const emptyTapRef = useRef(null) // касание пустого места — снять выделение детали

  // useLayoutEffect: при смене масштаба холст пересоздаётся — перерисовываем
  // до показа на экране, чтобы не мигал пустым
  useLayoutEffect(() => {
    placedRef.current = flipY(sheet.placed)
    redraw(placedRef.current)
  }, [sheet.placed, showOffcuts, offcutMode, manualOffcuts, zoom, pinching, selectedIdx, labelMode, showEdges])

  const PADDING = 8
  // Лист не выше ~⅔ экрана — над ним остаются кнопки, под ним буфер и листы
  const fitW = typeof window !== 'undefined'
    ? Math.min(window.innerWidth - 32, 480, (Math.max(260, window.innerHeight * 0.64) - PADDING * 2) * sheetW / sheetL + PADDING * 2)
    : 360
  const canvasW = fitW * zoom
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
    ctx.fillStyle = SHEET_FILL
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
    // «Мелкие — в центр»: мелкие/узкие детали у края листа (через отход) — оранжевым.
    // Считаем в координатах данных (flipY — обратимое преобразование).
    const dataItems = flipY(items)
    const edgeSmall = new Set()
    dataItems.forEach((p, i) => { if (p.isSmall && smallEdgeReal(p, dataItems, usableX, usableY) > 0) edgeSmall.add(i) })
    items.forEach((p, i) => {
      // p.x,p.w = X-координаты; p.y,p.h = Y-координаты
      const x = rx + toC(p.x), y = ry + toC(p.y)
      const w = toC(p.w) - toC(kerf), h = toC(p.h) - toC(kerf)
      const isDragging = i === dragIdx
      const isSelected = i === selectedIdx

      // Проверяем коллизии (по полигону, если есть — bbox слишком грубый для
      // true-shape деталей, уложенных вплотную в паз соседней)
      const hasCollision = conflicts.has(i)

      // Деталь — если есть реальный контур (true-shape нестинг для фрезера),
      // рисуем именно его; иначе — прямоугольник, как раньше
      const hasShape = Array.isArray(p.polygon) && p.polygon.length > 2
      // Обработка с двух сторон — полупрозрачный фиолетовый фон: деталь придётся переворачивать
      const twoSided = !!(details && details[p.detailIndex] && isTwoSided(details[p.detailIndex]))
      const baseFill = twoSided ? 'rgba(123,31,162,0.22)' : PART_FILL
      const atEdge = edgeSmall.has(i)
      ctx.fillStyle = hasCollision ? 'rgba(226,75,74,0.35)' : (isDragging ? 'rgba(24,95,165,0.12)' : (isSelected ? 'rgba(184,92,0,0.18)' : atEdge ? 'rgba(245,158,11,0.28)' : baseFill))
      ctx.strokeStyle = hasCollision ? '#E24B4A' : (isSelected ? '#B85C00' : atEdge ? '#D97706' : PART_STROKE)
      ctx.lineWidth = hasCollision ? 2.5 : (isSelected ? 2.5 : atEdge ? 2 : 1.4)
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
      // Внутренние вырезы (прямоугольные, с дугами, круглые) — «дырой» в детали
      const holes = details ? placedHoles(p, details[p.detailIndex]) : []
      if (holes.length) {
        ctx.save()
        ctx.fillStyle = SHEET_FILL
        ctx.strokeStyle = '#C0392B'
        ctx.lineWidth = 1.2
        holes.forEach(poly => {
          ctx.beginPath()
          poly.forEach((pt, vi) => {
            const sx = x + pt.x * sc, sy = y + h - pt.y * sc
            if (vi === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy)
          })
          ctx.closePath(); ctx.fill(); ctx.stroke()
        })
        ctx.restore()
      }

      // Кромка — рисуется НЕ по самому контуру, а с небольшим отступом внутрь,
      // чтобы контур детали и линия кромки не сливались, но было видно, на
      // какой стороне кромка
      ctx.strokeStyle = EDGE_COLOR
      ctx.lineWidth = 2
      const g = EDGE_GAP
      if (showEdges) {
        if (p.edgeTop) { ctx.beginPath(); ctx.moveTo(x + g, y + g); ctx.lineTo(x + w - g, y + g); ctx.stroke() }
        if (p.edgeBottom) { ctx.beginPath(); ctx.moveTo(x + g, y + h - g); ctx.lineTo(x + w - g, y + h - g); ctx.stroke() }
        if (p.edgeLeft) { ctx.beginPath(); ctx.moveTo(x + g, y + g); ctx.lineTo(x + g, y + h - g); ctx.stroke() }
        if (p.edgeRight) { ctx.beginPath(); ctx.moveTo(x + w - g, y + g); ctx.lineTo(x + w - g, y + h - g); ctx.stroke() }
      }

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
          // Кромка на фигурных участках контура и на вырезах — по самой линии контура
          if (showEdges) {
            const times = placedTurns(p, detail)
            const native = { left: detail.edge_left, right: detail.edge_right, top: detail.edge_top, bottom: detail.edge_bottom }
            ctx.save()
            ctx.strokeStyle = EDGE_COLOR; ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round'
            contourSegments(contour.vertices).forEach(seg => {
              if (!seg.edge) return
              const side = segmentSide(seg, panelW, panelH)
              if (side && native[side]) return     // вся сторона уже нарисована выше
              ctx.beginPath()
              seg.pts.forEach(([px, py], k) => {
                const { x: fx, y: fy } = rotatePointTimes(px, py, panelW, panelH, times)
                const sx = x + fx * sc, sy = y + h - fy * sc
                if (k) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy)
              })
              ctx.stroke()
            })
            // кромка на отдельных участках вырезов
            ;(contour.holes || []).forEach(hh => holeEdgeSegments(hh).forEach(seg => {
              ctx.beginPath()
              seg.pts.forEach(([px, py], k) => {
                const { x: fx, y: fy } = rotatePointTimes(px, py, panelW, panelH, times)
                const sx = x + fx * sc, sy = y + h - fy * sc
                if (k) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy)
              })
              ctx.stroke()
            }))
            const edged = (contour.holes || []).map(hh => !!hh.edge)
            if (edged.some(Boolean) && edged.length === holes.length) {
              holes.forEach((poly, hi) => {
                if (!edged[hi]) return
                ctx.beginPath()
                poly.forEach((pt, vi) => { const sx = x + pt.x * sc, sy = y + h - pt.y * sc; if (vi === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy) })
                ctx.closePath(); ctx.stroke()
              })
            }
            ctx.restore()
          }
          // пазы лицевой стороны — полупрозрачная заливка с контуром, как в редакторе
          {
            const times = placedTurns(p, detail)
            const rects = getGrooveRects(contour, panelW, panelH, true)
            if (rects.length) {
              ctx.save()
              ctx.fillStyle = 'rgba(250,199,117,0.75)'; ctx.strokeStyle = '#BA7517'; ctx.lineWidth = 1
              rects.forEach(r => {
                ctx.beginPath()
                r.pts.forEach(([px, py], k) => {
                  const f = rotatePointTimes(px, py, panelW, panelH, times)
                  if (k) ctx.lineTo(x + f.x * sc, y + h - f.y * sc); else ctx.moveTo(x + f.x * sc, y + h - f.y * sc)
                })
                ctx.closePath(); ctx.fill(); ctx.stroke()
              })
              ctx.restore()
            }
          }
          // только то, что сверлится с лицевой стороны (она смотрит вверх на станке); обработка с изнанки
          // остаётся в детали и появится здесь, если деталь перевернуть в редакторе
          const pts = getAllDrillPoints(contour, panelW, panelH, true)
          if (pts.length) {
            const times = placedTurns(p, detail)
            ctx.fillStyle = '#6A4A17'
            pts.forEach(pt => {
              // Точка в "родной" ориентации детали → в текущей (с учётом поворота на листе, 0/90/180/270)
              const { x: fx, y: fy } = rotatePointTimes(pt.x, pt.y, panelW, panelH, times)
              const sx = x + fx * sc
              const sy = y + h - fy * sc
              // отверстие в торец — на всю глубину: полоса шириной в диаметр от кромки вглубь детали
              if (pt.edge && pt.depth > 0) {
                const e2 = rotatePointTimes(pt.x + pt.dx * pt.depth, pt.y + pt.dy * pt.depth, panelW, panelH, times)
                ctx.save()
                ctx.strokeStyle = 'rgba(106,74,23,0.8)'; ctx.lineCap = 'butt'
                ctx.lineWidth = Math.max(1.6, (pt.d || 8) * sc)
                ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(x + e2.x * sc, y + h - e2.y * sc); ctx.stroke()
                ctx.restore()
                return
              }
              const r = Math.max(1.3, (pt.d || 8) * sc / 2)
              ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2)
              // с лица — закрашенный кружок (станок сверлит), с изнанки — пустой (только для сведения)
              if (pt.back) { ctx.strokeStyle = '#7B1FA2'; ctx.lineWidth = 0.9; ctx.stroke() } else ctx.fill()
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
      const lbl = partLabel(p, details, labelMode, true)
      if (h > 14 && lbl) ctx.fillText(lbl, lx, ly - (p.rotation ? 5 : 0))
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
    const scaleY = rect.height ? canvasH / rect.height : scaleX
    return {
      x: (touch.clientX - rect.left) * scaleX,
      y: (touch.clientY - rect.top) * scaleY
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
    // рез у края зоны не нужен — деталь встаёт вплотную к краю (pw/ph включают рез)
    const cx = [0, usableX + kerf - pw], cy = [0, usableY + kerf - ph]
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
    emptyTapRef.current = idx === -1 ? { x, y, time: Date.now() } : null
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
        // Долгое удержание на месте (деталь так и не сдвинули) — редактор контура этой детали
        if (onEditPart) longPressRef.current = setTimeout(() => {
          longPressRef.current = null
          if (draggingRef.current !== drag || drag.dragged) return
          draggingRef.current = null
          const cur = placedRef.current[idx]
          const back = placedRef.current.map((item, i) => i === idx ? { ...item, x: drag.origX, y: drag.origY } : item)
          placedRef.current = back
          redraw(back)
          if (navigator.vibrate) navigator.vibrate([10, 40, 10])
          onEditPart(cur.detailIndex)
        }, EDIT_HOLD_MS - DRAG_HOLD_MS)
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
    // деталь поехала — это перетаскивание, редактор открывать не нужно
    if (!drag0.dragged) {
      if (Math.hypot(x - startX, y - startY) <= 10) return
      drag0.dragged = true; clearLongPress()
    }
    const p = placedRef.current[idx]
    const dx = fromC(x - startX), dy = fromC(y - startY)
    let nx = Math.max(0, Math.min(usableX + kerf - p.w, origX + dx))
    let ny = Math.max(0, Math.min(usableY + kerf - p.h, origY + dy))
    const snapped = applyMagnet(nx, ny, p.w, p.h, idx, placedRef.current)
    // Точный магнит по контуру для фигурных деталей: зазор ровно kerf, в том числе внутри Г-образной
    const refined = snapPolygonGap(p, snapped.x, snapped.y, placedRef.current, idx, kerf, 50)
    nx = Math.max(0, Math.min(usableX + kerf - p.w, refined.x))
    ny = Math.max(0, Math.min(usableY + kerf - p.h, refined.y))
    const updated = placedRef.current.map((item, i) => i === idx ? { ...item, x: nx, y: ny } : item)
    placedRef.current = updated
    redraw(updated, idx)
  }

  function onPointerUp(e) {
    clearLongPress()
    const drag = draggingRef.current
    if (!drag) {
      // Короткое касание пустого места — снять выделение детали
      const et = emptyTapRef.current
      emptyTapRef.current = null
      if (et && onSelect && selectedIdx !== -1 && Date.now() - et.time < 400) {
        const pt = getPointer(e)
        if (Math.hypot(pt.x - et.x, pt.y - et.y) < 10) onSelect(-1)
      }
      return
    }
    const { x, y } = getPointer(e)
    const dist = Math.hypot(x - drag.startX, y - drag.startY)

    if (!drag.active && !drag.moved && dist < 8 && interactive && (Date.now() - drag.startTime) < DRAG_HOLD_MS) {
      const now = Date.now()
      const isDoubleTap = lastTap.current.idx === drag.idx && (now - lastTap.current.time) < 400
      lastTap.current = { idx: drag.idx, time: now }
      if (isDoubleTap) {
        const rotated = rotatePart(placedRef.current[drag.idx])
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
      // Одиночный тап — выделить деталь (для переноса в буфер)
      if (onSelect) onSelect(drag.idx)
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
        style={{ overflow: zoom > 1 ? 'auto' : 'visible', maxHeight: zoom > 1 ? '70vh' : 'none', borderRadius: 8,
          display: zoom > 1 ? 'block' : 'flex', justifyContent: 'center' }}>
        <canvas ref={canvasRef} width={Math.round(canvasW * DPR)} height={Math.round(canvasH * DPR)}
          style={{ width: canvasW, height: 'auto', aspectRatio: `${canvasW} / ${canvasH}`, maxWidth: zoom > 1 ? 'none' : '100%', borderRadius: 8, display: 'block', touchAction: interactive ? (zoom > 1 ? 'pan-x pan-y' : 'none') : 'auto' }}
          onMouseDown={e => { if (Date.now() - lastTouchRef.current < 800) return; onPointerDown(e) }}
          onMouseMove={e => { if (Date.now() - lastTouchRef.current < 800) return; onPointerMove(e) }}
          onMouseUp={e => { if (Date.now() - lastTouchRef.current < 800) return; onPointerUp(e) }}
          onTouchStart={e => { lastTouchRef.current = Date.now(); if (e.touches.length > 1) return; onPointerDown(e) }}
          onTouchMove={e => { lastTouchRef.current = Date.now(); if (e.touches.length > 1) return; onPointerMove(e) }}
          onTouchEnd={e => { lastTouchRef.current = Date.now(); onPointerUp(e) }}
          onTouchCancel={() => { clearLongPress(); draggingRef.current = null }}
        />
      </div>
      {/* Масштаб — под картой, справа: поверх карты он закрывал детали */}
      {zoom > 1.02 && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
          <button type="button" onClick={() => { setZoom(1); if (wrapRef.current) { wrapRef.current.scrollLeft = 0; wrapRef.current.scrollTop = 0 } }}
            style={{ fontSize: 10, padding: '3px 8px', border: '0.5px solid var(--border-md)',
              borderRadius: 6, background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}>
            {Math.round(zoom * 100)}% · сброс
          </button>
        </div>
      )}
    </div>
  )
}


// ─── Конфигурации раскроя ────────────────────────────────────────────────────
// Каждая конфигурация — свой набор настроек (укладка, время оптимизации, мелкие
// детали) и свой результат. Считаются одновременно, каждая в своём Web Worker
// (алгоритм один и тот же — различается только привязка укладки).
const DIR_OPTIONS = [['auto', 'Авто'], ['along_y', 'Вдоль Y'], ['along_x', 'Вдоль X']]
const DIR_SHORT = { auto: 'Авто', along_y: 'Вдоль Y', along_x: 'Вдоль X' }

let CFG_SEQ = 0
function newCfg(over = {}) {
  return {
    id: ++CFG_SEQ, dir: 'auto', small: false, sq: '', area: '', side: '', edge: '100', end: '', secs: '12',
    live: true,          // онлайн-раскрой: считать до «Стоп», показывая каждое улучшение
    open: true, status: 'idle', // idle | queued | running | stopping | done | error
    startedAt: 0, doneAt: 0, error: '',
    result: null, sheetsData: [], activeSheet: 0, saved: false,
    view: 'all',         // 'all' — все листы сразу · 'sheet' — один лист для правки
    improvements: 0, iter: 0, lastImproveAt: 0,
    islands: 1,          // сколько потоков считает эту конфигурацию
    history: null,       // хронология раскроя (после «Стоп»): улучшения + «пульс» поиска; очищается при «Оформить»
    histPos: -1,         // какой момент хронологии показан (-1 или последний — текущий результат)
    buffer: [],          // детали, снятые с листов (для переноса на другой лист)
    selPart: -1,         // выделенная деталь на активном листе (индекс в placed)
    selBuf: -1,          // выделенная деталь в буфере
    note: '',            // подсказка по буферу (например «нет места»)
    check: null,         // результат проверки раскроя { ok, errors, stats, for: sheetsData, method }
    ...over,
  }
}

function polyAreaMm(pts) {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length]
    a += p.x * q.y - q.x * p.y
  }
  return Math.abs(a) / 2
}
function partAreaMm(p) {
  return Array.isArray(p.polygon) && p.polygon.length > 2 ? polyAreaMm(p.polygon) : (p.origX || 0) * (p.origY || 0)
}
// Итоги для сравнения конфигураций: листов, средняя загрузка, заполнение последнего листа
function summarize(sheets, usableX, usableY) {
  if (!sheets?.length || !usableX || !usableY) return null
  const areas = sheets.map(s => s.placed.reduce((a, p) => a + partAreaMm(p), 0))
  // у листа-обрезка своя рабочая зона
  const cap = s => (s.usableX ?? usableX) * (s.usableY ?? usableY)
  const caps = sheets.map(cap)
  const offcuts = sheets.filter(s => s.stock === 'offcut').length
  return {
    count: sheets.length - offcuts, offcuts,
    util: areas.reduce((a, b) => a + b, 0) / caps.reduce((a, b) => a + b, 0),
    lastFill: areas[areas.length - 1] / caps[caps.length - 1],
  }
}
const countTxt = s => `${s.count} л.${s.offcuts ? ` + ${s.offcuts} обр.` : ''}`

// ─── Параметры листа и обрезки ────────────────────────────────────────────────
// Формат листа, рез и отступы живут в заказе (orders.*). Если выбрано
// производство — берутся из него и не редактируются. Обрезки со склада —
// orders.offcuts (JSON { margin, items: [{ length, width, qty }] }).
// Производство задаёт только рез и отступы (это его станок); формат листа
// пользователь меняет всегда — вдруг привезёт свой материал
const PROD_LOCKED = ['kerf', 'ml', 'mr', 'mt', 'mb']
const SHEET_FIELDS = [
  ['L', 'sheet_length'], ['W', 'sheet_width'], ['kerf', 'kerf_width'],
  ['ml', 'margin_left'], ['mr', 'margin_right'], ['mt', 'margin_top'], ['mb', 'margin_bottom'],
]
const sheetFormOf = src => Object.fromEntries(SHEET_FIELDS.map(([k, col]) => [k, src?.[col] != null ? String(src[col]) : '']))
function parseOffcuts(raw) {
  let o = raw
  if (typeof raw === 'string') { try { o = JSON.parse(raw) } catch { o = null } }
  const items = Array.isArray(o?.items)
    ? o.items.map(it => ({ length: String(it.length ?? ''), width: String(it.width ?? ''), qty: String(it.qty ?? '1') }))
    : []
  return { margin: o?.margin != null ? String(o.margin) : '10', items }
}
function offcutsValue(form) {
  const items = form.items
    .map(it => ({ length: Number(it.length) || 0, width: Number(it.width) || 0, qty: Math.max(0, Math.floor(Number(it.qty) || 0)) }))
    .filter(it => it.length > 0 && it.width > 0 && it.qty > 0)
  return { margin: Math.max(0, Number(String(form.margin).replace(',', '.')) || 0), items }
}
// Геометрия листа для показа / DXF / проверки: у листа-обрезка — своя, у
// обычного — из результата (с какими параметрами считали), иначе из заказа
function geoOf(order, result, sh) {
  const r = result || {}
  const num = (...v) => { for (const x of v) if (x != null && x !== '' && !isNaN(Number(x))) return Number(x); return 0 }
  const sheetL = num(sh?.sheetL, r.sheetL, order?.sheet_length)
  const sheetW = num(sh?.sheetW, r.sheetW, order?.sheet_width)
  const marginL = num(sh?.marginL, r.marginL, order?.margin_left)
  const marginR = num(sh?.marginR, r.marginR, order?.margin_right)
  const marginT = num(sh?.marginT, r.marginT, order?.margin_top)
  const marginB = num(sh?.marginB, r.marginB, order?.margin_bottom)
  const kerf = num(r.kerf, order?.kerf_width)
  return {
    sheetL, sheetW, marginL, marginR, marginT, marginB, kerf,
    usableX: num(sh?.usableX, r.usableX, sheetW - marginL - marginR),
    usableY: num(sh?.usableY, r.usableY, sheetL - marginT - marginB),
  }
}
// Отпечаток параметров листа — чтобы подсказать «пересчитайте», если их поменяли после расчёта
const paramsKey = p => JSON.stringify([+p.sheetL, +p.sheetW, +p.kerf, +p.marginT, +p.marginR, +p.marginB, +p.marginL, p.offcuts?.items?.length ? p.offcuts : null])
// Лучше — меньше листов; при равенстве — меньше материала на последнем листе
// (тот же критерий «фронтальной загрузки», что и в самом алгоритме)
function betterSummary(a, b) {
  if (a.count !== b.count) return a.count < b.count
  return a.lastFill < b.lastFill - 0.0005
}

// Один расчёт = один Web Worker: конфигурации считаются параллельно и не
// блокируют интерфейс. Если воркер не поднялся (старый браузер, ограничения
// окружения) — считаем в основном потоке, по очереди (алгоритм хранит
// направление в состоянии модуля, поэтому одновременно в одном потоке нельзя).
//
// live — онлайн-раскрой: поиск идёт до stop(); onProgress получает каждое
// улучшение (показываем на экране). stop() — мягкая остановка: алгоритм
// выходит из поиска и доводит лучший вариант до финала (стяжка), затем
// промис завершается итогом. Если за STOP_GRACE_MS итог не пришёл (фигурные
// детали — идёт длинный раунд), берём последний показанный результат.
const STOP_GRACE_MS = 2500
let mainThreadQueue = Promise.resolve()

// Сколько потоков («островов») дать одной конфигурации: ядра телефона
// минус одно под интерфейс, поровну между одновременно идущими конфигурациями.
function islandsFor(concurrentJobs = 1) {
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4
  return Math.max(1, Math.min(6, Math.floor((cores - 1) / Math.max(1, concurrentJobs))))
}

// Параллельный поиск «островами»: несколько воркеров считают один и тот же
// заказ независимо (у каждого свой случайный поиск), а лучший найденный вариант
// сразу пересылается остальным — они продолжают искать от него. Так за то же
// время перебирается в N раз больше вариантов укладки.
function startNestingJob(params, { live = false, onProgress = null, onStats = null, onIslandProgress = null, islands = 1 } = {}) {
  const workers = []
  let rejectFn = null, resolveFn = null
  let cancelled = false, finished = false, stopFlag = false
  let best = null, bestScore = null      // лучший промежуточный результат со всех островов
  const finals = []                       // итоги островов
  let expected = 0
  const killAll = () => { workers.forEach(w => w.terminate()); workers.length = 0 }
  const finish = res => { if (finished || cancelled) return; finished = true; killAll(); resolveFn(res) }
  const fail = err => { if (finished || cancelled) return; finished = true; killAll(); rejectFn(err) }
  const consider = (res, fromIdx) => {
    const sc = liveScore(res.sheets, res.usableX, res.usableY)
    const global = liveBetter(sc, bestScore)
    if (!cancelled && !finished) onIslandProgress?.(res, fromIdx, global)
    if (!global) return
    best = res; bestScore = sc
    if (!cancelled && !finished) onProgress?.(res, fromIdx)
    // соседям — и порядок деталей, и саму раскладку (дожатую, «починенную»)
    if (res.genome) workers.forEach((w, i) => { if (i !== fromIdx) w.postMessage({ type: 'migrant', genome: res.genome, sheets: res.sheets }) })
  }
  const pickBest = list => {
    let top = null, topScore = null
    list.forEach(r => { const sc = liveScore(r.sheets, r.usableX, r.usableY); if (liveBetter(sc, topScore)) { top = r; topScore = sc } })
    return top
  }
  // Все живые острова отчитались — итог = лучший из их итогов
  const checkDone = () => { if (expected > 0 && finals.length >= expected) finish(pickBest(finals)) }
  const onFinal = res => { finals.push(res); checkDone() }
  // Остров упал: если остались другие — считаем без него, если нет — ошибка
  const onIslandFail = (msg, fallback) => {
    if (cancelled || finished) return
    expected--
    if (expected > 0) { checkDone(); return }
    if (finals.length) { finish(pickBest(finals)); return }
    if (fallback) fallback()
    else fail(new Error(msg || 'ошибка расчёта'))
  }
  const promise = new Promise((resolve, reject) => {
    resolveFn = resolve; rejectFn = reject
    const fallback = () => {
      killAll()
      expected = 1
      mainThreadQueue = mainThreadQueue.catch(() => {}).then(async () => {
        if (cancelled) return
        await new Promise(r => setTimeout(r, 100)) // дать интерфейсу отрисовать состояние «считаю»
        return runLiveNesting(params, {
          live, shouldStop: () => stopFlag || cancelled,
          onProgress: res => consider(res, 0),
          onStats: st => { if (!cancelled && !finished) onStats?.(st, 0) },
        })
      }).then(finish, fail)
    }
    const n = Math.max(1, islands)
    try {
      for (let i = 0; i < n; i++) workers.push(new Worker(new URL('../lib/nestingWorker.js', import.meta.url), { type: 'module' }))
    } catch { fallback(); return }
    expected = workers.length
    workers.forEach((w, i) => {
      w.onmessage = e => {
        const m = e.data || {}
        if (m.type === 'progress') consider(m.res, i)
        else if (m.type === 'stats') { if (!cancelled && !finished) onStats?.(m.stats, i) }
        else if (m.type === 'done') onFinal(m.res)
        else onIslandFail(m.error, null)
      }
      // Воркер не поднялся (старый браузер) — последний упавший уводит расчёт в основной поток
      w.onerror = () => { w.onerror = null; onIslandFail('', best ? null : fallback) }
      w.postMessage({ type: 'start', params, live, island: i, islands: workers.length })
    })
  })
  return {
    promise,
    stop: () => {
      stopFlag = true
      workers.forEach(w => w.postMessage({ type: 'stop' }))
      setTimeout(() => {
        if (finished || cancelled) return
        // Итоги не успели — берём лучшее из того, что уже есть
        const pool = best ? [...finals, best] : finals
        if (pool.length) finish(pickBest(pool))
        else fail(new Error('stopped')) // ещё ничего не найдено — просто останавливаем
      }, STOP_GRACE_MS)
    },
    cancel: () => { cancelled = true; killAll(); rejectFn?.(new Error('cancelled')) },
  }
}

// «Мелкие — в центр»: порог по площади вводится в м², а хранится (в заказе и в
// алгоритме) как сторона равновеликого квадрата в мм: 0,16 м² ⇔ 400 мм.
function areaFromSide(sideMm) {
  const n = Number(sideMm)
  if (!n) return ''
  return String(+(n * n / 1e6).toFixed(3)).replace('.', ',')
}
function sideFromArea(areaText) {
  const a = parseFloat(String(areaText).replace(',', '.'))
  return a > 0 ? String(Math.round(Math.sqrt(a) * 1000)) : ''
}
// Какие детали заказа попадают в «мелкие» при заданных порогах
function smallDetailsOf(details, sq, side) {
  const sqN = Number(sq) || 0, sideN = Number(side) || 0
  return details.filter(d => {
    const w = Number(d.width) || 0, l = Number(d.length) || 0
    return (sqN > 0 && w * l <= sqN * sqN) || (sideN > 0 && Math.min(w, l) <= sideN)
  })
}

export default function NestingPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [order, setOrder] = useState(null)
  // В заказе могут быть детали из разных листовых материалов (модель импортирована целиком).
  // Раскраиваем по одному материалу: details — детали выбранного, allDetails — все.
  const [allDetails, setAllDetails] = useState([])
  const [matKey, setMatKey] = useState('')
  const [savedByMat, setSavedByMat] = useState({})   // сохранённые раскрои: ключ материала -> результат
  const materials = useMemo(() => materialsOf(allDetails, order), [allDetails, order])
  const multiMat = materials.length > 1
  // В раскрой деталь идёт заготовкой: с учётом подрезки на толщину кромки и прифуговки (edgeCut.js).
  // allDetails — строки заказа как есть (их правим и сохраняем), details — заготовки; исходная строка — rawDetail(d).
  const details = useMemo(() => cutDetails(multiMat ? allDetails.filter(d => detailMatKey(d, order) === matKey) : allDetails, parseEdgeTypes(order?.edge_types)), [allDetails, multiMat, matKey, order])
  const { user, profile, refreshProfile, cabinet, isMaster } = useAuth()
  // кабинет производства: ЧПУ и бирки по принятому раскрою
  const canProduce = cabinet === 'production' && (profile?.role === 'admin' || profile?.role === 'operator')
  const [part3d, setPart3d] = useState(null)       // { index, draft } — деталь в 3D-виде (долгое удержание на карте)
  const [inModel, setInModel] = useState(null)     // деталь в общей 3D-модели заказа: { focus, scene }
  const [sendJob, setSendJob] = useState(null)     // файл для отладки, который уходит мастер-аккаунту
  const [partsOpen, setPartsOpen] = useState(false)   // список деталей под картами — свёрнут
  const [partsSort, setPartsSort] = useState('')
  const [editPart, setEditPart] = useState(null)   // { index, draft } — деталь, открытая в редакторе контура с карты
  const [labelMode, setLabelMode] = useLabelMode(user)   // что писать на деталях карты (идёт за аккаунтом)
  // показывать ли кромку на картах (без неё карта читается легче) — тоже за аккаунтом
  const [showEdges, setShowEdges] = useState(() => getUserSettings(user).nestShowEdges !== false)
  const toggleEdges = v => { setShowEdges(v); saveUserSettings({ nestShowEdges: v }, user) }
  const [configs, setConfigs] = useState(() => [newCfg()])
  const [focusId, setFocusId] = useState(null)   // конфигурация, по которой считается шапка со статистикой
  const [parallel, setParallel] = useState(true) // считать конфигурации одновременно или по очереди
  const [tick, setTick] = useState(0)
  const [showDebugExport, setShowDebugExport] = useState(false)
  const [copyStatus, setCopyStatus] = useState('')
  const [showResultExport, setShowResultExport] = useState(false)
  const [resultCopyStatus, setResultCopyStatus] = useState('')
  const [busyId, setBusyId] = useState(null)     // конфигурация, которая сейчас сохраняется / оформляется
  const [cuttingMethod, setCuttingMethod] = useState('nesting')
  const [showOffcuts, setShowOffcuts] = useState(false)
  const [offcutMode, setOffcutMode] = useState('manual') // 'manual' | 'cuts'
  const [productions, setProductions] = useState([])     // зарегистрированные производства (если есть)
  const [needProd, setNeedProd] = useState(null)         // «Оформить» без производства: { cfg, force, pick, own }
  const [sheetForm, setSheetForm] = useState(() => sheetFormOf(null))
  const [offForm, setOffForm] = useState(() => parseOffcuts(null))
  const [sheetOpen, setSheetOpen] = useState(false)   // «Лист и обрезки» по умолчанию свёрнут
  const [paramsWarn, setParamsWarn] = useState('')
  const jobsRef = useRef({})     // cfgId -> { cancel }
  const skipRef = useRef(new Set()) // конфигурации, снятые из очереди
  const launchBatchRef = useRef(1)  // сколько конфигураций запускается одновременно (для деления ядер)
  const historyRef = useRef({})     // cfgId -> хронология раскроя (пишется во время расчёта)
  const playRef = useRef(null)      // таймер проигрывания хронологии
  const configsRef = useRef(configs)
  configsRef.current = configs

  const colorMap = {}
  details.forEach((d, i) => { colorMap[i] = COLORS[i % COLORS.length] })

  const anyRunning = configs.some(c => c.status === 'running' || c.status === 'queued' || c.status === 'stopping')

  useEffect(() => { fetchOrder() }, [id])
  // Остановить проигрывание хронологии при уходе со страницы
  useEffect(() => () => { if (playRef.current) clearInterval(playRef.current) }, [])
  useEffect(() => () => {
    Object.values(jobsRef.current).forEach(j => j.cancel())
    jobsRef.current = {}
  }, [])
  useEffect(() => {
    if (!anyRunning) return
    const t = setInterval(() => setTick(x => x + 1), 1000)
    return () => clearInterval(t)
  }, [anyRunning])

  // Конфигурация, по которой показываем шапку (листы/площадь), экспорт для
  // отладки и общие итоги: последняя открытая, у которой есть результат.
  const focus = configs.find(c => c.id === focusId && c.result) || configs.find(c => c.result) || null
  const result = focus?.result || null
  const sheetsData = focus?.sheetsData || []

  function updateCfg(cfgId, patch) {
    setConfigs(cs => cs.map(c => c.id === cfgId ? { ...c, ...(typeof patch === 'function' ? patch(c) : patch) } : c))
  }

  async function fetchOrder() {
    const { data: o } = await supabase.from('orders').select('*').eq('id', id).single()
    const { data: d } = await supabase.from('order_details').select('*').eq('order_id', id).order('sort_order')
    setOrder(o); setAllDetails(d || [])
    if (o) {
      setSheetForm(sheetFormOf(o))
      setOffForm(parseOffcuts(o.offcuts))
      fetchProductions(o)
      setCuttingMethod(o.cutting_method || 'nesting')
      let store = null
      if (o.nesting_result) { try { store = JSON.parse(o.nesting_result) } catch { store = null } }
      // несколько материалов — раскрой хранится по каждому отдельно: { multi: true, byMat: { ключ: результат } }
      const mats = materialsOf(d || [], o)
      const byMat = store?.multi ? (store.byMat || {}) : {}
      const key = mats.length > 1 ? (mats.find(m => byMat[m.key]) || mats[0]).key : ''
      const saved = mats.length > 1 ? (byMat[key] || null) : (store && !store.multi ? store : null)
      setSavedByMat(byMat); setMatKey(key)
      // Первая конфигурация — настройки заказа (и уже сохранённый раскрой, если он есть)
      const first = cfgFromOrder(o, saved)
      setConfigs([first])
      setFocusId(first.id)
    }
  }

  function cfgFromOrder(o, saved) {
    return newCfg({
      small: !!o.small_parts_to_center,
      sq: o.small_parts_max_square_side ? String(o.small_parts_max_square_side) : '',
      area: areaFromSide(o.small_parts_max_square_side),
      side: o.small_parts_max_side ? String(o.small_parts_max_side) : '',
      edge: o.small_parts_edge_gap ? String(o.small_parts_edge_gap) : '100',
      // «торцом к краю»: пусто — как «узкая сторона»
      end: o.small_parts_end_side != null ? String(o.small_parts_end_side) : '',
      secs: o.optimize_seconds != null ? String(o.optimize_seconds) : '12',
      ...(saved ? {
        dir: saved.config?.dir || 'auto',
        status: 'done', result: saved, sheetsData: (saved.sheets || []).map((sh, i) => ({ ...sh, index: i })),
        startedAt: 0, doneAt: 0, saved: true,
      } : {}),
    })
  }

  // Другой материал: показываем его детали и его сохранённый раскрой (если уже выбирали вариант)
  function chooseMaterial(key) {
    if (key === matKey || anyRunning) return
    historyRef.current = {}
    setMatKey(key)
    const first = cfgFromOrder(order, savedByMat[key] || null)
    setConfigs([first]); setFocusId(first.id)
  }

  // Что записать в заказ: один материал — сам результат, несколько — по ключам материалов
  async function writeSaved(byMat, single) {
    const value = multiMat ? (Object.keys(byMat).length ? JSON.stringify({ multi: true, byMat }) : null) : (single ? JSON.stringify(single) : null)
    // чужой заказ (его перекраивает производство) пишется через функцию базы — напрямую заказ меняет только хозяин
    if (order?.user_id && order.user_id !== user?.id && profile?.role !== 'admin') {
      const r = await productionSaveNesting(id, value)
      if (r.error) { setParamsWarn(r.missing ? 'Раскрой не сохранён: выполните migration_production_nesting.sql в Supabase (SQL Editor) — один раз.' : 'Не удалось сохранить раскрой: ' + r.error); return false }
    } else await supabase.from('orders').update({ nesting_result: value }).eq('id', id)
    setOrder(o => ({ ...o, nesting_result: value }))
    return true
  }

  // ─── Деталь с карты (долгое удержание): 3D-вид лицевой стороной к нам; там же — «Сменить лицевую сторону»
  // и «Редактор контура». Правки сохраняются при закрытии.
  function partDraft(di) {
    const d = rawDetail(details[di])
    if (!d) return null
    let c
    try { c = d.contour ? JSON.parse(d.contour) : null } catch { c = null }
    return { index: di, draft: {
      name: d.name || '', w: d.length, h: d.width, contour: c,
      edges: { top: d.edge_top || null, right: d.edge_right || null, bottom: d.edge_bottom || null, left: d.edge_left || null },
    } }
  }
  function openPart3d(di) { const pd = partDraft(di); if (pd) setPart3d(pd) }
  const thicknessOf = di => Number(detailMeta(details[di])?.thickness) || Number(order?.material_thickness) || 16
  function flipPart3d() {
    setPart3d(pd => (pd ? { ...pd, changed: true, draft: flipDetail({ ...pd.draft, contour: pd.draft.contour || {} }, thicknessOf(pd.index)) } : pd))
  }
  function closePart3d() { const pd = part3d; setPart3d(null); if (pd?.changed) savePartDraft(pd) }
  function part3dToEditor() { const pd = part3d; setPart3d(null); if (pd) setEditPart({ index: pd.index, draft: pd.draft }) }
  // деталь для 3D-вида: стоит лицевой пластью к зрителю (X — ширина, Y — длина, толщина — на нас)
  function part3dDetails(pd) {
    const dr = pd.draft, W = Number(dr.h) || 0, L = Number(dr.w) || 0, c = dr.contour || {}
    return [{
      name: dr.name || 'Деталь', w: L, h: W, edges: dr.edges,
      contour: { ...c, meta: {
        des: c.meta?.des || '', material: c.meta?.material || '', product: '',
        thickness: thicknessOf(pd.index), texDir: 2, turned: false, flipped: false,
        local: { x0: 0, y0: 0, dx: W, dy: L }, inst: [[1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]], ids: [0], anims: [null],
      } },
    }]
  }
  // Силуэт детали (контур + вырезы): изменился — готовый раскрой больше не верен
  function shapeKey(d) {
    const norm = pts => pts.map(p => `${Math.round((p.x ?? p[0]) * 10)},${Math.round((p.y ?? p[1]) * 10)}`).sort().join(';')
    let poly
    try { poly = parsePolygonFromDetail(d) } catch { poly = null }
    return `${d.width}x${d.length}|${poly?.polygon ? norm(poly.polygon) : 'rect'}|${detailHoles(d).map(norm).sort().join('/')}`
  }
  async function closePartEditor() {
    const ep = editPart
    setEditPart(null)
    if (ep) savePartDraft(ep)
  }
  async function savePartDraft(ep) {
    const d = rawDetail(details[ep.index]), dr = ep.draft
    const patch = {
      contour: dr.contour ? JSON.stringify(dr.contour) : null,
      edge_top: dr.edges.top || null, edge_right: dr.edges.right || null,
      edge_bottom: dr.edges.bottom || null, edge_left: dr.edges.left || null,
    }
    if (Object.keys(patch).every(k => (patch[k] || null) === (d[k] || null))) return   // ничего не меняли
    const nd = { ...d, ...patch, _parsedContour: undefined }   // сбросить кэш разобранного контура — иначе карта рисует старую присадку
    const shapeChanged = shapeKey(d) !== shapeKey(nd)
    if (shapeChanged && !window.confirm('Форма детали изменилась — готовый раскрой станет неверным и будет сброшен. Сохранить изменения?')) return
    const { error } = await supabase.from('order_details').update(patch).eq('id', d.id)
    if (error) { window.alert('Не удалось сохранить деталь: ' + error.message); return }
    setAllDetails(ds => ds.map(x => (x.id === d.id ? nd : x)))
    if (shapeChanged) {
      // сбрасываем раскрой только этого материала
      const rest = { ...savedByMat }; delete rest[matKey]
      setSavedByMat(rest)
      await writeSaved(rest, null)
      setConfigs(cs => cs.map(c => newCfg({ dir: c.dir, small: c.small, sq: c.sq, area: c.area, side: c.side, edge: c.edge, end: c.end, secs: c.secs })))
      setFocusId(null)
      return
    }
    // форма та же — на уложенных деталях обновляем только кромку (с учётом их поворота на листе)
    const fix = p => {
      if (p.detailIndex !== ep.index) return p
      const e = rotateEdgesTimes({ top: patch.edge_top, right: patch.edge_right, bottom: patch.edge_bottom, left: patch.edge_left },
        Math.round((p.rotation ?? (p.rotated ? 90 : 0)) / 90))
      return { ...p, edgeTop: e.top, edgeRight: e.right, edgeBottom: e.bottom, edgeLeft: e.left }
    }
    setConfigs(cs => cs.map(c => ({
      ...c,
      sheetsData: c.sheetsData.map(sh => ({ ...sh, placed: sh.placed.map(fix) })),
      buffer: (c.buffer || []).map(fix),
    })))
  }

  // Общие настройки заказа запоминаем по последней правке любой конфигурации
  async function saveSmallPartsSettings(patch) {
    rememberOrderDefaults(patch, user)   // и как «мои настройки» для следующих заказов
    await supabase.from('orders').update(patch).eq('id', id)
  }

  // ─── Производство, формат листа, рез, отступы, обрезки ──────────────────────
  async function fetchProductions(o) {
    let list = []
    try {
      const { data, error } = await supabase.from('productions').select('*').order('name')
      if (!error && Array.isArray(data)) list = data
    } catch { list = [] }
    setProductions(list)
    // Выбрано производство — параметры листа всегда его (могли поменяться)
    const pr = o?.production_id ? list.find(x => x.id === o.production_id) : null
    if (pr) {
      const patch = {}
      SHEET_FIELDS.forEach(([k, col]) => { if (PROD_LOCKED.includes(k) && pr[col] != null && Number(pr[col]) !== Number(o[col])) patch[col] = Number(pr[col]) })
      if (Object.keys(patch).length) await saveOrderPatch(patch, false)
    }
  }
  // Запись в заказ + сразу в состояние страницы. Нет колонки в базе (не
  // выполнена миграция) — пишем без неё и показываем предупреждение.
  async function saveOrderPatch(patch, remember = true) {
    if (remember) rememberOrderDefaults(patch, user)   // формат листа, фреза, отступы — запоминаем за аккаунтом
    setOrder(o => ({ ...o, ...patch }))
    if (SHEET_FIELDS.some(([, col]) => col in patch)) {
      setSheetForm(f => { const n = { ...f }; SHEET_FIELDS.forEach(([k, col]) => { if (col in patch) n[k] = String(patch[col]) }); return n })
    }
    const { error } = await supabase.from('orders').update(patch).eq('id', id)
    if (!error) return true
    const missing = ['production_id', 'offcuts'].filter(c => c in patch && String(error.message || '').includes(c))
    if (missing.length) {
      const rest = { ...patch }; missing.forEach(c => delete rest[c])
      if (Object.keys(rest).length) await supabase.from('orders').update(rest).eq('id', id)
      setParamsWarn('В базе нет колонок ' + missing.join(', ') + ' — выполните migration_productions_offcuts.sql в Supabase. Пока сохраняется только на этом экране.')
      return false
    }
    setParamsWarn('Не удалось сохранить: ' + (error.message || 'ошибка базы'))
    return false
  }
  function commitSheetField(key) {
    const col = SHEET_FIELDS.find(([k]) => k === key)[1]
    const v = Number(String(sheetForm[key]).replace(',', '.'))
    const ok = sheetForm[key] !== '' && isFinite(v) && v >= 0 && !((key === 'L' || key === 'W') && v < 50)
    if (!ok) { setSheetForm(f => ({ ...f, [key]: order[col] != null ? String(order[col]) : '' })); return }
    if (Number(order[col]) === v) return
    saveOrderPatch({ [col]: v })
  }
  function chooseProduction(pid) {
    const pr = productions.find(x => x.id === pid)
    if (!pr) { saveOrderPatch({ production_id: null }); return }
    const patch = { production_id: pr.id }
    SHEET_FIELDS.forEach(([k, col]) => { if (PROD_LOCKED.includes(k) && pr[col] != null) patch[col] = Number(pr[col]) }) // формат листа не трогаем
    saveOrderPatch(patch)
  }
  function commitOffcuts(form = offForm) {
    const v = offcutsValue(form)
    saveOrderPatch({ offcuts: JSON.stringify(v) })
  }

  function addCfg() {
    const last = configs[configs.length - 1]
    const used = new Set(configs.map(c => c.dir))
    const dir = ['auto', 'along_y', 'along_x'].find(d => !used.has(d)) || last.dir
    const cfg = newCfg({ small: last.small, sq: last.sq, area: last.area, side: last.side, edge: last.edge, end: last.end, secs: last.secs, dir })
    setConfigs(cs => [...cs.map(c => ({ ...c, open: false })), cfg])
  }

  function removeCfg(cfgId) {
    const job = jobsRef.current[cfgId]
    if (job) { delete jobsRef.current[cfgId]; job.cancel() }
    setConfigs(cs => cs.length > 1 ? cs.filter(c => c.id !== cfgId) : cs)
  }

  // Запуск одной конфигурации. Возвращает промис, который завершается, когда расчёт закончен.
  function launch(cfg) {
    // ?nfp=1 — прогнать ЭТОТ заказ через NFP для сравнения (только для фрезера)
    const useNfp = new URLSearchParams(window.location.search).get('nfp') === '1'
    const params = {
      details, direction: cfg.dir,
      sheetL: order.sheet_length, sheetW: order.sheet_width,
      marginT: order.margin_top, marginR: order.margin_right,
      marginB: order.margin_bottom, marginL: order.margin_left,
      kerf: order.kerf_width,
      offcuts: offcutsValue(offForm),
      smallPartsToCenter: cfg.small,
      smallPartsMaxSquareSide: cfg.sq === '' ? 0 : Number(cfg.sq),
      smallPartsMaxSide: cfg.side === '' ? 0 : Number(cfg.side),
      smallPartsEdgeGap: cfg.edge === '' ? 100 : Number(cfg.edge),
      optimizeSeconds: cfg.secs === '' ? 12 : Number(cfg.secs),
      cuttingMethod,
      algo: useNfp ? 'nfp' : 'raster',
    }
    const stamp = res => {
      res.algoVersion = NESTING_VERSION // версия алгоритма запишется вместе с результатом
      res.algo = params.algo // 'nfp' | 'raster' — чтобы на карте было видно, чем реально посчитано
      res.paramsKey = paramsKey(params) // с какими параметрами листа считали
      return res
    }
    const toSheets = res => res.sheets.map((sh, i) => ({ ...sh, index: i, freeRects: sh.freeRects || [] }))
    updateCfg(cfg.id, {
      status: 'running', startedAt: Date.now(), doneAt: 0, error: '', view: 'all',
      improvements: 0, iter: 0, lastImproveAt: 0, buffer: [], selPart: -1, selBuf: -1, note: '',
    })
    // Онлайн: каждое улучшение сразу на экран (детали плавно переезжают на новые места)
    // Ядра телефона делятся между конфигурациями, которые считаются одновременно
    const othersRunning = configsRef.current.filter(c => c.id !== cfg.id && (c.status === 'running' || c.status === 'stopping')).length
    const islands = islandsFor(Math.max(launchBatchRef.current, 1 + othersRunning))
    updateCfg(cfg.id, { islands, history: null, histPos: -1 })
    // Хронология раскроя пишется в ref (не в state — «пульс» идёт каждую секунду
    // с каждого потока), в конфигурацию попадает после «Стоп» / окончания
    const hist = newHistory(cfg, islands, params)
    historyRef.current[cfg.id] = hist
    const job = startNestingJob(params, {
      live: cfg.live,
      islands,
      onStats: (st, island) => { if (jobsRef.current[cfg.id] === job) recordStats(hist, st, island) },
      onIslandProgress: (res, island, global) => { if (jobsRef.current[cfg.id] === job) recordIsland(hist, res, island, global) },
      onProgress: (res, island) => {
        if (jobsRef.current[cfg.id] !== job) return
        recordEvent(hist, res, island, res.rough ? 'rough' : 'improve')
        updateCfg(cfg.id, c => {
          const sheetsData = toSheets(res)
          return {
            result: stamp(res), sheetsData, saved: false, rough: !!res.rough,
            improvements: c.improvements + 1, iter: res.iter || c.iter, lastImproveAt: Date.now(),
            activeSheet: Math.min(c.activeSheet, sheetsData.length - 1),
          }
        })
        setFocusId(f => (configsRef.current.some(c => c.id === f && c.result) ? f : cfg.id))
      },
    })
    jobsRef.current[cfg.id] = job
    return job.promise.then(res => {
      if (jobsRef.current[cfg.id] !== job) return // отменена или заменена
      delete jobsRef.current[cfg.id]
      recordEvent(hist, res, -1, 'final')
      hist.stoppedAt = Date.now()
      updateCfg(cfg.id, c => {
        const sheetsData = toSheets(res)
        return {
          status: 'done', doneAt: Date.now(), result: stamp(res), saved: false, sheetsData, rough: false,
          activeSheet: Math.min(c.activeSheet, sheetsData.length - 1),
          history: hist, histPos: hist.events.length - 1,
        }
      })
      setFocusId(f => (configsRef.current.some(c => c.id === f && c.result) ? f : cfg.id))
    }).catch(err => {
      if (jobsRef.current[cfg.id] !== job) return
      delete jobsRef.current[cfg.id]
      if (err?.message === 'stopped') { updateCfg(cfg.id, { status: 'idle', doneAt: Date.now() }); return }
      console.error('Ошибка раскроя:', err)
      updateCfg(cfg.id, {
        status: 'error', doneAt: Date.now(),
        error: 'Не удалось выполнить раскрой: ' + (err?.message || 'неизвестная ошибка') + '. Попробуйте ещё раз или уменьшите время оптимизации.',
      })
    })
  }

  function runCfg(cfgId) {
    const cfg = configsRef.current.find(c => c.id === cfgId)
    if (!cfg || !order || !details.length) return
    if (cfg.status === 'running' || cfg.status === 'stopping') return
    launch(cfg)
  }

  async function runAll() {
    if (!order || !details.length) return
    const list = configsRef.current.filter(c => c.status !== 'running' && c.status !== 'stopping')
    if (!list.length) return
    if (parallel) {
      launchBatchRef.current = list.length // ядра делятся поровну между запущенными вместе
      list.forEach(c => launch(c))
      launchBatchRef.current = 1
      return
    }
    list.forEach(c => updateCfg(c.id, { status: 'queued', error: '' }))
    for (const c of list) {
      if (skipRef.current.has(c.id)) { skipRef.current.delete(c.id); continue }
      const cur = configsRef.current.find(x => x.id === c.id)
      if (!cur) continue
      await launch(cur)
    }
  }

  // «Стоп»: идущий расчёт останавливается мягко — лучший найденный вариант
  // доводится до финала и остаётся на экране. Из очереди — просто снимается.
  function stopCfg(cfgId) {
    const cur = configsRef.current.find(c => c.id === cfgId)
    const job = jobsRef.current[cfgId]
    if (cur?.status === 'running' && job?.stop) {
      job.stop()
      updateCfg(cfgId, { status: 'stopping' })
      return
    }
    if (cur?.status === 'queued') skipRef.current.add(cfgId)
    if (job) { delete jobsRef.current[cfgId]; job.cancel() }
    updateCfg(cfgId, { status: 'idle' })
  }

  // ─── Буфер деталей ────────────────────────────────────────────────────────
  // Деталь снимается с листа в буфер, затем кладётся на любой другой лист
  // (в первое свободное место) или на новый лист.
  function toBuffer(cfgId) {
    setConfigs(cs => cs.map(c => {
      if (c.id !== cfgId) return c
      const si = c.activeSheet
      const part = c.sheetsData[si]?.placed[c.selPart]
      if (!part) return c
      return {
        ...c, saved: false, note: '', selPart: -1,
        buffer: [...c.buffer, part], selBuf: c.buffer.length,
        sheetsData: c.sheetsData.map((sh, i) => i === si ? { ...sh, placed: sh.placed.filter((_, j) => j !== c.selPart) } : sh),
      }
    }))
  }

  function fromBuffer(cfgId, toNewSheet) {
    setConfigs(cs => cs.map(c => {
      if (c.id !== cfgId || !c.result) return c
      const part = c.buffer[c.selBuf]
      if (!part) return c
      let sheetsData = c.sheetsData
      let si = c.activeSheet
      if (toNewSheet || !sheetsData[si]) {
        si = sheetsData.length
        sheetsData = [...sheetsData, { index: si, placed: [], freeRects: [], manualOffcuts: [] }]
      }
      const { usableX, usableY, kerf } = geoOf(order, c.result, sheetsData[si])
      const canRotate = !!details[part.detailIndex]?.rotatable
      const spot = findFreeSpot(sheetsData[si].placed, part, usableX, usableY, kerf, canRotate)
      if (!spot) {
        return { ...c, note: `На листе ${si + 1} нет места для «${part.label}» (${Math.round(part.origY)}×${Math.round(part.origX)}). Освободите место или положите на новый лист.` }
      }
      const placed = [...sheetsData[si].placed, spot]
      const buffer = c.buffer.filter((_, j) => j !== c.selBuf)
      return {
        ...c, saved: false, note: '', buffer,
        selBuf: buffer.length ? Math.min(c.selBuf, buffer.length - 1) : -1,
        activeSheet: si, view: 'sheet', selPart: placed.length - 1,
        sheetsData: sheetsData.map((sh, i) => i === si ? { ...sh, placed } : sh),
      }
    }))
  }

  // Пустой лист (все детали унесли в буфер / на другие листы) — убрать
  function deleteEmptySheet(cfgId, si) {
    setConfigs(cs => cs.map(c => {
      if (c.id !== cfgId || !c.sheetsData[si] || c.sheetsData[si].placed.length) return c
      const sheetsData = c.sheetsData.filter((_, i) => i !== si).map((sh, i) => ({ ...sh, index: i }))
      return {
        ...c, sheetsData, saved: false, note: '', selPart: -1,
        activeSheet: Math.max(0, Math.min(si, sheetsData.length - 1)),
        view: sheetsData.length ? c.view : 'all',
      }
    }))
  }

  async function saveNesting(cfg) {
    if (!cfg?.result) return
    // Пустые листы (все детали унесли в буфер/на другие листы) не сохраняем
    const sheets = cfg.sheetsData.filter(sh => sh.placed.length).map((sh, i) => ({ ...sh, index: i }))
    const toSave = {
      ...cfg.result, sheets,
      config: { dir: cfg.dir, small: cfg.small, sq: cfg.sq, side: cfg.side, edge: cfg.edge, end: cfg.end, secs: cfg.secs },
    }
    const next = multiMat ? { ...savedByMat, [matKey]: toSave } : {}
    if (multiMat) setSavedByMat(next)
    await writeSaved(next, toSave)
    return next
  }

  // ─── Проверка раскроя перед сохранением / оформлением ──────────────────────
  // Итоговая раскладка (с ручными правками) проверяется заново: все детали на
  // месте, нет пересечений, выдержан зазор на рез и отступы от края листа,
  // размеры и запрет поворота; для пилы — сквозные резы. Результат привязан к
  // конкретной раскладке (check.for) — после любой правки проверка повторяется.
  function checkCfg(cfg) {
    const r = validateNesting({
      sheets: cfg.sheetsData.filter(sh => sh.placed.length), details,
      usableX: cfg.result.usableX, usableY: cfg.result.usableY,
      kerf: geoOf(order, cfg.result).kerf, cuttingMethod,
    })
    updateCfg(cfg.id, { check: { ...r, for: cfg.sheetsData, method: cuttingMethod } })
    return r.ok
  }

  // «Выбрать вариант» — записать этот результат в заказ (остальные остаются на экране)
  // ЧПУ и бирки работают по сохранённому раскрою: несохранённый вариант сначала сохраняем
  async function goProduce(cfg, where) {
    if (!cfg.saved) {
      if (!checkCfg(cfg) && !window.confirm('В раскрое есть замечания (см. проверку). Всё равно сохранить его и продолжить?')) return
      setBusyId(cfg.id)
      await saveNesting(cfg)
      setConfigs(cs => cs.map(c => ({ ...c, saved: c.id === cfg.id })))
      setBusyId(null)
    }
    navigate(`/orders/${id}/${where}`)
  }
  async function chooseCfg(cfg, force = false) {
    if (!force && !checkCfg(cfg)) return
    setBusyId(cfg.id)
    await saveNesting(cfg)
    setConfigs(cs => cs.map(c => ({ ...c, saved: c.id === cfg.id })))
    setFocusId(cfg.id)
    setBusyId(null)
  }

  // Заказ оформляется на производство. Если оно не выбрано: у кого есть своё производство — заказ идёт туда;
  // остальным предлагаем выбрать производство или зарегистрировать своё.
  async function submitOrder(cfg, force = false, prodId = null) {
    if (!force && !checkCfg(cfg)) return
    if (prodId) await saveOrderPatch({ production_id: prodId }, false)     // раскрой уже посчитан — параметры листа не трогаем
    else if (!order.production_id) {
      const mine = await myProduction(user?.id)
      const ready = mine && (mine.status ?? 'approved') === 'approved'
      if (ready) await saveOrderPatch({ production_id: mine.id }, false)
      else if (mine !== undefined) {
        const list = productions.filter(pr => (pr.status ?? 'approved') === 'approved')
        setNeedProd({ cfg, force, pick: list[0]?.id || '', own: !mine && list.length === 0, pending: mine ? (mine.status || 'pending') : '' })
        return
      }
      // mine === undefined — в базе ещё нет кабинета производства: оформляем как раньше
    }
    setNeedProd(null)
    if (multiMat) {
      const missing = materials.filter(m => m.key !== matKey && !savedByMat[m.key])
      if (missing.length && !window.confirm(`Раскрой ещё не выбран для материалов:\n${missing.map(m => '· ' + m.label).join('\n')}\n\nВсё равно оформить заказ?`)) return
    }
    setBusyId(cfg.id)
    // Хронология нужна только на время раскроя — после оформления очищается
    historyRef.current = {}
    setConfigs(cs => cs.map(c => ({ ...c, history: null, histPos: -1 })))
    await saveNesting(cfg)
    await supabase.from('orders').update({ status: 'new', submitted_at: new Date().toISOString() }).eq('id', id)
    navigate(`/orders/${id}`)
  }

  function onMoveCfg(cfgId, sheetIdx, newPlaced) {
    setConfigs(cs => cs.map(c => c.id !== cfgId ? c : {
      ...c, saved: false,
      sheetsData: c.sheetsData.map((s, i) => i === sheetIdx ? { ...s, placed: newPlaced } : s),
    }))
  }

  function onManualOffcutsCfg(cfgId, sheetIdx, list) {
    setConfigs(cs => cs.map(c => c.id !== cfgId ? c : {
      ...c, saved: false,
      sheetsData: c.sheetsData.map((s, i) => i === sheetIdx ? { ...s, manualOffcuts: list } : s),
    }))
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
  function downloadNestingDxf(sheets = sheetsData, suffix = '') {
    const g = geoOf(order, result)
    const dxf = buildNestingDxf(sheets, { sheet_width: g.sheetW, sheet_length: g.sheetL, margin_left: g.marginL, margin_bottom: g.marginB, material_thickness: order.material_thickness }, details, labelMode)
    const blob = new Blob([dxf], { type: 'application/dxf' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${orderFileName(order)}${suffix}.dxf`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 30000) // не сразу: на телефоне загрузка может не успеть начаться
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
  function buildSheetDxf(sheetIdx, sheets = sheetsData) {
    const sheet = sheets[sheetIdx]
    if (!sheet || !order) return ''
    const G = geoOf(order, result, sheet)
    const sheetW = G.sheetW, sheetL = G.sheetL, kerf = G.kerf
    let entities = polygonToDxfEntity([[0, 0], [sheetW, 0], [sheetW, sheetL], [0, sheetL]], 'sheet')
    sheet.placed.forEach(p => {
      const hasShape = Array.isArray(p.polygon) && p.polygon.length > 2
      // Система координат — как у укладки (trueShapeNesting): Y вверх от низа
      // рабочей зоны, контур polygon кладётся БЕЗ переворота; плюс отступы
      // листа (левый и нижний). Канвас переводит в экранные координаты сам
      // (см. flipY в SheetCanvas), поэтому экран и DXF показывают одно и то же.
      const ox = G.marginL, oy = G.marginB
      const poly = hasShape
        ? p.polygon.map(pt => [ox + p.x + pt.x, oy + p.y + pt.y])
        : (() => { const w = p.w - kerf, h = p.h - kerf; return [[ox + p.x, oy + p.y], [ox + p.x + w, oy + p.y], [ox + p.x + w, oy + p.y + h], [ox + p.x, oy + p.y + h]] })()
      entities += polygonToDxfEntity(poly, 'detal')
      // внутренние вырезы — отдельным слоем
      placedHoles(p, details[p.detailIndex]).forEach(hp => {
        entities += polygonToDxfEntity(hp.map(pt => [ox + p.x + pt.x, oy + p.y + pt.y]), 'vyrez')
      })

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
      const label = (partLabel(p, details, labelMode) + ` ${Math.round(p.origY)}x${Math.round(p.origX)}`).trim()
      const textHeight = Math.max(15, Math.min(40, Math.min(p.origX, p.origY) / 8))
      // Тот же переворот по Y, что и у контура выше — иначе подпись у
      // контурных деталей уедет не туда (для прямоугольных labelLY=origY/2,
      // переворот не меняет результат, поэтому там расхождения не было).
      entities += textToDxfEntity(label, ox + p.x + labelLX, oy + p.y + labelLY, textHeight, 'Solid Edge 2D NestingPartName')
    })
    return `0\r\nSECTION\r\n2\r\nHEADER\r\n9\r\n$ACADVER\r\n1\r\nAC1009\r\n0\r\nENDSEC\r\n`
      + `0\r\nSECTION\r\n2\r\nENTITIES\r\n${entities}0\r\nENDSEC\r\n0\r\nEOF\r\n`
  }
  function downloadSheetDxf(sheetIdx, sheets = sheetsData, suffix = '') {
    const content = buildSheetDxf(sheetIdx, sheets)
    if (!content) return
    const blob = new Blob([content], { type: 'application/dxf' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${orderFileName(order)}${suffix}_лист${sheetIdx + 1}.dxf`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 30000) // не сразу: на телефоне загрузка может не успеть начаться
  }


  if (!order) return <div className="page"><CncLoader label="Открываем раскрой…" /></div>

  const totalQty = details.reduce((s, d) => s + (Number(d.qty) || 1), 0)
  // кромка: стороны (Дл/Дп — по длине, Шв/Шн — по ширине) + фигурные участки и вырезы; прямая и криволинейная — отдельно
  const edgeSum = edgeTotals(details)
  const edgeByType = edgeSum.byName
  const totalEdge = edgeSum.total
  const offcutCount = sheetsData.filter(sh => sh.stock === 'offcut').length
  const sheetsCount = sheetsData.length - offcutCount
  const totalArea = result ? sheetsData.reduce((a, sh) => { const g = geoOf(order, result, sh); return a + g.usableX * g.usableY / 1e6 }, 0) : 0
  const curParamsKey = paramsKey({
    sheetL: order.sheet_length, sheetW: order.sheet_width, kerf: order.kerf_width,
    marginT: order.margin_top, marginR: order.margin_right, marginB: order.margin_bottom, marginL: order.margin_left,
    offcuts: offcutsValue(offForm),
  })
  const focusIdx = focus ? configs.indexOf(focus) : -1

  // Сравнение конфигураций: «лучший» — меньше листов, затем меньше на последнем
  const sums = configs.map(c => c.result ? summarize(c.sheetsData, c.result.usableX, c.result.usableY) : null)
  const doneSums = configs.map((c, i) => (c.status === 'done' ? sums[i] : null))
  let bestIdx = -1
  if (doneSums.filter(Boolean).length >= 2) doneSums.forEach((s, i) => { if (s && (bestIdx < 0 || betterSummary(s, doneSums[bestIdx]))) bestIdx = i })

  const badge = (text, bg, color) => (
    <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 500, padding: '1px 7px', borderRadius: 8, background: bg, color, verticalAlign: 'middle' }}>{text}</span>
  )
  const pct = v => Math.round(v * 100) + '%'
  const cfgSecs = c => c.status === 'running'
    ? Math.floor((Date.now() - c.startedAt) / 1000)
    : (c.doneAt && c.startedAt ? Math.round((c.doneAt - c.startedAt) / 1000) : null)
  void tick

  // ─── Хронология раскроя: ползунок по времени, проигрывание, возврат, экспорт ──
  function stopPlay() { if (playRef.current) { clearInterval(playRef.current); playRef.current = null } }
  function playHistory(cfgId, from, last) {
    stopPlay()
    let pos = from >= last ? 0 : from
    updateCfg(cfgId, { histPos: pos })
    playRef.current = setInterval(() => {
      pos++
      updateCfg(cfgId, { histPos: pos })
      if (pos >= last) stopPlay()
    }, 700)
  }
  function restoreHistory(cfg, ev) {
    stopPlay()
    updateCfg(cfg.id, {
      sheetsData: ev.sheets.map((sh, i) => ({ ...sh, index: i, freeRects: sh.freeRects || [] })),
      saved: false, activeSheet: 0, selPart: -1, histPos: -1, note: '',
    })
  }

  // Файлы для отладки: мастер-аккаунт скачивает, остальные — отправляют мастер-аккаунту с описанием проблемы
  const debugName = suffix => `${orderFileName(order)}${suffix}`
  function exportHistory(cfg, idx) {
    if (!cfg.history) return
    if (!isMaster) {
      setSendJob({ title: `история раскроя, конфигурация ${idx + 1}`, fileName: debugName(`_k${idx + 1}_history.json`), orderId: id,
        getPayload: () => JSON.stringify(buildHistoryExport(cfg.history, { order, details, cfgIdx: idx })) })
      return
    }
    const data = buildHistoryExport(cfg.history, { order, details, cfgIdx: idx })
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${orderFileName(order)}_k${idx + 1}_history.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 30000) // не сразу: на телефоне загрузка может не успеть начаться
  }

  function renderTimeline(cfg, idx, events, pos, last, ev) {
    const cur = events[pos]
    const fmtT = ms => ms < 60000 ? `${(ms / 1000).toFixed(1)} с` : `${Math.floor(ms / 60000)} мин ${Math.round((ms % 60000) / 1000)} с`
    const pctv = v => Math.round(v * 100) + '%'
    const playing = !!playRef.current
    const btn = { padding: '5px 10px', borderRadius: 'var(--radius)', border: '0.5px solid var(--border-md)',
      background: 'transparent', color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer' }
    return (
      <div style={{ marginTop: 8, padding: 8, borderRadius: 'var(--radius)', background: 'var(--bg2)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
          <span style={{ fontSize: 12, fontWeight: 500 }}>Хронология</span>
          <span style={{ fontSize: 11, color: 'var(--text-hint)' }}>
            {pos + 1} из {events.length} · {cur.kind === 'final' ? 'итог' : cur.kind === 'rough' ? 'черновик' : fmtT(cur.t)}
          </span>
          <div style={{ flex: 1 }} />
          <button onClick={() => playing ? (stopPlay(), updateCfg(cfg.id, {})) : playHistory(cfg.id, pos, last)} style={btn}>
            {playing ? '❚❚' : '▶'}
          </button>
        </div>
        <input type="range" min={0} max={last} step={1} value={pos}
          onChange={e => { stopPlay(); updateCfg(cfg.id, { histPos: Number(e.target.value) }) }}
          style={{ width: '100%', margin: '2px 0' }} />
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {cur.count - (cur.offcuts || 0)} л.{cur.offcuts ? ` + ${cur.offcuts} обр.` : ''} · загрузка {pctv(cur.util)} · на последнем {pctv(cur.lastFill)}
          {cur.island >= 0 && cfg.history.islands > 1 ? ` · поток ${cur.island + 1}` : ''}
          {cur.mode ? ` · режим ${cur.mode}` : ''}
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          {ev && (
            <button onClick={() => restoreHistory(cfg, ev)} disabled={cfg.buffer.length > 0}
              title="Сделать этот момент текущим раскроем"
              style={{ ...btn, flex: 1, border: '0.5px solid var(--blue)', color: 'var(--blue)' }}>
              Взять этот вариант
            </button>
          )}
          {ev && (
            <button onClick={() => { stopPlay(); updateCfg(cfg.id, { histPos: -1 }) }} style={{ ...btn, flex: 1 }}>
              К итогу
            </button>
          )}
          <button onClick={() => exportHistory(cfg, idx)} title="Файл для разработчика: где поиск буксует, ошибки укладки"
            style={{ ...btn, flex: ev ? '0 0 auto' : 1 }}>
            {isMaster ? '⬇ Экспорт истории' : '✉ История — разработчику'}
          </button>
        </div>
      </div>
    )
  }

  function renderConfig(cfg, idx) {
    const isStopping = cfg.status === 'stopping'
    const isRunning = cfg.status === 'running' || isStopping, isQueued = cfg.status === 'queued'
    const s = sums[idx]
    const secs = cfgSecs(cfg)
    // «Мелкие — в центр»: сколько мелких деталей всё же у края листа
    const edgeN = cfg.small && cfg.result && cfg.sheetsData.length
      ? smallAtEdge(cfg.sheetsData, cfg.result.usableX, cfg.result.usableY, true) : null
    const smallTxt = edgeN === null ? '' : edgeN > 0 ? ` · мелкие у края: ${edgeN}` : ' · мелкие в центре ✓'
    let statusLine = 'не считался'
    if (isQueued) statusLine = 'в очереди'
    else if (isStopping) statusLine = 'фиксирую лучший вариант…'
    else if (isRunning) {
      // Сколько уже нет улучшений — подсказка, что можно жать «Стоп» без потери качества
      const idle = cfg.lastImproveAt ? Math.floor((Date.now() - cfg.lastImproveAt) / 1000) : 0
      statusLine = s
        ? `${cfg.live ? 'оптимизирую' : 'считаю'}… ${secs} с · ${countTxt(s)} · загрузка ${pct(s.util)} · на последнем ${pct(s.lastFill)}${smallTxt}`
          + (cfg.rough ? ' · черновик, уточняю' : ` · улучшений ${cfg.improvements}`)
          + (!cfg.rough && idle >= 20 ? ` · без улучшений ${idle} с` : '')
          + (cfg.islands > 1 ? ` · потоков ${cfg.islands}` : '')
        : `считаю… ${secs} с${cfg.islands > 1 ? ` · потоков ${cfg.islands}` : ''}`
    }
    else if (cfg.status === 'error') statusLine = 'ошибка расчёта'
    else if (s) statusLine = `${countTxt(s)} · загрузка ${pct(s.util)} · на последнем ${pct(s.lastFill)}${smallTxt}${secs != null ? ` · ${secs} с` : ''}`
    else if (cfg.result) statusLine = 'результат загружен'

    const canvasSheet = cfg.sheetsData[Math.max(0, Math.min(cfg.activeSheet, cfg.sheetsData.length - 1))]
    const persist = patch => saveSmallPartsSettings(patch)

    return (
      <div key={cfg.id} className="card"
        style={{ marginBottom: 8, padding: 0, overflow: 'hidden', border: idx === bestIdx ? '1px solid var(--teal)' : undefined }}>
        {/* Заголовок — виден всегда, по нажатию раскрывает конфигурацию */}
        <div onClick={() => { updateCfg(cfg.id, { open: !cfg.open }); if (!cfg.open && cfg.result) setFocusId(cfg.id) }}
          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', cursor: 'pointer' }}>
          <span style={{ fontSize: 12, color: 'var(--text-hint)', width: 12 }}>{cfg.open ? '▼' : '▶'}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 500 }}>
              Конфигурация {idx + 1} · {DIR_SHORT[cfg.dir]}
              {idx === bestIdx && badge('★ лучший', 'var(--teal-light)', 'var(--teal)')}
              {cfg.saved && badge('✓ в заказе', '#e6f4ea', '#1e7e34')}
            </div>
            <div style={{ fontSize: 10.5, color: cfg.status === 'error' ? '#dc3545' : 'var(--text-hint)', marginTop: 1 }}>
              {cfg.live ? 'до «Стоп»' : `${cfg.secs === '' ? 12 : cfg.secs} с`}{cfg.small ? ' · мелкие в центр' : ''} · {statusLine}
            </div>
          </div>
          {(isRunning || isQueued) && (
            <span style={{ display: 'inline-block', width: 14, height: 14, borderRadius: '50%', flexShrink: 0,
              border: '2px solid var(--text-hint)', borderTopColor: 'transparent', animation: 'nesting-spin 0.8s linear infinite' }} />
          )}
          <button onClick={e => { e.stopPropagation(); (isRunning || isQueued) ? stopCfg(cfg.id) : runCfg(cfg.id) }}
            disabled={!details.length || isStopping}
            style={{ flexShrink: 0, width: 28, height: 28, borderRadius: '50%', border: '0.5px solid var(--border-md)',
              background: 'var(--bg2)', color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer', padding: 0 }}>
            {(isRunning || isQueued) ? '■' : cfg.result ? '🔄' : '▶'}
          </button>
        </div>

        {cfg.open && (
          <div style={{ padding: '8px 10px 10px', borderTop: '0.5px solid var(--border)' }}>
            {/* Настройки — только когда не считаем (во время расчёта менять их нельзя),
                так кнопка «Стоп», время и карта листов помещаются на экран */}
            {!(isRunning || isQueued) && (<>
            {/* Направление укладки */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
              {DIR_OPTIONS.map(([val, label]) => (
                <button key={val} onClick={() => updateCfg(cfg.id, { dir: val })}
                  style={{ flex: 1, padding: '6px 2px', borderRadius: 'var(--radius)', border: 'none', fontSize: 12,
                    background: cfg.dir === val ? 'var(--blue)' : 'var(--bg2)',
                    color: cfg.dir === val ? 'white' : 'var(--text-muted)', cursor: 'pointer', fontWeight: cfg.dir === val ? 500 : 400 }}>
                  {label}
                </button>
              ))}
            </div>

            {/* Мелкие детали + время оптимизации — в одну строку */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', flex: 1, fontSize: 13 }}>
                <input type="checkbox" checked={cfg.small}
                  onChange={e => {
                    const v = e.target.checked
                    // первые значения-подсказки, если пороги ещё не заданы: 0,12 м² · полоса 200 мм · до края 100 мм
                    if (v && cfg.sq === '' && cfg.side === '') {
                      const sq = sideFromArea('0,12')
                      updateCfg(cfg.id, { small: v, area: '0,12', sq, side: '200', edge: '100' })
                      persist({ small_parts_to_center: v, small_parts_max_square_side: Number(sq) || 0, small_parts_max_side: 200 })
                      persist({ small_parts_edge_gap: 100 })
                    } else { updateCfg(cfg.id, { small: v }); persist({ small_parts_to_center: v }) }
                  }}
                  style={{ width: 17, height: 17, flexShrink: 0 }} />
                Мелкие — в центр
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13, flexShrink: 0 }}
                title="Онлайн-раскрой: поиск идёт, пока не нажмёте «Стоп», каждое улучшение сразу видно на листах">
                <input type="checkbox" checked={cfg.live} disabled={isRunning}
                  onChange={e => updateCfg(cfg.id, { live: e.target.checked })}
                  style={{ width: 17, height: 17, flexShrink: 0 }} />
                До «Стоп»
              </label>
              {!cfg.live && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, flexShrink: 0 }}
                  title="Больше времени — плотнее укладка на первых листах. 0 — быстрый расчёт без доп. оптимизации">
                  с
                  <input type="text" inputMode="numeric" pattern="[0-9]*" value={cfg.secs} placeholder="12"
                    onChange={e => updateCfg(cfg.id, { secs: e.target.value.replace(/[^0-9]/g, '') })}
                    onBlur={e => persist({ optimize_seconds: e.target.value === '' ? 12 : Number(e.target.value) })}
                    style={{ width: 48, fontSize: 14, padding: '3px 6px', boxSizing: 'border-box' }} />
                </label>
              )}
            </div>
            {cfg.small && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 8, alignItems: 'end' }}>
                <label style={{ flex: 1, fontSize: 11, color: 'var(--text-muted)' }}
                  title="Мелкая — деталь площадью не больше этой. Например 0,16 м² — это 400×400 мм или 800×200 мм">
                  Площадь до, м²
                  <input type="text" inputMode="decimal" value={cfg.area} placeholder="0,12"
                    onChange={e => { const v = e.target.value.replace(/[^0-9.,]/g, ''); updateCfg(cfg.id, { area: v, sq: sideFromArea(v) }) }}
                    onBlur={e => { const sd = sideFromArea(e.target.value); persist({ small_parts_max_square_side: sd === '' ? 0 : Number(sd) }) }}
                    style={{ width: '100%', fontSize: 14, padding: '3px 6px', boxSizing: 'border-box', display: 'block' }} />
                </label>
                <label style={{ flex: 1, fontSize: 11, color: 'var(--text-muted)' }}
                  title="Узкая полоса — деталь, у которой меньшая сторона не больше этой (включительно). Её гоним в середину листа: длинной стороной к краю не ставим">
                  Узкая полоса до, мм
                  <input type="text" inputMode="numeric" pattern="[0-9]*" value={cfg.side} placeholder="200"
                    onChange={e => updateCfg(cfg.id, { side: e.target.value.replace(/[^0-9]/g, '') })}
                    onBlur={e => persist({ small_parts_max_side: e.target.value === '' ? 0 : Number(e.target.value) })}
                    style={{ width: '100%', fontSize: 14, padding: '3px 6px', boxSizing: 'border-box', display: 'block' }} />
                </label>
                <label style={{ flex: 1, fontSize: 11, color: 'var(--text-muted)' }}
                  title="Мелкая деталь не ближе этого к краю листа (если между ней и краем нет другой детали)">
                  До края, мм
                  <input type="text" inputMode="numeric" pattern="[0-9]*" value={cfg.edge} placeholder="100"
                    onChange={e => updateCfg(cfg.id, { edge: e.target.value.replace(/[^0-9]/g, '') })}
                    onBlur={e => persist({ small_parts_edge_gap: e.target.value === '' ? 100 : Number(e.target.value) })}
                    style={{ width: '100%', fontSize: 14, padding: '3px 6px', boxSizing: 'border-box', display: 'block' }} />
                </label>
              </div>
            )}
            {cfg.small && cfg.sq === '' && cfg.side === '' && (
              <p style={{ fontSize: 10.5, color: 'var(--text-hint)', margin: '-4px 0 8px' }}>
                Задайте хотя бы один порог — иначе мелких деталей не будет.
              </p>
            )}
            {/* Какие детали попадают в «мелкие» при этих порогах — видно сразу, до запуска */}
            {cfg.small && (cfg.sq !== '' || cfg.side !== '') && (() => {
              const list = smallDetailsOf(details, cfg.sq, cfg.side)
              const n = list.reduce((a, d) => a + (Number(d.qty) || 1), 0)
              const total = details.reduce((a, d) => a + (Number(d.qty) || 1), 0)
              if (!list.length) return (
                <p style={{ fontSize: 10.5, color: '#b45309', margin: '-4px 0 8px' }}>
                  При таких порогах мелких деталей нет — увеличьте площадь или сторону.
                </p>
              )
              return (
                <p style={{ fontSize: 10.5, color: 'var(--text-muted)', margin: '-4px 0 8px', lineHeight: 1.4 }}>
                  Мелкие — {n} из {total} дет.: {list.slice(0, 5).map(d =>
                    `${d.display_name || d.name} ${Math.round(d.length)}×${Math.round(d.width)}${Number(d.qty) > 1 ? ` (${d.qty})` : ''}`).join(', ')}
                  {list.length > 5 ? ` и ещё ${list.length - 5} вид.` : ''}
                  <br />Их не ставим ближе {cfg.edge || 100} мм к краю листа, если между ними и краем нет другой детали.
                  {cfg.side !== '' ? `Узкие полосы (сторона до ${cfg.side} мм включительно) — в середину листа: длинной стороной к краю не ставим, в угол — никогда.` : 'В угол листа — никогда.'}
                  Оставшиеся у края подсвечиваются на карте оранжевым.
                </p>
              )
            })()}
            </>)}

            <div style={{ display: 'flex', gap: 6, marginBottom: cfg.error || cfg.result ? 8 : 0 }}>
              <button onClick={() => (isRunning || isQueued) ? stopCfg(cfg.id) : runCfg(cfg.id)} disabled={!details.length || isStopping}
                style={{ flex: 1, padding: 8, background: isRunning && !isStopping ? '#dc3545' : (isQueued || isStopping) ? 'var(--bg2)' : 'var(--blue)',
                  color: (isQueued || isStopping) ? 'var(--text-muted)' : 'white', border: 'none', borderRadius: 'var(--radius)',
                  fontSize: 13, fontWeight: 500, cursor: isStopping ? 'default' : 'pointer' }}>
                {isStopping ? 'Фиксирую лучший вариант…'
                  : isRunning ? `■ Стоп — зафиксировать (${secs} с)`
                  : isQueued ? '■ Убрать из очереди' : cfg.result ? '🔄 Пересчитать' : '▶ Выполнить раскрой'}
              </button>
              {configs.length > 1 && (
                <button onClick={() => removeCfg(cfg.id)}
                  style={{ padding: '8px 12px', background: 'transparent', color: 'var(--text-hint)',
                    border: '0.5px solid var(--border-md)', borderRadius: 'var(--radius)', fontSize: 12, cursor: 'pointer' }}>
                  Удалить
                </button>
              )}
            </div>
            {cfg.error && (
              <div style={{ padding: 10, marginBottom: 8, borderRadius: 'var(--radius)', background: 'rgba(220,53,69,0.1)', color: '#dc3545', fontSize: 13 }}>
                {cfg.error}
              </div>
            )}

            {/* Результат этой конфигурации */}
            {cfg.result && cfg.sheetsData.length > 0 && canvasSheet && (() => {
              const view = isRunning ? 'all' : cfg.view
              const locked = isRunning || isQueued
              const selPartObj = cfg.selPart >= 0 ? canvasSheet.placed[cfg.selPart] : null
              const selBufObj = cfg.selBuf >= 0 ? cfg.buffer[cfg.selBuf] : null
              const partName = p => `${(p.prefix ? p.prefix + ' ' : '') + String(p.label || '').replace(/Деталь\s*/, 'Д')} ${Math.round(p.origY)}×${Math.round(p.origX)}`
              const chip = (active, color) => ({
                flexShrink: 0, padding: '4px 10px', borderRadius: 16, border: 'none', fontSize: 12, cursor: 'pointer',
                background: active ? color : 'var(--bg2)', color: active ? 'white' : 'var(--text-muted)',
              })
              const openSheet = i => updateCfg(cfg.id, { activeSheet: i, view: 'sheet', selPart: -1, note: '' })
              // Хронология: какой момент показан на обзоре листов
              const hist = !isRunning ? cfg.history : null
              const hEvents = hist?.events || []
              const hLast = hEvents.length - 1
              const hPos = hist && cfg.histPos >= 0 && cfg.histPos <= hLast ? cfg.histPos : hLast
              const hEvent = hist && hPos < hLast ? hEvents[hPos] : null // null — показываем текущий результат
              const overviewSheets = hEvent ? hEvent.sheets : cfg.sheetsData
              const geo = geoOf(order, cfg.result)                 // обычный лист
              const cgeo = geoOf(order, cfg.result, canvasSheet)   // открытый лист (может быть обрезком)
              const stale = cfg.result.paramsKey && cfg.result.paramsKey !== curParamsKey && !isRunning
              return (
              <div>
                {stale && (
                  <p style={{ fontSize: 11, color: '#9a5b00', background: '#fff3d6', border: '1px solid #f0c674',
                    borderRadius: 6, padding: '4px 8px', margin: '0 0 8px' }}>
                    Параметры листа или обрезки изменились после расчёта — пересчитайте раскрой
                  </p>
                )}
                {cfg.result.algo === 'nfp' && (
                  <p style={{
                    fontSize: 11, fontWeight: 600, color: '#9a5b00', background: '#fff3d6',
                    border: '1px solid #f0c674', borderRadius: 6, padding: '4px 8px', margin: '0 0 8px',
                  }}>
                    ⚠ NFP (экспериментальный алгоритм) — не основной, только для сравнения
                  </p>
                )}
                {(cfg.result.algoVersion || 'до версионирования') !== NESTING_VERSION && (
                  <p style={{ fontSize: 11, color: 'var(--text-hint)', margin: '0 0 8px' }}>
                    Этот раскрой посчитан: {cfg.result.algoVersion ? 'v' + cfg.result.algoVersion : 'до версионирования'}
                  </p>
                )}
                <div style={{ background: 'transparent', borderRadius: 'var(--radius)', padding: 6, marginBottom: 6, border: '0.5px solid var(--border)' }}>
                  {/* Переключатель вида: все листы / один лист для правки */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                    <div style={{ display: 'flex', background: 'var(--bg2)', borderRadius: 16, padding: 2 }}>
                      <button onClick={() => updateCfg(cfg.id, { view: 'all', selPart: -1 })}
                        style={{ ...chip(view === 'all', 'var(--blue)'), padding: '3px 10px' }}>
                        Все листы · {cfg.sheetsData.length}
                      </button>
                      <button onClick={() => !locked && openSheet(cfg.activeSheet)} disabled={locked}
                        style={{ ...chip(view === 'sheet', 'var(--blue)'), padding: '3px 10px', opacity: locked ? 0.5 : 1 }}>
                        {canvasSheet.stock === 'offcut' ? 'Обрезок' : 'Лист'} {cfg.activeSheet + 1}
                      </button>
                    </div>
                    <div style={{ flex: 1 }} />
                    {view === 'sheet' && canvasSheet.placed.length === 0 && cfg.sheetsData.length > 1 && (
                      <button onClick={() => deleteEmptySheet(cfg.id, cfg.activeSheet)}
                        style={{ padding: '4px 10px', borderRadius: 20, border: '0.5px solid #dc3545',
                          background: 'transparent', color: '#dc3545', fontSize: 11, cursor: 'pointer' }}>
                        🗑 Удалить пустой лист
                      </button>
                    )}
                    {view === 'sheet' && (
                      <>
                        {isMaster && <button onClick={() => downloadSheetDxf(cfg.activeSheet, cfg.sheetsData, `_k${idx + 1}`)}
                          style={{ padding: '4px 10px', borderRadius: 20, border: '0.5px solid var(--border-md)',
                            background: 'transparent', color: 'var(--text-hint)', fontSize: 11, cursor: 'pointer' }}>
                          DXF
                        </button>}
                        <button onClick={() => setShowOffcuts(v => !v)}
                          style={{ padding: '4px 10px', borderRadius: 20, border: `0.5px solid ${showOffcuts ? 'var(--teal)' : 'var(--border-md)'}`,
                            background: showOffcuts ? 'var(--teal-light)' : 'transparent',
                            color: showOffcuts ? 'var(--teal)' : 'var(--text-hint)', fontSize: 11, cursor: 'pointer' }}>
                          {showOffcuts ? '✓ Обрезки' : 'Обрезки'}
                        </button>
                      </>
                    )}
                  </div>
                  {/* Что писать на деталях — отдельной строкой, чтобы не закрывать кнопки */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6, marginBottom: 6, fontSize: 11, color: 'var(--text-hint)' }}>
                    Подпись на деталях:
                    <select value={labelMode} onChange={e => setLabelMode(e.target.value)}
                      style={{ width: 'auto', padding: '2px 4px', fontSize: 11, color: 'var(--text-muted)' }}>
                      {LABEL_MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 4, margin: '0 0 0 6px', fontSize: 11, color: 'var(--text-hint)' }}>
                      <input type="checkbox" checked={showEdges} onChange={e => toggleEdges(e.target.checked)} style={{ width: 'auto' }} />
                      Кромка
                    </label>
                  </div>

                  {view === 'all' ? (
                    <>
                      <SheetsOverview
                        sheets={overviewSheets}
                        usableX={geo.usableX} usableY={geo.usableY}
                        sheetL={geo.sheetL} sheetW={geo.sheetW}
                        marginL={geo.marginL} marginT={geo.marginT} kerf={geo.kerf}
                        activeSheet={locked || hEvent ? -1 : cfg.activeSheet}
                        onPickSheet={locked || hEvent ? null : openSheet}
                        running={isRunning} bufferCount={cfg.buffer.length}
                        details={details} labelMode={labelMode}
                      />
                      <p style={{ fontSize: 10, color: 'var(--text-hint)', textAlign: 'center', marginTop: 4, marginBottom: 0 }}>
                        {isRunning
                          ? 'Идёт поиск: при более плотной укладке детали переезжают на новые места · «Стоп» — зафиксировать лучший вариант'
                          : hEvent ? 'Просмотр хронологии — правка недоступна' : 'Тап по листу — открыть для правки · щипок или −/+ — больше/меньше листов в ряд'}
                      </p>
                      {hist && hEvents.length > 0 && renderTimeline(cfg, idx, hEvents, hPos, hLast, hEvent)}
                    </>
                  ) : (
                    <>
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
                          {offcutMode === 'manual' && canvasSheet.manualOffcuts?.length > 0 && (
                            <button onClick={() => onManualOffcutsCfg(cfg.id, cfg.activeSheet, [])}
                              style={{ padding: '5px 10px', borderRadius: 'var(--radius)', border: '0.5px solid var(--border-md)',
                                background: 'transparent', color: 'var(--text-hint)', fontSize: 11, cursor: 'pointer' }}>
                              Очистить ({canvasSheet.manualOffcuts.length})
                            </button>
                          )}
                        </div>
                      )}
                      <SheetCanvas
                        key={cfg.id}
                        sheet={canvasSheet}
                        usableX={cgeo.usableX} usableY={cgeo.usableY}
                        sheetL={cgeo.sheetL} sheetW={cgeo.sheetW}
                        marginL={cgeo.marginL} marginT={cgeo.marginT}
                        kerf={cgeo.kerf} colorMap={colorMap} details={details} labelMode={labelMode} showEdges={showEdges}
                        onMove={(si, np) => onMoveCfg(cfg.id, si, np)} interactive={true} showOffcuts={showOffcuts}
                        offcutMode={offcutMode} manualOffcuts={canvasSheet.manualOffcuts}
                        onManualOffcuts={(si, list) => onManualOffcutsCfg(cfg.id, si, list)}
                        selectedIdx={cfg.selPart}
                        onSelect={i => updateCfg(cfg.id, { selPart: i, note: '' })}
                        onEditPart={locked ? null : openPart3d}
                      />
                      <p style={{ fontSize: 10, color: 'var(--text-hint)', textAlign: 'center', marginTop: 4, marginBottom: 0 }}>
                        {showOffcuts && offcutMode === 'manual'
                          ? 'Удержи палец на свободном месте — обрезок · удержи на выбранном — снять его'
                          : (showOffcuts && offcutMode === 'cuts'
                            ? 'Линии реза учитывают детали и выбранные обрезки и пересчитываются по текущей карте · красный пунктир — участок без сквозного реза'
                            : 'Тап — выделить (для буфера) · двойной тап — поворот · удержи и тяни — перенос · долго держи на месте — редактор контура · щипок — масштаб · фиолетовый фон — обработка с двух сторон (на карте показана только лицевая; изнанку видно в редакторе)')}
                      </p>
                    </>
                  )}
                </div>

                {/* Переключатель листов — под картой, чтобы палец не закрывал карту */}
                {!locked && (
                  <div style={{ display: 'flex', gap: 5, marginBottom: 8, overflowX: 'auto', paddingBottom: 2 }}>
                    {cfg.sheetsData.map((sh, i) => (
                      <button key={i} onClick={() => openSheet(i)}
                        style={chip(view === 'sheet' && cfg.activeSheet === i, 'var(--blue)')}>
                        {sh.stock === 'offcut' ? 'Обр.' : 'Лист'} {i + 1} · {sh.placed.length ? sh.placed.length : 'пусто'}
                      </button>
                    ))}
                  </div>
                )}

                {/* Буфер деталей — перенос деталей между листами */}
                {!locked && (view === 'sheet' || cfg.buffer.length > 0) && (
                  <div style={{ border: '1px dashed #B85C00', borderRadius: 'var(--radius)', padding: 8, marginBottom: 8, background: 'rgba(184,92,0,0.04)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: (cfg.buffer.length || selPartObj) ? 6 : 0 }}>
                      <span style={{ fontSize: 12, fontWeight: 500, color: '#B85C00' }}>Буфер · {cfg.buffer.length}</span>
                      <div style={{ flex: 1 }} />
                      {view === 'sheet' && selPartObj && (
                        <button onClick={() => toBuffer(cfg.id)}
                          style={{ padding: '5px 10px', borderRadius: 'var(--radius)', border: 'none', background: '#B85C00',
                            color: 'white', fontSize: 12, fontWeight: 500, cursor: 'pointer', maxWidth: '70%',
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          ⬇ В буфер: {partName(selPartObj)}
                        </button>
                      )}
                    </div>
                    {cfg.buffer.length > 0 && (
                      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: selBufObj ? 6 : 0 }}>
                        {cfg.buffer.map((p, i) => (
                          <button key={i} onClick={() => updateCfg(cfg.id, { selBuf: cfg.selBuf === i ? -1 : i, note: '' })}
                            style={{ ...chip(cfg.selBuf === i, '#B85C00'), fontSize: 11, padding: '3px 9px' }}>
                            {partName(p)}
                          </button>
                        ))}
                      </div>
                    )}
                    {selBufObj && (
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button onClick={() => fromBuffer(cfg.id, false)} disabled={view !== 'sheet'}
                          style={{ flex: 1, padding: 7, borderRadius: 'var(--radius)', border: 'none', fontSize: 12, fontWeight: 500,
                            background: view === 'sheet' ? 'var(--blue)' : 'var(--bg2)', color: view === 'sheet' ? 'white' : 'var(--text-hint)',
                            cursor: view === 'sheet' ? 'pointer' : 'default' }}>
                          {view === 'sheet' ? `⬆ На лист ${cfg.activeSheet + 1}` : 'Откройте лист'}
                        </button>
                        <button onClick={() => fromBuffer(cfg.id, true)}
                          style={{ flex: 1, padding: 7, borderRadius: 'var(--radius)', border: '0.5px solid var(--blue)', fontSize: 12,
                            background: 'transparent', color: 'var(--blue)', cursor: 'pointer' }}>
                          + На новый лист
                        </button>
                      </div>
                    )}
                    {cfg.note && <p style={{ fontSize: 11, color: '#dc3545', margin: '6px 0 0' }}>{cfg.note}</p>}
                    {!cfg.buffer.length && !selPartObj && (
                      <p style={{ fontSize: 10.5, color: 'var(--text-hint)', margin: 0 }}>
                        Тап по детали на листе → «В буфер». Затем откройте другой лист и положите её туда.
                      </p>
                    )}
                  </div>
                )}

                {/* Легенда — свёрнута, чтобы не растягивать страницу */}
                {view === 'sheet' && (
                  <details style={{ marginBottom: 8 }}>
                    <summary style={{ fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer', padding: '2px 0' }}>
                      Детали на листе {cfg.activeSheet + 1} ({canvasSheet.placed.length})
                    </summary>
                    {canvasSheet.placed.map((p, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, padding: '2px 0', borderBottom: '0.5px solid var(--border)' }}>
                        <div style={{ width: 10, height: 10, borderRadius: 3, background: colorMap[p.detailIndex], flexShrink: 0 }} />
                        <span style={{ flex: 1 }}>{labelMode === 'name' || labelMode === 'none' ? p.label : `${partLabel(p, details, labelMode)}${labelMode === 'des_name' ? '' : ' · ' + p.label}`}</span>
                        <span style={{ color: 'var(--text-hint)' }}>{Math.round(p.origY)}×{Math.round(p.origX)}</span>
                        {(p.rotation || p.rotated) && <span style={{ color: 'var(--teal)', fontSize: 11 }}>↻{p.rotation ?? 90}°</span>}
                      </div>
                    ))}
                  </details>
                )}

                {cfg.buffer.length > 0 && (
                  <p style={{ fontSize: 11, color: '#B85C00', margin: '0 0 6px' }}>
                    В буфере {cfg.buffer.length} дет. — разложите их по листам, иначе сохранить раскрой нельзя.
                  </p>
                )}

                {/* Результат проверки раскроя (для текущей раскладки и станка) */}
                {cfg.check && cfg.check.for === cfg.sheetsData && cfg.check.method === cuttingMethod && (
                  cfg.check.ok ? (
                    <>
                      <p style={{ fontSize: 11, color: '#1e7e34', margin: '0 0 6px' }}>
                        ✓ Проверено: {cfg.check.stats.placed} из {cfg.check.stats.total} деталей на месте, пересечений нет,
                        зазор на рез и отступы выдержаны{cuttingMethod === 'guillotine' ? ', все листы режутся насквозь' : ''}
                      </p>
                      {cfg.check.warnings?.length > 0 && (
                        <p style={{ fontSize: 11, color: '#b45309', margin: '-2px 0 6px' }}>
                          {cfg.check.warnings.join(' · ')}
                        </p>
                      )}
                    </>
                  ) : (
                    <div style={{ padding: 8, marginBottom: 8, borderRadius: 'var(--radius)', background: 'rgba(220,53,69,0.08)', border: '1px solid rgba(220,53,69,0.4)' }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: '#dc3545', marginBottom: 4 }}>
                        ⚠ Раскрой с ошибками — проверьте перед отправкой в производство
                      </div>
                      {cfg.check.errors.map((e, i) => (
                        <div key={i} style={{ fontSize: 11, color: '#a71d2a', padding: '1px 0' }}>• {e}</div>
                      ))}
                      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                        <button onClick={() => chooseCfg(cfg, true)} disabled={busyId === cfg.id}
                          style={{ flex: 1, padding: 6, borderRadius: 'var(--radius)', border: '0.5px solid #dc3545', background: 'transparent', color: '#dc3545', fontSize: 11, cursor: 'pointer' }}>
                          Всё равно сохранить
                        </button>
                        <button onClick={() => submitOrder(cfg, true)} disabled={busyId === cfg.id}
                          style={{ flex: 1, padding: 6, borderRadius: 'var(--radius)', border: 'none', background: '#dc3545', color: 'white', fontSize: 11, cursor: 'pointer' }}>
                          Всё равно оформить
                        </button>
                      </div>
                    </div>
                  )
                )}

                {/* DXF (мастер-аккаунт) · выбрать вариант · оформить — в одну строку */}
                {(() => {
                  const blocked = locked || cfg.buffer.length > 0 || busyId === cfg.id
                  return (
                    <div style={{ display: 'flex', gap: 6, opacity: locked ? 0.5 : 1 }}>
                      {isMaster && <button onClick={() => downloadNestingDxf(cfg.sheetsData.filter(sh => sh.placed.length), `_k${idx + 1}`)}
                        disabled={locked}
                        title="Скачать DXF всех листов (для сверки) — только мастер-аккаунт"
                        style={{ flex: '0 0 auto', padding: '9px 10px', borderRadius: 'var(--radius)', border: '0.5px solid var(--teal)',
                          background: 'var(--teal-light)', color: 'var(--teal)', fontSize: 12, fontWeight: 500, cursor: 'pointer' }}>
                        ⬇ DXF
                      </button>}
                      <button onClick={() => chooseCfg(cfg)} disabled={blocked || cfg.saved}
                        title="Сохранить этот раскрой в заказ; остальные конфигурации остаются на экране"
                        style={{ flex: 1, padding: 9, borderRadius: 'var(--radius)', fontSize: 13, fontWeight: 500,
                          cursor: (blocked || cfg.saved) ? 'default' : 'pointer',
                          border: '0.5px solid var(--teal)',
                          background: cfg.saved ? '#e6f4ea' : 'var(--teal-light)', color: cfg.saved ? '#1e7e34' : 'var(--teal)' }}>
                        {cfg.saved ? '✓ Выбран' : busyId === cfg.id ? 'Сохранение…' : 'Выбрать'}
                      </button>
                      {order.status !== 'draft' ? (canProduce && <>
                        <button onClick={() => goProduce(cfg, 'cnc')} disabled={blocked} title="Управляющие программы для станка с ЧПУ"
                          style={{ flex: 1, padding: 9, background: 'var(--blue)', color: 'white', border: 'none', borderRadius: 'var(--radius)', fontSize: 13, fontWeight: 500, cursor: blocked ? 'default' : 'pointer' }}>
                          ЧПУ
                        </button>
                        <button onClick={() => goProduce(cfg, 'labels')} disabled={blocked} title="Бирки деталей"
                          style={{ flex: 1, padding: 9, background: 'var(--bg)', color: 'var(--blue)', border: '0.5px solid var(--blue)', borderRadius: 'var(--radius)', fontSize: 13, fontWeight: 500, cursor: blocked ? 'default' : 'pointer' }}>
                          Бирки
                        </button>
                      </>) :
                      <button onClick={() => submitOrder(cfg)} disabled={blocked}
                        title="Сохранить раскрой и отправить заказ на производство"
                        style={{ flex: 1, padding: 9, background: 'var(--teal)', color: 'white', border: 'none',
                          borderRadius: 'var(--radius)', fontSize: 13, fontWeight: 500, cursor: blocked ? 'default' : 'pointer' }}>
                        {busyId === cfg.id ? 'Отправка…' : '✓ Оформить'}
                      </button>}
                    </div>
                  )
                })()}
              </div>
              )
            })()}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="page" style={{ paddingBottom: 100 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, paddingTop: 4 }}>
        <button onClick={() => navigate(`/orders/${id}`)}
          style={{ background: 'none', border: 'none', color: 'var(--blue)', fontSize: 22, padding: 0, cursor: 'pointer' }}>←</button>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 500 }}>Раскрой</div>
          <div style={{ fontSize: 12, color: 'var(--text-hint)' }}>{orderTitle(order)}</div>
        </div>
        {/* черновик можно править: название, материал, детали, кромку */}
        {order?.status === 'draft' && (!order.user_id || order.user_id === user?.id || profile?.role === 'admin') && (
          <button type="button" onClick={() => navigate(`/orders/${id}/edit`)}
            style={{ fontSize: 12, color: 'var(--blue)', background: 'none', border: '0.5px solid var(--blue-mid)', borderRadius: 20, padding: '3px 10px', whiteSpace: 'nowrap', cursor: 'pointer' }}>✎ Править заказ</button>
        )}
        {/* 3D открывается поверх страницы — раскрой при этом не сбрасывается */}
        <Model3DButton details={allDetails} title={orderTitle(order)} getScene={() => loadOrderModel(id)} orderId={id}
          saveToOrder={order?.status === 'draft'} order={order} materialThickness={Number(order?.material_thickness) || 16} onSaved={() => window.location.reload()} />
      </div>

      {order?.status === 'draft' && order.returned_at && (
        <div style={{ fontSize: 12, color: 'var(--amber)', background: 'var(--amber-light)', border: '0.5px solid var(--amber)', borderRadius: 'var(--radius)', padding: '6px 10px', marginBottom: 8 }}>
          ↩ Производство вернуло заказ на доработку{order.return_note ? `: ${order.return_note}` : ''}. Поправьте заказ («✎ Править заказ») и оформите его заново.
        </div>
      )}

      {/* Статистика */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, marginBottom: focus && configs.length > 1 ? 3 : 8 }}>
        {[[offcutCount ? 'Листов + обр.' : 'Листов', sheetsData.length ? (offcutCount ? `${sheetsCount}+${offcutCount}` : sheetsCount) : '—'],['Деталей', totalQty],['Кромка, м', totalEdge.toFixed(1)],['Площадь, м²', totalArea ? totalArea.toFixed(2) : '—']].map(([label, val]) => (
          <div key={label} style={{ background: 'var(--bg2)', borderRadius: 'var(--radius)', padding: '5px 8px' }}>
            <div style={{ fontSize: 10, color: 'var(--text-hint)', whiteSpace: 'nowrap' }}>{label}</div>
            <div style={{ fontSize: 16, fontWeight: 500, lineHeight: 1.2 }}>{val}</div>
          </div>
        ))}
      </div>
      {focus && configs.length > 1 && (
        <p style={{ fontSize: 10, color: 'var(--text-hint)', margin: '0 0 8px' }}>
          Листы и площадь — по конфигурации {focusIdx + 1} ({DIR_SHORT[focus.dir]})
        </p>
      )}

      {/* Кромка по типам */}
      {Object.keys(edgeByType).length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 8 }}>
          {Object.entries(edgeByType).map(([name, len]) => (
            <span key={name} style={{ fontSize: 11, background: 'var(--bg2)', borderRadius: 10, padding: '2px 9px', color: 'var(--text-muted)' }}>
              {name} · <span style={{ fontWeight: 500 }}>{len.total.toFixed(1)} м</span>{len.curved > 0.005 ? ` (крив. ${len.curved.toFixed(1)})` : ''}
            </span>
          ))}
        </div>
      )}

      {/* Производство, лист, рез, отступы, обрезки — общие для всех конфигураций */}
      {(() => {
        const prod = order.production_id ? productions.find(x => x.id === order.production_id) : null
        const isLocked = key => anyRunning || (!!prod && PROD_LOCKED.includes(key)) // производство задаёт рез и отступы
        const offLocked = anyRunning
        const inp = { width: '100%', fontSize: 14, padding: '4px 6px', boxSizing: 'border-box', display: 'block' }
        const lbl = { flex: 1, minWidth: 0, fontSize: 11, color: 'var(--text-muted)' }
        const field = (key, label, title) => (
          <label style={lbl} title={title}>
            {label}
            <input type="text" inputMode="decimal" value={sheetForm[key]} disabled={isLocked(key)}
              onChange={e => { const v = e.target.value.replace(/[^0-9.,]/g, ''); setSheetForm(f => ({ ...f, [key]: v })) }}
              onBlur={() => commitSheetField(key)}
              style={{ ...inp, opacity: isLocked(key) ? 0.55 : 1 }} />
          </label>
        )
        const ov = offcutsValue(offForm)
        const offN = ov.items.reduce((a, it) => a + it.qty, 0)
        const setItem = (i, k, v) => setOffForm(f => ({ ...f, items: f.items.map((it, j) => j === i ? { ...it, [k]: v } : it) }))
        const summary = `${order.sheet_length}×${order.sheet_width} · рез ${order.kerf_width} · отступы ${order.margin_left}/${order.margin_right}/${order.margin_top}/${order.margin_bottom}`
          + (offN ? ` · обрезков ${offN}` : '') + (prod ? ` · ${prod.name}` : '')
        return (
          <div className="card" style={{ marginBottom: 8, padding: 0, overflow: 'hidden' }}>
            <div onClick={() => setSheetOpen(v => !v)}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', cursor: 'pointer' }}>
              <span style={{ fontSize: 12, color: 'var(--text-hint)', width: 12 }}>{sheetOpen ? '▼' : '▶'}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>Лист и обрезки</div>
                {!sheetOpen && <div style={{ fontSize: 10.5, color: 'var(--text-hint)', marginTop: 1 }}>{summary}</div>}
              </div>
            </div>
            {sheetOpen && (
              <div style={{ padding: '8px 10px 10px', borderTop: '0.5px solid var(--border)' }}>
                {productions.length > 0 && (
                  <label style={{ ...lbl, display: 'block', marginBottom: 8 }}>
                    Производство
                    <select value={prod ? prod.id : ''} disabled={anyRunning}
                      onChange={e => chooseProduction(e.target.value)}
                      style={{ ...inp, padding: '5px 6px' }}>
                      <option value="">— не выбрано (свои параметры) —</option>
                      {productions.filter(pr => (pr.status ?? 'approved') === 'approved' || pr.id === order.production_id).map(pr => <option key={pr.id} value={pr.id}>{pr.name}</option>)}
                    </select>
                  </label>
                )}
                {prod && (
                  <p style={{ fontSize: 10.5, color: 'var(--text-hint)', margin: '-4px 0 8px' }}>
                    Рез и отступы задаёт производство «{prod.name}». Формат листа можно менять — например, под свой материал.
                  </p>
                )}
                <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                  {field('L', 'Длина листа, мм', 'Вертикаль на карте')}
                  {field('W', 'Ширина листа, мм', 'Горизонталь на карте')}
                  {field('kerf', 'Рез, мм', 'Ширина реза (диаметр фрезы / толщина пилы) — зазор между деталями')}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>Отступы от края листа, мм</div>
                <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                  {field('ml', '← слева')}
                  {field('mr', '→ справа')}
                  {field('mt', '↑ сверху')}
                  {field('mb', '↓ снизу')}
                </div>

                <div style={{ borderTop: '0.5px dashed var(--border-md)', paddingTop: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 2 }}>Обрезки со склада</div>
                  <p style={{ fontSize: 10.5, color: 'var(--text-hint)', margin: '0 0 6px' }}>
                    Раскраиваются первыми (крупные — раньше), как отдельные листы. На целые листы идёт то, что не поместилось.
                  </p>
                  {offForm.items.map((it, i) => (
                    <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'flex-end', marginBottom: 6 }}>
                      {[['length', 'Длина, мм'], ['width', 'Ширина, мм'], ['qty', 'Шт.']].map(([k, t]) => (
                        <label key={k} style={{ ...lbl, flex: k === 'qty' ? '0 0 52px' : 1 }}>
                          {i === 0 ? t : ''}
                          <input type="text" inputMode="numeric" value={it[k]} disabled={offLocked}
                            onChange={e => setItem(i, k, e.target.value.replace(/[^0-9]/g, ''))}
                            onBlur={() => commitOffcuts()}
                            style={inp} />
                        </label>
                      ))}
                      <button disabled={offLocked}
                        onClick={() => { const f = { ...offForm, items: offForm.items.filter((_, j) => j !== i) }; setOffForm(f); commitOffcuts(f) }}
                        style={{ flexShrink: 0, width: 30, height: 30, borderRadius: 'var(--radius)', border: '0.5px solid var(--border-md)',
                          background: 'transparent', color: 'var(--text-hint)', fontSize: 13, cursor: 'pointer', padding: 0 }}>✕</button>
                    </div>
                  ))}
                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                    <button disabled={offLocked}
                      onClick={() => setOffForm(f => ({ ...f, items: [...f.items, { length: '', width: '', qty: '1' }] }))}
                      style={{ flex: 1, padding: 7, borderRadius: 'var(--radius)', border: '0.5px dashed var(--border-md)',
                        background: 'transparent', color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer' }}>
                      + Добавить обрезок
                    </button>
                    {offForm.items.length > 0 && (
                      <label style={{ ...lbl, flex: '0 0 120px' }} title="Отступ от края обрезка (со всех сторон)">
                        Отступ от края, мм
                        <input type="text" inputMode="decimal" value={offForm.margin} disabled={offLocked}
                          onChange={e => { const v = e.target.value.replace(/[^0-9.,]/g, ''); setOffForm(f => ({ ...f, margin: v })) }}
                          onBlur={() => commitOffcuts()}
                          style={inp} />
                      </label>
                    )}
                  </div>
                  {offForm.items.some(it => it.length !== '' && it.width !== '' && (Number(it.length) <= 2 * ov.margin || Number(it.width) <= 2 * ov.margin)) && (
                    <p style={{ fontSize: 10.5, color: '#b45309', margin: '6px 0 0' }}>Обрезок меньше двух отступов — он не будет использован.</p>
                  )}
                </div>
                {paramsWarn && (
                  <p style={{ fontSize: 10.5, color: '#b45309', margin: '8px 0 0' }}>{paramsWarn}</p>
                )}
              </div>
            )}
          </div>
        )
      })()}

      {/* Материал: в заказе несколько листовых материалов — раскраиваем по одному */}
      {multiMat && (
        <div style={{ marginBottom: 8 }}>
          <label className="label" style={{ marginBottom: 3 }}>Материал</label>
          <select value={matKey} disabled={anyRunning} onChange={e => chooseMaterial(e.target.value)}
            style={{ width: '100%', padding: '8px 8px', fontSize: 14 }}>
            {materials.map(m => (
              <option key={m.key} value={m.key}>{savedByMat[m.key] ? '✓ ' : ''}{m.label} — {m.pieces} шт.</option>
            ))}
          </select>
          <p style={{ fontSize: 11, color: 'var(--text-hint)', margin: '3px 0 0' }}>
            Раскрой считается и сохраняется отдельно для каждого материала. Выбрано: {materials.filter(m => savedByMat[m.key]).length} из {materials.length}.
          </p>
        </div>
      )}

      {/* Тип станка — общий для всех конфигураций */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        {[['nesting', 'Фрезер (ЧПУ)'], ['guillotine', 'Пила (форматник)']].map(([val, label]) => (
          <div key={val} onClick={() => { setCuttingMethod(val); saveSmallPartsSettings({ cutting_method: val }) }}
            title={val === 'guillotine' ? 'Только сквозные резы через весь лист/полосу' : 'Свободная укладка для резки фрезой по любому контуру'}
            style={{ flex: 1, padding: '6px 4px', borderRadius: 'var(--radius)', textAlign: 'center',
              fontSize: 12, cursor: 'pointer',
              background: cuttingMethod === val ? 'var(--blue)' : 'var(--bg2)',
              color: cuttingMethod === val ? 'white' : 'var(--text-muted)', fontWeight: cuttingMethod === val ? 500 : 400 }}>
            {label}
          </div>
        ))}
      </div>

      {/* Конфигурации раскроя */}
      <p className="section-title" style={{ margin: '0 0 6px' }}>Конфигурации раскроя</p>
      {configs.map((cfg, idx) => renderConfig(cfg, idx))}

      <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
        <button onClick={addCfg}
          style={{ flex: 1, padding: 8, borderRadius: 'var(--radius)', border: '0.5px dashed var(--border-md)',
            background: 'transparent', color: 'var(--text-muted)', fontSize: 13, cursor: 'pointer' }}>
          + Новая конфигурация
        </button>
        <button onClick={runAll} disabled={anyRunning || !details.length}
          style={{ flex: 1, padding: 8, borderRadius: 'var(--radius)', border: 'none', fontSize: 13, fontWeight: 500,
            background: (anyRunning || !details.length) ? 'var(--bg2)' : 'var(--blue)',
            color: (anyRunning || !details.length) ? 'var(--text-hint)' : 'white',
            cursor: (anyRunning || !details.length) ? 'default' : 'pointer' }}>
          {anyRunning ? 'Считаю…' : configs.length > 1 ? '▶ Запустить все' : '▶ Выполнить раскрой'}
        </button>
      </div>
      {configs.length > 1 && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', marginBottom: 4, fontSize: 12, color: 'var(--text-muted)' }}
          title="Время оптимизации идёт по часам: на слабом телефоне при одновременном расчёте каждая конфигурация получает меньше вычислений. Если результат хуже — снимите галочку, конфигурации пойдут по очереди.">
          <input type="checkbox" checked={parallel} onChange={e => setParallel(e.target.checked)}
            style={{ width: 16, height: 16, flexShrink: 0 }} />
          Считать одновременно (на слабом телефоне — по очереди)
        </label>
      )}
      <div style={{ fontSize: 10, color: 'var(--text-hint)', textAlign: 'center', margin: '2px 0 8px' }}>
        Алгоритм раскроя v{NESTING_VERSION}
      </div>
      <style>{`@keyframes nesting-spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }`}</style>

      {/* Список деталей — под картами, свёрнут */}
      {details.length > 0 && (
        <div className="card" style={{ marginBottom: 12, padding: 0, overflow: 'hidden' }}>
          <div onClick={() => setPartsOpen(v => !v)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', cursor: 'pointer' }}>
            <span style={{ fontSize: 12, color: 'var(--text-hint)', width: 12 }}>{partsOpen ? '▼' : '▶'}</span>
            <div style={{ flex: 1, fontSize: 13, fontWeight: 500 }}>Список деталей</div>
            <span style={{ fontSize: 11, color: 'var(--text-hint)' }}>{details.length} поз. · {totalQty} шт.</span>
          </div>
          {partsOpen && (
            <div style={{ borderTop: '0.5px solid var(--border)', padding: '8px 10px 4px' }}>
              <select value={partsSort} onChange={e => setPartsSort(e.target.value)} style={{ width: '100%', padding: '6px 8px', fontSize: 13, marginBottom: 6 }}>
                <option value="">Как в заказе</option>
                {SORT_MODES.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
              </select>
              {sortDetails(details.map((d, i) => ({ ...d, __i: i })), partsSort).map(d => {
                const m = detailMeta(d), ed = edgeTotals([{ ...d, qty: 1 }])
                return (
                  <div key={d.__i} onClick={anyRunning ? undefined : () => openPart3d(d.__i)}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderTop: '0.5px solid var(--border)', cursor: anyRunning ? 'default' : 'pointer' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {m?.des ? <span style={{ fontFamily: 'monospace', color: 'var(--text-hint)', marginRight: 6 }}>{m.des}</span> : null}{d.name || 'Деталь'}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-hint)' }}>
                        {d.length}×{d.width}{ed.total > 0 ? ` · кромка ${ed.total.toFixed(2)} м${ed.curved > 0 ? ` (крив. ${ed.curved.toFixed(2)})` : ''}` : ''}
                      </div>
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{d.qty} шт.</div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* Экспорт контуров для отладки — скопировать точные координаты детали разработчику */}
      {details.some(d => d.contour) && (
        <div style={{ marginBottom: 12 }}>
          <button onClick={() => isMaster ? setShowDebugExport(v => !v) : setSendJob({ title: 'Контуры деталей', fileName: `contours_${orderFileName(order)}.json`, getPayload: () => debugExportText, orderId: id })}
            style={{ width: '100%', padding: '8px 10px', borderRadius: 'var(--radius)', border: '0.5px solid var(--border-md)',
              background: 'transparent', color: 'var(--text-hint)', fontSize: 12, cursor: 'pointer', textAlign: 'left' }}>
            {isMaster ? (showDebugExport ? '▼ ' : '▶ ') : '✉ '}Экспорт контуров деталей (для отладки)
          </button>
          {isMaster && showDebugExport && (
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

      {/* Экспорт РЕЗУЛЬТАТА укладки (по конфигурации, выбранной для шапки) */}
      {result && (
        <div style={{ marginBottom: 12 }}>
          <button onClick={() => isMaster ? setShowResultExport(v => !v) : setSendJob({ title: 'Результат раскроя', fileName: `nesting_${orderFileName(order)}.json`, getPayload: () => resultExportText, orderId: id })}
            style={{ width: '100%', padding: '8px 10px', borderRadius: 'var(--radius)', border: '0.5px solid var(--border-md)',
              background: 'transparent', color: 'var(--text-hint)', fontSize: 12, cursor: 'pointer', textAlign: 'left' }}>
            {isMaster ? (showResultExport ? '▼ ' : '▶ ') : '✉ '}Экспорт результата раскроя (для отладки){configs.length > 1 ? ` — конфигурация ${focusIdx + 1}` : ''}
          </button>
          {isMaster && showResultExport && (
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
      <BottomNav />
      {needProd && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 955, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }} onClick={() => setNeedProd(null)}>
          <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 520, maxHeight: '88vh', overflowY: 'auto', background: 'var(--bg)', borderRadius: '16px 16px 0 0', padding: '16px 16px calc(16px + env(safe-area-inset-bottom))' }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
              <div style={{ flex: 1, fontSize: 16, fontWeight: 500 }}>На какое производство оформить?</div>
              <button type="button" onClick={() => setNeedProd(null)} style={{ background: 'none', border: 'none', fontSize: 20, color: 'var(--text-hint)' }}>✕</button>
            </div>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>Заказ уходит заявкой на производство. Выберите производство из списка или зарегистрируйте своё — тогда заявки будут приходить вам, в раздел «Производство».</p>
            {needProd.pending && (
              <p style={{ fontSize: 12, color: 'var(--amber)', background: 'var(--amber-light)', borderRadius: 'var(--radius)', padding: '6px 8px', marginBottom: 10 }}>
                {needProd.pending === 'rejected' ? 'Заявка на регистрацию вашего производства отклонена — её можно подать заново в разделе «Производство».' : 'Ваше производство ждёт подтверждения администратора. Заказ сохранён; оформить его на своё производство можно будет после подтверждения.'}
                {' '}Сейчас заказ можно оформить на другое производство.
              </p>
            )}
            {!needProd.own ? (
              <>
                {(() => {
                  const list = productions.filter(pr => (pr.status ?? 'approved') === 'approved')
                  return list.length ? (
                    <>
                      <label className="label">Производство</label>
                      <select value={needProd.pick} onChange={e => setNeedProd(n => ({ ...n, pick: e.target.value }))} style={{ marginBottom: 10 }}>
                        {list.map(pr => <option key={pr.id} value={pr.id}>{pr.name}{[pr.country, pr.city].filter(Boolean).length ? ` · ${[pr.country, pr.city].filter(Boolean).join(', ')}` : ''}</option>)}
                      </select>
                      <button type="button" className="btn-primary" disabled={!needProd.pick} onClick={() => submitOrder(needProd.cfg, needProd.force, needProd.pick)}>✓ Оформить на это производство</button>
                    </>
                  ) : <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Подтверждённых производств пока нет.</p>
                })()}
                {!needProd.pending && <button type="button" onClick={() => setNeedProd(n => ({ ...n, own: true }))}
                  style={{ width: '100%', marginTop: 10, padding: 10, border: '0.5px solid var(--blue-mid)', borderRadius: 'var(--radius)', background: 'transparent', color: 'var(--blue)', fontSize: 14 }}>
                  У меня своё производство — зарегистрировать
                </button>}
              </>
            ) : (
              <>
                {productions.length === 0 && <p style={{ fontSize: 12, color: 'var(--amber)', background: 'var(--amber-light)', borderRadius: 'var(--radius)', padding: '6px 8px', marginBottom: 10 }}>Пока ни одно производство не зарегистрировано. Зарегистрируйте своё — заказ оформится на него.</p>}
                <ProductionForm submitLabel="Зарегистрировать и оформить"
                  sheet={{ kerf: order.kerf_width, ml: order.margin_left, mr: order.margin_right, mt: order.margin_top, mb: order.margin_bottom }}
                  onCancel={productions.length ? () => setNeedProd(n => ({ ...n, own: false })) : () => setNeedProd(null)}
                  onDone={async pid => {
                    await refreshProfile?.()
                    const mine = await myProduction(user?.id)
                    if (mine && (mine.status ?? 'approved') === 'approved') { submitOrder(needProd.cfg, needProd.force, pid); return }
                    // регистрация по запросу: производство ждёт подтверждения — заказ пока не оформляем
                    setNeedProd(n => ({ ...n, own: false, pending: 'pending' }))
                  }} />
              </>
            )}
          </div>
        </div>
      )}
      {editPart && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 950, background: 'var(--bg2)', overflowY: 'auto' }}>
          <ContourEditor
            detail={editPart.draft}
            onUpdate={u => setEditPart(ep => (ep ? { ...ep, draft: { ...ep.draft, contour: u.contour, edges: u.edges || ep.draft.edges } } : ep))}
            onClose={closePartEditor}
            materialThickness={order.material_thickness || 16} />
        </div>
      )}
      {part3d && (
        <Suspense fallback={<div style={{ position: 'fixed', inset: 0, zIndex: 960, background: 'var(--bg2)' }}><CncLoader label="Строим 3D-модель…" /></div>}>
          <Model3D key={part3d.index} details={part3dDetails(part3d)} title={part3d.draft.name || 'Деталь'} onClose={closePart3d} readOnly
            materialThickness={thicknessOf(part3d.index)}
            actions={[{ label: '⇄ Сменить лицевую сторону', onClick: flipPart3d }, { label: '✎ Редактор контура', onClick: part3dToEditor, primary: true },
              ...(hasModel(allDetails) ? [{ label: '⬆ В модели', onClick: () => { const d = rawDetail(details[part3d.index]); const focus = { di: allDetails.indexOf(d), des: detailMeta(d)?.des || '' }; setInModel({ focus, scene: undefined }); loadOrderModel(id).then(sc => setInModel(m => (m ? { ...m, scene: sc || null } : m))).catch(() => setInModel(m => (m ? { ...m, scene: null } : m))) } }] : [])]} />
        </Suspense>
      )}
      {inModel && (inModel.scene === undefined
        ? <div style={{ position: 'fixed', inset: 0, zIndex: 970, background: 'var(--bg2)' }}><CncLoader label="Открываем модель…" /></div>
        : (
          <Suspense fallback={null}>
            <div style={{ position: 'relative', zIndex: 970 }}>
              <Model3D details={allDetails} scene={inModel.scene} title={orderTitle(order)} onClose={() => setInModel(null)} readOnly orderId={null} focus={inModel.focus} />
            </div>
          </Suspense>
        ))}
      <SendToMaster job={sendJob} onClose={() => setSendJob(null)} />
    </div>
  )
}
