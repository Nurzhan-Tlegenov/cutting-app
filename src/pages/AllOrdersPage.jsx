import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { adminUsers } from '../lib/adminApi'
import { STATUS_LABELS, STATUS_BADGE, orderTitle } from '../lib/orderUtils'
import BottomNav from '../components/BottomNav'
import CncLoader from '../components/CncLoader'
import { archiveOrder, restoreOrder, deleteOrder } from '../lib/orderArchive'

// Мастер-аккаунт: заказы всех пользователей — чтобы по обращению открыть чужой заказ и разобраться с ошибкой.
// Обычный список «Мои заказы» остаётся только своим. Доступ — только у администратора (так же решает и база).
const FILTERS = [['all', 'Все'], ['draft', 'Черновики'], ['new', 'Отправлены'], ['discussion', 'Обсуждение'], ['inwork', 'В работе'], ['done', 'Исполнены']]
const digits = v => String(v || '').replace(/\D/g, '')
const date = v => (v ? new Date(v).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '')
const LINK = { background: 'none', border: '0.5px solid var(--blue)', color: 'var(--blue)', borderRadius: 'var(--radius)', padding: '4px 10px', fontSize: 12, cursor: 'pointer' }

export default function AllOrdersPage() {
  const navigate = useNavigate()
  const { user, isMaster } = useAuth()
  const [orders, setOrders] = useState(null)
  const [users, setUsers] = useState(() => new Map())
  const [find, setFind] = useState(() => sessionStorage.getItem('allOrdersFind') || '')
  const [status, setStatus] = useState(() => sessionStorage.getItem('allOrdersStatus') || 'all')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!isMaster) return
    let alive = true
    // тяжёлые поля (карта раскроя) не тянем; пока в базе нет архива — список без пометки архива
    const q = cols => supabase.from('orders').select(cols).order('created_at', { ascending: false }).limit(1000)
    Promise.all([
      q('id, user_id, order_name, order_number, status, material_name, material_thickness, created_at, archived_at').then(r => (r.error ? q('id, user_id, order_name, order_number, status, material_name, material_thickness, created_at') : r)),
      adminUsers(),
    ]).then(([o, u]) => {
      if (!alive) return
      if (o.error) setError(o.error.message)
      setOrders(o.data || [])
      setUsers(new Map((u.data || []).map(x => [x.id, x])))
    })
    return () => { alive = false }
  }, [isMaster])
  useEffect(() => { sessionStorage.setItem('allOrdersFind', find); sessionStorage.setItem('allOrdersStatus', status) }, [find, status])

  const owner = o => users.get(o.user_id)
  const patch = (id, p) => setOrders(list => (p ? list.map(x => (x.id === id ? { ...x, ...p } : x)) : list.filter(x => x.id !== id)))
  const act = async (fn, id, done) => { const r = await fn(); if (!r) return; if (r.error) { setError(r.error); return } setError(''); done(r) }
  const tel = u => digits(u?.phone) || digits(String(u?.email || '').split('@')[0])
  const shown = useMemo(() => {
    const q = find.trim().toLowerCase(), qd = digits(q)
    return (orders || []).filter(o => status === 'all' || o.status === status).filter(o => {
      if (!q) return true
      const u = users.get(o.user_id)
      return `${orderTitle(o)} ${o.order_number || ''} ${o.material_name || ''} ${u?.full_name || ''}`.toLowerCase().includes(q) || (qd.length > 2 && tel(u).includes(qd))
    })
  }, [orders, users, find, status])

  if (!isMaster) return (
    <div className="page" style={{ paddingBottom: 100 }}>
      <p style={{ color: 'var(--text-hint)', textAlign: 'center', padding: '60px 20px' }}>Раздел доступен только мастер-аккаунту.</p>
      <BottomNav />
    </div>
  )
  if (!orders) return <div className="page" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}><CncLoader label="Загружаем заказы…" /></div>

  return (
    <div className="page" style={{ paddingBottom: 100 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, paddingTop: 8 }}>
        <button onClick={() => navigate('/profile')} style={{ background: 'none', border: 'none', color: 'var(--blue)', fontSize: 20, cursor: 'pointer', padding: 0 }}>←</button>
        <h1 style={{ fontSize: 18, fontWeight: 500, flex: 1 }}>Заказы всех клиентов</h1>
        <span style={{ fontSize: 12, color: 'var(--text-hint)' }}>{shown.length} из {orders.length}</span>
      </div>
      {error && <div className="card" style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 10 }}>{error}</div>}
      <input value={find} onChange={e => setFind(e.target.value)} placeholder="Клиент, телефон, заказ или материал" style={{ marginBottom: 8 }} />
      <div style={{ display: 'flex', gap: 6, overflowX: 'auto', marginBottom: 10, paddingBottom: 2 }}>
        {FILTERS.map(([k, label]) => (
          <button key={k} onClick={() => setStatus(k)}
            style={{ flex: '0 0 auto', padding: '5px 10px', fontSize: 12, borderRadius: 14, cursor: 'pointer',
              border: `0.5px solid ${status === k ? 'var(--blue)' : 'var(--border-md)'}`, background: status === k ? 'var(--blue)' : 'transparent', color: status === k ? 'white' : 'var(--text-muted)' }}>
            {label}
          </button>
        ))}
      </div>
      {shown.length === 0 && <p style={{ color: 'var(--text-hint)', textAlign: 'center', padding: '40px 20px' }}>Ничего не найдено</p>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {shown.map(o => {
          const u = owner(o), t = tel(u)
          return (
            <div key={o.id} className="card" style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 5 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ flex: 1, minWidth: 0, fontWeight: 500, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{orderTitle(o)}</span>
                <span className={`badge ${STATUS_BADGE[o.status] || 'badge-new'}`}>{STATUS_LABELS[o.status] || (o.status === 'draft' ? 'Черновик' : o.status)}</span>
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {o.user_id === user?.id ? 'Вы' : u?.full_name || 'Без имени'}
                {t && o.user_id !== user?.id && <> · <a href={`tel:+${t}`} style={{ color: 'var(--blue)' }}>{u?.phone || `+${t}`}</a></>}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--text-hint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {date(o.created_at)}{o.material_name ? ` · ${o.material_name}` : ''}{o.material_thickness ? ` ${o.material_thickness} мм` : ''}
                </span>
                <button style={LINK} onClick={() => navigate(`/orders/${o.id}`)}>Заказ</button>
                <button style={LINK} onClick={() => navigate(`/orders/${o.id}/nesting`)}>Раскрой</button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ flex: 1, fontSize: 11, color: 'var(--amber)' }}>{o.archived_at ? 'В архиве' : ''}</span>
                {o.archived_at
                  ? <button style={{ ...LINK, color: 'var(--text-muted)', borderColor: 'var(--border-md)' }} onClick={() => act(() => restoreOrder(o.id), o.id, () => patch(o.id, { archived_at: null }))}>↩ Восстановить</button>
                  : (o.status === 'done' || o.status === 'draft') && <button style={{ ...LINK, color: 'var(--amber)', borderColor: 'var(--amber)' }} onClick={() => act(() => archiveOrder(o, orderTitle(o)), o.id, r => patch(o.id, { archived_at: r.at }))}>📦 В архив</button>}
                <button style={{ ...LINK, color: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={() => act(() => deleteOrder(o, orderTitle(o)), o.id, () => patch(o.id, null))}>🗑 Удалить</button>
              </div>
            </div>
          )
        })}
      </div>
      <BottomNav />
    </div>
  )
}
