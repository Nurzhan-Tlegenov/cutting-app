import AppStopCard from '../components/AppStopCard'
import { MenuButton } from '../components/NavDrawer'
import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import BottomNav from '../components/BottomNav'
import { adminSetProduction } from '../lib/productionApi'
import { adminEmailSignup, adminSetEmailSignup } from '../lib/adminApi'
import { adminUsers, adminRequests, adminSetSignup, adminSetRequest, adminAllowPhone, adminSetRole, signupOpen, adminPasswordResets, adminIssueReset, adminCloseReset, RESET_SQL_HINT, adminApproveRequest, tgBot, TG_BOT, adminLoginHelp, adminCloseLoginHelp, adminDeleteUser, adminSetLocation, adminBlockedPhones, adminBlockPhone, adminUnblockPhone } from '../lib/adminApi'
import CncLoader from '../components/CncLoader'
import { DefaultLimits, UserLimits } from '../components/LimitsAdmin'
import { adminLimits, adminSetDefaultLimits, adminSetUserLimits } from '../lib/limits'
import { countryCode } from '../lib/productionLabel'
import { useNoticeFocus } from '../lib/noticeNav'
import { siteOrigin } from '../lib/siteOrigin'
import { getUserSettings, saveUserSettings } from '../lib/userSettings'
import { adminBeta, adminSetBeta, BETA_FEATURES } from '../lib/beta'
import { adminPostAccess, adminUserPosts, grantPost, revokePost, setRequestStatus } from '../lib/postAccess'
import { sendReply } from '../lib/messages'
import WriteToUser, { WriteToUserDialog } from '../components/WriteToUser'
import { COUNTRY_NAMES } from '../lib/phoneCountries'

// Администратор: кто зарегистрирован, заявки на регистрацию и переключатель «регистрация открыта / по запросу».
const ROLES = [['client', 'Клиент'], ['operator', 'Производство'], ['admin', 'Администратор']]
const date = v => (v ? new Date(v).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '—')
// дата и время подачи заявки: «24.10.26 12:28»
const dateTime = v => (v ? `${date(v)} ${new Date(v).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}` : '—')
const digits = v => String(v || '').replace(/\D/g, '')
const byPhone = u => /@raskoypro\.local$/i.test(String(u?.email || ''))   // аккаунт по номеру; иначе — по почте (email, Google)
const isEmail = v => String(v || '').includes('@')
// ссылка открывает «У меня есть код» с подставленными номером и кодом — остаётся придумать пароль
const codeLink = (code, digits) => `${siteOrigin()}/auth?code=${code}&tel=${digits}`
const codeMsg = (code, digits) => `Ваша заявка в RaskroyPro одобрена. Код: ${code}\n\nЗавершите регистрацию по ссылке — номер и код уже подставлены, останется придумать пароль:\n${codeLink(code, digits)}\n\nИли откройте приложение → «У меня есть код». Код действует 3 дня.`

// Как подтверждён номер заявки
function VerifyBadge({ r }) {
  if (r.phone_verified_at) return <span style={{ fontSize: 11, color: 'var(--teal)' }}>✓ номер подтверждён в Telegram</span>
  if (r.messenger === 'telegram') return <span style={{ fontSize: 11, color: 'var(--amber)' }}>Telegram — номер ещё не подтверждён</span>
  if (r.messenger === 'whatsapp') return <span style={{ fontSize: 11, color: 'var(--text-hint)' }}>WhatsApp — код отправите вы</span>
  return null
}

