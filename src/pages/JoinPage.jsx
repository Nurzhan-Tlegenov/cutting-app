import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import CncLoader from '../components/CncLoader'
import { inviteInfo, acceptInvite, permsText, savePendingInvite, clearPendingInvite } from '../lib/workplaces'

// Приглашение на рабочее место производства (ссылка /join/код). Не вошёл — сначала вход или регистрация
// (приглашение запоминается и откроется снова). Сотрудник остаётся и клиентом приложения — одно другому не мешает.
export default function JoinPage() {
  const { code } = useParams()
  const navigate = useNavigate()
  const { user, setCabinet } = useAuth()
  const [info, setInfo] = useState(undefined)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!user) return
    let alive = true
    inviteInfo(code).then(r => { if (!alive) return; if (r.error) setError(r.error); setInfo(r.data || null) })
    return () => { alive = false }
  }, [code, user])

  const accept = async () => {
    setBusy(true)
    const r = await acceptInvite(code)
    setBusy(false)
    if (r.error) { setError(r.error); return }
    clearPendingInvite()
    setCabinet('production')
    navigate('/production')
  }

  const box = children => (
    <div className="page" style={{ paddingTop: 40 }}>
      <div className="card" style={{ maxWidth: 440, margin: '0 auto' }}>
        <div style={{ fontWeight: 600, fontSize: 17, marginBottom: 8 }}>Приглашение на производство</div>
        {children}
      </div>
    </div>
  )

  if (!user) return box(<>
    <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>Вас пригласили работать в производстве через приложение РаскройPro. Войдите или зарегистрируйтесь — приглашение откроется снова. Если вы уже пользуетесь приложением как клиент, просто войдите: ваши заказы останутся.</p>
    <button type="button" className="btn-primary" onClick={() => { savePendingInvite(code); navigate('/auth') }}>Войти или зарегистрироваться</button>
  </>)
  if (info === undefined) return <div className="page"><CncLoader label="Открываем приглашение…" /></div>
  if (!info) return box(<>
    <p className="error-text" style={{ marginBottom: 12 }}>{error || 'Приглашение не найдено — проверьте ссылку.'}</p>
    <button type="button" className="btn-secondary" onClick={() => { clearPendingInvite(); navigate('/') }}>В приложение</button>
  </>)
  return box(<>
    <div style={{ fontSize: 15, marginBottom: 4 }}><b>{info.production_name}</b>{info.city ? `, ${info.city}` : ''}</div>
    {info.name && <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Рабочее место: {info.name}</div>}
    <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 12 }}>Доступ: {permsText(info.perms)}</div>
    {error && <p className="error-text" style={{ marginBottom: 10 }}>{error}</p>}
    {info.owner ? <p style={{ fontSize: 13, color: 'var(--amber)' }}>Это ваше собственное производство — приглашение предназначено сотруднику. Отправьте ему ссылку.</p>
      : info.mine ? <button type="button" className="btn-primary" onClick={() => { clearPendingInvite(); setCabinet('production'); navigate('/production') }}>Вы уже сотрудник — открыть производство</button>
      : !info.valid ? <p style={{ fontSize: 13, color: 'var(--danger)' }}>{info.used ? 'Это приглашение уже принято.' : 'Срок приглашения истёк.'} Попросите новую ссылку.</p>
      : <button type="button" className="btn-primary" disabled={busy} onClick={accept}>{busy ? 'Подождите…' : 'Принять приглашение'}</button>}
    <p style={{ fontSize: 11.5, color: 'var(--text-hint)', marginTop: 10 }}>Вы останетесь и клиентом приложения: кабинеты переключаются в профиле.</p>
  </>)
}
