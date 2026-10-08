import { useNestingQuote } from '../hooks/useNestingQuote'
import { statsRows } from '../lib/nestingStats'
import { money, GROUP_TITLE, lineTitle, lineUnit } from '../lib/pricing'

// Стоимость работ производства по готовому раскрою.
// Заказчик видит общую сумму и суммы по видам работ (без расценок). Производство (full) — всю статистику раскроя
// и расчёт построчно: количество × цена. Аккаунту со своим производством цены чужого не показываются (так решает база).
const num = v => (Math.round(Number(v) * 100) / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })

export default function NestingCost({ order, mats, method, productionId, full = false, note = '', style }) {
  const { stats, quote } = useNestingQuote({ order, mats, method, productionId })
  if (!stats || !stats.parts) return null
  if (!full) {
    if (!quote || quote.empty) return null
    return (
      <div style={{ background: 'var(--blue-light)', border: '0.5px solid var(--blue-mid)', borderRadius: 'var(--radius)', padding: '8px 10px', ...style }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Стоимость работ производства{note ? ` ${note}` : ''}</span>
          <b style={{ fontSize: 17, whiteSpace: 'nowrap' }}>{money(quote.total, quote.currency)}</b>
        </div>
        {(quote.groups || []).length > 1 && (
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>
            {quote.groups.map(g => `${(GROUP_TITLE[g.group] || g.group).toLowerCase()} ${money(g.sum)}`).join(' · ')}
          </div>
        )}
        {quote.min_applied && <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 2 }}>Действует минимальная сумма заказа.</div>}
        <div style={{ fontSize: 10.5, color: 'var(--text-hint)', marginTop: 2 }}>Расчёт по этому раскрою и текущему прайс-листу производства; материал и кромка в сумму не входят.</div>
      </div>
    )
  }
  const rows = statsRows(stats)
  return (
    <div className="card" style={{ fontSize: 13, ...style }}>
      <p className="section-title">Статистика раскроя{note ? ` ${note}` : ''}</p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', columnGap: 10, rowGap: 2 }}>
        {rows.map(r => [
          <span key={r.key + 'l'} style={{ color: 'var(--text-muted)' }}>{r.label}</span>,
          <b key={r.key + 'v'} style={{ fontWeight: 500, textAlign: 'right', whiteSpace: 'nowrap' }}>{r.value}</b>,
        ])}
      </div>
      {quote?.own && (
        <>
          <p className="section-title" style={{ marginTop: 10 }}>Стоимость работ</p>
          {!quote.lines?.length && <p style={{ fontSize: 12, color: 'var(--text-hint)' }}>В прайс-листе нет цен на операции этого заказа.</p>}
          {(quote.lines || []).map(l => (
            <div key={l.key} style={{ display: 'flex', gap: 8, padding: '2px 0', borderTop: '0.5px solid var(--border)' }}>
              <span style={{ flex: 1, minWidth: 0, color: 'var(--text-muted)' }}>{lineTitle(l.key)}</span>
              <span style={{ color: 'var(--text-hint)', whiteSpace: 'nowrap', fontSize: 12 }}>{num(l.qty)} {lineUnit(l.key)}{l.rate != null ? ` × ${num(l.rate)}` : ''}</span>
              <b style={{ fontWeight: 500, whiteSpace: 'nowrap', minWidth: 62, textAlign: 'right' }}>{num(l.sum)}</b>
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, paddingTop: 5, marginTop: 3, borderTop: '1px solid var(--border-md)' }}>
            <span style={{ fontWeight: 500 }}>Итого{quote.min_applied ? ' (минимальная сумма заказа)' : ''}</span>
            <b style={{ fontSize: 16 }}>{money(quote.total, quote.currency)}</b>
          </div>
        </>
      )}
      {quote?.empty && <p style={{ fontSize: 11.5, color: 'var(--text-hint)', marginTop: 8 }}>Стоимость не посчитана: заполните и включите прайс-лист в кабинете производства.</p>}
    </div>
  )
}
