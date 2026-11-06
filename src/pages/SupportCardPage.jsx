import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import CncLoader from '../components/CncLoader'
import SupportNotes from '../components/SupportNotes'
import SupportOrders from '../components/SupportOrders'
import { isImageFile, payloadBlob, excludeRequest } from '../lib/messages'
import ExcludeStatsRequest from '../components/ExcludeStatsRequest'
import { supportTaskFromCard } from '../lib/tasks'
import { useIsSupport, supportCard, supportFile, supportTake, supportAssign, supportMove, supportReply, supportSummary,
  supportDevDecide, supportClose, supportReopen, supportMerge, supportTeam, SUPPORT_COLS, SUPPORT_CLOSED, DETAIL_TEMPLATES, DONE_TEXT, supAgo } from '../lib/support'

const dt = v => (v ? new Date(v).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '')
const COL = Object.fromEntries(SUPPORT_COLS.map(([k, t, c]) => [k, [t, c]]))
const stLabel = s => (COL[s] || SUPPORT_CLOSED[s] || [s])[0]
const stColor = s => (COL[s] || SUPPORT_CLOSED[s] || ['', 'var(--gray)'])[1]
const ACT = { created: 'обращение пришло', message: 'автор написал', take: 'взял', move: 'перенёс', assign: 'передал', reply: 'ответил',
  summary: '«Кратко»', note: 'заметка', dev_take: 'берём в разработку', dev_reject: 'не берём (разработка)', close: 'закрыл', reopen: 'вернул из архива', merge: 'объединил' }
const kb = n => (n > 1048576 ? `${(n * 0.75 / 1048576).toFixed(1)} МБ` : `${Math.max(1, Math.round(n * 0.75 / 1024))} КБ`)

