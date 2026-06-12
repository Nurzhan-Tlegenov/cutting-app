import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { runNesting, computeOffcuts } from '../lib/nesting'
import BottomNav from '../components/BottomNav'

const COLORS = [
  '#B5D4F4','#9FE1CB','#F5C4B3','#CECBF6','#FAC775',
  '#C0DD97','#F4C0D1','#B4B2A9','#85B7EB','#5DCAA5',
]

function rectsOverlap(a, b) {
  return a.x < b.x + b.w - 1 && a.x + a.w - 1 > b.x &&
         a.y < b.y + b.h - 1 && a.y + a.h - 1 > b.y
}

function SheetCanvas({ sheet, usableX, usableY, sheetL, sheetW, marginL, marginT, kerf, colorMap, onMove, interactive, showOffcuts }) {
  const canvasRef = useRef(null)
  const draggingRef = useRef(null)
  const placedRef = useRef(sheet.placed)
  const lastTap = useRef({ idx: -1, time: 0 })

  useEffect(() => {
    placedRef.current = sheet.placed
    redraw(sheet.placed)
  }, [sheet.placed, showOffcuts])

  const PADDING = 8
  const canvasW = typeof window !== 'undefined' ? Math.min(window.innerWidth - 32, 480) : 360
  const sc = (canvasW - PADDING * 2) / sheetW
  const canvasH = Math.round(sc * sheetL) + PADDING * 2
  

  const toC = v => v * sc
  const fromC = v => v / sc

  function redraw(items, dragIdx = -1) {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, canvasW, canvasH)

    // Фон листа
    ctx.fillStyle = '#F1EFE8'
    ctx.fillRect(0, 0, canvasW, canvasH)

    // Рабочая зона: X=usableX (горизонталь), Y=usableY (вертикаль)
    const rx = PADDING + toC(marginL), ry = PADDING + toC(marginT)
    const rw = toC(usableX), rh = toC(usableY)
    ctx.fillStyle = '#fff'
    ctx.fillRect(rx, ry, rw, rh)

    // Обрезки
    if (showOffcuts && sheet.freeRects) {
      const offcuts = computeOffcuts(sheet, usableX, usableY)
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
        // Размер обрезка
        ctx.fillStyle = '#3B6D11'
        ctx.font = `${Math.max(8, Math.min(10, ow / 8))}px sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        if (ow > 30 && oh > 14) {
          ctx.fillText(`${o.w}×${o.h}`, ox + ow / 2, oy + oh / 2)
        }
      })
    }

    // Детали
    items.forEach((p, i) => {
      // p.x,p.w = X-координаты; p.y,p.h = Y-координаты
      const x = rx + toC(p.x), y = ry + toC(p.y)
      const w = toC(p.w) - toC(kerf), h = toC(p.h) - toC(kerf)
      const isDragging = i === dragIdx

      // Проверяем коллизии
      const hasCollision = isDragging && items.some((o, j) => j !== i && rectsOverlap(
        { x: p.x, y: p.y, w: p.w - kerf, h: p.h - kerf },
        { x: o.x, y: o.y, w: o.w - kerf, h: o.h - kerf }
      ))

      ctx.fillStyle = hasCollision ? 'rgba(226,75,74,0.4)' : (isDragging ? colorMap[p.detailIndex] + 'cc' : colorMap[p.detailIndex] || COLORS[p.detailIndex % COLORS.length])
      ctx.fillRect(x, y, w, h)
      ctx.strokeStyle = hasCollision ? '#E24B4A' : 'rgba(0,0,0,0.15)'
      ctx.lineWidth = hasCollision ? 2 : 0.5
      ctx.strokeRect(x, y, w, h)

      // Кромка
      ctx.strokeStyle = '#185FA5'
      ctx.lineWidth = 2
      if (p.edgeTop) { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + w, y); ctx.stroke() }
      if (p.edgeBottom) { ctx.beginPath(); ctx.moveTo(x, y + h); ctx.lineTo(x + w, y + h); ctx.stroke() }
      if (p.edgeLeft) { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + h); ctx.stroke() }
      if (p.edgeRight) { ctx.beginPath(); ctx.moveTo(x + w, y); ctx.lineTo(x + w, y + h); ctx.stroke() }

      // Метка
      ctx.fillStyle = 'rgba(0,0,0,0.6)'
      ctx.font = `${Math.max(7, Math.min(10, w / 7))}px sans-serif`
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      const lbl = (p.prefix ? p.prefix.slice(0,3) + ' ' : '') + p.label.replace(/Деталь\s*/, 'Д')
      if (h > 14) ctx.fillText(lbl, x + w / 2, y + h / 2 - 5)
      ctx.fillStyle = 'rgba(0,0,0,0.4)'
      ctx.font = `${Math.max(6, Math.min(8, w / 9))}px sans-serif`
      if (h > 26) ctx.fillText(`${p.originalW}×${p.originalH}`, x + w / 2, y + h / 2 + 6)
    })

    // Рамка: X=sheetW(горизонталь), Y=sheetL(вертикаль)
    ctx.strokeStyle = '#888780'
    ctx.lineWidth = 1
    ctx.setLineDash([])
    ctx.strokeRect(PADDING, PADDING, toC(sheetW), toC(sheetL))
  }

  function getPointer(e) {
    const rect = canvasRef.current.getBoundingClientRect()
    const scaleX = canvasRef.current.width / rect.width
    const touch = e.touches?.[0] || e
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

  function applyMagnet(nx, ny, pw, ph, idx, items) {
    const SNAP = 50
    let sx = nx, sy = ny
    for (let i = 0; i < items.length; i++) {
      if (i === idx) continue
      const o = items[i]
      if (Math.abs(sx - (o.x + o.w)) < SNAP) sx = o.x + o.w
      if (Math.abs(sx - (o.x - pw)) < SNAP) sx = o.x - pw
      if (Math.abs(sx - o.x) < SNAP) sx = o.x
      if (Math.abs(sy - (o.y + o.h)) < SNAP) sy = o.y + o.h
      if (Math.abs(sy - (o.y - ph)) < SNAP) sy = o.y - ph
      if (Math.abs(sy - o.y) < SNAP) sy = o.y
    }
    if (Math.abs(sx) < SNAP) sx = 0
    if (Math.abs(sy) < SNAP) sy = 0
    if (Math.abs(sx + pw - usableX) < SNAP) sx = usableX - pw
    if (Math.abs(sy + ph - usableY) < SNAP) sy = usableY - ph
    return { x: sx, y: sy }
  }

  function onPointerDown(e) {
    if (!interactive) return
    const { x, y } = getPointer(e)
    const idx = findPiece(x, y)
    if (idx === -1) return
    e.preventDefault()
    const p = placedRef.current[idx]
    draggingRef.current = { idx, startX: x, startY: y, origX: p.x, origY: p.y }
  }

  function onPointerMove(e) {
    if (!draggingRef.current) return
    e.preventDefault()
    const { x, y } = getPointer(e)
    const { idx, startX, startY, origX, origY } = draggingRef.current
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
    const drag = draggingRef.current
    if (!drag) return
    const { x, y } = getPointer(e)
    const dist = Math.hypot(x - drag.startX, y - drag.startY)

    if (dist < 8 && interactive) {
      const now = Date.now()
      const isDoubleTap = lastTap.current.idx === drag.idx && (now - lastTap.current.time) < 400
      lastTap.current = { idx: drag.idx, time: now }
      if (isDoubleTap) {
        const p = placedRef.current[drag.idx]
        const rotated = {
          ...p, w: p.h, h: p.w,
          originalW: p.originalH, originalH: p.originalW, rotated: !p.rotated,
          edgeTop: p.edgeLeft, edgeRight: p.edgeTop,
          edgeBottom: p.edgeRight, edgeLeft: p.edgeBottom,
        }
        if (rotated.x + rotated.w <= usableX && rotated.y + rotated.h <= usableY) {
          const updated = placedRef.current.map((item, i) => i === drag.idx ? rotated : item)
          placedRef.current = updated
          redraw(updated)
          if (onMove) onMove(sheet.index, updated)
        }
        draggingRef.current = null
        return
      }
    }

    // Проверяем коллизии — если есть, возвращаем на место
    const p = placedRef.current[drag.idx]
    const hasCollision = placedRef.current.some((o, j) => j !== drag.idx && rectsOverlap(
      { x: p.x, y: p.y, w: p.w - kerf, h: p.h - kerf },
      { x: o.x, y: o.y, w: o.w - kerf, h: o.h - kerf }
    ))

    if (hasCollision) {
      const restored = placedRef.current.map((item, i) => i === drag.idx ? { ...item, x: drag.origX, y: drag.origY } : item)
      placedRef.current = restored
      redraw(restored)
      if (onMove) onMove(sheet.index, restored)
    } else {
      redraw(placedRef.current)
      if (onMove) onMove(sheet.index, placedRef.current)
    }
    draggingRef.current = null
  }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    redraw(placedRef.current)
  }, [])

  return (
    <canvas ref={canvasRef} width={canvasW} height={canvasH}
      style={{ width: '100%', borderRadius: 8, display: 'block', touchAction: interactive ? 'none' : 'auto' }}
      onMouseDown={onPointerDown} onMouseMove={onPointerMove} onMouseUp={onPointerUp}
      onTouchStart={onPointerDown} onTouchMove={onPointerMove} onTouchEnd={onPointerUp}
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
  const [activeSheet, setActiveSheet] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [sheetsData, setSheetsData] = useState([])
  const [nestDir, setNestDir] = useState('auto')
  const [showOffcuts, setShowOffcuts] = useState(false)

  const colorMap = {}
  details.forEach((d, i) => { colorMap[i] = COLORS[i % COLORS.length] })

  useEffect(() => { fetchOrder() }, [id])

  async function fetchOrder() {
    const { data: o } = await supabase.from('orders').select('*').eq('id', id).single()
    const { data: d } = await supabase.from('order_details').select('*').eq('order_id', id).order('sort_order')
    setOrder(o); setDetails(d || [])
    if (o?.nesting_result) {
      const saved = JSON.parse(o.nesting_result)
      setResult(saved); setSheetsData(saved.sheets)
    }
  }

  function doNesting() {
    if (!details.length || !order) return
    setRunning(true)
    setTimeout(() => {
      try {
        const res = runNesting({
          details, direction: nestDir,
          sheetL: order.sheet_length, sheetW: order.sheet_width,
          marginT: order.margin_top, marginR: order.margin_right,
          marginB: order.margin_bottom, marginL: order.margin_left,
          kerf: order.kerf_width,
        })
        setResult(res)
        setSheetsData(res.sheets.map(s => ({ ...s, freeRects: s.freeRects || [] })))
        setActiveSheet(0)
      } finally { setRunning(false) }
    }, 100)
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

      {/* Кнопка раскроя */}
      <button onClick={doNesting} disabled={running}
        style={{ width: '100%', padding: 12, background: running ? 'var(--bg2)' : 'var(--blue)',
          color: running ? 'var(--text-hint)' : 'white', border: 'none', borderRadius: 'var(--radius)',
          fontSize: 15, fontWeight: 500, cursor: running ? 'default' : 'pointer', marginBottom: 16 }}>
        {running ? '⏳ Выполняется...' : result ? '🔄 Пересчитать раскрой' : '▶ Выполнить раскрой'}
      </button>

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
              <span style={{ fontSize: 13, fontWeight: 500 }}>Лист {activeSheet + 1} из {sheetsData.length}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 11, color: 'var(--text-hint)' }}>{sheetsData[activeSheet]?.placed.length} дет.</span>
                <button onClick={() => setShowOffcuts(v => !v)}
                  style={{ padding: '4px 10px', borderRadius: 20, border: `0.5px solid ${showOffcuts ? 'var(--teal)' : 'var(--border-md)'}`,
                    background: showOffcuts ? 'var(--teal-light)' : 'transparent',
                    color: showOffcuts ? 'var(--teal)' : 'var(--text-hint)', fontSize: 11, cursor: 'pointer' }}>
                  {showOffcuts ? '✓ Обрезки' : 'Обрезки'}
                </button>
              </div>
            </div>
            <SheetCanvas
              sheet={sheetsData[activeSheet]}
              usableX={result.usableX} usableY={result.usableY}
              sheetL={order.sheet_length} sheetW={order.sheet_width}
              marginL={order.margin_left} marginT={order.margin_top}
              kerf={order.kerf_width} colorMap={colorMap}
              onMove={onMove} interactive={true} showOffcuts={showOffcuts}
            />
            <p style={{ fontSize: 11, color: 'var(--text-hint)', textAlign: 'center', marginTop: 6 }}>
              Двойной тап — повернуть деталь · Удержи и тяни — переместить
            </p>
          </div>

          {/* Легенда */}
          <div className="card" style={{ marginBottom: 12 }}>
            <p className="section-title">Детали на листе {activeSheet + 1}</p>
            {sheetsData[activeSheet]?.placed.map((p, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, padding: '4px 0', borderBottom: '0.5px solid var(--border)' }}>
                <div style={{ width: 12, height: 12, borderRadius: 3, background: colorMap[p.detailIndex], flexShrink: 0 }} />
                <span style={{ flex: 1 }}>{p.label}</span>
                <span style={{ color: 'var(--text-hint)' }}>{p.origY ?? p.originalH}×{p.origX ?? p.originalW}</span>
                {p.rotated && <span style={{ color: 'var(--teal)', fontSize: 11 }}>↻</span>}
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
