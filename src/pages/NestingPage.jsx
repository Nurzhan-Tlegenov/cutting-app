import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { runNesting, computeOffcuts, computeOffcutAtPoint } from '../lib/nesting'
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

// Пересечение двух деталей: сначала дешёвая проверка габаритов (с учётом
// kerf), и только если габариты пересеклись — точная по полигонам.
function piecesConflict(a, b, kerf) {
  if (a.x >= b.x + b.w - kerf || b.x >= a.x + a.w - kerf ||
      a.y >= b.y + b.h - kerf || b.y >= a.y + a.h - kerf) return false
  return polygonsOverlap(absolutePoly(a, kerf), absolutePoly(b, kerf))
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
  const placedRef = useRef(sheet.placed)
  const lastTap = useRef({ idx: -1, time: 0 })
  const lastTouchRef = useRef(0) // время последнего touch-события: браузер после касания шлёт ещё и эмулированные mouse-события
  const longPressRef = useRef(null)

  useEffect(() => {
    placedRef.current = flipY(sheet.placed)
    redraw(placedRef.current)
  }, [sheet.placed, showOffcuts, offcutMode, manualOffcuts])

  const PADDING = 8
  const canvasW = typeof window !== 'undefined' ? Math.min(window.innerWidth - 32, 480) : 360
  const sc = (canvasW - PADDING * 2) / sheetW
  const canvasH = Math.round(sc * sheetL) + PADDING * 2
  const DPR = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1

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

    // Обрезки — автоматически посчитанные (свободные прямоугольники раскроя)
    if (showOffcuts && offcutMode === 'auto' && sheet.freeRects) {
      const offcuts = flipRects(computeOffcuts(sheet, usableX, usableY))
      offcuts.forEach(o => {
        const ox = rx + toC(o.x), oy = ry + toC(o.y)
        const ow = toC(o.w), oh = toC(o.h)
        ctx.fillStyle = 'rgba(99,152,6,0.08)'
        ctx.fillRect(ox, oy, ow, oh)
        ctx.strokeStyle = '#3B6D11'
        ctx.lineWidth = 0.8
        ctx.setLineDash([3, 3])
        ctx.strokeRect(ox, oy, ow, oh)
        ctx.setLineDash([])
        ctx.fillStyle = '#3B6D11'
        ctx.font = `${Math.max(8, Math.min(10, ow / 8))}px sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        if (ow > 30 && oh > 14) {
          ctx.fillText(`${o.h}×${o.w}`, ox + ow / 2, oy + oh / 2)
        }
      })
    }

    // Обрезки, выбранные вручную (удержанием пальца) — деловые обрезки,
    // можно выбрать несколько; повторное удержание на уже выбранном — снимает его
    if (showOffcuts && offcutMode === 'manual' && manualOffcuts && manualOffcuts.length) {
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
      if (cx >= px && cx <= px + pw && cy >= py && cy <= py + ph) return i
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
            // Уже выбранные обрезки — такая же занятая часть листа, как и
            // детали: новый обрезок формируется только из оставшегося места
            // и не режется сквозь ранее выбранный
            // Вокруг ранее выбранных обрезков оставляем зазор на ширину реза (kerf)
            const taken = flipRects(list).map(o => ({ x: o.x - kerf, y: o.y - kerf, w: o.w + 2 * kerf, h: o.h + 2 * kerf }))
            const rect = computeOffcutAtPoint(mx, my, [...placedRef.current, ...taken], usableX, usableY)
            if (rect) onManualOffcuts(sheet.index, [...list, flipRects([rect])[0]])
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
    nx = Math.max(0, Math.min(usableX - p.w, snapped.x))
    ny = Math.max(0, Math.min(usableY - p.h, snapped.y))
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

  return (
    <canvas ref={canvasRef} width={Math.round(canvasW * DPR)} height={Math.round(canvasH * DPR)}
      style={{ width: canvasW, height: canvasH, maxWidth: '100%', borderRadius: 8, display: 'block', touchAction: interactive ? 'none' : 'auto' }}
      onMouseDown={e => { if (Date.now() - lastTouchRef.current < 800) return; onPointerDown(e) }}
      onMouseMove={e => { if (Date.now() - lastTouchRef.current < 800) return; onPointerMove(e) }}
      onMouseUp={e => { if (Date.now() - lastTouchRef.current < 800) return; onPointerUp(e) }}
      onTouchStart={e => { lastTouchRef.current = Date.now(); onPointerDown(e) }}
      onTouchMove={e => { lastTouchRef.current = Date.now(); onPointerMove(e) }}
      onTouchEnd={e => { lastTouchRef.current = Date.now(); onPointerUp(e) }}
      onTouchCancel={() => { clearLongPress(); draggingRef.current = null }}
    />
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
  const [offcutMode, setOffcutMode] = useState('auto') // 'auto' | 'manual'
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
                <button onClick={() => setOffcutMode('auto')}
                  style={{ flex: 1, padding: '5px 4px', borderRadius: 'var(--radius)', border: 'none', fontSize: 11,
                    background: offcutMode === 'auto' ? 'var(--teal)' : 'var(--bg2)',
                    color: offcutMode === 'auto' ? 'white' : 'var(--text-muted)', cursor: 'pointer' }}>
                  Авто
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
                : 'Двойной тап — повернуть деталь · Удержи и тяни — переместить'}
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
