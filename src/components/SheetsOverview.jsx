import { useState, useEffect, useLayoutEffect, useRef } from 'react'
import { placedHoles } from '../lib/partHoles'
import { partLabel } from '../lib/partLabel'
import { smallEdgeReal } from '../lib/nesting'

// ─── Обзор ВСЕХ листов раскроя на одном холсте ──────────────────────────────
// Нужен для онлайн-раскроя: пока идёт поиск, пользователь видит, как укладка
// уплотняется. При каждом новом результате детали не «перескакивают», а плавно
// переезжают на новые места (в том числе с листа на лист) — видно само сжатие.
// Просмотр — как галерея фото в телефоне: листы идут сеткой во всю ширину,
// щипок «раздвинуть» — меньше листов в ряд (крупнее, до 1 листа на всю ширину),
// «свести» — больше в ряд (до 10). Сетка прокручивается вниз; рисуется только
// видимая часть (75 листов — без тяжёлого холста на всю длину).
// Тап по листу — открыть этот лист для просмотра и редактирования (onPickSheet).
//
// Координаты данных — как везде в раскрое: Y вверх от низа рабочей зоны, контур
// polygon — Y вверх. На холсте Y идёт сверху вниз (тот же переворот, что и в
// SheetCanvas).

const PART_FILL = '#E6E6E6'
const PART_STROKE = 'rgba(20,20,20,0.75)'
const GAP_MM = 120      // промежуток между листами, мм (в масштабе листа)
const CAPTION_MM = 190  // место под подпись над листом, мм
const ANIM_MS = 600
const MAX_COLS = 10    // больше листов в ряд — уже не разглядеть

function polyArea(pts) {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length]
    a += p.x * q.y - q.x * p.y
  }
  return Math.abs(a) / 2
}
const partArea = p => (Array.isArray(p.polygon) && p.polygon.length > 2 ? polyArea(p.polygon) : (p.origX || 0) * (p.origY || 0))
const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

