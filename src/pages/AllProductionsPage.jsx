import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { adminProductionOrders } from '../lib/adminApi'
import { productionLabel, sortProductions } from '../lib/productionLabel'
import { STATUS_LABELS, STATUS_BADGE, orderTitle } from '../lib/orderUtils'
import { money } from '../lib/pricing'
import BottomNav from '../components/BottomNav'
import CncLoader from '../components/CncLoader'

// Мастер-аккаунт: заказы всех производств — сколько заявок, что в работе и исполнено, листы и суммы за период.
// Суммы — зафиксированные при оформлении заказа цены (по прайс-листу производства). Доступ — только администратору.
const PERIODS = [['month', 'Этот месяц'], ['prev', 'Прошлый месяц'], ['d30', '30 дней'], ['year', 'Этот год'], ['all', 'Всё время'], ['custom', 'Свои даты']]
const FILTERS = [['all', 'Все'], ['new', 'Новые'], ['work', 'В работе'], ['done', 'Исполнены']]
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const date = v => (v ? new Date(v).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '')
const n2 = v => (Math.round((Number(v) || 0) * 100) / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })
const LINK = { background: 'none', border: '0.5px solid var(--blue)', color: 'var(--blue)', borderRadius: 'var(--radius)', padding: '4px 10px', fontSize: 12, cursor: 'pointer' }
const chip = on => ({ flex: '0 0 auto', padding: '5px 10px', fontSize: 12, borderRadius: 14, cursor: 'pointer', border: `0.5px solid ${on ? 'var(--blue)' : 'var(--border-md)'}`, background: on ? 'var(--blue)' : 'transparent', color: on ? 'white' : 'var(--text-muted)' })

function periodRange(kind, from, to) {
  const now = new Date(), y = now.getFullYear(), m = now.getMonth()
  if (kind === 'month') return [new Date(y, m, 1), null]
  if (kind === 'prev') return [new Date(y, m - 1, 1), new Date(y, m, 1)]
  if (kind === 'd30') return [new Date(now.getTime() - 30 * 864e5), null]
  if (kind === 'year') return [new Date(y, 0, 1), null]
  if (kind === 'custom') return [from ? new Date(from + 'T00:00:00') : null, to ? new Date(new Date(to + 'T00:00:00').getTime() + 864e5) : null]
  return [null, null]
}
// дата, по которой заказ попадает в период: исполнен — когда исполнен, в работе — когда принят, иначе — когда отправлен
const orderDate = o => new Date((o.status === 'done' && (o.done_at || o.accepted_at)) || ((o.status === 'inwork') && o.accepted_at) || o.submitted_at || o.created_at)
const isWork = o => o.status === 'inwork' || o.status === 'discussion'

/** Итоги по списку заказов */
function totals(list) {
  const t = { all: list.length, fresh: 0, work: 0, done: 0, sheetsDone: 0, sheetsWork: 0, parts: 0, noPrice: 0, sumDone: {}, sumWork: {}, st: {} }
  const add = (o, cur, v) => { o[cur] = (o[cur] || 0) + v }
  for (const o of list) {
    const accepted = o.status === 'inwork' || o.status === 'done'
    if (o.status === 'new') t.fresh++
    if (isWork(o)) t.work++
    if (o.status === 'done') { t.done++; t.sheetsDone += o.sheets || 0 }
    if (o.status === 'inwork') t.sheetsWork += o.sheets || 0
    if (!accepted) continue
    t.parts += Number(o.parts) || 0
    if (o.total == null) t.noPrice++
    else add(o.status === 'done' ? t.sumDone : t.sumWork, o.currency || '', Number(o.total) || 0)
    const s = o.stats || {}
    for (const k of ['cut_m', 'edge_thin_m', 'edge_thick_m', 'edge_curved_m', 'holes', 'edge_holes', 'groove_m', 'pockets', 'cutouts', 'shaped_parts']) t.st[k] = (t.st[k] || 0) + (Number(s[k]) || 0)
  }
  return t
}
const sums = o => Object.entries(o).filter(([, v]) => v > 0).map(([cur, v]) => money(v, cur)).join(' + ') || '—'