// Карточка обращения: автор (кратко, без телефона), переписка с файлами, ответ, действия по колонкам, «Кратко», история.
export default function SupportCardPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user, isMaster } = useAuth()
  const ok = useIsSupport(user?.id)
  const [d, setD] = useState(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [text, setText] = useState('')
  const [summary, setSummary] = useState('')
  const [dlg, setDlg] = useState(null)        // { kind: 'details' | 'dev' | 'done' | 'rejected' | 'dev_take' | 'dev_reject' | 'assign' }
  const [team, setTeam] = useState(null)
  const [hist, setHist] = useState(false)
  const endRef = useRef(null)

  const load = useCallback(async () => {
    const r = await supportCard(id)
    if (r.error) { setErr(r.error); return }
    setD(r.data || false); setSummary(r.data?.card?.summary || '')
  }, [id])
  useEffect(() => {
    if (!ok) return
    const t = setTimeout(load, 0)
    const iv = setInterval(load, 30000)
    return () => { clearTimeout(t); clearInterval(iv) }
  }, [ok, load])
  useEffect(() => { if (d?.messages?.length) endRef.current?.scrollIntoView({ block: 'end' }) }, [d?.messages?.length])

  const run = async (fn, after) => {
    setBusy(true); setErr('')
    const r = await fn()
    setBusy(false)
    if (r?.error) { setErr(r.error); return false }
    after?.(); await load(); return true
  }

  if (ok === undefined || (ok && d === null && !err)) return <div className="page"><CncLoader label="Открываем обращение…" /></div>
  if (!ok) return <div className="page"><p style={{ fontSize: 13 }}>Раздел для сотрудников поддержки.</p></div>
  if (d === false) return <div className="page"><p style={{ fontSize: 13, marginBottom: 10 }}>Карточка не найдена (возможно, объединена с другой).</p><button type="button" className="btn-secondary" onClick={() => navigate('/support')}>К доске</button></div>
  if (!d) return <div className="page"><p className="error-text">{err}</p><button type="button" className="btn-secondary" onClick={() => navigate('/support')}>К доске</button></div>

  const c = d.card, a = d.author || {}
  const closed = !!SUPPORT_CLOSED[c.status]
  const mine = c.taken_by === user?.id
  const canClose = !closed && (c.status !== 'dev' || isMaster)
  const send = () => { const b = text.trim(); if (b) run(() => supportReply(c.id, b), () => setText('')) }
  // закрыть диалог одним нажатием: решено — в архив, пользователю ничего не уходит (с сообщением — «✓ Сделано»).
  // Напишет снова — откроется новый диалог (новая карточка), история этого остаётся в архиве
  const closeQuick = async () => {
    if (!window.confirm('Закрыть диалог? Он уйдёт в архив как решённый, пользователю ничего не придёт. Напишет снова — откроется новый диалог.')) return
    if (await run(() => supportClose(c.id, 'done', ''))) navigate('/support')
  }
  // задача команды поддержки по этому обращению — на доску «📌 Задачи»
  const toTask = async () => {
    const last = [...d.messages].reverse().find(m => !m.staff && (m.body || m.file_name))
    const title = (c.summary || '').trim() || `№${c.num} · ${c.author}`
    const note = [`Обращение №${c.num} · ${c.author}`, last?.body ? last.body.slice(0, 600) : last?.file_name ? '📎 ' + last.file_name : ''].filter(Boolean).join('\n')
    setBusy(true); setErr('')
    const r = await supportTaskFromCard({ cardId: c.id, title, note })
    setBusy(false)
    if (r.error) { setErr(r.error); return }
    navigate(`/support?tasks=1&card=${r.data.id}`)
  }
  const openAssign = async () => { setDlg({ kind: 'assign' }); if (!team) { const r = await supportTeam(); setTeam(r.data || []) } }
  const btn = (label, onClick, style = {}, cls = 'btn-secondary') => <button type="button" disabled={busy} className={cls} onClick={onClick} style={{ width: 'auto', padding: '7px 11px', fontSize: 12.5, ...style }}>{label}</button>

  const who = [
    a.production ? `🏭 ${a.production.name}${a.production.status && a.production.status !== 'approved' ? ' (ждёт подтверждения)' : ''}` : '',
    ...(a.works_at || []).map(w => `👷 сотрудник «${w.name}»`),
    !a.production && !(a.works_at || []).length ? 'клиент' : '',
  ].filter(Boolean).join(' · ')
  const posts = [...new Set([...(a.posts_granted || []), ...(a.posts_used || [])])]

  return (
    <div className="page" style={{ paddingBottom: 140 }}>
      {/* шапка закреплена сверху: выйти к доске можно из любого места переписки, не листая наверх */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, padding: '6px 0', position: 'sticky', top: 0, zIndex: 40, background: 'var(--bg)', borderBottom: '0.5px solid var(--border)' }}>
        <button type="button" onClick={() => navigate('/support')} aria-label="К доске" style={{ background: 'none', border: 'none', fontSize: 26, lineHeight: 1, color: 'var(--blue)', cursor: 'pointer', padding: '0 6px' }}>‹</button>
        <h1 style={{ fontSize: 17, fontWeight: 500, flex: 1, minWidth: 0 }}>№{c.num} · {c.author}</h1>
        <span style={{ fontSize: 12, padding: '3px 10px', borderRadius: 12, color: '#fff', background: stColor(c.status), flexShrink: 0 }}>{stLabel(c.status)}</span>
        {canClose && <button type="button" disabled={busy} onClick={closeQuick} title="Закрыть диалог: решено, в архив"
          style={{ flexShrink: 0, padding: '4px 9px', fontSize: 12, borderRadius: 12, border: '1px solid var(--teal)', background: 'transparent', color: 'var(--teal)', cursor: 'pointer' }}>🔒 Закрыть</button>}
      </div>

      {/* автор — кратко, без телефона */}
      <div className="card" style={{ marginBottom: 10, fontSize: 13 }}>
        <div style={{ fontWeight: 600 }}>{a.full_name || c.author}</div>
        <div style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>{[who, [a.city, a.country].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}</div>
        {posts.length > 0 && <div style={{ fontSize: 12, marginTop: 4 }}>⚙ Постпроцессоры: {posts.join(', ')}</div>}
        {a.machines?.length > 0 && <div style={{ fontSize: 12, marginTop: 2 }}>🛠 Станки: {a.machines.join('; ')}</div>}
        <div style={{ fontSize: 11.5, color: 'var(--text-hint)', marginTop: 4 }}>
          {a.since ? `в приложении с ${new Date(a.since).toLocaleDateString('ru-RU')}` : ''}{a.orders != null ? ` · заказов: ${a.orders}` : ''}
          {c.taken_by ? ` · занимается: ${mine ? 'вы' : c.taken_name}` : ' · никто не взял'}
        </div>
      </div>

      {/* действия */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        {!closed && !mine && btn(c.taken_by ? 'Забрать себе' : '✋ Беру', () => run(() => supportTake(c.id)), {}, 'btn-primary')}
        {!closed && btn('Передать…', openAssign)}
        {!closed && c.status !== 'new' && btn('↩ В «Новые»', () => run(() => supportMove(c.id, 'new')))}
        {!closed && c.status !== 'work' && c.status !== 'new' && btn('В работу', () => run(() => supportMove(c.id, 'work')))}
        {!closed && btn('❓ Нужны подробности', () => setDlg({ kind: 'details', picked: [], text: '' }))}
        {!closed && c.status !== 'dev' && btn('🛠 Нужен разработчик', () => setDlg({ kind: 'dev', text: '' }))}
        {!closed && c.status === 'dev' && isMaster && !c.dev_ok && btn('✓ Берём в разработку', () => setDlg({ kind: 'dev_take', text: '' }), { color: '#7B1FA2', borderColor: '#7B1FA2' })}
        {!closed && c.status === 'dev' && isMaster && btn('✕ Не берём', () => setDlg({ kind: 'dev_reject', text: '' }), { color: 'var(--danger)', borderColor: 'var(--danger)' })}
        {canClose && btn('✓ Сделано — с сообщением', () => setDlg({ kind: 'done', text: DONE_TEXT }), { color: 'var(--teal)', borderColor: 'var(--teal)' })}
        {canClose && c.status !== 'dev' && btn('Не берём', () => setDlg({ kind: 'rejected', text: '' }), { color: 'var(--danger)', borderColor: 'var(--danger)' })}
        {closed && btn('↩ Вернуть из архива', () => run(() => supportReopen(c.id)))}
        {btn('📌 В задачи', toTask)}
      </div>
      {c.status === 'dev' && <div style={{ fontSize: 12, color: '#7B1FA2', marginBottom: 8 }}>{c.dev_ok ? '✓ Мастер: берём в разработку. Когда будет готово — «Сделано».' : 'Ждёт решения мастер-аккаунта: «Берём в разработку» или «Не берём».'}</div>}
      {closed && c.close_note && <div style={{ fontSize: 12, color: stColor(c.status), marginBottom: 8 }}>{stLabel(c.status)} {dt(c.closed_at)}: {c.close_note}</div>}
      {err && <p className="error-text" style={{ fontSize: 12, marginBottom: 8 }}>{err}</p>}

      {/* Кратко */}
      <div className="card" style={{ marginBottom: 10, padding: '8px 10px' }}>
        <div style={{ fontSize: 12, color: 'var(--text-hint)', marginBottom: 3 }}>Кратко — суть обращения (видит только поддержка, пойдёт в пакет для разработчика)</div>
        <textarea value={summary} onChange={e => setSummary(e.target.value)} rows={2} placeholder="Например: шестисторонний XML — теряется зенковка на еврошурупах"
          onBlur={() => { if (summary.trim() !== (c.summary || '')) run(() => supportSummary(c.id, summary)) }}
          style={{ width: '100%', fontSize: 13, resize: 'vertical' }} />
      </div>

      {/* переписка */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {d.messages.map(m => (
          <div key={m.id} style={{ alignSelf: m.staff ? 'flex-end' : 'flex-start', maxWidth: '88%', background: m.staff ? 'var(--teal-light)' : 'var(--bg)', border: m.staff ? 'none' : '0.5px solid var(--border)',
            borderRadius: 12, padding: '7px 10px', fontSize: 13 }}>
            <div style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 2 }}>
              {m.staff ? `Поддержка · ${m.staff_name}` : c.author}{m.kind === 'debug' ? ' · файл для отладки' : ''} · {dt(m.created_at)}{m.staff && m.read_at ? ' · ✓✓' : ''}
            </div>
            {m.title && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{m.title}</div>}
            {m.body && <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.body}</div>}
            {m.file_name && <FileItem m={m} onError={setErr} />}
            {m.order_id && <div style={{ fontSize: 11.5, color: 'var(--text-hint)', marginTop: 3 }}>🧩 приложен заказ — см. «Заказы из обращения» ниже</div>}
            {/* просьба убрать тестовый заказ из итогов — кнопки прямо здесь (раньше были только в «Сообщениях») */}
            {isMaster && !m.staff && excludeRequest(m) && (
              <ExcludeStatsRequest req={excludeRequest(m)} onError={setErr}
                onDone={(o, on) => { if (on && !closed && window.confirm('Готово. Сообщить пользователю ответом?')) run(() => supportReply(c.id, `Тестовый заказ «${String(o.order_name || '').trim() || o.order_number || 'Заказ'}»${o.order_number ? ` (№ ${o.order_number})` : ''} убран из итогов.`)) }} />
            )}
          </div>
        ))}
        {!d.messages.length && <p style={{ fontSize: 13, color: 'var(--text-hint)' }}>Сообщений нет.</p>}
        <div ref={endRef} />
      </div>

      {/* заказы из обращения (просмотр) и пакет для разработчика */}
      <SupportOrders cardId={c.id} messagesKey={d.messages.length} />

      {/* внутренние заметки — пользователь их не видит */}
      <div className="card" style={{ marginTop: 14, padding: '9px 10px', background: 'var(--amber-light)', border: 'none' }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>🔒 Заметки поддержки <span style={{ fontWeight: 400, fontSize: 11.5, color: 'var(--text-muted)' }}>— пользователь их не видит</span></div>
        <SupportNotes cardId={c.id} me={user?.id} isMaster={isMaster} />
      </div>

      {/* другие карточки автора */}
      {d.others?.length > 0 && (
        <div style={{ marginTop: 14, fontSize: 12.5 }}>
          <div style={{ color: 'var(--text-hint)', marginBottom: 4 }}>Другие обращения этого пользователя</div>
          {d.others.map(o => (
            <div key={o.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', borderTop: '0.5px solid var(--border)' }}>
              <span role="button" tabIndex={0} onClick={() => navigate(`/support/${o.id}`)} onKeyDown={e => { if (e.key === 'Enter') navigate(`/support/${o.id}`) }}
                style={{ flex: 1, color: 'var(--blue)', cursor: 'pointer' }}>№{o.num} · {stLabel(o.status)} · {supAgo(o.created_at)}</span>
              <button type="button" className="btn-secondary" disabled={busy} style={{ width: 'auto', padding: '3px 8px', fontSize: 11.5 }}
                onClick={() => { if (window.confirm(`Перенести сообщения из №${o.num} в эту карточку? №${o.num} исчезнет.`)) run(() => supportMerge(o.id, c.id)) }}>Объединить сюда</button>
            </div>
          ))}
        </div>
      )}

      {/* история */}
      <div style={{ marginTop: 14 }}>
        <button type="button" onClick={() => setHist(v => !v)} style={{ background: 'none', border: 'none', color: 'var(--blue)', fontSize: 12.5, padding: 0, cursor: 'pointer' }}>
          История карточки ({d.events.length}) {hist ? '▴' : '▾'}</button>
        {hist && d.events.map((e, i) => (
          <div key={i} style={{ fontSize: 12, padding: '4px 0', borderTop: '0.5px solid var(--border)' }}>
            <span style={{ color: 'var(--text-hint)' }}>{dt(e.at)}</span> · <b style={{ fontWeight: 500 }}>{e.actor_name}</b> — {ACT[e.action] || e.action}
            {e.to_status && e.from_status !== e.to_status && (e.action === 'move' || e.action === 'take' || e.action === 'close' || e.action === 'reopen') ? ` → ${stLabel(e.to_status)}` : ''}
            {e.note ? <span style={{ color: 'var(--text-muted)' }}>: {e.note.length > 160 ? e.note.slice(0, 160) + '…' : e.note}</span> : ''}
          </div>
        ))}
      </div>

      {/* ответ пользователю */}
      <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, background: 'var(--bg)', borderTop: '0.5px solid var(--border)', padding: '8px 12px calc(8px + env(safe-area-inset-bottom))', zIndex: 50 }}>
        <div style={{ maxWidth: 720, margin: '0 auto', display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <textarea value={text} onChange={e => setText(e.target.value)} rows={text.split('\n').length > 2 ? 4 : 2} placeholder="Ответ пользователю — придёт в «Сообщения» и пушем, подпись «Поддержка RaskroyPro»"
            style={{ flex: 1, minWidth: 0, width: 'auto', fontSize: 13, resize: 'none' }} />
          <button type="button" className="btn-primary" disabled={busy || !text.trim()} onClick={send} style={{ width: 'auto', flexShrink: 0, padding: '9px 14px' }}>➤</button>
        </div>
      </div>

      {dlg && <ActionDialog dlg={dlg} setDlg={setDlg} team={team} me={user?.id} busy={busy} onSubmit={async v => {
        const fn = {
          details: () => supportReply(c.id, v.text, 'details'),
          dev: () => supportMove(c.id, 'dev', v.text),
          dev_take: () => supportDevDecide(c.id, true, v.text),
          dev_reject: () => supportDevDecide(c.id, false, v.text),
          done: () => supportClose(c.id, 'done', v.text),
          rejected: () => supportClose(c.id, 'rejected', v.text),
          assign: () => supportAssign(c.id, v.user),
        }[dlg.kind]
        if (await run(fn, () => setDlg(null)) && (dlg.kind === 'done' || dlg.kind === 'rejected' || dlg.kind === 'dev_reject')) navigate('/support')
      }} />}
    </div>
  )
}

// Файл из переписки: картинка — показать здесь, остальное — скачать
function FileItem({ m, onError }) {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => () => { if (url) URL.revokeObjectURL(url) }, [url])
  const img = isImageFile({ name: m.file_name })
  const get = async () => {
    setBusy(true)
    const r = await supportFile(m.id)
    setBusy(false)
    if (r.error || !r.data) { onError(r.error || 'Файл не найден'); return }
    const u = URL.createObjectURL(payloadBlob(r.data.payload || ''))
    if (img) { setUrl(u); return }
    const el = document.createElement('a'); el.href = u; el.download = r.data.file_name || m.file_name || 'file'; document.body.appendChild(el); el.click(); el.remove()
    setTimeout(() => URL.revokeObjectURL(u), 60000)
  }
  if (url) return <img src={url} alt={m.file_name} onClick={() => window.open(url, '_blank')} style={{ display: 'block', maxWidth: '100%', maxHeight: 320, borderRadius: 8, marginTop: 4, cursor: 'zoom-in' }} />
  return <button type="button" disabled={busy} onClick={get} style={{ display: 'block', marginTop: 4, background: 'none', border: '0.5px solid var(--border)', borderRadius: 8, padding: '4px 8px', fontSize: 12, color: 'var(--blue)', cursor: 'pointer', textAlign: 'left' }}>
    📎 {m.file_name}{m.file_size ? ` · ${kb(m.file_size)}` : ''} {busy ? '…' : img ? '— показать' : '— скачать'}
  </button>
}