export default function SheetsOverview({
  sheets, usableX, usableY, sheetL, sheetW, marginL, marginT, kerf,
  activeSheet = -1, onPickSheet, running = false, bufferCount = 0, details = null, labelMode = 'name',
}) {
  const canvasRef = useRef(null)
  const scrollRef = useRef(null)
  const curRef = useRef([])     // что сейчас нарисовано (с учётом анимации), мм общей раскладки
  const animRef = useRef(null)  // requestAnimationFrame id
  const n = Math.max(1, sheets.length)
  const defaultCols = n === 1 ? 1 : n <= 4 ? 2 : n <= 12 ? 3 : 4
  const [colsSet, setColsSet] = useState(null) // выбор пользователя (щипок / кнопки); null — по умолчанию
  const cols = Math.max(1, Math.min(MAX_COLS, colsSet ?? defaultCols, n))
  const colsRef = useRef(cols)
  colsRef.current = cols
  const [boxW, setBoxW] = useState(() => (typeof window !== 'undefined' ? Math.min(window.innerWidth - 32, 900) : 360))
  const drawRef = useRef(null)     // последняя draw (для прокрутки без перерисовки React)
  const scrollRaf = useRef(0)

  const rows = Math.ceil(n / cols)
  // Размеры каждого листа: у листа-обрезка — свои (sheet.sheetW/usableX…),
  // у обычного — общие. Клетка сетки — по самому большому листу.
  const dimOf = s => ({
    sw: s?.sheetW ?? sheetW, sl: s?.sheetL ?? sheetL,
    ml: s?.marginL ?? marginL, mt: s?.marginT ?? marginT,
    ux: s?.usableX ?? usableX, uy: s?.usableY ?? usableY,
    offcut: s?.stock === 'offcut',
  })
  const cellW = Math.max(sheetW, ...sheets.map(s => dimOf(s).sw))
  const cellL = Math.max(sheetL, ...sheets.map(s => dimOf(s).sl))
  const totalW = cols * cellW + (cols - 1) * GAP_MM
  const rowMM = CAPTION_MM + cellL + GAP_MM
  const totalH = rows * rowMM - GAP_MM
  const PADDING = 6
  // Во всю ширину блока — сколько листов в ряд, столько и делят ширину
  const sc = Math.max(0.001, (boxW - PADDING * 2) / totalW)
  const contentH = Math.round(totalH * sc) + PADDING * 2
  // Окно просмотра — не выше ~60% экрана: над ним время и «Стоп», под ним переключатель листов
  const maxViewH = typeof window !== 'undefined' ? Math.max(260, Math.round(window.innerHeight * 0.6)) : 480
  const viewH = Math.min(contentH, maxViewH)
  const canvasW = boxW
  const DPR = Math.min(typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1, 2.5)

  const origin = si => ({
    x: (si % cols) * (cellW + GAP_MM),
    y: Math.floor(si / cols) * rowMM + CAPTION_MM,
  })

  // Ширина блока — по факту (поворот экрана, разная ширина телефонов)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const upd = () => { const w = el.clientWidth; if (w > 0) setBoxW(w) }
    upd()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(upd)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Целевое положение каждой детали в общей раскладке (мм, Y сверху вниз)
  function targets() {
    const out = []
    sheets.forEach((s, si) => {
      const o = origin(si)
      const D = dimOf(s)
      s.placed.forEach(p => {
        const atEdge = !!p.isSmall && smallEdgeReal(p, s.placed, D.ux, D.uy) > 0
        const w = p.w - kerf, h = p.h - kerf
        out.push({
          di: p.detailIndex, sheet: si,
          x: o.x + D.ml + p.x,
          y: o.y + D.mt + (D.uy - p.y - h),
          w, h, polygon: Array.isArray(p.polygon) && p.polygon.length > 2 ? p.polygon : null,
          holes: details ? placedHoles(p, details[p.detailIndex]) : [],
          label: partLabel(p, details, labelMode, true),
          alpha: 1, atEdge,
        })
      })
    })
    return out
  }

  function draw(items) {
    const canvas = canvasRef.current
    if (!canvas) return
    const top = scrollRef.current ? scrollRef.current.scrollTop : 0
    if (canvas.width !== Math.round(canvasW * DPR) || canvas.height !== Math.round(viewH * DPR)) {
      canvas.width = Math.round(canvasW * DPR)
      canvas.height = Math.round(viewH * DPR)
    }
    const ctx = canvas.getContext('2d')
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
    ctx.clearRect(0, 0, canvasW, viewH)
    const X = v => PADDING + v * sc
    const Y = v => PADDING + v * sc - top
    // видимые ряды (с запасом в один ряд — для переезжающих деталей)
    const visTop = (top - PADDING) / sc - rowMM, visBot = (top + viewH) / sc + rowMM
    // Листы
    const badges = []
    sheets.forEach((s, si) => {
      const o = origin(si)
      if (o.y + cellL < visTop || o.y - CAPTION_MM > visBot) return
      const D = dimOf(s)
      const usableArea = D.ux * D.uy
      ctx.fillStyle = D.offcut ? '#E6DCC8' : '#F1EFE8'
      ctx.fillRect(X(o.x), Y(o.y), D.sw * sc, D.sl * sc)
      ctx.fillStyle = '#fff'
      ctx.fillRect(X(o.x + D.ml), Y(o.y + D.mt), D.ux * sc, D.uy * sc)
      // деловые обрезки, которые заказчик отметил оставить (хранятся в листе, Y — от низа рабочей зоны)
      ;(s.manualOffcuts || []).forEach(of => {
        const x = X(o.x + D.ml + of.x), y = Y(o.y + D.mt + (D.uy - of.y - of.h)), w = of.w * sc, h = of.h * sc
        ctx.fillStyle = 'rgba(230,126,34,0.16)'
        ctx.fillRect(x, y, w, h)
        ctx.strokeStyle = '#B85C00'; ctx.lineWidth = 1.2; ctx.setLineDash([5, 3])
        ctx.strokeRect(x, y, w, h)
        ctx.setLineDash([])
        const fs = Math.max(7, Math.min(11, w / 7))
        if (w > 34 && h > fs * 2.4) {
          ctx.fillStyle = '#B85C00'; ctx.font = `bold ${fs}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
          ctx.fillText('обрезок', x + w / 2, y + h / 2 - fs * 0.6)
          ctx.fillText(`${Math.round(of.h)}×${Math.round(of.w)}`, x + w / 2, y + h / 2 + fs * 0.6)
        }
      })
      const active = si === activeSheet
      ctx.strokeStyle = active ? '#185FA5' : D.offcut ? '#A0782C' : '#888780'
      ctx.lineWidth = active ? 2 : 1
      if (D.offcut && !active) ctx.setLineDash([6, 3])
      ctx.strokeRect(X(o.x), Y(o.y), D.sw * sc, D.sl * sc)
      ctx.setLineDash([])
      // Подпись над листом — короче, когда листы мелкие
      const fill = s.placed.reduce((a, p) => a + partArea(p), 0) / usableArea
      const fs = Math.max(8, Math.min(13, CAPTION_MM * sc * 0.62))
      ctx.font = `${active ? 'bold ' : ''}${fs}px sans-serif`
      ctx.fillStyle = active ? '#185FA5' : 'rgba(0,0,0,0.65)'
      ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'
      const cellPx = cellW * sc
      const name = `${D.offcut ? 'Обр.' : 'Лист'} ${si + 1}`
      if (cellPx > 150) {
        ctx.fillText(`${name} · ${s.placed.length} дет. · ${Math.round(fill * 100)}%`, X(o.x), Y(o.y) - 2)
      } else {
        // мелкие листы — номер «бейджем» внутри листа, иначе непонятно, к какому листу подпись
        badges.push({ t: cellPx > 80 ? `${si + 1} · ${Math.round(fill * 100)}%` : `${si + 1}`, x: X(o.x), y: Y(o.y), active, fs: Math.max(8, Math.min(11, cellPx / 6)) })
      }
    })

    // Детали
    items.forEach(it => {
      if (it.y + it.h < visTop || it.y > visBot) return
      const x = X(it.x), y = Y(it.y), w = it.w * sc, h = it.h * sc
      ctx.globalAlpha = it.alpha
      // мелкая/узкая деталь у края листа («мелкие — в центр» не выполнено) — оранжевым
      ctx.fillStyle = it.atEdge ? 'rgba(245,158,11,0.35)' : PART_FILL
      ctx.strokeStyle = it.atEdge ? '#D97706' : PART_STROKE
      ctx.lineWidth = it.atEdge ? 1.6 : (w < 6 ? 0.5 : 1)
      if (it.polygon) {
        ctx.beginPath()
        it.polygon.forEach((pt, vi) => {
          const sx = x + pt.x * sc, sy = y + h - pt.y * sc
          if (vi === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy)
        })
        ctx.closePath(); ctx.fill(); ctx.stroke()
      } else {
        ctx.fillRect(x, y, w, h)
        ctx.strokeRect(x, y, w, h)
      }
      // внутренние вырезы
      if (it.holes?.length) {
        ctx.fillStyle = '#fff'
        ctx.strokeStyle = '#C0392B'
        ctx.lineWidth = 0.8
        it.holes.forEach(poly => {
          ctx.beginPath()
          poly.forEach((pt, vi) => {
            const sx = x + pt.x * sc, sy = y + h - pt.y * sc
            if (vi === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy)
          })
          ctx.closePath(); ctx.fill(); ctx.stroke()
        })
      }
      // Подпись — только если деталь на экране достаточно крупная
      if (w > 26 && h > 12) {
        ctx.fillStyle = 'rgba(0,0,0,0.6)'
        ctx.font = `${Math.max(7, Math.min(13, w / 7))}px sans-serif`
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
        ctx.fillText(it.label, x + w / 2, y + h / 2)
      }
      ctx.globalAlpha = 1
    })
    // номера мелких листов — поверх деталей
    badges.forEach(b => {
      ctx.font = `${b.active ? 'bold ' : ''}${b.fs}px sans-serif`
      const tw = ctx.measureText(b.t).width
      ctx.fillStyle = b.active ? 'rgba(24,95,165,0.92)' : 'rgba(255,255,255,0.9)'
      ctx.fillRect(b.x + 1, b.y + 1, tw + 6, b.fs + 4)
      ctx.fillStyle = b.active ? '#fff' : 'rgba(0,0,0,0.85)'
      ctx.textAlign = 'left'; ctx.textBaseline = 'top'
      ctx.fillText(b.t, b.x + 4, b.y + 3)
    })
  }

  // Новый результат → плавный переезд деталей со старых мест на новые.
  // Одинаковые экземпляры одной детали взаимозаменяемы, поэтому каждому новому
  // месту подбирается ближайший ещё не занятый старый экземпляр той же детали.
  useLayoutEffect(() => {
    const next = targets()
    const prev = curRef.current
    if (animRef.current) { cancelAnimationFrame(animRef.current); animRef.current = null }
    if (!prev.length) { curRef.current = next; draw(next); return }
    const pool = new Map()
    prev.forEach(p => { if (!pool.has(p.di)) pool.set(p.di, []); pool.get(p.di).push(p) })
    const pairs = next.map(t => {
      const list = pool.get(t.di)
      let bi = -1, bd = Infinity
      if (list) list.forEach((p, i) => {
        const d = Math.hypot(p.x - t.x, p.y - t.y)
        if (d < bd) { bd = d; bi = i }
      })
      const from = bi >= 0 ? list.splice(bi, 1)[0] : { ...t, alpha: 0 }
      return { from, to: t }
    })
    const moving = pairs.some(({ from, to }) => Math.abs(from.x - to.x) > 0.5 || Math.abs(from.y - to.y) > 0.5 || from.alpha !== 1)
    if (!moving) { curRef.current = next; draw(next); return }
    const t0 = performance.now()
    const step = now => {
      const k = ease(Math.min(1, (now - t0) / ANIM_MS))
      const frame = pairs.map(({ from, to }) => ({
        ...to,
        x: from.x + (to.x - from.x) * k,
        y: from.y + (to.y - from.y) * k,
        alpha: from.alpha + (1 - from.alpha) * k,
      }))
      curRef.current = frame
      draw(frame)
      animRef.current = k < 1 ? requestAnimationFrame(step) : null
    }
    animRef.current = requestAnimationFrame(step)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheets, labelMode])

  // Сменилось число листов в ряд — детали сразу на новых местах (без анимации)
  useLayoutEffect(() => {
    if (animRef.current) { cancelAnimationFrame(animRef.current); animRef.current = null }
    curRef.current = targets()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cols, boxW])

  // Перерисовка при масштабе/выборе листа (без анимации)
  useLayoutEffect(() => { drawRef.current = draw; draw(curRef.current) })

  useEffect(() => () => { if (animRef.current) cancelAnimationFrame(animRef.current) }, [])

  // Смена числа листов в ряд с сохранением того листа, что был под пальцем
  const anchorRef = useRef(null)
  function changeCols(next, anchorSheet = null, anchorY = 0, pinch = null) {
    const c = Math.max(1, Math.min(MAX_COLS, next, n))
    const cv = canvasRef.current
    if (c === colsRef.current) {
      // число листов в ряд то же — просто вернуть масштаб пальцев к 1
      if (cv && pinch) { cv.style.transition = 'transform 180ms ease-out'; cv.style.transform = 'scale(1)' }
      return
    }
    const el = scrollRef.current
    const si = anchorSheet ?? (el ? Math.min(n - 1, Math.floor(((el.scrollTop - PADDING) / sc) / rowMM) * colsRef.current) : 0)
    anchorRef.current = { si, y: anchorY, ...(pinch ? { k: pinch.k, step: colsRef.current / c, ox: pinch.ox, oy: pinch.oy } : {}) }
    setColsSet(c)
  }
  useLayoutEffect(() => {
    const a = anchorRef.current, el = scrollRef.current
    if (!a || !el) return
    anchorRef.current = null
    const rowTop = Math.floor(a.si / cols) * rowMM * sc + PADDING
    el.scrollTop = Math.max(0, rowTop - a.y)
    draw(curRef.current)
    // Плавный «доезд»: холст был растянут пальцами (k), новая сетка крупнее/мельче
    // в cols-кратном шаге — остаток масштаба плавно уходит в 1
    const cv = canvasRef.current
    if (cv && a.k) {
      const rest = a.k / a.step
      cv.style.transition = 'none'
      cv.style.transformOrigin = `${a.ox}px ${a.oy}px`
      cv.style.transform = `scale(${rest})`
      requestAnimationFrame(() => requestAnimationFrame(() => {
        cv.style.transition = 'transform 180ms ease-out'
        cv.style.transform = 'scale(1)'
      }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cols])

  function sheetAt(clientX, clientY) {
    const el = scrollRef.current
    if (!el) return -1
    const r = el.getBoundingClientRect()
    const mx = (clientX - r.left - PADDING) / sc
    const my = (clientY - r.top + el.scrollTop - PADDING) / sc
    for (let si = 0; si < sheets.length; si++) {
      const o = origin(si), D = dimOf(sheets[si])
      if (mx >= o.x && mx <= o.x + Math.max(D.sw, cellW) && my >= o.y - CAPTION_MM && my <= o.y + D.sl + GAP_MM / 2) return si
    }
    return -1
  }

  // Тап по листу — открыть его
  function onClick(e) {
    if (!onPickSheet) return
    const si = sheetAt(e.clientX, e.clientY)
    if (si >= 0) onPickSheet(si)
  }

  // Щипок двумя пальцами — как в галерее: раздвинуть — меньше листов в ряд, свести — больше
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    // Как в галерее телефона: пока пальцы на экране — холст плавно тянется
    // (CSS-масштаб, без перерисовки), отпустили — сетка встаёт на ближайшее
    // число листов в ряд, остаток масштаба плавно доезжает.
    const st = { active: false, dist: 0, si: 0, y: 0, k: 1, ox: 0, oy: 0 }
    const dist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)
    const onStart = e => {
      if (e.touches.length !== 2) return
      st.active = true; st.dist = dist(e.touches); st.k = 1
      const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2, my = (e.touches[0].clientY + e.touches[1].clientY) / 2
      st.si = Math.max(0, sheetAtRef.current(mx, my))
      const r = el.getBoundingClientRect()
      st.y = my - r.top
      st.ox = mx - r.left; st.oy = my - r.top
      const cv = canvasRef.current
      if (cv) { cv.style.transition = 'none'; cv.style.transformOrigin = `${st.ox}px ${st.oy}px` }
    }
    const onMove = e => {
      if (!st.active || e.touches.length !== 2) return
      if (e.cancelable) e.preventDefault()
      if (st.dist <= 0) return
      const c = colsRef.current
      // пределы: не крупнее 1 листа в ряд и не мельче MAX_COLS (с небольшим «пружинящим» запасом)
      const kMax = c * 1.15, kMin = c / Math.min(MAX_COLS, nRef.current) * 0.87
      st.k = Math.max(kMin, Math.min(kMax, dist(e.touches) / st.dist))
      const cv = canvasRef.current
      if (cv) cv.style.transform = `scale(${st.k})`
    }
    const onEnd = e => {
      if (!st.active || e.touches.length >= 2) return
      st.active = false
      const c = colsRef.current
      const next = Math.round(c / st.k)
      changeColsRef.current(next, st.si, st.y, { k: st.k, ox: st.ox, oy: st.oy })
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
  const sheetAtRef = useRef(sheetAt); sheetAtRef.current = sheetAt
  const nRef = useRef(n); nRef.current = n
  const changeColsRef = useRef(changeCols); changeColsRef.current = changeCols

  const btn = { fontSize: 13, width: 30, height: 26, padding: 0, border: '0.5px solid var(--border-md)',
    borderRadius: 6, background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }
  return (
    <div style={{ position: 'relative' }}>
      <div ref={scrollRef} onScroll={() => {
        // прокрутка — перерисовка раз в кадр, без React
        if (scrollRaf.current) return
        scrollRaf.current = requestAnimationFrame(() => { scrollRaf.current = 0; drawRef.current?.(curRef.current) })
      }}
        style={{ height: viewH, overflowY: contentH > viewH ? 'auto' : 'hidden', overflowX: 'hidden', borderRadius: 8,
          touchAction: 'pan-y', WebkitOverflowScrolling: 'touch' }}>
        <div style={{ height: contentH, position: 'relative' }}>
          <canvas ref={canvasRef} onClick={onClick}
            width={Math.round(canvasW * DPR)} height={Math.round(viewH * DPR)}
            style={{ position: 'sticky', top: 0, width: canvasW, height: viewH, display: 'block',
              cursor: onPickSheet ? 'pointer' : 'default', willChange: 'transform' }} />
        </div>
      </div>
      {/* Под картой, а не поверх неё — чтобы ничего не закрывало укладку */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
        {bufferCount > 0 && !running && (
          <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 6, background: 'rgba(184,92,0,0.12)', color: '#B85C00' }}>
            В буфере: {bufferCount}
          </span>
        )}
        <div style={{ flex: 1 }} />
        {n > 1 && (<>
          <span style={{ fontSize: 10, color: 'var(--text-hint)' }}>в ряд: {cols}</span>
          <button type="button" style={btn} disabled={cols >= Math.min(MAX_COLS, n)} onClick={() => changeCols(cols + 1)} title="Мельче — больше листов в ряд">−</button>
          <button type="button" style={btn} disabled={cols <= 1} onClick={() => changeCols(cols - 1)} title="Крупнее — меньше листов в ряд">+</button>
        </>)}
      </div>
    </div>
  )
}
