import { NavLink } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

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
const IconAdmin = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
    <path d="M12 2l3 6.5L22 9.5l-5 5 1.2 7L12 18.5 5.8 21.5 7 14.5l-5-5 7-1z"/>
  </svg>
)

export default function BottomNav() {
  const { profile } = useAuth()
  const isOperator = profile?.role === 'operator' || profile?.role === 'admin'

  return (
    <nav className="bottom-nav">
      <NavLink to="/orders" className={({ isActive }) => isActive ? 'active' : ''}>
        <IconOrders /> Заказы
      </NavLink>
      <NavLink to="/orders/new" className={({ isActive }) => isActive ? 'active' : ''}>
        <IconNew /> Новый
      </NavLink>
      {isOperator && (
        <NavLink to="/admin" className={({ isActive }) => isActive ? 'active' : ''}>
          <IconAdmin /> Производство
        </NavLink>
      )}
      <NavLink to="/profile" className={({ isActive }) => isActive ? 'active' : ''}>
        <IconProfile /> Профиль
      </NavLink>
    </nav>
  )
}
