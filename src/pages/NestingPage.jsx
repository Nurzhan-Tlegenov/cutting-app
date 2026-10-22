import { openOrderEdit, canEditOrder, EDIT_BTN } from '../lib/editOrder'
import { getCnc } from '../lib/cncSettings'
import ShareBadge from '../components/ShareBadge'
import { useKeptState } from '../hooks/useKeptState'
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
import { placedThroughHoles, polyInsideWithGap } from '../lib/nestInHoles'
import { partLabel, LABEL_MODES } from '../lib/partLabel'
import { edgeTotals, detailEdgeList, holeEdgeSegments } from '../lib/edgeLength'
import { backSide } from '../lib/partInfo'
import { useLabelMode, rememberOrderDefaults, getUserSettings, saveUserSettings } from '../lib/userSettings'
import { useAuth } from '../context/AuthContext'
import { productionSaveNesting, productionOrderSheet, orderClient } from '../lib/productionApi'
import { myOrderPerms } from '../lib/workplaces'
import BottomNav from '../components/BottomNav'
import ContourEditor from '../components/ContourEditor'
import Model3DButton from '../components/Model3DButton'
import ProductionForm from '../components/ProductionForm'
import ProductionPicker from '../components/ProductionPicker'
import { myProduction } from '../lib/productionApi'
import { loadOrderModel } from '../lib/orderModel'
import { hasModel } from '../lib/model3d'
import { parsePolygonFromDetail, needsTrueShape } from '../lib/trueShapeNesting'
import { detailHoles } from '../lib/partHoles'
import { cutDetails, rawDetail, parseEdgeTypes, overOf, overMm, OVER_KEY, edgeKey, blankType } from '../lib/edgeCut'
import { saveNestingPdf } from '../lib/nestingPdf'
import { computeCutLines } from '../lib/cutLines'
import { insetEdgeLines } from '../lib/edgeLines'
import NestingCost from '../components/NestingCost'
import { nestingStats, sumStats, statsPayload } from '../lib/nestingStats'
import { fixOrderQuote } from '../lib/pricing'
import { statsAndQuote, pdfSummaryOf, userPdfTpl } from '../lib/pdfSummary'
import { savedNestings } from '../lib/savedNesting'
import { detailMatKey, materialsOf } from '../lib/detailMaterial'
import { flipDetail } from '../lib/mirrorDetail'
import { detailMeta } from '../lib/partLabel'
import { orderTitle, orderFileName, getNextOrderNumber, fileNameOf } from '../lib/orderUtils'
import { fileNamesOf } from '../lib/fileNames'
import { productionLabel, sortProductions } from '../lib/productionLabel'
import { sortDetails, SORT_MODES } from '../lib/sortDetails'
import CncLoader from '../components/CncLoader'
import SendToMaster from '../components/SendToMaster'
import { lazyRetry } from '../lib/lazyRetry'
import { useBackClose } from '../lib/backStack'
import { hasBeta } from '../lib/beta'
import { beamSettings, sameMaps, sameMapTag } from '../lib/beamSaw'
import { cutMethods } from '../lib/productionServices'
import { saveBeamSawXml } from '../lib/beamSawXml'
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
// Деталь внутри сквозного выреза другой (вложение, см. nestInHoles.js) — в экранных координатах (тот же переворот
// по Y, что и в absolutePoly): не конфликт, если контур целиком в вырезе с зазором ≥ реза
function nestedFlipped(inner, host, details, kerf) {
  const hd = details?.[host.detailIndex]
  if (!hd?.contour) return false
  if (inner.x < host.x - 0.5 || inner.y < host.y - 0.5 || inner.x + inner.w > host.x + host.w + 0.5 || inner.y + inner.h > host.y + host.h + 0.5) return false
  const ip = absolutePoly(inner, kerf)
  return placedThroughHoles(host, hd).some(hp => polyInsideWithGap(ip, hp.map(q => ({ x: host.x + q.x, y: host.y + (host.origY - q.y) })), kerf))
}
function piecesConflict(a, b, kerf, details = null) {
  if (!hasShapeOf(a) && !hasShapeOf(b)) {
    if (a.x >= b.x + b.w - kerf || b.x >= a.x + a.w - kerf ||
        a.y >= b.y + b.h - kerf || b.y >= a.y + a.h - kerf) return false
    if (!polygonsOverlap(absolutePoly(a, kerf), absolutePoly(b, kerf))) return false
    return !(details && (nestedFlipped(a, b, details, kerf) || nestedFlipped(b, a, details, kerf)))
  }
  // габариты (с учётом kerf) разнесены дальше kerf — конфликта нет
  if (a.x >= b.x + b.w || b.x >= a.x + a.w || a.y >= b.y + b.h || b.y >= a.y + a.h) return false
  if (polyGap(absolutePoly(a, kerf), absolutePoly(b, kerf)) >= kerf - 0.5) return false
  return !(details && (nestedFlipped(a, b, details, kerf) || nestedFlipped(b, a, details, kerf)))
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
function conflictSet(items, kerf, usableX, usableY, details = null) {
  const bad = new Set()
  for (let i = 0; i < items.length; i++) {
    if (outOfSheet(items[i], usableX, usableY, kerf)) bad.add(i)
    for (let j = i + 1; j < items.length; j++) {
      if (piecesConflict(items[i], items[j], kerf, details)) { bad.add(i); bad.add(j) }
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

function SheetCanvas({ sheet, usableX, usableY, sheetL, sheetW, marginL, marginT, kerf, colorMap, details, labelMode = 'name', showEdges = true, dimScale = 1, onMove, interactive, showOffcuts, offcutMode, manualOffcuts, onManualOffcuts, selectedIdx = -1, onSelect, onEditPart, onSwipe = null, canSwipe = null }) {
  const canvasRef = useRef(null)
  const draggingRef = useRef(null)
  // Перелистывание как в галерее телефона: карта едет за пальцем, при отпускании уходит за край, а соседний
  // лист въезжает с другой стороны. Только без масштаба (иначе палец прокручивает карту) и пока деталь не
  // тащат; движение в основном по горизонтали. Без соседа карта пружинит обратно.
  const slideRef = useRef(null)          // обёртка карты, которую двигаем
  const swipeRef = useRef(null)          // { x, y, t, horiz: null | true | false, dx }
  const enterRef = useRef(0)             // с какой стороны въезжает новый лист после переключения
  const SLIDE_MS = 190
  const slideW = () => (slideRef.current?.offsetWidth || window.innerWidth)
  const setSlide = (px, animate) => {
    const el = slideRef.current
    if (!el) return
    el.style.transition = animate ? `transform ${SLIDE_MS}ms ease-out, opacity ${SLIDE_MS}ms ease-out` : 'none'
    el.style.transform = px ? `translateX(${px}px)` : ''
    el.style.opacity = px ? String(Math.max(0.35, 1 - Math.abs(px) / slideW() * 0.8)) : ''
  }
  const swipeStart = e => { const t = e.touches?.[0]; swipeRef.current = t ? { x: t.clientX, y: t.clientY, t: Date.now(), horiz: null, dx: 0 } : null }
  // -> true, если палец ведёт карту (деталь трогать не нужно)
  const swipeMove = e => {
    const s = swipeRef.current, t = e.touches?.[0]
    if (!s || !t || !onSwipe || zoomRef.current > 1.02 || draggingRef.current?.active || draggingRef.current?.dragged) return false
    const dx = t.clientX - s.x, dy = t.clientY - s.y
    if (s.horiz === null && (Math.abs(dx) > 12 || Math.abs(dy) > 12)) s.horiz = Math.abs(dx) > Math.abs(dy) * 1.2
    if (!s.horiz) return false
    s.dx = dx
    // сосед есть — карта едет за пальцем; нет — только чуть поддаётся (упор)
    const can = !canSwipe || canSwipe(dx < 0 ? 1 : -1)
    setSlide(can ? dx : dx / 4, false)
    return true
  }
  const swipeEnd = () => {
    const s = swipeRef.current; swipeRef.current = null
    if (!s || !s.horiz) return false
    const dir = s.dx < 0 ? 1 : -1
    const fast = Date.now() - s.t < 300 && Math.abs(s.dx) > 30
    const can = !canSwipe || canSwipe(dir)
    if (can && (Math.abs(s.dx) >= slideW() * 0.25 || fast)) {
      setSlide(-dir * slideW(), true)
      setTimeout(() => {
        enterRef.current = dir
        if (onSwipe(dir) === false) { enterRef.current = 0; setSlide(0, true) }
      }, SLIDE_MS)
    } else setSlide(0, true)
    return true
  }
  // Новый лист въезжает с той стороны, куда ушёл предыдущий
  useEffect(() => {
    const dir = enterRef.current
    if (!dir) return
    enterRef.current = 0
    setSlide(dir * slideW(), false)
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setSlide(0, true)))
    return () => cancelAnimationFrame(id)
  }, [sheet])
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

  // useLayoutEffect: при смене масштаба холст пересоздаётся — перерисовываем
  // до показа на экране, чтобы не мигал пустым
  // (стоит после расчёта canvasW/canvasH/DPR — до него они ещё не объявлены)
  // canvasW/canvasH/DPR — тоже: размер холста считается от окна, и если он сменился (вернулись из 3D-вида,
  // из другого приложения, повернули телефон), React переставляет width/height холста, а браузер при этом
  // очищает картинку — карта оставалась белой, пока не перелистнёшь лист.
  useLayoutEffect(() => {
    placedRef.current = flipY(sheet.placed)
    redraw(placedRef.current)
  }, [sheet.placed, showOffcuts, offcutMode, manualOffcuts, zoom, pinching, selectedIdx, labelMode, showEdges, dimScale, canvasW, canvasH, DPR])

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
    const conflicts = conflictSet(items, kerf, usableX, usableY, details)
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
      // Обработка снизу (с нелицевой пласти) — фиолетовый фон: с двух сторон — деталь переворачивают,
      // только снизу (фасад: лицевая без присадки, петли с изнанки) — тоже нужно видеть, тон светлее
      const back = details && details[p.detailIndex] ? backSide(details[p.detailIndex]) : null
      const baseFill = back === 'both' ? 'rgba(123,31,162,0.22)' : back === 'back' ? 'rgba(123,31,162,0.13)' : PART_FILL
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
      // у детали с контуром кромка идёт по участкам контура с тем же отступом внутрь (прямые и дуги одинаково) —
      // на скруглённом углу без «прямоугольника» по габариту и без перехлёста; без контура — по сторонам габарита
      let edgeLines = null
      if (showEdges) {
        const dd = details && details[p.detailIndex]
        if (dd && dd.contour) {
          let cc = dd._parsedContour
          if (cc === undefined) { try { cc = dd.contour ? JSON.parse(dd.contour) : null } catch { cc = null } dd._parsedContour = cc }
          edgeLines = cc ? insetEdgeLines(dd, cc, g / sc) : null
          if (edgeLines) {
            const dW = Number(dd.width) || 0, dL = Number(dd.length) || 0, times = placedTurns(p, dd)
            ctx.save(); ctx.lineJoin = 'round'
            edgeLines.forEach(line => {
              ctx.beginPath()
              line.forEach(([qx, qy], k) => {
                const { x: fx, y: fy } = rotatePointTimes(qx, qy, dW, dL, times)
                const sx = x + fx * sc, sy = y + h - fy * sc
                if (k) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy)
              })
              ctx.stroke()
            })
            ctx.restore()
          }
        }
      }
      if (showEdges && !edgeLines) {
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
            ctx.save()
            ctx.strokeStyle = EDGE_COLOR; ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round'
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
      const fs = Math.round(8 * (dimScale || 1) * 10) / 10   // размер шрифта размеров — настраивается «Размеры − / +»
      ctx.font = `${fs}px sans-serif`
      const wTxt = String(Math.round(p.origX)), lTxt = String(Math.round(p.origY))
      const wPx = ctx.measureText(wTxt).width, lPx = ctx.measureText(lTxt).width
      if (hasShape) {
        // Фигурная деталь: размеры ставим на сам материал внутри контура
        const key = `${sc}|${fs}|${wTxt}|${lTxt}`
        let cached = dimSpotCache.get(p.polygon)
        if (!cached || cached.key !== key) {
          cached = { key, spots: findDimSpots(p.polygon, p.origX, p.origY, wPx / sc, lPx / sc, (fs + 2) / sc) }
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
        const off = 3 + fs / 2   // отступ подписи от стороны растёт вместе со шрифтом
        if (h > 2 * fs && wPx < w - 6) ctx.fillText(wTxt, x + w / 2, y + off)
        if (w > 2 * fs && lPx < h - 6) {
          ctx.save()
          ctx.translate(x + off, y + h / 2)
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
    const wasConflict = conflictSet(placedRef.current, kerf, usableX, usableY, details).has(idx)
    // вложенные в вырезы этой детали (nestInHoles) — едут вместе с ней
    const kids = placedRef.current.map((o, j) => (j !== idx && nestedFlipped(o, p, details, kerf) ? j : -1)).filter(j => j >= 0)
    const drag = { idx, startX: x, startY: y, origX: p.x, origY: p.y, wasConflict, active: false, moved: false, startTime: Date.now(), kids, kidsOrig: kids.map(j => [placedRef.current[j].x, placedRef.current[j].y]) }
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
    // вложенные в эту деталь едут вместе с ней — к ним не притягиваемся
    const others = drag0.kids.length ? placedRef.current.map((o, i) => (drag0.kids.includes(i) ? { ...o, x: -1e6, y: -1e6, polygon: undefined } : o)) : placedRef.current
    const snapped = applyMagnet(nx, ny, p.w, p.h, idx, others)
    // Точный магнит по контуру для фигурных деталей: зазор ровно kerf, в том числе внутри Г-образной
    const refined = snapPolygonGap(p, snapped.x, snapped.y, others, idx, kerf, 50)
    nx = Math.max(0, Math.min(usableX + kerf - p.w, refined.x))
    ny = Math.max(0, Math.min(usableY + kerf - p.h, refined.y))
    const kidAt = i => drag0.kids.indexOf(i)
    const updated = placedRef.current.map((item, i) => (i === idx ? { ...item, x: nx, y: ny }
      : kidAt(i) >= 0 ? { ...item, x: drag0.kidsOrig[kidAt(i)][0] + (nx - origX), y: drag0.kidsOrig[kidAt(i)][1] + (ny - origY) } : item))
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
    const group = [drag.idx, ...drag.kids]
    const hasCollision = group.some(g => placedRef.current.some((o, j) => !group.includes(j) && piecesConflict(placedRef.current[g], o, kerf, details)))

    // Возвращаем на место только если до перетаскивания деталь стояла
    // корректно. Если она уже была "в красном" (после поворота) — оставляем
    // где отпустили, красная подсветка покажет, что конфликт остался.
    if (hasCollision && !drag.wasConflict) {
      const restored = placedRef.current.map((item, i) => (i === drag.idx ? { ...item, x: drag.origX, y: drag.origY }
        : drag.kids.includes(i) ? { ...item, x: drag.kidsOrig[drag.kids.indexOf(i)][0], y: drag.kidsOrig[drag.kids.indexOf(i)][1] } : item))
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

  // Телефон может сбросить картинку холста, пока приложение свёрнуто или открыт тяжёлый 3D-вид (память).
  // Возвращаемся на страницу / холст восстановлен / сменился размер окна — рисуем лист заново (если деталь
  // сейчас не тащат — тогда перерисовка идёт сама от пальца).
  const redrawRef = useRef(null)
  redrawRef.current = () => { if (!draggingRef.current?.active) redraw(placedRef.current) }
  useEffect(() => {
    const canvas = canvasRef.current
    let raf = 0
    const again = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => redrawRef.current?.()) }
    const onVis = () => { if (document.visibilityState === 'visible') again() }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('pageshow', again)
    window.addEventListener('focus', again)
    window.addEventListener('resize', again)
    canvas?.addEventListener('contextrestored', again)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('pageshow', again)
      window.removeEventListener('focus', again)
      window.removeEventListener('resize', again)
      canvas?.removeEventListener('contextrestored', again)
    }
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
    <div style={{ position: 'relative', overflow: 'hidden' }}>
     <div ref={slideRef} style={{ willChange: 'transform' }}>
      <div ref={wrapRef}
        style={{ overflow: zoom > 1 ? 'auto' : 'visible', maxHeight: zoom > 1 ? '70vh' : 'none', borderRadius: 8,
          display: zoom > 1 ? 'block' : 'flex', justifyContent: 'center' }}>
        <canvas ref={canvasRef} width={Math.round(canvasW * DPR)} height={Math.round(canvasH * DPR)}
          style={{ width: canvasW, height: 'auto', aspectRatio: `${canvasW} / ${canvasH}`, maxWidth: zoom > 1 ? 'none' : '100%', borderRadius: 8, display: 'block', touchAction: interactive ? (zoom > 1 ? 'pan-x pan-y' : 'none') : 'auto' }}
          onMouseDown={e => { if (Date.now() - lastTouchRef.current < 800) return; onPointerDown(e) }}
          onMouseMove={e => { if (Date.now() - lastTouchRef.current < 800) return; onPointerMove(e) }}
          onMouseUp={e => { if (Date.now() - lastTouchRef.current < 800) return; onPointerUp(e) }}
          onTouchStart={e => { lastTouchRef.current = Date.now(); if (e.touches.length > 1) { swipeRef.current = null; setSlide(0, true); return } swipeStart(e); onPointerDown(e) }}
          onTouchMove={e => { lastTouchRef.current = Date.now(); if (e.touches.length > 1) { swipeRef.current = null; setSlide(0, true); return }
            if (swipeMove(e)) { clearLongPress(); if (draggingRef.current && !draggingRef.current.active) draggingRef.current.moved = true; return }
            onPointerMove(e) }}
          onTouchEnd={e => { lastTouchRef.current = Date.now(); if (swipeRef.current?.horiz) { clearLongPress(); draggingRef.current = null; emptyTapRef.current = null; swipeEnd(); return } swipeRef.current = null; onPointerUp(e) }}
          onTouchCancel={() => { clearLongPress(); draggingRef.current = null; swipeRef.current = null; setSlide(0, true) }}
        />
      </div>
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
    id: ++CFG_SEQ, dir: 'auto', box: false, small: false, sq: '', area: '', side: '', edge: '50', end: '', secs: '12',
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

// ─── Рабочее состояние раскроя на случай перезагрузки страницы ─────────────────────────────────────
// После обновления приложения открытая страница может перезагрузиться сама (подгрузка 3D-вида), а телефон —
// выгрузить вкладку из памяти. Чтобы не терять выбранный вариант (из хронологии, правки, обрезки, открытый лист),
// конфигурации держим в памяти вкладки (sessionStorage) и при новой загрузке того же заказа возвращаем.
const workKey = orderId => `nestWork:${orderId}`
const detailsSig = list => (list || []).map(d => `${d.id}:${d.qty}:${d.length}:${d.width}`).join('|')
function stashWork(orderId, data) {
  const slim = data.cfgs.map(c => ({ ...c, check: null, status: c.result ? 'done' : 'idle', startedAt: 0, doneAt: 0 }))
  const put = cfgs => { sessionStorage.setItem(workKey(orderId), JSON.stringify({ ...data, cfgs, at: Date.now() })) }
  try { put(slim) } catch {
    try { put(slim.map(c => ({ ...c, history: null, histPos: -1 }))) } catch { /* не поместилось — без запаса */ }   // хронология большая — без неё
  }
}
function takeWork(orderId) {
  try { const v = JSON.parse(sessionStorage.getItem(workKey(orderId)) || 'null'); return v && Date.now() - v.at < 6 * 3600e3 ? v : null } catch { return null }
}
const dropWork = orderId => { try { sessionStorage.removeItem(workKey(orderId)) } catch { /* без памяти */ } }

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
// «Производство — не выбрано (свои параметры)»: пользователь хочет раскроить заказ на своём резе и отступах
// (потестить, сравнить с другой программой). Выбор помнится за заказом на этом устройстве — раскрой больше не
// подставляет производство сам; при отправке, если параметры не совпадают с производством, предлагается перекроить.
const ownParamsKey = id => 'ownParams:' + id
function readOwnParams(id) { try { return localStorage.getItem(ownParamsKey(id)) === '1' } catch { return false } }
function writeOwnParams(id, on) { try { if (on) localStorage.setItem(ownParamsKey(id), '1'); else localStorage.removeItem(ownParamsKey(id)) } catch { /* без памяти */ } }
// рез и отступы производства для материала заказа: у ХДФ / ДВП — свои (если производство их задало), иначе общие
const prodVal = (pr, col, order) => (order?.material_kind === 'hdf' && pr['hdf_' + col] != null ? pr['hdf_' + col] : pr[col])
// Что требует производство для этого раскроя: у пильного центра β — его собственные пропил и обрезка листа
const BEAM_COL = { kerf_width: 'kerf', margin_left: 'trimLeft', margin_right: 'trimRight', margin_top: 'trimTop', margin_bottom: 'trimBottom' }
const prodNeed = (pr, col, order, result) => (result?.beamSaw ? beamSettings(pr.beam_saw_settings)[BEAM_COL[col]] : prodVal(pr, col, order))
// Рез и отступы, которые подставляются в поля листа: выбран пильный центр β — его настройки, иначе «Параметры станка»
const machineVal = (pr, col, order) => (order?.beam_saw && BEAM_COL[col] ? beamSettings(pr.beam_saw_settings)[BEAM_COL[col]] : prodVal(pr, col, order))
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
const paramsKey = p => JSON.stringify([!!p.byBox, +p.sheetL, +p.sheetW, +p.kerf, +p.marginT, +p.marginR, +p.marginB, +p.marginL, p.offcuts?.items?.length ? p.offcuts : null])
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
// На телефоне — не больше 4: половина ядер там слабые, и 6 потоков отнимают время у экрана — показ раскладки
// подтормаживает, а поиску лишние потоки почти ничего не дают.
const isTouch = () => typeof window !== 'undefined' && (navigator.maxTouchPoints > 0 || window.matchMedia?.('(pointer: coarse)')?.matches)
function islandsFor(concurrentJobs = 1) {
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4
  return Math.max(1, Math.min(isTouch() ? 4 : 6, Math.floor((cores - 1) / Math.max(1, concurrentJobs))))
}
// Показ улучшений на экране — не чаще раза в LIVE_SHOW_MS: улучшения от нескольких потоков приходят пачками, а каждое —
// перерисовка страницы и новый переезд деталей; на телефоне это дёргалось. Последнее улучшение не теряется — показывается
// по таймеру
const LIVE_SHOW_MS = 450

// Параллельный поиск «островами»: несколько воркеров считают один и тот же
// заказ независимо (у каждого свой случайный поиск), а лучший найденный вариант
// сразу пересылается остальным — они продолжают искать от него. Так за то же
// время перебирается в N раз больше вариантов укладки.
// Потоки не поднялись (чаще всего — приложение обновилось, а страница открыта в старой версии и файл потока
// уже не найти): один раз перезагружаем страницу (окно останется тем же), повторно — считаем в основном потоке
// и говорим об этом (onFallback), иначе расчёт молча шёл в основном потоке и «подвешивал» экран.
const WORKER_RELOAD_KEY = 'workerReloadAt'
function reloadOnce() {
  let last = 0
  try { last = Number(sessionStorage.getItem(WORKER_RELOAD_KEY)) || 0 } catch { /* без памяти */ }
  if (Date.now() - last < 60000) return false
  try { sessionStorage.setItem(WORKER_RELOAD_KEY, String(Date.now())) } catch { /* без памяти */ }
  window.location.reload()
  return true
}
function startNestingJob(params, { live = false, onProgress = null, onStats = null, onIslandProgress = null, onFallback = null, islands = 1 } = {}) {
  const workers = []
  let rejectFn = null, resolveFn = null
  let cancelled = false, finished = false, stopFlag = false
  let best = null, bestScore = null      // лучший промежуточный результат со всех островов
  let searchScore = null                 // лучший по счёту поиска (для обмена между потоками)
  // фрезер: при равных листах лучше тот, у кого больше цельный обрезок последнего листа (liveBetter, offFirst)
  const offFirst = (params.cuttingMethod || 'nesting') === 'nesting' && !params.beamSaw
  // «Стоп» на фрезере (кроме больших заказов, где потоки ещё доводят итог): итог — ровно то, что на экране,
  // сразу, без ожидания потоков и без «ещё одного шага» укладки
  const exactStop = offFirst && live && params.details.reduce((a, d) => a + (Number(d.qty) || 0), 0) <= 300
  const finals = []                       // итоги островов
  let expected = 0
  const killAll = () => { workers.forEach(w => w.terminate()); workers.length = 0 }
  const finish = res => { if (finished || cancelled) return; finished = true; killAll(); resolveFn(res) }
  const fail = err => { if (finished || cancelled) return; finished = true; killAll(); rejectFn(err) }
  const consider = (res, fromIdx) => {
    const raw = res.rawSheets || res.sheets      // раскладка самого поиска — для соседних потоков
    if (res.rawSheets) { res = { ...res }; delete res.rawSheets }
    if (exactStop && stopFlag) return             // после «Стоп» на экране ничего не меняется
    const sc = liveScore(res.sheets, res.usableX, res.usableY, params.direction, offFirst)
    const global = liveBetter(sc, bestScore)
    // соседям — и порядок деталей, и саму раскладку (дожатую, «починенную»). Уходит раскладка самого поиска
    // (rawSheets), а не дозаполненная вырезами и не доведённая для показа: для прямоугольного поиска деталь в вырезе
    // фигурной детали — наложение (см. withFilled в liveNesting.js). На экран и в историю rawSheets не идёт — лишний вес.
    // Какую раскладку слать соседям, решает счёт самого поиска (листы → мелкие у края → меньше на последнем листе),
    // а не обрезок: иначе вариант, который ближе к листу меньше, не доходил до соседей (261010_Timur_k1: 11 листов
    // перестали находиться)
    const ss = liveScore(raw, res.usableX, res.usableY)
    if (liveBetter(ss, searchScore)) {
      searchScore = ss
      if (res.genome) workers.forEach((w, i) => { if (i !== fromIdx) w.postMessage({ type: 'migrant', genome: res.genome, sheets: raw }) })
    }
    if (!cancelled && !finished) onIslandProgress?.(res, fromIdx, global)
    if (!global) return
    best = res; bestScore = sc
    if (!cancelled && !finished) onProgress?.(res, fromIdx)
  }
  const pickBest = list => {
    let top = null, topScore = null
    list.forEach(r => { const sc = liveScore(r.sheets, r.usableX, r.usableY, params.direction, offFirst); if (liveBetter(sc, topScore)) { top = r; topScore = sc } })
    return top
  }
  // Все живые острова отчитались — итог = лучший из их итогов
  // лучший показанный промежуточный результат участвует в выборе итога: итог потока после «финальной» обработки
  // бывает хуже того, что уже было на экране (261010_Timur_k1_history_2: показано 0,05 м², итог 0,09 м²)
  // показанный — первым: итог потока заменяет его, только если строго лучше (при равенстве остаётся то, что на экране)
  const checkDone = () => { if (expected > 0 && finals.length >= expected) finish(pickBest(best ? [best, ...finals] : finals)) }
  const onFinal = res => { if (res?.rawSheets) { res = { ...res }; delete res.rawSheets } finals.push(res); checkDone() }
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
      if (reloadOnce()) return                 // страница перезагружается — свежая версия поднимет потоки
      onFallback?.()
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
      // (фрезер: итог потока — ровно показанное либо показанное минус лист, если закономерный «съём» последнего листа
      // (sweepLast, ≤1,5 с) успел; поэтому итогов потоков ждём — до STOP_GRACE_MS)
      setTimeout(() => {
        if (finished || cancelled) return
        // Итоги не успели — берём лучшее из того, что уже есть
        const pool = best ? [best, ...finals] : finals
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

// «Мелкие — в центр» не применяется, если под пороги попадают все или почти все детали (от 80% штук):
// правило «мелкие не у края» тогда держит у края весь заказ и ломает раскладку — например, «вдоль Y»
// не получается (история 261015_002: все детали 330 мм при «узкая сторона до 350»)
const SMALL_ALL_SHARE = 0.8
function smallRuleOff(details, cfg) {
  if (!cfg.small) return false
  const total = details.reduce((a, d) => a + (Number(d.qty) || 1), 0)
  const n = smallDetailsOf(details, cfg.sq, cfg.side).reduce((a, d) => a + (Number(d.qty) || 1), 0)
  return total > 0 && n >= total * SMALL_ALL_SHARE
}

// Сколько места экрана (пиксели) оставить вокруг обзора листов: сверху «Стоп» и переключатели, снизу подсказка,
// «Выбрать» (нижнее меню SheetsOverview вычитает само) — тогда при «Стоп» наверху экрана карта и «Выбрать» видны целиком.
// Подогнано по замерам на экранах 360×640, 393×780, 412×870
const OVERVIEW_RESERVE = 232

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
  // виды кромки заказа (из бланка: настройки видов + то, что стоит на деталях) — для выбора в редакторе контура
  const orderEdgeNames = useMemo(() => [...new Set([
    ...Object.keys(parseEdgeTypes(order?.edge_types)).filter(k => !k.startsWith('__')),
    ...allDetails.flatMap(d => [d.edge_left, d.edge_right, d.edge_top, d.edge_bottom]),
  ].filter(v => v && v !== 'default' && v !== 'false' && v !== true))], [order, allDetails])
  const details = useMemo(() => cutDetails(multiMat ? allDetails.filter(d => detailMatKey(d, order) === matKey) : allDetails, parseEdgeTypes(order?.edge_types)), [allDetails, multiMat, matKey, order])
  // что нужно заказу от производства — для предупреждений в окне выбора производства
  const orderNeeds = useMemo(() => {
    try {
      const et = edgeTotals(details.map(rawDetail))
      const drill = details.some(d => {
        if (!d.contour) return false
        try { return getAllDrillPoints(JSON.parse(d.contour), Number(d.width) || 0, Number(d.length) || 0).length > 0 } catch { return false }
      })
      const shaped = details.some(d => parsePolygonFromDetail(d).custom || detailHoles(d).length > 0)
      return { shaped, edge: et.total > 0, curvedEdge: et.curved > 0, drill, hdf: order?.material_kind === 'hdf' }
    } catch { return {} }
  }, [details, order?.material_kind])
  // есть детали с фигурным контуром — показываем галочку «по габаритам»
  const hasShaped = useMemo(() => { try { return needsTrueShape(details) } catch { return false } }, [details])
  const { user, profile, refreshProfile, cabinet, isMaster } = useAuth()
  const [clientName, setClientName] = useState('')   // имя заказчика — для имени PDF карт (настройка «Имена файлов»)
  useEffect(() => { let alive = true; orderClient(id).then(r => { if (alive && !r.error) setClientName(r.data?.full_name || '') }).catch(() => {}); return () => { alive = false } }, [id])
  // кабинет производства: ЧПУ и бирки по принятому раскрою
  // ЧПУ и бирки из раскроя: владелец производства, начальник производства и сотрудник с этим полномочием
  const [wperms, setWperms] = useState(null)
  useEffect(() => { let alive = true; if (cabinet === 'production') myOrderPerms(id).then(r => { if (alive) setWperms(r.data || null) }); return () => { alive = false } }, [id, cabinet])
  const isOper = profile?.role === 'admin' || profile?.role === 'operator'
  const canCnc = cabinet === 'production' && (isOper || !!(wperms?.all || wperms?.cnc))
  const canLabels = cabinet === 'production' && (isOper || !!(wperms?.all || wperms?.labels))
  const canProduce = canCnc || canLabels
  const [part3d, setPart3d] = useState(null)       // { index, draft } — деталь в 3D-виде (долгое удержание на карте)
  const [inModel, setInModel] = useState(null)     // деталь в общей 3D-модели заказа: { focus, scene }
  const [sendJob, setSendJob] = useState(null)     // файл для отладки, который уходит мастер-аккаунту
  const [partsOpen, setPartsOpen] = useKeptState('partsOpen', false)   // список деталей под картами — свёрнут
  const [partsSort, setPartsSort] = useState('')
  const [editPart, setEditPart] = useState(null)   // { index, draft } — деталь, открытая в редакторе контура с карты
  // «Назад» телефона закрывает редактор контура, открытый с карты (а не уводит со страницы раскроя)
  useBackClose(!!editPart, () => closePartEditor())   // eslint-disable-line no-use-before-define
  const [labelMode, setLabelMode] = useLabelMode(user)   // что писать на деталях карты (идёт за аккаунтом)
  // показывать ли кромку на картах (без неё карта читается легче) — тоже за аккаунтом
  const [showEdges, setShowEdges] = useState(() => getUserSettings(user).nestShowEdges !== false)
  const toggleEdges = v => { setShowEdges(v); saveUserSettings({ nestShowEdges: v }, user) }
  // Размер цифр-размеров по сторонам деталей на карте (только они, остальное не меняется); идёт за аккаунтом
  const [dimScale, setDimScale] = useState(() => { const v = Number(getUserSettings(user).nestDimScale); return v >= 0.75 && v <= 2.5 ? v : 1 })
  const stepDim = d => setDimScale(v => { const n = Math.round(Math.min(2.5, Math.max(0.75, v + d)) * 100) / 100; saveUserSettings({ nestDimScale: n }, user); return n })
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
  // β Пильный центр: режет сквозными резами (cuttingMethod 'guillotine'), а сам выбор — отдельный флаг заказа orders.beam_saw.
  // Кнопку видят мастер-аккаунт и выбранные им бета-тестеры (migration_beta.sql).
  const [beamSaw, setBeamSaw] = useState(false)
  const [betaBeam, setBetaBeam] = useState(false)
  useEffect(() => { let alive = true; hasBeta('beam_saw').then(v => { if (alive) setBetaBeam(v) }); return () => { alive = false } }, [])
  const [showOffcuts, setShowOffcuts] = useKeptState('offcuts', false)
  const [offcutMode, setOffcutMode] = useState('manual') // 'manual' | 'cuts'
  const [productions, setProductions] = useState([])     // зарегистрированные производства (если есть)
  const [needProd, setNeedProd] = useState(null)         // «Оформить» без производства: { cfg, force, pick, own }
  // «Где будете резать?» — производство выбирается до раскроя: { mine } пока окно открыто
  const [pickProd, setPickProd] = useState(null)
  const [noProdOk, setNoProdOkState] = useState(() => readOwnParams(id))   // «Свои параметры» — производство само не подставляется
  const setNoProdOk = on => { setNoProdOkState(on); writeOwnParams(id, on) }
  const [ownFor, setOwnFor] = useState(id)   // другой заказ на той же странице — его собственный выбор
  if (ownFor !== id) { setOwnFor(id); setNoProdOkState(readOwnParams(id)) }
  const runAfterRef = useRef(null)                       // какой раскрой запустить, когда производство выбрано
  const [prodsReady, setProdsReady] = useState(false)    // список производств загружен (и последнее выбранное подставлено)
  // Сменили станок — в поля листа подставляются рез и отступы этого станка выбранного производства
  // (фрезер / пила — «Параметры станка», пильный центр β — настройки пильного центра)
  function setMachine(method, beam) {
    setCuttingMethod(method); setBeamSaw(beam)
    saveSmallPartsSettings({ cutting_method: method })
    if (beam !== !!order.beam_saw) supabase.from('orders').update({ beam_saw: beam }).eq('id', id).then(({ error }) => { if (!error) setOrder(o => (o ? { ...o, beam_saw: beam } : o)) })   // база ещё без migration_beta.sql — выбор живёт до перезагрузки
    const pr = order.production_id ? productions.find(x => x.id === order.production_id) : null
    if (!pr) return
    const o2 = { ...order, beam_saw: beam }, patch = {}
    SHEET_FIELDS.forEach(([k, col]) => { const v = machineVal(pr, col, o2); if (PROD_LOCKED.includes(k) && v != null && Number(v) !== Number(order[col])) patch[col] = Number(v) })
    if (Object.keys(patch).length) saveOrderPatch(patch, false)
  }
  // Производство указало, на чём режет (Услуги), а выбран способ, которого у него нет, — переключаемся на тот, что есть
  // (ЧПУ → пила → пильный центр β). Параметры подставляются по способу: ЧПУ и пила — «Параметры станка», пильный центр — свои.
  useEffect(() => {
    if (!prodsReady || !order?.production_id) return
    const pr = productions.find(x => x.id === order.production_id)
    if (!pr) return
    const m = cutMethods(pr.services)
    const cur = beamSaw ? 'beamsaw' : cuttingMethod
    if (m[cur]) return
    const next = ['nesting', 'guillotine', 'beamsaw'].find(k => m[k] && (k !== 'beamsaw' || betaBeam) && !(k === 'nesting' && order.material_kind === 'hdf'))
    if (!next) return
    const beam = next === 'beamsaw', method = beam ? 'guillotine' : next
    Promise.resolve().then(() => setMachine(method, beam))
  }, [prodsReady, order?.production_id, productions, betaBeam])   // eslint-disable-line react-hooks/exhaustive-deps
  // Прифуговка из настроек пильного центра производства. Её определяет производство (кромка без сколов): когда выбран
  // пильный центр, всем видам кромки заказа ставится производственная прифуговка — и в своём заказе, и в заказе клиента,
  // который режет это производство (запись через production_order_sheet); своя прифуговка клиента заменяется.
  // Заготовка везде считается одинаково (раскрой, карта, бирки, программа) — через существующий edgeCut
  // Так же и на фрезере ЧПУ: прифуговка из настроек ЧПУ производства («Обработка» → «Прифуговка под кромку», productions.cnc.joint).
  // На ручном форматнике производственной прифуговки нет — остаётся та, что в заказе.
  const jointProd = () => {
    if (!order) return 0
    const pr = order.production_id ? productions.find(x => x.id === order.production_id) : productions.find(x => x.owner_id && x.owner_id === user?.id)
    if (beamSaw) return beamSettings(pr?.beam_saw_settings).joint || 0
    if (cuttingMethod !== 'nesting') return 0
    const own = pr && pr.owner_id === user?.id                       // своё производство — свои настройки ЧПУ (самые свежие)
    return Math.max(0, Number(String((own ? getCnc(user).joint : null) ?? pr?.cnc?.joint ?? '').replace(',', '.')) || 0)
  }
  const canSetJoint = () => !!order && (order.user_id === user?.id || profile?.role === 'admin' || (cabinet === 'production' && order.status !== 'draft'))
  async function writeEdgeTypes(next, msg) {
    setOrder(o => (o ? { ...o, edge_types: next } : o))
    const own = order.user_id === user?.id || profile?.role === 'admin'
    const r = own ? await supabase.from('orders').update({ edge_types: next }).eq('id', id) : await productionOrderSheet(id, { edge_types: JSON.stringify(next) })
    if (r?.error) setParamsWarn(own ? 'Не удалось записать прифуговку: ' + (r.error.message || r.error) : 'Прифуговка производства не записалась в заказ клиента: выполните migration_production_sheet_edges.sql в Supabase (SQL Editor) — один раз.')
    else setParamsWarn(msg)
  }
  const applyJoint = (j, all) => {
    const types = parseEdgeTypes(order.edge_types)
    const keys = new Set(allDetails.flatMap(d => [d.edge_left, d.edge_right, d.edge_top, d.edge_bottom]).map(edgeKey).filter(Boolean))
    const next = { ...types }
    let changed = false
    for (const k of keys) { const t = types[k] || blankType(); if (all ? Math.abs(Number(t.joint) - j) > 0.001 : !(Number(t.joint) > 0)) { next[k] = { ...t, t: Number(t.t) || 0, joint: j }; changed = true } }
    return changed ? next : null
  }
  useEffect(() => {
    const j = jointProd()
    if (!(j > 0) || !prodsReady || !canSetJoint() || !allDetails.length) return
    const next = applyJoint(j, true)
    if (next) Promise.resolve().then(() => writeEdgeTypes(next, `Прифуговка ${j} мм из настроек ${beamSaw ? 'пильного центра' : 'фрезера ЧПУ'} производства поставлена кромкам заказа — пересчитайте раскрой.`))
  }, [beamSaw, cuttingMethod, prodsReady, order?.production_id, allDetails.length, order?.edge_types])   // eslint-disable-line react-hooks/exhaustive-deps
  const askedOnOpenRef = useRef(false)
  useBackClose(!!pickProd, () => { runAfterRef.current = null; setPickProd(null) })
  useBackClose(!!needProd, () => setNeedProd(null))
  const [sheetForm, setSheetForm] = useState(() => sheetFormOf(null))
  const [offForm, setOffForm] = useState(() => parseOffcuts(null))
  const [sheetOpen, setSheetOpen] = useKeptState('sheetOpen', false)   // «Лист и обрезки» по умолчанию свёрнут
  const [paramsWarn, setParamsWarn] = useState(() => {
    // страница только что перезагрузилась из-за не поднявшихся потоков (см. reloadOnce) — скажем, что делать
    try { return Date.now() - (Number(sessionStorage.getItem(WORKER_RELOAD_KEY)) || 0) < 10000 ? 'Приложение обновилось до новой версии — нажмите «Выполнить раскрой» ещё раз.' : '' } catch { return '' }
  })
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

  useEffect(() => { fetchOrder(true) }, [id])
  // Пила (форматник): линии реза на листе видны сразу — по ним пилят (их же печатает PDF)
  useEffect(() => { if (cuttingMethod === 'guillotine') { setShowOffcuts(true); setOffcutMode('cuts') } }, [cuttingMethod])   // eslint-disable-line react-hooks/exhaustive-deps
  // 3D-вид детали подгружаем сразу, пока версия приложения на сервере та же: иначе после обновления приложения
  // первое удержание детали перезагружало страницу (и сбрасывало выбранный вариант раскроя)
  useEffect(() => { const t = setTimeout(() => { import('../components/Model3D').catch(() => {}) }, 1500); return () => clearTimeout(t) }, [])
  // Рабочее состояние — в память вкладки (не во время расчёта: там результат меняется каждую секунду)
  const workSigRef = useRef(null)
  useEffect(() => {
    if (anyRunning || !workSigRef.current || !configs.some(c => c.result)) return
    const t = setTimeout(() => stashWork(id, { ...workSigRef.current, matKey, focusId, cfgs: configsRef.current }), 700)
    return () => clearTimeout(t)
  }, [configs, matKey, focusId, anyRunning, id])
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

  async function fetchOrder(initial = false) {
    const { data: o } = await supabase.from('orders').select('*').eq('id', id).single()
    const { data: d } = await supabase.from('order_details').select('*').eq('order_id', id).order('sort_order')
    setOrder(o); setAllDetails(d || [])
    if (o) {
      const sig = { status: o.status || 'draft', details: detailsSig(d), result: String(o.nesting_result || '').length }
      workSigRef.current = sig
      if (!initial) dropWork(id)   // заказ перечитан после отправки / изменения — прежний запас уже не про него
      setSheetForm(sheetFormOf(o))
      setOffForm(parseOffcuts(o.offcuts))
      fetchProductions(o).then(() => setProdsReady(true))   // после этого — «Где будете резать?», если производство не выбрано
      setCuttingMethod(o.material_kind === 'hdf' ? 'guillotine' : (o.cutting_method || 'nesting'))   // ХДФ / ДВП режется только на пиле
      setBeamSaw(!!o.beam_saw && (o.material_kind === 'hdf' || (o.cutting_method || 'nesting') === 'guillotine'))
      let store = null
      if (o.nesting_result) { try { store = JSON.parse(o.nesting_result) } catch { store = null } }
      // несколько материалов — раскрой хранится по каждому отдельно: { multi: true, byMat: { ключ: результат } }
      const mats = materialsOf(d || [], o)
      const byMat = store?.multi ? (store.byMat || {}) : {}
      const key = mats.length > 1 ? (mats.find(m => byMat[m.key]) || mats[0]).key : ''
      const saved = mats.length > 1 ? (byMat[key] || null) : (store && !store.multi ? store : null)
      setSavedByMat(byMat); setMatKey(key)
      // Страница перезагрузилась, а заказ тот же (статус, детали, сохранённый раскрой) — возвращаем рабочее состояние:
      // выбранный вариант, правки, обрезки, открытый лист
      const w = initial ? takeWork(id) : null
      if (w && w.status === sig.status && w.details === sig.details && w.result === sig.result && w.cfgs?.length
          && (mats.length > 1 ? mats.some(m => m.key === w.matKey) : true)) {
        CFG_SEQ = Math.max(CFG_SEQ, ...w.cfgs.map(c => Number(c.id) || 0))
        if (mats.length > 1) setMatKey(w.matKey)
        setConfigs(w.cfgs.map(c => newCfg(c)))
        setFocusId(w.cfgs.some(c => c.id === w.focusId) ? w.focusId : w.cfgs[0].id)
        return
      }
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
      edge: o.small_parts_edge_gap ? String(o.small_parts_edge_gap) : '50',
      // «торцом к краю»: пусто — как «узкая сторона»
      end: o.small_parts_end_side != null ? String(o.small_parts_end_side) : '',
      secs: o.optimize_seconds != null ? String(o.optimize_seconds) : '12',
      ...(saved ? {
        dir: saved.config?.dir || 'auto', box: !!(saved.config?.box || saved.byBox),
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
  // «Вращать все» / «Выключить всем»: поворот деталей этого материала (как галочка вращения в бланке заказа).
  // Включение не портит готовые варианты (ограничение только снимается) — новый раскрой уже сможет поворачивать детали
  const [rotBusy, setRotBusy] = useState(false)
  async function setRotateAll(on) {
    const list = details.filter(d => !!d.rotatable !== on && d.id)
    if (!list.length) return
    const msg = on
      ? `Разрешить вращение всем деталям (${list.length} поз.)?\n\nЕсли у материала есть рисунок или направление волокон — повёрнутые детали пойдут поперёк него.\nПосле этого выполните раскрой заново.`
      : `Запретить вращение всем деталям (${list.length} поз.)?\nДетали будут уложены строго по рисунку / волокнам. После этого выполните раскрой заново.`
    if (!window.confirm(msg)) return
    setRotBusy(true)
    const ids = list.map(d => d.id)
    const { error } = await supabase.from('order_details').update({ rotatable: on }).in('id', ids)
    setRotBusy(false)
    if (error) { window.alert('Не удалось изменить вращение: ' + error.message); return }
    setAllDetails(ds => ds.map(x => (ids.includes(x.id) ? { ...x, rotatable: on } : x)))
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
    list = sortProductions(list)                          // страна → город → название
    setProductions(list)
    // Выбрано производство — параметры листа всегда его (могли поменяться)
    const pr = o?.production_id ? list.find(x => x.id === o.production_id) : null
    if (pr) {
      const patch = {}
      SHEET_FIELDS.forEach(([k, col]) => { const v = machineVal(pr, col, o); if (PROD_LOCKED.includes(k) && v != null && Number(v) !== Number(o[col])) patch[col] = Number(v) })
      if (Object.keys(patch).length) await saveOrderPatch(patch, false)
      return
    }
    // Производство не выбрано — подставляем последнее, которое клиент выбирал (запоминается за аккаунтом).
    // Только в своём ещё не отправленном заказе, где раскроя пока нет: готовый раскрой не пересчитывается от чужого реза.
    const last = getUserSettings(user).lastProductionId
    const lp = last && !o?.production_id && o?.user_id === user?.id && (!o.status || o.status === 'draft') && !o.nesting_result && !readOwnParams(o.id)
      ? list.find(x => x.id === last && (x.status ?? 'approved') === 'approved') : null
    if (lp) {
      const patch = { production_id: lp.id }
      SHEET_FIELDS.forEach(([k, col]) => { const v = machineVal(lp, col, o); if (PROD_LOCKED.includes(k) && v != null) patch[col] = Number(v) })
      await saveOrderPatch(patch, false)
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
    // чужой заказ (его перекраивает производство): лист, рез, отступы, обрезки — через функцию базы
    if (order?.user_id && order.user_id !== user?.id && profile?.role !== 'admin') {
      const sheet = Object.fromEntries(Object.entries(patch).filter(([c]) => c === 'offcuts' || SHEET_FIELDS.some(([, col]) => col === c)))
      if (!Object.keys(sheet).length) return true
      const r = await productionOrderSheet(id, sheet)
      if (!r.error) return true
      setParamsWarn(r.missing ? 'Лист не сохранён в заказе: выполните migration_production_sheet.sql в Supabase (SQL Editor) — один раз.' : 'Не удалось сохранить лист: ' + r.error)
      return false
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
  function chooseProduction(pid, list = productions) {
    const pr = list.find(x => x.id === pid)
    saveUserSettings({ lastProductionId: pr ? pr.id : '' }, user)     // в следующем заказе это производство подставится само
    setNoProdOk(!pr)                                                 // «не выбрано» — раскрой идёт на своих резе и отступах
    if (!pr) { saveOrderPatch({ production_id: null }); return }
    const patch = { production_id: pr.id }
    SHEET_FIELDS.forEach(([k, col]) => { const v = machineVal(pr, col, order); if (PROD_LOCKED.includes(k) && v != null) patch[col] = Number(v) }) // формат листа не трогаем
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
    const cfg = newCfg({ box: last.box, small: last.small, sq: last.sq, area: last.area, side: last.side, edge: last.edge, end: last.end, secs: last.secs, dir })
    setConfigs(cs => [...cs.map(c => ({ ...c, open: false })), cfg])
  }

  function removeCfg(cfgId) {
    const job = jobsRef.current[cfgId]
    if (job) { delete jobsRef.current[cfgId]; job.cancel() }
    setConfigs(cs => cs.length > 1 ? cs.filter(c => c.id !== cfgId) : cs)
  }

  // Запуск одной конфигурации. Возвращает промис, который завершается, когда расчёт закончен.
  // continueFrom — «Продолжить»: поиск стартует с раскладки, которая сейчас на экране (после «Стоп» или
  // выбранного варианта, вместе с ручными правками), а не с нуля. Если параметры листа с тех пор поменяли
  // или детали лежат в буфере — раскладка в поиск не передаётся, идёт обычный старт.
  function launch(cfg, continueFrom = false) {
    // ?nfp=1 — прогнать ЭТОТ заказ через NFP для сравнения (только для фрезера)
    const useNfp = new URLSearchParams(window.location.search).get('nfp') === '1'
    const params = {
      details, direction: cfg.dir,
      sheetL: order.sheet_length, sheetW: order.sheet_width,
      marginT: order.margin_top, marginR: order.margin_right,
      marginB: order.margin_bottom, marginL: order.margin_left,
      kerf: order.kerf_width,
      offcuts: offcutsValue(offForm),
      smallPartsToCenter: cfg.small && !smallRuleOff(details, cfg),
      smallPartsMaxSquareSide: cfg.sq === '' ? 0 : Number(cfg.sq),
      smallPartsMaxSide: cfg.side === '' ? 0 : Number(cfg.side),
      smallPartsEdgeGap: cfg.edge === '' ? 100 : Number(cfg.edge),
      // «Торцом к краю до, мм» (строка потерялась 2.10 при загрузке файлов — порог не доходил до раскроя)
      smallPartsEndSide: cfg.end === '' ? null : Number(cfg.end),
      optimizeSeconds: cfg.secs === '' ? 12 : Number(cfg.secs),
      cuttingMethod,
      algo: useNfp ? 'nfp' : 'raster',
      byBox: !!cfg.box && cuttingMethod !== 'guillotine',   // фигурные детали — прямоугольником по габариту
    }
    // β Пильный центр: свой алгоритм (src/lib/beamSawNesting.js) и свои настройки пильного центра производства —
    // выбранного в заказе, иначе своего: пропил и обрезка листа тоже свои (не «Параметры станка» пилы / фрезера);
    // направление «вдоль X / вдоль Y» конфигурации главнее, «авто» — как задано у производства
    if (beamSaw) {
      const pr = (order.production_id && productions.find(x => x.id === order.production_id)) || productions.find(x => x.owner_id && x.owner_id === user?.id) || null
      const bs = beamSettings(pr?.beam_saw_settings)
      Object.assign(params, { beamSaw: pr?.beam_saw_settings || {}, kerf: bs.kerf, marginL: bs.trimLeft, marginR: bs.trimRight, marginT: bs.trimTop, marginB: bs.trimBottom, byBox: false })
    }
    if (continueFrom && cfg.result && cfg.sheetsData?.length && !(cfg.buffer || []).length && cfg.result.paramsKey === paramsKey(params)) {
      params.seed = {
        sheets: cfg.sheetsData.filter(sh => sh.placed?.length).map(sh => ({ ...sh, placed: sh.placed.map(p => ({ ...p })) })),   // листы целиком: у обрезков свои размеры и stock
        algoVersion: cfg.result.algoVersion || null, saved: !!cfg.saved,   // в хронологию: чем и когда была посчитана исходная раскладка
      }
    }
    const stamp = res => {
      res.algoVersion = NESTING_VERSION // версия алгоритма запишется вместе с результатом
      res.algo = params.algo // 'nfp' | 'raster' — чтобы на карте было видно, чем реально посчитано
      res.byBox = !!params.byBox // фигурные детали уложены по габариту (станок режет только прямоугольники)
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
      onFallback: () => {
        hist.fallback = 'main-thread'; hist.islands = 1
        updateCfg(cfg.id, { islands: 1 })
        setParamsWarn('Потоки расчёта не поднялись — считаю в основном потоке (медленнее, экран может притормаживать). Обновите приложение: потяните страницу вниз или закройте и откройте его.')
      },
      onIslandProgress: (res, island, global) => { if (jobsRef.current[cfg.id] === job) recordIsland(hist, res, island, global) },
      onProgress: (res, island) => {
        if (jobsRef.current[cfg.id] !== job) return
        recordEvent(hist, res, island, res.seeded ? 'seed' : res.rough ? 'rough' : 'improve')
        showLater(res)
      },
    })
    // показ — с ограничением частоты (см. LIVE_SHOW_MS); итог (ниже) показывается сразу и отменяет отложенный показ
    let showTimer = 0, pending = null, lastShown = 0
    const showNow = res => {
        pending = null; lastShown = Date.now()
        if (jobsRef.current[cfg.id] !== job) return
        updateCfg(cfg.id, c => {
          const sheetsData = toSheets(res)
          return {
            result: stamp(res), sheetsData, saved: false, rough: !!res.rough,
            improvements: c.improvements + 1, iter: res.iter || c.iter, lastImproveAt: Date.now(),
            activeSheet: Math.min(c.activeSheet, sheetsData.length - 1),
          }
        })
        setFocusId(f => (configsRef.current.some(c => c.id === f && c.result) ? f : cfg.id))
    }
    const showLater = res => {
      pending = res
      if (showTimer) return
      const wait = Math.max(0, LIVE_SHOW_MS - (Date.now() - lastShown))
      showTimer = setTimeout(() => { showTimer = 0; if (pending) showNow(pending) }, wait)
    }
    jobsRef.current[cfg.id] = job
    return job.promise.then(res => {
      if (showTimer) { clearTimeout(showTimer); showTimer = 0; pending = null }
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

  // Свой неотправленный заказ без производства — сначала «Где будете резать?», раскрой запустится после выбора
  async function askProductionFirst(run) {
    if (!order || order.user_id !== user?.id || (order.status && order.status !== 'draft') || order.production_id || noProdOk) return false
    const mine = await myProduction(user?.id)
    if (mine === undefined) return false                  // в базе ещё нет кабинета производства — как раньше
    runAfterRef.current = run
    // у пользователя своё подтверждённое производство — режет у себя, окно выбора не нужно
    if (mine && (mine.status ?? 'approved') === 'approved') { pickProductionAndRun(mine); return true }
    setPickProd({ mine })
    return true
  }
  // Заказ открыт на раскрое, а производство не выбрано — окно выбора сразу, ещё до «Выполнить раскрой»
  useEffect(() => {
    if (!prodsReady || askedOnOpenRef.current || !order) return
    askedOnOpenRef.current = true
    askProductionFirst(null)
  }, [prodsReady, order])   // eslint-disable-line react-hooks/exhaustive-deps
  async function pickProductionAndRun(pr) {
    let list = productions
    if (!list.some(x => x.id === pr.id)) { list = sortProductions([...productions, pr]); setProductions(list) }
    setPickProd(null)
    chooseProduction(pr.id, list)                          // рез и отступы производства — в заказ; раскрой стартует на следующем кадре
  }

  function runCfg(cfgId, continueFrom = false) {
    const cfg = configsRef.current.find(c => c.id === cfgId)
    if (!cfg || !order || !details.length) return
    if (cfg.status === 'running' || cfg.status === 'stopping') return
    if (!order.production_id && !noProdOk && order.user_id === user?.id) {
      askProductionFirst({ id: cfgId, cont: continueFrom }).then(asked => { if (!asked) launch(cfg, continueFrom) })
      return
    }
    launch(cfg, continueFrom)
  }

  async function runAll() {
    if (!order || !details.length) return
    if (await askProductionFirst({ all: true })) return
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

  // Запустили раскрой — экран прокручивается так, чтобы «Стоп» был наверху: под ним карта листов и «Выбрать» —
  // всё сразу на экране (окно карты подогнано по высоте экрана, см. SheetsOverview reserve)
  function stopToTop(cfgId) {
    setTimeout(() => {
      const el = document.querySelector(`[data-cfg-stop="${cfgId}"]`)
      if (!el) return
      const top = el.getBoundingClientRect().top
      if (Math.abs(top - 8) > 4) window.scrollBy({ top: top - 8, behavior: 'smooth' })
    }, 120)   // настройки конфигурации уже свернулись — считаем по новой раскладке
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

  // производство выбрано (или «пока со своими параметрами») — запускаем отложенный раскрой уже с новыми резом и отступами
  useEffect(() => {
    const r = runAfterRef.current
    if (!r || pickProd || !(order?.production_id || noProdOk)) return
    runAfterRef.current = null
    if (r.all) runAll(); else runCfg(r.id, r.cont)
  }, [order?.production_id, order?.kerf_width, order?.margin_left, order?.margin_right, order?.margin_top, order?.margin_bottom, noProdOk, pickProd])   // eslint-disable-line react-hooks/exhaustive-deps

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
    const result = { ...cfg.result }
    delete result.rawSheets           // служебная копия раскладки до дозаполнения — в заказе не нужна
    const toSave = {
      ...result, sheets,
      config: { dir: cfg.dir, box: !!cfg.box, small: cfg.small, sq: cfg.sq, side: cfg.side, edge: cfg.edge, end: cfg.end, secs: cfg.secs },
    }
    const next = multiMat ? { ...savedByMat, [matKey]: toSave } : {}
    if (multiMat) setSavedByMat(next)
    await writeSaved(next, toSave)
    return next
  }

  // ─── Проверка раскроя перед сохранением / оформлением ──────────────────────
  // Итоговая раскладка (с ручными правками) проверяется заново: все детали на
  // месте, нет пересечений, выдержан зазор на рез и отступы от края листа,
  // размеры (поворот против текстуры — только предупреждение); для пилы — сквозные резы. Результат привязан к
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

  // Карты раскроя этого варианта в PDF: лист на страницу, список деталей листа, кромка, процент использования
  const [pdfBusy, setPdfBusy] = useState(null)
  const [pdfEstimate, setPdfEstimateState] = useState(() => !!getUserSettings(user).pdfEstimate)   // галочка «Смета» под кнопкой PDF
  const setPdfEstimate = on => { setPdfEstimateState(on); saveUserSettings({ pdfEstimate: on }, user) }
  // β Пильный центр: программа для пилы KDT (XML) — по текущей карте, с ручными правками и обрезками
  async function xmlCfg(cfg) {
    try {
      const m = materials.find(x => x.key === matKey) || materials[0] || {}
      const [name, thick] = String(m.key || '|').split('|')
      const mat = { name: name || order.material_name || '', thickness: Number(thick) || Number(order.material_thickness) || 16, result: cfg.result, sheets: cfg.sheetsData.filter(sh => sh.placed.length), details }
      await saveBeamSawXml({ order, mat, geoOf: sh => geoOf(order, cfg.result, sh) })
    } catch (e) { window.alert('Не удалось собрать XML для пилы: ' + (e?.message || e)) }
  }
  async function pdfCfg(cfg, idx) {
    setPdfBusy(cfg.id)
    try {
      const m = materials.find(x => x.key === matKey) || materials[0] || {}
      const [name, thick] = String(m.key || '|').split('|')
      const mat = { name: name || order.material_name || '', thickness: Number(thick) || Number(order.material_thickness) || 16, result: cfg.result, sheets: cfg.sheetsData.filter(sh => sh.placed.length), details, method: cuttingMethod }
      // кабинет производства: своё оформление листа, а с галочкой «Смета» — ещё страница со статистикой раскроя и сметой
      let summary = null
      if (cabinet === 'production' && pdfEstimate) {
        const { stats, quote } = await statsAndQuote({ order, mats: [mat], method: cuttingMethod })
        summary = pdfSummaryOf(stats, quote, getUserSettings(user).pdfSummary || {})
      }
      await saveNestingPdf({ order, fileName: `${fileNameOf('maps', fileNamesOf(user).maps, { total: mat.sheets.length, order, material: mat.name, thickness: mat.thickness, client: clientName })}${configs.length > 1 ? `_k${idx + 1}` : ''}.pdf`, mat,
        summary, tpl: cabinet === 'production' ? userPdfTpl(user) : null })
    } catch (e) { window.alert('Не удалось собрать PDF: ' + (e?.message || e)) } finally { setPdfBusy(null) }
  }

  // «Выбрать вариант» — записать этот результат в заказ (остальные остаются на экране)
  // ЧПУ и бирки работают по сохранённому раскрою: несохранённый вариант сначала сохраняем
  async function goProduce(cfg, where) {
    // раскрой с ошибками (пересечение, зазор меньше реза, деталь на отступе) в ЧПУ и на бирки не идёт — это брак
    if (!checkCfg(cfg)) return
    if (!cfg.saved) {
      setBusyId(cfg.id)
      await saveNesting(cfg)
      setConfigs(cs => cs.map(c => ({ ...c, saved: c.id === cfg.id })))
      setBusyId(null)
    }
    navigate(`/orders/${id}/${where}`)
  }
  // Раскрой с ошибками нельзя ни выбрать, ни отправить: обойти проверку нельзя («всё равно сохранить» убрано —
  // так на производство ушёл раскрой с зазором меньше реза)
  async function chooseCfg(cfg) {
    if (!checkCfg(cfg)) return
    setBusyId(cfg.id)
    await saveNesting(cfg)
    setConfigs(cs => cs.map(c => ({ ...c, saved: c.id === cfg.id })))
    setFocusId(cfg.id)
    setBusyId(null)
  }

  // Заказ оформляется на производство. Если оно не выбрано: у кого есть своё производство — заказ идёт туда;
  // остальным предлагаем выбрать производство или зарегистрировать своё.
  async function submitOrder(cfg, force = false, prodId = null) {
    if (!checkCfg(cfg)) return
    const wasPid = order.production_id || null
    let pid = prodId || order.production_id || null
    if (prodId) { await saveOrderPatch({ production_id: prodId }, false); saveUserSettings({ lastProductionId: prodId }, user) }     // раскрой уже посчитан — параметры листа не трогаем; производство запоминается для следующих заказов
    else if (!order.production_id) {
      const mine = await myProduction(user?.id)
      const ready = mine && (mine.status ?? 'approved') === 'approved'
      if (ready) { await saveOrderPatch({ production_id: mine.id }, false); pid = mine.id }
      else if (mine !== undefined) {
        const list = productions.filter(pr => (pr.status ?? 'approved') === 'approved')
        setNeedProd({ cfg, force, pick: list[0]?.id || '', own: !mine && list.length === 0, pending: mine ? (mine.status || 'pending') : '' })
        return
      }
      // mine === undefined — в базе ещё нет кабинета производства: оформляем как раньше
    }
    setNeedProd(null)
    {
      const target = pid ? productions.find(x => x.id === pid) : null
      if (target && (target.status ?? 'approved') !== 'approved') {
        window.alert(target.owner_id === user?.id
          ? `Ваше производство «${target.name}» ещё ждёт подтверждения администратора. Раскрой сохранён — отправить заказ можно будет после подтверждения.`
          : `Производство «${target.name}» ещё не подтверждено — выберите другое в «Лист и обрезки».`)
        return
      }
    }
    // Раскрой должен быть посчитан с резом и отступами не меньше, чем у производства, куда идёт заказ.
    // Если производство выбрали уже после раскроя и его рез шире — заказ не отправляется: нужен пересчёт.
    const pr = pid ? productions.find(x => x.id === pid) : null
    if (pr) {
      const g = geoOf(order, cfg.result)
      const less = (have, col) => { const need = prodNeed(pr, col, order, cfg.result); return need != null && need !== '' && Number(have) < Number(need) - 0.01 }
      if (less(g.kerf, 'kerf_width') || less(g.marginL, 'margin_left') || less(g.marginR, 'margin_right') || less(g.marginT, 'margin_top') || less(g.marginB, 'margin_bottom')) {
        const pv = col => prodNeed(pr, col, order, cfg.result)
        const again = window.confirm(`Этот раскрой посчитан на ваших параметрах: рез ${g.kerf} мм, отступы ${g.marginL}/${g.marginR}/${g.marginT}/${g.marginB} мм.\n`
          + `У производства «${pr.name}»: рез ${pv('kerf_width')} мм, отступы ${pv('margin_left')}/${pv('margin_right')}/${pv('margin_top')}/${pv('margin_bottom')} мм — `
          + `по такому раскрою оно резать не сможет.\n\nПерекроить заказ под это производство? Раскрой запустится заново, после него заказ можно отправить.`)
        if (again) {
          // параметры производства уже стоят в заказе (раскрой просто старый) — запускаем сразу,
          // иначе — когда рез и отступы производства встанут в заказ (см. отложенный запуск ниже)
          const already = SHEET_FIELDS.every(([k, col]) => !PROD_LOCKED.includes(k) || pv(col) == null || Number(pv(col)) === Number(order[col]))
          if (already) { chooseProduction(pid); runCfg(cfg.id) }
          else { runAfterRef.current = { id: cfg.id }; chooseProduction(pid) }
        } else if (!wasPid) {
          await saveOrderPatch({ production_id: null }, false)   // остаёмся на своих параметрах — производство не закрепляется
        }
        return
      }
    }
    // несколько материалов — на производство отдельными заявками, по одной на материал (см. submitByMaterial)
    if (multiMat) { await submitByMaterial(cfg); return }
    setBusyId(cfg.id)
    // Хронология нужна только на время раскроя — после оформления очищается
    historyRef.current = {}
    setConfigs(cs => cs.map(c => ({ ...c, history: null, histPos: -1 })))
    await saveNesting(cfg)
    await supabase.from('orders').update({ status: 'new', submitted_at: new Date().toISOString() }).eq('id', id)
    // цена работ фиксируется в момент оформления: по сохранённым картам всех материалов и прайс-листу производства
    try {
      const { data: fresh } = await supabase.from('orders').select('*').eq('id', id).single()
      if (fresh?.production_id) {
        const mats = savedNestings(fresh, cutDetails(allDetails, parseEdgeTypes(fresh.edge_types)))
        const st = sumStats(mats.map(mat => nestingStats({ order: fresh, mat, method: fresh.cutting_method || 'nesting' })))
        if (st.parts) await fixOrderQuote(id, statsPayload(st))
      }
    } catch { /* не посчиталось — заказ всё равно оформлен, цена покажется по текущему прайсу */ }
    navigate(`/orders/${id}`)
  }

  // Заказ из нескольких материалов уходит на производство отдельными заявками — по одной на материал, с тем же названием
  // (у каждой свой номер, только детали своего материала и его раскрой). Уходят материалы, для которых раскрой выбран
  // (текущий — вместе с этим вариантом); остальные остаются в черновике и отправляются потом так же. Последний материал
  // уходит самим заказом. Производство уже выбрано и проверено в submitOrder.
  async function submitByMaterial(cfg) {
    const sendKeys = materials.filter(m => m.key === matKey || savedByMat[m.key]).map(m => m.key)
    const rest = materials.filter(m => !sendKeys.includes(m.key))
    const lab = k => materials.find(m => m.key === k)?.label || k
    if (!window.confirm(`В заказе ${materials.length} материала — на производство они уходят отдельными заявками, по одной на материал, с тем же названием заказа.\n\nСейчас уйдут:\n${sendKeys.map(k => '· ' + lab(k)).join('\n')}${rest.length ? `\n\nРаскрой ещё не выбран — останутся в черновике, их можно раскроить и отправить позже:\n${rest.map(m => '· ' + m.label).join('\n')}` : ''}\n\nОтправить?`)) return
    setBusyId(cfg.id)
    historyRef.current = {}
    setConfigs(cs => cs.map(c => ({ ...c, history: null, histPos: -1 })))
    try {
      const byMat = await saveNesting(cfg)
      const { data: src, error: e0 } = await supabase.from('orders').select('*').eq('id', id).single()
      if (e0 || !src) throw new Error(e0?.message || 'заказ не найден')
      const { data: rows } = await supabase.from('order_details').select('*').eq('order_id', id).order('sort_order')
      const keyOf = r => detailMatKey(r, src)
      const matCols = k => { const [n, t] = k.split('|'); return { material_name: n || src.material_name, material_thickness: t !== '' && t != null && isFinite(Number(t)) ? Number(t) : src.material_thickness } }
      const fixQuote = async (o, list) => {
        try {
          const mats = savedNestings(o, cutDetails(list, parseEdgeTypes(o.edge_types)))
          const st = sumStats(mats.map(mat => nestingStats({ order: o, mat, method: o.cutting_method || 'nesting' })))
          if (st.parts) await fixOrderQuote(o.id, statsPayload(st))
        } catch { /* цена покажется по текущему прайсу */ }
      }
      const keepKey = rest.length ? null : sendKeys[sendKeys.length - 1]       // всё уходит — последний материал остаётся этим заказом
      const now = new Date().toISOString()
      const made = []
      let model = null
      try { const { data: m } = await supabase.from('order_models').select('data').eq('order_id', id).maybeSingle(); model = m?.data || null } catch { model = null }
      for (const k of sendKeys) {
        if (k === keepKey) continue
        const mine = (rows || []).filter(r => keyOf(r) === k)
        if (!mine.length || !byMat[k]) continue
        const row = {}
        for (const [c, v] of Object.entries(src)) {
          if (c === 'id' || c === 'order_number' || c === 'status' || c.endsWith('_at') || c === 'archived_by' || c === 'archived_sheets' || c === 'return_note' || c === 'nesting_result') continue
          row[c] = v
        }
        Object.assign(row, matCols(k), { order_number: await getNextOrderNumber(supabase), status: 'new', submitted_at: now, nesting_result: JSON.stringify(byMat[k]) })
        const { data: copy, error: e1 } = await supabase.from('orders').insert(row).select().single()
        if (e1 || !copy) throw new Error(/limit/i.test(e1?.message || '') ? 'Достигнут предел бесплатного использования: заказов слишком много. Удалите или отправьте в архив ненужные.' : (e1?.message || 'не удалось создать заявку'))
        const { error: e2 } = await supabase.from('order_details').insert(mine.map(r => { const { id: _i, created_at: _c, ...restCols } = r; void _i; void _c; return { ...restCols, order_id: copy.id } }))
        if (e2) { await supabase.from('orders').delete().eq('id', copy.id); throw new Error(e2.message) }
        const { error: e3 } = await supabase.from('order_details').delete().in('id', mine.map(r => r.id))
        if (e3) { await supabase.from('orders').delete().eq('id', copy.id); throw new Error(e3.message) }
        if (model) { try { await supabase.from('order_models').insert({ order_id: copy.id, data: model }) } catch { /* без модели */ } }
        await fixQuote(copy, mine)
        made.push({ key: k, number: copy.order_number })
      }
      if (keepKey) {
        // последний материал — сам заказ: его раскрой, его материал, оформлен
        await supabase.from('orders').update({ ...matCols(keepKey), nesting_result: JSON.stringify(byMat[keepKey]), status: 'new', submitted_at: now }).eq('id', id)
        const { data: fresh } = await supabase.from('orders').select('*').eq('id', id).single()
        if (fresh?.production_id) await fixQuote(fresh, (rows || []).filter(r => keyOf(r) === keepKey))
        setBusyId(null)
        if (made.length) window.alert(`Отправлено заявками: ${made.map(x => `№${x.number} — ${lab(x.key)}`).join('; ')}; ${lab(keepKey)} — этим заказом.`)
        navigate(`/orders/${id}`)
        return
      }
      // в черновике остаются материалы без раскроя
      const left = Object.fromEntries(Object.entries(byMat).filter(([k]) => !made.some(x => x.key === k)))
      const patch = { nesting_result: Object.keys(left).length ? JSON.stringify({ multi: true, byMat: left }) : null }
      if (rest.length === 1) Object.assign(patch, matCols(rest[0].key))
      await supabase.from('orders').update(patch).eq('id', id)
      setBusyId(null)
      await fetchOrder()
      window.alert(`Отправлено на производство отдельными заявками:\n${made.map(x => `· №${x.number} — ${lab(x.key)}`).join('\n')}\n\nВ черновике осталось: ${rest.map(m => m.label).join(', ')} — выполните раскрой, выберите вариант и отправьте.`)
    } catch (err) {
      setBusyId(null)
      await fetchOrder()
      window.alert('Отправить не удалось: ' + (err?.message || err))
    }
  }

  // Повторная отправка исполненного заказа: создаётся новый заказ — копия этого (детали, кромка, 3D-модель) с выбранным
  // сейчас раскроем — и сразу уходит на то же производство. Исполненный заказ и его место в итогах производства не меняются.
  async function resendOrder(cfg) {
    if (!checkCfg(cfg)) return
    const pr = order.production_id ? productions.find(x => x.id === order.production_id) : null
    if (!order.production_id) { window.alert('У заказа не выбрано производство.'); return }
    if (pr) {
      const g = geoOf(order, cfg.result)
      const less = (have, col) => { const need = prodNeed(pr, col, order, cfg.result); return need != null && need !== '' && Number(have) < Number(need) - 0.01 }
      if (less(g.kerf, 'kerf_width') || less(g.marginL, 'margin_left') || less(g.marginR, 'margin_right') || less(g.marginT, 'margin_top') || less(g.marginB, 'margin_bottom')) {
        chooseProduction(order.production_id)
        window.alert(`Раскрой посчитан с резом ${g.kerf} мм или отступами меньше, чем сейчас у производства «${pr.name}» (рез ${prodNeed(pr, 'kerf_width', order, cfg.result)} мм).\n\nПараметры производства подставлены — выполните раскрой заново и отправьте повторно.`)
        return
      }
    }
    if (!window.confirm(`Отправить заказ повторно${pr ? ` на производство «${pr.name}»` : ''}?\n\nБудет создан новый заказ — копия этого, с раскроем, который выбран сейчас. Исполненный заказ останется как есть.`)) return
    setBusyId(cfg.id)
    try {
      // раскрой для копии — как при сохранении, но в новый заказ (исполненный не трогаем)
      const sheets = cfg.sheetsData.filter(sh => sh.placed.length).map((sh, i) => ({ ...sh, index: i }))
      const result = { ...cfg.result }
      delete result.rawSheets
      const toSave = { ...result, sheets, config: { dir: cfg.dir, box: !!cfg.box, small: cfg.small, sq: cfg.sq, side: cfg.side, edge: cfg.edge, end: cfg.end, secs: cfg.secs } }
      const nesting = multiMat ? JSON.stringify({ multi: true, byMat: { ...savedByMat, [matKey]: toSave } }) : JSON.stringify(toSave)
      const { data: src, error: e0 } = await supabase.from('orders').select('*').eq('id', id).single()
      if (e0 || !src) throw new Error(e0?.message || 'заказ не найден')
      const row = {}
      for (const [k, v] of Object.entries(src)) {
        if (k === 'id' || k === 'order_number' || k === 'status' || k.endsWith('_at') || k === 'archived_by' || k === 'archived_sheets' || k === 'return_note' || k === 'nesting_result') continue
        row[k] = v
      }
      const now = new Date().toISOString()
      Object.assign(row, { user_id: user.id, order_number: await getNextOrderNumber(supabase), status: 'new', submitted_at: now, nesting_result: nesting })
      const { data: copy, error: e1 } = await supabase.from('orders').insert(row).select().single()
      if (e1 || !copy) throw new Error(/limit/i.test(e1?.message || '') ? 'Достигнут предел бесплатного использования: заказов слишком много. Удалите или отправьте в архив ненужные.' : (e1?.message || 'не удалось создать заказ'))
      const { data: rows } = await supabase.from('order_details').select('*').eq('order_id', id).order('sort_order')
      if (rows?.length) {
        const { error: e2 } = await supabase.from('order_details').insert(rows.map(r => { const { id: _i, created_at: _c, ...rest } = r; void _i; void _c; return { ...rest, order_id: copy.id } }))
        if (e2) { await supabase.from('orders').delete().eq('id', copy.id); throw new Error(e2.message) }
      }
      try {   // 3D-модель заказа — тоже в копию (если была)
        const { data: m } = await supabase.from('order_models').select('data').eq('order_id', id).maybeSingle()
        if (m?.data) await supabase.from('order_models').insert({ order_id: copy.id, data: m.data })
      } catch { /* без модели */ }
      // цена фиксируется в момент отправки — по картам копии и текущему прайсу производства
      try {
        const mats = savedNestings(copy, cutDetails(allDetails, parseEdgeTypes(copy.edge_types)))
        const st = sumStats(mats.map(mat => nestingStats({ order: copy, mat, method: copy.cutting_method || 'nesting' })))
        if (st.parts) await fixOrderQuote(copy.id, statsPayload(st))
      } catch { /* цена покажется по текущему прайсу */ }
      setBusyId(null)
      navigate(`/orders/${copy.id}`)
    } catch (err) {
      setBusyId(null)
      window.alert('Повторно отправить не удалось: ' + (err?.message || err))
    }
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
  // длина — по готовой детали; свесы (запас на каждую закромленную сторону) — из настроек кромки заказа
  const edgeOver = overOf(parseEdgeTypes(order?.edge_types))
  const overNow = edgeOver.on ? edgeOver.mm : 0
  const edgeSum = edgeTotals(details.map(rawDetail), overNow)
  // галочка «свесы» в раскрое: клиент со своей кромкой отключает её — метраж пересчитывается сразу
  async function setEdgeOver(on) {
    const types = { ...parseEdgeTypes(order?.edge_types), [OVER_KEY]: { on, mm: edgeOver.mm } }
    setOrder(o => (o ? { ...o, edge_types: types } : o))
    try { await supabase.from('orders').update({ edge_types: types }).eq('id', id) } catch { /* не записалось — галочка действует до закрытия страницы */ }
  }
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
  // Детали со всеми свойствами (только мастер-аккаунт): размеры готовой детали и заготовки, кромка по сторонам
  // и её длина, настройки видов кромки, контур с присадкой — всё, что нужно, чтобы проверить расчёты.
  function partsExportData() {
    const parse = v => { if (typeof v !== 'string') return v ?? null; try { return JSON.parse(v) } catch { return v } }
    const raws = details.map(rawDetail)
    const pick = (o, keys) => Object.fromEntries(keys.filter(k => o?.[k] !== undefined).map(k => [k, o[k]]))
    return {
      exportedAt: new Date().toISOString(), app: 'RaskroyPro', what: 'детали со свойствами',
      order: { ...pick(order, ['id', 'order_number', 'order_name', 'status', 'material_name', 'material_thickness', 'sheet_length', 'sheet_width', 'kerf_width',
        'margin_top', 'margin_right', 'margin_bottom', 'margin_left', 'cutting_method']), edge_types: parseEdgeTypes(order?.edge_types) },
      material: multiMat ? matKey : null,
      totals: { positions: details.length, pieces: totalQty, overhang: edgeOver, edgeNet_m: edgeTotals(raws), edgeWithOverhang_m: edgeSum, edgeByBlank_m: edgeTotals(details) },
      parts: details.map((d, i) => {
        const raw = raws[i]
        return {
          index: i, ...pick(raw, ['id', 'name', 'display_name', 'prefix', 'qty', 'rotatable', 'sort_order']),
          length: raw.length, width: raw.width,
          blank: d._cut ? { length: d.length, width: d.width, lessBySide: d._cut } : null,       // размер в раскрой (подрезка / прифуговка)
          edges: { left_Дл: raw.edge_left || null, right_Дп: raw.edge_right || null, top_Шв: raw.edge_top || null, bottom_Шн: raw.edge_bottom || null },
          edgeByFinished_mm: detailEdgeList(raw), edgeByBlank_mm: d._cut ? detailEdgeList(d) : null,
          edgePerPieceShown_m: edgeTotals([{ ...raw, qty: 1 }], overNow).total,
          contour: parse(raw.contour), contourBlank: d._cut ? parse(d.contour) : null,
        }
      }),
    }
  }
  function downloadParts() {
    const blob = new Blob([JSON.stringify(partsExportData(), null, 1)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = debugName('_parts.json')
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }
  async function copyParts() {
    try { await navigator.clipboard.writeText(JSON.stringify(partsExportData())); window.alert('Детали скопированы — вставьте в сообщение') }
    catch { window.alert('Скопировать не удалось — скачайте файлом') }
  }
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
            {playing ? '❚❚' : '⏵ Пуск'}
          </button>
        </div>
        {/* ползунок и шаг на один момент назад / вперёд — точно попасть в нужный вариант */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button type="button" aria-label="Шаг назад" disabled={pos <= 0}
            onClick={() => { stopPlay(); updateCfg(cfg.id, { histPos: Math.max(0, pos - 1) }) }}
            style={{ ...btn, padding: 0, width: 30, height: 28, flexShrink: 0, fontSize: 13, opacity: pos <= 0 ? 0.4 : 1 }}>◀</button>
          <input type="range" min={0} max={last} step={1} value={pos}
            onChange={e => { stopPlay(); updateCfg(cfg.id, { histPos: Number(e.target.value) }) }}
            style={{ flex: 1, minWidth: 0, margin: '2px 0' }} />
          <button type="button" aria-label="Шаг вперёд" disabled={pos >= last}
            onClick={() => { stopPlay(); updateCfg(cfg.id, { histPos: Math.min(last, pos + 1) }) }}
            style={{ ...btn, padding: 0, width: 30, height: 28, flexShrink: 0, fontSize: 13, opacity: pos >= last ? 0.4 : 1 }}>▶</button>
        </div>
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
    const edgeN = cfg.small && !smallRuleOff(details, cfg) && cfg.result && cfg.sheetsData.length
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
      <div key={cfg.id} className="card" data-tour={idx === 0 ? 'nest-cfg' : undefined}
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
              {cfg.live ? 'до «Стоп»' : `${cfg.secs === '' ? 12 : cfg.secs} с`}{cfg.box && hasShaped && cuttingMethod !== 'guillotine' ? ' · по габаритам' : ''}{cfg.small && !smallRuleOff(details, cfg) ? ' · мелкие в центр' : ''} · {statusLine}
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

            {/* Фигурные детали — по габаритам: для станков, которые режут только прямоугольники */}
            {hasShaped && cuttingMethod !== 'guillotine' && (
              <div style={{ marginBottom: 8 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
                  <input type="checkbox" checked={!!cfg.box} onChange={e => updateCfg(cfg.id, { box: e.target.checked })}
                    style={{ width: 17, height: 17, flexShrink: 0 }} />
                  Фигурные детали — по габаритам
                </label>
                <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 2, marginLeft: 23 }}>
                  Каждая фигурная деталь укладывается прямоугольником своего габарита — без сцепки с соседями и без деталей в вырезах. Включите, если производство режет только прямоугольники.
                </div>
              </div>
            )}

            {/* Мелкие детали + время оптимизации — в одну строку */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', flex: 1, fontSize: 13 }}>
                <input type="checkbox" checked={cfg.small}
                  onChange={e => {
                    const v = e.target.checked
                    // первые значения-подсказки, если пороги ещё не заданы: 0,12 м² · узкая полоса 0 (выключена) · до края 50 мм
                    if (v && cfg.sq === '' && cfg.side === '') {
                      const sq = sideFromArea('0,12')
                      updateCfg(cfg.id, { small: v, area: '0,12', sq, side: '', edge: '50' })
                      persist({ small_parts_to_center: v, small_parts_max_square_side: Number(sq) || 0, small_parts_max_side: 0 })
                      persist({ small_parts_edge_gap: 50 })
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
                  <input type="text" inputMode="numeric" pattern="[0-9]*" value={cfg.side} placeholder="0"
                    onChange={e => updateCfg(cfg.id, { side: e.target.value.replace(/[^0-9]/g, '') })}
                    onBlur={e => persist({ small_parts_max_side: e.target.value === '' ? 0 : Number(e.target.value) })}
                    style={{ width: '100%', fontSize: 14, padding: '3px 6px', boxSizing: 'border-box', display: 'block' }} />
                </label>
                <label style={{ flex: 1, fontSize: 11, color: 'var(--text-muted)' }}
                  title="Мелкая деталь не ближе этого к краю листа (если между ней и краем нет другой детали)">
                  До края, мм
                  <input type="text" inputMode="numeric" pattern="[0-9]*" value={cfg.edge} placeholder="50"
                    onChange={e => updateCfg(cfg.id, { edge: e.target.value.replace(/[^0-9]/g, '') })}
                    onBlur={e => persist({ small_parts_edge_gap: e.target.value === '' ? 50 : Number(e.target.value) })}
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
              if (smallRuleOff(details, cfg)) return (
                <p style={{ fontSize: 10.5, color: '#b45309', margin: '-4px 0 8px', lineHeight: 1.4 }}>
                  Мелкими получаются {n === total ? 'все' : 'почти все'} детали ({n} из {total}) — правило «мелкие — в центр» в этом раскрое не применяется,
                  иначе весь заказ пришлось бы держать подальше от краёв листа. Чтобы оно работало, уменьшите площадь или узкую сторону.
                </p>
              )
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
                  <br />Их не ставим ближе {cfg.edge || 50} мм к краю листа, если между ними и краем нет другой детали.
                  {cfg.side !== '' ? `Узкие полосы (сторона до ${cfg.side} мм включительно) — в середину листа: длинной стороной к краю не ставим, в угол — никогда.` : 'В угол листа — никогда.'}
                  Оставшиеся у края подсвечиваются на карте оранжевым.
                </p>
              )
            })()}
            </>)}

            <div style={{ display: 'flex', gap: 6, marginBottom: cfg.error || cfg.result ? 8 : 0 }}>
              <button data-cfg-stop={cfg.id} onClick={() => { if (isRunning || isQueued) stopCfg(cfg.id); else { runCfg(cfg.id); stopToTop(cfg.id) } }} disabled={!details.length || isStopping}
                style={{ flex: 1, padding: 8, background: isRunning && !isStopping ? '#dc3545' : (isQueued || isStopping) ? 'var(--bg2)' : 'var(--blue)',
                  color: (isQueued || isStopping) ? 'var(--text-muted)' : 'white', border: 'none', borderRadius: 'var(--radius)',
                  fontSize: 13, fontWeight: 500, cursor: isStopping ? 'default' : 'pointer' }}>
                {isStopping ? 'Фиксирую лучший вариант…'
                  : isRunning ? `■ Стоп — зафиксировать (${secs} с)`
                  : isQueued ? '■ Убрать из очереди' : cfg.result ? '↻ Заново' : '▶ Выполнить раскрой'}
              </button>
              {/* «Продолжить» — поиск идёт дальше с раскладки на экране (после «Стоп» / выбранного варианта / ручных правок), а не с нуля */}
              {cfg.result && !isRunning && !isQueued && !isStopping && (
                <button onClick={() => { runCfg(cfg.id, true); stopToTop(cfg.id) }} disabled={!details.length || (cfg.buffer || []).length > 0}
                  title={(cfg.buffer || []).length ? 'Сначала положите детали из буфера на листы' : 'Продолжить поиск с этой раскладки — детали остаются на местах, поиск ищет, как уложить плотнее'}
                  style={{ flex: 1, padding: 8, background: 'var(--teal)', color: 'white', border: 'none', borderRadius: 'var(--radius)',
                    fontSize: 13, fontWeight: 500, cursor: 'pointer', opacity: (cfg.buffer || []).length ? 0.5 : 1 }}>
                  ▶ Продолжить
                </button>
              )}
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
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6, marginBottom: 6, fontSize: 11, color: 'var(--text-hint)', whiteSpace: 'nowrap', flexWrap: 'wrap', rowGap: 4 }}>
                    Подпись на деталях:
                    <select value={labelMode} onChange={e => setLabelMode(e.target.value)}
                      style={{ width: 'auto', minWidth: 0, maxWidth: 150, flex: '0 1 auto', padding: '2px 4px', fontSize: 11, color: 'var(--text-muted)', textOverflow: 'ellipsis' }}>
                      {LABEL_MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 4, margin: '0 0 0 6px', fontSize: 11, color: 'var(--text-hint)' }}>
                      <input type="checkbox" checked={showEdges} onChange={e => toggleEdges(e.target.checked)} style={{ width: 'auto' }} />
                      Кромка
                    </label>
                    {view !== 'all' && (
                      <span style={{ display: 'flex', alignItems: 'center', gap: 3, marginLeft: 6 }} title="Размер цифр по сторонам деталей">
                        Размеры:
                        <button type="button" onClick={() => stepDim(-0.25)} disabled={dimScale <= 0.75}
                          style={{ width: 22, height: 20, padding: 0, borderRadius: 6, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text-muted)', fontSize: 13, lineHeight: 1, cursor: 'pointer' }}>−</button>
                        <span style={{ minWidth: 30, textAlign: 'center', color: 'var(--text-muted)' }}>{Math.round(dimScale * 100)}%</span>
                        <button type="button" onClick={() => stepDim(0.25)} disabled={dimScale >= 2.5}
                          style={{ width: 22, height: 20, padding: 0, borderRadius: 6, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text-muted)', fontSize: 13, lineHeight: 1, cursor: 'pointer' }}>+</button>
                      </span>
                    )}
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
                        reserve={OVERVIEW_RESERVE}
                      />
                      <p style={{ fontSize: 10, color: 'var(--text-hint)', textAlign: 'center', marginTop: 4, marginBottom: 0 }}>
                        {isRunning
                          ? 'Идёт поиск — при более плотной укладке детали переезжают · «Стоп» — зафиксировать'
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
                        kerf={cgeo.kerf} colorMap={colorMap} details={details} labelMode={labelMode} showEdges={showEdges} dimScale={dimScale}
                        onMove={(si, np) => onMoveCfg(cfg.id, si, np)} interactive={true} showOffcuts={showOffcuts}
                        offcutMode={offcutMode} manualOffcuts={canvasSheet.manualOffcuts}
                        onManualOffcuts={(si, list) => onManualOffcutsCfg(cfg.id, si, list)}
                        selectedIdx={cfg.selPart}
                        onSelect={i => updateCfg(cfg.id, { selPart: i, note: '' })}
                        onEditPart={locked ? null : openPart3d}
                        onSwipe={d => { const i = cfg.activeSheet + d; if (i < 0 || i >= cfg.sheetsData.length) return false; openSheet(i); return true }}
                        canSwipe={d => { const i = cfg.activeSheet + d; return i >= 0 && i < cfg.sheetsData.length }}
                      />
                      <p style={{ fontSize: 10, color: 'var(--text-hint)', textAlign: 'center', marginTop: 4, marginBottom: 0 }}>
                        {showOffcuts && offcutMode === 'manual'
                          ? 'Удержи палец на свободном месте — обрезок · удержи на выбранном — снять его'
                          : (showOffcuts && offcutMode === 'cuts'
                            ? 'Линии реза учитывают детали и выбранные обрезки и пересчитываются по текущей карте · красный пунктир — участок без сквозного реза'
                            : 'Смахни влево/вправо — другой лист · тап — выделить (для буфера) · двойной тап — поворот · удержи и тяни — перенос · долго держи на месте — редактор контура · щипок — масштаб · фиолетовый фон — есть обработка снизу (с изнанки или с двух сторон; на карте показана только лицевая, изнанку видно в редакторе)')}
                      </p>
                    </>
                  )}
                </div>

                {/* Переключатель листов — под картой, чтобы палец не закрывал карту */}
                {!locked && (
                  <div style={{ display: 'flex', gap: 5, marginBottom: 8, overflowX: 'auto', paddingBottom: 2 }}>
                    {(() => { const same = cfg.result?.beamSaw && cfg.result.beamSettings?.mergeSame !== false ? sameMaps(cfg.sheetsData) : null; return cfg.sheetsData.map((sh, i) => (
                      <button key={i} onClick={() => openSheet(i)} title={same && same[i].first !== i ? `Такая же карта, как лист ${same[i].first + 1}` : same && same[i].count > 1 ? `Эта карта режется ${same[i].count} раза` : undefined}
                        style={chip(view === 'sheet' && cfg.activeSheet === i, 'var(--blue)')}>
                        {sh.stock === 'offcut' ? 'Обр.' : 'Лист'} {i + 1}{sameMapTag(same, i)} · {sh.placed.length ? sh.placed.length : 'пусто'}
                      </button>
                    )) })()}
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

                {/* Стоимость работ выбранного производства — сразу после раскроя (расценки не показываются) */}
                {order.production_id && cfg.result && cfg.status !== 'running' && cfg.status !== 'stopping' && cfg.status !== 'queued' && cfg.buffer.length === 0 && (
                  <NestingCost order={order} method={cuttingMethod} productionId={order.production_id} style={{ marginBottom: 6 }}
                    note={multiMat ? '(этот материал)' : ''}
                    mats={[{ sheets: cfg.sheetsData, details, result: cfg.result, thickness: Number(String(matKey || '').split('|')[1]) || Number(order.material_thickness) || 16 }]} />
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
                        <div style={{ fontSize: 11, color: '#b45309', margin: '-2px 0 6px' }}>
                          {cfg.check.warnings.map((w, i) => <div key={i}>{w}</div>)}
                        </div>
                      )}
                    </>
                  ) : (
                    <div style={{ padding: 8, marginBottom: 8, borderRadius: 'var(--radius)', background: 'rgba(220,53,69,0.08)', border: '1px solid rgba(220,53,69,0.4)' }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: '#dc3545', marginBottom: 4 }}>
                        ⚠ Раскрой с ошибками — его нельзя выбрать и отправить на производство
                      </div>
                      {cfg.check.errors.map((e, i) => (
                        <div key={i} style={{ fontSize: 11, color: '#a71d2a', padding: '1px 0' }}>• {e}</div>
                      ))}
                      <div style={{ fontSize: 11, color: '#a71d2a', marginTop: 6, fontWeight: 500 }}>
                        Исправьте раскладку: раздвиньте детали на ширину реза (красные — с нарушением) или выполните раскрой заново. Пока ошибки есть, сохранить и отправить этот раскрой нельзя.
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
                      {/* исполненный заказ клиента не перезаписывается: перекроенный вариант уходит копией («Отправить повторно») */}
                      {!(cabinet !== 'production' && order.status === 'done' && order.user_id === user?.id) && <button data-tour="nest-pick" onClick={() => chooseCfg(cfg)} disabled={blocked || cfg.saved}
                        title="Сохранить этот раскрой за заказом (заказ при этом не отправляется); остальные варианты остаются на экране"
                        style={{ flex: 1, padding: 9, borderRadius: 'var(--radius)', fontSize: 13, fontWeight: 500,
                          cursor: (blocked || cfg.saved) ? 'default' : 'pointer',
                          border: '0.5px solid var(--teal)',
                          background: cfg.saved ? '#e6f4ea' : 'var(--teal-light)', color: cfg.saved ? '#1e7e34' : 'var(--teal)' }}>
                        {cfg.saved ? '✓ Выбран' : busyId === cfg.id ? 'Сохранение…' : 'Выбрать'}
                      </button>}
                      <div style={{ flex: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                        <button onClick={() => pdfCfg(cfg, idx)} disabled={!!pdfBusy} title="Карты раскроя в PDF: листы с деталями, размерами, кромкой и процентом использования материала"
                          style={{ padding: '9px 12px', background: 'var(--bg)', color: 'var(--blue)', border: '0.5px solid var(--blue-mid)', borderRadius: 'var(--radius)', fontSize: 13, fontWeight: 500, cursor: pdfBusy ? 'default' : 'pointer' }}>
                          {pdfBusy === cfg.id ? '…' : 'PDF'}
                        </button>
                        {cfg.result?.beamSaw && (
                          <button onClick={() => xmlCfg(cfg)} title="β Программа для пильного центра KDT: XML с деревом резов"
                            style={{ padding: '4px 10px', background: 'var(--bg)', color: 'var(--blue)', border: '0.5px solid var(--blue-mid)', borderRadius: 'var(--radius)', fontSize: 11.5, cursor: 'pointer' }}>XML пилы</button>
                        )}
                        {cabinet === 'production' && (
                          <label title="Добавить в PDF страницу со статистикой раскроя и сметой: операция, количество, цена, сумма" style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10.5, color: pdfEstimate ? 'var(--blue)' : 'var(--text-hint)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                            <input type="checkbox" checked={pdfEstimate} onChange={e => setPdfEstimate(e.target.checked)} style={{ width: 13, height: 13, margin: 0 }} />Смета
                          </label>
                        )}
                      </div>
                      {cabinet !== 'production' && order.status === 'done' && order.user_id === user?.id ? (
                        <button onClick={() => resendOrder(cfg)} disabled={blocked}
                          title="Создать копию этого заказа с выбранным раскроем и отправить на производство ещё раз"
                          style={{ flex: 1, padding: 9, background: 'var(--teal)', color: 'white', border: 'none',
                            borderRadius: 'var(--radius)', fontSize: 13, fontWeight: 500, cursor: blocked ? 'default' : 'pointer' }}>
                          {busyId === cfg.id ? 'Отправка…' : '↻ Отправить повторно'}
                        </button>
                      ) : order.status !== 'draft' ? (canProduce && <>
                        {canCnc && <button onClick={() => goProduce(cfg, 'cnc')} disabled={blocked} title="Управляющие программы для станка с ЧПУ"
                          style={{ flex: 1, padding: 9, background: 'var(--blue)', color: 'white', border: 'none', borderRadius: 'var(--radius)', fontSize: 13, fontWeight: 500, cursor: blocked ? 'default' : 'pointer' }}>
                          ЧПУ
                        </button>}
                        {canLabels && <button onClick={() => goProduce(cfg, 'labels')} disabled={blocked} title="Бирки деталей"
                          style={{ flex: 1, padding: 9, background: 'var(--bg)', color: 'var(--blue)', border: '0.5px solid var(--blue)', borderRadius: 'var(--radius)', fontSize: 13, fontWeight: 500, cursor: blocked ? 'default' : 'pointer' }}>
                          Бирки
                        </button>}
                      </>) :
                      // «Выбрать» только сохраняет раскладку за заказом. Отправка — отдельным действием и только у выбранного варианта
                      !cfg.saved ? null :
                      <button data-tour="nest-send" onClick={() => { if (multiMat || window.confirm('Отправить заказ на производство?\n\nПока производство не приняло заказ, его можно отозвать кнопкой «Редактировать».')) submitOrder(cfg) }} disabled={blocked}
                        title={multiMat ? 'Материалы с выбранным раскроем уходят на производство отдельными заявками — по одной на материал' : 'Отправить заказ с выбранным раскроем на производство'}
                        style={{ flex: 1, padding: 9, background: 'var(--teal)', color: 'white', border: 'none',
                          borderRadius: 'var(--radius)', fontSize: 13, fontWeight: 500, cursor: blocked ? 'default' : 'pointer' }}>
                        {busyId === cfg.id ? 'Отправка…' : 'Отправить заказ'}
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
          <ShareBadge orderId={id} style={{ marginTop: 3 }} />
        </div>
        {/* черновик можно править: название, материал, детали, кромку */}
        {cabinet !== 'production' && canEditOrder(order, user, profile) && order.status !== 'done' && (
          <button type="button" onClick={() => openOrderEdit(order, navigate)} style={EDIT_BTN}>✎ Редактировать</button>
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
      <div data-tour="nest-stats" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, marginBottom: focus && configs.length > 1 ? 3 : 8 }}>
        {[[offcutCount ? 'Листов + обр.' : 'Листов', sheetsData.length ? (offcutCount ? `${sheetsCount}+${offcutCount}` : sheetsCount) : '—'],['Деталей', totalQty],['Кромка, м', totalEdge.toFixed(2)],['Площадь, м²', totalArea ? totalArea.toFixed(2) : '—']].map(([label, val]) => (
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
              {name} · <span style={{ fontWeight: 500 }}>{len.total.toFixed(2)} м</span>{len.curved > 0.005 ? ` (крив. ${len.curved.toFixed(2)})` : ''}
            </span>
          ))}
          <label title="Запас к длине кромки на каждую закромленную сторону. Если кромка своя — отключите."
            style={{ display: 'flex', alignItems: 'center', gap: 5, margin: 0, fontSize: 11, color: edgeOver.on ? 'var(--blue)' : 'var(--text-hint)', border: '0.5px solid ' + (edgeOver.on ? 'var(--blue-mid)' : 'var(--border-md)'), borderRadius: 10, padding: '2px 9px', cursor: 'pointer' }}>
            <input type="checkbox" checked={edgeOver.on} onChange={e => setEdgeOver(e.target.checked)} style={{ width: 'auto', margin: 0 }} />
            свесы +{edgeOver.mm} мм на сторону
          </label>
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
          <div className="card" data-tour="nest-sheet" style={{ marginBottom: 8, padding: 0, overflow: 'hidden' }}>
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
                      {productions.filter(pr => (pr.status ?? 'approved') === 'approved' || pr.id === order.production_id).map(pr => <option key={pr.id} value={pr.id}>{productionLabel(pr)}</option>)}
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

      {/* Материал — всегда на виду: что сейчас раскраиваем */}
      {!multiMat && materials.length === 1 && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8, padding: '7px 10px', borderRadius: 'var(--radius)', background: 'var(--bg)', border: '0.5px solid var(--border-md)' }}>
          <span style={{ fontSize: 11, color: 'var(--text-hint)', flexShrink: 0 }}>Материал</span>
          <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{materials[0].label}</span>
          <span style={{ fontSize: 11, color: 'var(--text-hint)', flexShrink: 0 }}>{materials[0].pieces} шт.</span>
        </div>
      )}
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
      <div data-tour="nest-machine" style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        {[['nesting', 'Фрезер (ЧПУ)'], ['guillotine', 'Пила (форматник)'], ...(betaBeam || beamSaw ? [['beamsaw', 'Пильный центр β']] : [])].map(([val, label]) => {
          const active = val === 'beamsaw' ? beamSaw : !beamSaw && cuttingMethod === val
          // производство выбрано и указало, на чём режет (Услуги) — только эти способы; не указало — любые
          const prc = order.production_id ? productions.find(x => x.id === order.production_id) : null
          const notOffered = !!prc && !cutMethods(prc.services)[val]
          const off = (val === 'nesting' && order.material_kind === 'hdf') || notOffered
          return (
          <div key={val} onClick={() => {
            if (notOffered) { window.alert(`Производство «${prc.name}» не режет на этом станке (${label.replace(' β', '')}). Выберите другой способ или другое производство.`); return }
            if (off) return
            const beam = val === 'beamsaw', method = beam ? 'guillotine' : val
            setMachine(method, beam)
          }}
            title={notOffered ? `Производство «${prc.name}» так не режет` : off ? 'Материал заказа — ХДФ / ДВП: он режется только на пиле' : val === 'beamsaw' ? 'Бета-тест: раскрой под пильный центр — полосы и сквозные резы' : val === 'guillotine' ? 'Только сквозные резы через весь лист/полосу' : 'Свободная укладка для резки фрезой по любому контуру'}
            style={{ flex: 1, padding: '6px 4px', borderRadius: 'var(--radius)', textAlign: 'center',
              opacity: off ? 0.4 : 1,
              fontSize: 12, cursor: 'pointer',
              background: active ? 'var(--blue)' : 'var(--bg2)',
              color: active ? 'white' : 'var(--text-muted)', fontWeight: active ? 500 : 400 }}>
            {label}
          </div>
          )
        })}
      </div>
      {beamSaw && (
        <p style={{ fontSize: 11, color: 'var(--blue)', margin: '-4px 0 8px', lineHeight: 1.4 }}>
          β Бета-тест. Полосы от большой к малой, только сквозные резы по уровням, остаток для захвата, узкие детали с запасом (✂ — подрезать до размера). Направление — как выбрано в конфигурации («авто» — как у производства); пропил, обрезка листа и остальные правила — свои, из настроек пильного центра {(() => { const pr = (order.production_id && productions.find(x => x.id === order.production_id)) || productions.find(x => x.owner_id && x.owner_id === user?.id); const bs = beamSettings(pr?.beam_saw_settings); return <>{pr ? `производства «${pr.name}»` : 'по умолчанию (производство не выбрано)'}: <b>рез {bs.kerf} мм, отступы ←{bs.trimLeft} →{bs.trimRight} ↑{bs.trimTop} ↓{bs.trimBottom}</b> {order.production_id ? '— подставлены в рез и отступы выше' : '(рез и отступы выше для пильного центра не используются)'}</> })()}.
          {!isMaster && (
            <button type="button" onClick={() => setSendJob({
              title: 'Замечание по пильному центру β', fileName: `beamsaw_${orderFileName(order)}.json`, orderId: id,
              need: 'Опишите замечание: что не так на карте или чего не хватает — хотя бы пару слов.',
              getPayload: () => JSON.stringify({ kind: 'beam_saw_feedback', order: { id, sheet_length: order.sheet_length, sheet_width: order.sheet_width, production_id: order.production_id },
                details, configs: configs.map((c, i) => ({ dir: c.dir, secs: c.secs, result: c.result ? { ...c.result, sheets: c.sheetsData || c.result.sheets } : null,
                  history: c.history ? buildHistoryExport(c.history, { order, details, cfgIdx: i }) : null })) }),
            })} style={{ display: 'block', marginTop: 4, padding: '4px 10px', borderRadius: 14, fontSize: 11.5, border: '0.5px solid var(--blue)', background: 'transparent', color: 'var(--blue)', cursor: 'pointer' }}>
              β Замечание по пильному центру
            </button>
          )}
        </p>
      )}

      {order.material_kind === 'hdf' && <p style={{ fontSize: 11, color: 'var(--text-hint)', margin: '-4px 0 8px' }}>Материал заказа — ХДФ / ДВП: раскрой только под пилу{order.production_id ? ', рез и отступы — как задало производство для этого материала' : ''}.</p>}

      {/* Вращение деталей — всегда на виду: забыли включить при вводе / импорте — включить всем прямо отсюда */}
      {details.length > 0 && (() => {
        const fixed = details.filter(d => !d.rotatable)
        const all = !fixed.length
        return (
          <div data-tour="nest-rotate" style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, padding: '6px 10px', borderRadius: 'var(--radius)',
            background: all ? 'var(--bg2)' : 'var(--amber-light, var(--bg2))', border: all ? 'none' : '0.5px solid var(--amber)', fontSize: 12 }}>
            <span style={{ fontSize: 15, color: all ? 'var(--teal)' : 'var(--amber)' }}>↻</span>
            <span style={{ flex: 1, minWidth: 0, color: 'var(--text-muted)' }}>
              {all ? 'Вращение деталей: включено у всех' : `Вращение выключено ${fixed.length === details.length ? 'у всех деталей' : `у ${fixed.length} из ${details.length} позиций`}`}
            </span>
            <button type="button" disabled={rotBusy || anyRunning} onClick={() => setRotateAll(!all)}
              style={{ flexShrink: 0, padding: '5px 10px', borderRadius: 16, fontSize: 12, fontWeight: 500, cursor: 'pointer', opacity: anyRunning ? 0.5 : 1,
                border: `0.5px solid ${all ? 'var(--border-md)' : 'var(--teal)'}`, background: all ? 'transparent' : 'var(--teal)', color: all ? 'var(--text-muted)' : 'white' }}>
              {rotBusy ? '…' : all ? 'Выключить всем' : 'Вращать все'}
            </button>
          </div>
        )
      })()}

      {/* Конфигурации раскроя */}
      <p className="section-title" style={{ margin: '0 0 6px' }}>Конфигурации раскроя</p>
      {configs.map((cfg, idx) => renderConfig(cfg, idx))}

      <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
        <button onClick={addCfg}
          style={{ flex: 1, padding: 8, borderRadius: 'var(--radius)', border: '0.5px dashed var(--border-md)',
            background: 'transparent', color: 'var(--text-muted)', fontSize: 13, cursor: 'pointer' }}>
          + Новая конфигурация
        </button>
        <button data-tour="nest-run" onClick={runAll} disabled={anyRunning || !details.length}
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
              {isMaster && (
                <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                  <button type="button" onClick={downloadParts} style={{ flex: 1, padding: '6px 8px', fontSize: 12, borderRadius: 'var(--radius)', background: 'transparent', border: '0.5px solid var(--blue-mid)', color: 'var(--blue)', cursor: 'pointer' }}>⬇ Экспорт деталей со свойствами</button>
                  <button type="button" onClick={copyParts} style={{ padding: '6px 10px', fontSize: 12, borderRadius: 'var(--radius)', background: 'transparent', border: '0.5px solid var(--border-md)', color: 'var(--text-muted)', cursor: 'pointer' }}>Копировать</button>
                </div>
              )}
              <select value={partsSort} onChange={e => setPartsSort(e.target.value)} style={{ width: '100%', padding: '6px 8px', fontSize: 13, marginBottom: 6 }}>
                <option value="">Как в заказе</option>
                {SORT_MODES.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
              </select>
              {sortDetails(details.map((d, i) => ({ ...d, __i: i })), partsSort).map(d => {
                const m = detailMeta(d), ed = edgeTotals([{ ...rawDetail(d), qty: 1 }], overNow)
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
      {pickProd && (
        <ProductionPicker productions={productions} mine={pickProd.mine} lastId={getUserSettings(user).lastProductionId} profile={profile}
          kerfOf={pr => prodVal(pr, 'kerf_width', order)} needs={orderNeeds}
          sheet={{ kerf: order.kerf_width, ml: order.margin_left, mr: order.margin_right, mt: order.margin_top, mb: order.margin_bottom }}
          onPick={pickProductionAndRun}
          onSkip={() => { setNoProdOk(true); setPickProd(null) }}
          onClose={() => { runAfterRef.current = null; setPickProd(null) }}
          onRegistered={async () => {
            await refreshProfile?.()
            const mine = await myProduction(user?.id)
            if (mine) pickProductionAndRun(mine)
            else setPickProd(null)
          }} />
      )}
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
                        {list.map(pr => <option key={pr.id} value={pr.id}>{productionLabel(pr)}</option>)}
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
            edgeNames={orderEdgeNames}
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
