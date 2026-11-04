import { useState } from 'react'
import { useSupportStaff, setSupport, isStaffIn } from '../lib/support'

// Мастер-аккаунт: галочка «Сотрудник поддержки» в карточке пользователя. Сотрудник видит только раздел «Поддержка»
// (обращения и их переписку) — разделы мастер-аккаунта ему не открываются.
export default function SupportToggle({ userId, name = '', style }) {
  const st = useSupportStaff(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  if (st === undefined) return null
  if (st.missing) return <div style={{ fontSize: 11.5, color: 'var(--text-hint)', ...style }}>Роль «Поддержка» — после migration_support_staff.sql в Supabase.</div>
  const on = isStaffIn(st, userId)
  const toggle = async () => {
    if (!on && !window.confirm(`Сделать «${name || 'пользователя'}» сотрудником поддержки?\n\nОн увидит раздел «Поддержка»: обращения пользователей, их переписку и файлы, краткую карточку автора (без телефона). Разделы мастер-аккаунта ему недоступны.`)) return
    setBusy(true); setErr('')
    const r = await setSupport(userId, !on)
    setBusy(false)
    if (r.error) setErr(r.error)
  }
  return (
    <div style={style}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: busy ? 'wait' : 'pointer' }}>
        <input type="checkbox" checked={on} disabled={busy} onChange={toggle} style={{ width: 18, height: 18, margin: 0 }} />
        <span>🎧 Сотрудник поддержки</span>
      </label>
      {err && <div className="error-text" style={{ fontSize: 11.5, marginTop: 2 }}>{err}</div>}
    </div>
  )
}
