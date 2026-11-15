// Подтверждение почты кодом — для новых аккаунтов, зарегистрированных по почте (migration_email_verify.sql).
// Код приходит письмом Supabase («Magic Link» с {{ .Token }}), вход по коду отмечает почту подтверждённой.
// Ошибся в адресе — «Изменить почту»: адрес меняется, код уходит на новый.
import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { markEmailVerified } from '../lib/adminApi'

const WAIT = 60   // секунд между письмами
const lastSentKey = em => 'emailCodeSent:' + String(em || '').toLowerCase()
const sinceSent = em => { try { return (Date.now() - Number(sessionStorage.getItem(lastSentKey(em)) || 0)) / 1000 } catch { return 1e9 } }

function errText(e) {
  const m = String(e?.message || e || '')
  if (/rate limit|too many|security purposes|seconds/i.test(m)) return 'Письма отправляются не чаще раза в минуту — подождите немного и нажмите «Отправить код ещё раз».'
  if (/expired|invalid|token/i.test(m)) return 'Код неверный или устарел. Проверьте последнее письмо или запросите новый код.'
  if (/already.*registered|already been registered|exists/i.test(m)) return 'Этот адрес уже занят другим аккаунтом.'
  return m || 'Не получилось, попробуйте ещё раз.'
}

export default function EmailVerifyPage() {
  const { emailGate, refreshEmailGate, signOut } = useAuth()
  const [email, setEmail] = useState(emailGate?.email || '')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [left, setLeft] = useState(0)
  const [edit, setEdit] = useState(false)
  const [newEmail, setNewEmail] = useState('')
  const sentOnce = useRef(false)

  useEffect(() => { const t = setInterval(() => setLeft(Math.max(0, Math.ceil(WAIT - sinceSent(email)))), 1000); return () => clearInterval(t) }, [email])

  async function send(to = email) {
    setError(''); setNote('')
    if (sinceSent(to) < WAIT) { setNote(`Код уже отправлен на ${to}. Проверьте почту (и папку «Спам»).`); return }
    setBusy(true)
    try {
      const { error: e } = await supabase.auth.signInWithOtp({ email: to, options: { shouldCreateUser: false } })
      if (e) throw e
      try { sessionStorage.setItem(lastSentKey(to), String(Date.now())) } catch { /* без памяти */ }
      setNote(`Код отправлен на ${to}. Проверьте почту (и папку «Спам»).`)
    } catch (e) { setError(errText(e)) } finally { setBusy(false) }
  }
  // первое письмо — сразу при открытии экрана
  useEffect(() => { if (!sentOnce.current && email) { sentOnce.current = true; send(email) } }, [email]) // eslint-disable-line react-hooks/exhaustive-deps

  async function verify(e) {
    e.preventDefault()
    const token = code.replace(/\D/g, '')
    if (token.length < 6) { setError('Введите код из письма — 6 цифр.'); return }
    setBusy(true); setError('')
    try {
      const { error: e1 } = await supabase.auth.verifyOtp({ email, token, type: 'email' })
      if (e1) throw e1
      const r = await markEmailVerified()
      if (r.error) throw new Error(r.error === 'no_otp' ? 'Код принят, но отметка не записалась — нажмите «Подтвердить» ещё раз.' : r.error)
      await refreshEmailGate()
    } catch (err) { setError(errText(err)) } finally { setBusy(false) }
  }

  async function changeEmail(e) {
    e.preventDefault()
    const to = newEmail.trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) { setError('Проверьте адрес почты.'); return }
    setBusy(true); setError(''); setNote('')
    try {
      const { data, error: e1 } = await supabase.auth.updateUser({ email: to })
      if (e1) throw e1
      if (String(data?.user?.email || '').toLowerCase() !== to) {
        setNote(`На ${to} ушло письмо для смены адреса — откройте ссылку в нём, затем вернитесь сюда.`)
        return
      }
      setEmail(to); setEdit(false); setNewEmail(''); setCode('')
      await send(to)
    } catch (err) { setError(errText(err)) } finally { setBusy(false) }
  }

  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', paddingTop: 48, maxWidth: 480, margin: '0 auto' }}>
      <div style={{ marginBottom: 20, textAlign: 'center' }}>
        <div style={{ fontSize: 28, fontWeight: 600, color: 'var(--blue)', marginBottom: 4 }}>РаскройPro</div>
        <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>Подтвердите почту</div>
      </div>
      <div className="card">
        <p style={{ fontSize: 14, lineHeight: 1.45, marginBottom: 4 }}>Мы отправили код на</p>
        <p style={{ fontSize: 16, fontWeight: 600, marginBottom: 12, wordBreak: 'break-all' }} data-no-i18n>{email}</p>
        <form onSubmit={verify} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <input type="text" inputMode="numeric" autoComplete="one-time-code" placeholder="Код из письма" value={code}
            onChange={e => setCode(e.target.value.replace(/[^\d]/g, '').slice(0, 10))} style={{ fontSize: code ? 22 : 16, letterSpacing: code ? 4 : 0, textAlign: 'center' }} />
          {error && <p className="error-text">{error}</p>}
          {note && !error && <p style={{ fontSize: 12.5, color: 'var(--teal)', lineHeight: 1.4 }}>{note}</p>}
          <button type="submit" className="btn-primary" disabled={busy}>{busy ? 'Проверяем…' : 'Подтвердить'}</button>
        </form>
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button type="button" className="btn-secondary" style={{ flex: 1 }} disabled={busy || left > 0} onClick={() => send()}>
            {left > 0 ? `Отправить ещё раз (${left} с)` : 'Отправить код ещё раз'}
          </button>
          <button type="button" className="btn-secondary" style={{ flex: 1 }} disabled={busy} onClick={() => { setEdit(v => !v); setError('') }}>Изменить почту</button>
        </div>
        {edit && (
          <form onSubmit={changeEmail} style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12, paddingTop: 12, borderTop: '0.5px solid var(--border)' }}>
            <label className="label">Правильный адрес почты</label>
            <input type="email" autoComplete="email" placeholder="name@mail.com" value={newEmail} onChange={e => setNewEmail(e.target.value)} />
            <button type="submit" className="btn-primary" disabled={busy}>Сохранить и отправить код</button>
          </form>
        )}
        <p style={{ fontSize: 12, color: 'var(--text-hint)', lineHeight: 1.4, marginTop: 12 }}>Письмо не пришло? Проверьте папку «Спам» и правильность адреса. Код действует 1 час.</p>
      </div>
      <button type="button" onClick={signOut} style={{ marginTop: 14, border: 'none', background: 'none', color: 'var(--text-muted)', fontSize: 13 }}>Выйти</button>
    </div>
  )
}
