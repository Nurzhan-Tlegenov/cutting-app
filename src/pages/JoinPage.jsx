import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import CncLoader from '../components/CncLoader'
import { inviteInfo, acceptInvite, permsText, savePendingInvite, clearPendingInvite, openWorkplace } from '../lib/workplaces'

// Приглашение на рабочее место производства (ссылка /join/код).
// Нового человека регистрирует прямо здесь — как сотрудника этого производства, без заявки и без одобрения мастера.
// Кабинет клиента и своё производство он может запросить потом (это уже по одобрению мастера).
// Уже есть аккаунт — «Войти», и приглашение принимается после входа.
const phoneToEmail = phone => `${String(phone).replace(/\D/g, '')}@raskoypro.local`

export default function JoinPage() {
  const { code } = useParams()
  const navigate = useNavigate()
  const { user, signUp, setCabinet } = useAuth()
  const [info, setInfo] = useState(undefined)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ full_name: '', phone: '', password: '' })
  const [showPass, setShowPass] = useState(false)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  useEffect(() => {
    let alive = true
    inviteInfo(code).then(r => { if (!alive) return; if (r.error && user) setError(r.error); setInfo(r.data || null) })
    return () => { alive = false }
  }, [code, user])

  const goWork = pid => { clearPendingInvite(); openWorkplace(pid || info?.production_id); setCabinet('production'); navigate('/production') }
  const [joined, setJoined] = useState('')
  useEffect(() => { if (user && joined) goWork(joined === 'x' ? '' : joined) }, [user, joined])   // eslint-disable-line react-hooks/exhaustive-deps
  const accept = async () => {
    setBusy(true)
    const r = await acceptInvite(code)
    setBusy(false)
    if (r.error) { setError(r.error); return }
    goWork(r.data)
  }
  const register = async e => {
    e.preventDefault()
    setError('')
    if (!form.full_name.trim()) { setError('Введите имя и фамилию'); return }
    if (form.phone.replace(/\D/g, '').length < 10) { setError('Введите номер телефона полностью'); return }
    if (form.password.length < 6) { setError('Пароль минимум 6 символов'); return }
    setBusy(true)
    try {
      savePendingInvite(code)   // если что-то пойдёт не так — после входа приглашение откроется снова
      await signUp(phoneToEmail(form.phone), form.password, { full_name: form.full_name.trim(), phone: form.phone.trim(), invite: code })
      // база уже сделала его сотрудником; на случай старой базы — принимаем приглашение ещё раз (повтор безопасен)
      await acceptInvite(code)
      setJoined(info?.production_id || 'x')   // кабинет переключится, когда аккаунт войдёт (ниже)
    } catch (err) {
      const m = String(err?.message || err)
      if (/already registered/i.test(m)) setError('Этот номер уже зарегистрирован в приложении. Нажмите «У меня уже есть аккаунт — войти»: после входа приглашение откроется.')
      else if (/signup_closed|Database error saving new user|Signups not allowed/i.test(m)) setError('Приглашение не сработало — возможно, оно уже использовано или истекло. Попросите у производства новую ссылку.')
      else setError(m)
    } finally { setBusy(false) }
  }

  const box = children => (
    <div className="page" style={{ paddingTop: 40 }}>
      <div className="card" style={{ maxWidth: 440, margin: '0 auto' }}>
        <div style={{ fontWeight: 600, fontSize: 17, marginBottom: 8 }}>Приглашение на производство</div>
        {children}
      </div>
    </div>
  )
  const head = info && (
    <>
      <div style={{ fontSize: 15, marginBottom: 4 }}><b>{info.production_name}</b>{info.city ? `, ${info.city}` : ''}</div>
      {info.name && <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Рабочее место: {info.name}</div>}
      <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 12 }}>Доступ: {permsText(info.perms)}</div>
    </>
  )

  if (info === undefined) return <div className="page"><CncLoader label="Открываем приглашение…" /></div>

  if (!user) {
    if (info && !info.valid) return box(<>{head}<p style={{ fontSize: 13, color: 'var(--danger)' }}>{info.used ? 'Это приглашение уже принято.' : 'Срок приглашения истёк.'} Попросите у производства новую ссылку.</p></>)
    return box(<>
      {head}
      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>Зарегистрируйтесь как сотрудник производства — без заявки и ожидания. Вход потом — по номеру телефона и паролю.</p>
      <form onSubmit={register} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div>
          <label className="label">Имя и фамилия *</label>
          <input type="text" value={form.full_name} onChange={e => set('full_name', e.target.value)} placeholder="Иван Иванов" enterKeyHint="next" />
        </div>
        <div>
          <label className="label">Телефон * (для входа)</label>
          <input type="tel" value={form.phone} onChange={e => set('phone', e.target.value)} placeholder="+7 700 000 00 00" enterKeyHint="next" />
        </div>
        <div>
          <label className="label">Пароль *</label>
          <div style={{ position: 'relative' }}>
            <input type={showPass ? 'text' : 'password'} value={form.password} onChange={e => set('password', e.target.value)} placeholder="Минимум 6 символов" minLength={6} enterKeyHint="go" style={{ paddingRight: 44 }} />
            <button type="button" onClick={() => setShowPass(v => !v)} style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', fontSize: 18, color: 'var(--text-hint)', padding: 0 }}>{showPass ? '🙈' : '👁'}</button>
          </div>
        </div>
        {error && <p className="error-text">{error}</p>}
        <button type="submit" className="btn-primary" disabled={busy}>{busy ? 'Подождите…' : 'Зарегистрироваться сотрудником'}</button>
      </form>
      <button type="button" onClick={() => { savePendingInvite(code); navigate('/auth') }}
        style={{ marginTop: 12, background: 'none', border: 'none', color: 'var(--blue)', fontSize: 13, padding: 0, cursor: 'pointer' }}>У меня уже есть аккаунт — войти</button>
    </>)
  }

  if (!info) return box(<>
    <p className="error-text" style={{ marginBottom: 12 }}>{error || 'Приглашение не найдено — проверьте ссылку.'}</p>
    <button type="button" className="btn-secondary" onClick={() => { clearPendingInvite(); navigate('/') }}>В приложение</button>
  </>)
  return box(<>
    {head}
    {error && <p className="error-text" style={{ marginBottom: 10 }}>{error}</p>}
    {info.owner ? <p style={{ fontSize: 13, color: 'var(--amber)' }}>Это ваше собственное производство — приглашение предназначено сотруднику. Отправьте ему ссылку.</p>
      : info.mine ? <button type="button" className="btn-primary" onClick={() => goWork()}>Вы уже сотрудник — открыть производство</button>
      : !info.valid ? <p style={{ fontSize: 13, color: 'var(--danger)' }}>{info.used ? 'Это приглашение уже принято.' : 'Срок приглашения истёк.'} Попросите новую ссылку.</p>
      : <button type="button" className="btn-primary" disabled={busy} onClick={accept}>{busy ? 'Подождите…' : 'Принять приглашение'}</button>}
  </>)
}
