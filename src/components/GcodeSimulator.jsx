import { useEffect, useMemo, useRef, useState } from 'react'
import { parseGcode, fmtTime } from '../lib/gcodeSim'

// Симулятор G-кода: вид сверху, фреза идёт по программе. Рез рисуется шириной инструмента:
// синий — сквозной (до стола), зелёный — на глубину (пазы, выемки, глухие отверстия);
// холостые перемещения — серым пунктиром. Щипок / колесо — масштаб, перетаскивание — сдвиг.
//
// text — G-код; sheet — { x, y, w, l } лист в координатах станка; outlines — контуры деталей
// [[x, y]…] в тех же координатах; toolDia(T) — диаметр инструмента по номеру; thickness; rapid.

const SPEEDS = [1, 5, 20, 60, 200]
const C_THROUGH = '#185FA5', C_DEPTH = '#1D9E75', C_RAPID = 'rgba(95,94,90,0.55)'

export default function GcodeSimulator({ text, sheet, outlines = [], toolDia, thickness = 16, rapid = 20000, title = '', onClose }) {
  const prog = useMemo(() => parseGcode(text, { rapid }), [text, rapid])
  const wrapRef = useRef(null), canvasRef = useRef(null)
  const tRef = useRef(0), rafRef = useRef(0), lastRef = useRef(0)
  const viewRef = useRef({ k: 1, dx: 0, dy: 0 })       // масштаб и сдвиг пользователя (поверх «вписать»)
  const ptrs = useRef(new Map()), pinch = useRef(null)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(20)
  const [showRapid, setShowRapid] = useState(true)
  const [, setTick] = useState(0)
  const [box, setBox] = useState({ w: 360, h: 480 })
  const speedRef = useRef(speed); speedRef.current = speed
  const rapidRef = useRef(showRapid); rapidRef.current = showRapid

  const area = useMemo(() => {
    const b = prog.box
    const x0 = Math.min(sheet?.x ?? b.x0, b.x0), y0 = Math.min(sheet?.y ?? b.y0, b.y0)
    const x1 = Math.max(sheet ? sheet.x + sheet.w : b.x1, b.x1), y1 = Math.max(sheet ? sheet.y + sheet.l : b.y1, b.y1)
    return { x0, y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) }
  }, [prog, sheet])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const upd = () => { const w = el.clientWidth; if (w > 0) setBox({ w, h: Math.max(240, Math.min(Math.round(window.innerHeight * 0.62), Math.round(w * area.h / area.w) + 12)) }) }
    upd()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(upd); ro.observe(el)
    return () => ro.disconnect()
  }, [area])

  // индекс текущего перемещения по времени
  const moveAt = t => {
    const m = prog.moves
    let lo = 0, hi = m.length - 1
    if (hi < 0) return -1
    while (lo < hi) { const mid = (lo + hi) >> 1; if (m[mid].t1 < t) lo = mid + 1; else hi = mid }
    return lo
  }

  const draw = () => {
    const cv = canvasRef.current
    if (!cv) return
    const DPR = Math.min(window.devicePixelRatio || 1, 2.5)
    if (cv.width !== Math.round(box.w * DPR) || cv.height !== Math.round(box.h * DPR)) { cv.width = Math.round(box.w * DPR); cv.height = Math.round(box.h * DPR) }
    const ctx = cv.getContext('2d')
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
    ctx.clearRect(0, 0, box.w, box.h)
    const P = 6, v = viewRef.current
    const fit = Math.min((box.w - P * 2) / area.w, (box.h - P * 2) / area.h)
    const sc = fit * v.k
    const X = x => P + (box.w - P * 2 - area.w * fit) / 2 + v.dx + (x - area.x0) * sc
    const Y = y => P + v.dy + (area.h - (y - area.y0)) * sc
    // лист и детали
    if (sheet) {
      ctx.fillStyle = '#fff'; ctx.strokeStyle = '#888780'; ctx.lineWidth = 1
      ctx.fillRect(X(sheet.x), Y(sheet.y + sheet.l), sheet.w * sc, sheet.l * sc)
      ctx.strokeRect(X(sheet.x), Y(sheet.y + sheet.l), sheet.w * sc, sheet.l * sc)
    }
    ctx.fillStyle = '#ECEAE3'; ctx.strokeStyle = 'rgba(20,20,20,0.35)'; ctx.lineWidth = 0.6
    outlines.forEach(pts => {
      ctx.beginPath()
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))))
      ctx.closePath(); ctx.fill(); ctx.stroke()
    })
    // путь до текущего момента
    const t = tRef.current, moves = prog.moves, cur = moveAt(t)
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'
    let pos = null
    const rapids = []
    for (let i = 0; i <= cur; i++) {
      const m = moves[i]
      let x1 = m.x1, y1 = m.y1, z1 = m.z1
      if (i === cur && t < m.t1) { const f = m.t1 > m.t0 ? Math.max(0, (t - m.t0) / (m.t1 - m.t0)) : 1; x1 = m.x0 + (m.x1 - m.x0) * f; y1 = m.y0 + (m.y1 - m.y0) * f; z1 = m.z0 + (m.z1 - m.z0) * f }
      pos = { x: x1, y: y1, z: z1, m }
      if (m.rapid) { rapids.push(m.x0, m.y0, x1, y1); continue }
      const zLow = Math.min(m.z0, z1)
      if (zLow >= thickness - 0.001) continue
      const d = Math.max(1, (toolDia?.(m.tool) || 3) * sc)
      ctx.strokeStyle = ctx.fillStyle = zLow <= 0.6 ? C_THROUGH : C_DEPTH
      if (Math.abs(m.x0 - x1) < 1e-6 && Math.abs(m.y0 - y1) < 1e-6) { ctx.beginPath(); ctx.arc(X(x1), Y(y1), d / 2, 0, Math.PI * 2); ctx.fill(); continue }
      ctx.lineWidth = d
      ctx.beginPath(); ctx.moveTo(X(m.x0), Y(m.y0)); ctx.lineTo(X(x1), Y(y1)); ctx.stroke()
    }
    if (rapidRef.current && rapids.length) {
      ctx.strokeStyle = C_RAPID; ctx.lineWidth = 0.7; ctx.setLineDash([4, 3])
      ctx.beginPath()
      for (let i = 0; i < rapids.length; i += 4) { ctx.moveTo(X(rapids[i]), Y(rapids[i + 1])); ctx.lineTo(X(rapids[i + 2]), Y(rapids[i + 3])) }
      ctx.stroke(); ctx.setLineDash([])
    }
    if (pos) {
      const r = Math.max(4, (toolDia?.(pos.m.tool) || 3) * sc / 2)
      ctx.strokeStyle = '#E24B4A'; ctx.lineWidth = 2; ctx.fillStyle = pos.z < thickness ? 'rgba(226,75,74,0.35)' : 'rgba(226,75,74,0.08)'
      ctx.beginPath(); ctx.arc(X(pos.x), Y(pos.y), r, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(X(pos.x) - r - 4, Y(pos.y)); ctx.lineTo(X(pos.x) + r + 4, Y(pos.y)); ctx.moveTo(X(pos.x), Y(pos.y) - r - 4); ctx.lineTo(X(pos.x), Y(pos.y) + r + 4)
      ctx.lineWidth = 0.8; ctx.stroke()
    }
  }
  const drawRef = useRef(draw); drawRef.current = draw

  // проигрывание
  useEffect(() => {
    if (!playing) return
    lastRef.current = 0
    const step = ts => {
      if (lastRef.current) tRef.current = Math.min(prog.time, tRef.current + (ts - lastRef.current) / 1000 * speedRef.current)
      lastRef.current = ts
      drawRef.current(); setTick(x => x + 1)
      if (tRef.current >= prog.time) { setPlaying(false); return }
      rafRef.current = requestAnimationFrame(step)
    }
    rafRef.current = requestAnimationFrame(step)
    return () => cancelAnimationFrame(rafRef.current)
  }, [playing, prog])
  useEffect(() => { tRef.current = 0; viewRef.current = { k: 1, dx: 0, dy: 0 }; setPlaying(false); setTick(x => x + 1) }, [prog])
  useEffect(() => { drawRef.current() })

  // масштаб и сдвиг
  const zoomAt = (px, py, f) => {
    const v = viewRef.current, k = Math.max(1, Math.min(40, v.k * f)), r = k / v.k
    const cx = px - 6 - (box.w - 12 - area.w * Math.min((box.w - 12) / area.w, (box.h - 12) / area.h)) / 2, cy = py - 6
    viewRef.current = { k, dx: k === 1 ? 0 : cx - (cx - v.dx) * r, dy: k === 1 ? 0 : cy - (cy - v.dy) * r }
    drawRef.current()
  }
  const local = e => { const r = canvasRef.current.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top] }
  const onDown = e => { canvasRef.current.setPointerCapture?.(e.pointerId); ptrs.current.set(e.pointerId, local(e)); pinch.current = null }
  const onMove = e => {
    if (!ptrs.current.has(e.pointerId)) return
    const prev = ptrs.current.get(e.pointerId), now = local(e)
    ptrs.current.set(e.pointerId, now)
    const pts = [...ptrs.current.values()]
    if (pts.length === 1) { const v = viewRef.current; if (v.k > 1) { viewRef.current = { ...v, dx: v.dx + now[0] - prev[0], dy: v.dy + now[1] - prev[1] }; drawRef.current() } }
    else if (pts.length === 2) {
      const d = Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1])
      if (pinch.current) zoomAt((pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2, d / pinch.current)
      pinch.current = d
    }
  }
  const onUp = e => { ptrs.current.delete(e.pointerId); pinch.current = null }
  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const wheel = e => { e.preventDefault(); const [x, y] = local(e); zoomAt(x, y, e.deltaY < 0 ? 1.25 : 0.8) }
    cv.addEventListener('wheel', wheel, { passive: false })
    return () => cv.removeEventListener('wheel', wheel)
  })

  const t = tRef.current, ci = moveAt(t), cm = ci >= 0 ? prog.moves[ci] : null
  const line = cm ? cm.line : 0
  const from = Math.max(0, Math.min(line - 2, prog.lines.length - 5))
  const seek = v => { tRef.current = Number(v); setTick(x => x + 1) }
  const chip = on => ({ padding: '5px 9px', borderRadius: 20, fontSize: 12, border: 'none', background: on ? 'var(--blue)' : 'var(--bg2)', color: on ? 'white' : 'var(--text-muted)' })

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <div style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title || 'Симулятор'}</div>
        <span style={{ fontSize: 11, color: 'var(--text-hint)', whiteSpace: 'nowrap' }}>{fmtTime(t)} / {fmtTime(prog.time)}</span>
        {onClose && <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, color: 'var(--text-muted)', padding: '0 4px' }}>×</button>}
      </div>
      <div ref={wrapRef} style={{ background: 'var(--bg3)', borderRadius: 'var(--radius)', overflow: 'hidden', touchAction: 'none' }}>
        <canvas ref={canvasRef} style={{ width: box.w, height: box.h, display: 'block' }}
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} />
      </div>
      <input type="range" min={0} max={prog.time || 1} step="any" value={t} onChange={e => seek(e.target.value)} style={{ width: '100%', padding: 0, margin: '8px 0 4px', border: 'none' }} />
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" onClick={() => { if (t >= prog.time) tRef.current = 0; setPlaying(p => !p) }}
          style={{ padding: '7px 16px', borderRadius: 20, border: 'none', background: 'var(--blue)', color: 'white', fontSize: 14, fontWeight: 500 }}>{playing ? '⏸ Пауза' : '▶ Пуск'}</button>
        <button type="button" onClick={() => { setPlaying(false); seek(0) }} style={chip(false)}>⏮</button>
        <button type="button" onClick={() => { setPlaying(false); seek(prog.time) }} style={chip(false)}>⏭</button>
        <span style={{ flex: 1 }} />
        {SPEEDS.map(s => <button key={s} type="button" onClick={() => setSpeed(s)} style={chip(speed === s)}>×{s}</button>)}
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 8, fontSize: 12, color: 'var(--text-muted)', flexWrap: 'wrap' }}>
        <span>T{cm?.tool ?? '—'}</span>
        <span>X{cm ? Math.round(cm.x1 * 10) / 10 : 0} Y{cm ? Math.round(cm.y1 * 10) / 10 : 0} Z{cm ? Math.round(cm.z1 * 100) / 100 : 0}</span>
        <span>{cm?.rapid ? 'холостой' : `F${cm ? Math.round(cm.feed) : 0}`}</span>
        <label style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
          <input type="checkbox" checked={showRapid} onChange={e => setShowRapid(e.target.checked)} style={{ width: 15, height: 15 }} /> холостые
        </label>
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 4, fontSize: 11, color: 'var(--text-hint)' }}>
        <span><i style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: C_THROUGH, marginRight: 4 }} />сквозной рез</span>
        <span><i style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: C_DEPTH, marginRight: 4 }} />на глубину</span>
      </div>
      <pre style={{ margin: '8px 0 0', padding: '6px 8px', background: 'var(--bg2)', borderRadius: 'var(--radius)', fontSize: 11, lineHeight: 1.5, overflow: 'hidden', fontFamily: 'monospace' }}>
        {prog.lines.slice(from, from + 5).map((s, i) => (
          <div key={from + i} style={{ color: from + i === line ? 'var(--blue)' : 'var(--text-hint)', fontWeight: from + i === line ? 600 : 400, whiteSpace: 'nowrap' }}>
            {String(from + i + 1).padStart(4, ' ')}  {s || ' '}
          </div>
        ))}
      </pre>
    </div>
  )
}
