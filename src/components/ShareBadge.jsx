import { useEffect, useState } from 'react'
import { cachedShare, getShare, onShareChange } from '../lib/modelShare'
import ShareLinkBox from './ShareLinkBox'

// Пометка «🔗 ссылка на 3D открыта» — на любом этапе заказа (список, раскрой, правка, производство).
// Нажатие открывает ссылку: скопировать, отправить или закрыть доступ. Ссылки нет — пометки нет.
// known — уже известно, что ссылка есть (из общего списка), чтобы не спрашивать базу по каждому заказу.
export default function ShareBadge({ orderId, known, style }) {
  // live — что знает кэш ссылок (меняется, когда ссылку создали или закрыли где угодно); не знает — берём known
  const [live, setLive] = useState(() => (orderId ? cachedShare(orderId) : undefined))
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!orderId) return
    const off = onShareChange(() => { const t = cachedShare(orderId); if (t !== undefined) setLive(t || null) })
    if (known === undefined && cachedShare(orderId) === undefined) getShare(orderId)
    return off
  }, [orderId, known])
  const has = live !== undefined ? !!live : !!known
  if (!orderId || (!has && !open)) return null
  const stop = e => e.stopPropagation()
  return (
    <>
      {has && (
        <button type="button" title="По ссылке 3D-модель этого заказа открыта для просмотра. Нажмите, чтобы скопировать или закрыть доступ."
          onClick={e => { stop(e); setOpen(true) }} onMouseDown={stop} onTouchStart={stop}
          style={{ alignSelf: 'flex-start', fontSize: 11, color: 'var(--teal)', background: 'var(--teal-light)', border: '0.5px solid var(--teal)', borderRadius: 10, padding: '1px 8px', cursor: 'pointer', whiteSpace: 'nowrap', ...style }}>
          🔗 ссылка на 3D открыта
        </button>
      )}
      {open && (
        <div onClick={e => { stop(e); setOpen(false) }} onMouseDown={stop} onTouchStart={stop}
          style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
          <div onClick={stop} style={{ width: '100%', maxWidth: 520, background: 'var(--bg)', borderRadius: '14px 14px 0 0', padding: '14px 14px calc(14px + env(safe-area-inset-bottom))' }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
              <div style={{ flex: 1, fontSize: 15, fontWeight: 500 }}>Ссылка на 3D-модель</div>
              <button type="button" onClick={() => setOpen(false)} style={{ background: 'none', border: 'none', fontSize: 20, color: 'var(--text-hint)', cursor: 'pointer' }}>✕</button>
            </div>
            <ShareLinkBox orderId={orderId} />
          </div>
        </div>
      )}
    </>
  )
}
