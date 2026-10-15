import { useEffect, useState } from 'react'
import LangPicker from '../components/LangPicker'
import { offerLangFrom } from '../i18n'
import { signupOpen, requestSignup2, confirmSignupCode, tgStartLink, requestPasswordReset, confirmPasswordReset } from '../lib/adminApi'
import { PHONE_COUNTRIES, phoneCountry, guessPhoneCountry, nationalDigits, formatNational, fullPhone, phoneProblem, splitFullPhone } from '../lib/phoneCountries'
import { useAuth } from '../context/AuthContext'
import { useNavigate } from 'react-router-dom'
import { pendingInvite } from '../lib/workplaces'

const COUNTRIES = ['Казахстан', 'Россия', 'Узбекистан', 'Кыргызстан', 'Беларусь', 'Таджикистан', 'Азербайджан', 'Армения', 'Грузия', 'Туркменистан']

// Имя и фамилия похожи на настоящие (как name_looks_real в migration_signup_resubmit.sql):
// два слова от 2 букв, без цифр, «тест», «test» и одинаковых слов; одно слово — только у имён без латиницы и кириллицы
function nameLooksReal(v) {
  const s = String(v || '').trim().toLowerCase()
  const w = s.split(/\s+/).filter(Boolean)
  if (w.some(x => /^(тест|test|qwe|qwerty|asd|йцу|йцукен|фыв|xxx|ххх)$/.test(x.replace(/[\p{P}\p{S}]/gu, '')))) return false
  if (w.some(x => /\d/.test(x))) return false
  const n = w.filter(x => x.replace(/[\p{P}\p{S}]/gu, '').length >= 2).length
  if (n < 2 && (n < 1 || /[a-zа-яё]/.test(s))) return false
  if (w.length === 2 && w[0] === w[1]) return false
  return true
}

