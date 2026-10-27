import { useEffect, useState } from 'react'
import LangPicker from '../components/LangPicker'
import { offerLangFrom, getLang, tr } from '../i18n'
import { signupOpen, requestSignup2, confirmSignupCode, signupMissing, tgStartLink, requestPasswordReset, confirmPasswordReset, loginHelpRequest } from '../lib/adminApi'
import { COUNTRY_NAMES, PHONE_COUNTRIES, phoneCountry, guessPhoneCountry, guessCountryName, nationalDigits, formatNational, fullPhone, phoneProblem, splitFullPhone } from '../lib/phoneCountries'
import { useAuth, googleEnabled } from '../context/AuthContext'
import { useNavigate } from 'react-router-dom'
import { pendingInvite } from '../lib/workplaces'
import { pendingRef, savePendingRef, clearPendingRef, refInfo, requestSignupRef } from '../lib/refLinks'
import { appVersionText } from '../lib/version'

const COUNTRIES = COUNTRY_NAMES

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
  const qs = (() => { try { return new URLSearchParams(window.location.search) } catch { return new URLSearchParams() } })()
  // пригласительная ссылка (/r/код → «Зарегистрироваться», или код от пригласившего в WhatsApp с &r=код)
  const [refCode] = useState(() => { const r = (qs.get('r') || '').replace(/[^0-9a-f]/gi, ''); if (r) savePendingRef(r); return r || pendingRef() })
  const [refI, setRefI] = useState(null)   // { kind, inviter, production_name } — действующая ссылка
  useEffect(() => {
    if (!refCode) return
    let alive = true
    refInfo(refCode).then(r => { if (!alive) return; if (r.data) setRefI(r.data); else if (!r.error) clearPendingRef() })
    return () => { alive = false }
  }, [refCode])
  const refBy = refI ? (refI.kind === 'client' ? refI.production_name : refI.inviter) || '' : ''
  const [mode, setMode] = useState(linkCode ? 'code' : qs.get('reg') ? 'register' : 'login')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const { signIn, signUp, signInWithGoogle, sendResetEmail } = useAuth()
  const navigate = useNavigate()
  // Способ входа: по номеру телефона (Telegram / WhatsApp) или по почте. Зарубежным Telegram и WhatsApp не нужны —
  // для языков Европы и дальнего зарубежья сразу открывается почта; выбор запоминается на этом устройстве.
  const [method, setMethodState] = useState(() => {
    try { const v = localStorage.getItem('authMethod'); if (v === 'email' || v === 'phone') return v } catch { /* без памяти */ }
    return ['ru', 'uk', 'kk', 'ky', 'uz', 'az'].includes(getLang()) ? 'phone' : 'email'
  })
  const setMethod = m => { setMethodState(m); setError(''); setNote(''); try { localStorage.setItem('authMethod', m) } catch { /* без памяти */ } }
  const [googleOn, setGoogleOn] = useState(false)
  useEffect(() => { let alive = true; googleEnabled().then(v => { if (alive) setGoogleOn(v) }); return () => { alive = false } }, [])

  const [showPass, setShowPass] = useState(false)
  const [form, setForm] = useState(() => ({
    full_name: '', phone: '', whatsapp: '', email: '', password: '', comment: '', code: linkCode.replace(/\D/g, '').slice(0, 8), country: (method === 'email' ? tr(guessCountryName()) : guessCountryName()) || (method === 'phone' ? phoneCountry(guessPhoneCountry()).name : ''), city: ''
  }))
  // Регистрация может быть закрыта: тогда новый человек оставляет заявку, а регистрируется после одобрения
  const [open, setOpen] = useState(true)
  const [approved, setApproved] = useState(false)   // заявка этого номера одобрена — можно задать пароль
  const [note, setNote] = useState('')
  useEffect(() => { let alive = true; signupOpen().then(v => { if (alive) setOpen(v) }); return () => { alive = false } }, [])
  const invite = pendingInvite()   // пришёл по ссылке-приглашению производства — регистрация сотрудника без заявки
  const byEmail = method === 'email' && !invite && mode !== 'code'   // вход / регистрация по почте (сотрудник по приглашению — только по номеру)
  // Регистрация (кроме приглашения производства) всегда идёт через подтверждение номера: при закрытой — по заявке,
  // при открытой — Telegram подтверждает номер и сразу присылает код, без администратора
  const byRequest = mode === 'register' && !approved && !invite && !byEmail
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

  // Вход по номеру: аккаунт записан полным номером с кодом страны (7701…). Человек мог ввести 8 701… или 701… —
  // пробуем и такие варианты, иначе зарегистрированный человек «не может войти»
  function loginEmails(phone) {
    const d = String(phone || '').replace(/\D/g, '')
    const out = [d]
    if (d.length === 11 && d[0] === '8') out.push('7' + d.slice(1))
    if (d.length === 10) out.push('7' + d)
    return [...new Set(out)].map(x => `${x}@raskoypro.local`)
  }
  async function signInAny(phone, password) {
    let last = null
    for (const em of loginEmails(phone)) {
      try { await signIn(em, password); return } catch (e) { last = e; if (!/Invalid login/i.test(String(e?.message || e))) throw e }
    }
    throw last || new Error('Invalid login credentials')
  }
  // «Не получается войти?» — сообщение мастер-аккаунту с этого номера (на экране входа, без аккаунта)
  const [help, setHelp] = useState(null)        // null | { name, text, sent }
  const [loginFails, setLoginFails] = useState(0)
  async function sendHelp() {
    setError('')
    const tel = mode === 'register' ? regPhone : form.phone
    if (String(tel || '').replace(/\D/g, '').length < 10) { setError('Введите номер телефона, с которым вы регистрировались или пытаетесь войти'); return }
    setLoading(true)
    const r = await loginHelpRequest(tel, help?.name || '', help?.text || '')
    setLoading(false)
    if (r.error) setError(r.error)
    else setHelp(h => ({ ...h, sent: true }))
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

  // приглашённый выбрал WhatsApp, но не хочет ждать код от пригласившего — переключаемся на Telegram (код придёт сам)
  async function toTelegram() {
    setError(''); setLoading(true)
    const r = await requestSignupRef(form.full_name, regPhone, form.comment, form.country.trim(), form.city.trim(), 'telegram', refCode)
    setLoading(false)
    if (r.error || r.missing) { setError(r.error || 'Не получилось — попробуйте ещё раз'); return }
    setMessenger('telegram'); setReq(r)
    setNote(r.verified ? 'Номер уже подтверждён в Telegram — код придёт туда. Введите его ниже и придумайте пароль.' : 'Нажмите кнопку ниже, затем «Поделиться номером» в боте — код придёт сразу.')
  }

  async function google() {
    setError(''); setLoading(true)
    try { await signInWithGoogle() } catch (err) { setError(err.message); setLoading(false) }
  }
  const emailOk = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim())

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      if (byEmail) {
        const em = form.email.trim().toLowerCase()
        if (!emailOk(em)) throw new Error('Проверьте адрес почты')
        if (/@raskoypro\.local$/.test(em)) throw new Error('Проверьте адрес почты')
        if (mode === 'forgot') {
          await sendResetEmail(em)
          setNote('Мы отправили письмо со ссылкой для смены пароля. Откройте его на этом устройстве. Письма нет — проверьте «Спам».')
          return
        }
        if (form.password.length < 6) throw new Error('Пароль минимум 6 символов')
        if (mode === 'login') { await signIn(em, form.password); navigate(pendingRef() ? `/r/${pendingRef()}` : '/'); return }
        if (!form.full_name.trim()) throw new Error('Введите имя и фамилию')
        if (form.country.trim().length < 2) throw new Error('Укажите страну')
        if (form.city.trim().length < 2) throw new Error('Укажите город')
        await signUp(em, form.password, { full_name: form.full_name.trim(), phone: '', country: form.country.trim(), city: form.city.trim() })
        navigate('/')
        return
      }
      if (mode === 'forgot') {
        if (!form.code.trim()) throw new Error('Введите код, который мы вам прислали')
        if (form.password.length < 6) throw new Error('Пароль минимум 6 символов')
        const r = await confirmPasswordReset(form.phone, form.code, form.password)
        if (r.error) throw new Error(r.error)
        await signInAny(form.phone, form.password)
      } else if (mode === 'code') {
        // «У меня есть код»: заявка одобрена, код пришёл в Telegram / WhatsApp — только номер, код и пароль
        setPhoneTouched(true)
        if (phoneErr) throw new Error(phoneErr)
        if (!form.code.trim()) throw new Error('Введите код из сообщения — 6 цифр')
        if (form.password.length < 6) throw new Error('Придумайте пароль — минимум 6 символов')
        const c = await confirmSignupCode(regPhone, form.code)
        if (c.error) throw new Error(c.error)
        // В заявке нет имени, страны или города — без них аккаунт не создаётся (migration_signup_required.sql):
        // переводим на полную форму, номер и код уже введены
        if (await signupMissing(regPhone)) {
          setReq({ status: 'approved' }); setApproved(true); setMode('register')
          setNote('Укажите имя и фамилию, страну и город — без них регистрация не завершится. Номер и код уже введены.')
          return
        }
        await signUp(phoneToEmail(regPhone), form.password, { full_name: '', phone: regPhone, country: '', city: '' })
      } else if (mode === 'login') {
        await signInAny(form.phone, form.password)
      } else {
        if (!form.full_name.trim()) throw new Error('Введите имя и фамилию')
        if (byRequest && !nameLooksReal(form.full_name)) throw new Error('Укажите настоящие имя и фамилию (например: Иван Петров) — заявки без имени не одобряются')
        setPhoneTouched(true)
        if (phoneErr) throw new Error(phoneErr)
        if (!invite && form.country.trim().length < 2) throw new Error('Укажите страну')
        if (!invite && form.city.trim().length < 2) throw new Error('Укажите город')
        if (byRequest) {
          let r = refI ? await requestSignupRef(form.full_name, regPhone, form.comment, form.country.trim(), form.city.trim(), messenger, refCode) : null
          if (!r || r.missing) r = await requestSignup2(form.full_name, regPhone, form.comment, form.country.trim(), form.city.trim(), messenger)
          if (r.error) throw new Error(r.error)
          const byRef = r.ref === 'ok'
          setReq(r)
          const tgMode = r.messenger === 'telegram'
          if (r.registered) setError('Этот номер уже зарегистрирован — войдите на вкладке «Вход». Не помните пароль — «Забыли пароль?» или напишите разработчику ниже.')
          else if (r.status === 'open' || (r.status === 'approved' && r.legacy)) { setApproved(true); setNote('Остался один шаг: придумайте пароль и нажмите «Зарегистрироваться».') }
          else if (r.status === 'approved') {
            setApproved(true)
            const pre = r.auto || byRef ? '' : 'Заявка одобрена. '   // открытая регистрация или ссылка-приглашение — одобрять нечего, сразу подтверждение номера
            setNote(r.code_issued || (byRef && tgMode && r.verified) ? `${pre}Введите код из ${tgMode && r.verified ? 'Telegram' : 'сообщения'} и придумайте пароль.`
              : tgMode && !r.verified ? `${pre}Подтвердите номер в Telegram: нажмите кнопку ниже, затем «Поделиться номером» — бот сразу пришлёт код.`
              : byRef ? `Код пришлёт в WhatsApp ${r.inviter || 'тот, кто вас пригласил'} — ему уже пришло уведомление. Введите код ниже и придумайте пароль. Не хотите ждать — нажмите «Получить код в Telegram»: он придёт сразу.`
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
        if (offerLangFrom([form.full_name, form.country, form.city].join(' '), pendingRef() ? `/r/${pendingRef()}` : '/')) return
      }
      navigate(pendingRef() ? `/r/${pendingRef()}` : '/')
    } catch (err) {
      const msg = String(err?.message || err)
      if (byEmail) {
        if (/Invalid login|banned/i.test(msg)) setError('Неверная почта или пароль.')
        else if (/already registered|already been registered/i.test(msg)) setError('Эта почта уже зарегистрирована — войдите на вкладке «Вход».')
        else if (/signup_closed|Database error saving new user|Signups not allowed/i.test(msg)) setError('Регистрация по почте сейчас закрыта. Попробуйте позже.')
        else if (/rate limit|too many/i.test(msg)) setError('Слишком много попыток — подождите немного и попробуйте снова.')
        else setError(msg)
        return
      }
      // закрытый вход (номер заблокирован мастером) — как обычный неверный пароль, без слов о блокировке
      const badLogin = /Invalid login|banned/i.test(msg)
      if (badLogin) setLoginFails(n => n + 1)
      if (badLogin) setError('Неверный телефон или пароль. Если вашу заявку одобрили и пришёл код, а пароль вы ещё не задавали — нажмите «У меня есть код».')
      else if (msg.includes('already registered')) setError('Этот номер уже зарегистрирован — войдите на вкладке «Вход». Не помните пароль — «Забыли пароль?» или напишите разработчику ниже.')
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
          {mode === 'code' ? 'Завершение регистрации' : mode === 'forgot' ? 'Восстановление пароля' : mode === 'login' ? 'Войдите в личный кабинет' : byRequest && !open && !refI ? 'Регистрация по заявке' : 'Создайте аккаунт'}
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
            {googleOn && !invite && (mode === 'login' || mode === 'register') && (
              <>
                <button type="button" onClick={google} disabled={loading}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, padding: '10px', borderRadius: 'var(--radius)', border: '1px solid var(--border-md)', background: 'var(--bg)', color: 'var(--text)', fontSize: 15, fontWeight: 500, cursor: 'pointer' }}>
                  <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
                  Продолжить с Google
                </button>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-hint)', fontSize: 12 }}>
                  <div style={{ flex: 1, height: 1, background: 'var(--border-md)' }} />или<div style={{ flex: 1, height: 1, background: 'var(--border-md)' }} />
                </div>
              </>
            )}
            {!invite && mode !== 'code' && (
              <div style={{ display: 'flex', gap: 6 }}>
                {[['email', '✉', 'Email'], ['phone', '📱', 'Телефон']].map(([k, ic, t]) => (
                  <button key={k} type="button" onClick={() => setMethod(k)}
                    style={{ flex: 1, padding: '7px', borderRadius: 'var(--radius)', fontSize: 13, cursor: 'pointer',
                      border: method === k ? '1.5px solid var(--blue)' : '0.5px solid var(--border-md)',
                      background: method === k ? 'var(--blue-light, var(--bg2))' : 'transparent',
                      color: method === k ? 'var(--blue)' : 'var(--text-muted)', fontWeight: method === k ? 600 : 400 }}><span>{ic}</span> <span>{t}</span></button>
                ))}
              </div>
            )}
            {byEmail && (
              <>
                {mode === 'register' && (
                  <div>
                    <label className="label">Имя и фамилия *</label>
                    <input type="text" autoComplete="name" placeholder="Jan Kowalski" value={form.full_name} onChange={e => set('full_name', e.target.value)} maxLength={120} required />
                  </div>
                )}
                <div>
                  <label className="label">Электронная почта *</label>
                  <input type="email" inputMode="email" autoComplete="email" placeholder="name@mail.com" value={form.email} onChange={e => set('email', e.target.value)} required />
                </div>
                {mode === 'register' && (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <label className="label">Страна *</label>
                      <input type="text" list="reg-countries-em" value={form.country} onChange={e => set('country', e.target.value)} maxLength={60} required />
                      <datalist id="reg-countries-em">{COUNTRIES.map(c => <option key={c} value={tr(c)} />)}</datalist>
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <label className="label">Город *</label>
                      <input type="text" value={form.city} onChange={e => set('city', e.target.value)} maxLength={80} required />
                    </div>
                  </div>
                )}
                {mode === 'forgot' ? (
                  <p style={{ fontSize: 12, color: 'var(--text-muted)', background: 'var(--bg2)', borderRadius: 'var(--radius)', padding: '8px 10px', margin: 0 }}>
                    Введите почту, с которой вы регистрировались, — пришлём ссылку для смены пароля.
                  </p>
                ) : (
                  <div>
                    <label className="label">Пароль *</label>
                    <div style={{ position: 'relative' }}>
                      <input type={showPass ? 'text' : 'password'} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} placeholder="Минимум 6 символов"
                        value={form.password} onChange={e => set('password', e.target.value)} required minLength={6} style={{ paddingRight: 44 }} />
                      <button type="button" onClick={() => setShowPass(v => !v)}
                        style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-hint)', fontSize: 18, lineHeight: 1, padding: 0 }}>
                        {showPass ? '🙈' : '👁'}
                      </button>
                    </div>
                  </div>
                )}
                {note && <p style={{ fontSize: 13, color: 'var(--teal)' }}>{note}</p>}
                {error && <p className="error-text">{error}</p>}
                <button type="submit" className="btn-primary" disabled={loading} style={{ marginTop: 4 }}>
                  {loading ? 'Загрузка...' : mode === 'forgot' ? 'Отправить ссылку' : mode === 'login' ? 'Войти' : 'Зарегистрироваться'}
                </button>
                {mode === 'login' && <button type="button" onClick={() => { setMode('forgot'); setError(''); setNote('') }}
                  style={{ background: 'none', border: 'none', color: 'var(--blue)', fontSize: 13, padding: 0, cursor: 'pointer' }}>Забыли пароль?</button>}
                {mode === 'forgot' && <button type="button" onClick={() => { setMode('login'); setError(''); setNote('') }}
                  style={{ background: 'none', border: 'none', color: 'var(--blue)', fontSize: 13, padding: 0, cursor: 'pointer' }}>← Вернуться ко входу</button>}
              </>
            )}
            {!byEmail && <>
            {refI && mode !== 'login' && mode !== 'forgot' && (
              <div style={{ border: '1px solid var(--teal)', borderRadius: 'var(--radius)', padding: '10px 12px', background: 'var(--bg2)' }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--teal)' }}>Приглашение{refBy ? ` от «${refBy}»` : ''}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                  Регистрация без ожидания одобрения — нужно только подтвердить номер телефона{refI.kind === 'production' ? '. Ваше производство подтвердится сразу' : ''}.
                </div>
              </div>
            )}
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
                {refI
                  ? <>Подтвердим номер телефона: через Telegram — сразу, в один тап; через WhatsApp — код пришлёт {refBy ? `«${refBy}»` : 'тот, кто вас пригласил'}. Потом — пароль.</>
                  : open
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
                  <p style={{ fontSize: 11, marginTop: 3, color: 'var(--text-hint)' }}>Выберите из списка или впишите свою</p>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <label className="label">Город *</label>
                  <input type="text" placeholder="Алматы" value={form.city} onChange={e => set('city', e.target.value)} maxLength={80} required={!invite} />
                </div>
              </div>
            )}
            {byRequest && !open && !refI && (
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
                  {[['telegram', 'Telegram', open ? 'сразу — номер подтверждается в 1 тап, код приходит сам' : 'быстро — номер подтверждается в 1 тап, код приходит сам'], ['whatsapp', 'WhatsApp', refI ? 'код пришлёт тот, кто вас пригласил' : open ? 'код пришлёт администратор — придётся подождать' : 'код пришлёт администратор после одобрения']].map(([k, title, sub]) => (
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
            {mode === 'register' && refI && req?.ref === 'ok' && req.messenger === 'whatsapp' && !req.registered && (
              <button type="button" className="btn-primary" disabled={loading} style={{ background: '#229ED9' }} onClick={toTelegram}>📱 Получить код в Telegram</button>
            )}
            {error && <p className="error-text">{error}</p>}

            <button type="submit" className="btn-primary" disabled={loading} style={{ marginTop: 4 }}>
              {loading ? 'Загрузка...' : mode === 'forgot' ? 'Сменить пароль и войти' : mode === 'login' ? 'Войти' : byRequest ? 'Продолжить' : 'Зарегистрироваться'}
            </button>
            {mode === 'login' && <button type="button" onClick={() => { setMode('forgot'); setError(''); setNote('') }}
              style={{ background: 'none', border: 'none', color: 'var(--blue)', fontSize: 13, padding: 0, cursor: 'pointer' }}>Забыли пароль?</button>}
            {/* Не получается войти или зарегистрироваться — написать разработчику прямо отсюда, с этого номера */}
            {(mode === 'login' || mode === 'register' || mode === 'forgot') && (
              <div style={{ border: `1px solid ${loginFails > 0 || /уже зарегистрирован/.test(error) ? 'var(--amber)' : 'var(--border-md)'}`, borderRadius: 'var(--radius)', padding: '10px 12px', marginTop: 4 }}>
                {help?.sent ? (
                  <p style={{ fontSize: 13, color: 'var(--teal)', margin: 0 }}>✓ Сообщение отправлено разработчику. Мы пришлём код в WhatsApp на этот номер — введите его в «Забыли пароль?» и придумайте новый пароль.</p>
                ) : help ? (
                  <>
                    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Написать разработчику</div>
                    <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 8px' }}>Номер телефона — тот, что вы ввели выше{mode === 'register' ? '' : ' (поле «Телефон»)'}. Ответ и код придут в WhatsApp.</p>
                    <input type="text" placeholder="Имя (необязательно)" value={help.name || ''} onChange={e => setHelp(h => ({ ...h, name: e.target.value }))} maxLength={120} style={{ marginBottom: 6 }} />
                    <textarea rows={2} placeholder="Что не получается? Например: зарегистрировался, а войти не могу" value={help.text || ''} onChange={e => setHelp(h => ({ ...h, text: e.target.value }))}
                      maxLength={1000} style={{ fontSize: 14, resize: 'vertical', width: '100%' }} />
                    <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                      <button type="button" className="btn-primary" disabled={loading} onClick={sendHelp} style={{ flex: 1 }}>Отправить</button>
                      <button type="button" className="btn-secondary" onClick={() => setHelp(null)}>Отмена</button>
                    </div>
                  </>
                ) : (
                  <>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>Не получается войти или зарегистрироваться?</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', margin: '2px 0 8px' }}>Напишите разработчику — он поможет и пришлёт код для входа в WhatsApp.</div>
                    <button type="button" className="btn-secondary" style={{ width: '100%', padding: 8 }}
                      onClick={() => setHelp({ name: form.full_name || '', text: '' })}>✉ Написать разработчику</button>
                  </>
                )}
              </div>
            )}
            {mode === 'code' && <button type="button" onClick={() => { setMode('register'); setError(''); setNote('') }}
              style={{ background: 'none', border: 'none', color: 'var(--blue)', fontSize: 13, padding: 0, cursor: 'pointer' }}>Кода нет — оставить заявку на регистрацию</button>}
            {mode === 'forgot' && <button type="button" onClick={() => { setMode('login'); setError(''); setNote('') }}
              style={{ background: 'none', border: 'none', color: 'var(--blue)', fontSize: 13, padding: 0, cursor: 'pointer' }}>← Вернуться ко входу</button>}
            </>}
          </div>
        </form>
      </div>
      <p style={{ fontSize: 11, color: 'var(--text-hint)', textAlign: 'center', margin: '4px 0 16px' }}>RaskroyPro · {appVersionText()}</p>
    </div>
  )
}
