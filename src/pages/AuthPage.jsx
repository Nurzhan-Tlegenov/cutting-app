import { useEffect, useState } from 'react'
import { signupOpen, requestSignup } from '../lib/adminApi'
import { useAuth } from '../context/AuthContext'
import { useNavigate } from 'react-router-dom'

export default function AuthPage() {
  const [mode, setMode] = useState('login')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const { signIn, signUp } = useAuth()
  const navigate = useNavigate()

  const [showPass, setShowPass] = useState(false)
  const [form, setForm] = useState({
    full_name: '', phone: '', whatsapp: '', email: '', password: '', comment: ''
  })
  // Регистрация может быть закрыта: тогда новый человек оставляет заявку, а регистрируется после одобрения
  const [open, setOpen] = useState(true)
  const [approved, setApproved] = useState(false)   // заявка этого номера одобрена — можно задать пароль
  const [note, setNote] = useState('')
  useEffect(() => { let alive = true; signupOpen().then(v => { if (alive) setOpen(v) }); return () => { alive = false } }, [])
  const byRequest = mode === 'register' && !open && !approved
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  // Генерируем фейковый email из номера телефона
  function phoneToEmail(phone) {
    const digits = phone.replace(/\D/g, '')
    return `${digits}@raskoypro.local`
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      if (mode === 'login') {
        const email = phoneToEmail(form.phone)
        await signIn(email, form.password)
      } else {
        if (!form.full_name.trim()) throw new Error('Введите имя и фамилию')
        if (!form.phone.trim()) throw new Error('Введите контактный телефон')
        if (byRequest) {
          const r = await requestSignup(form.full_name, form.phone, form.comment)
          if (r.error) throw new Error(r.error)
          if (r.status === 'approved' || r.status === 'open') { setApproved(true); setNote('Заявка одобрена. Остался один шаг: придумайте пароль и нажмите «Зарегистрироваться».') }
          else if (r.status === 'rejected') setError('Заявка для этого номера отклонена. Свяжитесь с нами.')
          else setNote('Заявка отправлена. Мы свяжемся с вами. После одобрения откройте «Регистрация», введите этот же номер и нажмите «Продолжить» — появится создание пароля.')
          return
        }
        if (form.password.length < 6) throw new Error('Пароль минимум 6 символов')
        if (form.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) throw new Error('Проверьте адрес почты — или оставьте поле пустым')
        const email = phoneToEmail(form.phone)
        await signUp(email, form.password, {
          full_name: form.full_name,
          phone: form.phone,
          whatsapp: form.whatsapp,
          contact_email: form.email
        })
      }
      navigate('/')
    } catch (err) {
      const msg = err.message
      if (msg.includes('Invalid login')) setError('Неверный телефон или пароль. Если вашу заявку одобрили, а пароль вы ещё не задавали — откройте вкладку «Регистрация».')
      else if (msg.includes('already registered')) setError('Этот номер уже зарегистрирован')
      else if (/signup_closed|Database error saving new user|Signups not allowed/i.test(msg)) { setOpen(false); setApproved(false); setError('Регистрация сейчас только по запросу. Оставьте заявку.') }
      else setError(msg)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', paddingTop: 48 }}>
      <div style={{ marginBottom: 32, textAlign: 'center' }}>
        <div style={{ fontSize: 28, fontWeight: 600, color: 'var(--blue)', marginBottom: 4 }}>РаскройPro</div>
        <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>
          {mode === 'login' ? 'Войдите в личный кабинет' : byRequest ? 'Регистрация по заявке' : 'Создайте аккаунт'}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <form onSubmit={handleSubmit}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 20, background: 'var(--bg2)', borderRadius: 'var(--radius)', padding: 4 }}>
            {['login','register'].map(m => (
              <button key={m} type="button" onClick={() => { setMode(m); setError(''); setNote('') }}
                style={{ flex: 1, padding: '8px', border: 'none', borderRadius: 6,
                  background: mode === m ? 'var(--bg)' : 'transparent',
                  color: mode === m ? 'var(--blue)' : 'var(--text-hint)',
                  fontWeight: mode === m ? 500 : 400, fontSize: 14 }}>
                {m === 'login' ? 'Вход' : 'Регистрация'}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {byRequest && (
              <p style={{ fontSize: 12, color: 'var(--text-muted)', background: 'var(--bg2)', borderRadius: 'var(--radius)', padding: '8px 10px' }}>
                Регистрация сейчас по запросу. <b>Заявка уже одобрена?</b> Введите имя и тот же номер телефона, нажмите «Продолжить» — и откроется создание пароля.
                Заявки ещё не было — она отправится этим же шагом, и мы с вами свяжемся.
              </p>
            )}
            {mode === 'register' && (
              <div>
                <label className="label">Имя и фамилия *</label>
                <input type="text" placeholder="Иван Иванов" value={form.full_name}
                  onChange={e => set('full_name', e.target.value)} required />
              </div>
            )}

            <div>
              <label className="label">Телефон * (используется для входа)</label>
              <input type="tel" placeholder="+7 700 000 00 00" value={form.phone}
                onChange={e => set('phone', e.target.value)} required />
            </div>

            {byRequest && (
              <div>
                <label className="label">Комментарий (кто вы, чем занимаетесь)</label>
                <input type="text" placeholder="Мебельный цех, город…" value={form.comment}
                  onChange={e => set('comment', e.target.value)} maxLength={300} />
              </div>
            )}
            {mode === 'register' && !byRequest && (
              <div>
                <label className="label">WhatsApp (если отличается)</label>
                <input type="tel" placeholder="+7 700..." value={form.whatsapp}
                  onChange={e => set('whatsapp', e.target.value)} />
              </div>
            )}

            {mode === 'register' && !byRequest && (
              <div>
                <label className="label">Электронная почта (необязательно)</label>
                <input type="email" inputMode="email" autoComplete="email" placeholder="name@mail.com" value={form.email}
                  onChange={e => set('email', e.target.value)} />
                <p style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 3 }}>Для восстановления пароля. Вход — по номеру телефона.</p>
              </div>
            )}

            {!byRequest && <div>
              <label className="label">Пароль *</label>
              <div style={{ position: 'relative' }}>
                <input type={showPass ? 'text' : 'password'} placeholder="Минимум 6 символов" value={form.password}
                  onChange={e => set('password', e.target.value)} required minLength={6}
                  style={{ paddingRight: 44 }} />
                <button type="button" onClick={() => setShowPass(v => !v)}
                  style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
                    background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-hint)', fontSize: 18, lineHeight: 1, padding: 0 }}>
                  {showPass ? '🙈' : '👁'}
                </button>
              </div>
            </div>}

            {note && <p style={{ fontSize: 13, color: 'var(--teal)' }}>{note}</p>}
            {error && <p className="error-text">{error}</p>}

            <button type="submit" className="btn-primary" disabled={loading} style={{ marginTop: 4 }}>
              {loading ? 'Загрузка...' : mode === 'login' ? 'Войти' : byRequest ? 'Продолжить' : 'Зарегистрироваться'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
