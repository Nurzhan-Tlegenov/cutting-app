import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import BottomNav from '../components/BottomNav'
import CncLoader from '../components/CncLoader'
import { listMessages, sendAppeal, sendNews, sendReply, deleteMessage, messagePayload, markSeen, isIncoming } from '../lib/messages'
import { getUserSettings } from '../lib/userSettings'

// Сообщения: у пользователя — новости мастер-аккаунта, ответы и свои обращения;
// у мастер-аккаунта — обращения и файлы для отладки от пользователей (видно, от кого), новости для всех.
const when = v => (v ? new Date(v).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '')
const KIND = { news: ['Новость', 'var(--blue-light)', 'var(--blue-dark)'], appeal: ['Обращение', 'var(--amber-light)', 'var(--amber)'], reply: ['Ответ', 'var(--teal-light)', 'var(--teal)'], debug: ['Файл для отладки', '#F3E5F5', '#7B1FA2'] }
const sizeTxt = n => (n > 1048576 ? (n / 1048576).toFixed(1) + ' МБ' : n > 1024 ? Math.round(n / 1024) + ' КБ' : (n || 0) + ' Б')

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }))
  const a = document.createElement('a')
  a.href = url; a.download = name
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30000)
}

export default function MessagesPage() {
  const navigate = useNavigate()
  const { user, profile, isMaster } = useAuth()
  const [list, setList] = useState(null)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('all')
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [replyTo, setReplyTo] = useState(null)      // сообщение, на которое отвечает мастер-аккаунт
  const [replyText, setReplyText] = useState('')
  const [seenAt] = useState(() => getUserSettings(user).msgSeenAt || '')   // что было непрочитанным на момент открытия

  const load = async () => {
    const r = await listMessages()
    if (r.error) { setError(r.error); setList([]); return }
    setError(''); setList(r.data)
    markSeen(user)
    window.dispatchEvent(new Event('messages-seen'))
  }
  useEffect(() => { Promise.resolve().then(load) }, [user?.id])   // eslint-disable-line react-hooks/exhaustive-deps

  const post = async () => {
    const body = text.trim()
    if (!body) return
    setBusy(true)
    const r = isMaster ? await sendNews(user, profile, title.trim(), body) : await sendAppeal(user, profile, body)
    setBusy(false)
    if (r.error) { setError(r.error); return }
    setText(''); setTitle(''); load()
  }
  const reply = async () => {
    const body = replyText.trim()
    if (!body || !replyTo) return
    setBusy(true)
    const r = await sendReply(user, profile, replyTo.from_id, body)
    setBusy(false)
    if (r.error) { setError(r.error); return }
    setReplyTo(null); setReplyText(''); load()
  }
  const getFile = async m => {
    const r = await messagePayload(m.id)
    if (r.error) { setError(r.error); return }
    download(r.fileName, r.payload)
  }
  const remove = async m => {
    if (!window.confirm('Удалить сообщение?')) return
    const r = await deleteMessage(m.id)
    if (r.error) setError(r.error); else setList(l => l.filter(x => x.id !== m.id))
  }

  const FILTERS = isMaster ? [['all', 'Все'], ['appeal', 'Обращения'], ['debug', 'Файлы'], ['news', 'Новости']] : [['all', 'Все'], ['news', 'Новости'], ['mine', 'Мои обращения']]
  const shown = (list || []).filter(m => filter === 'all' || (filter === 'mine' ? m.from_id === user?.id || m.kind === 'reply' : m.kind === filter))
  const chip = on => ({ flex: '0 0 auto', padding: '6px 12px', borderRadius: 20, border: 'none', fontSize: 12, background: on ? 'var(--blue)' : 'var(--bg)', color: on ? 'white' : 'var(--text-muted)' })
  const small = { padding: '5px 11px', borderRadius: 20, fontSize: 12, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text-muted)', whiteSpace: 'nowrap' }

  return (
    <div className="page" style={{ paddingBottom: 100 }}>
      <h1 style={{ fontSize: 18, fontWeight: 500, marginBottom: 12, paddingTop: 8 }}>Сообщения</h1>
      {error && <p className="error-text" style={{ marginBottom: 12 }}>{error}</p>}

      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ fontWeight: 500, fontSize: 14, marginBottom: 6 }}>{isMaster ? 'Новость для всех пользователей' : 'Написать разработчику'}</div>
        {isMaster && <input type="text" value={title} onChange={e => setTitle(e.target.value)} placeholder="Заголовок (необязательно)" style={{ marginBottom: 6, fontSize: 14 }} />}
        <textarea value={text} onChange={e => setText(e.target.value)} rows={3} style={{ fontSize: 14, resize: 'vertical' }}
          placeholder={isMaster ? 'Что нового в приложении…' : 'Вопрос, замечание или пожелание…'} />
        <button type="button" className="btn-primary" style={{ marginTop: 8 }} disabled={busy || !text.trim()} onClick={post}>
          {busy ? 'Отправка…' : isMaster ? 'Опубликовать новость' : 'Отправить обращение'}
        </button>
      </div>

      <div style={{ display: 'flex', gap: 6, overflowX: 'auto', marginBottom: 10, paddingBottom: 2 }}>
        {FILTERS.map(([k, l]) => <button key={k} type="button" style={chip(filter === k)} onClick={() => setFilter(k)}>{l}</button>)}
      </div>

      {list === null ? <CncLoader label="Загружаем сообщения…" compact /> : !shown.length ? (
        <p style={{ fontSize: 13, color: 'var(--text-hint)', textAlign: 'center', padding: '24px 0' }}>Сообщений пока нет.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {shown.map(m => {
            const [kl, bg, fg] = KIND[m.kind] || KIND.news
            const mine = m.from_id === user?.id
            const fresh = isIncoming(m, user?.id, isMaster) && (!seenAt || m.created_at > seenAt)
            return (
              <div key={m.id} className="card" style={{ padding: '10px 12px', borderColor: fresh ? 'var(--blue)' : undefined }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 11, fontWeight: 500, padding: '2px 8px', borderRadius: 10, background: bg, color: fg }}>{kl}</span>
                  {fresh && <span style={{ fontSize: 10, color: 'var(--blue)', fontWeight: 600 }}>● новое</span>}
                  <span style={{ flex: 1 }} />
                  <span style={{ fontSize: 11, color: 'var(--text-hint)' }}>{when(m.created_at)}</span>
                </div>
                {/* мастер-аккаунт видит, от кого пришло */}
                {isMaster && !mine && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 3 }}>От: <b style={{ color: 'var(--text)' }}>{m.from_name || 'пользователь'}</b></div>}
                {!isMaster && mine && <div style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 3 }}>Вы писали</div>}
                {m.title && <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 2 }}>{m.title}</div>}
                {m.body && <div style={{ fontSize: 14, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.body}</div>}
                {m.file_name && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, fontFamily: 'monospace', wordBreak: 'break-all' }}>📎 {m.file_name} · {sizeTxt(m.file_size)}</div>}
                <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                  {isMaster && m.file_name && <button type="button" style={{ ...small, color: 'var(--teal)', borderColor: 'var(--teal)' }} onClick={() => getFile(m)}>⬇ Скачать файл</button>}
                  {isMaster && m.order_id && <button type="button" style={small} onClick={() => navigate(`/orders/${m.order_id}/nesting`)}>Открыть заказ</button>}
                  {isMaster && !mine && (m.kind === 'appeal' || m.kind === 'debug') && <button type="button" style={{ ...small, color: 'var(--blue)', borderColor: 'var(--blue)' }} onClick={() => { setReplyTo(m); setReplyText('') }}>Ответить</button>}
                  {(isMaster || mine) && <button type="button" style={small} onClick={() => remove(m)}>Удалить</button>}
                </div>
                {replyTo?.id === m.id && (
                  <div style={{ marginTop: 8 }}>
                    <textarea value={replyText} onChange={e => setReplyText(e.target.value)} rows={3} autoFocus placeholder="Ответ пользователю…" style={{ fontSize: 14 }} />
                    <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                      <button type="button" className="btn-primary" style={{ padding: 9, fontSize: 14 }} disabled={busy || !replyText.trim()} onClick={reply}>Отправить ответ</button>
                      <button type="button" className="btn-secondary" style={{ padding: 9, fontSize: 14 }} onClick={() => setReplyTo(null)}>Отмена</button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
      <BottomNav />
    </div>
  )
}
