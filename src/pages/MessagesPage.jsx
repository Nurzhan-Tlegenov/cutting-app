import { MenuButton } from '../components/NavDrawer'
import { Suspense, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import BottomNav from '../components/BottomNav'
import CncLoader from '../components/CncLoader'
import { receipt } from '../lib/messages'
import { excludeRequest, listMessages, sendAppeal, sendAppealFiles, REPORT_MAX_MB, sendNews, sendReply, deleteMessage, messagePayload, markSeen, isIncoming, payloadBlob } from '../lib/messages'
import { getUserSettings } from '../lib/userSettings'
import { adminProductionOrders } from '../lib/adminApi'
import { productionExcludeStats } from '../lib/productionApi'
import { orderTitle } from '../lib/orderUtils'
import { markNewsSeen, adminNewsViews } from '../lib/activity'
import { isNestingFileName } from '../lib/nestingFile'
import { lazyRetry } from '../lib/lazyRetry'
const NestingFileViewer = lazyRetry(() => import('../components/NestingFileViewer'))

// Сообщения: у пользователя — новости мастер-аккаунта, ответы и свои обращения;
// у мастер-аккаунта — обращения и файлы для отладки от пользователей (видно, от кого), новости для всех.
const when = v => (v ? new Date(v).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '')
const KIND = { news: ['Новость', 'var(--blue-light)', 'var(--blue-dark)'], appeal: ['Обращение', 'var(--amber-light)', 'var(--amber)'], reply: ['Сообщение', 'var(--teal-light)', 'var(--teal)'], debug: ['Файл для отладки', '#F3E5F5', '#7B1FA2'], order: ['По заказу', 'var(--teal-light)', 'var(--teal)'] }
const sizeTxt = n => (n > 1048576 ? (n / 1048576).toFixed(1) + ' МБ' : n > 1024 ? Math.round(n / 1024) + ' КБ' : (n || 0) + ' Б')

function download(name, text) {
  const url = URL.createObjectURL(payloadBlob(text))   // импортированный файл (Базис, Астра, Excel…) приходит двоичным — восстанавливаем как был
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
  const [files, setFiles] = useState([])            // файлы к обращению (модели Базиса, Астры, К3 и т. п.)
  const fileRef = useRef(null)
  const [replyTo, setReplyTo] = useState(null)      // сообщение, на которое отвечает мастер-аккаунт
  const [replyText, setReplyText] = useState('')
  const [views, setViews] = useState(null)          // мастер: просмотры новостей { byId, users }
  const [viewersOf, setViewersOf] = useState(null)  // мастер: у какой новости раскрыт список прочитавших
  const [seenAt] = useState(() => getUserSettings(user).msgSeenAt || '')   // что было непрочитанным на момент открытия

  const load = async () => {
    const r = await listMessages()
    if (r.error) { setError(r.error); setList([]); return }
    setError(''); setList(r.data)
    if (isMaster) adminNewsViews().then(v => { if (!v.error) setViews(v.data) })
    else markNewsSeen(r.data.filter(m => m.kind === 'news').map(m => m.id))   // мастер видит, кто прочитал новость
    markSeen(user)
    if (!isMaster) receipt(true)                     // открыл «Сообщения» — ответы мастер-аккаунта прочитаны
    window.dispatchEvent(new Event('messages-seen'))
  }
  useEffect(() => { Promise.resolve().then(load) }, [user?.id])   // eslint-disable-line react-hooks/exhaustive-deps

  const post = async () => {
    const body = text.trim() || (files.length ? 'Файлы во вложении' : '')
    if (!body) return
    setBusy(true); setError('')
    const r = isMaster ? await sendNews(user, profile, title.trim(), body) : files.length ? await sendAppealFiles(user, profile, body, files) : await sendAppeal(user, profile, body)
    setBusy(false)
    if (r.error) { setError(r.error); return }
    setText(''); setTitle(''); setFiles([]); load()
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
  // мастер: файл раскроя из сообщения (или с компьютера) — открыть прямо здесь: карты листов и хронология с откатом
  const [nestView, setNestView] = useState(null)   // { fileName, text }
  const nestFileRef = useRef(null)
  const openNesting = async m => {
    const r = await messagePayload(m.id)
    if (r.error) { setError(r.error); return }
    setNestView({ fileName: r.fileName, text: r.payload })
  }
  const remove = async m => {
    if (!window.confirm('Удалить сообщение?')) return
    const r = await deleteMessage(m.id)
    if (r.error) setError(r.error); else setList(l => l.filter(x => x.id !== m.id))
  }

  // мастер-аккаунт: обращения «убрать тестовый заказ из итогов» — кнопка прямо в сообщении
  const [allOrders, setAllOrders] = useState(null)   // заказы всех производств (для таких обращений)
  const hasExcl = isMaster && (list || []).some(m => excludeRequest(m))
  useEffect(() => {
    if (!hasExcl || allOrders) return
    let alive = true
    adminProductionOrders().then(r => { if (alive) setAllOrders(r.data || []) })
    return () => { alive = false }
  }, [hasExcl])   // eslint-disable-line react-hooks/exhaustive-deps
  const findOrder = req => {
    if (!allOrders) return null
    if (req.orderId) return allOrders.find(o => o.id === req.orderId) || null
    const same = allOrders.filter(o => o.order_number === req.num)
    return same.length === 1 ? same[0] : same.find(o => o.status === 'done') || same[0] || null
  }
  const doExclude = async (m, o, on) => {
    if (!o) return
    if (on && !window.confirm(`Убрать заказ «${orderTitle(o)}»${o.order_number ? ` (№ ${o.order_number})` : ''} из итогов как тестовый?\nЕго сумма, листы и работы не будут считаться.`)) return
    setBusy(true)
    const r = await productionExcludeStats(o.id, on)
    setBusy(false)
    if (r.error) { setError(r.error); return }
    setAllOrders(l => (l || []).map(x => (x.id === o.id ? { ...x, excluded: on } : x)))
    if (on && m.from_id && window.confirm('Готово. Сообщить пользователю ответом?')) {
      const a = await sendReply(user, profile, m.from_id, `Тестовый заказ «${orderTitle(o)}»${o.order_number ? ` (№ ${o.order_number})` : ''} убран из итогов.`)
      if (a.error) setError(a.error); else load()
    }
  }

  const FILTERS = isMaster ? [['all', 'Все'], ['appeal', 'Обращения'], ['debug', 'Файлы'], ['news', 'Новости']] : [['all', 'Все'], ['news', 'Новости'], ['mine', 'Мои обращения']]
  const shown = (list || []).filter(m => filter === 'all' || (filter === 'mine' ? m.from_id === user?.id || m.kind === 'reply' : m.kind === filter))
  const chip = on => ({ flex: '0 0 auto', padding: '6px 12px', borderRadius: 20, border: 'none', fontSize: 12, background: on ? 'var(--blue)' : 'var(--bg)', color: on ? 'white' : 'var(--text-muted)' })
  const small = { padding: '5px 11px', borderRadius: 20, fontSize: 12, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text-muted)', whiteSpace: 'nowrap' }

  return (
    <div className="page page-read" style={{ paddingBottom: 100 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 12, paddingTop: 4 }}><MenuButton /><h1 style={{ fontSize: 18, fontWeight: 500 }}>Сообщения</h1></div>
      {error && <p className="error-text" style={{ marginBottom: 12 }}>{error}</p>}

      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ fontWeight: 500, fontSize: 14, marginBottom: 6 }}>{isMaster ? 'Новость для всех пользователей' : 'Написать разработчику'}</div>
        {isMaster && <input type="text" value={title} onChange={e => setTitle(e.target.value)} placeholder="Заголовок (необязательно)" style={{ marginBottom: 6, fontSize: 14 }} />}
        <textarea value={text} onChange={e => setText(e.target.value)} rows={3} style={{ fontSize: 14, resize: 'vertical' }}
          placeholder={isMaster ? 'Что нового в приложении…' : 'Вопрос, замечание или пожелание…'} />
        {!isMaster && (
          <div style={{ marginTop: 8 }}>
            <input ref={fileRef} type="file" multiple style={{ display: 'none' }}
              onChange={e => { const add = [...(e.target.files || [])]; e.target.value = ''; setFiles(fs => [...fs, ...add.filter(f => !fs.some(x => x.name === f.name && x.size === f.size))]) }} />
            <button type="button" onClick={() => fileRef.current?.click()} disabled={busy}
              style={{ ...small, color: 'var(--blue)', borderColor: 'var(--blue)' }}>📎 Прикрепить файлы</button>
            <span style={{ fontSize: 11, color: 'var(--text-hint)', marginLeft: 8 }}>модель, проект, Excel, фото — до {REPORT_MAX_MB} МБ вместе</span>
            {files.length > 0 && (
              <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {files.map((f, i) => (
                  <div key={f.name + i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, background: 'var(--bg2)', borderRadius: 8, padding: '4px 8px' }}>
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>📎 {f.name}</span>
                    <span style={{ color: 'var(--text-hint)', flexShrink: 0 }}>{sizeTxt(f.size)}</span>
                    <button type="button" onClick={() => setFiles(fs => fs.filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', color: 'var(--text-hint)', fontSize: 15, padding: 0 }}>×</button>
                  </div>
                ))}
                <span style={{ fontSize: 11, color: 'var(--text-hint)' }}>Файлы уйдут разработчику вместе с сообщением{files.length > 1 ? ' (одним архивом)' : ''}.</span>
              </div>
            )}
          </div>
        )}
        <button type="button" className="btn-primary" style={{ marginTop: 8 }} disabled={busy || (!text.trim() && !files.length)} onClick={post}>
          {busy ? 'Отправка…' : isMaster ? 'Опубликовать новость' : files.length ? `Отправить обращение и файлы (${files.length})` : 'Отправить обращение'}
        </button>
      </div>

      <div style={{ display: 'flex', gap: 6, overflowX: 'auto', marginBottom: 10, paddingBottom: 2 }}>
        {FILTERS.map(([k, l]) => <button key={k} type="button" style={chip(filter === k)} onClick={() => setFilter(k)}>{l}</button>)}
        {isMaster && <>
          <span style={{ flex: 1 }} />
          <button type="button" style={{ ...small, flex: '0 0 auto' }} title="Файл раскроя или истории раскроя (.json), присланный не через приложение"
            onClick={() => nestFileRef.current?.click()}>👁 Раскрой из файла…</button>
          <input ref={nestFileRef} type="file" accept=".json,application/json" style={{ display: 'none' }}
            onChange={async e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) setNestView({ fileName: f.name, text: await f.text() }) }} />
        </>}
      </div>

      {list === null ? <CncLoader label="Загружаем сообщения…" compact /> : !shown.length ? (
        <p style={{ fontSize: 13, color: 'var(--text-hint)', textAlign: 'center', padding: '24px 0' }}>Сообщений пока нет.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {shown.map(m => {
            const [kl, bg, fg] = KIND[m.kind] || KIND.news
            const mine = m.from_id === user?.id
            const fresh = isIncoming(m, user?.id, isMaster) && (!seenAt || m.created_at > seenAt)
            const excl = isMaster && !mine ? excludeRequest(m) : null
            const exclOrder = excl ? findOrder(excl) : null
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
                {isMaster && mine && m.kind === 'reply' && / → /.test(m.from_name || '') && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 3 }}>Кому: <b style={{ color: 'var(--text)' }}>{(m.from_name || '').split(' → ').pop()}</b></div>}
                {!isMaster && mine && <div style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 3 }}>Вы писали</div>}
                {m.title && <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 2 }}>{m.title}</div>}
                {m.body && <div style={{ fontSize: 14, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.body.replace(/\n?Сделать: Профиль → Заказы всех производств[^\n]*/, '')}</div>}
                {m.file_name && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, fontFamily: 'monospace', wordBreak: 'break-all' }}>📎 {m.file_name} · {sizeTxt(m.file_size)}</div>}
                {/* мастер-аккаунт: дошёл ли ответ и прочитан ли — галочки как в мессенджерах */}
                {isMaster && mine && m.kind === 'reply' && 'read_at' in m && (
                  <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 5, marginTop: 4, fontSize: 11.5, color: m.read_at ? 'var(--blue)' : 'var(--text-hint)' }}
                    title={m.read_at ? `Прочитано ${when(m.read_at)}` : m.delivered_at ? `Дошло ${when(m.delivered_at)} — ещё не открыл «Сообщения»` : 'Отправлено — пользователь ещё не открывал приложение'}>
                    <span>{m.read_at ? `прочитано ${when(m.read_at)}` : m.delivered_at ? `дошло ${when(m.delivered_at)}` : 'отправлено'}</span>
                    <span style={{ fontWeight: 700, letterSpacing: -3, color: m.read_at ? 'var(--blue)' : 'var(--text-hint)' }}>{m.delivered_at || m.read_at ? '✓✓' : '✓'}</span>
                  </div>
                )}
                {isMaster && m.kind === 'news' && views && (() => {
                  const v = views.byId.get(m.id) || { viewers: [], audience: 0 }
                  const n = v.viewers.length, all = Math.max(v.audience, n)
                  const pct = all ? Math.round(n / all * 100) : 0
                  const open = viewersOf === m.id
                  return (
                    <div style={{ marginTop: 6 }}>
                      <button type="button" onClick={() => setViewersOf(open ? null : m.id)} title="Сколько пользователей открыли новость"
                        style={{ border: 'none', background: 'none', padding: 0, fontSize: 12.5, color: 'var(--text-muted)', cursor: 'pointer' }}>
                        👁 <b style={{ color: 'var(--text)' }}>{n}</b> из {all} · {pct}%{n > 0 ? (open ? ' ▾' : ' ▸') : ''}
                      </button>
                      {open && n > 0 && (
                        <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 220, overflowY: 'auto' }}>
                          {v.viewers.map(x => <div key={x.id}>{x.name || 'пользователь'} <span style={{ color: 'var(--text-hint)' }}>· {when(x.at)}</span></div>)}
                        </div>
                      )}
                    </div>
                  )
                })()}
                <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                  {isMaster && m.file_name && isNestingFileName(m.file_name) && <button type="button" style={{ ...small, color: 'white', background: 'var(--blue)', borderColor: 'var(--blue)' }} onClick={() => openNesting(m)}>👁 Открыть раскрой</button>}
                  {isMaster && m.file_name && <button type="button" style={{ ...small, color: 'var(--teal)', borderColor: 'var(--teal)' }} onClick={() => getFile(m)}>⬇ Скачать файл</button>}
                  {excl && (() => {
                    if (!allOrders) return <span style={{ fontSize: 12, color: 'var(--text-hint)', alignSelf: 'center' }}>ищем заказ…</span>
                    if (!exclOrder) return <button type="button" style={small} onClick={() => navigate(`/all-productions?num=${encodeURIComponent(excl.num)}`)}>Заказ не найден — открыть итоги</button>
                    return exclOrder.excluded
                      ? <><span style={{ fontSize: 12, color: 'var(--teal)', alignSelf: 'center' }}>✓ Уже не в итогах</span>
                          <button type="button" style={small} disabled={busy} onClick={() => doExclude(m, exclOrder, false)}>Вернуть в итоги</button></>
                      : <button type="button" style={{ ...small, color: 'white', background: 'var(--amber)', borderColor: 'var(--amber)' }} disabled={busy} onClick={() => doExclude(m, exclOrder, true)}>Убрать из итогов</button>
                  })()}
                  {excl && exclOrder && <button type="button" style={small} onClick={() => navigate(`/all-productions?order=${exclOrder.id}`)}>Итоги производства</button>}
                  {m.kind === 'order' && m.order_id && <button type="button" style={{ ...small, color: 'var(--blue)', borderColor: 'var(--blue)' }} onClick={() => navigate(`/orders/${m.order_id}#order-chat`)}>Открыть заказ и ответить</button>}
                  {isMaster && m.order_id && !excl && m.kind !== 'order' && <button type="button" style={small} onClick={() => navigate(`/orders/${m.order_id}/nesting`)}>Открыть заказ</button>}
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
      {nestView && <Suspense fallback={null}><NestingFileViewer fileName={nestView.fileName} text={nestView.text} onClose={() => setNestView(null)} /></Suspense>}
    </div>
  )
}
