// Мастер-аккаунт: постпроцессоры по запросу — запросы производств, кому какой постпроцессор выдан,
// кто и каким постпроцессором выпускает программы (migration_post_access.sql).
import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { MenuButton } from '../components/NavDrawer'
import BottomNav from '../components/BottomNav'
import CncLoader from '../components/CncLoader'
import { adminPostAccess, grantPost, revokePost, setRequestStatus, deleteRequest, requestProgram } from '../lib/postAccess'

const dt = v => (v ? new Date(v).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—')
const ago = v => {
  if (!v) return 'не выпускал'
  const d = Math.floor((Date.now() - new Date(v).getTime()) / 86400000)
  return d <= 0 ? 'сегодня' : d === 1 ? 'вчера' : `${d} дн. назад`
}
const KIND = { router: 'раскрой', drill6: 'присадка 6-стор.', beamsaw: 'пильный центр' }
const chip = (fg, bg) => ({ fontSize: 11, padding: '1px 8px', borderRadius: 10, color: fg, background: bg, whiteSpace: 'nowrap' })
const btn = (fg, filled) => ({ padding: '6px 11px', borderRadius: 16, border: `1px solid ${fg}`, background: filled ? fg : 'transparent', color: filled ? '#fff' : fg, fontSize: 12.5, cursor: 'pointer', whiteSpace: 'nowrap' })
const SUSPECT = 3          // запросов за 30 дней от одного аккаунта — подсветить

export default function PostAccessPage() {
  const { isMaster } = useAuth()
  const [d, setD] = useState(null)
  const [err, setErr] = useState('')
  const [tab, setTab] = useState('req')
  const [open, setOpen] = useState(null)              // раскрытый постпроцессор
  const load = async () => { const r = await adminPostAccess(); if (r.error) { setErr(r.error); setD({ posts: [], requests: [], usage: [] }) } else { setErr(''); setD(r.data || { posts: [], requests: [], usage: [] }) } }
  useEffect(() => { Promise.resolve().then(load) }, [])
  if (!isMaster) return <div className="page"><p>Раздел доступен только мастер-аккаунту.</p><BottomNav /></div>
  const act = async p => { const r = await p; if (r?.error) window.alert(r.error); await load() }
  const fresh = (d?.requests || []).filter(r => r.status === 'new').length
  const tabs = [['req', `Запросы${fresh ? ` · ${fresh}` : ''}`], ['posts', `Выдача · ${d?.posts?.length || 0}`], ['usage', 'Кто чем выпускает']]

  return (
    <div className="page page-read" style={{ paddingBottom: 100 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 10, paddingTop: 4 }}><MenuButton /><h1 style={{ fontSize: 18, fontWeight: 500 }}>Постпроцессоры по запросу</h1></div>
      {err && <div className="card" style={{ fontSize: 13, color: 'var(--danger)', marginBottom: 10 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 4, background: 'var(--bg2)', borderRadius: 18, padding: 3, marginBottom: 12 }}>
        {tabs.map(([k, l]) => (
          <button key={k} type="button" onClick={() => setTab(k)} style={{ flex: 1, padding: '6px 6px', borderRadius: 15, border: 'none', fontSize: 12.5, fontWeight: tab === k ? 600 : 400, background: tab === k ? 'var(--bg)' : 'transparent', color: tab === k ? 'var(--blue)' : 'var(--text-muted)', cursor: 'pointer' }}>{l}</button>
        ))}
      </div>
      {!d && <CncLoader label="Загружаем…" />}

      {d && tab === 'req' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {!d.requests.length && <p style={{ fontSize: 13, color: 'var(--text-hint)', textAlign: 'center', padding: 20 }}>Запросов пока нет.</p>}
          {d.requests.map(r => <Request key={r.id} r={r} posts={d.posts} act={act} />)}
        </div>
      )}

      {d && tab === 'posts' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p style={{ fontSize: 12, color: 'var(--text-hint)' }}>Постпроцессоры в каталоге (кнопка 🔑 у станка в настройках ЧПУ). Их видят только те, кому вы выдали, и сотрудники их производства; остальные — название и «Запросить».</p>
          {!d.posts.length && <p style={{ fontSize: 13, color: 'var(--text-hint)', textAlign: 'center', padding: 20 }}>В каталоге пока нет постпроцессоров.</p>}
          {d.posts.map(p => (
            <div key={p.id} className="card" style={{ padding: '10px 12px' }}>
              <button type="button" onClick={() => setOpen(o => (o === p.id ? null : p.id))} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', textAlign: 'left', color: 'var(--text)' }}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 14.5, fontWeight: 600 }}>{p.name}</span>
                  <span style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                    выдан: <b>{p.access.length}</b> · пользуются: <b>{p.users}</b> · программ выпущено: <b>{p.runs}</b> · последний раз: {ago(p.last)}
                  </span>
                </span>
                <span style={chip('var(--blue-dark)', 'var(--blue-light)')}>{KIND[p.kind] || p.kind}</span>
                <span style={{ color: 'var(--text-hint)' }}>{open === p.id ? '▴' : '▾'}</span>
              </button>
              {open === p.id && <Access p={p} act={act} />}
            </div>
          ))}
        </div>
      )}

      {d && tab === 'usage' && (
        <div className="card" style={{ padding: 4 }}>
          <p style={{ fontSize: 12, color: 'var(--text-hint)', padding: '6px 8px' }}>Кто выпускал управляющие программы за 90 дней и какими постпроцессорами (🔑 — выданный вами, без значка — свой).</p>
          {!d.usage.length && <p style={{ fontSize: 13, color: 'var(--text-hint)', textAlign: 'center', padding: 20 }}>Пока никто не выпускал программ (записи идут с этого обновления).</p>}
          {d.usage.map(u => (
            <div key={u.user_id} style={{ padding: '8px 8px', borderTop: '0.5px solid var(--border)' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 500 }}>{u.name}{u.prod ? <span style={{ color: 'var(--text-hint)', fontWeight: 400 }}> · {u.prod}</span> : null}</span>
                <span style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{u.runs} раз · {ago(u.last)}</span>
              </div>
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 4 }}>
                {(u.posts || []).map((x, i) => <span key={i} style={chip(x.shared ? 'var(--teal)' : 'var(--text-muted)', x.shared ? 'var(--teal-light)' : 'var(--bg2)')}>{x.shared ? '🔑 ' : ''}{x.name || '—'}</span>)}
              </div>
            </div>
          ))}
        </div>
      )}
      <BottomNav />
    </div>
  )
}

