import { useEffect, useMemo, useRef, useState } from 'react'

// Экран ожидания вместо «Загрузка…»: живой раскрой по форме (нестинг). 36 карт, уже уложенных деталями
// мебельных контуров; пока идёт загрузка, детали перелетают с карты на карту.
// Ничего не считается: только сдвиг (transform), поэтому плавно и на слабом телефоне. Нажатие — другая раскладка.
const PW = 132, PH = 200, PAD = 4, GAP = 3            // карта (в условных единицах), поле и зазор между деталями
const KINDS = 3                                       // сколько разных раскладок карт
const HINTS = [
  'Детали перекладываются с карты на карту',
  'Раскрой по форме: детали любого контура',
  'Нажмите — возьмём другую раскладку',
]
const rnd = seed => { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 } }

// Контуры деталей в квадрате 100 × 100 (растягиваются под своё место): круглые, скруглённые, с вырезами и скосами
const SHAPES = [
  'M50 0A50 50 0 1 1 49.9 0Z',                                                  // круг / овал
  'M0 100V50A50 50 0 0 1 100 50V100Z',                                          // арка
  'M0 100V0A100 100 0 0 1 100 100Z',                                            // четверть круга
  'M0 0H100V100H0Z',                                                            // прямоугольник
  'M18 0H82Q100 0 100 18V82Q100 100 82 100H18Q0 100 0 82V18Q0 0 18 0Z',          // скруглённые углы
  'M0 0H100V45H45V100H0Z',                                                      // уголок (Г-образная)
  'M0 0H100V100H70V40H30V100H0Z',                                               // П-образная
  'M0 0H100V70L70 100H0Z',                                                      // со срезанным углом
  'M0 0H100V100H0ZM30 30V70H70V30Z',                                            // с прямоугольным вырезом
  'M0 0H100V100H0ZM50 22A28 28 0 1 0 50.1 22Z',                                 // с круглым вырезом
  'M0 0H60Q100 0 100 40V100H0Z',                                                // один скруглённый угол
  'M0 20Q50 -20 100 20V100H0Z',                                                 // дуга по стороне
  'M20 0H80L100 100H0Z',                                                        // трапеция
  'M0 0H100V100H62A12 16 0 0 0 38 100H0Z',                                      // с полукруглым вырезом на стороне
  'M0 50A50 50 0 0 1 100 50V100H0Z',                                            // полукруг с основанием
  'M0 0H100V100H55V60H0Z',                                                      // ступенька
]

// раскладка карты: прямоугольные места без пустот (лист делится пополам, половины — ещё раз и т.д.)
function makeSlots(seed) {
  const r = rnd(seed), out = []
  const split = (x, y, w, h, depth) => {
    if (depth < 3 && (w > 58 || h > 66) && (depth < 2 || r() < 0.65)) {
      const k = 0.36 + r() * 0.28
      if (w / h > 1.1 || (w / h > 0.75 && r() < 0.5)) { split(x, y, w * k, h, depth + 1); split(x + w * k, y, w * (1 - k), h, depth + 1) }
      else { split(x, y, w, h * k, depth + 1); split(x, y + h * k, w, h * (1 - k), depth + 1) }
      return
    }
    out.push({ x: x + GAP / 2, y: y + GAP / 2, w: w - GAP, h: h - GAP, shape: Math.floor(r() * SHAPES.length), turn: Math.floor(r() * 4) })
  }
  split(PAD, PAD, PW - PAD * 2, PH - PAD * 2, 0)
  return out
}

