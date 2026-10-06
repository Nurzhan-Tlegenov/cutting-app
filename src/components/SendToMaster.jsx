import { useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { sendDebugFile } from '../lib/messages'

// Отправка файла для отладки мастер-аккаунту: «Точно отправить?» + обязательное описание того, что не работает.
// Сам файл пользователю не скачивается — он уходит мастер-аккаунту вместе с комментарием.
// job — { title, fileName, getPayload(), orderId }; onClose().
export default function SendToMaster({ job, onClose }) {
  const { user, profile } = useAuth()
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  if (!job) return null
  const send = async () => {
    if (comment.trim().length < 5) { setError('Опишите, что не работает — хотя бы пару слов.'); return }
    setBusy(true); setError('')
    let payload = ''
    try { payload = await job.getPayload() } catch (e) { setBusy(false); setError('Не удалось собрать файл: ' + (e?.message || e)); return }
    const r = await sendDebugFile(user, profile, { fileName: job.fileName, payload, comment: comment.trim(), orderId: job.orderId, title: job.title })
    setBusy(false)
    if (r.error) { setError(r.error); return }
    setDone(true)
  }
  return (
    <div onClick={busy ? undefined : onClose} style={{ position: 'fixed', inset: 0, zIndex: 990, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 520, background: 'var(--bg)', borderRadius: '16px 16px 0 0', padding: '16px 16px calc(16px + env(safe-area-inset-bottom))' }}>
        {done ? (
          <>
            <div style={{ fontSize: 16, fontWeight: 500, marginBottom: 6 }}>✓ Отправлено</div>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>Файл и ваше описание ушли разработчику. Ответ придёт в раздел «Сообщения».</p>
            <button type="button" className="btn-primary" onClick={onClose}>Хорошо</button>
          </>
        ) : (
          <>
            <div style={{ fontSize: 16, fontWeight: 500, marginBottom: 4 }}>Точно отправить?</div>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
              Разработчику уйдёт: <b>{job.title}</b>. Файл на устройство не скачивается.
            </p>
            <label className="label">Что не работает? Опишите замечание</label>
            <textarea value={comment} onChange={e => setComment(e.target.value)} rows={4} autoFocus
              placeholder="Например: на листе 2 деталь наложилась на соседнюю после поворота" style={{ fontSize: 14, resize: 'vertical' }} />
            {error && <p className="error-text" style={{ marginTop: 6 }}>{error}</p>}
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button type="button" className="btn-primary" disabled={busy} onClick={send}>{busy ? 'Отправка…' : 'Отправить'}</button>
              <button type="button" className="btn-secondary" disabled={busy} onClick={onClose}>Отмена</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
