import { useEffect, useState } from 'react'
import { listSimShares, deleteSimShare, simShareUrl } from '../lib/simShare'

// Открытые ссылки на симуляцию обработки по заказу: видно всегда (в заказе и в ЧПУ), отсюда же закрывается доступ.
// Ссылок нет — блок не показывается. refresh — поменяйте значение, чтобы перечитать список.
export default function SimLinksBox({ orderId, refresh = 0, style }) {
  const [list, setList] = useState([])
  const [msg, setMsg] = useState('')
  useEffect(() => {
    let alive = true
    listSimShares(orderId).then(l => { if (alive) setList(l) })
    return () => { alive = false }
  }, [orderId, refresh])
  if (!list.length) return null
  const copy = async code => {
    const url = simShareUrl(code)
    try { await navigator.clipboard.writeText(url); setMsg('Ссылка скопирована') } catch { window.prompt('Скопируйте ссылку', url) }
  }
  const close = async s => {
    if (!window.confirm(`Закрыть доступ к симуляции «${s.name}»? Ссылка перестанет открываться у всех, кому вы её отправили.`)) return
    const r = await deleteSimShare(s.code)
    if (r.error) setMsg(r.error); else { setList(l => l.filter(x => x.code !== s.code)); setMsg('') }
  }
  const closeAll = async () => {
    if (!window.confirm(`Закрыть доступ ко всем симуляциям этого заказа (${list.length})?`)) return
    for (const s of list) await deleteSimShare(s.code)
    setList(await listSimShares(orderId))
  }
  const btn = { padding: '6px 10px', borderRadius: 20, fontSize: 12, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text-muted)', whiteSpace: 'nowrap' }
  return (
    <div className="card" style={{ border: '1px solid var(--teal)', ...style }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <p className="section-title" style={{ color: 'var(--teal)', marginBottom: 0, flex: 1 }}>🔗 Открыты ссылки на симуляцию · {list.length}</p>
        {list.length > 1 && <button type="button" onClick={closeAll} style={{ ...btn, color: 'var(--danger)', borderColor: 'var(--danger)' }}>Закрыть все</button>}
      </div>
      {list.map(s => (
        <div key={s.code} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 0', borderTop: '0.5px solid var(--border)' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</div>
            <div style={{ fontSize: 11, color: 'var(--text-hint)' }}>/s/{s.code}{s.updated_at ? ' · ' + new Date(s.updated_at).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' }) : ''}</div>
          </div>
          <button type="button" style={btn} onClick={() => copy(s.code)}>Копировать</button>
          <button type="button" style={{ ...btn, color: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={() => close(s)}>Закрыть</button>
        </div>
      ))}
      {msg && <p style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 4 }}>{msg}</p>}
    </div>
  )
}
