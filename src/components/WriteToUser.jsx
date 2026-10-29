// Мастер-аккаунт пишет пользователю личное сообщение — откуда угодно, не уходя со страницы: «Пользователи и
// регистрация», «Постпроцессоры по запросу» (запросы, кому выдан, кто чем выпускает), после выдачи 🔑.
// Сообщение приходит пользователю в «Сообщения» (как ответ мастера) и пушем.
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useAuth } from '../context/AuthContext'
import { sendReply } from '../lib/messages'

const TEMPLATES = [
  ['Постпроцессор выдан', name => `Здравствуйте! Выдал вам постпроцессор${name ? ` «${name}»` : ''}. Он появился в настройках ЧПУ (Профиль → Настройки ЧПУ → станок). Попробуйте выпустить программу и напишите, как отработал станок.`],
  ['Нужны данные', () => 'Здравствуйте! Чтобы настроить постпроцессор, пришлите, пожалуйста, пример рабочей программы со станка (G-код) и модель станка / системы ЧПУ.'],
  ['Как дела?', () => 'Здравствуйте! Как работает программа? Если что-то не так — напишите, поправлю.'],
]

/** Окно «Написать»: to — { id, name }, text — текст заранее (например, «постпроцессор выдан»), post — название для шаблона */
export function WriteToUserDialog({ to, text = '', post = '', onClose, onSent }) {
  const { user, profile } = useAuth()
  const [body, setBody] = useState(text)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const send = async () => {
    const b = body.trim()
    if (!b) return
    setBusy(true); setErr('')
    const r = await sendReply(user, profile, to.id, b, to.name || '')
    setBusy(false)
    if (r.error) { setErr(r.error); return }
    onSent?.(); onClose()
  }
  const chip = { padding: '4px 10px', borderRadius: 14, fontSize: 11.5, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }
  return createPortal(
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 1300, background: 'rgba(0,0,0,.38)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 520, background: 'var(--bg)', borderRadius: '18px 18px 0 0', padding: '14px 16px 22px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1, fontSize: 15.5, fontWeight: 600 }}>✉ Написать: {to.name || 'пользователю'}</div>
          <button type="button" onClick={onClose} style={{ width: 32, height: 32, borderRadius: 16, border: 'none', background: 'var(--bg2)', fontSize: 18, cursor: 'pointer', color: 'var(--text-muted)' }}>×</button>
        </div>
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', margin: '8px 0 6px' }}>
          {TEMPLATES.map(([l, f]) => <button key={l} type="button" style={chip} onClick={() => setBody(f(post))}>{l}</button>)}
        </div>
        <textarea value={body} onChange={e => setBody(e.target.value)} rows={5} autoFocus placeholder="Текст сообщения…"
          style={{ width: '100%', padding: '8px 10px', fontSize: 14, borderRadius: 10, border: '1px solid var(--border-md)', background: 'var(--bg)', color: 'var(--text)', fontFamily: 'inherit', resize: 'vertical' }} />
        <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 4 }}>Придёт пользователю в «Сообщения» и уведомлением на телефон.</div>
        {err && <p className="error-text" style={{ marginTop: 6 }}>{err}</p>}
        <button type="button" className="btn-primary" disabled={busy || !body.trim()} onClick={send} style={{ marginTop: 10 }}>{busy ? 'Отправляем…' : 'Отправить'}</button>
      </div>
    </div>,
    document.body,
  )
}

/** Кнопка «✉ Написать» с окном */
export default function WriteToUser({ id, name, text = '', post = '', label = '✉ Написать', style = null, onSent }) {
  const [open, setOpen] = useState(false)
  if (!id) return null
  return (
    <>
      <button type="button" onClick={e => { e.stopPropagation(); setOpen(true) }} title={`Написать: ${name || 'пользователю'}`}
        style={style || { padding: '4px 10px', borderRadius: 14, fontSize: 12, border: '0.5px solid var(--blue)', background: 'transparent', color: 'var(--blue)', cursor: 'pointer', whiteSpace: 'nowrap' }}>{label}</button>
      {open && <WriteToUserDialog to={{ id, name }} text={text} post={post} onClose={() => setOpen(false)} onSent={onSent} />}
    </>
  )
}