/** Запрос производства: кто, что просит, пример программы; выдать / готово / отклонить */
function Request({ r, posts, act }) {
  const [pick, setPick] = useState(r.post_id || '')
  const many = r.user_30d >= SUSPECT
  const download = async () => {
    const x = await requestProgram(r.id)
    if (x.error || !x.data?.text) { window.alert(x.error || 'Программы в запросе нет'); return }
    const url = URL.createObjectURL(new Blob([x.data.text], { type: 'text/plain' }))
    const a = document.createElement('a'); a.href = url; a.download = x.data.name || 'program.nc'; document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  }
  const give = async () => {
    if (!pick) { window.alert('Выберите постпроцессор, который выдать.'); return }
    const p = posts.find(x => x.id === pick)
    if (!window.confirm(`Выдать «${p?.name}» пользователю ${r.name}${r.prod ? ` (${r.prod})` : ''}?`)) return
    const g = await grantPost(pick, r.user_id, 'по запросу')
    if (g.error) { window.alert(g.error); return }
    await act(setRequestStatus(r.id, 'done'))
  }
  return (
    <div className="card" style={{ padding: '10px 12px', border: r.status === 'new' ? '1px solid var(--blue)' : undefined, opacity: r.status === 'new' ? 1 : 0.7 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: 14.5, fontWeight: 600 }}>{r.name}{r.prod ? <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}> · {r.prod}</span> : null}</span>
        {r.status !== 'new' && <span style={chip(r.status === 'done' ? 'var(--teal)' : 'var(--text-muted)', r.status === 'done' ? 'var(--teal-light)' : 'var(--bg2)')}>{r.status === 'done' ? 'выдан' : 'отклонён'}</span>}
        <span style={{ fontSize: 11.5, color: 'var(--text-hint)' }}>{dt(r.created_at)}</span>
      </div>
      {r.phone && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{r.phone}</div>}
      {many && <div style={{ ...chip('var(--danger)', 'var(--danger-light)'), display: 'inline-block', marginTop: 4 }}>⚠ запросов с этого аккаунта за 30 дней: {r.user_30d} (всего {r.user_total}) — проверьте, не собирают ли постпроцессоры</div>}
      <div style={{ fontSize: 13, marginTop: 6 }}>
        {r.post_name ? <>Просит: <b>{r.post_name}</b></> : <>Свой станок</>}
        {(r.machine || r.controller) && <div style={{ color: 'var(--text-muted)' }}>{[r.machine, r.controller].filter(Boolean).join(' · ')}</div>}
        {r.note && <div style={{ color: 'var(--text-muted)', whiteSpace: 'pre-wrap', marginTop: 2 }}>{r.note}</div>}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
        {r.has_program && <button type="button" style={btn('var(--blue)')} onClick={download}>⬇ Пример программы{r.program_name ? ` (${r.program_name})` : ''}</button>}
        {r.status === 'new' && (
          <>
            <select value={pick} onChange={e => setPick(e.target.value)} style={{ padding: '6px 8px', fontSize: 12.5, borderRadius: 8, maxWidth: 220 }}>
              <option value="">— какой выдать —</option>
              {posts.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <button type="button" style={btn('var(--teal)', true)} onClick={give}>🔑 Выдать</button>
            <button type="button" style={btn('var(--text-muted)')} onClick={() => act(setRequestStatus(r.id, 'rejected'))}>Отклонить</button>
          </>
        )}
        {r.status !== 'new' && <button type="button" style={btn('var(--text-muted)')} onClick={() => act(setRequestStatus(r.id, 'new'))}>Вернуть в новые</button>}
        <button type="button" style={btn('var(--danger)')} onClick={() => { if (window.confirm('Удалить запрос?')) act(deleteRequest(r.id)) }}>Удалить</button>
      </div>
      {!posts.length && r.status === 'new' && <div style={{ fontSize: 11.5, color: 'var(--text-hint)', marginTop: 4 }}>Сначала настройте постпроцессор под этот станок и добавьте его в каталог (🔑 у станка в настройках ЧПУ) — потом выдайте здесь.</div>}
    </div>
  )
}

