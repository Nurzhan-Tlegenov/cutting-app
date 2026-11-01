// Картинка на весь экран с увеличением: щипок двумя пальцами, двойное нажатие (×2,5 в этой точке / обратно),
// перетаскивание одним пальцем, колёсико мыши. Масштаб страницы в приложении запрещён — здесь свой.
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

const MAX = 8
export default function ImageZoom({ src, alt = '', onClose }) {
  const box = useRef(null)
  const [v, setV] = useState({ s: 1, x: 0, y: 0 })
  const vRef = useRef(v)
  useEffect(() => { vRef.current = v }, [v])
  useEffect(() => {
    const el = box.current
    if (!el) return
    let g = null, lastTap = 0, moved = false
    const center = () => { const r = el.getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 } }
    // масштаб s вокруг точки экрана (px, py)
    const zoomAt = (s, px, py, from = vRef.current) => {
      s = Math.max(1, Math.min(MAX, s))
      const { cx, cy } = center(), k = s / from.s
      const x = s === 1 ? 0 : px - cx - (px - cx - from.x) * k, y = s === 1 ? 0 : py - cy - (py - cy - from.y) * k
      setV({ s, x, y })
    }
    const pts = e => [...e.touches].map(t => ({ x: t.clientX, y: t.clientY }))
    const start = e => {
      const p = pts(e); moved = false
      if (p.length === 2) g = { kind: 'pinch', d: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y), mx: (p[0].x + p[1].x) / 2, my: (p[0].y + p[1].y) / 2, v: vRef.current }
      else if (p.length === 1) g = { kind: 'pan', x: p[0].x, y: p[0].y, v: vRef.current }
    }
    const move = e => {
      if (!g) return
      e.preventDefault()
      const p = pts(e)
      if (g.kind === 'pinch' && p.length === 2) {
        const d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y), mx = (p[0].x + p[1].x) / 2, my = (p[0].y + p[1].y) / 2
        const s = Math.max(1, Math.min(MAX, g.v.s * d / g.d)), { cx, cy } = center(), k = s / g.v.s
        setV(s === 1 ? { s: 1, x: 0, y: 0 } : { s, x: mx - cx - (g.mx - cx - g.v.x) * k, y: my - cy - (g.my - cy - g.v.y) * k })
        moved = true
      } else if (g.kind === 'pan' && p.length === 1) {
        const dx = p[0].x - g.x, dy = p[0].y - g.y
        if (Math.abs(dx) + Math.abs(dy) > 6) moved = true
        if (g.v.s > 1) setV({ ...g.v, x: g.v.x + dx, y: g.v.y + dy })
      }
    }
    const end = e => {
      const was = g; g = null
      if (e.touches.length === 1) { start(e); return }      // отпустили один палец из двух — продолжаем двигать
      if (!was || was.kind !== 'pan' || moved) return
      const t = e.changedTouches[0], now = Date.now()
      if (now - lastTap < 300) { lastTap = 0; const cur = vRef.current; zoomAt(cur.s > 1.05 ? 1 : 2.5, t.clientX, t.clientY, cur) }
      else lastTap = now
    }
    const wheel = e => { e.preventDefault(); const cur = vRef.current; zoomAt(cur.s * (e.deltaY < 0 ? 1.2 : 1 / 1.2), e.clientX, e.clientY, cur) }
    const dbl = e => { const cur = vRef.current; zoomAt(cur.s > 1.05 ? 1 : 2.5, e.clientX, e.clientY, cur) }
    // мышь: перетаскивание увеличенной картинки
    let drag = null
    const mdown = e => { if (vRef.current.s > 1) { drag = { x: e.clientX, y: e.clientY, v: vRef.current }; e.preventDefault() } }
    const mmove = e => { if (drag) setV({ ...drag.v, x: drag.v.x + e.clientX - drag.x, y: drag.v.y + e.clientY - drag.y }) }
    const mup = () => { drag = null }
    el.addEventListener('touchstart', start, { passive: true })
    el.addEventListener('touchmove', move, { passive: false })
    el.addEventListener('touchend', end)
    el.addEventListener('touchcancel', end)
    el.addEventListener('wheel', wheel, { passive: false })
    el.addEventListener('dblclick', dbl)
    el.addEventListener('mousedown', mdown)
    window.addEventListener('mousemove', mmove)
    window.addEventListener('mouseup', mup)
    return () => {
      el.removeEventListener('touchstart', start); el.removeEventListener('touchmove', move); el.removeEventListener('touchend', end); el.removeEventListener('touchcancel', end)
      el.removeEventListener('wheel', wheel); el.removeEventListener('dblclick', dbl); el.removeEventListener('mousedown', mdown)
      window.removeEventListener('mousemove', mmove); window.removeEventListener('mouseup', mup)
    }
  }, [])
  const btn = { width: 40, height: 40, borderRadius: 20, border: 'none', background: 'rgba(255,255,255,.18)', color: '#fff', fontSize: 20, cursor: 'pointer', padding: 0 }
  const step = f => setV(cur => { const s = Math.max(1, Math.min(MAX, cur.s * f)); return s === 1 ? { s: 1, x: 0, y: 0 } : { s, x: cur.x * s / cur.s, y: cur.y * s / cur.s } })
  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 3000, background: 'rgba(0,0,0,.92)', touchAction: 'none' }}>
      <div ref={box} style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', cursor: v.s > 1 ? 'grab' : 'zoom-in' }}>
        <img src={src} alt={alt} draggable={false}
          style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', transform: `translate(${v.x}px, ${v.y}px) scale(${v.s})`, transformOrigin: 'center center', userSelect: 'none', pointerEvents: 'none' }} />
      </div>
      <div style={{ position: 'absolute', top: 'calc(10px + env(safe-area-inset-top))', right: 12, display: 'flex', gap: 8 }}>
        <button type="button" style={btn} onClick={() => step(1 / 1.5)} aria-label="Уменьшить">−</button>
        <button type="button" style={btn} onClick={() => step(1.5)} aria-label="Увеличить">+</button>
        <button type="button" style={{ ...btn, fontSize: 24 }} onClick={onClose} aria-label="Закрыть">×</button>
      </div>
      <div style={{ position: 'absolute', bottom: 'calc(12px + env(safe-area-inset-bottom))', left: 0, right: 0, textAlign: 'center', color: 'rgba(255,255,255,.7)', fontSize: 12, pointerEvents: 'none' }}>
        {v.s > 1.01 ? `×${v.s.toFixed(1)} · двойное нажатие — обратно` : 'Увеличить: два пальца или двойное нажатие'}
      </div>
    </div>,
    document.body,
  )
}
