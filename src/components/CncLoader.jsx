import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

// Экран ожидания вместо «Загрузка…»: живой раскрой на четырёх листах. Детали перекладываются —
// от рыхлой раскладки к плотной, как в онлайн-раскрое приложения; затем берётся новый набор деталей.
// Нажатие по листу — новый набор. Движение — только сдвигом и поворотом (без перестройки страницы), поэтому плавное.
const W = 120, H = 160, PAD = 2, GAP = 1.5
const HINTS = [
  'Детали перекладываются, пока не лягут плотнее',
  'Плотнее раскладка — больше деловой обрезок',
  'Мелкие детали — в середину листа',
  'Нажмите на лист — возьмём другие детали',
]
const rnd = seed => { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 } }

function makeParts(r, share) {
  const out = []
  let area = 0
  const target = (W - PAD * 2) * (H - PAD * 2) * share
  while (area < target && out.length < 22) {
    const big = r() < 0.38, w = Math.round(big ? 34 + r() * 30 : 12 + r() * 22), h = Math.round(big ? 26 + r() * 26 : 10 + r() * 18)
    out.push({ w, h }); area += w * h
  }
  return out
}
// Укладка «по горизонту»: каждая деталь встаёт туда, где окажется выше всего (ближе к началу листа), в лучшем из двух
// поворотов. -> { pos: [{ x, y, w, h, rot }], used } | null (не поместилось)
function pack(parts, order, turn) {
  const n = Math.floor(W - PAD * 2), sky = new Float32Array(n).fill(PAD), pos = new Array(parts.length)
  let used = PAD
  for (const i of order) {
    let best = null
    for (const rot of turn ? [false, true] : [false]) {
      const w = rot ? parts[i].h : parts[i].w, h = rot ? parts[i].w : parts[i].h, span = Math.ceil(w + GAP)
      if (w > n) continue
      for (let x = 0; x + Math.ceil(w) <= n; x++) {
        let y = 0
        for (let k = x; k < Math.min(n, x + span); k++) if (sky[k] > y) y = sky[k]
        if (y + h > H - PAD) continue
        if (!best || y + h < best.y + best.h - 0.01 || (Math.abs(y + h - best.y - best.h) < 0.01 && x < best.x)) best = { x, y, w, h, rot }
      }
    }
    if (!best) return null
    for (let k = best.x; k < Math.min(n, best.x + Math.ceil(best.w + GAP)); k++) sky[k] = best.y + best.h + GAP
    pos[i] = { ...best, x: best.x + PAD }
    used = Math.max(used, best.y + best.h)
  }
  return { pos, used }
}
// три раскладки одного набора: рыхлая -> плотнее -> плотная
function makeStages(seed) {
  const r = rnd(seed)
  for (const share of [0.74, 0.68, 0.6, 0.5]) {
    const parts = makeParts(r, share), idx = parts.map((_, i) => i), found = []
    for (let k = 0; k < 10; k++) { const p = pack(parts, idx.slice().sort(() => r() - 0.5), k % 2 === 1); if (p) found.push(p) }
    const best = pack(parts, idx.slice().sort((a, b) => Math.max(parts[b].w, parts[b].h) - Math.max(parts[a].w, parts[a].h) || parts[b].w * parts[b].h - parts[a].w * parts[a].h), true)
    if (!best || !found.length) continue
    found.sort((a, b) => b.used - a.used)
    const stages = [found[0], found[found.length - 1], best].filter((s, i, a) => !i || s.used < a[i - 1].used - 0.5 || i === a.length - 1)
    const area = parts.reduce((a, p) => a + p.w * p.h, 0)
    return { parts, stages: stages.map(s => ({ ...s, fill: Math.min(99, Math.round(area / ((W - PAD * 2) * (s.used - PAD)) * 100)) })) }
  }
  return null
}

