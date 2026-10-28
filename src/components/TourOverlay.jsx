import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { TOURS, tourState, setTour } from '../lib/tours'

// Интерактивный тур поверх настоящих экранов: затемнение с «окном» вокруг подсвеченного элемента и пузырь с пояснением.
// Затемнение не мешает нажатиям — подсвеченную кнопку можно нажать, тур продолжится на следующем экране.
// Состояние тура — в sessionStorage: переживает переходы и обновление страницы.

const PAD = 6
const EASE = 'cubic-bezier(.32,.72,0,1)'

export default function TourOverlay() {
  const { user, setCabinet } = useAuth()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [t, setT] = useState(tourState)
  const [box, setBox] = useState(null)                 // { key, x, y, w, h } — где подсвеченный элемент для шага key
  const [vh, setVh] = useState(() => window.innerHeight)
  const scrolled = useRef(null)                        // для какого шага уже прокрутили к элементу

  useEffect(() => {
    const on = () => setT(tourState())
    window.addEventListener('tour-change', on)
    return () => window.removeEventListener('tour-change', on)
  }, [])

  const tour = t && TOURS[t.id]
  const step = tour?.steps[t.i]
  const onPath = !!step && (!step.path || step.path.test(pathname))
  const stepKey = t ? `${t.id}:${t.i}` : ''

  // открылся экран, который ждёт шаг (нажали подсвеченную кнопку) — дальше
  useEffect(() => {
    if (!step?.until || !step.until.test(pathname) || (step.path && step.path.test(pathname))) return
    setTour({ ...t, i: Math.min(t.i + 1, tour.steps.length - 1) })
  }, [pathname, stepKey])   // eslint-disable-line react-hooks/exhaustive-deps

  // следим за положением подсвеченного элемента: прокрутка, раскрытие блоков, клавиатура
  useEffect(() => {
    if (!step?.el || !onPath) return
    let alive = true
    const measure = () => {
      if (!alive) return
      const el = document.querySelector(`[data-tour="${step.el}"]`)
      const r = el?.getBoundingClientRect()
      const ok = r && (r.width > 0 || r.height > 0)
      if (ok && scrolled.current !== stepKey) {
        scrolled.current = stepKey
        el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }
      setVh(window.visualViewport?.height || window.innerHeight)
      setBox(prev => {
        if (!ok) return null
        const n = { key: stepKey, x: r.left, y: r.top, w: r.width, h: r.height }
        return prev && prev.key === n.key && Math.abs(prev.x - n.x) < 0.5 && Math.abs(prev.y - n.y) < 0.5 && Math.abs(prev.w - n.w) < 0.5 && Math.abs(prev.h - n.h) < 0.5 ? prev : n
      })
    }
    Promise.resolve().then(measure)
    const id = setInterval(measure, 150)
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    return () => { alive = false; clearInterval(id); window.removeEventListener('scroll', measure, true); window.removeEventListener('resize', measure) }
  }, [stepKey, onPath, step?.el])

  if (!user || !step) return null
  const rect = onPath && step.el && box?.key === stepKey ? box : null

  const n = tour.steps.length
  const close = () => setTour(null)
  const move = d => { const i = t.i + d; if (i < 0) return; if (i >= n) close(); else setTour({ ...t, i }) }
  const go = () => {
    const g = step.go
    if (g.cabinet) setCabinet(g.cabinet)
    if (g.tab) { try { sessionStorage.setItem('keep:/production#prodTab', JSON.stringify(g.tab)) } catch { /* без памяти */ } }
    navigate(g.to, g.tab ? { state: { tab: g.tab } } : undefined)
    if (!step.path) move(1)                            // вводный шаг: перешли — сразу к первому настоящему
  }

  // что показать в пузыре
  let body = step.text, center = false
  if (!onPath) { body = step.wait || 'Перейдите на нужный экран.'; center = true }
  else if (step.el && !rect) { body = step.missing || step.text; center = true }
  const showGo = step.go && (!step.path || !onPath)

  // пузырь — под элементом, если внизу хватает места, иначе над ним
  const W = Math.min(420, window.innerWidth - 24)
  const left = Math.round((window.innerWidth - W) / 2)
  let pos = { bottom: 'calc(16px + env(safe-area-inset-bottom))' }
  if (rect && !center) {
    const below = vh - (rect.y + rect.h + PAD)
    pos = below > 210 || below > rect.y ? { top: Math.min(vh - 120, rect.y + rect.h + PAD + 10) } : { bottom: Math.max(12, window.innerHeight - rect.y + PAD + 10) }
  }
  const btn = main => ({ padding: '7px 14px', borderRadius: 18, fontSize: 13, border: main ? 'none' : '0.5px solid var(--border-md)', background: main ? 'var(--blue)' : 'transparent', color: main ? '#fff' : 'var(--text-muted)', cursor: 'pointer', whiteSpace: 'nowrap' })

  return createPortal(
    <div data-full="" style={{ position: 'fixed', inset: 0, zIndex: 1200, pointerEvents: 'none' }}>
      {rect && !center && (
        <div style={{ position: 'fixed', left: rect.x - PAD, top: rect.y - PAD, width: rect.w + PAD * 2, height: rect.h + PAD * 2, borderRadius: 12,
          boxShadow: '0 0 0 2px var(--blue), 0 0 0 9999px rgba(0,0,0,.45)', transition: `all .3s ${EASE}` }} />
      )}
      <div role="dialog" aria-label={step.title}
        style={{ position: 'fixed', left, width: W, ...pos, pointerEvents: 'auto', background: 'var(--bg)', borderRadius: 16, padding: '12px 14px 12px',
          boxShadow: '0 10px 32px rgba(0,0,0,.28)', border: '0.5px solid var(--border)', transition: `top .3s ${EASE}, bottom .3s ${EASE}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 11, color: 'var(--blue)', fontWeight: 600 }}>Обучение · {t.i + 1} из {n}</span>
          <span style={{ flex: 1, height: 3, borderRadius: 2, background: 'var(--bg2)', overflow: 'hidden' }}>
            <span style={{ display: 'block', height: '100%', width: `${((t.i + 1) / n) * 100}%`, background: 'var(--blue)', transition: `width .3s ${EASE}` }} />
          </span>
          <button type="button" aria-label="Закрыть обучение" onClick={close} style={{ width: 28, height: 28, borderRadius: 14, border: 'none', background: 'var(--bg2)', color: 'var(--text-muted)', fontSize: 16, padding: 0, cursor: 'pointer' }}>×</button>
        </div>
        <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 3 }}>{step.title}</div>
        <div style={{ fontSize: 13.5, lineHeight: 1.45, color: 'var(--text-muted)' }}>{body}</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
          {t.i > 0 && <button type="button" onClick={() => move(-1)} style={btn(false)}>Назад</button>}
          <span style={{ flex: 1 }} />
          {showGo && <button type="button" onClick={go} style={btn(!step.path)}>{step.goLabel || 'Перейти'}</button>}
          {(step.path || !step.go) && <button type="button" onClick={() => move(1)} style={btn(true)}>{t.i === n - 1 ? 'Готово' : 'Далее'}</button>}
        </div>
      </div>
    </div>,
    document.body,
  )
}
