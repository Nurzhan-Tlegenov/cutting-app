import { useState } from 'react'
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
    full_name: '', phone: '', whatsapp: '', password: ''
  })
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
        if (form.password.length < 6) throw new Error('Пароль минимум 6 символов')
        const email = phoneToEmail(form.phone)
        await signUp(email, form.password, {
          full_name: form.full_name,
          phone: form.phone,
          whatsapp: form.whatsapp
        })
      }
      navigate('/')
    } catch (err) {
      const msg = err.message
      if (msg.includes('Invalid login')) setError('Неверный телефон или пароль')
      else if (msg.includes('already registered')) setError('Этот номер уже зарегистрирован')
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
          {mode === 'login' ? 'Войдите в личный кабинет' : 'Создайте аккаунт'}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <form onSubmit={handleSubmit}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 20, background: 'var(--bg2)', borderRadius: 'var(--radius)', padding: 4 }}>
            {['login','register'].map(m => (
              <button key={m} type="button" onClick={() => { setMode(m); setError('') }}
                style={{ flex: 1, padding: '8px', border: 'none', borderRadius: 6,
                  background: mode === m ? 'var(--bg)' : 'transparent',
                  color: mode === m ? 'var(--blue)' : 'var(--text-hint)',
                  fontWeight: mode === m ? 500 : 400, fontSize: 14 }}>
                {m === 'login' ? 'Вход' : 'Регистрация'}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
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

            {mode === 'register' && (
              <div>
                <label className="label">WhatsApp (если отличается)</label>
                <input type="tel" placeholder="+7 700..." value={form.whatsapp}
                  onChange={e => set('whatsapp', e.target.value)} />
              </div>
            )}

            <div>
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
            </div>

            {error && <p className="error-text">{error}</p>}

            <button type="submit" className="btn-primary" disabled={loading} style={{ marginTop: 4 }}>
              {loading ? 'Загрузка...' : mode === 'login' ? 'Войти' : 'Зарегистрироваться'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
