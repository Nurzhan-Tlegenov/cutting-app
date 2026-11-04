import { useEffect, useState } from 'react'
import { supportCardOrders, supportOrderData, supportConfig } from '../lib/support'
import { buildSupportPack } from '../lib/supportPack'

const ST = { draft: 'черновик', new: 'новый', discussion: 'обсуждение', inwork: 'в работе', done: 'исполнен' }
const n1 = v => (v == null || v === '' ? '' : String(+v))
const edges = d => [['Дв', d.edge_top], ['Дн', d.edge_bottom], ['Шл', d.edge_left], ['Шп', d.edge_right]].filter(x => x[1]).map(x => `${x[0]}: ${x[1]}`).join(', ')

// Карточка обращения: заказы, на которые оно ссылается (приложенные и найденные по номеру в тексте) — просмотр без правки,
// и кнопка «📦 Пакет для разработчика» (мастер-аккаунт; сотрудник — если мастер разрешил).
export default function SupportOrders({ cardId, messagesKey }) {
  const [orders, setOrders] = useState(null)
  const [cfg, setCfg] = useState(null)
  const [open, setOpen] = useState(null)       // { id, data } — раскрытый заказ
  const [err, setErr] = useState('')
  const [step, setStep] = useState('')
  useEffect(() => {
    let alive = true
    supportCardOrders(cardId).then(r => { if (!alive) return; if (r.error) { setErr(r.missing ? r.error : ''); setOrders([]) } else setOrders(r.data || []) })
    supportConfig().then(r => { if (alive) setCfg(r.data || null) })
    return () => { alive = false }
  }, [cardId, messagesKey])
  const toggle = async o => {
    if (open?.id === o.id) { setOpen(null); return }
    setOpen({ id: o.id, data: null })
    const r = await supportOrderData(cardId, o.id, false)
    if (r.error) { setErr(r.error); setOpen(null) } else setOpen({ id: o.id, data: r.data })
  }
  const pack = async () => {
    setErr(''); setStep('Собираем…')
    try {
      const r = await buildSupportPack(cardId, setStep)
      if (r.error) { setErr(r.error); return }
      const u = URL.createObjectURL(r.blob)
      const a = document.createElement('a'); a.href = u; a.download = r.name; document.body.appendChild(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(u), 60000)
    } catch (e) { setErr(String(e?.message || e)) } finally { setStep('') }
  }
  return (
    <div className="card" style={{ marginTop: 14, padding: '9px 10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <div style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>🧩 Заказы из обращения{orders ? ` · ${orders.length}` : ''}</div>
        {cfg?.pack_allowed && <button type="button" className="btn-primary" disabled={!!step} onClick={pack} style={{ width: 'auto', padding: '6px 11px', fontSize: 12.5 }}>
          {step || '📦 Пакет для разработчика'}</button>}
      </div>
      {orders === null ? <p style={{ fontSize: 12, color: 'var(--text-hint)' }}>Загружаем…</p>
        : !orders.length ? <p style={{ fontSize: 12, color: 'var(--text-hint)' }}>Нет — ни приложенных заказов, ни номеров вида 261104_001 в тексте обращения.</p>
          : orders.map(o => (
            <div key={o.id} style={{ borderTop: '0.5px solid var(--border)', padding: '5px 0' }}>
              <div role="button" tabIndex={0} onClick={() => toggle(o)} onKeyDown={e => { if (e.key === 'Enter') toggle(o) }} style={{ cursor: 'pointer', fontSize: 13 }}>
                <b style={{ fontWeight: 500 }}>{o.order_number}</b>{o.order_name ? ` «${o.order_name}»` : ''}
                <span style={{ color: 'var(--text-hint)', fontSize: 12 }}> · {o.material_name || 'материал не указан'} · {ST[o.status] || o.status} · деталей {o.details}{o.own ? '' : ' · заказ его клиента'}</span>
                <span style={{ color: 'var(--blue)', fontSize: 12 }}> {open?.id === o.id ? '▴' : '▾'}</span>
              </div>
              {open?.id === o.id && (!open.data ? <p style={{ fontSize: 12, color: 'var(--text-hint)' }}>Загружаем…</p> : (
                <div style={{ overflowX: 'auto', marginTop: 4 }}>
                  <div style={{ fontSize: 11.5, color: 'var(--text-hint)', marginBottom: 3 }}>
                    Лист {n1(open.data.order?.sheet_length)}×{n1(open.data.order?.sheet_width)}, рез {n1(open.data.order?.kerf_width)} мм · только просмотр
                  </div>
                  <table style={{ borderCollapse: 'collapse', fontSize: 12, width: '100%' }}>
                    <thead><tr style={{ color: 'var(--text-hint)', textAlign: 'left' }}><th style={{ padding: '2px 6px' }}>Деталь</th><th style={{ padding: '2px 6px' }}>Д×Ш</th><th style={{ padding: '2px 6px' }}>Шт</th><th style={{ padding: '2px 6px' }}>Кромка</th><th style={{ padding: '2px 6px' }}>Контур</th></tr></thead>
                    <tbody>{(open.data.details || []).map(d => (
                      <tr key={d.id} style={{ borderTop: '0.5px solid var(--border)' }}>
                        <td style={{ padding: '2px 6px' }}>{d.display_name || d.name || [d.prefix, d.sort_order].filter(Boolean).join('')}</td>
                        <td style={{ padding: '2px 6px', whiteSpace: 'nowrap' }}>{n1(d.length)}×{n1(d.width)}</td>
                        <td style={{ padding: '2px 6px' }}>{d.qty}</td>
                        <td style={{ padding: '2px 6px' }}>{edges(d) || '—'}</td>
                        <td style={{ padding: '2px 6px' }}>{d.contour ? '◇ есть' : ''}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              ))}
            </div>
          ))}
      {cfg && !cfg.pack_allowed && <p style={{ fontSize: 11.5, color: 'var(--text-hint)', marginTop: 4 }}>Пакет для разработчика собирает мастер-аккаунт.</p>}
      {err && <p className="error-text" style={{ fontSize: 12, marginTop: 4 }}>{err}</p>}
    </div>
  )
}
