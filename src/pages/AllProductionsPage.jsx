import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { adminProductionOrders } from '../lib/adminApi'
import { productionLabel, sortProductions } from '../lib/productionLabel'
import { STATUS_LABELS, STATUS_BADGE, orderTitle } from '../lib/orderUtils'
import { money } from '../lib/pricing'
import { Totals, totals, usePeriod, orderDate, isWork } from '../components/OrderStats'
import BottomNav from '../components/BottomNav'
import CncLoader from '../components/CncLoader'

// Мастер-аккаунт: заказы всех производств — сколько заявок, что в работе и исполнено, листы и суммы за период.
// Суммы — зафиксированные при оформлении заказа цены (по прайс-листу производства). Доступ — только администратору.
const FILTERS = [['all', 'Все'], ['new', 'Новые'], ['work', 'В работе'], ['done', 'Исполнены']]
const date = v => (v ? new Date(v).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '')
const LINK = { background: 'none', border: '0.5px solid var(--blue)', color: 'var(--blue)', borderRadius: 'var(--radius)', padding: '4px 10px', fontSize: 12, cursor: 'pointer' }
const chip = on => ({ flex: '0 0 auto', padding: '5px 10px', fontSize: 12, borderRadius: 14, cursor: 'pointer', border: `0.5px solid ${on ? 'var(--blue)' : 'var(--border-md)'}`, background: on ? 'var(--blue)' : 'transparent', color: on ? 'white' : 'var(--text-muted)' })

export default function AllProductionsPage() {
  const navigate = useNavigate()
  const { isMaster } = useAuth()
  const [prods, setProds] = useState(null)
  const [orders, setOrders] = useState([])
  const [error, setError] = useState('')
  const keep = (k, d) => sessionStorage.getItem('allProds_' + k) ?? d
  const per = usePeriod('allProds_')
  const [filter, setFilter] = useState(() => keep('filter', 'all'))
  const [open, setOpen] = useState(() => keep('open', ''))

  useEffect(() => {
    if (!isMaster) return
    let alive = true
    Promise.all([supabase.from('productions').select('id, name, country, city, phone, status'), adminProductionOrders()]).then(([p, o]) => {
      if (!alive) return
      setError(o.error || p.error?.message || '')
      setOrders(o.data || [])
      setProds(sortProductions(p.data || []))
    })
    return () => { alive = false }
  }, [isMaster])
  useEffect(() => { Object.entries({ filter, open }).forEach(([k, v]) => sessionStorage.setItem('allProds_' + k, v)) }, [filter, open])

  const inPeriod = useMemo(() => per.inPeriod(orders), [orders, per.period, per.from, per.to])   // eslint-disable-line react-hooks/exhaustive-deps
  const byProd = useMemo(() => { const m = new Map(); for (const o of inPeriod) { if (!m.has(o.production_id)) m.set(o.production_id, []); m.get(o.production_id).push(o) } return m }, [inPeriod])

  if (!isMaster) return (
    <div className="page" style={{ paddingBottom: 100 }}>
      <p style={{ color: 'var(--text-hint)', textAlign: 'center', padding: '60px 20px' }}>Раздел доступен только мастер-аккаунту.</p>
      <BottomNav />
    </div>
  )
  if (!prods) return <div className="page" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}><CncLoader label="Загружаем производства…" /></div>

  return (
    <div className="page" style={{ paddingBottom: 100 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, paddingTop: 8 }}>
        <button onClick={() => navigate('/profile')} style={{ background: 'none', border: 'none', color: 'var(--blue)', fontSize: 20, cursor: 'pointer', padding: 0 }}>←</button>
        <h1 style={{ fontSize: 18, fontWeight: 500, flex: 1 }}>Заказы всех производств</h1>
      </div>
      {error && <div className="card" style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 10 }}>{error}</div>}

      {per.picker}

      <div className="card" style={{ marginBottom: 12, padding: '10px 12px' }}>
        <div style={{ fontSize: 12, color: 'var(--text-hint)', marginBottom: 6 }}>Все производства · за период</div>
        <Totals t={totals(inPeriod)} />
      </div>

      {prods.length === 0 && <p style={{ color: 'var(--text-hint)', textAlign: 'center', padding: '30px 20px' }}>Производств пока нет</p>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {prods.map(pr => {
          const list = byProd.get(pr.id) || [], isOpen = open === pr.id
          const shown = list.filter(o => filter === 'all' || (filter === 'new' ? o.status === 'new' : filter === 'done' ? o.status === 'done' : isWork(o)))
          return (
            <div key={pr.id} className="card" style={{ padding: '10px 12px' }}>
              <button type="button" onClick={() => setOpen(isOpen ? '' : pr.id)} aria-expanded={isOpen}
                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', padding: 0, marginBottom: 6, textAlign: 'left', cursor: 'pointer', color: 'var(--text)' }}>
                <span style={{ flex: 1, minWidth: 0, fontWeight: 500, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{productionLabel(pr)}</span>
                {(pr.status ?? 'approved') !== 'approved' && <span style={{ fontSize: 11, color: 'var(--amber)' }}>{pr.status === 'rejected' ? 'отклонено' : 'не подтверждено'}</span>}
                <span style={{ color: 'var(--text-hint)', fontSize: 12, transform: isOpen ? 'rotate(180deg)' : 'none' }}>▾</span>
              </button>
              <Totals t={totals(list)} />
              {isOpen && (
                <div style={{ marginTop: 10, borderTop: '0.5px solid var(--border)', paddingTop: 8 }}>
                  <div style={{ display: 'flex', gap: 6, overflowX: 'auto', marginBottom: 8 }}>
                    {FILTERS.map(([k, label]) => <button key={k} onClick={() => setFilter(k)} style={chip(filter === k)}>{label}</button>)}
                  </div>
                  {shown.length === 0 && <p style={{ fontSize: 12, color: 'var(--text-hint)' }}>За этот период таких заказов нет</p>}
                  {shown.map(o => (
                    <div key={o.id} style={{ padding: '7px 0', borderTop: '0.5px solid var(--border)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{orderTitle(o)}</span>
                        <span className={`badge ${STATUS_BADGE[o.status] || 'badge-new'}`}>{o.deleted ? 'Удалён · история' : o.archived_at ? 'В архиве' : STATUS_LABELS[o.status] || o.status}</span>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {date(orderDate(o))} · {o.client_name || 'Без имени'}{o.client_phone ? ` · ${o.client_phone}` : ''}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 }}>
                        <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--text-hint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          листов {o.sheets || 0} · деталей {o.parts || 0} · {o.total != null ? <b style={{ color: 'var(--text)' }}>{money(o.total, o.currency)}</b> : 'цена не зафиксирована'}
                        </span>
                        {!o.deleted && <button style={LINK} onClick={() => navigate(`/orders/${o.id}`)}>Заказ</button>}
                        {!o.deleted && <button style={LINK} onClick={() => navigate(`/orders/${o.id}/nesting`)}>Раскрой</button>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
      <BottomNav />
    </div>
  )
}
