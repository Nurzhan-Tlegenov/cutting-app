import { useState, useEffect, useLayoutEffect, useRef } from 'react'

// ─── Обзор ВСЕХ листов раскроя на одном холсте ──────────────────────────────
// Нужен для онлайн-раскроя: пока идёт поиск, пользователь видит, как укладка
// уплотняется. При каждом новом результате детали не «перескакивают», а плавно
// переезжают на новые места (в том числе с листа на лист) — видно само сжатие.
// Щипок двумя пальцами — масштаб; тап по листу — открыть этот лист для
// просмотра и редактирования (onPickSheet).
//
// Координаты данных — как везде в раскрое: Y вверх от низа рабочей зоны, контур
// polygon — Y вверх. На холсте Y идёт сверху вниз (тот же переворот, что и в
// SheetCanvas).

const PART_FILL = '#E6E6E6'
const PART_STROKE = 'rgba(20,20,20,0.75)'
const GAP_MM = 120      // промежуток между листами, мм (в масштабе листа)
const CAPTION_MM = 190  // место под подпись над листом, мм
const ANIM_MS = 600

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
  activeSheet = -1, onPickSheet, running = false, bufferCount = 0,
}) {
  const canvasRef = useRef(null)
  const wrapRef = useRef(null)
  const [zoom, setZoom] = useState(1)
  const [pinching, setPinching] = useState(false)
  const zoomRef = useRef(1)
  zoomRef.current = zoom
  const anchorRef = useRef(null)
  const pinchRef = useRef({ active: false, dist: 0, zoom: 1 })
  const curRef = useRef([])     // что сейчас нарисовано (с учётом анимации), мм общей раскладки
  const animRef = useRef(null)  // requestAnimationFrame id

  const n = Math.max(1, sheets.length)
  const cols = n === 1 ? 1 : n <= 4 ? 2 : 3
  const rows = Math.ceil(n / cols)
  const totalW = cols * sheetW + (cols - 1) * GAP_MM
  const totalH = rows * (CAPTION_MM + sheetL) + (rows - 1) * GAP_MM
  const PADDING = 6
  const baseW = typeof window !== 'undefined' ? Math.min(window.innerWidth - 32, 480) : 360
  const canvasW = baseW * zoom
  const sc = (canvasW - PADDING * 2) / totalW
  const canvasH = Math.round(totalH * sc) + PADDING * 2
  const DPR = pinching ? 1 : Math.min(typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1, Math.sqrt(12e6 / (canvasW * canvasH)))

  const origin = si => ({
    x: (si % cols) * (sheetW + GAP_MM),
    y: Math.floor(si / cols) * (CAPTION_MM + sheetL + GAP_MM) + CAPTION_MM,
  })

  // Целевое положение каждой детали в общей раскладке (мм, Y сверху вниз)
  function targets() {
    const out = []
    sheets.forEach((s, si) => {
      const o = origin(si)
      s.placed.forEach(p => {
        const w = p.w - kerf, h = p.h - kerf
        out.push({
          di: p.detailIndex, sheet: si,
          x: o.x + marginL + p.x,
          y: o.y + marginT + (usableY - p.y - h),
          w, h, polygon: Array.isArray(p.polygon) && p.polygon.length > 2 ? p.polygon : null,
          label: (p.prefix ? p.prefix.slice(0, 3) + ' ' : '') + String(p.label || '').replace(/Деталь\s*/, 'Д'),
          alpha: 1,
        })
      })
    })
    return out
  }

  function draw(items) {
    const canvas = canvasRef.current
    if (!canvas) return
    if (canvas.width !== Math.round(canvasW * DPR) || canvas.height !== Math.round(canvasH * DPR)) {
      canvas.width = Math.round(canvasW * DPR)
      canvas.height = Math.round(canvasH * DPR)
    }
    const ctx = canvas.getContext('2d')
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
    ctx.clearRect(0, 0, canvasW, canvasH)
    const X = v => PADDING + v * sc
    const usableArea = usableX * usableY

    // Листы
    sheets.forEach((s, si) => {
      const o = origin(si)
      ctx.fillStyle = '#F1EFE8'
      ctx.fillRect(X(o.x), X(o.y), sheetW * sc, sheetL * sc)
      ctx.fillStyle = '#fff'
      ctx.fillRect(X(o.x + marginL), X(o.y + marginT), usableX * sc, usableY * sc)
      const active = si === activeSheet
      ctx.strokeStyle = active ? '#185FA5' : '#888780'
      ctx.lineWidth = active ? 2 : 1
      ctx.strokeRect(X(o.x), X(o.y), sheetW * sc, sheetL * sc)
      // Подпись над листом
      const fill = s.placed.reduce((a, p) => a + partArea(p), 0) / usableArea
      const fs = Math.max(9, Math.min(13, CAPTION_MM * sc * 0.62))
      ctx.font = `${active ? 'bold ' : ''}${fs}px sans-serif`
      ctx.fillStyle = active ? '#185FA5' : 'rgba(0,0,0,0.65)'
      ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'
      ctx.fillText(`Лист ${si + 1} · ${s.placed.length} дет. · ${Math.round(fill * 100)}%`, X(o.x), X(o.y) - 2)
    })

    // Детали
    items.forEach(it => {
      const x = X(it.x), y = X(it.y), w = it.w * sc, h = it.h * sc
      ctx.globalAlpha = it.alpha
      ctx.fillStyle = PART_FILL
      ctx.strokeStyle = PART_STROKE
      ctx.lineWidth = 1
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
      // Подпись — только если деталь на экране достаточно крупная
      if (w > 26 && h > 12) {
        ctx.fillStyle = 'rgba(0,0,0,0.6)'
        ctx.font = `${Math.max(7, Math.min(11, w / 7))}px sans-serif`
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
        ctx.fillText(it.label, x + w / 2, y + h / 2)
      }
      ctx.globalAlpha = 1
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
  }, [sheets])

  // Перерисовка при масштабе/выборе листа (без анимации)
  useLayoutEffect(() => { draw(curRef.current) })

  useEffect(() => () => { if (animRef.current) cancelAnimationFrame(animRef.current) }, [])

  // Тап по листу — открыть его
  function onClick(e) {
    if (!onPickSheet) return
    const rect = canvasRef.current.getBoundingClientRect()
    const k = rect.width ? canvasW / rect.width : 1
    const mx = ((e.clientX - rect.left) * k - PADDING) / sc
    const my = ((e.clientY - rect.top) * k - PADDING) / sc
    for (let si = 0; si < sheets.length; si++) {
      const o = origin(si)
      if (mx >= o.x && mx <= o.x + sheetW && my >= o.y - CAPTION_MM && my <= o.y + sheetL) { onPickSheet(si); return }
    }
  }

  // Щипок двумя пальцами — масштаб (как на карте листа)
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
      st.active = true; st.dist = dist(e.touches); st.zoom = zoomRef.current
      setPinching(true); setAnchor(e.touches, true)
    }
    const onMove = e => {
      if (!st.active || e.touches.length !== 2) return
      if (e.cancelable) e.preventDefault()
      if (st.dist <= 0) return
      let nz = Math.max(1, Math.min(5, st.zoom * dist(e.touches) / st.dist))
      if (nz < 1.04) nz = 1
      setAnchor(e.touches, false)
      if (Math.abs(nz - zoomRef.current) < 0.001) applyAnchor()
      else setZoom(nz)
    }
    const onEnd = e => {
      if (e.touches.length < 2 && st.active) {
        st.active = false; setPinching(false)
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
        <canvas ref={canvasRef} onClick={onClick}
          width={Math.round(canvasW * DPR)} height={Math.round(canvasH * DPR)}
          style={{ width: canvasW, height: 'auto', aspectRatio: `${canvasW} / ${canvasH}`, maxWidth: zoom > 1 ? 'none' : '100%',
            display: 'block', touchAction: zoom > 1 ? 'pan-x pan-y' : 'pan-y', cursor: onPickSheet ? 'pointer' : 'default' }} />
      </div>
      {zoom > 1.02 && (
        <button type="button" onClick={() => { setZoom(1); if (wrapRef.current) { wrapRef.current.scrollLeft = 0; wrapRef.current.scrollTop = 0 } }}
          style={{ position: 'absolute', top: 6, right: 6, fontSize: 10, padding: '3px 8px', border: '0.5px solid var(--border-md)',
            borderRadius: 6, background: 'rgba(255,255,255,0.92)', color: 'var(--text-muted)', cursor: 'pointer' }}>
          {Math.round(zoom * 100)}% · сброс
        </button>
      )}
      {running && (
        <div style={{ position: 'absolute', top: 6, left: 6, fontSize: 10, padding: '3px 8px', borderRadius: 6,
          background: 'rgba(24,95,165,0.9)', color: 'white', pointerEvents: 'none' }}>
          ● идёт оптимизация
        </div>
      )}
      {bufferCount > 0 && !running && (
        <div style={{ position: 'absolute', bottom: 6, left: 6, fontSize: 10, padding: '3px 8px', borderRadius: 6,
          background: 'rgba(184,92,0,0.9)', color: 'white', pointerEvents: 'none' }}>
          В буфере: {bufferCount}
        </div>
      )}
    </div>
  )
}
