// Выбор угла укладки — четыре угла листа, как они лежат на карте (вверху — верх карты)
import { CORNERS, cornerOf } from '../lib/sheetCorner'

const ARROW = { tl: '↖', tr: '↗', bl: '↙', br: '↘' }

export default function CornerPick({ value, onChange, disabled = false, compact = false }) {
  const v = cornerOf(value)
  const btn = k => {
    const on = k === v
    return (
      <button key={k} type="button" disabled={disabled} onClick={() => onChange(k)} title={CORNERS.find(c => c[0] === k)[1]}
        style={{ padding: compact ? '4px 6px' : '6px 8px', fontSize: compact ? 11.5 : 12.5, borderRadius: 8, cursor: disabled ? 'default' : 'pointer',
          border: '0.5px solid ' + (on ? 'var(--blue)' : 'var(--border-md)'), background: on ? 'var(--blue-light)' : 'transparent', color: 'var(--text)',
          fontWeight: on ? 600 : 400, textAlign: 'left', whiteSpace: 'nowrap' }}>
        {ARROW[k]} {CORNERS.find(c => c[0] === k)[1].toLowerCase()}
      </button>
    )
  }
  return (
    <div style={{ display: 'inline-grid', gridTemplateColumns: '1fr 1fr', gap: 4, opacity: disabled ? 0.6 : 1 }}>
      {['tl', 'tr', 'bl', 'br'].map(btn)}
    </div>
  )
}
