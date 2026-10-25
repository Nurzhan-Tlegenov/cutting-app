// Переписка по заказу внутри приложения: заказчик ↔ производство.
// Производство может сразу переспросить (заказ тестовый? отправлен по ошибке?), заказчик отвечает здесь же;
// адресату приходит пуш со ссылкой на этот заказ. См. migration_order_chat.sql.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { listOrderMessages, sendOrderMessage, ORDER_CHAT_SQL_HINT } from '../lib/messages'

const when = iso => {
  const d = new Date(iso)
  const today = new Date().toDateString() === d.toDateString()
  return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export default function OrderChat({ orderId, title, hint }) {
  const { user, profile } = useAuth()
  const [list, setList] = useState(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const endRef = useRef(null)

  const load = useCallback(async () => {
    const r = await listOrderMessages(orderId)
    if (r.error) { setError(r.missing ? ORDER_CHAT_SQL_HINT : r.error); setList([]); return }
    setError(''); setList(r.data)
  }, [orderId])
  useEffect(() => { load(); const t = setInterval(load, 20000); return () => clearInterval(t) }, [load])
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest' }) }, [list?.length])
  // пришли из «Сообщений» или по пушу (#order-chat) — сразу к переписке
  useEffect(() => {
    if (list && window.location.hash === '#order-chat') document.getElementById('order-chat')?.scrollIntoView({ block: 'center' })
  }, [list === null])   // eslint-disable-line react-hooks/exhaustive-deps

  async function send() {
    const body = text.trim()
    if (!body || busy) return
    setBusy(true)
    const r = await sendOrderMessage(user, profile, orderId, body)
    setBusy(false)
    if (r.error) { setError(/kind_check|check constraint|row-level security/i.test(r.error) ? ORDER_CHAT_SQL_HINT : r.error); return }
    setText('')
    load()
  }

  return (
    <div className="card" id="order-chat" style={{ marginBottom: 12 }}>
      <p className="section-title">{title}</p>
      {hint && <p style={{ fontSize: 12, color: 'var(--text-hint)', marginBottom: 8 }}>{hint}</p>}
      {list && list.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 320, overflowY: 'auto', marginBottom: 8 }}>
          {list.map(m => {
            const mine = m.from_id === user?.id
            return (
              <div key={m.id} style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '85%', background: mine ? 'var(--blue-light)' : 'var(--bg2)', borderRadius: 12, padding: '6px 10px' }}>
                {!mine && m.from_name && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>{m.from_name}</div>}
                <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.body}</div>
                <div style={{ fontSize: 10, color: 'var(--text-hint)', textAlign: 'right', marginTop: 2 }}>{when(m.created_at)}</div>
              </div>
            )
          })}
          <div ref={endRef} />
        </div>
      )}
      {list && !list.length && !error && <p style={{ fontSize: 12, color: 'var(--text-hint)', marginBottom: 8 }}>Сообщений пока нет.</p>}
      {error && <p style={{ fontSize: 12, color: 'var(--red)', marginBottom: 8 }}>{error}</p>}
      <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
        <textarea value={text} onChange={e => setText(e.target.value)} rows={2} placeholder="Написать сообщение…" maxLength={2000}
          style={{ flex: 1, resize: 'vertical', fontSize: 14 }} />
        <button type="button" className="btn-primary" disabled={!text.trim() || busy} onClick={send} style={{ flex: 'none', width: 'auto', padding: '10px 14px' }}>
          {busy ? '…' : 'Отправить'}
        </button>
      </div>
    </div>
  )
}
