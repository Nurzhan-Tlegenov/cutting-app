import { useState } from 'react'
import Hint from './Hint'
import { useDesktop } from '../hooks/useDesktop'
import { useAuth } from '../context/AuthContext'
import { useNestingQuote } from '../hooks/useNestingQuote'
import { useBackClose } from '../lib/backStack'
import { money } from '../lib/pricing'
import { baseLines, extraLines, applyEstimate, emptyEstimate, isCustom, loadEstimate, saveEstimate, estimateKey } from '../lib/estimateEdit'
import { getUserSettings, saveUserSettings } from '../lib/userSettings'
import { syncProductionReports } from '../lib/productionReports'

// Своя смета перед PDF (кабинет производства): строки прайса можно поправить или убрать, добавить свои
// (материал — листы × цена, кромка, доставка, упаковка…), или считать без прайса — только своими строками.
// Прайс-лист производства не меняется; правки запоминаются на этот заказ и материал.
const clean = v => String(v ?? '').replace(/[^0-9.,\s-]/g, '')
const n2 = v => (Math.round(Number(v) * 100) / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })
let uid = 0
const newId = () => `x${Date.now().toString(36)}${++uid}`

export function EstimateEditor({ quote, stats, mat, est, onChange }) {
  const own = quote && !quote.empty && Array.isArray(quote.lines) && quote.lines.length > 0
  const noPrice = !!est.noPrice || !own
  const base = baseLines(quote, est)
  const extra = extraLines(est)
  const res = applyEstimate(quote, est)
  const cur = res.currency
  const set = patch => onChange({ ...est, ...patch })
  const edit = (key, patch) => {
    const e = { ...(est.edits || {}) }
    const next = { ...(e[key] || {}), ...patch }
    for (const k of Object.keys(next)) if (next[k] == null || next[k] === false) delete next[k]
    if (Object.keys(next).length) e[key] = next; else delete e[key]
    set({ edits: e })
  }
  const setX = (id, patch) => set({ extra: (est.extra || []).map(x => (x.id === id ? { ...x, ...patch } : x)) })
  const add = x => set({ extra: [...(est.extra || []), { id: newId(), title: '', qty: '1', unit: 'шт.', rate: '', ...x }] })
  const sheets = stats ? stats.sheetCount - stats.offcutSheets : 0
  const matTitle = [mat?.name, mat?.thickness ? `${mat.thickness} мм` : ''].filter(Boolean).join(' ')
  const inp = { fontSize: 13, padding: '5px 6px', minWidth: 0, textAlign: 'right' }
  const chip = on => ({ flex: 1, padding: '7px 4px', borderRadius: 20, fontSize: 12, border: on ? 'none' : '0.5px solid var(--border-md)', background: on ? 'var(--blue)' : 'transparent', color: on ? 'white' : 'var(--text-muted)' })
  const small = { padding: '5px 10px', borderRadius: 20, fontSize: 12, border: '0.5px solid var(--blue-mid)', background: 'transparent', color: 'var(--blue)' }
  const row = { padding: '6px 0', borderTop: '0.5px solid var(--border)' }
  return (
    <div>
      {own && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
          <button type="button" style={chip(!est.noPrice)} onClick={() => set({ noPrice: false })}>По прайсу</button>
          <button type="button" style={chip(!!est.noPrice)} onClick={() => set({ noPrice: true })}>Без прайса — свои строки</button>
        </div>
      )}
      <Hint>Цену и количество в строке можно поправить, строку — убрать (✕). Свои строки (материал, доставка, упаковка…) входят в итог. Прайс-лист от этого не меняется; правки запоминаются на этот заказ.</Hint>
      {!noPrice && base.map(l => (
        <div key={l.key} style={{ ...row, opacity: l.off ? 0.45 : 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <span style={{ flex: 1, minWidth: 0, textDecoration: l.off ? 'line-through' : 'none' }}>{l.title}{l.edited ? <span style={{ color: 'var(--blue)' }}> · изменено</span> : ''}</span>
            <button type="button" title={l.off ? 'Вернуть строку' : 'Убрать строку из сметы'} onClick={() => edit(l.key, { off: !l.off })} style={{ border: 'none', background: 'none', color: l.off ? 'var(--blue)' : 'var(--text-hint)', fontSize: 15, padding: '0 4px' }}>{l.off ? '↺' : '✕'}</button>
          </div>
          {!l.off && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4, fontSize: 12, color: 'var(--text-muted)' }}>
              <input type="text" inputMode="decimal" value={est.edits?.[l.key]?.qty ?? n2(l.qty)} onChange={e => edit(l.key, { qty: clean(e.target.value) })} style={{ ...inp, width: 64 }} />
              <span>{l.unit} ×</span>
              <input type="text" inputMode="decimal" value={est.edits?.[l.key]?.rate ?? n2(l.rate)} onChange={e => edit(l.key, { rate: clean(e.target.value) })} style={{ ...inp, width: 80 }} />
              <b style={{ flex: 1, textAlign: 'right', color: 'var(--text)', fontWeight: 500 }}>{n2(l.sum)}</b>
              {l.edited && <button type="button" title="Как в прайсе" onClick={() => edit(l.key, { qty: null, rate: null })} style={{ border: 'none', background: 'none', color: 'var(--blue)', fontSize: 14, padding: '0 2px' }}>↺</button>}
            </div>
          )}
        </div>
      ))}
      {extra.map(x => (
        <div key={x.id} style={row}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="text" value={x.title} placeholder="Наименование (материал, доставка…)" onChange={e => setX(x.id, { title: e.target.value })} style={{ fontSize: 13, padding: '5px 6px', flex: 1, minWidth: 0 }} />
            <button type="button" title="Удалить строку" onClick={() => set({ extra: (est.extra || []).filter(y => y.id !== x.id) })} style={{ border: 'none', background: 'none', color: 'var(--text-hint)', fontSize: 15, padding: '0 4px' }}>✕</button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4, fontSize: 12, color: 'var(--text-muted)' }}>
            <input type="text" inputMode="decimal" value={(est.extra || []).find(y => y.id === x.id)?.qty ?? ''} onChange={e => setX(x.id, { qty: clean(e.target.value) })} style={{ ...inp, width: 56 }} />
            <input type="text" value={x.unit || ''} placeholder="ед." onChange={e => setX(x.id, { unit: e.target.value.slice(0, 8) })} style={{ ...inp, width: 44, textAlign: 'left' }} />
            <span>×</span>
            <input type="text" inputMode="decimal" value={(est.extra || []).find(y => y.id === x.id)?.rate ?? ''} placeholder="цена" onChange={e => setX(x.id, { rate: clean(e.target.value) })} style={{ ...inp, width: 80 }} />
            <b style={{ flex: 1, textAlign: 'right', color: 'var(--text)', fontWeight: 500 }}>{n2(x.sum)}</b>
          </div>
        </div>
      ))}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '8px 0' }}>
        <button type="button" style={small} onClick={() => add({ title: matTitle ? `Материал ${matTitle}` : 'Материал', qty: String(sheets || 1), unit: 'л.' })}>+ Материал{sheets ? ` (${sheets} л.)` : ''}</button>
        {stats?.edgeM > 0 && <button type="button" style={small} onClick={() => add({ title: 'Кромка (материал)', qty: n2(stats.edgeM).replace(/\s/g, ''), unit: 'м' })}>+ Кромка ({n2(stats.edgeM)} м)</button>}
        <button type="button" style={small} onClick={() => add({ title: 'Доставка', qty: '1', unit: 'усл.' })}>+ Доставка</button>
        <button type="button" style={small} onClick={() => add({})}>+ Своя строка</button>
      </div>
      {!own && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
          Валюта
          <input type="text" value={est.cur ?? ''} placeholder="₸, ₽, $…" onChange={e => set({ cur: e.target.value.slice(0, 6) })} style={{ fontSize: 13, padding: '4px 6px', width: 70 }} />
        </label>
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 14, padding: '6px 0 4px', borderTop: '0.5px solid var(--border-md)' }}>
        <span>Итого{res.minApplied ? ' (мин. сумма работ)' : ''}</span><b>{money(res.total, cur)}</b>
      </div>
      {res.extras > 0 && res.work > 0 && <div style={{ fontSize: 11, color: 'var(--text-hint)' }}>работы {money(res.work, cur)} + свои строки {money(res.extras, cur)}</div>}
      {isCustom(est) && <button type="button" onClick={() => onChange(emptyEstimate())} style={{ border: 'none', background: 'none', color: 'var(--blue)', fontSize: 12, padding: '6px 0' }}>Сбросить — как в прайсе</button>}
    </div>
  )
}

