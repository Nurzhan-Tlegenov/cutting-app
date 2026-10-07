import { useEffect, useMemo, useRef, useState } from 'react'

// Экран ожидания вместо «Загрузка…»: живые карты раскроя. Несколько листов, плотно уложенных деталями;
// детали всё время перелетают с листа на лист. Ничего не считается — только плавное движение
// (сдвиг через transform, без перерисовки), поэтому не тормозит и на слабом телефоне.
// Нажатие — другая раскладка. Цвета — как на картах раскроя: светло-оранжевые детали на светло-сером листе.
const PW = 132, PH = 200, PAD = 4, GAP = 2.4          // лист (в условных единицах), поле и зазор между деталями
const HINTS = [
  'Детали перекладываются с карты на карту',
  'Плотнее раскладка — больше деловой обрезок',
  'Нажмите — возьмём другую раскладку',
]
const rnd = seed => { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 } }

// раскладка листа: прямоугольники без пустот (лист делится пополам, половины — ещё раз и т.д.)
function makeSlots(seed) {
  const r = rnd(seed), out = []
  const split = (x, y, w, h, depth) => {
    if (depth < 3 && (w > 60 || h > 70) && (depth < 2 || r() < 0.6)) {
      const k = 0.36 + r() * 0.28
      if (w / h > 1.1 || (w / h > 0.75 && r() < 0.5)) { split(x, y, w * k, h, depth + 1); split(x + w * k, y, w * (1 - k), h, depth + 1) }
      else { split(x, y, w, h * k, depth + 1); split(x, y + h * k, w, h * (1 - k), depth + 1) }
      return
    }
    out.push({ x: x + GAP / 2, y: y + GAP / 2, w: w - GAP, h: h - GAP })
  }
  split(PAD, PAD, PW - PAD * 2, PH - PAD * 2, 0)
  return out
}

function LiveSheets({ label, compact }) {
  const boxRef = useRef(null)
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 1e9))   // eslint-disable-line react-hooks/purity
  const [width, setWidth] = useState(0)
  const cols = compact ? 3 : 6, rows = compact ? 2 : 6, N = cols * rows, SG = 10        // листов в ряд, рядов (36 карт), зазор между листами
  const slots = useMemo(() => makeSlots(seed), [seed])
  // у каждого листа раскладка та же, но отражённая — листы выглядят разными, а места одного номера одинаковые по размеру
  const place = (sheet, i) => {
    const s = slots[i], fx = (sheet % cols) % 2 === 1, fy = Math.floor(sheet / cols) % 2 === 1
    return { x: (sheet % cols) * (PW + SG) + (fx ? PW - s.x - s.w : s.x), y: Math.floor(sheet / cols) * (PH + SG) + (fy ? PH - s.y - s.h : s.y), w: s.w, h: s.h }
  }
  // где сейчас лежит каждая деталь: at[i][k] — номер листа для k-й детали места i
  const [at, setAt] = useState(() => slots.map(() => Array.from({ length: N }, (_, k) => k)))
  const [moving, setMoving] = useState(() => new Set())
  useEffect(() => { setAt(slots.map(() => Array.from({ length: N }, (_, k) => k))); setMoving(new Set()) }, [slots, N])   // eslint-disable-line react-hooks/set-state-in-effect
  useEffect(() => {
    const fit = () => setWidth(boxRef.current?.clientWidth || 0)
    fit(); window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])
  useEffect(() => {
    let n = 0
    const t = setInterval(() => {
      const r = rnd((seed + ++n * 2654435761) >>> 0)
      // несколько пар деталей одного размера меняются местами — перелетают с карты на карту
      const swaps = Array.from({ length: Math.max(3, Math.round(N / 3)) }, () => [Math.floor(r() * slots.length), Math.floor(r() * N), Math.floor(r() * N)])
      const mv = new Set()
      setAt(prev => {
        const next = prev.map(row => row.slice())
        for (const [i, a, b] of swaps) {
          if (a === b || mv.has(i + ':' + a) || mv.has(i + ':' + b)) continue
          const t = next[i][a]; next[i][a] = next[i][b]; next[i][b] = t
          mv.add(i + ':' + a); mv.add(i + ':' + b)
        }
        return next
      })
      setMoving(mv)
    }, 820)
    return () => clearInterval(t)
  }, [seed, slots.length, N])
  const TW = cols * PW + (cols - 1) * SG, TH = rows * PH + (rows - 1) * SG, k = width / TW
  return (
    <div ref={boxRef} onClick={() => setSeed(x => (x * 17 + 3) >>> 0)} role="img" aria-label={label}
      style={{ position: 'relative', width: compact ? 170 : 'min(90vw, 420px, 54vh)', aspectRatio: `${TW} / ${TH}`, cursor: 'pointer', WebkitTapHighlightColor: 'transparent' }}>
      {Array.from({ length: N }, (_, s) => (
        <div key={s} style={{ position: 'absolute', left: (s % cols) * (PW + SG) * k, top: Math.floor(s / cols) * (PH + SG) * k, width: PW * k, height: PH * k,
          background: '#F5F4F0', border: '1px solid var(--gray-mid)', borderRadius: 3, boxSizing: 'border-box' }} />
      ))}
      {width > 0 && at.map((row, i) => row.map((sheet, part) => {
        const p = place(sheet, i), fly = moving.has(i + ':' + part)
        return (
          <div key={i + ':' + part} style={{ position: 'absolute', left: 0, top: 0, width: p.w * k, height: p.h * k, boxSizing: 'border-box',
            transform: `translate3d(${p.x * k}px, ${p.y * k}px, 0)`, transition: 'transform 0.7s cubic-bezier(0.45, 0.05, 0.3, 1), background-color 0.3s',
            background: fly ? '#F2B694' : '#F9DCC8', border: '1px solid rgba(120,60,30,0.9)', zIndex: fly ? 2 : 1, willChange: 'transform' }} />
        )
      }))}
    </div>
  )
}

export default function CncLoader({ label = 'Загрузка…', full = false, compact = false, style }) {
  const [hint, setHint] = useState(0)
  useEffect(() => { const t = setInterval(() => setHint(h => (h + 1) % HINTS.length), 4000); return () => clearInterval(t) }, [])
  return (
    <div className="wait-screen" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, padding: compact ? 12 : '16px 0',
      ...(full ? { minHeight: '100vh' } : { minHeight: compact ? 0 : '70vh' }), ...style }}>
      <LiveSheets label={label} compact={compact} />
      <div style={{ fontSize: compact ? 12 : 16, color: 'var(--text-muted)', fontWeight: 500 }}>{label}</div>
      {!compact && <div style={{ fontSize: 12.5, color: 'var(--text-hint)', minHeight: 16, textAlign: 'center' }}>{HINTS[hint]}</div>}
    </div>
  )
}
