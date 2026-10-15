import { useEffect, useState } from 'react'
import { getShare, createShare, deleteShare, shareUrl, SHARE_TABLE_HINT } from '../lib/modelShare'

// Ссылка на 3D-модель заказа для клиента: создать, скопировать, отправить, закрыть доступ.
export default function ShareLinkBox({ orderId, note = '' }) {
  const [token, setToken] = useState(undefined)     // undefined — ещё проверяем
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  useEffect(() => {
    let alive = true
    getShare(orderId).then(r => { if (!alive) return; setToken(r.token || null); if (r.missing) setErr(SHARE_TABLE_HINT) })
    return () => { alive = false }
  }, [orderId])
  const url = token ? shareUrl(token) : ''
  const create = async () => {
    setBusy(true); setErr('')
    const r = await createShare(orderId)
    setBusy(false)
    if (r.token) setToken(r.token); else setErr(r.error || 'Не удалось создать ссылку')
  }
  const close = async () => {
    if (!window.confirm('Закрыть доступ? Ссылка перестанет открываться у всех, кому вы её отправили.')) return
    setBusy(true); setErr('')
    const r = await deleteShare(orderId)
    setBusy(false)
    if (r.ok) { setToken(null); setMsg('') } else setErr(r.error || 'Не удалось закрыть доступ')
  }
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); setMsg('Ссылка скопирована') } catch { setMsg('Выделите ссылку и скопируйте вручную') }
  }
  const send = async () => {
    try { await navigator.share({ title: '3D-модель', url }) } catch { /* отменили */ }
  }
  const btn = primary => ({ flex: 1, padding: '9px 8px', borderRadius: 'var(--radius)', fontSize: 13, cursor: 'pointer', border: primary ? 'none' : '0.5px solid var(--border-md)', background: primary ? 'var(--blue)' : 'transparent', color: primary ? 'white' : 'var(--text-muted)' })
  if (token === undefined) return <p style={{ fontSize: 12, color: 'var(--text-hint)' }}>Проверяем…</p>
  return (
    <div>
      {token ? (
        <>
          <p style={{ fontSize: 12, color: 'var(--teal)', marginBottom: 6 }}>● Доступ по ссылке открыт: модель увидит любой, у кого есть ссылка (только просмотр, без входа).</p>
          <input type="text" readOnly value={url} onFocus={e => e.target.select()} style={{ width: '100%', fontSize: 12, padding: '7px 8px', marginBottom: 8 }} />
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" style={btn(true)} onClick={copy}>Скопировать</button>
            {typeof navigator !== 'undefined' && navigator.share && <button type="button" style={btn(false)} onClick={send}>Отправить…</button>}
            <button type="button" disabled={busy} style={{ ...btn(false), color: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={close}>Закрыть доступ</button>
          </div>
          {msg && <p style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 6 }}>{msg}</p>}
        </>
      ) : (
        <>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>Клиент откроет модель по ссылке в браузере: вращение, виды, взрыв-схема. Править и видеть другие заказы он не сможет. Доступ можно закрыть в любой момент.</p>
          <button type="button" disabled={busy} style={{ ...btn(true), width: '100%' }} onClick={create}>{busy ? 'Создаём…' : 'Создать ссылку'}</button>
        </>
      )}
      {note && <p style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 6 }}>{note}</p>}
      {err && <p className="error-text" style={{ fontSize: 12, marginTop: 6 }}>{err}</p>}
    </div>
  )
}