export default function UsersPage() {
  const { user, profile } = useAuth()
  const [notifyU, setNotifyU] = useState(null)   // выдан постпроцессор — окно «написать пользователю»
  const [writeTo, setWriteTo] = useState(null)   // кому мастер пишет личное сообщение (id пользователя)
  const [draft, setDraft] = useState('')
  const [locEdit, setLocEdit] = useState(null)   // { id, country, city } — мастер правит страну и город пользователя
  const [users, setUsers] = useState(null)
  const [reqs, setReqs] = useState([])
  const [resets, setResets] = useState(null)   // запросы на восстановление пароля; null — в базе ещё нет этой части
  const [open, setOpen] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [phone, setPhone] = useState('')
  const [name, setName] = useState('')
  const [find, setFind] = useState(() => new URLSearchParams(window.location.search).get('find') || '')   // из «Активности» — сразу нужный человек
  // карточки пользователей свёрнуты; нажатие раскрывает
  const [openU, setOpenU] = useState(() => new Set())
  const flip = id => setOpenU(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  // «Новые с прошлого просмотра»: кто зарегистрировался, пока мастера не было (по ссылкам, при открытой регистрации).
  // Момент последнего просмотра хранится за аккаунтом; при уходе со страницы или по кнопке новые переходят в общий список.
  const [seenAt, setSeenAt] = useState(() => getUserSettings(user).usersSeenAt || '')
  const newCount = useRef(0)
  const markSeen = () => {
    const now = new Date().toISOString()
    saveUserSettings({ usersSeenAt: now }, user); setSeenAt(now)
    window.dispatchEvent(new Event('notices-seen'))
  }
  useEffect(() => {
    if (!getUserSettings(user).usersSeenAt) saveUserSettings({ usersSeenAt: new Date().toISOString() }, user)   // первый раз — новых нет
    return () => { if (newCount.current) { saveUserSettings({ usersSeenAt: new Date().toISOString() }, user); window.dispatchEvent(new Event('notices-seen')) } }
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps
  const [kind, setKind] = useState('all')      // все / клиенты / производства
  const [land, setLand] = useState('')         // страна (обозначение) — фильтр списка
  const [town, setTown] = useState('')         // город — фильтр списка
  const [ready, setReady] = useState(false)   // база ответила: функции на месте и вы администратор
  const [info, setInfo] = useState('')         // итог последнего действия (код отправлен, бот подключён…)
  const [lim, setLim] = useState(null)         // лимиты: { defaults, users } или { error } — в базе ещё нет лимитов
  const [helps, setHelps] = useState(null)     // «Не получается войти» с экрана входа; null — в базе ещё нет этой части
  const [beta, setBeta] = useState(null)       // бета-тест: Map(user_id -> [функции]) или { error } — в базе ещё нет
  const [posts, setPosts] = useState(null)     // постпроцессоры по запросу: { list, has: Map(user -> Set(post)), asks: Map(user -> [запросы]) } или null — в базе ещё нет
  const [blocked, setBlocked] = useState(null) // заблокированные номера: [] или { error } — в базе ещё нет этой части
  const [blkPhone, setBlkPhone] = useState('')
  const [blkNote, setBlkNote] = useState('')

  const [emailOpen, setEmailOpen] = useState(null)   // регистрация по почте и Google: true / false, null — в базе ещё нет (migration_email_login.sql)
  const load = async () => {
    const [u, r, o, pr, lm, lh, bt, bl, eo, pa, up] = await Promise.all([adminUsers(), adminRequests(), signupOpen(), adminPasswordResets(), adminLimits(), adminLoginHelp(), adminBeta(), adminBlockedPhones(), adminEmailSignup(), adminPostAccess(), adminUserPosts()])
    if (pa.error) setPosts(null)
    else {
      const has = new Map(), asks = new Map()
      for (const p of pa.data?.posts || []) for (const a of p.access || []) { if (!has.has(a.user_id)) has.set(a.user_id, new Set()); has.get(a.user_id).add(p.id) }
      for (const q of pa.data?.requests || []) if (q.status === 'new') { if (!asks.has(q.user_id)) asks.set(q.user_id, []); asks.get(q.user_id).push(q) }
      setPosts({ list: pa.data?.posts || [], has, asks, own: new Map((up.error ? [] : up.data || []).map(x => [x.user_id, x])) })
    }
    setEmailOpen(eo)
    setBlocked(bl.error ? { error: bl.error } : bl.data || [])
    setBeta(bt.error ? { error: bt.error } : bt.data)
    setHelps(lh.error ? null : lh.data || [])
    setLim(lm.error ? { error: lm.error } : { defaults: lm.data?.defaults || {}, users: new Map((lm.data?.users || []).map(x => [x.user_id, x])) })
    setResets(pr.error ? null : pr.data || [])
    if (u.error) { setError(u.error); setReady(false); setUsers([]); return }
    setError(''); setReady(true); setUsers(u.data || []); setReqs(r.data || []); setOpen(o)
  }
  useEffect(() => { Promise.resolve().then(load) }, [])   // eslint-disable-line react-hooks/exhaustive-deps
  useNoticeFocus()   // пришли по уведомлению — нужная заявка подсвечена

  const act = async fn => { setBusy(true); const r = await fn(); setBusy(false); if (r?.error) setError(r.error); else await load() }
  const toggle = () => {
    const next = !open
    if (!next && !window.confirm('Закрыть свободную регистрацию? Зарегистрироваться смогут только те, чьи заявки вы одобрите.')) return
    act(() => adminSetSignup(next))
  }
  // Одобрить заявку: база выдаёт код; номер подтверждён в Telegram — бот сразу присылает его туда
  const approve = r => act(async () => {
    setInfo('')
    const a = await adminApproveRequest(r.id)
    if (a.missing) return adminSetRequest(r.id, 'approved')   // база ещё без подтверждения номера
    if (a.error) return a
    if (a.data?.telegram) {
      const t = await tgBot({ action: 'send_code', request_id: r.id, tel: r.digits, origin: siteOrigin() })
      setInfo(t.error ? `Код не ушёл в Telegram: ${t.error}. Отправьте его в WhatsApp.` : `Код отправлен в Telegram — ${r.full_name || r.phone}.`)
    } else setInfo(`Заявка одобрена. Отправьте код ${r.full_name || r.phone} в WhatsApp.`)
    return {}
  })
  const sendTg = r => act(async () => {
    const t = await tgBot({ action: 'send_code', request_id: r.id, tel: r.digits, origin: siteOrigin() })
    setInfo(t.error ? `Код не ушёл в Telegram: ${t.error}` : `Код отправлен в Telegram — ${r.full_name || r.phone}.`)
    return {}
  })
  const setupBot = () => act(async () => {
    const t = await tgBot({ action: 'setup' })
    setInfo(t.error ? `Бот не подключён: ${t.error}` : `Бот @${t.bot || TG_BOT} подключён и отвечает.`)
    return {}
  })
  // код по одобренной, но ещё не зарегистрированной заявке
  const codeRow = r => {
    if (r.registered || r.status !== 'approved') return null
    const dead = !r.code || r.code_expired || r.code_attempts >= 5
    // что делать мастеру — одной строкой: в Telegram код уходит сам, в WhatsApp — отправляете вы
    const tgWait = r.messenger === 'telegram' && !r.phone_verified_at
    const tgSent = !!r.phone_verified_at && !!r.code_sent_at && !dead
    const todo = tgSent ? ['✓ Код отправлен ботом в Telegram автоматически — ничего делать не нужно, ждём, когда человек его введёт.', 'var(--teal)']
      : tgWait ? ['⏳ Ничего делать не нужно: человек подтверждает номер в Telegram, бот пришлёт код сам. Если он пишет, что не получается, — отправьте код в WhatsApp.', 'var(--text-muted)']
      : r.phone_verified_at ? ['Номер подтверждён в Telegram — нажмите «В Telegram», бот отправит код.', 'var(--amber)']
      : r.code_sent_at ? ['✓ Код отправлен в WhatsApp — ждём, когда человек его введёт.', 'var(--teal)']
      : ['👉 Отправьте код в WhatsApp — кнопка ниже.', 'var(--amber)']
    return (
      <div style={{ marginTop: 6 }}>
        <div style={{ fontSize: 12, color: todo[1], marginBottom: 4, lineHeight: 1.35 }}>{todo[0]}</div>
        {r.code && <div style={{ fontSize: 13 }}>
          Код: <b style={{ fontSize: 16, letterSpacing: 2 }}>{r.code}</b>
          <span style={{ fontSize: 11, color: dead ? 'var(--danger)' : 'var(--text-hint)', marginLeft: 8 }}>
            {r.code_expired ? 'срок вышел' : r.code_attempts >= 5 ? 'попытки исчерпаны' : r.code_sent_at ? (r.phone_verified_at ? 'отправлен ботом в Telegram' : 'отправлен в WhatsApp') : r.code_attempts ? `неверных попыток: ${r.code_attempts}` : 'ждёт ввода'}
          </span>
        </div>}
        <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
          {dead ? <button type="button" disabled={busy} style={btn(tgWait ? undefined : 'main')} onClick={() => approve(r)}>{tgWait ? 'Выдать код для WhatsApp' : r.code ? 'Новый код' : 'Выдать код'}</button>
            : <>
              {r.tg_linked && <button type="button" disabled={busy} style={btn('main')} onClick={() => sendTg(r)}>В Telegram</button>}
              <a href={`https://wa.me/${r.digits}?text=${encodeURIComponent(codeMsg(r.code, r.digits))}`} target="_blank" rel="noreferrer" style={{ ...btn(r.tg_linked ? undefined : 'main'), textDecoration: 'none' }}>В WhatsApp</a>
              <button type="button" disabled={busy} style={btn()} onClick={() => approve(r)}>Новый код</button>
            </>}
        </div>
      </div>
    )
  }
  // Заблокировать номер: регистрация, заявка, смена пароля и вход для него больше не проходят (ему об этом не сообщается)
  const blockPhone = (ph, note, who) => {
    if (isEmail(ph) ? !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ph.trim()) : digits(ph).length < 10) { setError('Введите номер телефона полностью или адрес почты'); return }
    if (!window.confirm(`Заблокировать ${who ? `«${who}» (${ph})` : ph}?\n\nС этим номером нельзя будет зарегистрироваться, оставить заявку или войти. Сообщение о блокировке человек не увидит — у него просто не получится.\nАккаунт и заказы не удаляются (удалить можно отдельно). Снять блокировку — в списке «Заблокированные номера».`)) return
    act(async () => { const r = await adminBlockPhone(ph, note); if (!r.error) { setBlkPhone(''); setBlkNote(''); setInfo(`Номер ${ph} заблокирован.`) } return r })
  }
  const allow = () => {
    if (digits(phone).length < 10) { setError('Введите номер телефона полностью'); return }
    act(async () => { const r = await adminAllowPhone(phone, name); if (!r.error) { setPhone(''); setName('') } return r })
  }

  const fresh = reqs.filter(r => r.status === 'new')
  const waiting = reqs.filter(r => r.status === 'approved' && !r.registered)   // одобрены — ждут регистрации по коду
  const rest = reqs.filter(r => r.status !== 'new' && !waiting.includes(r))
  const q = find.trim().toLowerCase()
  const isProd = u => !!u.production_id && (u.production_status ?? 'approved') === 'approved'
  const betaOf = u => (beta instanceof Map ? beta.get(u.id) || [] : [])
  const prodCount = (users || []).filter(isProd).length
  // страна и город пользователя: свои, а у производства без них — из данных производства
  const landOf = u => countryCode(u.country || u.production_country) || '—'
  const townOf = u => String(u.city || u.production_city || '').trim() || '—'
  const cmp = (a, b) => a.localeCompare(b, 'ru', { sensitivity: 'base' })
  const isNew = u => !!seenAt && u.id !== user?.id && !!u.created_at && new Date(u.created_at) > new Date(seenAt)
  const newUsers = (users || []).filter(isNew).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
  useEffect(() => { newCount.current = newUsers.length })
  const inKind = (users || []).filter(u => !isNew(u)).filter(u => kind === 'all' || (kind === 'prod' ? isProd(u) : !isProd(u)))
  // сколько пользователей в каждой стране и городе — количество и доля
  const tally = (list, key) => { const m = new Map(); list.forEach(u => m.set(key(u), (m.get(key(u)) || 0) + 1)); return [...m.entries()].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])) }
  const lands = tally(inKind, landOf), towns = land ? tally(inKind.filter(u => landOf(u) === land), townOf) : []
  const pct = (n, of) => (of ? Math.round(n / of * 100) : 0)
  const shown = inKind.filter(u => (!land || landOf(u) === land) && (!town || townOf(u) === town))
    .sort((a, b) => cmp(landOf(a), landOf(b)) || cmp(townOf(a), townOf(b)) || cmp(String(a.full_name || ''), String(b.full_name || ''))).filter(u => !q || `${u.full_name || ''} ${u.phone || ''} ${u.email || ''}`.toLowerCase().includes(q) || (digits(q) && digits(u.phone || u.email).includes(digits(q))))
  // Удалить аккаунт целиком — номер освобождается, человек регистрируется заново
  const delUser = u => {
    const who = `${u.full_name || 'без имени'}${u.phone ? ' · ' + u.phone : ''}`
    if (!window.confirm(`Удалить аккаунт «${who}»?\n\nУдалятся вход, профиль и все его заказы (в том числе отправленные на производство). Восстановить нельзя.\nПосле этого он сможет зарегистрироваться заново с этим номером.`)) return
    if (!window.confirm('Точно удалить? Это действие необратимо.')) return
    act(async () => { const r = await adminDeleteUser(u.id); if (!r.error) setInfo(`Аккаунт «${who}» удалён — номер свободен для новой регистрации.`); return r })
  }
  // карточка пользователя: свёрнута — имя, «произв.», страна·город; нажатие — всё остальное
  const userCard = u => {
              const tel = digits(u.phone) || (byPhone(u) ? digits(String(u.email || '').split('@')[0]) : '')
              const wa = digits(u.whatsapp) || tel
    return (
                <div key={u.id} className="card" data-focus={`nu:${u.id}`} style={{ padding: '8px 12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <button type="button" onClick={() => flip(u.id)} style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0, width: '100%', background: 'none', border: 'none', padding: 0, textAlign: 'left', cursor: 'pointer', color: 'var(--text)' }}>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.full_name || 'Без имени'}{u.id === user?.id ? ' (вы)' : ''}</span>
                    {isProd(u) && <span style={{ fontSize: 10.5, padding: '1px 7px', borderRadius: 9, background: 'var(--amber-light)', color: 'var(--amber)', flexShrink: 0 }}>произв.</span>}
                    {betaOf(u).length > 0 && <span title="Бета-тестер" style={{ fontSize: 10.5, padding: '1px 7px', borderRadius: 9, background: 'var(--blue-light, var(--bg2))', color: 'var(--blue)', flexShrink: 0 }}>β</span>}
                    {posts?.has.get(u.id)?.size > 0 && <span title={'Выданы постпроцессоры: ' + posts.list.filter(p => posts.has.get(u.id).has(p.id)).map(p => p.name).join(', ')} style={{ fontSize: 10.5, padding: '1px 5px', borderRadius: 9, background: 'var(--teal-light)', color: 'var(--teal)', flexShrink: 0 }}>🔑{posts.has.get(u.id).size > 1 ? ' ' + posts.has.get(u.id).size : ''}</span>}
                    {posts?.own?.get(u.id) && (() => {
                      const o = posts.own.get(u.id), based = o.own.filter(x => x.base)
                      return <span title={'Свои постпроцессоры: ' + o.own.map(x => x.name + (x.base ? ` (на основе «${x.base}»)` : '')).join(', ')} style={{ fontSize: 10.5, padding: '1px 5px', borderRadius: 9, background: based.length ? 'var(--amber-light)' : 'var(--bg2)', color: based.length ? 'var(--amber)' : 'var(--text-muted)', flexShrink: 0 }}>⚙</span>
                    })()}
                    {posts?.asks.has(u.id) && <span title="Ждёт постпроцессор" style={{ fontSize: 10.5, padding: '1px 5px', borderRadius: 9, background: 'var(--amber-light)', color: 'var(--amber)', flexShrink: 0 }}>⏳</span>}
                    <span style={{ fontSize: 11, color: 'var(--text-hint)', flexShrink: 0, maxWidth: '38%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{landOf(u) === '—' ? '—' : `${landOf(u)}${townOf(u) === '—' ? '' : ' · ' + townOf(u)}`}</span>
                    <span style={{ color: 'var(--text-hint)', fontSize: 14, transform: openU.has(u.id) ? 'rotate(90deg)' : 'none', transition: 'transform .2s' }}>›</span>
                  </button>
                  {u.id !== user?.id && <WriteToUser id={u.id} name={u.full_name || u.phone || ''} label="✉"
                    style={{ width: 30, height: 26, borderRadius: 13, border: '0.5px solid var(--blue)', background: 'transparent', color: 'var(--blue)', fontSize: 13, cursor: 'pointer', flexShrink: 0, padding: 0 }}
                    onSent={() => setInfo(`Сообщение отправлено: ${u.full_name || u.phone || 'пользователю'}.`)} />}
                  </div>
                  {openU.has(u.id) && <div style={{ marginTop: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13 }}>
                        {tel ? <a href={`tel:+${tel}`} style={{ color: 'var(--blue)' }}>{u.phone || `+${tel}`}</a> : <span style={{ color: 'var(--text-hint)' }}>{u.email}</span>}
                        {wa && <a href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer" style={{ color: 'var(--teal)', marginLeft: 10, fontSize: 12 }}>WhatsApp</a>}
                        {u.id !== user?.id && <button type="button" onClick={() => { setWriteTo(writeTo === u.id ? null : u.id); setDraft('') }}
                          style={{ marginLeft: 10, fontSize: 12, color: 'var(--blue)', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>✉ Написать</button>}
                      </div>
                    </div>
                    <select value={u.role} disabled={busy || u.id === user?.id} onChange={e => act(() => adminSetRole(u.id, e.target.value))}
                      style={{ width: 'auto', padding: '4px 6px', fontSize: 12, borderRadius: 20 }}>
                      {ROLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </div>
                  {locEdit?.id === u.id ? (
                    <div style={{ marginTop: 8, display: 'flex', gap: 6, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                      <div style={{ flex: '1 1 120px', minWidth: 0 }}>
                        <div style={{ fontSize: 11, color: 'var(--text-hint)' }}>Страна</div>
                        <input type="text" list="admin-countries" value={locEdit.country} onChange={e => setLocEdit({ ...locEdit, country: e.target.value })} maxLength={60} style={{ fontSize: 13, padding: '6px 8px' }} />
                        <datalist id="admin-countries">{COUNTRY_NAMES.map(c => <option key={c} value={c} />)}</datalist>
                      </div>
                      <div style={{ flex: '1 1 120px', minWidth: 0 }}>
                        <div style={{ fontSize: 11, color: 'var(--text-hint)' }}>Город</div>
                        <input type="text" value={locEdit.city} onChange={e => setLocEdit({ ...locEdit, city: e.target.value })} maxLength={80} style={{ fontSize: 13, padding: '6px 8px' }} />
                      </div>
                      <button type="button" style={btn()} onClick={() => setLocEdit(null)}>Отмена</button>
                      <button type="button" style={btn('main')} disabled={busy || !locEdit.country.trim()} onClick={() => act(async () => {
                        const r = await adminSetLocation(u.id, locEdit.country, locEdit.city)
                        if (!r.error) { setLocEdit(null); setInfo(`Страна и город изменены: ${u.full_name || u.phone || 'пользователь'}.`) }
                        return r
                      })}>Сохранить</button>
                    </div>
                  ) : (
                    <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span>{[u.country, u.city].map(v => String(v || '').trim()).filter(Boolean).join(', ') || 'Страна и город не указаны'}</span>
                      <button type="button" onClick={() => setLocEdit({ id: u.id, country: String(u.country || ''), city: String(u.city || '') })}
                        style={{ fontSize: 12, color: 'var(--blue)', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>✎ Изменить</button>
                    </div>
                  )}
                  {writeTo === u.id && (
                    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <div style={{ fontSize: 11.5, color: 'var(--text-hint)' }}>Личное сообщение — увидит только {u.full_name || 'этот пользователь'} (в «Сообщениях» и уведомлением на телефон)</div>
                      <textarea value={draft} onChange={e => setDraft(e.target.value)} rows={3} autoFocus placeholder="Текст сообщения…" style={{ fontSize: 14 }} />
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        <button type="button" style={btn()} onClick={() => setWriteTo(null)}>Отмена</button>
                        <button type="button" style={btn('main')} disabled={busy || !draft.trim()} onClick={() => act(async () => {
                          const r = await sendReply(user, profile, u.id, draft.trim(), u.full_name || u.phone || '')
                          if (!r.error) { setWriteTo(null); setDraft(''); setInfo(`Сообщение отправлено: ${u.full_name || u.phone || 'пользователю'}.`) }
                          return r
                        })}>Отправить</button>
                      </div>
                    </div>
                  )}
                  {u.production_id && !isProd(u) && (
                    <div style={{ fontSize: 12, marginTop: 6, color: 'var(--text-hint)', display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ flex: 1 }}>Производство «{u.production_name}» — {u.production_status === 'rejected' ? 'отклонено' : 'ждёт подтверждения'}</span>
                      {u.production_status === 'rejected' && <button type="button" disabled={busy} style={btn()} onClick={() => act(() => adminSetProduction(u.production_id, 'approved'))}>Подтвердить</button>}
                    </div>
                  )}
                  {isProd(u) && (
                    <div style={{ fontSize: 12, marginTop: 6, padding: '6px 8px', background: 'var(--amber-light)', borderRadius: 'var(--radius)', color: 'var(--amber)' }}>
                      Производство «{u.production_name}»{[u.production_country, u.production_city].filter(Boolean).length ? `, ${[u.production_country, u.production_city].filter(Boolean).join(', ')}` : ''}: заявок получено <b>{u.received}</b> · принято <b>{u.accepted}</b> · исполнено <b>{u.done}</b>
                    </div>
                  )}
                  {beta instanceof Map && u.role !== 'admin' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 11.5, color: 'var(--text-hint)' }}>Бета-тест:</span>
                      {BETA_FEATURES.map(([f, label]) => {
                        const on = betaOf(u).includes(f)
                        return (
                          <button key={f} type="button" disabled={busy} onClick={() => act(() => adminSetBeta(u.id, f, !on))}
                            style={{ padding: '3px 10px', borderRadius: 14, fontSize: 11.5, cursor: 'pointer', border: `0.5px solid ${on ? 'var(--blue)' : 'var(--border-md)'}`, background: on ? 'var(--blue)' : 'transparent', color: on ? 'white' : 'var(--text-muted)' }}>
                            β {label}{on ? ' ✓' : ''}
                          </button>
                        )
                      })}
                    </div>
                  )}
                  {posts && posts.list.length > 0 && u.role !== 'admin' && (isProd(u) || posts.has.has(u.id) || posts.asks.has(u.id) || posts.own?.has(u.id)) && (
                    <div style={{ marginTop: 6 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 11.5, color: 'var(--text-hint)' }}>Постпроцессоры:</span>
                        {posts.list.map(p => {
                          const on = !!posts.has.get(u.id)?.has(p.id), asked = (posts.asks.get(u.id) || []).some(q => q.post_id === p.id)
                          return (
                            <button key={p.id} type="button" disabled={busy} title={on ? 'Выдан — нажмите, чтобы отозвать' : 'Выдать'}
                              onClick={() => {
                                if (on && !window.confirm(`Отозвать «${p.name}» у ${u.full_name || 'пользователя'}?`)) return
                                act(async () => {
                                  const r = on ? await revokePost(p.id, u.id) : await grantPost(p.id, u.id, 'выдан в «Пользователи»')
                                  if (!r.error && !on) for (const q of (posts.asks.get(u.id) || []).filter(q => q.post_id === p.id || !q.post_id)) await setRequestStatus(q.id, 'done')
                                  if (!r.error && !on) setNotifyU({ id: u.id, name: u.full_name || u.phone || '', post: p.name })   // сразу — написать, что выдан
                                  return r
                                })
                              }}
                              style={{ padding: '3px 10px', borderRadius: 14, fontSize: 11.5, cursor: 'pointer', border: `0.5px solid ${on ? 'var(--teal)' : asked ? 'var(--amber)' : 'var(--border-md)'}`, background: on ? 'var(--teal)' : asked ? 'var(--amber-light)' : 'transparent', color: on ? 'white' : asked ? 'var(--amber)' : 'var(--text-muted)' }}>
                              🔑 {p.name}{on ? ' ✓' : asked ? ' · просит' : ''}
                            </button>
                          )
                        })}
                      </div>
                      {posts.own?.get(u.id) && (
                        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>
                          ⚙ Свои: {posts.own.get(u.id).own.map((x, i) => <span key={i}>{i ? ', ' : ''}«{x.name}»{x.base ? <span style={{ color: 'var(--amber)' }}> — на основе «{x.base}»</span> : null}</span>)}
                          {posts.own.get(u.id).own_runs > 0 ? ` · выпущено своими: ${posts.own.get(u.id).own_runs}` : ''}
                        </div>
                      )}
                      {(posts.asks.get(u.id) || []).filter(q => !q.post_id).map(q => (
                        <div key={q.id} style={{ fontSize: 11.5, color: 'var(--amber)', marginTop: 3 }}>Запрос под свой станок: {[q.machine, q.controller].filter(Boolean).join(' · ') || 'без описания'} — подробности и пример программы в «Постпроцессоры по запросу»</div>
                      ))}
                    </div>
                  )}
                  {lim && !lim.error && <UserLimits key={JSON.stringify(lim.users.get(u.id) || {})} u={u} data={lim.users.get(u.id)} defaults={lim.defaults} isProd={isProd(u)} busy={busy}
                    onSave={(id, unl, l) => act(() => adminSetUserLimits(id, unl, l))} />}
                  {u.id !== user?.id && u.role !== 'admin' && (
                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
                      <button type="button" disabled={busy} onClick={() => blockPhone(byPhone(u) ? (u.phone || ('+' + digits(u.email))) : u.email, '', u.full_name || '')} style={{ ...btn('danger'), padding: '4px 10px', fontSize: 11, marginRight: 6 }}>{byPhone(u) ? '🚫 Заблокировать номер' : '🚫 Заблокировать почту'}</button>
                      <button type="button" disabled={busy} onClick={() => delUser(u)} style={{ ...btn('danger'), padding: '4px 10px', fontSize: 11 }}>Удалить аккаунт</button>
                    </div>
                  )}
                  <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 4 }}>
                    Регистрация {date(u.created_at)} · последний вход {date(u.last_sign_in_at)} · заказов создано {u.orders}{u.submitted != null ? `, оформлено ${u.submitted}` : ''}{u.last_order_at ? ` (последний ${date(u.last_order_at)})` : ''}
                  </div>
                  </div>}
                </div>
    )
  }
  const btn = (kind) => ({ padding: '6px 12px', borderRadius: 20, fontSize: 12, cursor: 'pointer', border: kind === 'main' ? 'none' : `0.5px solid ${kind === 'danger' ? 'var(--danger)' : 'var(--border-md)'}`, background: kind === 'main' ? 'var(--blue)' : 'transparent', color: kind === 'main' ? 'white' : kind === 'danger' ? 'var(--danger)' : 'var(--text-muted)', whiteSpace: 'nowrap' })
  const statusLabel = r => (r.registered ? 'зарегистрирован' : r.status === 'approved' ? 'одобрена — ждём регистрации' : 'отклонена')

  return (
    <div className="page" style={{ paddingBottom: 100 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, paddingTop: 8 }}>
        <MenuButton />
        <h1 style={{ fontSize: 18, fontWeight: 500 }}>Пользователи</h1>
      </div>
      {error && <p className="error-text" style={{ marginBottom: 12 }}>{error}</p>}
      {info && <p style={{ fontSize: 13, color: 'var(--teal)', marginBottom: 12 }} onClick={() => setInfo('')}>{info}</p>}
      {users === null ? <CncLoader label="Собираем список…" /> : !ready ? (
        <div className="card">
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 10 }}>Список пользователей и переключатель регистрации появятся, когда база будет обновлена: откройте Supabase → SQL Editor, вставьте содержимое файла <b>migration_security_all.sql</b> и нажмите Run.</p>
          <button type="button" onClick={load} style={btn('main')}>Проверить ещё раз</button>
        </div>
      ) : (
        <>
          <AppStopCard />
          <div className="card" style={{ marginBottom: 12, border: open ? undefined : '1px solid var(--amber)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 500, fontSize: 15 }}>{open ? 'Регистрация открыта' : 'Регистрация только по запросу'}</div>
                <div style={{ fontSize: 12, color: 'var(--text-hint)', marginTop: 2 }}>
                  {open ? 'Зарегистрироваться может любой — после подтверждения номера: в Telegram сразу, через WhatsApp — по вашему коду.' : 'Новый человек оставляет заявку; зарегистрироваться он сможет после того, как вы её одобрите.'}
                </div>
              </div>
              <button type="button" disabled={busy} onClick={toggle} style={btn(open ? 'danger' : 'main')}>{open ? 'Закрыть регистрацию' : 'Открыть для всех'}</button>
            </div>
            {emailOpen != null && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, paddingTop: 10, borderTop: '0.5px solid var(--border)' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 500, fontSize: 14 }}>{emailOpen ? 'Регистрация по email и Google — включена' : 'Регистрация по email и Google — выключена'}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-hint)', marginTop: 2 }}>Для зарубежных: без Telegram/WhatsApp и без вашего одобрения. Новые аккаунты появятся вверху как «без вашего одобрения».</div>
                </div>
                <button type="button" disabled={busy} style={btn(emailOpen ? 'danger' : 'main')}
                  onClick={() => { if (emailOpen && !window.confirm('Выключить регистрацию по email и Google? Уже зарегистрированные по-прежнему смогут входить.')) return; act(() => adminSetEmailSignup(!emailOpen)) }}>
                  {emailOpen ? 'Выключить' : 'Включить'}</button>
              </div>
            )}
          </div>

          <div className="card" style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 500, fontSize: 14 }}>Telegram-бот @{TG_BOT}</div>
              <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 2 }}>Подтверждает номера в заявках и присылает коды. Нажмите один раз после установки функции бота — и при её обновлении.</div>
            </div>
            <button type="button" disabled={busy} onClick={setupBot} style={btn()}>Подключить бота</button>
          </div>

          {resets === null && <p style={{ fontSize: 11, color: 'var(--amber)', marginBottom: 10 }}>{RESET_SQL_HINT}</p>}
          {helps?.some(h => h.status === 'new') && (
            <>
              <p className="section-title">Не получается войти · {helps.filter(h => h.status === 'new').length}</p>
              <div className="card" data-focus="lh" style={{ marginBottom: 12, border: '1px solid var(--amber)' }}>
                <p style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 6 }}>Написали с экрана входа. Аккаунт есть — ниже, в «Восстановлении пароля», уже есть запрос: выдайте код и отправьте в WhatsApp. Аккаунта нет — свяжитесь с человеком или разрешите регистрацию его номеру.</p>
                {helps.filter(h => h.status === 'new').map(h => (
                  <div key={h.id} style={{ padding: '8px 0', borderTop: '0.5px solid var(--border)' }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                      <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.name || 'Без имени'}</span>
                      <a href={`tel:+${h.digits}`} style={{ fontSize: 12, color: 'var(--blue)' }}>+{h.digits}</a>
                    </div>
                    <div style={{ fontSize: 11, color: h.registered ? 'var(--teal)' : 'var(--amber)' }}>
                      {h.registered ? 'аккаунт есть — нужен новый пароль' : h.request_status ? `аккаунта нет · заявка: ${h.request_status === 'approved' ? 'одобрена' : h.request_status === 'new' ? 'ждёт' : 'отклонена'}` : 'аккаунта нет'} · {date(h.created_at)}
                    </div>
                    {h.body && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{h.body}</div>}
                    <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                      <a href={`https://wa.me/${h.digits}`} target="_blank" rel="noreferrer" style={{ ...btn('main'), textDecoration: 'none', background: '#25D366' }}>WhatsApp</a>
                      {!h.registered && <button type="button" disabled={busy} style={btn()} onClick={() => act(() => adminAllowPhone('+' + h.digits, h.name || ''))}>Разрешить регистрацию</button>}
                      {h.registered && h.user_id && <button type="button" disabled={busy} style={btn('danger')} onClick={() => { const u = (users || []).find(x => x.id === h.user_id); if (u) delUser(u) }}>Удалить аккаунт</button>}
                      <button type="button" disabled={busy} style={btn()} onClick={() => act(() => adminCloseLoginHelp(h.id))}>Решено</button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
          {resets?.some(r => r.status !== 'done') && (
            <>
              <p className="section-title">Восстановление пароля · {resets.filter(r => r.status !== 'done').length}</p>
              <div className="card" style={{ marginBottom: 12, border: '1px solid var(--amber)' }}>
                <p style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 6 }}>Убедитесь, что пишет сам владелец номера, выдайте код и отправьте его. Код действует сутки, 5 попыток ввода.</p>
                {resets.filter(r => r.status !== 'done').map(r => {
                  const wa = digits(r.whatsapp) || r.digits
                  const dead = r.status === 'issued' && (r.expired || r.attempts >= 5)
                  const msg = `Код для смены пароля в RaskroyPro: ${r.code}. Откройте вход → «Забыли пароль?», введите код и новый пароль.`
                  return (
                    <div key={r.id} data-focus={`pw:${r.id}`} style={{ padding: '8px 0', borderTop: '0.5px solid var(--border)' }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                        <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.full_name || 'Без имени'}</span>
                        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{r.phone || '+' + r.digits}</span>
                      </div>
                      {r.status === 'issued' && (
                        <div style={{ fontSize: 13, marginTop: 2 }}>
                          Код: <b style={{ fontSize: 16, letterSpacing: 2 }}>{r.code}</b>
                          <span style={{ fontSize: 11, color: dead ? 'var(--danger)' : 'var(--text-hint)', marginLeft: 8 }}>{r.expired ? 'срок вышел' : r.attempts >= 5 ? 'попытки исчерпаны' : r.attempts ? `неверных попыток: ${r.attempts}` : 'ждёт ввода'}</span>
                        </div>
                      )}
                      <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                        <button type="button" disabled={busy} style={btn(r.status === 'new' || dead ? 'main' : undefined)} onClick={() => act(() => adminIssueReset(r.id))}>{r.status === 'new' ? 'Выдать код' : 'Новый код'}</button>
                        {r.status === 'issued' && !dead && <a href={`https://wa.me/${wa}?text=${encodeURIComponent(msg)}`} target="_blank" rel="noreferrer" style={{ ...btn('main'), textDecoration: 'none' }}>Отправить в WhatsApp</a>}
                        <button type="button" disabled={busy} style={btn('danger')} onClick={() => act(() => adminCloseReset(r.id))}>Отказать</button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </>
          )}

          <p className="section-title">Заявки на регистрацию{fresh.length ? ` · новых ${fresh.length}` : ''}</p>
          <div className="card" style={{ marginBottom: 12 }}>
            {!fresh.length && <p style={{ fontSize: 12, color: 'var(--text-hint)', marginBottom: 8 }}>Новых заявок нет.</p>}
            {fresh.map(r => (
              <div key={r.id} data-focus={`rq:${r.id}`} style={{ padding: '8px 0', borderBottom: '0.5px solid var(--border)' }}>
                <div style={{ fontSize: 14, fontWeight: 500 }}>{r.full_name || 'Без имени'}
                  {r.resubmits > 0 && <span style={{ marginLeft: 6, padding: '1px 7px', borderRadius: 9, fontSize: 10.5, fontWeight: 500, background: 'var(--amber-light)', color: 'var(--amber)' }}>повторная{r.resubmits > 1 ? ` ×${r.resubmits}` : ''}</span>}
                </div>
                {r.resubmits > 0 && r.rejected_name && <div style={{ fontSize: 11, color: 'var(--text-hint)' }}>отклонена с именем «{r.rejected_name}»</div>}
                <div style={{ fontSize: 13 }}><a href={`tel:+${r.digits}`} style={{ color: 'var(--blue)' }}>{r.phone}</a> <span style={{ color: 'var(--text-hint)', fontSize: 11 }}>· заявка {dateTime(r.created_at)}</span></div>
                {(r.country || r.city) && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{[countryCode(r.country), r.city].filter(Boolean).join(' · ')}</div>}
                {r.comment && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{r.comment}</div>}
                <div style={{ marginTop: 2 }}><VerifyBadge r={r} /></div>
                <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                  <button type="button" disabled={busy} style={btn('main')} onClick={() => approve(r)}>Одобрить</button>
                  <button type="button" disabled={busy} style={btn('danger')} onClick={() => act(() => adminSetRequest(r.id, 'rejected'))}>Отклонить</button>
                  <a href={`https://wa.me/${r.digits}`} target="_blank" rel="noreferrer" style={{ ...btn(), textDecoration: 'none' }}>WhatsApp</a>
                </div>
              </div>
            ))}
            {waiting.length > 0 && <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-muted)', margin: '10px 0 2px' }}>Одобрены — ждут регистрации · {waiting.length}</div>}
            {waiting.map(r => (
              <div key={r.id} style={{ padding: '8px 0', borderBottom: '0.5px solid var(--border)' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.full_name || 'Без имени'}</span>
                  <a href={`tel:+${r.digits}`} style={{ fontSize: 12, color: 'var(--blue)' }}>{r.phone}</a>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-hint)' }}>Заявка подана {dateTime(r.created_at)}</div>
                {r.ref_by_name && <div style={{ fontSize: 11, color: 'var(--teal)' }}>по ссылке{r.ref_kind === 'production' ? ' для производства' : ''} от «{r.ref_by_name}» — одобрена сама</div>}
                <VerifyBadge r={r} />
                {codeRow(r)}
                <div style={{ marginTop: 4 }}>
                  <button type="button" disabled={busy} style={{ ...btn('danger'), padding: '3px 10px', fontSize: 11 }} onClick={() => act(() => adminSetRequest(r.id, 'rejected'))}>Отозвать</button>
                </div>
              </div>
            ))}
            <div style={{ fontSize: 12, color: 'var(--text-muted)', margin: '10px 0 6px' }}>Разрешить регистрацию номеру без заявки:</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input type="tel" placeholder="+7 700 000 00 00" value={phone} onChange={e => setPhone(e.target.value)} style={{ flex: 1.2, minWidth: 0 }} />
              <input type="text" placeholder="Имя" value={name} onChange={e => setName(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
              <button type="button" disabled={busy} style={btn('main')} onClick={allow}>Разрешить</button>
            </div>
            {/* Заблокированные номера: ни регистрации, ни заявки, ни входа — без сообщения о блокировке */}
            <details style={{ marginTop: 12 }}>
              <summary style={{ fontSize: 12, color: 'var(--danger)', cursor: 'pointer' }}>🚫 Заблокированные номера{Array.isArray(blocked) ? ` (${blocked.length})` : ''}</summary>
              {blocked?.error ? <p style={{ fontSize: 12, color: 'var(--amber)', margin: '6px 0' }}>{blocked.error}</p> : (
                <>
                  <div style={{ fontSize: 11, color: 'var(--text-hint)', margin: '6px 0' }}>С этих номеров нельзя зарегистрироваться (даже по ссылке-приглашению), оставить заявку, сменить пароль или войти. Человек не видит, что заблокирован, — у него просто не получается.</div>
                  <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                    <input type="text" placeholder="+7 700 000 00 00 или почта" value={blkPhone} onChange={e => setBlkPhone(e.target.value)} style={{ flex: 1.2, minWidth: 0 }} />
                    <input type="text" placeholder="Пометка (для себя)" value={blkNote} onChange={e => setBlkNote(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
                    <button type="button" disabled={busy} style={btn('danger')} onClick={() => blockPhone(blkPhone, blkNote, '')}>Заблокировать</button>
                  </div>
                  {(blocked || []).map(b => (
                    <div key={b.digits} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderTop: '0.5px solid var(--border)', fontSize: 12 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div>{isEmail(b.digits) ? '' : '+'}{b.digits}{b.name ? ` · ${b.name}` : ''}{b.user_id ? <span style={{ color: 'var(--text-hint)' }}> · аккаунт есть, вход закрыт</span> : ''}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-hint)' }}>{b.note ? `${b.note} · ` : ''}с {dateTime(b.created_at)}</div>
                      </div>
                      <button type="button" disabled={busy} style={btn()} onClick={() => { const v = isEmail(b.digits) ? b.digits : '+' + b.digits; if (window.confirm(`Снять блокировку с ${v}?`)) act(() => adminUnblockPhone(v)) }}>Разблокировать</button>
                    </div>
                  ))}
                </>
              )}
            </details>
            {rest.length > 0 && (
              <details style={{ marginTop: 10 }}>
                <summary style={{ fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}>Рассмотренные ({rest.length})</summary>
                {rest.map(r => (
                  <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderTop: '0.5px solid var(--border)', fontSize: 12 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div>{r.full_name || 'Без имени'} · {r.phone} <span style={{ color: 'var(--text-hint)', fontSize: 11 }}>· заявка {dateTime(r.created_at)}</span></div>
                      <div style={{ color: r.status === 'rejected' ? 'var(--danger)' : 'var(--text-hint)' }}>{statusLabel(r)} <VerifyBadge r={r} /></div>
                      {codeRow(r)}
                    </div>
                    {!r.registered && r.status === 'approved' && <button type="button" disabled={busy} style={btn('danger')} onClick={() => act(() => adminSetRequest(r.id, 'rejected'))}>Отозвать</button>}
                    {r.status === 'rejected' && <button type="button" disabled={busy} style={btn()} onClick={() => act(() => adminSetRequest(r.id, 'approved'))}>Одобрить</button>}
                    <button type="button" disabled={busy} title="Убрать из списка" style={{ background: 'none', border: 'none', color: 'var(--text-hint)', fontSize: 16 }} onClick={() => act(() => adminSetRequest(r.id, 'delete'))}>✕</button>
                  </div>
                ))}
              </details>
            )}
          </div>

          {users.some(u => u.production_status === 'pending') && (
            <>
              <p className="section-title">Производства ждут подтверждения · {users.filter(u => u.production_status === 'pending').length}</p>
              <div className="card" style={{ marginBottom: 12, border: '1px solid var(--amber)' }}>
                {users.filter(u => u.production_status === 'pending').map(u => (
                  <div key={u.production_id} data-focus={`pd:${u.production_id}`} style={{ padding: '8px 0', borderBottom: '0.5px solid var(--border)' }}>
                    <div style={{ fontSize: 14, fontWeight: 500 }}>{u.production_name}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{[u.production_country, u.production_city, u.production_phone].filter(Boolean).join(' · ') || 'страна не указана'}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-hint)' }}>Владелец: {u.full_name || 'без имени'}{u.phone ? ` · ${u.phone}` : ''}</div>
                    <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                      <button type="button" disabled={busy} style={btn('main')} onClick={() => act(() => adminSetProduction(u.production_id, 'approved'))}>Подтвердить</button>
                      <button type="button" disabled={busy} style={btn('danger')} onClick={() => act(() => adminSetProduction(u.production_id, 'rejected'))}>Отклонить</button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
          {lim?.error ? <p style={{ fontSize: 12, color: 'var(--amber)', marginBottom: 12 }}>{lim.error}</p>
            : lim && <DefaultLimits key={JSON.stringify(lim.defaults)} defaults={lim.defaults} busy={busy} onSave={v => act(() => adminSetDefaultLimits(v))} />}
          {beta?.error ? <p style={{ fontSize: 12, color: 'var(--amber)', marginBottom: 12 }}>{beta.error}</p> : beta instanceof Map && (
            <details className="card" style={{ marginBottom: 12, padding: '10px 12px' }}>
              <summary style={{ fontSize: 14, fontWeight: 500, cursor: 'pointer' }}>Бета-тест · {(users || []).filter(u => betaOf(u).length).length}</summary>
              <p style={{ fontSize: 11.5, color: 'var(--text-hint)', margin: '6px 0 8px' }}>
                Новые функции видят только вы и выбранные пользователи — клиенты или производства. Включить: откройте карточку пользователя ниже → «β …».
              </p>
              {BETA_FEATURES.map(([f, label]) => {
                const who = (users || []).filter(u => betaOf(u).includes(f))
                return (
                  <div key={f} style={{ fontSize: 12.5, marginBottom: 4 }}>
                    <b>β {label}</b>: {who.length ? who.map(u => u.full_name || u.phone || 'без имени').join(', ') : <span style={{ color: 'var(--text-hint)' }}>пока только вы</span>}
                  </div>
                )
              })}
            </details>
          )}
          {newUsers.length > 0 && (
            <>
              <p className="section-title" style={{ color: 'var(--teal)' }}>Новые с прошлого просмотра · {newUsers.length}</p>
              <div style={{ border: '1px solid var(--teal)', borderRadius: 'var(--radius)', padding: 8, marginBottom: 12 }}>
                <p style={{ fontSize: 11, color: 'var(--text-hint)', margin: '0 0 6px' }}>Зарегистрировались без вашего одобрения — по ссылкам-приглашениям или при открытой регистрации. После просмотра они перейдут в общий список.</p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{newUsers.map(userCard)}</div>
                <button type="button" onClick={markSeen} style={{ ...btn('main'), width: '100%', marginTop: 8, background: 'var(--teal)' }}>Просмотрено ✓</button>
              </div>
            </>
          )}
          <p className="section-title">Зарегистрированы ({users.length - newUsers.length})</p>
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            {[['all', `Все · ${users.length}`], ['client', `Клиенты · ${users.length - prodCount}`], ['prod', `Производства · ${prodCount}`]].map(([id, label]) => (
              <button key={id} type="button" onClick={() => setKind(id)} style={{ flex: 1, padding: '7px 4px', borderRadius: 20, border: 'none', fontSize: 12, background: kind === id ? 'var(--blue)' : 'var(--bg2)', color: kind === id ? 'white' : 'var(--text-muted)' }}>{label}</button>
            ))}
          </div>
          {/* страны и города: количество и доля; нажатие оставляет в списке только их */}
          <div className="card" style={{ padding: '8px 10px', marginBottom: 8 }}>
            <div style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 4 }}>По странам{land ? ' и городам' : ''} · список отсортирован: страна, город, имя</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {lands.map(([c, n]) => (
                <button key={c} type="button" onClick={() => { setLand(land === c ? '' : c); setTown('') }}
                  style={{ padding: '4px 10px', borderRadius: 14, fontSize: 12, cursor: 'pointer', border: `0.5px solid ${land === c ? 'var(--blue)' : 'var(--border-md)'}`, background: land === c ? 'var(--blue)' : 'transparent', color: land === c ? 'white' : 'var(--text)' }}>
                  {c === '—' ? 'не указана' : c} · {n} · {pct(n, inKind.length)} %
                </button>
              ))}
            </div>
            {land && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                {towns.map(([c, n]) => (
                  <button key={c} type="button" onClick={() => setTown(town === c ? '' : c)}
                    style={{ padding: '3px 9px', borderRadius: 14, fontSize: 11, cursor: 'pointer', border: `0.5px solid ${town === c ? 'var(--teal)' : 'var(--border-md)'}`, background: town === c ? 'var(--teal)' : 'transparent', color: town === c ? 'white' : 'var(--text-muted)' }}>
                    {c === '—' ? 'город не указан' : c} · {n} · {pct(n, lands.find(l => l[0] === land)?.[1] || 0)} %
                  </button>
                ))}
              </div>
            )}
          </div>
          {users.length > 6 && <input type="text" placeholder="Поиск: имя или телефон" value={find} onChange={e => setFind(e.target.value)} style={{ marginBottom: 8 }} />}
          {/* значки у имени — коротко; «?» раскрывает, что они значат */}
          <details style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--text-muted)' }}>
            <summary style={{ cursor: 'pointer', listStyle: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 18, height: 18, borderRadius: 9, border: '1px solid var(--border-md)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 600 }}>?</span>
              Что значат значки
            </summary>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '6px 2px 0' }}>
              <span><b style={{ color: 'var(--blue)' }}>β</b> — бета-тестер</span>
              <span><b style={{ color: 'var(--teal)' }}>🔑</b> — вы выдали постпроцессор (число — сколько)</span>
              <span><b style={{ padding: '0 4px', borderRadius: 6, background: 'var(--bg2)' }}>⚙</b> серый — свой постпроцессор, настроил сам</span>
              <span><b style={{ padding: '0 4px', borderRadius: 6, background: 'var(--amber-light)', color: 'var(--amber)' }}>⚙</b> жёлтый — свой, взятый за основу из каталога</span>
              <span><b style={{ color: 'var(--amber)' }}>⏳</b> — просит постпроцессор</span>
              <span style={{ color: 'var(--text-hint)' }}>Подробнее — в карточке пользователя (нажать на имя).</span>
            </div>
          </details>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {shown.map(userCard)}
          </div>
        </>
      )}
      {notifyU && <WriteToUserDialog to={notifyU} post={notifyU.post}
        text={`Здравствуйте! Выдал вам постпроцессор «${notifyU.post}». Он появился в настройках ЧПУ (Профиль → Настройки ЧПУ → станок). Попробуйте выпустить программу и напишите, как отработал станок.`}
        onClose={() => setNotifyU(null)} onSent={() => setInfo(`Сообщение отправлено: ${notifyU.name || 'пользователю'}.`)} />}
      <BottomNav />
    </div>
  )
}
