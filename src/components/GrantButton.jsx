// Мастер-аккаунт: выдать доступ по запросу прямо из сообщения («Запрос: выгрузка DXF» -> 🔑 Выдать).
// Выдано — «✓ Выдано» и «Отключить». Пользователю уходит уведомление (grantFeature).
import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { adminBeta, grantFeature } from '../lib/beta'

let cache = null
const loadMap = async (force) => { if (!cache || force) { const r = await adminBeta(); cache = r.error ? new Map() : r.data } return cache }

export default function GrantButton({ userId, userName, feature, onDone }) {
  const { user, profile } = useAuth()
  const [has, setHas] = useState(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { let alive = true; loadMap().then(m => { if (alive) setHas((m.get(userId) || []).includes(feature)) }); return () => { alive = false } }, [userId, feature])
  const set = async on => {
    if (!on && !window.confirm('Отключить доступ? Пользователю придёт уведомление.')) return
    setBusy(true)
    const r = await grantFeature(user, profile, userId, userName, feature, on)
    setBusy(false)
    if (r?.error) { window.alert(r.error); return }
    await loadMap(true); setHas(on); onDone?.()
  }
  if (has == null) return null
  const st = { padding: '4px 10px', borderRadius: 16, fontSize: 12, cursor: 'pointer' }
  return has
    ? <>
        <span style={{ fontSize: 12, color: 'var(--teal)', alignSelf: 'center' }}>✓ Выдано</span>
        <button type="button" disabled={busy} onClick={() => set(false)} style={{ ...st, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text-muted)' }}>Отключить</button>
      </>
    : <button type="button" disabled={busy} onClick={() => set(true)} style={{ ...st, border: '0.5px solid var(--teal)', background: 'var(--teal)', color: 'white', fontWeight: 500 }}>🔑 Выдать</button>
}
