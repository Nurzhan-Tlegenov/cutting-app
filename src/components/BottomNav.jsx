import { useEffect, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { unreadCount } from '../lib/messages'

const IconOrders = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
    <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"/>
    <rect x="9" y="3" width="6" height="4" rx="1"/>
    <path d="M9 12h6M9 16h4"/>
  </svg>
)
const IconNew = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
    <circle cx="12" cy="12" r="9"/>
    <path d="M12 8v8M8 12h8"/>
  </svg>
)
const IconProfile = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
    <circle cx="12" cy="8" r="4"/>
    <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
  </svg>
)
const IconProd = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
    <path d="M3 20V9l6 4V9l6 4V5h6v15z"/>
    <path d="M7 17h2M12 17h2M17 17h1"/>
  </svg>
)
const IconMsg = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
    <path d="M18 9a6 6 0 10-12 0c0 6-2.5 7.5-2.5 7.5h17S18 15 18 9z"/>
    <path d="M10 20a2.2 2.2 0 004 0"/>
  </svg>
)

// Нижнее меню зависит от кабинета: «Клиент» — заказы и новый заказ, «Производство» — заявки.
export default function BottomNav() {
  const { user, cabinet, isMaster } = useAuth()
  const [unread, setUnread] = useState(0)
  useEffect(() => {
    let alive = true
    const check = () => unreadCount(user, isMaster).then(n => { if (alive) setUnread(n) })
    check()
    const seen = () => setUnread(0)
    window.addEventListener('messages-seen', seen)
    return () => { alive = false; window.removeEventListener('messages-seen', seen) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, isMaster])
  const cls = ({ isActive }) => (isActive ? 'active' : '')
  const { pathname } = useLocation()
  const inOrders = pathname.startsWith('/orders') && pathname !== '/orders/new'

  return (
    <nav className="bottom-nav">
      {cabinet === 'production' ? (
        <NavLink to="/production" className={cls}><IconProd /> Заявки</NavLink>
      ) : (
        <>
          <NavLink to="/orders" className={() => (inOrders ? 'active' : '')}><IconOrders /> Заказы</NavLink>
          <NavLink to="/orders/new" className={cls}><IconNew /> Новый</NavLink>
        </>
      )}
      <NavLink to="/messages" className={cls} style={{ position: 'relative' }}>
        <IconMsg /> Сообщения
        {unread > 0 && <span style={{ position: 'absolute', top: 0, left: '50%', marginLeft: 6, minWidth: 16, height: 16, padding: '0 4px', borderRadius: 8, background: 'var(--danger)', color: 'white', fontSize: 10, fontWeight: 600, lineHeight: '16px', textAlign: 'center' }}>{unread > 9 ? '9+' : unread}</span>}
      </NavLink>
      <NavLink to="/profile" className={cls}><IconProfile /> Профиль</NavLink>
    </nav>
  )
}
