// Полоса сверху, пока мастер тихо смотрит заказы пользователя: изменения не сохраняются (peek.js)
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { getPeek, setPeek } from '../lib/peek'

export default function PeekBar() {
  const { isMaster } = useAuth()
  const navigate = useNavigate()
  const [p, setP] = useState(getPeek)
  useEffect(() => { const f = () => setP(getPeek()); window.addEventListener('peek', f); return () => window.removeEventListener('peek', f) }, [])
  if (!isMaster || !p) return null
  return (
    <div style={{ position: 'sticky', top: 0, zIndex: 900, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '6px 12px', fontSize: 12.5,
      background: 'var(--amber)', color: '#1a1a1a' }}>
      <span style={{ flex: 1, minWidth: 0 }}>👁 Просмотр заказов: <b>{p.name}</b> — пользователь не видит, изменения в его заказы не сохраняются</span>
      <button type="button" onClick={() => navigate(`/all-orders?user=${p.userId}`)} style={{ padding: '3px 10px', borderRadius: 12, border: '1px solid #1a1a1a', background: 'transparent', color: '#1a1a1a', fontSize: 12, cursor: 'pointer' }}>Его заказы</button>
      <button type="button" onClick={() => { setPeek(null); navigate('/messages') }} style={{ padding: '3px 10px', borderRadius: 12, border: 'none', background: '#1a1a1a', color: 'white', fontSize: 12, cursor: 'pointer' }}>Выйти из просмотра</button>
    </div>
  )
}
