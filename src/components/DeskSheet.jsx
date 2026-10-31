import { useRef, useState } from 'react'
import { useDesktop } from '../hooks/useDesktop'

// Окно-карточка: на телефоне — выезжает снизу (как было), на компьютере — посередине экрана, переносится за верхнюю
// полосу (за то место, за которое взяли) и растягивается за угол; место и размер запоминаются (storeKey).
// Координаты — от подложки: при закреплённом меню она начинается правее его (см. index.css, nav-pinned).
// Закрывается щелчком мимо окна (только если и нажали мимо — отпущенная снаружи мышь при переносе не закрывает).
const pinWidth = () => (document.body.classList.contains('nav-pinned') ? parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--nav-pin-w')) || 0 : 0)

export default function DeskSheet({ onClose, storeKey = 'deskSheet', width = 560, zIndex = 300, children }) {
  const desk = useDesktop()
  const ref = useRef(null)
  const downOut = useRef(null)
  const [win, setWin] = useState(() => {
    let s
    try { s = JSON.parse(localStorage.getItem(storeKey) || 'null') } catch { s = null }
    const vw = window.innerWidth - pinWidth(), vh = window.innerHeight
    const w = Math.min(s?.w || width, vw - 40)
    const x = s ? Math.min(Math.max(0, s.x), vw - 160) : Math.round((vw - w) / 2)
    const y = s ? Math.min(Math.max(0, s.y), vh - 60) : null      // впервые — по центру и по высоте (ниже: top 50%)
    return { x, y, w, h: s?.h ? Math.min(s.h, vh - 40) : null }
  })
  const save = () => {
    const el = ref.current
    if (!desk || !el) return
    const r = el.getBoundingClientRect(), pr = el.parentElement.getBoundingClientRect()
    // высоту запоминаем, только если окно растягивали (браузер ставит её в style при растягивании за угол)
    const next = { x: Math.round(r.left - pr.left), y: Math.round(r.top - pr.top), w: Math.round(r.width), h: el.style.height ? Math.round(r.height) : null }
    setWin(next)
    try { localStorage.setItem(storeKey, JSON.stringify(next)) } catch { /* без памяти */ }
  }
  const startMove = e => {
    if (e.button !== 0) return
    e.preventDefault()
    const el = ref.current, r = el.getBoundingClientRect(), pr = el.parentElement.getBoundingClientRect()
    const dx = e.clientX - r.left, dy = e.clientY - r.top
    el.style.transform = 'none'; el.style.top = (r.top - pr.top) + 'px'
    const move = ev => {
      el.style.left = Math.min(Math.max(0, ev.clientX - dx - pr.left), pr.width - 160) + 'px'
      el.style.top = Math.min(Math.max(0, ev.clientY - dy - pr.top), pr.height - 50) + 'px'
    }
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); save() }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }

  return (
    <div onPointerDown={e => { downOut.current = e.target === e.currentTarget }} onClick={e => { if (e.target === e.currentTarget && downOut.current === true) onClose() }}
      style={{ position: 'fixed', inset: 0, zIndex, background: desk ? 'rgba(0,0,0,.12)' : 'rgba(0,0,0,.35)', display: 'flex', alignItems: desk ? 'flex-start' : 'flex-end', justifyContent: desk ? 'flex-start' : 'center' }}>
      {desk ? (
        <div ref={ref} onMouseUp={save}
          style={{ position: 'absolute', left: win.x, ...(win.y == null ? { top: '50%', transform: 'translateY(-50%)' } : { top: win.y, transform: 'none' }), width: win.w, ...(win.h ? { height: win.h } : {}), minWidth: 340, minHeight: 160, maxWidth: '96vw', maxHeight: '92vh',
            resize: 'both', overflow: 'auto', background: 'var(--bg)', borderRadius: 14, boxShadow: '0 12px 40px rgba(0,0,0,.25)', display: 'flex', flexDirection: 'column' }}>
          <div onPointerDown={startMove} title="Потяните, чтобы перенести окно"
            style={{ position: 'sticky', top: 0, zIndex: 2, flex: '0 0 auto', height: 18, cursor: 'move', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', borderRadius: '14px 14px 0 0' }}>
            <div style={{ width: 44, height: 4, borderRadius: 2, background: 'var(--border-md)' }} />
          </div>
          <div style={{ padding: '2px 16px 18px', flex: 1 }}>{children}</div>
        </div>
      ) : (
        <div style={{ background: 'var(--bg)', width: '100%', maxWidth: width, maxHeight: '92vh', overflowY: 'auto', borderRadius: '16px 16px 0 0', padding: '14px 16px calc(18px + env(safe-area-inset-bottom))' }}>
          {children}
        </div>
      )}
    </div>
  )
}
