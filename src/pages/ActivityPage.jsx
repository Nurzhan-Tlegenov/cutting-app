// Мастер-аккаунт: вовлечённость пользователей — кто активно пользуется приложением, кто заходит редко, кто пропал.
// Рейтинг по баллам за выбранный период: дни в приложении, заказы, отправленные заказы, детали, сообщения,
// прочитанные новости; у производств — полученные и готовые заказы, у сотрудников — отметки на постах.
import { MenuButton } from '../components/NavDrawer'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import BottomNav from '../components/BottomNav'
import CncLoader from '../components/CncLoader'
import { adminActivity, scoreOf, statusOf, lastSeenOf, STATUS } from '../lib/activity'

const PERIODS = [[1, '1 день'], [7, '7 дней'], [30, '30 дней'], [90, '90 дней'], [0, 'Всё время']]
const ago = v => {
  if (!v) return 'никогда'
  const d = Math.floor((Date.now() - new Date(v).getTime()) / 86400000)
  if (d <= 0) return 'сегодня'
  if (d === 1) return 'вчера'
  if (d < 30) return `${d} дн. назад`
  return new Date(v).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' })
}
const n = v => Number(v) || 0

export default function ActivityPage() {
  const navigate = useNavigate()
  const { isMaster } = useAuth()
  const [days, setDays] = useState(30)
  const [rows, setRows] = useState(null)
  const [error, setError] = useState('')
  const [kind, setKind] = useState('all')       // все / клиенты / производства
  const [st, setSt] = useState('')              // фильтр по статусу
  const [find, setFind] = useState('')
  const [open, setOpen] = useState(null)

  useEffect(() => {
    let alive = true
    Promise.resolve().then(() => { if (alive) setRows(null) })
    adminActivity(days).then(r => {
      if (!alive) return
      if (r.error) { setError(r.error); setRows([]); return }
      setError('')
      // у владельца нескольких производств строка на каждое — сводим в одну
      const by = new Map()
      for (const u of r.data || []) {
        const p = by.get(u.id)
        if (!p) { by.set(u.id, { ...u, prods: u.production_name ? [u.production_name] : [] }); continue }
        if (u.production_name) p.prods.push(u.production_name)
        p.received = n(p.received) + n(u.received); p.done = n(p.done) + n(u.done)
      }
      const now = Date.now()
      setRows([...by.values()].map(u => { const seen = lastSeenOf(u); return { ...u, score: scoreOf(u), status: statusOf(u), seen, ago: seen ? now - new Date(seen).getTime() : null } }))
    })
    return () => { alive = false }
  }, [days])

  // заходил за выбранный период (1 день — последние 24 часа)
  const inPeriod = u => !days || (u.ago != null && u.ago <= days * 86400000)
  const counts = useMemo(() => {
    const c = { active: 0, rare: 0, sleep: 0, never: 0 }
    for (const u of rows || []) c[u.status]++
    return c
  }, [rows])
  const shown = useMemo(() => {
    const q = find.trim().toLowerCase()
    return (rows || [])
      .filter(u => kind === 'all' || (kind === 'prod' ? u.prods.length > 0 || u.role === 'operator' : !u.prods.length && u.role !== 'operator'))
      .filter(u => !st || (st === 'period' ? inPeriod(u) : u.status === st))
      .filter(u => !q || [u.name, u.phone, u.city, u.country, ...u.prods].some(x => String(x || '').toLowerCase().includes(q)))
      .sort((a, b) => b.score - a.score || String(b.seen || '').localeCompare(String(a.seen || '')))
  }, [rows, kind, st, find])

  if (!isMaster) return <div className="page"><p>Раздел доступен только мастер-аккаунту.</p><BottomNav /></div>

  const chip = on => ({ flex: '0 0 auto', padding: '6px 12px', borderRadius: 20, border: 'none', fontSize: 12, background: on ? 'var(--blue)' : 'var(--bg)', color: on ? 'white' : 'var(--text-muted)' })
  const total = (rows || []).length
  const metric = (icon, label, v) => (n(v) > 0 ? <span title={label} style={{ whiteSpace: 'nowrap' }}>{icon} {Math.round(n(v)).toLocaleString('ru-RU')}</span> : null)

  return (
    <div className="page" style={{ paddingBottom: 100 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 12, paddingTop: 4 }}><MenuButton /><h1 style={{ fontSize: 18, fontWeight: 500 }}>Активность пользователей</h1></div>
      {error && <p className="error-text" style={{ marginBottom: 12 }}>{error}</p>}

      {/* сводка: сколько активных, редких, пропавших — нажатие фильтрует список */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, marginBottom: 10 }}>
        {Object.entries(STATUS).map(([k, [label, fg, bg]]) => (
          <button key={k} type="button" onClick={() => setSt(s => (s === k ? '' : k))}
            style={{ border: st === k ? `1.5px solid ${fg}` : '0.5px solid var(--border)', background: bg, borderRadius: 12, padding: '8px 4px', textAlign: 'center', cursor: 'pointer' }}>
            <div style={{ fontSize: 20, fontWeight: 600, color: fg }}>{counts[k]}</div>
            <div style={{ fontSize: 10.5, color: 'var(--text-muted)', lineHeight: 1.2 }}>{label}</div>
            {total > 0 && <div style={{ fontSize: 10, color: 'var(--text-hint)' }}>{Math.round(counts[k] / total * 100)}%</div>}
          </button>
        ))}
      </div>
      <p style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 10 }}>
        Активный — заходил за последние 7 дней, редко — за 30, неактивный — дольше. Всего пользователей: {total}.
      </p>

      <div style={{ display: 'flex', gap: 6, overflowX: 'auto', marginBottom: 8, paddingBottom: 2 }}>
        {PERIODS.map(([d, l]) => <button key={d} type="button" style={chip(days === d)} onClick={() => setDays(d)}>{l}</button>)}
      </div>
      {rows && (() => {
        const pr = rows.filter(inPeriod), sum = k => rows.reduce((a, u) => a + n(u[k]), 0)
        const f = v => Math.round(v).toLocaleString('ru-RU')
        const per = days === 1 ? 'за последние 24 часа' : days ? `за ${days} дней` : 'за всё время'
        return (
          <button type="button" onClick={() => setSt(s => (s === 'period' ? '' : 'period'))}
            style={{ width: '100%', textAlign: 'left', border: st === 'period' ? '1.5px solid var(--blue)' : '0.5px solid var(--border)', background: 'var(--bg)', borderRadius: 12, padding: '8px 10px', marginBottom: 8, cursor: 'pointer', fontSize: 12, color: 'var(--text-muted)' }}>
            <div style={{ color: 'var(--text)' }}>Заходили {per}: <b style={{ fontSize: 15 }}>{f(pr.length)}</b> из {f(total)}{st === 'period' ? ' · показаны только они' : ' · нажмите, чтобы показать их'}</div>
            <div style={{ marginTop: 2 }}>
              заказов {f(sum('orders'))} · отправлено {f(sum('submitted'))} · деталей {f(sum('parts'))} · сообщений {f(sum('messages'))} · прочитано новостей {f(sum('news_seen'))}
              {sum('received') > 0 && ` · производства приняли ${f(sum('received'))}`}{sum('done') > 0 && ` · исполнено ${f(sum('done'))}`}
            </div>
          </button>
        )
      })()}
      <div style={{ display: 'flex', gap: 6, marginBottom: 8, alignItems: 'center' }}>
        {[['all', 'Все'], ['client', 'Клиенты'], ['prod', 'Производства']].map(([k, l]) => <button key={k} type="button" style={chip(kind === k)} onClick={() => setKind(k)}>{l}</button>)}
      </div>
      <input type="search" value={find} onChange={e => setFind(e.target.value)} placeholder="Поиск: имя, телефон, город, производство" style={{ fontSize: 14, marginBottom: 10 }} />

      {rows === null ? <CncLoader label="Считаем активность…" compact /> : !shown.length ? (
        <p style={{ fontSize: 13, color: 'var(--text-hint)', textAlign: 'center', padding: '24px 0' }}>Никого не нашлось.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {shown.map((u, i) => {
            const [sl, sfg, sbg] = STATUS[u.status]
            const top = i < 3 && u.score > 0 && !st && !find
            const isOpen = open === u.id
            return (
              <div key={u.id} className="card" style={{ padding: '9px 12px', cursor: 'pointer' }} onClick={() => setOpen(isOpen ? null : u.id)}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ width: 26, textAlign: 'center', fontSize: top ? 18 : 13, fontWeight: 600, color: 'var(--text-muted)', flex: 'none' }}>{top ? ['🥇', '🥈', '🥉'][i] : i + 1}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
                      <b style={{ fontSize: 14 }}>{u.name || 'Без имени'}</b>
                      <span style={{ fontSize: 10.5, padding: '1px 7px', borderRadius: 9, background: sbg, color: sfg }}>{sl}</span>
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {[u.prods.length ? '🏭 ' + u.prods.join(', ') : '', [u.city, u.country].filter(Boolean).join(', '), 'был ' + ago(u.seen)].filter(Boolean).join(' · ')}
                    </div>
                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>
                      {metric('📅', 'Дней в приложении', u.days)}
                      {metric('📦', 'Создал заказов', u.orders)}
                      {metric('📤', 'Отправил на производство', u.submitted)}
                      {metric('🧩', 'Деталей в заказах', u.parts)}
                      {metric('💬', 'Сообщений', u.messages)}
                      {metric('👁', 'Прочитал новостей', u.news_seen)}
                      {metric('📥', 'Получено заказов производством', u.received)}
                      {metric('✅', 'Выполнено заказов', u.done)}
                      {metric('🔧', 'Отметок на постах', u.stage_marks)}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', flex: 'none' }}>
                    <div style={{ fontSize: 17, fontWeight: 600, color: u.score > 0 ? 'var(--blue)' : 'var(--text-hint)' }}>{u.score}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-hint)' }}>баллов</div>
                  </div>
                </div>
                {isOpen && (
                  <div style={{ marginTop: 8, paddingTop: 8, borderTop: '0.5px solid var(--border)', fontSize: 12, color: 'var(--text-muted)', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '3px 10px' }}>
                    <span>Регистрация</span><b style={{ color: 'var(--text)' }}>{ago(u.created_at)}</b>
                    <span>Последний вход</span><b style={{ color: 'var(--text)' }}>{ago(u.last_sign_in_at)}</b>
                    <span>Был в приложении</span><b style={{ color: 'var(--text)' }}>{ago(u.last_seen)}</b>
                    <span>Последний заказ</span><b style={{ color: 'var(--text)' }}>{ago(u.last_order_at)}</b>
                    <span>Дней в приложении</span><b style={{ color: 'var(--text)' }}>{n(u.days)} (открывал {n(u.visits)} раз)</b>
                    <span>Заказы</span><b style={{ color: 'var(--text)' }}>создал {n(u.orders)}, отправил {n(u.submitted)}, деталей {n(u.parts).toLocaleString('ru-RU')}</b>
                    {(u.prods.length > 0 || n(u.received) > 0) && <><span>Производство</span><b style={{ color: 'var(--text)' }}>получило {n(u.received)}, выполнило {n(u.done)}</b></>}
                    {n(u.stage_marks) > 0 && <><span>На постах</span><b style={{ color: 'var(--text)' }}>{n(u.stage_marks)} отметок</b></>}
                    <span>Общение</span><b style={{ color: 'var(--text)' }}>сообщений {n(u.messages)}, прочитал новостей {n(u.news_seen)}</b>
                    {u.phone && <><span>Телефон</span><b style={{ color: 'var(--text)' }}>{u.phone}</b></>}
                    <span />
                    <button type="button" className="btn-secondary" style={{ padding: '6px 10px', fontSize: 12, width: 'auto', justifySelf: 'start' }}
                      onClick={e => { e.stopPropagation(); navigate(`/users?find=${encodeURIComponent(u.phone || u.name || '')}`) }}>Открыть в «Пользователях»</button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
      <p style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 12 }}>
        Баллы за период: день в приложении — 3, заказ — 5, отправка на производство — 5, сообщение — 2, прочитанная новость — 1,
        заказ, полученный или выполненный производством, — 4, отметка на посту — 0,5, 100 деталей — 5.
        Дни в приложении и прочитанные новости считаются с момента включения этой статистики.
      </p>
      <BottomNav />
    </div>
  )
}
