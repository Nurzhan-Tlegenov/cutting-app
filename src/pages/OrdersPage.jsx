import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { STATUS_LABELS, STATUS_BADGE } from '../lib/orderUtils'
import BottomNav from '../components/BottomNav'

export default function OrdersPage() {
  const { user, profile } = useAuth()
  const navigate = useNavigate()
  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const isOperator = profile?.role === 'operator' || profile?.role === 'admin'

  useEffect(() => {
    fetchOrders()
  }, [user])

  async function fetchOrders() {
    let query = supabase.from('orders').select(`*, profiles(full_name)`).order('created_at', { ascending: false })
    if (!isOperator) query = query.eq('user_id', user.id)
    const { data } = await query
    setOrders(data || [])
    setLoading(false)
  }

  const statusLabel = s => STATUS_LABELS[s] || s
  const statusBadge = s => STATUS_BADGE[s] || 'badge-new'

  if (loading) return (
    <div className="page" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <p style={{ color: 'var(--text-hint)' }}>Загрузка...</p>
    </div>
  )

  return (
    <div className="page" style={{ paddingBottom: 100 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, paddingTop: 8 }}>
        <h1 style={{ fontSize: 18, fontWeight: 500 }}>
          {isOperator ? 'Все заказы' : 'Мои заказы'}
        </h1>
        <button onClick={() => navigate('/orders/new')}
          style={{ background: 'var(--blue)', color: 'white', border: 'none', borderRadius: 'var(--radius)', padding: '8px 16px', fontSize: 14, fontWeight: 500 }}>
          + Новый
        </button>
      </div>

      {orders.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 20px' }}>
          <p style={{ color: 'var(--text-hint)', marginBottom: 16 }}>Заказов пока нет</p>
          <button className="btn-primary" style={{ maxWidth: 200 }} onClick={() => navigate('/orders/new')}>
            Создать первый заказ
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {orders.map(order => (
            <div key={order.id} className="card" onClick={() => navigate(`/orders/${order.id}`)}
              style={{ cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontWeight: 500, fontSize: 15, fontFamily: 'monospace' }}>{order.order_number}</span>
                <span className={`badge ${statusBadge(order.status)}`}>{statusLabel(order.status)}</span>
              </div>
              {order.order_name && <div style={{ fontSize: 14, fontWeight: 500 }}>{order.order_name}</div>}
              <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{order.material_name}</div>
              {isOperator && order.profiles && (
                <div style={{ fontSize: 12, color: 'var(--text-hint)' }}>{order.profiles.full_name}</div>
              )}
              <div style={{ fontSize: 11, color: 'var(--text-hint)' }}>
                {new Date(order.created_at).toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit' })}
              </div>
            </div>
          ))}
        </div>
      )}

      <BottomNav />
    </div>
  )
}
