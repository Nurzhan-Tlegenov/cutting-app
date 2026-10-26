import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { MenuButton } from '../components/NavDrawer'
import BottomNav from '../components/BottomNav'
import PushSettings from '../components/PushSettings'
import { fetchNotices } from '../lib/notices'

// Все новые события одним списком: что случилось и куда ведёт. Нажатие — сразу к нужной строке.
const ICON = { users: '👤', own: '📥', client: '📋' }
export default function NoticesPage() {
  const { user, isMaster } = useAuth()
  const navigate = useNavigate()
  const [list, setList] = useState(null)
  useEffect(() => {
    let alive = true
    const load = () => fetchNotices({ user, isMaster }).then(n => { if (alive) setList(n.list) })
    load()
    window.addEventListener('notices-seen', load)
    return () => { alive = false; window.removeEventListener('notices-seen', load) }
  }, [user?.id, isMaster])   // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="page page-read" style={{ paddingBottom: 100 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 12, paddingTop: 4 }}><MenuButton /><h1 style={{ fontSize: 18, fontWeight: 500 }}>Уведомления</h1></div>
      <PushSettings />
      <p className="section-title">Новое{list?.length ? ` · ${list.length}` : ''}</p>
      {!list && <p style={{ fontSize: 13, color: 'var(--text-hint)' }}>Загружаем…</p>}
      {list && !list.length && <p style={{ fontSize: 13, color: 'var(--text-hint)', textAlign: 'center', padding: '24px 0' }}>Новых событий нет.</p>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {(list || []).map(n => (
          <button key={n.key} type="button" onClick={() => navigate(n.to)} className="card"
            style={{ display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left', padding: '10px 12px', cursor: 'pointer', border: '1px solid var(--blue)', color: 'var(--text)', width: '100%' }}>
            <span style={{ fontSize: 18 }}>{ICON[n.src] || (String(n.src).startsWith('work') ? '🛠' : '🔔')}</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 14, fontWeight: 500 }}>{n.text}</span>
              {n.where && <span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-hint)', marginTop: 2 }}>→ {n.where}</span>}
            </span>
            <span style={{ color: 'var(--blue)', fontSize: 18 }}>›</span>
          </button>
        ))}
      </div>
      <BottomNav />
    </div>
  )
}
