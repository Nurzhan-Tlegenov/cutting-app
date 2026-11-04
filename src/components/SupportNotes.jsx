import { useCallback, useEffect, useRef, useState } from 'react'
import { supportNotes, supportNoteAdd, supportNoteDelete } from '../lib/support'

const dt = v => (v ? new Date(v).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '')

// Внутренние заметки поддержки (cardId — у карточки) или общий чат команды (cardId пусто).
// Пользователь их не видит — только мастер-аккаунт и сотрудники поддержки.
export default function SupportNotes({ cardId = null, me, isMaster, onSent, tall = false }) {
  const [list, setList] = useState(null)
  const [text, setText] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const endRef = useRef(null)
  const load = useCallback(async () => {
    const r = await supportNotes(cardId)
    if (r.error) { setErr(r.error); setList(l => l || []) } else { setErr(''); setList(r.data || []) }
  }, [cardId])
  useEffect(() => {
    const t = setTimeout(load, 0)
    const iv = setInterval(load, cardId ? 30000 : 15000)
    return () => { clearTimeout(t); clearInterval(iv) }
  }, [load, cardId])
  useEffect(() => { if (tall && list?.length) endRef.current?.scrollIntoView({ block: 'end' }) }, [tall, list?.length])
  const send = async () => {
    const b = text.trim(); if (!b) return
    setBusy(true); const r = await supportNoteAdd(cardId, b); setBusy(false)
    if (r.error) { setErr(r.error); return }
    setText(''); await load(); onSent?.()
  }
  const del = async n => {
    if (!window.confirm('Удалить заметку?')) return
    const r = await supportNoteDelete(n.id)
    if (r.error) setErr(r.error); else load()
  }
  return (
    <div>
      <div style={{ ...(tall ? { maxHeight: '58vh', overflowY: 'auto' } : {}), display: 'flex', flexDirection: 'column', gap: 6 }}>
        {list === null ? <p style={{ fontSize: 12, color: 'var(--text-hint)' }}>Загружаем…</p>
          : !list.length ? <p style={{ fontSize: 12, color: 'var(--text-hint)' }}>{cardId ? 'Заметок пока нет.' : 'Сообщений пока нет — напишите команде первым.'}</p>
            : list.map(n => {
              const mine = n.author === me
              return (
                <div key={n.id} style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '90%', background: 'var(--bg)',
                  border: mine ? '1px solid var(--amber)' : '0.5px solid var(--border)', borderRadius: 10, padding: '6px 9px', fontSize: 13 }}>
                  <div style={{ fontSize: 11, color: 'var(--text-hint)', display: 'flex', gap: 6 }}>
                    <span style={{ flex: 1 }}>{mine ? 'Вы' : n.author_name} · {dt(n.created_at)}</span>
                    {(mine || isMaster) && <span role="button" tabIndex={0} title="Удалить" onClick={() => del(n)} onKeyDown={e => { if (e.key === 'Enter') del(n) }} style={{ cursor: 'pointer' }}>✕</span>}
                  </div>
                  <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{n.body}</div>
                </div>
              )
            })}
        <div ref={endRef} />
      </div>
      {err && <p className="error-text" style={{ fontSize: 12, marginTop: 4 }}>{err}</p>}
      <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'flex-end' }}>
        <textarea value={text} onChange={e => setText(e.target.value)} rows={2} placeholder={cardId ? 'Заметка для команды — пользователь её не видит' : 'Сообщение команде поддержки'}
          style={{ flex: 1, minWidth: 0, width: 'auto', fontSize: 13, resize: 'vertical' }} />
        <button type="button" className="btn-secondary" disabled={busy || !text.trim()} onClick={send} style={{ width: 'auto', flexShrink: 0, padding: '8px 12px' }}>{cardId ? 'Добавить' : '➤'}</button>
      </div>
    </div>
  )
}