function LiveSheets({ label, compact }) {
  const boxRef = useRef(null)
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 1e9))   // eslint-disable-line react-hooks/purity
  const [width, setWidth] = useState(0)
  const cols = compact ? 3 : 6, rows = compact ? 2 : 6, N = cols * rows, SG = 10
  // несколько разных раскладок; карта s — раскладки kind(s), у соседей она ещё и отражена
  const layouts = useMemo(() => Array.from({ length: KINDS }, (_, L) => makeSlots((seed + L * 104729) >>> 0)), [seed])
  const kind = s => ((s % cols) + Math.floor(s / cols) * 2) % KINDS
  const sheetsOf = useMemo(() => Array.from({ length: KINDS }, (_, L) => Array.from({ length: N }, (_, s) => s).filter(s => kind(s) === L)), [N, cols])   // eslint-disable-line react-hooks/exhaustive-deps
  const place = (L, i, sheet) => {
    const s = layouts[L][i], fx = (sheet % cols) % 2 === 1, fy = Math.floor(sheet / cols) % 2 === 1
    return { x: (sheet % cols) * (PW + SG) + (fx ? PW - s.x - s.w : s.x), y: Math.floor(sheet / cols) * (PH + SG) + (fy ? PH - s.y - s.h : s.y), w: s.w, h: s.h }
  }
  // где лежит каждая деталь: at[L][i][k] — номер карты k-й детали места i раскладки L
  const fresh = () => layouts.map((slots, L) => slots.map(() => sheetsOf[L].slice()))
  const [at, setAt] = useState(fresh)
  const [moving, setMoving] = useState(() => new Set())
  useEffect(() => { setAt(fresh()); setMoving(new Set()) }, [layouts, sheetsOf])   // eslint-disable-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect
  useEffect(() => {
    const fit = () => setWidth(boxRef.current?.clientWidth || 0)
    fit(); window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])
  // загрузка затянулась — детали одного размера меняются местами между картами
  useEffect(() => {
    let n = 0, clear = 0
    const run = () => {
      const r = rnd((seed + ++n * 2654435761) >>> 0), mv = new Set()
      setAt(prev => {
        const next = prev.map(slots => slots.map(row => row.slice()))
        for (let q = 0; q < (compact ? 2 : 5); q++) {
          const L = Math.floor(r() * KINDS), i = Math.floor(r() * next[L].length), row = next[L][i]
          const a = Math.floor(r() * row.length), b = Math.floor(r() * row.length)
          if (a === b || mv.has(`${L}:${i}:${a}`) || mv.has(`${L}:${i}:${b}`)) continue
          const t = row[a]; row[a] = row[b]; row[b] = t
          mv.add(`${L}:${i}:${a}`); mv.add(`${L}:${i}:${b}`)
        }
        return next
      })
      setMoving(mv)
      clearTimeout(clear); clear = setTimeout(() => setMoving(new Set()), 1000)
    }
    const first = setTimeout(run, 350), t = setInterval(run, 1250)
    return () => { clearTimeout(first); clearInterval(t); clearTimeout(clear) }
  }, [seed, compact])
  const TW = cols * PW + (cols - 1) * SG, TH = rows * PH + (rows - 1) * SG, k = width / TW
  return (
    <div ref={boxRef} onClick={() => setSeed(x => (x * 17 + 3) >>> 0)} role="img" aria-label={label}
      style={{ position: 'relative', width: compact ? 170 : 'min(90vw, 420px, 54vh)', aspectRatio: `${TW} / ${TH}`, cursor: 'pointer', WebkitTapHighlightColor: 'transparent' }}>
      {Array.from({ length: N }, (_, s) => (
        <div key={s} style={{ position: 'absolute', left: (s % cols) * (PW + SG) * k, top: Math.floor(s / cols) * (PH + SG) * k, width: PW * k, height: PH * k,
          background: '#fff', border: '1px solid var(--gray-mid)', borderRadius: 3, boxSizing: 'border-box' }} />
      ))}
      {width > 0 && at.map((slots, L) => slots.map((row, i) => row.map((sheet, part) => {
        const key = `${L}:${i}:${part}`, p = place(L, i, sheet), fly = moving.has(key), s = layouts[L][i]
        const tf = `translate3d(${p.x * k}px, ${p.y * k}px, 0) scale(${fly ? 1.5 : 1})`
        return (
          <svg key={seed + key} viewBox="-2 -2 104 104" preserveAspectRatio="none" width={p.w * k} height={p.h * k}
            style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', transform: tf, zIndex: fly ? 3 : 1, willChange: 'transform',
              transition: 'transform 0.95s cubic-bezier(0.3, 0.1, 0.2, 1)' }}>
            <path d={SHAPES[s.shape]} fillRule="evenodd" transform={`rotate(${s.turn * 90} 50 50)`} vectorEffect="non-scaling-stroke"
              style={{ fill: fly ? '#9CC4EE' : '#E6E6E6', stroke: 'rgba(20,20,20,0.8)', strokeWidth: 1, transition: 'fill 0.3s' }} />
          </svg>
        )
      })))}
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
