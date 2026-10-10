import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { productionOrders, productionSetStatus, productionReturnOrder, orderMarks } from '../lib/productionApi'
import { orderFaults, faultText } from '../lib/nestingCheck'
import { limitFromError } from '../lib/limits'
import { STATUS_LABELS, STATUS_BADGE, orderTitle } from '../lib/orderUtils'
import { permsText, membersList } from '../lib/workplaces'
import { OrderAssign } from './ProductionStaff'
import ProductionForm from './ProductionForm'
import CncLoader from './CncLoader'

// Кабинет производства у сотрудника (своего производства нет, есть рабочие места по приглашению).
// Начальник производства (all) видит все заказы и назначает их сотрудникам; остальные — только назначенные им.
// Кнопки — по полномочиям: статусы, ЧПУ, бирки. Цен и итогов здесь нет (их видит владелец, а начальник — с галочкой «Цены»).
const date = v => (v ? new Date(v).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '')
const FILTERS = [['new', 'Новые'], ['work', 'В работе'], ['all', 'Все']]

export default function WorkerProduction({ wps, onRegister }) {
  const navigate = useNavigate()
  const [pid, setPid] = useState(() => { try { const v = localStorage.getItem('workPid'); return wps.some(w => w.production_id === v) ? v : wps[0].production_id } catch { return wps[0].production_id } })
  const wp = wps.find(w => w.production_id === pid) || wps[0]
  const perms = wp.perms || {}, chief = !!perms.all
  const can = k => chief || !!perms[k]
  const [orders, setOrders] = useState(null)
  const [members, setMembers] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [open, setOpen] = useState(() => new Set())
  const [filter, setFilter] = useState(chief ? 'new' : 'all')
  const load = async () => {
    const r = await productionOrders()
    if (r.error) { setError(r.error); setOrders([]); return }
    setError(''); setOrders((r.data || []).filter(o => !o.production_id || o.production_id === wp.production_id))
  }
  useEffect(() => {
    Promise.resolve().then(load)
    if (chief) membersList().then(r => setMembers(r.data?.members || null))
  }, [pid])   // eslint-disable-line react-hooks/exhaustive-deps
  const pick = v => { setPid(v); try { localStorage.setItem('workPid', v) } catch { /* без памяти */ } }

  const setStatus = async (o, status) => {
    if (status === 'inwork') {
      const f = await orderFaults(o.id)
      if (f.length) { window.alert(faultText(f, 'Принять такой заказ в работу нельзя. Откройте заказ и исправьте раскрой или верните заказ на доработку.')); return }
    }
    if (status === 'done' && !window.confirm(`Заказ «${orderTitle(o)}» исполнен?\nОн уйдёт из списка производства.`)) return
    setBusy(o.id)
    const r = await productionSetStatus(o.id, status)
    setBusy('')
    const lim = r.error && limitFromError(r.error)
    if (lim) { window.alert(lim.text); return }
    if (r.error) { setError(r.error); return }
    load()
  }
  const returnOrder = async o => {
    const note = window.prompt(`Вернуть заказ «${orderTitle(o)}» заказчику на доработку?\nЧто нужно поправить:`, '')
    if (note === null) return
    setBusy(o.id)
    const r = await productionReturnOrder(o.id, note)
    setBusy('')
    if (r.error) setError(r.error); else load()
  }
  const toggle = id => setOpen(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const btn = kind => ({ padding: '6px 12px', borderRadius: 20, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap', border: kind === 'main' ? 'none' : '0.5px solid var(--border-md)', background: kind === 'main' ? 'var(--blue)' : 'transparent', color: kind === 'main' ? 'white' : 'var(--text-muted)' })

  const live = (orders || []).filter(o => o.status !== 'done')
  const shown = live.filter(o => filter === 'all' || (filter === 'new' ? o.status === 'new' : o.status === 'discussion' || o.status === 'inwork'))
  return (
    <>
      <div className="card" style={{ marginBottom: 12 }}>
        {wps.length > 1 ? (
          <select value={pid} onChange={e => pick(e.target.value)} style={{ marginBottom: 6, fontWeight: 500 }}>
            {wps.map(w => <option key={w.production_id} value={w.production_id}>{w.production_name}{w.city ? `, ${w.city}` : ''}</option>)}
          </select>
        ) : <div style={{ fontWeight: 500, fontSize: 16 }}>{wp.production_name}</div>}
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Ваше рабочее место: <b style={{ fontWeight: 500 }}>{wp.name || 'сотрудник'}</b></div>
        <div style={{ fontSize: 11.5, color: 'var(--text-hint)' }}>Доступ: {permsText(perms)}{wp.owner_name ? ` · руководитель: ${wp.owner_name}` : ''}</div>
      </div>
      {error && <p className="error-text" style={{ marginBottom: 10 }}>{error}</p>}
      {chief && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
          {FILTERS.map(([id, label]) => {
            const n = live.filter(o => id === 'all' || (id === 'new' ? o.status === 'new' : o.status === 'discussion' || o.status === 'inwork')).length
            return <button key={id} type="button" onClick={() => setFilter(id)} style={{ flex: 1, padding: '7px 4px', borderRadius: 20, border: 'none', fontSize: 12, background: filter === id ? 'var(--blue)' : 'var(--bg2)', color: filter === id ? 'white' : 'var(--text-muted)' }}>{label}{n ? ` · ${n}` : ''}</button>
          })}
        </div>
      )}
      {!chief && <p className="section-title">Мои заказы</p>}
      {orders === null ? <CncLoader compact label="Загружаем заказы…" /> : !shown.length ? (
        <p style={{ fontSize: 13, color: 'var(--text-hint)', textAlign: 'center', padding: '24px 0' }}>{chief ? 'В этом разделе пусто.' : 'Вам пока не назначили заказов. Они появятся здесь, когда начальник производства их назначит.'}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {shown.map(o => {
            const isOpen = open.has(o.id)
            return (
              <div key={o.id} className="card" style={{ padding: isOpen ? '8px 12px 10px' : '7px 12px' }}>
                <div onClick={() => toggle(o.id)} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
                  <span style={{ width: 10, fontSize: 11, lineHeight: '20px', color: 'var(--text-hint)' }}>{isOpen ? '▾' : '▸'}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 500, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{orderTitle(o)}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{[o.material_name, o.sheets > 0 && `листов ${o.sheets}`, `деталей ${o.parts}`, date(o.submitted_at)].filter(Boolean).join(' · ')}</div>
                    {chief && o.client_name && <div style={{ fontSize: 12 }}>{o.client_name}{o.client_phone ? ` · ${o.client_phone}` : ''}</div>}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
                    <span className={`badge ${STATUS_BADGE[o.status] || 'badge-new'}`}>{STATUS_LABELS[o.status] || o.status}</span>
                    {'gcode_at' in o && (o.status === 'inwork' || o.gcode_at) && <div style={{ display: 'flex', gap: 4 }}>{orderMarks(o).map(m => <span key={m.key} title={m.text} style={{ fontSize: 11, lineHeight: '16px', borderRadius: 9, padding: '0 7px', border: `0.5px solid ${m.on ? 'var(--blue)' : 'var(--border-md)'}`, background: m.on ? 'var(--blue)' : 'transparent', color: m.on ? 'white' : 'var(--text-hint)' }}>{m.short}</span>)}</div>}
                  </div>
                </div>
                {isOpen && (
                  <>
                    <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                      {can('status') && o.status !== 'inwork' && <button type="button" disabled={busy === o.id} style={btn('main')} onClick={() => setStatus(o, 'inwork')}>✓ Принять</button>}
                      {can('status') && o.status === 'inwork' && <button type="button" disabled={busy === o.id} style={btn('main')} onClick={() => setStatus(o, 'done')}>Исполнен</button>}
                      <button type="button" style={btn()} onClick={() => navigate(`/orders/${o.id}`)}>Открыть</button>
                      {can('cnc') && <button type="button" style={btn()} onClick={() => navigate(`/orders/${o.id}/cnc`)}>ЧПУ</button>}
                      {can('labels') && <button type="button" style={btn()} onClick={() => navigate(`/orders/${o.id}/labels`)}>Бирки</button>}
                      {can('status') && <button type="button" disabled={busy === o.id} style={{ ...btn(), color: 'var(--amber)', borderColor: 'var(--amber)' }} onClick={() => returnOrder(o)}>↩ На доработку</button>}
                    </div>
                    {chief && <OrderAssign orderId={o.id} members={members} />}
                  </>
                )}
              </div>
            )
          })}
        </div>
      )}
      <details className="card" style={{ marginTop: 16, padding: '10px 12px' }}>
        <summary style={{ fontSize: 12.5, color: 'var(--text-muted)', cursor: 'pointer' }}>У вас есть и своё производство? Зарегистрировать</summary>
        <div style={{ marginTop: 8 }}><ProductionForm onDone={onRegister} /></div>
      </details>
    </>
  )
}
