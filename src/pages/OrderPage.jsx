import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { STATUS_LABELS, STATUS_BADGE } from '../lib/orderUtils'
import BottomNav from '../components/BottomNav'

const STATUSES = ['new', 'discussion', 'inwork', 'done']

export default function OrderPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { profile } = useAuth()
  const isOperator = profile?.role === 'operator' || profile?.role === 'admin'

  const [order, setOrder] = useState(null)
  const [details, setDetails] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => { fetchOrder() }, [id])

  async function fetchOrder() {
    const { data: o } = await supabase.from('orders').select(`*, profiles(full_name, phone, whatsapp)`).eq('id', id).single()
    const { data: d } = await supabase.from('order_details').select('*').eq('order_id', id).order('sort_order')
    setOrder(o)
    setDetails(d || [])
    setLoading(false)
  }

async function setStatus(status) {
    await supabase.from('orders').update({ status }).eq('id', id)
    setOrder(o => ({ ...o, status }))
  }

  if (loading) return <div className="page"><p style={{ color: 'var(--text-hint)', paddingTop: 40 }}>Загрузка...</p></div>
  if (!order) return <div className="page"><p>Заказ не найден</p></div>

  const validDetails = details.filter(d => d.length > 0 && d.width > 0)
  const kerf = order.kerf_width || 4
  const usableL = order.sheet_length - (order.margin_left || 0) - (order.margin_right || 0)
  const usableW = order.sheet_width - (order.margin_top || 0) - (order.margin_bottom || 0)
  const usableArea = (usableL / 1000) * (usableW / 1000)
  let totalPartArea = 0, totalEdge = 0, totalQty = 0
  validDetails.forEach(d => {
    totalPartArea += ((d.length + kerf) / 1000) * ((d.width + kerf) / 1000) * d.qty
    totalQty += d.qty
    if (d.edge_top) totalEdge += (d.length / 1000) * d.qty
    if (d.edge_bottom) totalEdge += (d.length / 1000) * d.qty
    if (d.edge_left) totalEdge += (d.width / 1000) * d.qty
    if (d.edge_right) totalEdge += (d.width / 1000) * d.qty
  })
  const sheetsNeeded = usableArea > 0 ? Math.ceil(totalPartArea / (usableArea * 0.85)) : 0

  const isDraft = order.status === 'draft'
  const canSubmit = isDraft && validDetails.length > 0

  const edgeNames = { edge_top:'В', edge_right:'П', edge_bottom:'Н', edge_left:'Л' }

  return (
    <div className="page" style={{ paddingBottom: 100 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20, paddingTop: 8 }}>
        <button onClick={() => navigate('/orders')} style={{ background: 'none', border: 'none', color: 'var(--blue)', fontSize: 22, padding: 0 }}>←</button>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: 'monospace', fontWeight: 600, fontSize: 16 }}>{order.order_number}</div>
          <div style={{ fontSize: 12, color: 'var(--text-hint)' }}>{order.material_name}</div>
        </div>
        <span className={`badge ${STATUS_BADGE[order.status] || 'badge-new'}`}>
          {STATUS_LABELS[order.status] || order.status}
        </span>
      </div>

      {isOperator && order.profiles && (
        <div className="card" style={{ marginBottom: 12 }}>
          <p className="section-title">Клиент</p>
          <p style={{ fontWeight: 500 }}>{order.profiles.full_name}</p>
          <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Тел: {order.profiles.phone}</p>
          {order.profiles.whatsapp && <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>WhatsApp: {order.profiles.whatsapp}</p>}
        </div>
      )}

      {isOperator && (
        <div className="card" style={{ marginBottom: 12 }}>
          <p className="section-title">Изменить статус</p>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {STATUSES.map(s => (
              <button key={s} onClick={() => setStatus(s)} style={{
                padding: '6px 12px', borderRadius: 20, fontSize: 12, border: 'none',
                background: order.status === s ? 'var(--blue)' : 'var(--bg2)',
                color: order.status === s ? 'white' : 'var(--text-muted)',
                fontWeight: order.status === s ? 500 : 400
              }}>{STATUS_LABELS[s]}</button>
            ))}
          </div>
        </div>
      )}

      <div style={{ marginBottom: 12 }}>
        <p className="section-title">Статистика</p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {[
            ['Листов нужно', sheetsNeeded],
            ['Деталей всего', totalQty],
            ['Кромка (п.м.)', totalEdge.toFixed(1)],
            ['Площадь листов (м²)', (sheetsNeeded * usableArea).toFixed(2)]
          ].map(([label, val]) => (
            <div key={label} style={{ background: 'var(--bg2)', borderRadius: 'var(--radius)', padding: '12px' }}>
              <div style={{ fontSize: 11, color: 'var(--text-hint)' }}>{label}</div>
              <div style={{ fontSize: 22, fontWeight: 500, marginTop: 2 }}>{val}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <p className="section-title" style={{ marginBottom: 0 }}>Детали ({details.length})</p>
          {isDraft && (
            <button onClick={() => navigate(`/orders/${id}/edit`)}
              style={{ fontSize: 13, color: 'var(--blue)', background: 'none', border: 'none' }}>
              Редактировать
            </button>
          )}
        </div>

        <div style={{ background: 'var(--bg)', border: '0.5px solid var(--border)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--bg2)' }}>
                <th style={{ padding: '8px 10px', textAlign: 'left', fontWeight: 500, color: 'var(--text-muted)', fontSize: 11 }}>Деталь</th>
                <th style={{ padding: '8px 6px', textAlign: 'center', fontWeight: 500, color: 'var(--text-muted)', fontSize: 11 }}>Д×Ш</th>
                <th style={{ padding: '8px 6px', textAlign: 'center', fontWeight: 500, color: 'var(--text-muted)', fontSize: 11 }}>Кол</th>
                <th style={{ padding: '8px 6px', textAlign: 'center', fontWeight: 500, color: 'var(--text-muted)', fontSize: 11 }}>Кромка</th>
              </tr>
            </thead>
            <tbody>
              {details.map((d, i) => (
                <tr key={d.id} style={{ borderTop: '0.5px solid var(--border)' }}>
                  <td style={{ padding: '8px 10px' }}>
                    {d.prefix && <div style={{ fontSize: 10, color: 'var(--blue)', fontWeight: 500 }}>{d.prefix}</div>}
                    <div>{d.name}</div>
                  </td>
                  <td style={{ padding: '8px 6px', textAlign: 'center', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{d.length}×{d.width}</td>
                  <td style={{ padding: '8px 6px', textAlign: 'center' }}>{d.qty}</td>
                  <td style={{ padding: '8px 6px', textAlign: 'center', fontSize: 11, color: 'var(--blue)' }}>
                    {['edge_top','edge_right','edge_bottom','edge_left'].filter(k => d[k]).map(k => edgeNames[k]).join('')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {isDraft && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <button onClick={() => navigate(`/orders/${id}/nesting`)}
            style={{ width: '100%', padding: 12, background: 'var(--blue)', color: 'white',
              border: 'none', borderRadius: 'var(--radius)', fontSize: 15, fontWeight: 500, cursor: 'pointer' }}>
            ▶ Выполнить раскрой
          </button>
          <p style={{ fontSize: 12, color: 'var(--text-hint)', textAlign: 'center' }}>
            После раскроя вы сможете оформить заказ
          </p>
        </div>
      )}

      <BottomNav />
    </div>
  )
}
