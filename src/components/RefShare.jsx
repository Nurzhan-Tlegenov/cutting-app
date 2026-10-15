import { useEffect, useState } from 'react'
import { myRefCode, refUrl, refText } from '../lib/refLinks'

// Личная ссылка-приглашение: показать, скопировать, отправить в WhatsApp / Telegram / куда угодно.
// kind: 'client' — производство приглашает клиентов; 'production' — пользователь приглашает своё производство.
// fallback — адрес, которым делиться, если база ещё без ссылок (до миграции): приглашение как раньше, по общему адресу.
export default function RefShare({ kind, name = '', production = '', compact = false, fallback = '' }) {
  const [code, setCode] = useState(undefined)   // undefined — загружаем
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  useEffect(() => {
    let alive = true
    myRefCode(kind).then(r => { if (!alive) return; setCode(r.data || null); if (r.error && !(r.missing && fallback)) setErr(r.error) })
    return () => { alive = false }
  }, [kind, fallback])
  const url = code ? refUrl(code) : fallback
  const text = url ? refText(kind, url, { name, production, plain: !code }) : ''
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); setMsg('Ссылка скопирована') } catch { setMsg('Выделите ссылку и скопируйте вручную') }
  }
  const pad = compact ? '8px 6px' : '9px 8px'
  if (code === undefined) return <p style={{ fontSize: 12, color: 'var(--text-hint)' }}>Готовим ссылку…</p>
  if (!url) return err ? <p className="error-text" style={{ fontSize: 12 }}>{err}</p> : null
  return (
    <div>
      {!compact && <input type="text" readOnly value={url} onFocus={e => e.target.select()} style={{ width: '100%', fontSize: 13, padding: '7px 8px', marginBottom: 8 }} />}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <a href={`https://wa.me/?text=${encodeURIComponent(text)}`} target="_blank" rel="noreferrer" className="btn-primary" style={{ flex: 1, textAlign: 'center', textDecoration: 'none', background: '#25D366', padding: pad }}>WhatsApp</a>
        <a href={`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text.replace(' ' + url, ''))}`} target="_blank" rel="noreferrer" className="btn-primary" style={{ flex: 1, textAlign: 'center', textDecoration: 'none', background: '#229ED9', padding: pad }}>Telegram</a>
        {typeof navigator !== 'undefined' && typeof navigator.share === 'function'
          ? <button type="button" className="btn-secondary" style={{ flex: 1, padding: pad }} onClick={() => navigator.share({ title: 'RaskroyPro', text }).catch(() => {})}>Ещё…</button>
          : <button type="button" className="btn-secondary" style={{ flex: 1, padding: pad }} onClick={copy}>Копировать</button>}
      </div>
      {!compact && typeof navigator !== 'undefined' && typeof navigator.share === 'function' && (
        <button type="button" onClick={copy} style={{ background: 'none', border: 'none', color: 'var(--blue)', fontSize: 12, padding: '6px 0 0', cursor: 'pointer' }}>Скопировать ссылку</button>
      )}
      {msg && <p style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 4 }}>{msg}</p>}
    </div>
  )
}