/** Кому выдан постпроцессор: список с программами и последним выпуском, отозвать (выдают в «Пользователи и регистрация») */
function Access({ p, act }) {
  return (
    <div style={{ marginTop: 8 }}>
      {!p.access.length && <div style={{ fontSize: 12.5, color: 'var(--text-hint)', padding: '4px 0' }}>Пока никому не выдан.</div>}
      {p.access.map(a => (
        <div key={a.user_id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '7px 0', borderTop: '0.5px solid var(--border)' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 500 }}>{a.name}{a.prod ? <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}> · {a.prod}</span> : null}</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-hint)' }}>
              выдан {dt(a.granted_at)}{a.note ? ` (${a.note})` : ''} · программ: <b style={{ color: a.runs ? 'var(--teal)' : 'var(--text-muted)' }}>{a.runs}</b> · {ago(a.last)}{a.phone ? ` · ${a.phone}` : ''}
            </div>
          </div>
          <button type="button" style={btn('var(--danger)')} onClick={() => { if (window.confirm(`Отозвать «${p.name}» у ${a.name}?\nУ него и сотрудников его производства этот постпроцессор пропадёт.`)) act(revokePost(p.id, a.user_id)) }}>Отозвать</button>
        </div>
      ))}
      <div style={{ fontSize: 11.5, color: 'var(--text-hint)', marginTop: 8 }}>Выдать — в «Пользователи и регистрация»: фильтр «Производства», у пользователя кнопки 🔑 с названиями постпроцессоров.</div>
    </div>
  )
}
