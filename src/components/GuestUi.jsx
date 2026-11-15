// Пробный режим без регистрации (guest.js): полоса сверху, окно «Зарегистрируйтесь», заглушка закрытых страниц,
// сообщение о переносе пробных заказов в аккаунт.
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useBackClose } from '../lib/backStack'

const goRegister = navigate => navigate('/auth?reg=1')

/** Полоса сверху у гостя */
export function GuestBar() {
  const { isGuest, signOut } = useAuth()
  const navigate = useNavigate()
  if (!isGuest) return null
  return (
    <div style={{ position: 'sticky', top: 0, zIndex: 900, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '6px 12px', fontSize: 12.5,
      background: 'var(--blue)', color: 'white' }}>
      <span style={{ flex: 1, minWidth: 0 }}>Пробный режим — заказы хранятся только на этом устройстве</span>
      <button type="button" onClick={() => goRegister(navigate)} style={{ padding: '3px 12px', borderRadius: 12, border: 'none', background: 'white', color: 'var(--blue)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Зарегистрироваться</button>
      <button type="button" onClick={() => { signOut(); navigate('/auth') }} style={{ padding: '3px 8px', borderRadius: 12, border: '1px solid rgba(255,255,255,.6)', background: 'transparent', color: 'white', fontSize: 12, cursor: 'pointer' }}>Выйти</button>
    </div>
  )
}

/** Окно «Чтобы …, зарегистрируйтесь» — по событию guest-register (guestBlock) */
export function GuestRegisterModal() {
  const navigate = useNavigate()
  const [what, setWhat] = useState(null)
  useEffect(() => {
    const f = e => setWhat(String(e.detail || ''))
    window.addEventListener('guest-register', f)
    return () => window.removeEventListener('guest-register', f)
  }, [])
  useBackClose(what != null, () => setWhat(null))
  if (what == null) return null
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget) setWhat(null) }}>
      <div className="card" style={{ maxWidth: 420, width: '100%', padding: 20 }}>
        <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 8 }}>Нужна регистрация</div>
        <p style={{ fontSize: 14, lineHeight: 1.45, marginBottom: 6 }}>{what ? `«${what}» — доступно после регистрации.` : 'Это доступно после регистрации.'}</p>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.45, marginBottom: 14 }}>Регистрация бесплатная. Ваши пробные заказы не пропадут — они сами перейдут в аккаунт.</p>
        <button type="button" className="btn-primary" style={{ width: '100%', marginBottom: 8 }} onClick={() => { setWhat(null); goRegister(navigate) }}>Зарегистрироваться</button>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn-secondary" style={{ flex: 1 }} onClick={() => { setWhat(null); navigate('/auth') }}>У меня есть аккаунт</button>
          <button type="button" className="btn-secondary" style={{ flex: 1 }} onClick={() => setWhat(null)}>Позже</button>
        </div>
      </div>
    </div>
  )
}

/** Пробные заказы перенесены в аккаунт */
export function GuestClaimedNote() {
  const [n, setN] = useState(0)
  useEffect(() => {
    const f = e => { setN(Number(e.detail) || 0); setTimeout(() => setN(0), 8000) }
    window.addEventListener('guest-claimed', f)
    return () => window.removeEventListener('guest-claimed', f)
  }, [])
  if (!n) return null
  return (
    <div onClick={() => setN(0)} style={{ position: 'fixed', left: 12, right: 12, bottom: 84, zIndex: 1000, maxWidth: 480, margin: '0 auto', padding: '10px 14px', borderRadius: 12,
      background: 'var(--teal)', color: 'white', fontSize: 13.5, boxShadow: '0 4px 16px rgba(0,0,0,.25)' }}>
      ✓ Пробные заказы перенесены в ваш аккаунт: {n}
    </div>
  )
}

/** Страница, закрытая для гостя */
export function GuestGate() {
  const navigate = useNavigate()
  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '70vh', textAlign: 'center', gap: 10 }}>
      <div style={{ fontSize: 40 }}>🔒</div>
      <div style={{ fontSize: 17, fontWeight: 600 }}>Этот раздел — после регистрации</div>
      <p style={{ fontSize: 13.5, color: 'var(--text-muted)', maxWidth: 360, lineHeight: 1.45 }}>В пробном режиме можно создать заказ, загрузить модель или детали и выполнить раскрой. Регистрация бесплатная — пробные заказы перейдут в аккаунт.</p>
      <button type="button" className="btn-primary" style={{ minWidth: 220 }} onClick={() => goRegister(navigate)}>Зарегистрироваться</button>
      <button type="button" className="btn-secondary" style={{ minWidth: 220 }} onClick={() => navigate('/orders')}>К моим заказам</button>
    </div>
  )
}
