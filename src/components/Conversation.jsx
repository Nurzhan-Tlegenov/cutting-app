// Мастер-аккаунт: вся переписка с одним пользователем одним разговором — его обращения и файлы слева, ответы справа,
// внизу — ответ с файлами (скриншот, проверенная модель). Скриншот можно и вставить из буфера (Ctrl+V).
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAuth } from '../context/AuthContext'
import { listConversation, sendReplyFiles, REPORT_MAX_MB } from '../lib/messages'
import MsgFile from './MsgFile'

const when = v => (v ? new Date(v).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '')
const sizeTxt = n => (n > 1048576 ? (n / 1048576).toFixed(1) + ' МБ' : n > 1024 ? Math.round(n / 1024) + ' КБ' : (n || 0) + ' Б')

export default function Conversation({ userId, name, onClose, onSent }) {
  const { user, profile } = useAuth()
  const [list, setList] = useState(null)
  const [error, setError] = useState('')
  const [text, setText] = useState('')
  const [files, setFiles] = useState([])
  const [busy, setBusy] = useState('')
  const fileRef = useRef(null)
  const endRef = useRef(null)
  const load = async () => {
    const r = await listConversation(userId)
    if (r.error) { setError(r.error); setList([]); return }
    setList(r.data)
  }
  useEffect(() => { Promise.resolve().then(load) }, [userId])   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [list])
  const addFiles = add => setFiles(fs => [...fs, ...add.filter(f => !fs.some(x => x.name === f.name && x.size === f.size))])
  // скриншот из буфера обмена: картинка становится файлом сообщения
  const onPaste = e => {
    const imgs = [...(e.clipboardData?.items || [])].filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean)
    if (!imgs.length) return
    e.preventDefault()
    addFiles(imgs.map((f, k) => (f.name && f.name !== 'image.png' ? f : new File([f], `скриншот_${new Date().toISOString().slice(11, 19).replace(/:/g, '-')}${k ? '_' + k : ''}.png`, { type: f.type || 'image/png' }))))
  }
  const send = async () => {
    const body = text.trim() || (files.length ? 'Файл во вложении' : '')
    if (!body) return
    setBusy('…'); setError('')
    const r = await sendReplyFiles(user, profile, userId, body, files, name, (k, n) => setBusy(n > 1 ? `${Math.round((k / n) * 100)}%` : '…'))
    setBusy('')
    if (r.error) { setError(r.error); return }
    setText(''); setFiles([]); load(); onSent?.()
  }
  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 2000, background: 'var(--bg2)', display: 'flex', flexDirection: 'column',
      paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', background: 'var(--bg)', borderBottom: '0.5px solid var(--border-md)' }}>
        <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--blue)', fontSize: 22, padding: 0, cursor: 'pointer' }}>←</button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name || 'Пользователь'}</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-hint)' }}>Переписка: обращения и ответы{list ? ` · ${list.length}` : ''}</div>
        </div>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 10px', display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 760, width: '100%', margin: '0 auto' }}>
        {list === null && <div style={{ textAlign: 'center', color: 'var(--text-hint)', fontSize: 13 }}>Загружаем…</div>}
        {list && !list.length && <div style={{ textAlign: 'center', color: 'var(--text-hint)', fontSize: 13 }}>Сообщений пока нет.</div>}
        {(list || []).map(m => {
          const mine = m.kind === 'reply'
          return (
            <div key={m.id} style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '86%', padding: '8px 11px', borderRadius: 14,
              borderBottomRightRadius: mine ? 4 : 14, borderBottomLeftRadius: mine ? 14 : 4,
              background: mine ? 'var(--blue)' : 'var(--bg)', color: mine ? '#fff' : 'var(--text)', boxShadow: '0 1px 2px rgba(0,0,0,.08)' }}>
              {m.kind === 'debug' && <div style={{ fontSize: 11, fontWeight: 600, color: '#7B1FA2', marginBottom: 2 }}>Файл для отладки</div>}
              {m.title && <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 2 }}>{m.title}</div>}
              {m.body && <div style={{ fontSize: 14, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.body.replace(/\n?Сделать: Профиль → Заказы всех производств[^\n]*/, '')}</div>}
              <MsgFile m={m} light={mine} onError={setError} />
              <div style={{ fontSize: 10.5, opacity: 0.75, textAlign: 'right', marginTop: 3 }}>
                {when(m.created_at)}{mine && 'read_at' in m ? (m.read_at ? ' · ✓✓ прочитано' : m.delivered_at ? ' · ✓✓ дошло' : ' · ✓') : ''}
              </div>
            </div>
          )
        })}
        <div ref={endRef} />
      </div>
      <div style={{ background: 'var(--bg)', borderTop: '0.5px solid var(--border-md)', padding: '8px 10px' }}>
        <div style={{ maxWidth: 760, margin: '0 auto' }}>
          {error && <p className="error-text" style={{ margin: '0 0 6px' }}>{error}</p>}
          {files.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 6 }}>
              {files.map((f, i) => (
                <span key={f.name + i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, background: 'var(--bg2)', borderRadius: 12, padding: '3px 4px 3px 9px', maxWidth: '100%' }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>📎 {f.name}</span>
                  <span style={{ color: 'var(--text-hint)' }}>{sizeTxt(f.size)}</span>
                  <button type="button" onClick={() => setFiles(fs => fs.filter((_, j) => j !== i))} style={{ border: 'none', background: 'none', color: 'var(--text-hint)', fontSize: 15, padding: '0 4px', cursor: 'pointer' }}>×</button>
                </span>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
            <input ref={fileRef} type="file" multiple style={{ display: 'none' }} onChange={e => { const add = [...(e.target.files || [])]; e.target.value = ''; addFiles(add) }} />
            <button type="button" title={`Прикрепить файл — скриншот, модель… (до ${REPORT_MAX_MB} МБ)`} onClick={() => fileRef.current?.click()} disabled={!!busy}
              style={{ flex: '0 0 auto', width: 40, height: 40, borderRadius: 20, border: '0.5px solid var(--border-md)', background: 'var(--bg2)', fontSize: 18, padding: 0, cursor: 'pointer' }}>📎</button>
            <textarea value={text} onChange={e => setText(e.target.value)} onPaste={onPaste} rows={2} placeholder="Ответ… (скриншот можно вставить: Ctrl+V)"
              style={{ flex: 1, minWidth: 0, fontSize: 14, resize: 'none', padding: '8px 10px' }} />
            <button type="button" onClick={send} disabled={!!busy || (!text.trim() && !files.length)}
              style={{ flex: '0 0 auto', height: 40, padding: '0 14px', borderRadius: 20, border: 'none', background: 'var(--blue)', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer', opacity: !text.trim() && !files.length ? 0.5 : 1 }}>
              {busy ? busy : 'Отправить'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