// Окно действия: подробности (шаблоны), разработчик, сделано / не берём, передать
function ActionDialog({ dlg, setDlg, team, me, busy, onSubmit }) {
  const k = dlg.kind
  const title = { details: 'Нужны подробности', dev: 'Нужен разработчик', dev_take: 'Берём в разработку', dev_reject: 'Не берём — разработка', done: 'Сделано', rejected: 'Не берём', assign: 'Передать обращение' }[k]
  const hint = {
    details: 'Отметьте, что попросить, — текст уйдёт пользователю, карточка перейдёт в «Нужны подробности». Когда он ответит, карточка сама вернётся в работу.',
    dev: 'Коротко для мастер-аккаунта: что надо сделать (пользователю не уходит). Решение «берём / не берём» — за мастером.',
    dev_take: 'Сообщение пользователю (необязательно), например: «Взяли в разработку, сообщим, когда будет готово».',
    dev_reject: 'Причина для пользователя — обязательно. Карточка уйдёт в архив.',
    done: 'Сообщение пользователю (можно стереть — тогда ничего не уйдёт). Карточка уйдёт в архив.',
    rejected: 'Причина для пользователя — обязательно. Карточка уйдёт в архив.',
  }[k]
  const need = k === 'rejected' || k === 'dev_reject' || k === 'details'
  const toggleTpl = t => {
    const picked = dlg.picked.includes(t[0]) ? dlg.picked.filter(x => x !== t[0]) : [...dlg.picked, t[0]]
    const body = ['Здравствуйте! Чтобы разобраться, нужно чуть больше информации:', ...DETAIL_TEMPLATES.filter(x => picked.includes(x[0])).map(x => '• ' + x[1])].join('\n')
    setDlg({ ...dlg, picked, text: picked.length ? body : '' })
  }
  return (
    <div onClick={() => setDlg(null)} style={{ position: 'fixed', inset: 0, zIndex: 2100, background: 'rgba(0,0,0,.38)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 560, maxHeight: '88vh', overflowY: 'auto', background: 'var(--bg)', borderRadius: '18px 18px 0 0', padding: '14px 16px calc(18px + env(safe-area-inset-bottom))' }}>
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>{title}</div>
        {hint && <p style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 8 }}>{hint}</p>}
        {k === 'assign' ? (
          !team ? <p style={{ fontSize: 13, color: 'var(--text-hint)' }}>Загружаем…</p> : team.filter(t => t.user_id !== me).map(t => (
            <button key={t.user_id} type="button" disabled={busy} className="btn-secondary" onClick={() => onSubmit({ user: t.user_id })}
              style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 6, padding: '9px 12px' }}>{t.master ? '👑 ' : '🎧 '}{t.full_name}</button>
          ))
        ) : <>
          {k === 'details' && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
              {DETAIL_TEMPLATES.map(t => (
                <button key={t[0]} type="button" onClick={() => toggleTpl(t)} className={dlg.picked.includes(t[0]) ? 'btn-primary' : 'btn-secondary'}
                  style={{ width: 'auto', padding: '5px 10px', fontSize: 12.5 }}>{t[0]}</button>
              ))}
            </div>
          )}
          <textarea value={dlg.text} onChange={e => setDlg({ ...dlg, text: e.target.value })} rows={5} autoFocus={k !== 'details'}
            style={{ width: '100%', fontSize: 13, resize: 'vertical' }} />
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button type="button" className="btn-secondary" style={{ flex: 1 }} onClick={() => setDlg(null)}>Отмена</button>
            <button type="button" className="btn-primary" style={{ flex: 2 }} disabled={busy || (need && !dlg.text.trim())} onClick={() => onSubmit({ text: dlg.text.trim() })}>
              {k === 'details' ? 'Отправить и ждать ответа' : k === 'dev' ? 'Передать мастеру' : k === 'dev_take' ? 'Берём' : k === 'done' ? (dlg.text.trim() ? 'Отправить и закрыть' : 'Закрыть без сообщения') : 'Отправить и закрыть'}
            </button>
          </div>
        </>}
      </div>
    </div>
  )
}
