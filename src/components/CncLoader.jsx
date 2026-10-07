import { useEffect, useState } from 'react'

// Экран ожидания вместо «Загрузка…»: живой раскрой. Детали перекладываются на листе —
// от рыхлой раскладки к плотной, как в онлайн-раскрое приложения; затем берётся новый набор деталей.
// Нажатие по листу — новый набор.
const W = 200, H = 132, PAD = 3, GAP = 2
const HINTS = [
  'Детали перекладываются, пока не лягут плотнее',
  'Плотнее раскладка — больше деловой обрезок',
  'Мелкие детали — в середину листа',
  'Нажмите на лист — возьмём другие детали',
]
const rnd = seed => { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 } }

// набор деталей: суммарно около 62 % листа
function makeParts(seed) {
  const r = rnd(seed), out = []
  let area = 0
  const target = (W - PAD * 2) * (H - PAD * 2) * 0.62
  while (area < target && out.length < 14) {
    const big = r() < 0.4, w = Math.round(big ? 44 + r() * 34 : 18 + r() * 26), h = Math.round(big ? 30 + r() * 22 : 14 + r() * 20)
    out.push({ w, h }); area += w * h
  }
  return out
}
// раскладка рядами в заданном порядке; rot[i] — деталь повёрнута. -> { pos: [{x, y, w, h}], used } | null (не поместилось)
function pack(parts, order, rot) {
  const pos = new Array(parts.length)
  let x = PAD, y = PAD, row = 0
  for (const i of order) {
    const w = rot[i] ? parts[i].h : parts[i].w, h = rot[i] ? parts[i].w : parts[i].h
    if (x + w > W - PAD) { x = PAD; y += row + GAP; row = 0 }
    if (y + h > H - PAD || w > W - PAD * 2) return null
    pos[i] = { x, y, w, h }; x += w + GAP; row = Math.max(row, h)
  }
  return { pos, used: y + row }
}
// несколько раскладок одного набора: от рыхлой к плотной
function makeStages(seed) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const parts = makeParts(seed + attempt * 7919), r = rnd(seed ^ 0x9e3779b9), n = parts.length, found = []
    for (let k = 0; k < 60; k++) {
      const order = parts.map((_, i) => i).sort(() => r() - 0.5), rot = parts.map(p => r() < 0.35 && p.w !== p.h)
      const p = pack(parts, order, rot)
      if (p) found.push(p)
    }
    // плотная: высокие детали первыми, длинной стороной вдоль ряда
    const rot = parts.map(p => p.h > p.w), hh = i => (rot[i] ? parts[i].w : parts[i].h)
    const best = pack(parts, parts.map((_, i) => i).sort((a, b) => hh(b) - hh(a)), rot)
    if (best) found.push(best)
    if (found.length < 2) continue
    found.sort((a, b) => b.used - a.used)
    const stages = [found[0], found[Math.floor(found.length / 2)], found[found.length - 1]].filter((s, i, a) => !i || s !== a[i - 1])
    const area = parts.reduce((a, p) => a + p.w * p.h, 0)
    return { n, stages: stages.map(s => ({ ...s, fill: Math.round(area / ((W - PAD * 2) * (s.used - PAD)) * 100) })) }
  }
  return null
}

function Flat({ label, compact }) {
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 1e9))   // eslint-disable-line react-hooks/purity
  const [step, setStep] = useState(0)
  const [data, setData] = useState(() => makeStages(seed))
  useEffect(() => { setData(makeStages(seed)); setStep(0) }, [seed])       // eslint-disable-line react-hooks/set-state-in-effect
  useEffect(() => {
    if (!data) return
    const last = step >= data.stages.length - 1
    const t = setTimeout(() => { if (last) setSeed(x => (x * 31 + 7) >>> 0); else setStep(s => s + 1) }, step === 0 ? 450 : last ? 1300 : 800)
    return () => clearTimeout(t)
  }, [step, data])
  if (!data) return null
  const st = data.stages[Math.min(step, data.stages.length - 1)], pc = v => v + '%'
  return (
    <div onClick={() => setSeed(x => (x * 17 + 3) >>> 0)} role="img" aria-label={label}
      style={{ position: 'relative', width: compact ? 150 : 'min(92vw, 440px)', aspectRatio: `${W} / ${H}`, background: '#fff', border: '1px solid var(--gray-mid)', borderRadius: 4,
        cursor: 'pointer', overflow: 'hidden', WebkitTapHighlightColor: 'transparent' }}>
      {/* деловой обрезок — свободная часть листа под раскладкой */}
      <div style={{ position: 'absolute', left: pc(PAD / W * 100), right: pc(PAD / W * 100), bottom: pc(PAD / H * 100), top: pc((st.used + GAP) / H * 100),
        background: 'repeating-linear-gradient(135deg, rgba(29,158,117,0.16) 0 5px, rgba(29,158,117,0.05) 5px 10px)', borderTop: '1px dashed rgba(29,158,117,0.7)', transition: 'top 0.6s ease-in-out' }} />
      {st.pos.map((p, i) => (
        <div key={i} style={{ position: 'absolute', left: pc(p.x / W * 100), top: pc(p.y / H * 100), width: pc(p.w / W * 100), height: pc(p.h / H * 100), boxSizing: 'border-box',
          background: '#E6E6E6', border: '1px solid rgba(20,20,20,0.8)', transition: `left 0.6s ease-in-out ${i * 18}ms, top 0.6s ease-in-out ${i * 18}ms, width 0.6s ease-in-out, height 0.6s ease-in-out` }} />
      ))}
      {!compact && <div style={{ position: 'absolute', right: 6, bottom: 4, fontSize: 11, fontWeight: 500, color: 'var(--teal)', background: 'rgba(255,255,255,0.85)', borderRadius: 8, padding: '1px 7px' }}>заполнение {st.fill}%</div>}
    </div>
  )
}

export default function CncLoader({ label = 'Загрузка…', full = false, compact = false, style }) {
  const [hint, setHint] = useState(0)
  useEffect(() => { const t = setInterval(() => setHint(h => (h + 1) % HINTS.length), 4000); return () => clearInterval(t) }, [])
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, padding: compact ? 12 : '24px 0',
      ...(full ? { minHeight: '100vh' } : { minHeight: compact ? 0 : '55vh' }), ...style }}>
      <Flat label={label} compact={compact} />
      <div style={{ fontSize: compact ? 12 : 16, color: 'var(--text-muted)', fontWeight: 500 }}>{label}</div>
      {!compact && <div style={{ fontSize: 12.5, color: 'var(--text-hint)', minHeight: 16, textAlign: 'center' }}>{HINTS[hint]}</div>}
    </div>
  )
}
