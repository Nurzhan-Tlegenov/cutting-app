import { useEffect, useRef, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { unreadCount } from '../lib/messages'
import { fetchNotices } from '../lib/notices'
import NavDrawer, { setMenuBadge } from './NavDrawer'
import { pushStatus, enablePush, syncPush, playNoticeSound } from '../lib/push'

// Предложение включить уведомления на телефоне: показывается, пока не включены; «Позже» — снова через неделю
const ASK = 'pushAskLater'
const askLater = () => { try { return Date.now() < Number(localStorage.getItem(ASK) || 0) } catch { return false } }
function PushAsk() {
  const [st, setSt] = useState(null)
  const [msg, setMsg] = useState('')
  useEffect(() => { let alive = true; pushStatus().then(v => { if (alive) setSt(v) }); return () => { alive = false } }, [])
  if (!(st === 'off' || st === 'ios-home') || askLater()) return null
  const later = () => { try { localStorage.setItem(ASK, String(Date.now() + 7 * 864e5)) } catch { /* без памяти */ } setSt('later') }
  const on = async () => { setMsg('Включаем…'); const r = await enablePush(); if (r.error) setMsg(r.error); else { setMsg(''); setSt('on') } }
  return (
    <div style={{ position: 'fixed', left: 10, right: 10, bottom: 'calc(66px + env(safe-area-inset-bottom))', zIndex: 101, background: 'var(--bg)', border: '1px solid var(--blue)', borderRadius: 12, boxShadow: '0 4px 16px rgba(0,0,0,.15)', padding: '10px 12px', fontSize: 13 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <span style={{ fontSize: 18 }}>🔔</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <b>Уведомления на телефон</b>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
            {st === 'ios-home'
              ? 'На iPhone: Поделиться → «На экран Домой», откройте RaskroyPro с экрана Домой и включите здесь — заявки и статусы будут приходить в шторку со звуком.'
              : 'Новые заявки и статусы заказов будут приходить в шторку со звуком — даже когда приложение закрыто.'}
          </div>
          {msg && <div style={{ fontSize: 12, color: msg === 'Включаем…' ? 'var(--text-hint)' : 'var(--danger)', marginTop: 4 }}>{msg}</div>}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 8, justifyContent: 'flex-end' }}>
        <button type="button" onClick={later} style={{ padding: '6px 12px', borderRadius: 8, border: '0.5px solid var(--border-md)', background: 'var(--bg)', color: 'var(--text-muted)', fontSize: 13 }}>Позже</button>
        {st === 'off' && <button type="button" onClick={on} style={{ padding: '6px 14px', borderRadius: 8, border: 'none', background: 'var(--blue)', color: 'white', fontSize: 13, fontWeight: 500 }}>Включить</button>}
      </div>
    </div>
  )
}

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
  // Уведомления: новые заявки на регистрацию (мастер), новые заявки производству, смена статуса своих заказов.
  // Пока приложение открыто — проверка раз в 45 секунд и при возвращении в него; о новом событии — плашка сверху.
  const navigate = useNavigate()
  const [notices, setNotices] = useState({ users: 0, production: 0, orders: 0, list: [] })
  const [toast, setToast] = useState(null)
  const known = useRef(null)                          // события, о которых уже сообщали
  useEffect(() => { if (user?.id) syncPush() }, [user?.id])   // телефон с включёнными уведомлениями — за вошедшим аккаунтом
  useEffect(() => {
    if (!user?.id) return
    let alive = true, hide = null
    const check = async () => {
      if (document.hidden) return
      const n = await fetchNotices({ user, isMaster })
      if (!alive) return
      setNotices(n)
      const keys = new Set(n.list.map(x => x.key))
      const fresh = known.current ? n.list.filter(x => !known.current.has(x.key)) : []
      known.current = keys
      if (fresh.length) {
        setToast({ ...fresh[0], more: fresh.length - 1 })
        try { navigator.vibrate?.(120) } catch { /* без вибрации */ }
        playNoticeSound()
        clearTimeout(hide); hide = setTimeout(() => { if (alive) setToast(null) }, 9000)
      }
    }
    check()
    const timer = setInterval(check, 45000)
    const onShow = () => { if (!document.hidden) check() }
    document.addEventListener('visibilitychange', onShow)
    window.addEventListener('notices-seen', check)
    return () => { alive = false; clearInterval(timer); clearTimeout(hide); document.removeEventListener('visibilitychange', onShow); window.removeEventListener('notices-seen', check) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, isMaster])
  useEffect(() => { setMenuBadge(notices.users + notices.production + notices.orders + unread) }, [notices, unread])
  const dot = n => (n > 0 ? <span style={{ position: 'absolute', top: 0, left: '50%', marginLeft: 6, minWidth: 16, height: 16, padding: '0 4px', borderRadius: 8, background: 'var(--danger)', color: 'white', fontSize: 10, fontWeight: 600, lineHeight: '16px', textAlign: 'center' }}>{n > 9 ? '9+' : n}</span> : null)
  const cls = ({ isActive }) => (isActive ? 'active' : '')
  const { pathname } = useLocation()
  const inOrders = pathname.startsWith('/orders') && pathname !== '/orders/new'

  return (
    <>
    <NavDrawer notices={notices} unread={unread} />
    {pathname !== '/notices' && pathname !== '/profile' && <PushAsk />}
    {toast && (
      <div onClick={() => { setToast(null); navigate(toast.more > 0 ? '/notices' : toast.to) }}
        style={{ position: 'fixed', top: 'calc(8px + env(safe-area-inset-top))', left: 10, right: 10, zIndex: 1200, display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
          background: 'var(--blue)', color: 'white', borderRadius: 12, boxShadow: '0 4px 16px rgba(0,0,0,.25)', cursor: 'pointer', fontSize: 13 }}>
        <span style={{ fontSize: 16 }}>🔔</span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block' }}>{toast.text}</span>
          <span style={{ display: 'block', fontSize: 11.5, opacity: 0.85, marginTop: 2 }}>{toast.more > 0 ? `и ещё ${toast.more} · нажмите — все новые` : `Нажмите → ${toast.where || 'открыть'}`}</span>
        </span>
        <span onClick={e => { e.stopPropagation(); setToast(null) }} style={{ fontSize: 18, padding: '0 4px', opacity: 0.8 }}>×</span>
      </div>
    )}
    <nav className="bottom-nav">
      {cabinet === 'production' ? (
        <NavLink to="/production" className={cls} style={{ position: 'relative' }}><IconProd /> Заявки{dot(notices.production)}</NavLink>
      ) : (
        <>
          <NavLink to="/orders" className={() => (inOrders ? 'active' : '')} style={{ position: 'relative' }}><IconOrders /> Заказы{dot(notices.orders)}</NavLink>
          <NavLink to="/orders/new" className={cls}><IconNew /> Новый</NavLink>
        </>
      )}
      <NavLink to="/messages" className={cls} style={{ position: 'relative' }}>
        <IconMsg /> Сообщения
        {unread > 0 && <span style={{ position: 'absolute', top: 0, left: '50%', marginLeft: 6, minWidth: 16, height: 16, padding: '0 4px', borderRadius: 8, background: 'var(--danger)', color: 'white', fontSize: 10, fontWeight: 600, lineHeight: '16px', textAlign: 'center' }}>{unread > 9 ? '9+' : unread}</span>}
      </NavLink>
      {/* в профиле — «Пользователи» (мастер) и переход в другой кабинет: туда же ведёт и отметка */}
      <NavLink to="/profile" className={cls} style={{ position: 'relative' }}><IconProfile /> Профиль{dot(notices.users + (cabinet === 'production' ? notices.orders : notices.production))}</NavLink>
    </nav>
    </>
  )
}
