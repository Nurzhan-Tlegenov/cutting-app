import { useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react'
import { SHEET, makeLayout, pathOf, pointAt } from '../lib/loaderLayout'

// 3D-сцена (станок режет лист, камера идёт за шпинделем) подгружается отдельно; пока её нет или нет WebGL — плоская картинка
const Scene3D = lazy(() => import('./CncLoader3D').catch(() => ({ default: ({ fallback }) => fallback })))

// Экран ожидания вместо «Загрузка…»: маленький станок с ЧПУ режет лист.
// Раскладка каждый раз новая; фреза идёт от края листа к центру — как в настоящей программе.
// Нажатие по листу — новый лист.
const { W, H } = SHEET
const HINTS = [
  'Фреза начинает с детали у края листа',
  'Центральная деталь режется последней',
  'Мелкие детали — в середину листа',
  'Заход в материал — под наклоном',
  'Нажмите на лист — возьмём новый',
  'Камера идёт за шпинделем',
]

function Flat({ label, compact }) {
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 1e9))   // eslint-disable-line react-hooks/purity
  const parts = useMemo(() => makeLayout(seed), [seed])
  const pathRefs = useRef([]), fillRefs = useRef([]), toolRef = useRef(null), trailRef = useRef(null)

  useEffect(() => {
    const SPEED = 210, RAPID = 520                  // «мм»/с по контуру и на холостом ходу
    const steps = []
    let t = 0, from = [W / 2, -8]
    parts.forEach((r, i) => {
      const travel = Math.hypot(r.pts[0][0] - from[0], r.pts[0][1] - from[1]) / RAPID
      steps.push({ i, t0: t, t1: t + travel, t2: t + travel + r.per / SPEED, from })
      t += travel + r.per / SPEED
      from = r.pts[0]
    })
    const total = t + 0.9
    let raf = 0, start = 0
    const frame = now => {
      if (!start) start = now
      const el = (now - start) / 1000
      if (el > total) { setSeed(x => (x * 31 + 7) >>> 0); return }
      let pos = from
      for (const st of steps) {
        const r = parts[st.i], p = pathRefs.current[st.i], f = fillRefs.current[st.i]
        const done = el >= st.t2
        const cut = el <= st.t1 ? 0 : done ? r.per : (el - st.t1) * SPEED
        if (p) p.style.strokeDashoffset = String(r.per - cut)
        if (f) f.style.opacity = done ? (el > t ? String(Math.max(0, 1 - (el - t) / 0.7)) : '1') : '0'
        if (el >= st.t0 && el < st.t1) { const k = (el - st.t0) / Math.max(1e-6, st.t1 - st.t0); pos = [st.from[0] + (r.pts[0][0] - st.from[0]) * k, st.from[1] + (r.pts[0][1] - st.from[1]) * k] }
        else if (el >= st.t1 && el < st.t2) pos = pointAt(r, cut)
      }
      if (toolRef.current) toolRef.current.setAttribute('transform', `translate(${pos[0].toFixed(2)} ${pos[1].toFixed(2)})`)
      if (trailRef.current) trailRef.current.setAttribute('transform', `rotate(${(el * 720) % 360})`)
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [parts])

  const size = compact ? 150 : 230
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={size} height={size * H / W} onClick={() => setSeed(x => (x * 17 + 3) >>> 0)}
        style={{ cursor: 'pointer', overflow: 'visible', WebkitTapHighlightColor: 'transparent' }} role="img" aria-label={label}>
        <rect x="1" y="1" width={W - 2} height={H - 2} rx="3" fill="#FBF8F1" stroke="var(--gray-mid)" strokeWidth="1" />
        {parts.map((r, i) => (
          <g key={seed + '_' + i}>
            <rect ref={el => { fillRefs.current[i] = el }} x={r.x} y={r.y} width={r.w} height={r.h} fill="var(--blue-light)" style={{ opacity: 0, transition: 'opacity 0.25s' }} />
            <path d={pathOf(r)} fill="none" stroke="var(--gray-mid)" strokeWidth="0.5" strokeDasharray="2 2" />
            <path ref={el => { pathRefs.current[i] = el }} d={pathOf(r)} fill="none" stroke="var(--blue)" strokeWidth="1.4" strokeLinejoin="round"
              strokeDasharray={r.per} style={{ strokeDashoffset: r.per }} />
          </g>
        ))}
        <g ref={toolRef} transform={`translate(${W / 2} -8)`}>
          <circle r="6.5" fill="rgba(24,95,165,0.12)" />
          <g ref={trailRef}>
            <path d="M0 -4.2 A4.2 4.2 0 0 1 4.2 0" fill="none" stroke="var(--amber)" strokeWidth="1.3" strokeLinecap="round" />
            <path d="M0 4.2 A4.2 4.2 0 0 1 -4.2 0" fill="none" stroke="var(--amber)" strokeWidth="1.3" strokeLinecap="round" />
          </g>
          <circle r="2" fill="var(--blue-dark)" />
        </g>
    </svg>
  )
}

export default function CncLoader({ label = 'Загрузка…', full = false, compact = false, style }) {
  const [hint, setHint] = useState(0)
  useEffect(() => { const t = setInterval(() => setHint(h => (h + 1) % HINTS.length), 4000); return () => clearInterval(t) }, [])
  const flat = <Flat label={label} compact={compact} />
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: compact ? 12 : 24,
      ...(full ? { minHeight: '100vh' } : { minHeight: compact ? 0 : '55vh' }), ...style }}>
      {compact ? flat : <Suspense fallback={flat}><Scene3D fallback={flat} /></Suspense>}
      <div style={{ fontSize: compact ? 12 : 14, color: 'var(--text-muted)', fontWeight: 500 }}>{label}</div>
      {!compact && <div style={{ fontSize: 11, color: 'var(--text-hint)', minHeight: 14, textAlign: 'center' }}>{HINTS[hint]}</div>}
    </div>
  )
}
