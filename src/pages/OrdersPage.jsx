import { useState, useEffect, useRef } from 'react'
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
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState(new Set())
  const [deleting, setDeleting] = useState(false)
  const isOperator = profile?.role === 'operator' || profile?.role === 'admin'
  const holdTimers = useRef({})

  useEffect(() => { fetchOrders() }, [user])

  async function fetchOrders() {
    let query = supabase.from('orders').select('*').order('created_at', { ascending: false })
    if (!isOperator) query = query.eq('user_id', user.id)
    const { data } = await query
    setOrders(data || [])
    setLoading(false)
  }

  function startHold(id) {
    holdTimers.current[id] = setTimeout(() => {
      setSelectMode(true)
      setSelected(new Set([id]))
    }, 600)
  }

  function cancelHold(id) {
    clearTimeout(holdTimers.current[id])
  }

  function toggleSelect(id) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function handleTap(id) {
    if (selectMode) {
      toggleSelect(id)
    } else {
      navigate(`/orders/${id}`)
    }
  }

  function exitSelectMode() {
    setSelectMode(false)
    setSelected(new Set())
  }

  async function deleteSelected() {
    if (!window.confirm(`Удалить ${selected.size} заказ(ов)? Это действие нельзя отменить.`)) return
    setDeleting(true)
    for (const id of selected) {
      await supabase.from('order_details').delete().eq('order_id', id)
      await supabase.from('orders').delete().eq('id', id)
    }
    setOrders(prev => prev.filter(o => !selected.has(o.id)))
    setDeleting(false)
    exitSelectMode()
  }

  if (loading) return (
    <div className="page" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <p style={{ color: 'var(--text-hint)' }}>Загрузка...</p>
    </div>
  )

  return (
    <div className="page" style={{ paddingBottom: 100 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, paddingTop: 8 }}>
        {selectMode ? (
          <>
            <button onClick={exitSelectMode}
              style={{ background: 'none', border: 'none', color: 'var(--blue)', fontSize: 14, cursor: 'pointer' }}>
              Отмена
            </button>
            <span style={{ fontSize: 14, fontWeight: 500 }}>Выбрано: {selected.size}</span>
            <button onClick={deleteSelected} disabled={selected.size === 0 || deleting}
              style={{ background: selected.size > 0 ? 'var(--danger)' : 'var(--bg2)',
                color: selected.size > 0 ? 'white' : 'var(--text-hint)',
                border: 'none', borderRadius: 'var(--radius)', padding: '7px 14px',
                fontSize: 14, fontWeight: 500, cursor: 'pointer' }}>
              {deleting ? '...' : `🗑 Удалить (${selected.size})`}
            </button>
          </>
        ) : (
          <>
            <h1 style={{ fontSize: 18, fontWeight: 500 }}>{isOperator ? 'Все заказы' : 'Мои заказы'}</h1>
            <button onClick={() => navigate('/orders/new')}
              style={{ background: 'var(--blue)', color: 'white', border: 'none',
                borderRadius: 'var(--radius)', padding: '8px 16px', fontSize: 14, fontWeight: 500 }}>
              + Новый
            </button>
          </>
        )}
      </div>

      {orders.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 20px' }}>
          <p style={{ color: 'var(--text-hint)', marginBottom: 16 }}>Заказов пока нет</p>
          <button className="btn-primary" style={{ maxWidth: 200 }} onClick={() => navigate('/orders/new')}>
            Создать первый заказ
          </button>
        </div>
      ) : (
        <>
          {!selectMode && (
            <p style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 8, textAlign: 'center' }}>
              Удержите заказ для выбора и удаления
            </p>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {orders.map(order => {
              const isSelected = selected.has(order.id)
              return (
                <div key={order.id}
                  onClick={() => handleTap(order.id)}
                  onMouseDown={() => startHold(order.id)}
                  onMouseUp={() => cancelHold(order.id)}
                  onMouseLeave={() => cancelHold(order.id)}
                  onTouchStart={() => startHold(order.id)}
                  onTouchEnd={() => cancelHold(order.id)}
                  className="card"
                  style={{ cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 6,
                    border: isSelected ? '2px solid var(--danger)' : undefined,
                    background: isSelected ? 'rgba(226,75,74,0.05)' : undefined,
                    userSelect: 'none' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {selectMode && (
                        <div style={{ width: 20, height: 20, borderRadius: '50%',
                          border: `2px solid ${isSelected ? 'var(--danger)' : 'var(--border-md)'}`,
                          background: isSelected ? 'var(--danger)' : 'transparent',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                          {isSelected && <span style={{ color: 'white', fontSize: 12 }}>✓</span>}
                        </div>
                      )}
                      <span style={{ fontWeight: 500, fontSize: 15, fontFamily: 'monospace' }}>{order.order_number}</span>
                    </div>
                    <span className={`badge ${STATUS_BADGE[order.status] || 'badge-new'}`}>
                      {STATUS_LABELS[order.status] || order.status}
                    </span>
                  </div>
                  {order.order_name && <div style={{ fontSize: 14, fontWeight: 500 }}>{order.order_name}</div>}
                  <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{order.material_name}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-hint)' }}>
                    {new Date(order.created_at).toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit' })}
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}
      <BottomNav />
    </div>
  )
}
