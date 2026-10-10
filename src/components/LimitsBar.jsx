import { useEffect, useState } from 'react'
import { myLimits, LIMIT_KEYS } from '../lib/limits'

// Сколько осталось по лимитам бесплатного использования — компактно, одной строкой (только где лимит есть).
// cabinet — 'client' | 'production'; refresh — любое значение, при смене которого лимиты перечитываются.
export default function LimitsBar({ cabinet, refresh, style }) {
  const [l, setL] = useState(null)
  useEffect(() => { let alive = true; myLimits(true).then(v => { if (alive) setL(v) }); return () => { alive = false } }, [refresh])
  if (!l || l.master || l.unlimited) return null
  const items = LIMIT_KEYS.filter(([k, , c]) => c === cabinet && l.limits?.[k]?.limit != null).map(([k, label]) => ({ k, label, ...l.limits[k] }))
  if (!items.length) return null
  const full = items.some(i => i.used >= i.limit)
  return (
    <div style={{ fontSize: 11.5, color: full ? 'var(--amber)' : 'var(--text-hint)', background: full ? 'var(--amber-light)' : 'transparent', border: full ? '0.5px solid var(--amber)' : 'none', borderRadius: 'var(--radius)', padding: full ? '5px 9px' : '0 2px', marginBottom: 8, ...style }}>
      Бесплатно: {items.map((i, n) => (
        <span key={i.k}>{n ? ' · ' : ''}{i.label.split(' (')[0].toLowerCase()} <b style={{ color: i.used >= i.limit ? 'var(--amber)' : 'var(--text-muted)' }}>{i.used} из {i.limit}</b></span>
      ))}
      {full && <span style={{ display: 'block', marginTop: 2 }}>Предел бесплатного использования достигнут — чтобы расширить, напишите администратору.</span>}
    </div>
  )
}
