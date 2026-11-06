import { useCallback, useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import SupportNotes from '../components/SupportNotes'
import TasksPage from './TasksPage'
import { useAuth } from '../context/AuthContext'
import { MenuButton } from '../components/NavDrawer'
import BottomNav from '../components/BottomNav'
import CncLoader from '../components/CncLoader'
import { UserName } from '../components/UserCard'
import { useIsSupport, useSupportStaff, setSupport, supportTeam, supportBoard, supportTake, supportClose, supportArchiveLegacy, supportNotes, supportConfig, setSupportStaffPack, chatSeenAt, markChatSeen,
  SUPPORT_COLS, SUPPORT_CLOSED, supAgo } from '../lib/support'

const date = v => (v ? new Date(v).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '')
const useWide = () => {
  const [w, setW] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 400))
  useEffect(() => { const f = () => setW(window.innerWidth); window.addEventListener('resize', f); return () => window.removeEventListener('resize', f) }, [])
  return w >= 900
}

// «Поддержка» — доска обращений для мастер-аккаунта и сотрудников поддержки (claude/support-spec.md, migration_support_board.sql).
// Колонки: Новые → В работе → Нужны подробности → Нужен разработчик; Сделано / Не берём — в архиве (с поиском).
// Телефон: колонки — вкладками; монитор — рядом.
export default function SupportPage() {
  const { user, isMaster } = useAuth()
  const navigate = useNavigate()
  const ok = useIsSupport(user?.id)
  const wide = useWide()
  const [cards, setCards] = useState(null)
  const [err, setErr] = useState('')
  const [col, setCol] = useState(() => { try { return sessionStorage.getItem('supCol') || 'new' } catch { return 'new' } })
  const [archive, setArchive] = useState(false)
  const [q, setQ] = useState('')
  const loc = useLocation()
  // «Задачи» — общий канбан команды поддержки (из головы и по обращениям); ?tasks=1 — сразу на нём (из пуша, из обращения)
  const [tasks, setTasksRaw] = useState(() => new URLSearchParams(loc.search).get('tasks') === '1')
  useEffect(() => { if (new URLSearchParams(loc.search).get('tasks') === '1') Promise.resolve().then(() => setTasksRaw(true)) }, [loc.search])
  const setTasks = v => { setTasksRaw(v); if (!v && /tasks=1/.test(loc.search)) navigate('/support', { replace: true }) }
  const [team, setTeam] = useState(() => (new URLSearchParams(loc.search).get('chat') ? 'chat' : ''))   // '' — доска, 'chat' — чат команды, 'team' — команда
  const [chatNew, setChatNew] = useState(0)
  const [busy, setBusy] = useState('')

  const load = useCallback(async () => {
    const r = await supportBoard(archive, archive ? q : '')
    if (r.error) { setErr(r.error); setCards([]) } else { setErr(''); setCards(r.data || []) }
  }, [archive, q])
  useEffect(() => {
    if (!ok) return
    const t = setTimeout(load, archive ? 350 : 0)
    if (archive) return () => clearTimeout(t)
    const iv = setInterval(load, 30000)          // доска обновляется сама раз в 30 с
    return () => { clearTimeout(t); clearInterval(iv) }
  }, [ok, load, archive])
  // новые сообщения в чате команды (с прошлого открытия чата)
  useEffect(() => {
    if (!ok) return
    if (team === 'chat') return () => markChatSeen()   // ушли из чата — всё, что пришло, пока он был открыт, прочитано
    let alive = true
    const check = () => supportNotes(null).then(r => { if (alive && r.data) { const seen = chatSeenAt(); setChatNew(r.data.filter(n => n.author !== user?.id && (!seen || n.created_at > seen)).length) } })
    const t = setTimeout(check, 0), iv = setInterval(check, 30000)
    return () => { alive = false; clearTimeout(t); clearInterval(iv) }
  }, [ok, team, user?.id])
  const openView = v => { if (v === 'chat') { markChatSeen(); setChatNew(0) } setTeam(t => (t === v ? '' : v)) }
  const pickCol = c => { setCol(c); try { sessionStorage.setItem('supCol', c) } catch { /* без памяти */ } }

  const head = <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 10, paddingTop: 4 }}><MenuButton /><h1 style={{ fontSize: 18, fontWeight: 500, flex: 1 }}>Поддержка</h1>
    {ok && team && <button type="button" className="btn-secondary" style={{ width: 'auto', padding: '5px 10px', fontSize: 12 }} onClick={() => setTeam('')}>К доске</button>}
    {ok && team !== 'chat' && <button type="button" className="btn-secondary" style={{ width: 'auto', padding: '5px 10px', fontSize: 12, marginLeft: 4, position: 'relative' }} onClick={() => openView('chat')}>💬 Чат
      {chatNew > 0 && <span style={{ position: 'absolute', top: -6, right: -6, minWidth: 18, height: 18, borderRadius: 9, background: 'var(--danger)', color: '#fff', fontSize: 11, lineHeight: '18px', padding: '0 4px' }}>{chatNew}</span>}</button>}
    {ok && team !== 'team' && <button type="button" className="btn-secondary" style={{ width: 'auto', padding: '5px 10px', fontSize: 12, marginLeft: 4 }} onClick={() => openView('team')}>👥 Команда</button>}</div>
  if (ok === undefined) return <div className="page"><CncLoader label="Открываем…" /></div>
  if (!ok) return (
    <div className="page" style={{ paddingBottom: 100 }}>{head}
      <div className="card"><p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 10 }}>Этот раздел — для сотрудников поддержки RaskroyPro. Вопрос или проблема? Напишите нам — ответ придёт в «Сообщения».</p>
        <button type="button" className="btn-primary" onClick={() => navigate('/messages?write=1')}>Написать в поддержку</button></div>
      <BottomNav />
    </div>
  )
  if (team === 'team') return <div className="page" style={{ paddingBottom: 100 }}>{head}<TeamBlock isMaster={isMaster} me={user?.id} /><BottomNav /></div>
  if (team === 'chat') return (
    <div className="page" style={{ paddingBottom: 100 }}>{head}
      <div className="card">
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 2 }}>Чат команды поддержки</div>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>Мастер-аккаунт и сотрудники поддержки. Пользователи его не видят.</p>
        <SupportNotes me={user?.id} isMaster={isMaster} tall onSent={markChatSeen} />
      </div>
      <BottomNav />
    </div>
  )

  // закрыть диалог: обращение решено / ответ дан — в архив, пользователю ничего не уходит. Напишет снова — будет новая карточка
  const closeQuick = async (e, c) => {
    e.stopPropagation()
    if (!window.confirm(`Закрыть диалог №${c.num} (${c.author})? Он уйдёт в архив как решённый, пользователю ничего не придёт. Напишет снова — откроется новый диалог.`)) return
    setBusy(c.id)
    const r = await supportClose(c.id, 'done', '')
    setBusy('')
    if (r.error) setErr(r.error); else load()
  }
  const take = async (e, c) => {
    e.stopPropagation(); setBusy(c.id)
    const r = await supportTake(c.id); setBusy('')
    if (r.error) setErr(r.error); else load()
  }
  const legacy = (cards || []).filter(c => c.legacy && c.status === 'new' && !c.taken_by).length
  const archiveLegacy = async () => {
    if (!window.confirm(`Отправить в архив старые обращения (${legacy}), которыми никто не занимался? Пользователям ничего не придёт.`)) return
    const r = await supportArchiveLegacy()
    if (r.error) setErr(r.error); else load()
  }

  const tile = c => {
    const fresh = c.last_user_at && (!c.last_staff_at || c.last_user_at > c.last_staff_at)
    const mine = c.taken_by === user?.id
    const closed = SUPPORT_CLOSED[c.status]
    return (
      <div key={c.id} role="button" tabIndex={0} onClick={() => navigate(`/support/${c.id}`)} onKeyDown={e => { if (e.key === 'Enter') navigate(`/support/${c.id}`) }}
        className="card" style={{ padding: '9px 11px', marginBottom: 8, cursor: 'pointer', borderLeft: `3px solid ${fresh && !closed ? 'var(--amber)' : 'transparent'}` }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span style={{ fontSize: 11, color: 'var(--text-hint)' }}>№{c.num}</span>
          <span style={{ fontSize: 13.5, fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.author}</span>
          <span style={{ fontSize: 11, color: 'var(--text-hint)', flexShrink: 0 }}>{supAgo(c.closed_at || c.last_user_at || c.created_at)}</span>
        </div>
        {(c.city || c.country) && <div style={{ fontSize: 11, color: 'var(--text-hint)' }}>{[c.city, c.country].filter(Boolean).join(', ')}</div>}
        <div style={{ fontSize: 12.5, color: c.summary ? 'var(--text)' : 'var(--text-muted)', marginTop: 3, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
          {c.summary ? <b style={{ fontWeight: 500 }}>{c.summary}</b> : (c.last_text || '—')}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 11.5, color: 'var(--text-hint)', flexWrap: 'wrap' }}>
          {closed ? <span style={{ color: closed[1] }}>{closed[0]}</span>
            : c.taken_by ? <span style={{ color: mine ? 'var(--teal)' : 'var(--text-muted)' }}>👤 {mine ? 'вы' : c.taken_name}</span> : <span>никто не взял</span>}
          {c.status === 'dev' && c.dev_ok && <span style={{ color: '#7B1FA2' }}>✓ в разработке</span>}
          {fresh && !closed && <span style={{ color: 'var(--amber)' }}>● ждёт ответа</span>}
          {c.files > 0 && <span>📎 {c.files}</span>}
          <span>💬 {c.msgs}</span>
          {c.legacy && <span>старое</span>}
          <span style={{ flex: 1 }} />
          {!closed && !fresh && c.status !== 'dev' && c.last_staff_at && <button type="button" disabled={busy === c.id} onClick={e => closeQuick(e, c)} className="btn-secondary"
            title="Ответ дан — закрыть диалог (в архив как решённый)" style={{ width: 'auto', padding: '3px 10px', fontSize: 11.5, color: 'var(--teal)', borderColor: 'var(--teal)' }}>🔒 Закрыть</button>}
          {!closed && !mine && <button type="button" disabled={busy === c.id} onClick={e => take(e, c)} className={c.taken_by ? 'btn-secondary' : 'btn-primary'}
            style={{ width: 'auto', padding: '3px 10px', fontSize: 11.5 }}>{c.taken_by ? 'Забрать' : 'Беру'}</button>}
        </div>
      </div>
    )
  }

  const by = Object.fromEntries(SUPPORT_COLS.map(([k]) => [k, []]))
  for (const c of cards || []) (by[c.status] || []).push(c)
  const colHead = ([k, title, color]) => (
    <div style={{ fontSize: 13, fontWeight: 600, color, marginBottom: 6 }}>{title} <span style={{ color: 'var(--text-hint)', fontWeight: 400 }}>{by[k].length}</span></div>
  )

  return (
    <div className="page" style={{ paddingBottom: 100, ...(wide || tasks ? { maxWidth: 'none' } : {}) }}>
      {head}
      <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <button type="button" onClick={() => { setArchive(false); setTasks(false) }} className={archive || tasks ? 'btn-secondary' : 'btn-primary'} style={{ width: 'auto', padding: '5px 12px', fontSize: 12.5 }}>Обращения</button>
        <button type="button" onClick={() => { setArchive(true); setTasks(false) }} className={archive && !tasks ? 'btn-primary' : 'btn-secondary'} style={{ width: 'auto', padding: '5px 12px', fontSize: 12.5 }}>Архив</button>
        <button type="button" onClick={() => setTasks(true)} className={tasks ? 'btn-primary' : 'btn-secondary'} style={{ width: 'auto', padding: '5px 12px', fontSize: 12.5 }}>📌 Задачи</button>
        {archive && !tasks && <input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Поиск: имя, текст, №" style={{ flex: '1 1 160px', padding: '6px 10px', fontSize: 13 }} />}
        {!archive && !tasks && isMaster && legacy > 0 && <button type="button" className="btn-secondary" style={{ width: 'auto', padding: '5px 10px', fontSize: 12 }} onClick={archiveLegacy}>Старые ({legacy}) → в архив</button>}
      </div>
      {err && <p className="error-text" style={{ fontSize: 12, marginBottom: 8 }}>{err}</p>}
      {tasks ? <TasksPage team="support" />
        : cards === null ? <CncLoader label="Загружаем обращения…" />
        : archive ? (cards.length ? cards.map(tile) : <p style={{ fontSize: 13, color: 'var(--text-hint)' }}>{q ? 'Ничего не найдено.' : 'В архиве пока пусто.'}</p>)
          : wide ? (
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${SUPPORT_COLS.length}, minmax(0, 1fr))`, gap: 12, alignItems: 'start' }}>
              {SUPPORT_COLS.map(c => (
                <div key={c[0]} style={{ background: 'rgba(0,0,0,.035)', borderRadius: 'var(--radius-lg)', padding: 8, minHeight: 120 }}>
                  {colHead(c)}{by[c[0]].map(tile)}
                </div>
              ))}
            </div>
          ) : <>
            <div style={{ display: 'flex', gap: 6, overflowX: 'auto', marginBottom: 10, paddingBottom: 2 }}>
              {SUPPORT_COLS.map(([k, title, color]) => (
                <button key={k} type="button" onClick={() => pickCol(k)} style={{ flexShrink: 0, padding: '6px 11px', fontSize: 12.5, borderRadius: 16, cursor: 'pointer',
                  border: `1px solid ${col === k ? color : 'var(--border)'}`, background: col === k ? color : 'transparent', color: col === k ? '#fff' : 'var(--text)' }}>
                  {title} · {by[k].length}
                </button>
              ))}
            </div>
            {by[col]?.length ? by[col].map(tile) : <p style={{ fontSize: 13, color: 'var(--text-hint)' }}>Здесь пусто.</p>}
          </>}
      <BottomNav />
    </div>
  )
}

// Команда поддержки: кто в ней; мастеру — выдать / снять роль
function TeamBlock({ isMaster, me }) {
  const staff = useSupportStaff(!!isMaster)
  const [team, setTeam] = useState(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    let alive = true
    supportTeam().then(r => { if (!alive) return; if (r.error) setErr(r.error); else setTeam(r.data || []) })
    return () => { alive = false }
  }, [staff])
  const rows = staff?.data || []
  const set = async (id, on) => {
    if (!on && !window.confirm('Снять роль «Поддержка»? Раздел «Поддержка» у него пропадёт.')) return
    const r = await setSupport(id, on)
    if (r.error) setErr(r.error)
  }
  return <>
    <div className="card" style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>Команда поддержки</div>
      {!team ? <p style={{ fontSize: 12, color: 'var(--text-hint)' }}>{err || 'Загружаем…'}</p> : team.map(t => (
        <div key={t.user_id} style={{ fontSize: 13, padding: '5px 0', borderTop: '0.5px solid var(--border)' }}>
          {t.master ? '👑 ' : '🎧 '}{t.full_name}{t.user_id === me ? <span style={{ color: 'var(--text-hint)' }}> · это вы</span> : ''}
        </div>
      ))}
    </div>
    {isMaster && (
      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 2 }}>Сотрудники поддержки</div>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
          Добавить — галочкой «🎧 Сотрудник поддержки» в карточке пользователя («Пользователи и регистрация» или нажатие на имя).
          Сотрудник видит только раздел «Поддержка»: обращения, переписку, файлы и краткую карточку автора без телефона.
        </p>
        <StaffPackToggle />
        {staff === undefined ? <p style={{ fontSize: 12, color: 'var(--text-hint)' }}>Загружаем…</p>
          : staff.error ? <p className="error-text" style={{ fontSize: 12 }}>{staff.error}</p>
            : !rows.length ? <p style={{ fontSize: 12, color: 'var(--text-hint)' }}>Пока никого.</p>
              : rows.map(s => (
                <div key={s.user_id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderTop: '0.5px solid var(--border)', opacity: s.active ? 1 : 0.55 }}>
                  <div style={{ flex: 1, minWidth: 0, fontSize: 13 }}>
                    <UserName id={s.user_id} name={s.full_name || 'Пользователь'} />
                    <div style={{ fontSize: 11.5, color: 'var(--text-hint)' }}>{[s.country, s.city].filter(Boolean).join(', ')}{s.active ? ` · с ${date(s.added_at)}` : ' · роль снята'}</div>
                  </div>
                  <button type="button" className="btn-secondary" style={{ width: 'auto', padding: '5px 10px', fontSize: 12 }} onClick={() => set(s.user_id, !s.active)}>{s.active ? 'Снять' : 'Вернуть'}</button>
                </div>
              ))}
      </div>
    )}
    {err && team && <p className="error-text" style={{ fontSize: 12 }}>{err}</p>}
  </>
}

// мастер: могут ли сотрудники поддержки сами скачивать «📦 Пакет для разработчика»
function StaffPackToggle() {
  const [on, setOn] = useState(undefined)
  const [err, setErr] = useState('')
  useEffect(() => { let alive = true; supportConfig().then(r => { if (alive) setOn(r.data ? !!r.data.staff_pack : null) }); return () => { alive = false } }, [])
  if (on === undefined || on === null) return null
  const flip = async () => { const r = await setSupportStaffPack(!on); if (r.error) setErr(r.error); else setOn(!on) }
  return (
    <div style={{ marginBottom: 8 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
        <input type="checkbox" checked={on} onChange={flip} style={{ width: 18, height: 18, margin: 0 }} />
        <span>Сотрудники могут скачивать «📦 Пакет для разработчика»</span>
      </label>
      {err && <div className="error-text" style={{ fontSize: 11.5 }}>{err}</div>}
    </div>
  )
}
