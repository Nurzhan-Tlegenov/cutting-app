import { useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { getUserSettings, saveUserSettings } from '../lib/userSettings'
import { useNestingQuote } from '../hooks/useNestingQuote'
import { statsRows } from '../lib/nestingStats'
import { money } from '../lib/pricing'
import { saveNestingPdf } from '../lib/nestingPdf'
import { quoteLines, pdfSummaryOf, userPdfTpl } from '../lib/pdfSummary'
import PdfLayoutEditor from './PdfLayoutEditor'

// PDF карт раскроя из кабинета производства — конструктор: что из статистики раскроя и стоимости вывести
// на последней странице. Выбор запоминается за аккаунтом.
const PRICE_MODES = [['lines', 'Смета построчно'], ['total', 'Только итог'], ['none', 'Без сметы']]

export default function PdfSetup({ order, mat, method, fileName, onClose }) {
  const { user } = useAuth()
  const { stats, quote } = useNestingQuote({ order, mats: [mat], method, productionId: order?.production_id })
  const [cfg, setCfg] = useState(() => ({ off: [], price: 'lines', ...(getUserSettings(user).pdfSummary || {}) }))
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [layout, setLayout] = useState(false)       // открыт конструктор листа
  const customTpl = userPdfTpl(user)
  const change = patch => { const next = { ...cfg, ...patch }; setCfg(next); saveUserSettings({ pdfSummary: next }, user) }
  const rows = stats ? statsRows(stats) : []
  const off = new Set(cfg.off || [])
  const toggle = key => change({ off: off.has(key) ? [...off].filter(k => k !== key) : [...off, key] })
  const priced = quote && !quote.empty && Number(quote.total) > 0
  const lines = priced ? quoteLines(quote) : []
  const make = async () => {
    setBusy('…'); setError('')
    try {
      const summary = pdfSummaryOf(stats, quote, cfg)
      await saveNestingPdf({ order, mat, fileName, summary, tpl: userPdfTpl(user), onProgress: (a, b) => setBusy(`${a}/${b}`) })
      onClose()
    } catch (e) { setError('Не удалось собрать PDF: ' + (e?.message || e)); setBusy('') }
  }
  const chip = on => ({ flex: 1, padding: '7px 4px', borderRadius: 20, fontSize: 12, border: on ? 'none' : '0.5px solid var(--border-md)', background: on ? 'var(--blue)' : 'transparent', color: on ? 'white' : 'var(--text-muted)' })
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 950, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }} onClick={e => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div style={{ width: '100%', maxWidth: 520, maxHeight: '88vh', display: 'flex', flexDirection: 'column', background: 'var(--bg)', borderRadius: '16px 16px 0 0' }}>
        <div style={{ padding: '14px 16px 8px' }}>
          <div style={{ fontSize: 16, fontWeight: 500 }}>PDF карт раскроя</div>
          <div style={{ fontSize: 12, color: 'var(--text-hint)' }}>Отметьте, что вывести на последней странице: статистику раскроя и смету.</div>
          <div onClick={() => setLayout(true)} style={{ display: 'flex', alignItems: 'center', marginTop: 8, padding: '8px 10px', border: '0.5px solid var(--blue-mid)', borderRadius: 'var(--radius)', cursor: 'pointer' }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, color: 'var(--blue)', fontWeight: 500 }}>Оформление листа (конструктор)</div>
              <div style={{ fontSize: 11, color: 'var(--text-hint)' }}>{customTpl ? 'Свой макет: карта, список и подписи расставлены вами' : 'Стандартный вид. Можно расставить карту, список и подписи по-своему'}</div>
            </div>
            <span style={{ color: 'var(--blue)', fontSize: 16 }}>›</span>
          </div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 16px' }}>
          <p className="section-title">Статистика раскроя</p>
          {rows.map(r => (
            <label key={r.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderTop: '0.5px solid var(--border)', fontSize: 13 }}>
              <input type="checkbox" checked={!off.has(r.key)} onChange={() => toggle(r.key)} style={{ width: 'auto' }} />
              <span style={{ flex: 1, color: off.has(r.key) ? 'var(--text-hint)' : 'var(--text)' }}>{r.label}</span>
              <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{r.value}</span>
            </label>
          ))}
          <div style={{ display: 'flex', gap: 8, margin: '6px 0 10px' }}>
            <button type="button" style={{ ...chip(false), flex: '0 0 auto', padding: '5px 12px' }} onClick={() => change({ off: [] })}>Выбрать всё</button>
            <button type="button" style={{ ...chip(false), flex: '0 0 auto', padding: '5px 12px' }} onClick={() => change({ off: rows.map(r => r.key) })}>Снять всё</button>
          </div>
          <p className="section-title">Смета</p>
          {quote === undefined ? <p style={{ fontSize: 12, color: 'var(--text-hint)', marginBottom: 10 }}>Считаем…</p>
            : !priced ? <p style={{ fontSize: 12, color: 'var(--text-hint)', marginBottom: 10 }}>Цен нет: прайс-лист производства не заполнен или выключен (Производство → Прайс-лист).</p>
            : (
              <>
                <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                  {PRICE_MODES.map(([k, l]) => <button key={k} type="button" style={chip(cfg.price === k)} onClick={() => change({ price: k })}>{l}</button>)}
                </div>
                {cfg.price === 'lines' && lines.map((l, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, fontSize: 12.5, padding: '2px 0' }}>
                    <span style={{ flex: 1, minWidth: 0, color: 'var(--text-muted)' }}>{l.title}</span>
                    <span style={{ color: 'var(--text-hint)', whiteSpace: 'nowrap' }}>{l.qty}{l.rate ? ` × ${l.rate}` : ''}</span>
                    <b style={{ fontWeight: 500, minWidth: 60, textAlign: 'right' }}>{l.sum}</b>
                  </div>
                ))}
                {cfg.price !== 'none' && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '4px 0 10px' }}>
                    <span>Итого{quote.min_applied ? ' (минимальная сумма)' : ''}</span><b>{money(quote.total, quote.currency)}</b>
                  </div>
                )}
              </>
            )}
        </div>
        <div style={{ padding: '10px 16px calc(12px + env(safe-area-inset-bottom))', borderTop: '0.5px solid var(--border)' }}>
          {error && <p className="error-text" style={{ marginBottom: 6 }}>{error}</p>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn-secondary" style={{ flex: 1 }} disabled={!!busy} onClick={onClose}>Отмена</button>
            <button type="button" className="btn-primary" style={{ flex: 2 }} disabled={!!busy || quote === undefined} onClick={make}>{busy ? `PDF ${busy}` : 'Создать PDF'}</button>
          </div>
        </div>
      </div>
      {layout && <PdfLayoutEditor order={order} mat={mat} onClose={() => setLayout(false)} />}
    </div>
  )
}
