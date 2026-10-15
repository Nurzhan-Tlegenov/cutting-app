import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import CncLoader from '../components/CncLoader'
import { refInfo, acceptRef, savePendingRef, clearPendingRef } from '../lib/refLinks'
import { getUserSettings, saveUserSettings } from '../lib/userSettings'

// Пригласительная ссылка /r/<код> (migration_ref_links.sql).
//   • Без аккаунта: «Зарегистрироваться» — регистрация без одобрения мастера, только подтверждение номера.
//   • С аккаунтом (уже был или только что зарегистрировался): ссылка принимается —
//     от производства: это производство выбирается в раскрое по умолчанию;
//     для производства: своё производство регистрируется / подтверждается без ожидания.
export default function RefPage() {
  const { code } = useParams()
  const navigate = useNavigate()
  const { user, setCabinet, refreshProfile } = useAuth()
  const [info, setInfo] = useState(undefined)
  const [res, setRes] = useState(null)
  const [error, setError] = useState('')
  const done = useRef(false)

  useEffect(() => {
    let alive = true
    refInfo(code).then(r => { if (!alive) return; if (r.missing) setError('Ссылка пока не работает — попросите прислать её позже.'); setInfo(r.data || null) })
    return () => { alive = false }
  }, [code])

  // вошли — принимаем ссылку один раз
  useEffect(() => {
    if (!user || !info || done.current) return
    done.current = true
    acceptRef(code).then(r => {
      clearPendingRef()
      if (r.error) { setError(r.error); return }
      const d = r.data || {}
      if (d.error === 'own') { setRes({ own: true }); return }
      if (d.error) { setError('Ссылка недействительна.'); return }
      if (info.kind === 'client' && info.production_id && !getUserSettings(user).lastProductionId) saveUserSettings({ lastProductionId: info.production_id }, user)
      if (info.kind === 'production') refreshProfile?.()
      setRes(d)
    })
  }, [user, info, code])   // eslint-disable-line react-hooks/exhaustive-deps

  const box = children => (
    <div className="page" style={{ paddingTop: 40 }}>
      <div style={{ textAlign: 'center', fontSize: 26, fontWeight: 600, color: 'var(--blue)', marginBottom: 16 }}>РаскройPro</div>
      <div className="card" style={{ maxWidth: 440, margin: '0 auto' }}>{children}</div>
    </div>
  )
  if (info === undefined) return <div className="page"><CncLoader label="Открываем приглашение…" /></div>
  if (!info) return box(<>
    <p className="error-text" style={{ marginBottom: 12 }}>{error || 'Приглашение не найдено или больше не действует — попросите новую ссылку.'}</p>
    <button type="button" className="btn-secondary" onClick={() => { clearPendingRef(); navigate(user ? '/' : '/auth') }}>{user ? 'В приложение' : 'Войти или зарегистрироваться'}</button>
  </>)

  const isClient = info.kind === 'client'
  const who = isClient ? <><b>{info.production_name}</b>{info.production_city ? `, ${info.production_city}` : ''}</> : <b>{info.inviter || 'Пользователь RaskroyPro'}</b>
  const head = <>
    <div style={{ fontWeight: 600, fontSize: 17, marginBottom: 6 }}>{isClient ? 'Приглашение от производства' : 'Приглашение для производства'}</div>
    <div style={{ fontSize: 14, marginBottom: 8 }}>{who} {isClient ? 'приглашает вас оформлять заказы на раскрой в приложении.' : 'приглашает ваше производство: заказы на раскрой будут приходить вам сразу с вашим резом и отступами.'}</div>
  </>

  if (!user) return box(<>
    {head}
    <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
      Регистрация по этой ссылке — <b>без ожидания одобрения</b>: нужно только подтвердить номер телефона{isClient ? '' : ', а потом заполнить данные производства — оно подтвердится сразу'}.
    </p>
    <button type="button" className="btn-primary" style={{ width: '100%' }} onClick={() => { savePendingRef(code); navigate('/auth?reg=1') }}>Зарегистрироваться</button>
    <button type="button" onClick={() => { savePendingRef(code); navigate('/auth') }}
      style={{ marginTop: 12, background: 'none', border: 'none', color: 'var(--blue)', fontSize: 13, padding: 0, cursor: 'pointer' }}>У меня уже есть аккаунт — войти</button>
  </>)

  if (error) return box(<>{head}<p className="error-text" style={{ marginBottom: 10 }}>{error}</p>
    <button type="button" className="btn-secondary" onClick={() => navigate('/')}>В приложение</button></>)
  if (!res) return <div className="page"><CncLoader label="Принимаем приглашение…" /></div>
  if (res.own) return box(<>{head}<p style={{ fontSize: 13, color: 'var(--amber)', marginBottom: 10 }}>Это ваша собственная ссылка — отправьте её {isClient ? 'клиенту' : 'производству'}.</p>
    <button type="button" className="btn-secondary" onClick={() => navigate('/invite')}>К приглашениям</button></>)

  return box(<>
    {head}
    {isClient ? <>
      <p style={{ fontSize: 13, color: 'var(--teal)', marginBottom: 12 }}>✓ Готово. В новых заказах производство «{info.production_name}» будет выбрано само — раскрой сразу с его резом и отступами.</p>
      <button type="button" className="btn-primary" style={{ width: '100%' }} onClick={() => { setCabinet('client'); navigate('/orders/new') }}>Создать заказ</button>
      <button type="button" className="btn-secondary" style={{ width: '100%', marginTop: 8 }} onClick={() => { setCabinet('client'); navigate('/orders') }}>Мои заказы</button>
    </> : <>
      <p style={{ fontSize: 13, color: 'var(--teal)', marginBottom: 12 }}>✓ Приглашение принято. Зарегистрируйте своё производство — подтверждение администратора не нужно, оно сразу появится у клиентов в списке.</p>
      <button type="button" className="btn-primary" style={{ width: '100%' }} onClick={() => { setCabinet('production'); navigate('/production') }}>Моё производство</button>
    </>}
  </>)
}