function Sheet({ start, delay, u, small }) {
  const [seed, setSeed] = useState(start)
  const [step, setStep] = useState(0)
  const data = useMemo(() => makeStages(seed), [seed])
  useEffect(() => {
    if (!data) return
    const last = step >= data.stages.length - 1
    const t = setTimeout(() => { if (last) { setStep(0); setSeed(x => (x * 31 + 7) >>> 0) } else setStep(s => s + 1) }, (step === 0 ? 500 : last ? 1500 : 900) + (step === 0 ? delay : 0))
    return () => clearTimeout(t)
  }, [step, data, delay])
  if (!data) return null
  const st = data.stages[Math.min(step, data.stages.length - 1)]
  return (
    <div onClick={() => { setStep(0); setSeed(x => (x * 17 + 3) >>> 0) }}
      style={{ position: 'relative', width: W * u, height: H * u, background: '#fff', border: '1px solid var(--gray-mid)', borderRadius: 3, cursor: 'pointer', overflow: 'hidden', WebkitTapHighlightColor: 'transparent', contain: 'strict' }}>
      {/* деловой обрезок — свободная часть листа под раскладкой */}
      <div style={{ position: 'absolute', left: PAD * u, right: PAD * u, top: 0, height: (H - PAD) * u, transformOrigin: '0 100%', transform: `scaleY(${Math.max(0, (H - PAD - st.used - GAP) / (H - PAD))})`,
        background: 'rgba(29,158,117,0.13)', transition: 'transform 0.7s cubic-bezier(.4,0,.2,1)', willChange: 'transform' }} />
      {data.parts.map((p, i) => {
        const q = st.pos[i]
        // деталь не меняет размер: поворот — вокруг своего центра, место — сдвигом
        const cx = (q.x + q.w / 2 - p.w / 2) * u, cy = (q.y + q.h / 2 - p.h / 2) * u
        return <div key={seed + '_' + i} style={{ position: 'absolute', left: 0, top: 0, width: p.w * u, height: p.h * u, boxSizing: 'border-box', background: '#E6E6E6', border: '1px solid rgba(20,20,20,0.8)',
          transform: `translate3d(${cx}px, ${cy}px, 0) rotate(${q.rot ? 90 : 0}deg)`, transition: `transform 0.7s cubic-bezier(.4,0,.2,1) ${i * 14}ms`, willChange: 'transform' }} />
      })}
      {!small && <div style={{ position: 'absolute', right: 4, bottom: 3, fontSize: 10, fontWeight: 500, color: 'var(--teal)', background: 'rgba(255,255,255,0.88)', borderRadius: 8, padding: '0 6px' }}>{st.fill}%</div>}
    </div>
  )
}

function Sheets({ label, compact }) {
  const ref = useRef(null)
  const [u, setU] = useState(0)                      // точек экрана на единицу листа
  const [base] = useState(() => Math.floor(Math.random() * 1e9))
  const n = compact ? 1 : 4, gap = 8
  useLayoutEffect(() => {
    const fit = () => {
      const el = ref.current
      if (!el) return
      if (compact) { setU(110 / W); return }
      // четыре листа 2 × 2 — на большую часть экрана телефона
      const maxW = Math.min(el.parentElement?.clientWidth || window.innerWidth, 560) - 8, maxH = window.innerHeight * 0.66
      setU(Math.max(0.5, Math.min((maxW - gap) / 2 / W, (maxH - gap) / 2 / H)))
    }
    fit(); window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [compact])
  return (
    <div ref={ref} role="img" aria-label={label} style={{ display: 'grid', gridTemplateColumns: `repeat(${compact ? 1 : 2}, max-content)`, gap, justifyContent: 'center', minHeight: u ? undefined : 120 }}>
      {u > 0 && Array.from({ length: n }, (_, i) => <Sheet key={i} start={(base + i * 977) >>> 0} delay={i * 230} u={u} small={compact} />)}
    </div>
  )
}

export default function CncLoader({ label = 'Загрузка…', full = false, compact = false, style }) {
  const [hint, setHint] = useState(0)
  useEffect(() => { const t = setInterval(() => setHint(h => (h + 1) % HINTS.length), 4000); return () => clearInterval(t) }, [])
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: compact ? 12 : '12px 0', width: '100%',
      ...(full ? { minHeight: '100vh' } : { minHeight: compact ? 0 : '55vh' }), ...style }}>
      <Sheets label={label} compact={compact} />
      <div style={{ fontSize: compact ? 12 : 16, color: 'var(--text-muted)', fontWeight: 500 }}>{label}</div>
      {!compact && <div style={{ fontSize: 12.5, color: 'var(--text-hint)', minHeight: 16, textAlign: 'center' }}>{HINTS[hint]}</div>}
    </div>
  )
}