function Totals({ t }) {
  const edge = (t.st.edge_thin_m || 0) + (t.st.edge_thick_m || 0)
  const work = [['Рез', t.st.cut_m, 'м'], ['Кромка', edge, 'м'], ['в т. ч. криволинейная', t.st.edge_curved_m, 'м'], ['Отверстия', (t.st.holes || 0) + (t.st.edge_holes || 0), 'шт.'], ['Пазы', t.st.groove_m, 'м'],
    ['Выемки', t.st.pockets, 'шт.'], ['Вырезы', t.st.cutouts, 'шт.'], ['Фигурные детали', t.st.shaped_parts, 'шт.']].filter(r => r[1] > 0)
  return (
    <>
      <div style={{ display: 'flex', gap: 6 }}>
        {[['Заявок', t.all], ['Новые', t.fresh], ['В работе', t.work], ['Исполнено', t.done]].map(([l, v]) => (
          <div key={l} style={{ flex: 1, minWidth: 0, textAlign: 'center', background: 'var(--bg2)', borderRadius: 'var(--radius)', padding: '4px 2px' }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>{v}</div>
            <div style={{ fontSize: 10, color: 'var(--text-hint)' }}>{l}</div>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 13, marginTop: 6, lineHeight: 1.6 }}>
        <div>Исполнено: <b>{sums(t.sumDone)}</b> · листов <b>{t.sheetsDone}</b></div>
        <div style={{ color: 'var(--text-muted)' }}>В работе: {sums(t.sumWork)} · листов {t.sheetsWork}</div>
        {t.noPrice > 0 && <div style={{ fontSize: 11, color: 'var(--amber)' }}>Без зафиксированной цены: {t.noPrice} — в суммы не вошли</div>}
      </div>
      {work.length > 0 && (
        <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 4 }}>
          Принято в работу и исполнено — деталей {n2(t.parts)}{work.map(([l, v, u]) => ` · ${l.toLowerCase()} ${n2(v)} ${u}`).join('')}
        </div>
      )}
    </>
  )
}

export default function AllProductionsPage() {
  const navigate = useNavigate()
  const { isMaster } = useAuth()
  const [prods, setProds] = useState(null)
  const [orders, setOrders] = useState([])
  const [error, setError] = useState('')
  const keep = (k, d) => sessionStorage.getItem('allProds_' + k) ?? d
  const [period, setPeriod] = useState(() => keep('period', 'month'))
  const [from, setFrom] = useState(() => keep('from', iso(new Date(new Date().getFullYear(), new Date().getMonth(), 1))))
  const [to, setTo] = useState(() => keep('to', iso(new Date())))
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
  useEffect(() => { Object.entries({ period, from, to, filter, open }).forEach(([k, v]) => sessionStorage.setItem('allProds_' + k, v)) }, [period, from, to, filter, open])

  const inPeriod = useMemo(() => {
    const [a, b] = periodRange(period, from, to)
    return orders.filter(o => { const d = orderDate(o); return (!a || d >= a) && (!b || d < b) })
  }, [orders, period, from, to])
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

      <div style={{ display: 'flex', gap: 6, overflowX: 'auto', marginBottom: 8, paddingBottom: 2 }}>
        {PERIODS.map(([k, label]) => <button key={k} onClick={() => setPeriod(k)} style={chip(period === k)}>{label}</button>)}
      </div>
      {period === 'custom' && (
        <div className="row2" style={{ marginBottom: 8 }}>
          <div><label className="label">С</label><input type="date" value={from} onChange={e => setFrom(e.target.value)} /></div>
          <div><label className="label">По</label><input type="date" value={to} onChange={e => setTo(e.target.value)} /></div>
        </div>
      )}

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
