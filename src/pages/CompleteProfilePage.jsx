import { useState } from 'react'
import LangPicker from '../components/LangPicker'
import { useAuth } from '../context/AuthContext'
import { nameOk, phoneOk } from '../lib/profileRules'
import { COUNTRY_NAMES, guessCountryName } from '../lib/phoneCountries'
import { tr } from '../i18n'

// Аккаунт по почте (email или Google): имени, страны и города при входе ещё нет — спрашиваем один раз, до работы в приложении.
// Производству они нужны, чтобы понимать, чей заказ и откуда; телефон — по желанию (для связи по заказу).
export function CompleteProfilePage() {
  const { user, profile, completeProfile, signOut } = useAuth()
  const meta = user?.user_metadata || {}
  const [form, setForm] = useState(() => ({
    full_name: String(profile?.full_name || meta.full_name || meta.name || '').trim(),
    country: String(profile?.country || meta.country || tr(guessCountryName()) || '').trim(),
    city: String(profile?.city || meta.city || '').trim(),
    phone: String(profile?.phone || '').trim(),
  }))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  async function save(e) {
    e.preventDefault()
    setError('')
    if (!nameOk(form.full_name)) { setError('Введите имя и фамилию полностью — например, Иван Петров'); return }
    if (form.country.trim().length < 2) { setError('Укажите страну'); return }
    if (form.city.trim().length < 2) { setError('Укажите город'); return }
    if (!phoneOk(form.phone)) { setError('Укажите номер телефона с кодом страны — например, +7 701 000 00 00'); return }
    setBusy(true)
    try { await completeProfile(form) } catch (err) { setError(String(err?.message || err)) } finally { setBusy(false) }
  }

  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', paddingTop: 48, maxWidth: 480, margin: '0 auto' }}>
      <LangPicker style={{ maxWidth: 220, margin: '0 auto 16px' }} />
      <div style={{ marginBottom: 24, textAlign: 'center' }}>
        <div style={{ fontSize: 28, fontWeight: 600, color: 'var(--blue)', marginBottom: 4 }}>РаскройPro</div>
        <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>Почти готово — расскажите о себе</div>
      </div>
      <div className="card">
        <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>Вход: {user?.email}</p>
          <div>
            <label className="label">Имя и фамилия *</label>
            <p style={{ fontSize: 11, color: 'var(--text-hint)', margin: '-2px 0 4px' }}>Полностью, как вас зовут — их видят производство и заказчики.</p>
            <input type="text" autoComplete="name" value={form.full_name} onChange={e => set('full_name', e.target.value)} maxLength={120} required />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <label className="label">Страна *</label>
              <input type="text" list="cp-countries" value={form.country} onChange={e => set('country', e.target.value)} maxLength={60} required />
              <datalist id="cp-countries">{COUNTRY_NAMES.map(c => <option key={c} value={tr(c)} />)}</datalist>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <label className="label">Город *</label>
              <input type="text" value={form.city} onChange={e => set('city', e.target.value)} maxLength={80} required />
            </div>
          </div>
          <div>
            <label className="label">Телефон *</label>
            <input type="tel" autoComplete="tel" placeholder="+7 701 000 00 00" value={form.phone} onChange={e => set('phone', e.target.value)} maxLength={40} required />
            <p style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 3 }}>Чтобы производство и поддержка РаскройPro могли связаться с вами. В РаскройPro все знают, с кем работают.</p>
          </div>
          {error && <p className="error-text">{error}</p>}
          <button type="submit" className="btn-primary" disabled={busy}>{busy ? 'Загрузка...' : 'Продолжить'}</button>
          <button type="button" onClick={signOut} style={{ background: 'none', border: 'none', color: 'var(--text-hint)', fontSize: 13, cursor: 'pointer' }}>Выйти</button>
        </form>
      </div>
    </div>
  )
}

// Открыли ссылку «сменить пароль» из письма — вход уже есть, задаём новый пароль
export function NewPasswordPage() {
  const { setNewPassword } = useAuth()
  const [pass, setPass] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function save(e) {
    e.preventDefault()
    setError('')
    if (pass.length < 6) { setError('Пароль минимум 6 символов'); return }
    setBusy(true)
    try { await setNewPassword(pass) } catch (err) { setError(String(err?.message || err)) } finally { setBusy(false) }
  }
  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', paddingTop: 48, maxWidth: 480, margin: '0 auto' }}>
      <div style={{ marginBottom: 24, textAlign: 'center' }}>
        <div style={{ fontSize: 28, fontWeight: 600, color: 'var(--blue)', marginBottom: 4 }}>РаскройPro</div>
        <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>Восстановление пароля</div>
      </div>
      <div className="card">
        <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label className="label">Новый пароль *</label>
            <input type="password" autoComplete="new-password" placeholder="Минимум 6 символов" value={pass} onChange={e => setPass(e.target.value)} minLength={6} required />
          </div>
          {error && <p className="error-text">{error}</p>}
          <button type="submit" className="btn-primary" disabled={busy}>{busy ? 'Загрузка...' : 'Сохранить пароль'}</button>
        </form>
      </div>
    </div>
  )
}
