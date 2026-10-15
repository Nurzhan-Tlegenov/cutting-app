import { useMemo } from 'react'
import { materialsOf } from '../lib/detailMaterial'

// Выбор материала для списка деталей. Показывается, только если в заказе детали
// из нескольких листовых материалов (модель импортирована целиком).
// value — ключ материала ('' — все), onChange(key).
export default function MaterialFilter({ details, order, value, onChange }) {
  const mats = useMemo(() => materialsOf(details, order), [details, order])
  if (mats.length < 2) return null
  const total = mats.reduce((n, m) => n + m.pieces, 0)
  const cur = mats.some(m => m.key === value) ? value : ''
  return (
    <select value={cur} onChange={e => onChange(e.target.value)}
      style={{ width: '100%', padding: '7px 8px', fontSize: 13, marginBottom: 8 }}>
      <option value="">Все материалы — {total} шт.</option>
      {mats.map(m => <option key={m.key} value={m.key}>{m.label} — {m.pieces} шт.</option>)}
    </select>
  )
}
