// Мастер-аккаунт: вся переписка с одним пользователем одним разговором — его обращения и файлы слева, ответы справа,
// внизу — ответ с файлами (скриншот, проверенная модель). Скриншот можно и вставить из буфера (Ctrl+V).
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAuth } from '../context/AuthContext'
import { useNavigate } from 'react-router-dom'
import { listConversation, sendReplyFiles, sendReply, excludeRequest, REPORT_MAX_MB } from '../lib/messages'
import ExcludeStatsRequest from './ExcludeStatsRequest'
import MsgFile from './MsgFile'
import { UserName, UserLine } from './UserCard'
import { useAdminDirectory } from '../lib/adminDirectory'
import GrantButton from './GrantButton'
import { grantOfMessage } from '../lib/beta'

const when = v => (v ? new Date(v).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '')
const sizeTxt = n => (n > 1048576 ? (n / 1048576).toFixed(1) + ' МБ' : n > 1024 ? Math.round(n / 1024) + ' КБ' : (n || 0) + ' Б')

export default function Conversation({ userId, name, onClose, onSent }) {
  const { user, profile, isMaster } = useAuth()
  const dir = useAdminDirectory(isMaster)
  const navigate = useNavigate()
  // обращение из заказа — мастер открывает этот заказ пользователя сразу (раскрой или бланк)
  const go = path => { onClose?.(); navigate(path) }
  const [list, setList] = useState(null)
  const [error, setError] = useState('')
  const [text, setText] = useState('')
  const [files, setFiles] = useState([])
  const [busy, setBusy] = useState('')
  const fileRef = useRef(null)
  // поле ответа: само растёт под текст (до половины видимой части экрана); выше — потянуть полоску над полем
  const taRef = useRef(null)
  const [taH, setTaH] = useState(0)          // высота, заданная полоской (0 — по тексту)
  const drag = useRef(null)
  useEffect(() => {
    const el = taRef.current
    if (!el || taH) return
    el.style.height = 'auto'
    const max = Math.round((window.visualViewport?.height || window.innerHeight) * 0.5)
    el.style.height = Math.min(Math.max(el.scrollHeight + 2, 44), max) + 'px'
  }, [text, taH])
  const gripDown = e => { e.preventDefault(); drag.current = { y: e.clientY, h: taRef.current?.offsetHeight || 60 }; e.currentTarget.setPointerCapture?.(e.pointerId) }
  const gripMove = e => {
    if (!drag.current) return
    const max = Math.round((window.visualViewport?.height || window.innerHeight) * 0.8)
    const h = Math.max(44, Math.min(max, drag.current.h + (drag.current.y - e.clientY)))
    setTaH(h); if (taRef.current) taRef.current.style.height = h + 'px'
  }
  const gripUp = () => { drag.current = null }
  const endRef = useRef(null)
  const load = async () => {
    const r = await listConversation(userId)
    if (r.error) { setError(r.error); setList([]); return }
    setList(r.data)
  }
  useEffect(() => { Promise.resolve().then(load) }, [userId])   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [list])
  // Клавиатура телефона: окно переписки — по видимой части экрана (visualViewport), иначе поле ответа уходит под клавиатуру
  // (во встроенных браузерах страница под клавиатурой не сжимается)
  const [vv, setVv] = useState(null)
  useEffect(() => {
    const v = window.visualViewport
    if (!v) return
    const upd = () => {
      const kb = window.innerHeight - v.height > 80
      setVv(kb ? { top: v.offsetTop, h: v.height } : null)
      if (kb) requestAnimationFrame(() => endRef.current?.scrollIntoView({ block: 'end' }))
    }
    upd()
    v.addEventListener('resize', upd); v.addEventListener('scroll', upd)
    return () => { v.removeEventListener('resize', upd); v.removeEventListener('scroll', upd) }
  }, [])
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
    setText(''); setFiles([]); setTaH(0); load(); onSent?.()
  }
  return createPortal(
    <div style={{ position: 'fixed', left: 0, right: 0, ...(vv ? { top: vv.top, height: vv.h } : { top: 0, bottom: 0 }), zIndex: 2000, background: 'var(--bg2)', display: 'flex', flexDirection: 'column',
      paddingTop: vv ? 0 : 'env(safe-area-inset-top)', paddingBottom: vv ? 0 : 'env(safe-area-inset-bottom)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', background: 'var(--bg)', borderBottom: '0.5px solid var(--border-md)' }}>
        <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--blue)', fontSize: 22, padding: 0, cursor: 'pointer' }}>←</button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{isMaster ? <UserName id={userId} name={name} dir={dir} canWrite={false} /> : (name || 'Пользователь')}</div>
          {isMaster && <UserLine dir={dir} id={userId} />}
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
              {/* просьба убрать тестовый заказ из итогов — кнопки прямо здесь */}
              {isMaster && !mine && excludeRequest(m) && (
                <ExcludeStatsRequest req={excludeRequest(m)} go={go} onError={setError}
                  onDone={async (o, on) => {
                    if (!on || !window.confirm('Готово. Сообщить пользователю ответом?')) return
                    const r = await sendReply(user, profile, userId, `Тестовый заказ «${String(o.order_name || '').trim() || o.order_number || 'Заказ'}»${o.order_number ? ` (№ ${o.order_number})` : ''} убран из итогов.`, name)
                    if (r.error) setError(r.error); else { load(); onSent?.() }
                  }} />
              )}
              {isMaster && !mine && grantOfMessage(m) && !m.order_id && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}><GrantButton userId={userId} userName={name} feature={grantOfMessage(m)} onDone={() => { load(); onSent?.() }} /></div>
              )}
              {isMaster && !mine && m.order_id && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                  {grantOfMessage(m) && <GrantButton userId={userId} userName={name} feature={grantOfMessage(m)} onDone={() => { load(); onSent?.() }} />}
                  <button type="button" onClick={() => go(`/orders/${m.order_id}/nesting`)} style={{ padding: '4px 10px', borderRadius: 16, fontSize: 12, border: '0.5px solid var(--blue)', background: 'var(--blue-light)', color: 'var(--blue-dark)', cursor: 'pointer' }}>🧩 Раскрой заказа</button>
                  <button type="button" onClick={() => go(`/orders/${m.order_id}`)} style={{ padding: '4px 10px', borderRadius: 16, fontSize: 12, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text)', cursor: 'pointer' }}>📄 Заказ</button>
                </div>
              )}
              <div style={{ fontSize: 10.5, opacity: 0.75, textAlign: 'right', marginTop: 3 }}>
                {when(m.created_at)}{mine && 'read_at' in m ? (m.read_at ? ' · ✓✓ прочитано' : m.delivered_at ? ' · ✓✓ дошло' : ' · ✓') : ''}
              </div>
            </div>
          )
        })}
        <div ref={endRef} />
      </div>
      <div style={{ background: 'var(--bg)', borderTop: '0.5px solid var(--border-md)', padding: '0 10px 8px' }}>
        {/* полоска: потянуть вверх — поле ответа выше (прочитать длинный текст), вниз — ниже; двойной тап — снова по тексту */}
        <div onPointerDown={gripDown} onPointerMove={gripMove} onPointerUp={gripUp} onPointerCancel={gripUp} onDoubleClick={() => setTaH(0)}
          title="Потяните вверх — поле ответа выше" style={{ height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'ns-resize', touchAction: 'none' }}>
          <span style={{ width: 48, height: 5, borderRadius: 3, background: 'var(--border-md)' }} />
        </div>
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
            <textarea ref={taRef} value={text} onChange={e => setText(e.target.value)} onPaste={onPaste} rows={2} placeholder="Ответ… (скриншот можно вставить: Ctrl+V)"
              style={{ flex: 1, minWidth: 0, fontSize: 14, resize: 'none', padding: '8px 10px', lineHeight: 1.4, overflowY: 'auto' }} />
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
