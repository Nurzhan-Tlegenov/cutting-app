import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import AuthPage from '../pages/AuthPage'

// Остановка приложения мастер-аккаунтом (migration_app_stop.sql). Пока остановлено, у всех, кроме мастер-аккаунта,
// вместо приложения — «зависшая» заставка с логотипом, как при загрузке. Внизу — тихая ссылка «Написать разработчику».
// Мастер-аккаунт работает как обычно; войти им на новом устройстве — 5 раз нажать на логотип.
const KEY = 'appStopped'
const readCached = () => { try { return localStorage.getItem(KEY) === '1' } catch { return false } }
async function fetchStopped() {
  try {
    const { data, error } = await supabase.rpc('app_stopped')
    if (error) return false                 // функции ещё нет в базе — приложение работает как обычно
    return data === true
  } catch { return null }                   // нет сети — оставляем, что было
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAppStopped() {
  const [stopped, setStopped] = useState(readCached)
  useEffect(() => {
    let alive = true
    const check = () => fetchStopped().then(v => {
      if (!alive || v === null) return
      setStopped(v)
      try { localStorage.setItem(KEY, v ? '1' : '0') } catch { /* без памяти */ }
    })
    check()
    const t = setInterval(check, 60000)
    const vis = () => { if (document.visibilityState === 'visible') check() }
    document.addEventListener('visibilitychange', vis)
    window.addEventListener('app-stop-changed', check)
    return () => { alive = false; clearInterval(t); document.removeEventListener('visibilitychange', vis); window.removeEventListener('app-stop-changed', check) }
  }, [])
  return stopped
}

export default function StopGate({ children }) {
  const { loading, isMaster, user } = useAuth()
  const stopped = useAppStopped()
  const [login, setLogin] = useState(false)
  if (!stopped || isMaster) return children
  if (loading) return children                 // пока неизвестно, кто вошёл, — обычная загрузка
  if (login && !user) return <AuthPage />
  return <StopScreen onLogin={() => setLogin(true)} />
}

function StopScreen({ onLogin }) {
  const { user, profile } = useAuth()
  const taps = useRef({ n: 0, t: 0 })
  const [form, setForm] = useState(false)
  const [name, setName] = useState(profile?.full_name || '')
  const [phone, setPhone] = useState(profile?.phone || '')
  const [text, setText] = useState('')
  const [state, setState] = useState('')       // '' | 'sending' | 'sent' | текст ошибки
  useEffect(() => {
    supabase.rpc('stop_ping', { p_path: location.pathname, p_ua: navigator.userAgent }).then(() => {}, () => {})
  }, [user?.id])
  const tapLogo = () => {
    const now = Date.now(), t = taps.current
    t.n = now - t.t < 800 ? t.n + 1 : 1; t.t = now
    if (t.n >= 5 && !user) { t.n = 0; onLogin() }
  }
  const send = async () => {
    if (!text.trim()) return
    setState('sending')
    const { error } = await supabase.rpc('stop_message', { p_name: name, p_phone: phone, p_text: text })
    setState(error ? (/too many/.test(error.message) ? 'Сообщение уже отправлено, попробуйте позже' : 'Не удалось отправить, попробуйте ещё раз') : 'sent')
  }
  const inp = { width: '100%', boxSizing: 'border-box', padding: '9px 10px', fontSize: 15, border: '1px solid #ddd', borderRadius: 10, fontFamily: 'inherit' }
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, background: '#fff',
      fontFamily: 'system-ui,-apple-system,Segoe UI,Roboto,sans-serif', padding: 16, zIndex: 5000 }}>
      <img src="/app-icon.svg" alt="" onClick={tapLogo} style={{ width: 'min(46vw,220px)', height: 'auto', userSelect: 'none' }} draggable={false} />
      <div style={{ fontSize: 22, fontWeight: 600, color: '#009BDE' }}>RaskroyPro</div>
      <div style={{ fontSize: 14, color: '#888' }}>Загрузка…</div>
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 18, display: 'flex', justifyContent: 'center', padding: '0 16px' }}>
        {!form ? (
          <button type="button" onClick={() => setForm(true)} style={{ border: 'none', background: 'transparent', color: '#aaa', fontSize: 13, textDecoration: 'underline', cursor: 'pointer' }}>
            Написать разработчику
          </button>
        ) : state === 'sent' ? (
          <div style={{ fontSize: 14, color: '#1F7A38', textAlign: 'center' }}>Сообщение отправлено разработчику. Спасибо!</div>
        ) : (
          <div style={{ width: '100%', maxWidth: 420, display: 'flex', flexDirection: 'column', gap: 8, background: '#fff', border: '1px solid #eee', borderRadius: 14, padding: 12, boxShadow: '0 6px 24px rgba(0,0,0,.08)' }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#333' }}>Сообщение разработчику</div>
            {!user && <input style={inp} value={name} onChange={e => setName(e.target.value)} placeholder="Ваше имя" />}
            {!user && <input style={inp} value={phone} onChange={e => setPhone(e.target.value)} placeholder="Телефон для ответа" inputMode="tel" />}
            <textarea style={{ ...inp, minHeight: 90, resize: 'vertical' }} value={text} onChange={e => setText(e.target.value)} placeholder="Что случилось? Что вы хотели сделать?" />
            {state && state !== 'sending' && <div style={{ fontSize: 12, color: '#b45309' }}>{state}</div>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" onClick={() => setForm(false)} style={{ flex: 1, padding: 10, borderRadius: 10, border: '1px solid #ddd', background: '#fff', fontSize: 14, cursor: 'pointer' }}>Отмена</button>
              <button type="button" disabled={!text.trim() || state === 'sending'} onClick={send}
                style={{ flex: 2, padding: 10, borderRadius: 10, border: 'none', background: '#009BDE', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer', opacity: !text.trim() ? 0.6 : 1 }}>
                {state === 'sending' ? 'Отправляем…' : 'Отправить'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
