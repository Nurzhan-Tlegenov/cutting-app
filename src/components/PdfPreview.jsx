import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useBackClose } from '../lib/backStack'

// ─── Предварительный просмотр PDF ───────────────────────────────────────────
// Те же страницы, что попадут в файл (карты листов, статистика, смета), — до сохранения макета и без скачивания.
// make() → Promise<[адреса картинок страниц]>. Масштаб: −/+, «По ширине», Ctrl + колёсико мыши, щипок двумя пальцами.
// start: 'last' — открыть сразу на последней странице (страница статистики).
const ZMIN = 0.4, ZMAX = 4

export default function PdfPreview({ make, title = 'Предварительный просмотр', start = 'first', onClose }) {
  useBackClose(true, onClose)
  const [pages, setPages] = useState(null)
  const [err, setErr] = useState('')
  const [prog, setProg] = useState('')
  const [zoom, setZoom] = useState(1)        // 1 — страница целиком по высоте окна
  const [box, setBox] = useState({ w: 800, h: 600 })
  const boxRef = useRef(null), zoomRef = useRef(1)
  zoomRef.current = zoom

  useEffect(() => {
    let alive = true, got = []
    make(setProg).then(u => { got = u; if (alive) setPages(u); else u.forEach(x => URL.revokeObjectURL(x)) })
      .catch(e => { if (alive) setErr(String(e?.message || e)) })
    return () => { alive = false; got.forEach(x => URL.revokeObjectURL(x)) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const upd = () => setBox({ w: el.clientWidth, h: el.clientHeight })
    upd()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(upd) : null
    ro?.observe(el)
    return () => ro?.disconnect()
  }, [])

  // страница целиком (по высоте и ширине окна) — при zoom 1
  const fitW = Math.max(200, Math.min(box.w - 24, (box.h - 24) * 210 / 297))
  const pageW = Math.round(fitW * zoom)
  const widthZoom = (box.w - 24) / fitW

  // масштаб с сохранением точки под курсором / пальцами
  const zoomAt = (nz, cx, cy) => {
    const el = boxRef.current
    const z = Math.max(ZMIN, Math.min(ZMAX, nz)), k = z / zoomRef.current
    if (!el || Math.abs(k - 1) < 1e-3) return
    const sx = el.scrollLeft + cx, sy = el.scrollTop + cy
    setZoom(z)
    requestAnimationFrame(() => { el.scrollLeft = sx * k - cx; el.scrollTop = sy * k - cy })
  }
  const zoomAtRef = useRef(zoomAt); zoomAtRef.current = zoomAt

  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const onWheel = e => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const r = el.getBoundingClientRect()
      zoomAtRef.current(zoomRef.current * Math.exp(-e.deltaY * 0.002), e.clientX - r.left, e.clientY - r.top)
    }
    const st = { d: 0, z: 1 }
    const dist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)
    const ts = e => { if (e.touches.length === 2) { st.d = dist(e.touches); st.z = zoomRef.current } }
    const tm = e => {
      if (e.touches.length !== 2 || !st.d) return
      e.preventDefault()
      const r = el.getBoundingClientRect()
      zoomAtRef.current(st.z * dist(e.touches) / st.d, (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left, (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top)
    }
    const te = e => { if (e.touches.length < 2) st.d = 0 }
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('touchstart', ts, { passive: true })
    el.addEventListener('touchmove', tm, { passive: false })
    el.addEventListener('touchend', te, { passive: true })
    return () => { el.removeEventListener('wheel', onWheel); el.removeEventListener('touchstart', ts); el.removeEventListener('touchmove', tm); el.removeEventListener('touchend', te) }
  }, [])

  // открыть на последней странице (статистика)
  const lastRef = useRef(null)
  useEffect(() => { if (pages && start === 'last') setTimeout(() => lastRef.current?.scrollIntoView({ block: 'start' }), 50) }, [pages, start])

  const btn = { padding: '6px 11px', borderRadius: 20, fontSize: 13, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }
  const mid = () => ({ x: box.w / 2, y: box.h / 2 })
  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 2000, background: '#5f5f5c', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', background: 'var(--bg)', borderBottom: '0.5px solid var(--border)', flexWrap: 'wrap' }}>
        <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--blue)', fontSize: 22, padding: 0, lineHeight: 1 }}>←</button>
        <div style={{ flex: 1, minWidth: 140 }}>
          <div style={{ fontSize: 15, fontWeight: 500 }}>{title}</div>
          <div style={{ fontSize: 11, color: 'var(--text-hint)' }}>{pages ? `Страниц: ${pages.length} · так будет выглядеть PDF` : err ? 'Ошибка' : `Готовим страницы… ${prog}`}</div>
        </div>
        <button type="button" style={btn} onClick={() => zoomAt(zoom / 1.25, mid().x, mid().y)} disabled={zoom <= ZMIN}>−</button>
        <span style={{ fontSize: 12, color: 'var(--text-muted)', minWidth: 42, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
        <button type="button" style={btn} onClick={() => zoomAt(zoom * 1.25, mid().x, mid().y)} disabled={zoom >= ZMAX}>+</button>
        <button type="button" style={btn} onClick={() => setZoom(1)}>Страница целиком</button>
        <button type="button" style={btn} onClick={() => setZoom(Math.min(ZMAX, widthZoom))}>По ширине</button>
        <button type="button" onClick={onClose} style={{ padding: '7px 16px', borderRadius: 'var(--radius)', border: 'none', background: 'var(--blue)', color: 'white', fontSize: 13 }}>Закрыть</button>
      </div>
      <div ref={boxRef} style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 12, touchAction: 'pan-x pan-y' }}>
        {err && <p style={{ color: '#fff', textAlign: 'center', marginTop: 40 }}>Не удалось подготовить просмотр: {err}</p>}
        {!pages && !err && <p style={{ color: '#fff', textAlign: 'center', marginTop: 40 }}>Готовим страницы… {prog}</p>}
        {pages && (
          <div style={{ width: Math.max(pageW, 0), margin: '0 auto' }}>
            {pages.map((u, i) => (
              <div key={u} ref={i === pages.length - 1 ? lastRef : null} style={{ marginBottom: 14 }}>
                <img src={u} alt={`Страница ${i + 1}`} draggable={false}
                  style={{ display: 'block', width: pageW, height: Math.round(pageW * 297 / 210), background: '#fff', boxShadow: '0 2px 12px rgba(0,0,0,.35)' }} />
                <div style={{ textAlign: 'center', fontSize: 11, color: '#e8e8e4', marginTop: 4 }}>{i + 1} / {pages.length}</div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div style={{ padding: '4px 14px 6px', fontSize: 11, color: '#e8e8e4', textAlign: 'center', background: '#4f4f4c' }}>
        Масштаб: −/+, Ctrl + колёсико мыши или щипок двумя пальцами
      </div>
    </div>, document.body)
}
