import { useEffect, useState } from 'react'
import { loadPrices, savePrices, PRICE_GROUPS } from '../lib/pricing'

// Прайс-лист производства: цены на операции, с которыми сталкивается раскрой.
// Заполнять можно не всё — в расчёт идут только операции с ценой. Видит и меняет прайс только владелец производства.
const clean = v => String(v ?? '').replace(/[^0-9.,]/g, '')
const CURRENCIES = ['₸', '₽', 'сом', 'сум', 'Br', '₴', '$', '€']

export default function PriceList({ production, onClose }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    let alive = true
    loadPrices(production.id).then(r => { if (!alive) return; if (r.error) setError(r.error); setData({ on: true, currency: '₸', tiers: [], ...(r.data || {}) }) })
    return () => { alive = false }
  }, [production.id])
  const set = (k, v) => { setSaved(false); setData(d => ({ ...d, [k]: v })) }
  const tiers = Array.isArray(data?.tiers) ? data.tiers : []
  const setTier = (i, k, v) => set('tiers', tiers.map((t, j) => (j === i ? { ...t, [k]: clean(v) } : t)))
  const save = async () => {
    setBusy(true); setError('')
    // ступени — по возрастанию числа деталей; ступень без числа («свыше») — последней
    const ts = tiers.filter(t => String(t.price ?? '') !== '').sort((a, b) => (Number(String(a.to).replace(',', '.')) || Infinity) - (Number(String(b.to).replace(',', '.')) || Infinity))
    const out = { ...data, tiers: ts }
    const r = await savePrices(production.id, out)
    setBusy(false)
    if (r.error) setError(r.error); else { setData(out); setSaved(true) }
  }
  const inp = { padding: '6px 8px', fontSize: 14, textAlign: 'right' }
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 900, background: 'var(--bg2)', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', background: 'var(--bg)', borderBottom: '0.5px solid var(--border)' }}>
        <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--blue)', fontSize: 22, padding: 0, lineHeight: 1 }}>←</button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 500 }}>Прайс-лист</div>
          <div style={{ fontSize: 11, color: 'var(--text-hint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{production.name}</div>
        </div>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: 14 }}>
        {!data ? <p style={{ fontSize: 13, color: 'var(--text-hint)' }}>Загрузка…</p> : (
          <>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
              Укажите цены на свои операции — заполнять можно не всё. Заказчик, выбравший ваше производство, после раскроя сразу видит общую стоимость работ
              (сами расценки ему не показываются). Другим производствам ваши цены и стоимость недоступны.
            </p>
            <div className="card" style={{ marginBottom: 10 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
                <input type="checkbox" checked={data.on !== false} onChange={e => set('on', e.target.checked)} style={{ width: 'auto' }} />
                Показывать заказчикам стоимость по этому прайс-листу
              </label>
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <label style={{ flex: 1, fontSize: 11, color: 'var(--text-muted)' }}>Валюта
                  <select value={data.currency || ''} onChange={e => set('currency', e.target.value)} style={{ padding: '6px 8px', fontSize: 14 }}>
                    {[...new Set([data.currency || '₸', ...CURRENCIES])].map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </label>
                <label style={{ flex: 2, fontSize: 11, color: 'var(--text-muted)' }}>Минимальная сумма заказа
                  <input type="text" inputMode="decimal" placeholder="нет" value={data.min ?? ''} onChange={e => set('min', clean(e.target.value))} style={inp} />
                </label>
              </div>
            </div>

            {PRICE_GROUPS.map(g => (
              <div key={g.id} className="card" style={{ marginBottom: 10 }}>
                <p className="section-title">{g.title}</p>
                {g.items.map(([k, title, unit]) => (
                  <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13 }}>{title}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-hint)' }}>{unit}{k === 'cut_sheet' && tiers.length ? ' — не действует, пока заданы ступени ниже' : ''}{k === 'edge_thick_m' ? ' — пусто: как обычная кромка' : ''}</div>
                    </div>
                    <input type="text" inputMode="decimal" placeholder="—" value={data[k] ?? ''} onChange={e => set(k, clean(e.target.value))} style={{ ...inp, width: 96, flex: '0 0 auto' }} />
                  </div>
                ))}
                {g.id === 'cut' && (
                  <div style={{ marginTop: 8, paddingTop: 8, borderTop: '0.5px solid var(--border)' }}>
                    <div style={{ fontSize: 13 }}>Раскрой листа по числу деталей на листе</div>
                    <div style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 6 }}>Цена за лист зависит от того, сколько на нём деталей: до 5 — одна цена, до 10 — другая. Строка без числа — «свыше».</div>
                    {tiers.map((t, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
                        <span style={{ fontSize: 12, color: 'var(--text-muted)', flex: '0 0 auto' }}>{i > 0 && tiers[i - 1].to ? `от ${Number(String(tiers[i - 1].to).replace(',', '.')) + 1} ` : ''}до</span>
                        <input type="text" inputMode="numeric" placeholder="свыше" value={t.to ?? ''} onChange={e => setTier(i, 'to', e.target.value)} style={{ ...inp, width: 64, flex: '0 0 auto' }} />
                        <span style={{ fontSize: 12, color: 'var(--text-muted)', flex: 1 }}>дет. — за лист</span>
                        <input type="text" inputMode="decimal" placeholder="цена" value={t.price ?? ''} onChange={e => setTier(i, 'price', e.target.value)} style={{ ...inp, width: 96, flex: '0 0 auto' }} />
                        <button type="button" onClick={() => set('tiers', tiers.filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', color: 'var(--text-hint)', fontSize: 18, padding: '0 2px' }}>×</button>
                      </div>
                    ))}
                    <button type="button" onClick={() => set('tiers', [...tiers, { to: '', price: '' }])}
                      style={{ padding: '6px 12px', borderRadius: 20, fontSize: 12, border: '0.5px solid var(--blue)', background: 'transparent', color: 'var(--blue)' }}>+ Добавить ступень</button>
                  </div>
                )}
              </div>
            ))}
            <p style={{ fontSize: 11, color: 'var(--text-hint)' }}>Все заполненные цены складываются: например, «за метр реза» и «за лист» вместе. Стоимость материала и самой кромки в расчёт не входит — только работа.</p>
          </>
        )}
      </div>
      <div style={{ padding: '10px 14px calc(10px + env(safe-area-inset-bottom))', background: 'var(--bg)', borderTop: '0.5px solid var(--border)' }}>
        {error && <p className="error-text" style={{ marginBottom: 6 }}>{error}</p>}
        {saved && <p style={{ fontSize: 12, color: 'var(--teal)', marginBottom: 6, textAlign: 'center' }}>Сохранено</p>}
        <button type="button" className="btn-primary" disabled={busy || !data} onClick={save}>{busy ? 'Сохраняем…' : 'Сохранить прайс-лист'}</button>
      </div>
    </div>
  )
}