/** Хранение правок сметы заказа + материала: [est, setEst] (сохраняется за аккаунтом сразу) */
// eslint-disable-next-line react-refresh/only-export-components
export function useEstimate(order, mat) {
  const { user } = useAuth()
  const key = estimateKey(order, mat)
  const [state, setState] = useState(() => ({ key, est: loadEstimate(user, key) }))
  const est = state.key === key ? state.est : loadEstimate(user, key)
  const setEst = next => { setState({ key, est: next }); saveEstimate(user, key, next) }
  return [est, setEst]
}

const PRICE_MODES = [['lines', 'Построчно'], ['total', 'Только итог'], ['none', 'Без сметы']]

/** Окно «Смета» перед PDF карт (страница раскроя, кабинет производства). onMake(est) — собрать PDF */
export default function EstimateModal({ order, mat, method, onClose, onMake }) {
  useBackClose(true, onClose)
  const { user } = useAuth()
  const desk = useDesktop()
  const { stats, quote } = useNestingQuote({ order, mats: [mat], method, productionId: order?.production_id })
  const [est, setEst] = useEstimate(order, mat)
  const [price, setPriceState] = useState(() => getUserSettings(user).pdfSummary?.price || 'lines')
  const setPrice = k => { setPriceState(k); saveUserSettings({ pdfSummary: { ...(getUserSettings(user).pdfSummary || {}), price: k } }, user); syncProductionReports(user) }
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 950, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: desk ? 'center' : 'flex-end', justifyContent: 'center' }} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ width: '100%', maxWidth: 520, maxHeight: '88vh', display: 'flex', flexDirection: 'column', background: 'var(--bg)', borderRadius: desk ? 16 : '16px 16px 0 0' }}>
        <div style={{ padding: '14px 16px 8px' }}>
          <div style={{ fontSize: 16, fontWeight: 500 }}>Смета в PDF</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            {PRICE_MODES.map(([k, l]) => <button key={k} type="button" onClick={() => setPrice(k)} style={{ flex: 1, padding: '7px 4px', borderRadius: 20, fontSize: 12, border: price === k ? 'none' : '0.5px solid var(--border-md)', background: price === k ? 'var(--blue)' : 'transparent', color: price === k ? 'white' : 'var(--text-muted)' }}>{l}</button>)}
          </div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 16px 8px' }}>
          {price === 'none' ? <p style={{ fontSize: 12, color: 'var(--text-hint)' }}>Смета в PDF не выводится — только статистика раскроя.</p>
            : quote === undefined ? <p style={{ fontSize: 12, color: 'var(--text-hint)' }}>Считаем…</p>
            : <EstimateEditor quote={quote} stats={stats} mat={mat} est={est} onChange={setEst} />}
        </div>
        <div style={{ display: 'flex', gap: 8, padding: '10px 16px calc(12px + env(safe-area-inset-bottom))', borderTop: '0.5px solid var(--border)' }}>
          <button type="button" className="btn-secondary" style={{ flex: 1 }} onClick={onClose}>Отмена</button>
          <button type="button" className="btn-primary" style={{ flex: 2 }} disabled={quote === undefined && price !== 'none'} onClick={() => onMake(est)}>Создать PDF</button>
        </div>
      </div>
    </div>
  )
}
