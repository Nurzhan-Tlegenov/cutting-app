import { useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { useNavigate } from 'react-router-dom'
import BottomNav from '../components/BottomNav'

export default function ProfilePage() {
  const { profile, user, signOut } = useAuth()
  const navigate = useNavigate()
  const [loggingOut, setLoggingOut] = useState(false)

  async function handleSignOut() {
    setLoggingOut(true)
    await signOut()
    navigate('/auth')
  }

  const isOperator = profile?.role === 'operator' || profile?.role === 'admin'
  const initials = profile?.full_name
    ? profile.full_name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
    : (user?.email?.[0] || '?').toUpperCase()

  return (
    <div className="page" style={{ paddingBottom: 100 }}>
      <h1 style={{ fontSize: 18, fontWeight: 500, marginBottom: 20, paddingTop: 8 }}>Профиль</h1>

      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16 }}>
          <div style={{
            width: 52, height: 52, borderRadius: '50%',
            background: isOperator ? 'var(--amber-light)' : 'var(--blue-light)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 20, fontWeight: 600,
            color: isOperator ? 'var(--amber)' : 'var(--blue)',
            flexShrink: 0
          }}>
            {initials}
          </div>
          <div>
            <div style={{ fontWeight: 500, fontSize: 16 }}>
              {profile?.full_name || 'Пользователь'}
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-hint)' }}>
              {isOperator ? 'Оператор производства' : 'Клиент'}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {[
            ['Телефон', profile?.phone],
            ['WhatsApp', profile?.whatsapp],
            ['Роль', isOperator ? 'Оператор' : 'Клиент'],
          ].filter(([, val]) => val).map(([label, val]) => (
            <div key={label} style={{
              display: 'flex', justifyContent: 'space-between',
              padding: '10px 0', borderBottom: '0.5px solid var(--border)'
            }}>
              <span style={{ color: 'var(--text-hint)', fontSize: 13 }}>{label}</span>
              <span style={{ fontSize: 13 }}>{val}</span>
            </div>
          ))}
        </div>
      </div>

      <button
        onClick={handleSignOut}
        disabled={loggingOut}
        style={{
          width: '100%', padding: 12,
          background: 'var(--bg)', border: '0.5px solid var(--danger)',
          borderRadius: 'var(--radius)', fontSize: 15,
          color: 'var(--danger)', cursor: 'pointer'
        }}>
        {loggingOut ? 'Выход...' : 'Выйти из аккаунта'}
      </button>

      <BottomNav />
    </div>
  )
}
