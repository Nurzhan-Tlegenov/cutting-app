import { useState } from 'react'
import { useNestingQuote } from '../hooks/useNestingQuote'
import { supabase } from '../lib/supabase'
import { statsRows } from '../lib/nestingStats'
import { money, GROUP_TITLE, lineTitle, lineUnit } from '../lib/pricing'

// Стоимость работ производства по готовому раскрою.
// Заказчик видит общую сумму и суммы по видам работ (без расценок). Производство (full) — всю статистику раскроя
// и расчёт построчно: количество × цена. Аккаунту со своим производством цены чужого не показываются (так решает база).
const num = v => (Math.round(Number(v) * 100) / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })

// Тип изделия для цены присадки за м²: у производства две цены — «кухни, ванные» (мелкие детали, дороже) и «шкафы»
// (крупные детали). Переключатель виден, только когда у производства заполнены обе (quote.drill_kinds) и цена ещё не
// зафиксирована; выбор пишется в заказ (orders.drill_kind, migration_drill_kind.sql) и сразу пересчитывает смету
// «Без присадки» — цена присадки за м² не начисляется (присадка по площади всех деталей начисляется всегда, если цена есть)
function DrillKind({ value, onChange, two }) {
  const opt = [...(two ? [['', 'Кухня, ванная', 'мелкие детали'], ['large', 'Шкафы', 'крупные детали']] : [['', 'С присадкой', 'по площади деталей']]), ['none', 'Без присадки', 'не начислять']]
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 4 }}>{two ? 'Что кроите — от этого зависит цена присадки за м²:' : 'Присадка за м²:'}</div>
      <div style={{ display: 'flex', gap: 6 }}>
        {opt.map(([k, t, s]) => {
          const on = (value || '') === k
          return (
            <button key={k} type="button" onClick={() => onChange(k)} style={{ flex: 1, padding: '6px 8px', borderRadius: 10, cursor: 'pointer', textAlign: 'center',
              border: on ? '1.5px solid var(--blue)' : '0.5px solid var(--border-md)', background: on ? 'var(--bg)' : 'transparent', color: on ? 'var(--blue)' : 'var(--text-muted)' }}>
              <div style={{ fontSize: 13, fontWeight: on ? 600 : 400 }}>{t}</div>
              <div style={{ fontSize: 10.5, color: 'var(--text-hint)' }}>{s}</div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

export default function NestingCost({ order, mats, method, productionId, full = false, note = '', style, onDrillKind = null }) {
  const [kind, setKind] = useState(order?.drill_kind || '')
  const ord = order ? { ...order, drill_kind: kind || null } : order
  const { stats, quote } = useNestingQuote({ order: ord, mats, method, productionId })
  const pickKind = async k => {
    setKind(k)
    if (order?.id) { try { await supabase.from('orders').update({ drill_kind: k || null }).eq('id', order.id); onDrillKind?.(k || null) } catch { /* нет колонки — смета всё равно пересчитана */ } }
  }
  // переключатель — когда у производства есть цена присадки за м² (одна или две) и цена ещё не зафиксирована
  const hasDrill = !!quote?.drill_kinds || kind === 'none' || (quote?.lines || []).some(l => l.key === 'drill_m2' || l.key === 'drill_m2_large')
  const kindSwitch = quote && hasDrill && !quote.fixed ? <DrillKind value={kind} onChange={pickKind} two={!!quote.drill_kinds} /> : null
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
        {kindSwitch}
        <div style={{ fontSize: 10.5, color: 'var(--text-hint)', marginTop: 2 }}>
          {quote.fixed ? `Цена зафиксирована при оформлении заказа${quote.at ? ' ' + new Date(quote.at).toLocaleDateString('ru-RU') : ''}` : 'Предварительно: по этому раскрою и текущему прайс-листу. Цена фиксируется при оформлении заказа'}; материал и кромка в сумму не входят.
        </div>
      </div>
    )
  }
  const rows = statsRows(stats)
  return (
    <div className="card" style={{ fontSize: 13, ...style }}>
      <p className="section-title">Статистика раскроя{note ? ` ${note}` : ''}</p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', columnGap: 10, rowGap: 2 }}>
        {rows.map(r => [
          <span key={r.key + r.label + 'l'} style={{ color: 'var(--text-muted)' }}>{r.label}</span>,
          <b key={r.key + r.label + 'v'} style={{ fontWeight: 500, textAlign: 'right', whiteSpace: 'nowrap' }}>{r.value}</b>,
        ])}
      </div>
      {quote?.own && (
        <>
          <p className="section-title" style={{ marginTop: 10 }}>Стоимость работ{quote.fixed ? ` · зафиксирована${quote.at ? ' ' + new Date(quote.at).toLocaleDateString('ru-RU') : ''}` : ' · по текущему прайс-листу'}</p>
          {!quote.lines?.length && <p style={{ fontSize: 12, color: 'var(--text-hint)' }}>В прайс-листе нет цен на операции этого заказа.</p>}
          {(quote.lines || []).filter(l => Number(l.qty) > 0 || Number(l.sum) > 0).map(l => (   // только операции, которые есть в заказе
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
      {quote?.own && kindSwitch}
      {quote?.empty && <p style={{ fontSize: 11.5, color: 'var(--text-hint)', marginTop: 8 }}>Стоимость не посчитана: заполните и включите прайс-лист в кабинете производства.</p>}
    </div>
  )
}