export default function AuthPage() {
  // ссылка из сообщения с кодом (бот / WhatsApp): /auth?code=123456&tel=77011234567 — сразу экран «У меня есть код»
  const linkCode = (() => { try { return new URLSearchParams(window.location.search).get('code') || '' } catch { return '' } })()
  const linkTel = (() => { try { return (new URLSearchParams(window.location.search).get('tel') || '').replace(/\D/g, '') } catch { return '' } })()
  const [mode, setMode] = useState(linkCode ? 'code' : 'login')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const { signIn, signUp } = useAuth()
  const navigate = useNavigate()

  const [showPass, setShowPass] = useState(false)
  const [form, setForm] = useState(() => ({
    full_name: '', phone: '', whatsapp: '', email: '', password: '', comment: '', code: linkCode.replace(/\D/g, '').slice(0, 8), country: phoneCountry(guessPhoneCountry()).name, city: ''
  }))
  // Регистрация может быть закрыта: тогда новый человек оставляет заявку, а регистрируется после одобрения
  const [open, setOpen] = useState(true)
  const [approved, setApproved] = useState(false)   // заявка этого номера одобрена — можно задать пароль
  const [note, setNote] = useState('')
  useEffect(() => { let alive = true; signupOpen().then(v => { if (alive) setOpen(v) }); return () => { alive = false } }, [])
  const invite = pendingInvite()   // пришёл по ссылке-приглашению производства — регистрация сотрудника без заявки
  // Регистрация (кроме приглашения производства) всегда идёт через подтверждение номера: при закрытой — по заявке,
  // при открытой — Telegram подтверждает номер и сразу присылает код, без администратора
  const byRequest = mode === 'register' && !approved && !invite
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  // Номер при регистрации: страна (код) + номер нужной длины — номер с недостающей цифрой не уйдёт
  const [pcIso, setPcIso] = useState(() => (linkTel ? splitFullPhone(linkTel, guessPhoneCountry()).iso : guessPhoneCountry()))
  const pc = phoneCountry(pcIso)
  const [national, setNational] = useState(() => (linkTel ? splitFullPhone(linkTel, guessPhoneCountry()).national : ''))
  const [otherDial, setOtherDial] = useState('')
  const regPhone = fullPhone(pc, national, otherDial)
  const phoneErr = phoneProblem(pc, national, otherDial)
  const [phoneTouched, setPhoneTouched] = useState(false)
  // номер изменили — прежний ответ на заявку относится к другому номеру
  const phoneChanged = () => { setReq(null); setApproved(false); setNote('') }
  const pickCountry = iso => {
    const c = phoneCountry(iso)
    setPcIso(iso); setNational(n => nationalDigits(n, c)); phoneChanged()
    // страна проживания по умолчанию — страна номера (если человек не вписал свою)
    if (c.iso !== 'OTHER') setForm(f => (!f.country.trim() || PHONE_COUNTRIES.some(x => x.name === f.country) ? { ...f, country: c.name } : f))
  }
  // Куда прислать код: Telegram (бот подтверждает номер сразу) или WhatsApp (код пришлёт администратор)
  const [messenger, setMessenger] = useState('telegram')
  const [req, setReq] = useState(null)   // ответ на заявку: статус, метка для бота, подтверждён ли номер, выдан ли код
  const needCode = approved && req && req.status === 'approved' && !req.legacy

  // Генерируем фейковый email из номера телефона
  function phoneToEmail(phone) {
    const digits = phone.replace(/\D/g, '')
    return `${digits}@raskoypro.local`
  }

  // «Забыли пароль?»: человек просит код, администратор сообщает его (WhatsApp), здесь вводится код и новый пароль
  async function askCode() {
    setError(''); setNote('')
    if (form.phone.replace(/\D/g, '').length < 10) { setError('Введите номер телефона, с которым вы регистрировались'); return }
    setLoading(true)
    const r = await requestPasswordReset(form.phone)
    setLoading(false)
    if (r.error) setError(r.error)
    else setNote('Запрос отправлен. Мы пришлём вам код (обычно в WhatsApp) — введите его ниже вместе с новым паролем.')
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      if (mode === 'forgot') {
        if (!form.code.trim()) throw new Error('Введите код, который мы вам прислали')
        if (form.password.length < 6) throw new Error('Пароль минимум 6 символов')
        const r = await confirmPasswordReset(form.phone, form.code, form.password)
        if (r.error) throw new Error(r.error)
        await signIn(phoneToEmail(form.phone), form.password)
      } else if (mode === 'code') {
        // «У меня есть код»: заявка одобрена, код пришёл в Telegram / WhatsApp — только номер, код и пароль
        setPhoneTouched(true)
        if (phoneErr) throw new Error(phoneErr)
        if (!form.code.trim()) throw new Error('Введите код из сообщения — 6 цифр')
        if (form.password.length < 6) throw new Error('Придумайте пароль — минимум 6 символов')
        const c = await confirmSignupCode(regPhone, form.code)
        if (c.error) throw new Error(c.error)
        await signUp(phoneToEmail(regPhone), form.password, { full_name: '', phone: regPhone, country: '', city: '' })
      } else if (mode === 'login') {
        const email = phoneToEmail(form.phone)
        await signIn(email, form.password)
      } else {
        if (!form.full_name.trim()) throw new Error('Введите имя и фамилию')
        if (byRequest && !nameLooksReal(form.full_name)) throw new Error('Укажите настоящие имя и фамилию (например: Иван Петров) — заявки без имени не одобряются')
        setPhoneTouched(true)
        if (phoneErr) throw new Error(phoneErr)
        if (!invite && form.country.trim().length < 2) throw new Error('Укажите страну')
        if (!invite && form.city.trim().length < 2) throw new Error('Укажите город')
        if (byRequest) {
          const r = await requestSignup2(form.full_name, regPhone, form.comment, form.country.trim(), form.city.trim(), messenger)
          if (r.error) throw new Error(r.error)
          setReq(r)
          const tgMode = r.messenger === 'telegram'
          if (r.registered) setError('Этот номер уже зарегистрирован — войдите на вкладке «Вход».')
          else if (r.status === 'open' || (r.status === 'approved' && r.legacy)) { setApproved(true); setNote('Остался один шаг: придумайте пароль и нажмите «Зарегистрироваться».') }
          else if (r.status === 'approved') {
            setApproved(true)
            const pre = r.auto ? '' : 'Заявка одобрена. '   // открытая регистрация — одобрять нечего, сразу подтверждение номера
            setNote(r.code_issued ? `${pre}Введите код из ${tgMode && r.verified ? 'Telegram' : 'сообщения'} и придумайте пароль.`
              : tgMode && !r.verified ? `${pre}Подтвердите номер в Telegram: нажмите кнопку ниже, затем «Поделиться номером» — бот сразу пришлёт код.`
              : `${pre}Код ещё не отправлен — дождитесь сообщения от администратора.`)
          }
          else if (r.status === 'rejected') setError(
            r.resubmit === 'same_name' ? 'Заявка для этого номера была отклонена. Чтобы подать её повторно, укажите настоящие имя и фамилию — не те, что в прошлой заявке.'
            : r.resubmit === 'bad_name' ? 'Заявка для этого номера была отклонена. Укажите настоящие имя и фамилию и отправьте заявку ещё раз.'
            : r.resubmit === 'limit' ? 'Заявка для этого номера отклонена несколько раз. Свяжитесь с нами.'
            : 'Заявка для этого номера отклонена. Исправьте данные (имя и фамилия, страна, город) и отправьте заявку ещё раз.')
          else if (r.resubmit === 'ok' && tgMode && r.verified) setNote('Повторная заявка отправлена, номер подтверждён ✓. Как только её одобрят, код для регистрации придёт в Telegram.')
          else if (r.resubmit === 'ok' && !tgMode) setNote('Повторная заявка отправлена. После одобрения администратор пришлёт код в WhatsApp.')
          else if (tgMode && !r.verified) setNote('Заявка отправлена. Остался один шаг: подтвердите номер в Telegram — нажмите кнопку ниже, затем «Поделиться номером» в боте. Код для регистрации придёт туда же после одобрения.')
          else if (tgMode) setNote('Заявка отправлена, номер подтверждён ✓. Как только заявку одобрят, код для регистрации придёт в Telegram.')
          else setNote('Заявка отправлена. После одобрения администратор пришлёт код в WhatsApp — откройте «Регистрация», введите этот же номер и код.')
          // написал на своём языке (имя, страна, город) — предложить переключить приложение на него
          if (r.status !== 'approved' && r.status !== 'open') offerLangFrom([form.full_name, form.country, form.city, form.comment].join(' '))
          return
        }
        if (form.password.length < 6) throw new Error('Пароль минимум 6 символов')
        if (needCode) {
          if (!form.code.trim()) throw new Error('Введите код из сообщения')
          const c = await confirmSignupCode(regPhone, form.code)
          if (c.error) throw new Error(c.error)
        }
        if (form.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) throw new Error('Проверьте адрес почты — или оставьте поле пустым')
        const email = phoneToEmail(regPhone)
        await signUp(email, form.password, {
          full_name: form.full_name,
          phone: regPhone,
          whatsapp: form.whatsapp,
          country: form.country.trim(), city: form.city.trim(),
          contact_email: form.email,
          invite
        })
        if (offerLangFrom([form.full_name, form.country, form.city].join(' '), '/')) return
      }
      navigate('/')
    } catch (err) {
      const msg = err.message
      if (msg.includes('Invalid login')) setError('Неверный телефон или пароль. Если вашу заявку одобрили и пришёл код, а пароль вы ещё не задавали — нажмите «У меня есть код».')
      else if (msg.includes('already registered')) setError('Этот номер уже зарегистрирован')
      else if (/signup_closed|Database error saving new user|Signups not allowed/i.test(msg)) { setOpen(false); setApproved(false); setError('Регистрация сейчас только по запросу. Оставьте заявку.') }
      else setError(msg)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', paddingTop: 48 }}>
      <LangPicker style={{ maxWidth: 220, margin: '0 auto 16px' }} />
      <div style={{ marginBottom: 32, textAlign: 'center' }}>
        <div style={{ fontSize: 28, fontWeight: 600, color: 'var(--blue)', marginBottom: 4 }}>РаскройPro</div>
        <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>
          {mode === 'code' ? 'Завершение регистрации' : mode === 'forgot' ? 'Восстановление пароля' : mode === 'login' ? 'Войдите в личный кабинет' : byRequest && !open ? 'Регистрация по заявке' : 'Создайте аккаунт'}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <form onSubmit={handleSubmit}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 20, background: 'var(--bg2)', borderRadius: 'var(--radius)', padding: 4 }}>
            {['login','register'].map(m => (
              <button key={m} type="button" onClick={() => { setMode(m); setError(''); setNote('') }}
                style={{ flex: 1, padding: '8px', border: 'none', borderRadius: 6,
                  background: (mode === 'forgot' ? 'login' : mode === 'code' ? 'register' : mode) === m ? 'var(--bg)' : 'transparent',
                  color: (mode === 'forgot' ? 'login' : mode === 'code' ? 'register' : mode) === m ? 'var(--blue)' : 'var(--text-hint)',
                  fontWeight: (mode === 'forgot' ? 'login' : mode === 'code' ? 'register' : mode) === m ? 500 : 400, fontSize: 14 }}>
                {m === 'login' ? 'Вход' : 'Регистрация'}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* пришёл код в Telegram / WhatsApp — сразу сюда, без повторной заявки */}
            {(mode === 'login' || (mode === 'register' && !approved && !invite)) && (
              <div style={{ border: '1px solid var(--blue)', borderRadius: 'var(--radius)', padding: '10px 12px', background: 'var(--blue-light, var(--bg2))' }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--blue)' }}>Пришёл код в Telegram или WhatsApp?</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', margin: '2px 0 8px' }}>
                  {mode === 'register' ? 'Тогда заявку заполнять не нужно — введите номер, код и придумайте пароль. Кода нет — заполните заявку ниже.' : 'Ваша заявка одобрена — введите номер, код и придумайте пароль.'}
                </div>
                <button type="button" className="btn-primary" style={{ width: '100%', padding: '8px' }} onClick={() => { setMode('code'); setError(''); setNote('') }}>У меня есть код</button>
              </div>
            )}
            {mode === 'code' && (
              <p style={{ fontSize: 12, color: 'var(--text-muted)', background: 'var(--bg2)', borderRadius: 'var(--radius)', padding: '8px 10px' }}>
                Введите <b>тот же номер</b>, что в заявке, <b>код из сообщения</b> (6 цифр) и <b>придумайте пароль</b> — им вы будете входить в приложение.
              </p>
            )}
            {byRequest && (
              <p style={{ fontSize: 12, color: 'var(--text-muted)', background: 'var(--bg2)', borderRadius: 'var(--radius)', padding: '8px 10px' }}>
                {open
                  ? <>Сначала подтвердим номер телефона: через Telegram — сразу, в один тап; через WhatsApp — код пришлёт администратор. Потом — пароль.</>
                  : <>Регистрация сейчас по запросу. <b>Заявка уже одобрена?</b> Введите имя и тот же номер телефона, нажмите «Продолжить» — и откроется ввод кода и пароля.
                    Заявки ещё не было — она отправится этим же шагом, и мы с вами свяжемся.</>}
              </p>
            )}
            {mode === 'register' && (
              <div>
                <label className="label">Имя и фамилия *</label>
                <input type="text" placeholder="Иван Иванов" value={form.full_name}
                  onChange={e => set('full_name', e.target.value)} required />
              </div>
            )}

            {mode === 'register' || mode === 'code' ? (
              <div>
                <label className="label">Телефон * (используется для входа)</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <select value={pcIso} onChange={e => pickCountry(e.target.value)}
                    style={{ width: pc.dial ? 104 : 150, flexShrink: 0 }} aria-label="Код страны">
                    {PHONE_COUNTRIES.map(c => <option key={c.iso} value={c.iso}>{c.dial ? `${c.iso} +${c.dial}` : c.name}</option>)}
                  </select>
                  {!pc.dial && <input type="tel" inputMode="numeric" placeholder="+код" value={otherDial ? '+' + otherDial : ''} style={{ width: 70, flexShrink: 0 }}
                    onChange={e => { setOtherDial(e.target.value.replace(/\D/g, '').slice(0, 4)); phoneChanged() }} aria-label="Код страны" />}
                  <input type="tel" inputMode="numeric" autoComplete="tel-national" placeholder={pc.mask} value={formatNational(national, pc)}
                    onChange={e => { setNational(nationalDigits(e.target.value, pc)); phoneChanged() }} onBlur={() => national && setPhoneTouched(true)}
                    style={{ flex: 1, minWidth: 0, borderColor: phoneTouched && phoneErr ? 'var(--danger)' : undefined }} required />
                </div>
                <p style={{ fontSize: 11, marginTop: 3, color: phoneTouched && phoneErr ? 'var(--danger)' : 'var(--text-hint)' }}>
                  {phoneTouched && phoneErr ? phoneErr : !phoneErr ? `✓ ${regPhone}` : `${pc.name}: ${pc.len[0] === pc.len[1] ? pc.len[0] : `${pc.len[0]}–${pc.len[1]}`} цифр после +${pc.dial || otherDial || '…'}`}
                </p>
              </div>
            ) : (
              <div>
                <label className="label">Телефон * (используется для входа)</label>
                <input type="tel" placeholder="+7 700 000 00 00" value={form.phone}
                  onChange={e => set('phone', e.target.value)} required />
              </div>
            )}

            {mode === 'register' && (
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <label className="label">Страна *</label>
                  <input type="text" list="reg-countries" placeholder="Казахстан" value={form.country} onChange={e => set('country', e.target.value)} maxLength={60} required={!invite} />
                  <datalist id="reg-countries">{COUNTRIES.map(c => <option key={c} value={c} />)}</datalist>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <label className="label">Город *</label>
                  <input type="text" placeholder="Алматы" value={form.city} onChange={e => set('city', e.target.value)} maxLength={80} required={!invite} />
                </div>
              </div>
            )}
            {byRequest && !open && (
              <div>
                <label className="label">Комментарий (кто вы, чем занимаетесь)</label>
                <input type="text" placeholder="Мебельный цех, город…" value={form.comment}
                  onChange={e => set('comment', e.target.value)} maxLength={300} />
              </div>
            )}
            {byRequest && (
              <div>
                <label className="label">Куда прислать код подтверждения</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  {[['telegram', 'Telegram', open ? 'сразу — номер подтверждается в 1 тап, код приходит сам' : 'быстро — номер подтверждается в 1 тап, код приходит сам'], ['whatsapp', 'WhatsApp', open ? 'код пришлёт администратор — придётся подождать' : 'код пришлёт администратор после одобрения']].map(([k, title, sub]) => (
                    <button key={k} type="button" onClick={() => setMessenger(k)}
                      style={{ flex: 1, textAlign: 'left', padding: '10px 10px 8px', borderRadius: 'var(--radius)', cursor: 'pointer', position: 'relative',
                        border: messenger === k ? '1.5px solid var(--blue)' : '0.5px solid var(--border-md)', background: messenger === k ? 'var(--blue-light, var(--bg2))' : 'transparent' }}>
                      {k === 'telegram' && <span style={{ position: 'absolute', top: -8, right: 8, fontSize: 10, background: 'var(--teal)', color: 'white', borderRadius: 10, padding: '1px 7px' }}>рекомендуем</span>}
                      <div style={{ fontSize: 14, fontWeight: 600, color: messenger === k ? 'var(--blue)' : 'var(--text)' }}>{messenger === k ? '● ' : '○ '}{title}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 2, lineHeight: 1.3 }}>{sub}</div>
                    </button>
                  ))}
                </div>
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

            {mode === 'forgot' && (
              <>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', background: 'var(--bg2)', borderRadius: 'var(--radius)', padding: '8px 10px' }}>
                  Введите номер телефона и нажмите «Запросить код». Мы пришлём код — впишите его и придумайте новый пароль.
                </p>
                <button type="button" className="btn-secondary" disabled={loading} onClick={askCode}>Запросить код</button>
                <div>
                  <label className="label">Код *</label>
                  <input type="text" inputMode="numeric" autoComplete="one-time-code" placeholder="6 цифр" maxLength={8} value={form.code}
                    onChange={e => set('code', e.target.value.replace(/\D/g, ''))} />
                </div>
              </>
            )}

            {mode === 'register' && needCode && (
              <div>
                <label className="label">Код из {req.messenger === 'telegram' && req.verified ? 'Telegram' : 'сообщения'} *</label>
                <input type="text" inputMode="numeric" autoComplete="one-time-code" placeholder="6 цифр" maxLength={8} value={form.code}
                  onChange={e => set('code', e.target.value.replace(/\D/g, ''))} />
              </div>
            )}

            {mode === 'code' && (
              <div>
                <label className="label">Код из сообщения *</label>
                <input type="text" inputMode="numeric" autoComplete="one-time-code" placeholder="6 цифр" maxLength={8} value={form.code}
                  onChange={e => set('code', e.target.value.replace(/\D/g, ''))} style={{ fontSize: 18, letterSpacing: 3 }} />
              </div>
            )}

            {!byRequest && <div>
              <label className="label">{mode === 'code' ? 'Придумайте пароль *' : mode === 'forgot' ? 'Новый пароль *' : 'Пароль *'}</label>
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
            {mode === 'register' && req?.tg_token && !req.verified && !req.registered && (
              <a href={tgStartLink(req.tg_token)} target="_blank" rel="noreferrer" className="btn-primary"
                style={{ display: 'block', textAlign: 'center', textDecoration: 'none', background: '#229ED9' }}>📱 Подтвердить номер в Telegram</a>
            )}
            {error && <p className="error-text">{error}</p>}

            <button type="submit" className="btn-primary" disabled={loading} style={{ marginTop: 4 }}>
              {loading ? 'Загрузка...' : mode === 'forgot' ? 'Сменить пароль и войти' : mode === 'login' ? 'Войти' : byRequest ? 'Продолжить' : 'Зарегистрироваться'}
            </button>
            {mode === 'login' && <button type="button" onClick={() => { setMode('forgot'); setError(''); setNote('') }}
              style={{ background: 'none', border: 'none', color: 'var(--blue)', fontSize: 13, padding: 0, cursor: 'pointer' }}>Забыли пароль?</button>}
            {mode === 'code' && <button type="button" onClick={() => { setMode('register'); setError(''); setNote('') }}
              style={{ background: 'none', border: 'none', color: 'var(--blue)', fontSize: 13, padding: 0, cursor: 'pointer' }}>Кода нет — оставить заявку на регистрацию</button>}
            {mode === 'forgot' && <button type="button" onClick={() => { setMode('login'); setError(''); setNote('') }}
              style={{ background: 'none', border: 'none', color: 'var(--blue)', fontSize: 13, padding: 0, cursor: 'pointer' }}>← Вернуться ко входу</button>}
          </div>
        </form>
      </div>
    </div>
  )
}
