// Заработок постов (сдельная оплата, migration_post_pay.sql): кто сколько заработал за период.
// Начисление пишется само, когда пост выполнен: количество из заказа × расценка поста (настройка поста → «Расценка»).
// Владелец, начальник и сотрудники с правами «Итоги» + «Цены» видят всех; остальные сотрудники — только своё.
import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { usePeriod, periodRange } from './OrderStats'
import { PAY_UNITS } from '../lib/postPay'

const UNIT_SHORT = Object.fromEntries(PAY_UNITS.map(([k, , s]) => [k, s]))
const n2 = v => (Math.round((Number(v) || 0) * 100) / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })
const MISSING = /PGRST202|PGRST205|42883|42P01|schema cache|Could not find|does not exist/i

export default function PostEarnings({ prodId, currency = '', title = 'Заработок постов', mine = false }) {
  const per = usePeriod('pay_')
  const [open, setOpen] = useState(() => { try { return sessionStorage.getItem('payOpen') === '1' } catch { return false } })
  const [res, setRes] = useState({ key: '', rows: null, err: '' })
  const [who, setWho] = useState(null)
  const [a, b] = periodRange(per.period, per.from, per.to)
  const range = `${a?.toISOString() || ''}|${b?.toISOString() || ''}`
  useEffect(() => {
    if (!open || !prodId) return
    let alive = true
    const key = `${prodId}|${range}|${mine}`
    supabase.rpc('post_earnings_of', { p_prod: prodId, p_from: a ? a.toISOString() : null, p_to: b ? b.toISOString() : null }).then(({ data, error }) => {
      if (!alive) return
      if (error) setRes({ key, rows: [], err: MISSING.test(String(error.message) + String(error.code)) ? 'Заработок постов появится после migration_post_pay.sql в Supabase.' : error.message })
      else setRes({ key, rows: (data || []).filter(r => !mine || r.mine), err: '' })
    })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, prodId, range, mine])
  const cur = res.key === `${prodId}|${range}|${mine}`
  const rows = cur ? res.rows : null, err = cur ? res.err : ''
  const people = useMemo(() => {
    const m = new Map()
    for (const r of rows || []) {
      const k = r.user_id || '—'
      const p = m.get(k) || { id: k, name: r.user_name || 'не назначен', sum: 0, rows: [] }
      p.sum += Number(r.sum) || 0; p.rows.push(r); m.set(k, p)
    }
    return [...m.values()].sort((x, y) => y.sum - x.sum)
  }, [rows])
  const total = people.reduce((t, p) => t + p.sum, 0)
  const toggle = () => setOpen(v => { try { sessionStorage.setItem('payOpen', v ? '0' : '1') } catch { /* без памяти */ } return !v })
  return (
    <div style={{ marginTop: 8, border: '0.5px solid var(--border-md)', borderRadius: 'var(--radius)' }}>
      <button type="button" onClick={toggle} aria-expanded={open}
        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: 'var(--bg2)', border: 'none', borderRadius: 'var(--radius)', cursor: 'pointer', textAlign: 'left', color: 'var(--text)' }}>
        <span style={{ fontWeight: 500, fontSize: 14 }}>{title}</span>
        <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{open && rows ? `${n2(total)} ${currency}` : 'кто сколько заработал'}</span>
        <span style={{ color: 'var(--text-hint)', fontSize: 12, transform: open ? 'rotate(180deg)' : 'none' }}>▾</span>
      </button>
      {open && (
        <div style={{ padding: '8px 10px 10px' }}>
          {per.picker}
          {err ? <p style={{ fontSize: 12, color: 'var(--amber)' }}>{err}</p> : rows === null ? <p style={{ fontSize: 12, color: 'var(--text-hint)' }}>Считаем…</p> : !people.length ? (
            <p style={{ fontSize: 12, color: 'var(--text-hint)' }}>За этот период начислений нет. Расценка задаётся в настройке поста (Посты → пост → «Расценка»); начисляется, когда пост выполнен.</p>
          ) : (
            <>
              {people.map(p => (
                <div key={p.id} style={{ borderTop: '0.5px solid var(--border)' }}>
                  <button type="button" onClick={() => setWho(w => (w === p.id ? null : p.id))}
                    style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text)', textAlign: 'left' }}>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                    <span style={{ fontSize: 11.5, color: 'var(--text-hint)' }}>{p.rows.length} пост.</span>
                    <b style={{ fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap' }}>{n2(p.sum)} {currency}</b>
                    <span style={{ color: 'var(--text-hint)', fontSize: 11, transform: who === p.id ? 'rotate(180deg)' : 'none' }}>▾</span>
                  </button>
                  {who === p.id && (
                    <div style={{ paddingBottom: 6 }}>
                      {/* по постам */}
                      {Object.entries(p.rows.reduce((m, r) => { m[r.post_name || 'пост'] = (m[r.post_name || 'пост'] || 0) + (Number(r.sum) || 0); return m }, {})).map(([n, v]) => (
                        <div key={n} style={{ display: 'flex', gap: 8, fontSize: 12.5, padding: '1px 0 1px 10px' }}>
                          <span style={{ flex: 1, color: 'var(--text-muted)' }}>{n}</span><span>{n2(v)}</span>
                        </div>
                      ))}
                      <details style={{ marginTop: 4, paddingLeft: 10 }}>
                        <summary style={{ fontSize: 11.5, color: 'var(--text-hint)', cursor: 'pointer' }}>по заказам</summary>
                        {p.rows.map(r => (
                          <div key={r.id} style={{ display: 'flex', gap: 6, fontSize: 11.5, padding: '3px 0', borderTop: '0.5px dashed var(--border)' }}>
                            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {new Date(r.at).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })} · {String(r.order_name || '').trim() || r.order_number || 'заказ'} · {r.post_name}
                            </span>
                            <span style={{ color: 'var(--text-hint)', whiteSpace: 'nowrap' }}>{r.unit === 'pct' ? `${n2(r.rate)} % от ${n2(r.qty * 100)}` : `${n2(r.qty)} ${UNIT_SHORT[r.unit] || ''} × ${n2(r.rate)}`}</span>
                            <b style={{ fontWeight: 500, whiteSpace: 'nowrap', minWidth: 54, textAlign: 'right' }}>{n2(r.sum)}</b>
                          </div>
                        ))}
                      </details>
                    </div>
                  )}
                </div>
              ))}
              {people.length > 1 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 6, borderTop: '1px solid var(--border-md)', fontSize: 13.5 }}>
                  <span style={{ fontWeight: 500 }}>Всего</span><b>{n2(total)} {currency}</b>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
