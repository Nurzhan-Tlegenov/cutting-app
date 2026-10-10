import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import BottomNav from '../components/BottomNav'
import { adminSetProduction } from '../lib/productionApi'
import { adminUsers, adminRequests, adminSetSignup, adminSetRequest, adminAllowPhone, adminSetRole, signupOpen, adminPasswordResets, adminIssueReset, adminCloseReset, RESET_SQL_HINT } from '../lib/adminApi'
import CncLoader from '../components/CncLoader'
import { DefaultLimits, UserLimits } from '../components/LimitsAdmin'
import { adminLimits, adminSetDefaultLimits, adminSetUserLimits } from '../lib/limits'
import { countryCode } from '../lib/productionLabel'

// Администратор: кто зарегистрирован, заявки на регистрацию и переключатель «регистрация открыта / по запросу».
const ROLES = [['client', 'Клиент'], ['operator', 'Производство'], ['admin', 'Администратор']]
const date = v => (v ? new Date(v).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '—')
const digits = v => String(v || '').replace(/\D/g, '')

export default function UsersPage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [users, setUsers] = useState(null)
  const [reqs, setReqs] = useState([])
  const [resets, setResets] = useState(null)   // запросы на восстановление пароля; null — в базе ещё нет этой части
  const [open, setOpen] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [phone, setPhone] = useState('')
  const [name, setName] = useState('')
  const [find, setFind] = useState('')
  const [kind, setKind] = useState('all')      // все / клиенты / производства
  const [land, setLand] = useState('')         // страна (обозначение) — фильтр списка
  const [town, setTown] = useState('')         // город — фильтр списка
  const [ready, setReady] = useState(false)   // база ответила: функции на месте и вы администратор
  const [lim, setLim] = useState(null)         // лимиты: { defaults, users } или { error } — в базе ещё нет лимитов

  const load = async () => {
    const [u, r, o, pr, lm] = await Promise.all([adminUsers(), adminRequests(), signupOpen(), adminPasswordResets(), adminLimits()])
    setLim(lm.error ? { error: lm.error } : { defaults: lm.data?.defaults || {}, users: new Map((lm.data?.users || []).map(x => [x.user_id, x])) })
    setResets(pr.error ? null : pr.data || [])
    if (u.error) { setError(u.error); setReady(false); setUsers([]); return }
    setError(''); setReady(true); setUsers(u.data || []); setReqs(r.data || []); setOpen(o)
  }
  useEffect(() => { Promise.resolve().then(load) }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  const act = async fn => { setBusy(true); const r = await fn(); setBusy(false); if (r?.error) setError(r.error); else await load() }
  const toggle = () => {
    const next = !open
    if (!next && !window.confirm('Закрыть свободную регистрацию? Зарегистрироваться смогут только те, чьи заявки вы одобрите.')) return
    act(() => adminSetSignup(next))
  }
  const allow = () => {
    if (digits(phone).length < 10) { setError('Введите номер телефона полностью'); return }
    act(async () => { const r = await adminAllowPhone(phone, name); if (!r.error) { setPhone(''); setName('') } return r })
  }

  const fresh = reqs.filter(r => r.status === 'new')
  const rest = reqs.filter(r => r.status !== 'new')
  const q = find.trim().toLowerCase()
  const isProd = u => !!u.production_id && (u.production_status ?? 'approved') === 'approved'
  const prodCount = (users || []).filter(isProd).length
  // страна и город пользователя: свои, а у производства без них — из данных производства
  const landOf = u => countryCode(u.country || u.production_country) || '—'
  const townOf = u => String(u.city || u.production_city || '').trim() || '—'
  const cmp = (a, b) => a.localeCompare(b, 'ru', { sensitivity: 'base' })
  const inKind = (users || []).filter(u => kind === 'all' || (kind === 'prod' ? isProd(u) : !isProd(u)))
  // сколько пользователей в каждой стране и городе — количество и доля
  const tally = (list, key) => { const m = new Map(); list.forEach(u => m.set(key(u), (m.get(key(u)) || 0) + 1)); return [...m.entries()].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])) }
  const lands = tally(inKind, landOf), towns = land ? tally(inKind.filter(u => landOf(u) === land), townOf) : []
  const pct = (n, of) => (of ? Math.round(n / of * 100) : 0)
  const shown = inKind.filter(u => (!land || landOf(u) === land) && (!town || townOf(u) === town))
    .sort((a, b) => cmp(landOf(a), landOf(b)) || cmp(townOf(a), townOf(b)) || cmp(String(a.full_name || ''), String(b.full_name || ''))).filter(u => !q || `${u.full_name || ''} ${u.phone || ''} ${u.email || ''}`.toLowerCase().includes(q) || (digits(q) && digits(u.phone || u.email).includes(digits(q))))
  const btn = (kind) => ({ padding: '6px 12px', borderRadius: 20, fontSize: 12, cursor: 'pointer', border: kind === 'main' ? 'none' : `0.5px solid ${kind === 'danger' ? 'var(--danger)' : 'var(--border-md)'}`, background: kind === 'main' ? 'var(--blue)' : 'transparent', color: kind === 'main' ? 'white' : kind === 'danger' ? 'var(--danger)' : 'var(--text-muted)', whiteSpace: 'nowrap' })
  const statusLabel = r => (r.registered ? 'зарегистрирован' : r.status === 'approved' ? 'одобрена — ждём регистрации' : 'отклонена')

  return (
    <div className="page" style={{ paddingBottom: 100 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, paddingTop: 8 }}>
        <button type="button" onClick={() => navigate('/profile')} style={{ background: 'none', border: 'none', color: 'var(--blue)', fontSize: 22, padding: 0, lineHeight: 1 }}>←</button>
        <h1 style={{ fontSize: 18, fontWeight: 500 }}>Пользователи</h1>
      </div>
      {error && <p className="error-text" style={{ marginBottom: 12 }}>{error}</p>}
      {users === null ? <CncLoader label="Собираем список…" /> : !ready ? (
        <div className="card">
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 10 }}>Список пользователей и переключатель регистрации появятся, когда база будет обновлена: откройте Supabase → SQL Editor, вставьте содержимое файла <b>migration_security_all.sql</b> и нажмите Run.</p>
          <button type="button" onClick={load} style={btn('main')}>Проверить ещё раз</button>
        </div>
      ) : (
        <>
          <div className="card" style={{ marginBottom: 12, border: open ? undefined : '1px solid var(--amber)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 500, fontSize: 15 }}>{open ? 'Регистрация открыта' : 'Регистрация только по запросу'}</div>
                <div style={{ fontSize: 12, color: 'var(--text-hint)', marginTop: 2 }}>
                  {open ? 'Зарегистрироваться может любой, кто откроет приложение.' : 'Новый человек оставляет заявку; зарегистрироваться он сможет после того, как вы её одобрите.'}
                </div>
              </div>
              <button type="button" disabled={busy} onClick={toggle} style={btn(open ? 'danger' : 'main')}>{open ? 'Закрыть регистрацию' : 'Открыть для всех'}</button>
            </div>
          </div>

          {resets === null && <p style={{ fontSize: 11, color: 'var(--amber)', marginBottom: 10 }}>{RESET_SQL_HINT}</p>}
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
                    <div key={r.id} style={{ padding: '8px 0', borderTop: '0.5px solid var(--border)' }}>
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
              <div key={r.id} style={{ padding: '8px 0', borderBottom: '0.5px solid var(--border)' }}>
                <div style={{ fontSize: 14, fontWeight: 500 }}>{r.full_name || 'Без имени'}</div>
                <div style={{ fontSize: 13 }}><a href={`tel:+${r.digits}`} style={{ color: 'var(--blue)' }}>{r.phone}</a> <span style={{ color: 'var(--text-hint)', fontSize: 11 }}>· {date(r.created_at)}</span></div>
                {(r.country || r.city) && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{[countryCode(r.country), r.city].filter(Boolean).join(' · ')}</div>}
                {r.comment && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{r.comment}</div>}
                <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                  <button type="button" disabled={busy} style={btn('main')} onClick={() => act(() => adminSetRequest(r.id, 'approved'))}>Одобрить</button>
                  <button type="button" disabled={busy} style={btn('danger')} onClick={() => act(() => adminSetRequest(r.id, 'rejected'))}>Отклонить</button>
                  <a href={`https://wa.me/${r.digits}`} target="_blank" rel="noreferrer" style={{ ...btn(), textDecoration: 'none' }}>WhatsApp</a>
                </div>
              </div>
            ))}
            <div style={{ fontSize: 12, color: 'var(--text-muted)', margin: '10px 0 6px' }}>Разрешить регистрацию номеру без заявки:</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input type="tel" placeholder="+7 700 000 00 00" value={phone} onChange={e => setPhone(e.target.value)} style={{ flex: 1.2, minWidth: 0 }} />
              <input type="text" placeholder="Имя" value={name} onChange={e => setName(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
              <button type="button" disabled={busy} style={btn('main')} onClick={allow}>Разрешить</button>
            </div>
            {rest.length > 0 && (
              <details style={{ marginTop: 10 }}>
                <summary style={{ fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}>Рассмотренные ({rest.length})</summary>
                {rest.map(r => (
                  <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderTop: '0.5px solid var(--border)', fontSize: 12 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div>{r.full_name || 'Без имени'} · {r.phone}</div>
                      <div style={{ color: r.status === 'rejected' ? 'var(--danger)' : 'var(--text-hint)' }}>{statusLabel(r)}</div>
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
                  <div key={u.production_id} style={{ padding: '8px 0', borderBottom: '0.5px solid var(--border)' }}>
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
          <p className="section-title">Зарегистрированы ({users.length})</p>
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {shown.map(u => {
              const tel = digits(u.phone) || digits(String(u.email || '').split('@')[0])
              const wa = digits(u.whatsapp) || tel
              return (
                <div key={u.id} className="card" style={{ padding: '10px 12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.full_name || 'Без имени'}{u.id === user?.id ? ' (вы)' : ''}</div>
                      <div style={{ fontSize: 12, color: landOf(u) === '—' ? 'var(--text-hint)' : 'var(--text-muted)' }}>{landOf(u) === '—' ? 'страна и город не указаны' : `${landOf(u)} · ${townOf(u) === '—' ? 'город не указан' : townOf(u)}`}</div>
                      <div style={{ fontSize: 13 }}>
                        {tel ? <a href={`tel:+${tel}`} style={{ color: 'var(--blue)' }}>{u.phone || `+${tel}`}</a> : <span style={{ color: 'var(--text-hint)' }}>{u.email}</span>}
                        {wa && <a href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer" style={{ color: 'var(--teal)', marginLeft: 10, fontSize: 12 }}>WhatsApp</a>}
                      </div>
                    </div>
                    <select value={u.role} disabled={busy || u.id === user?.id} onChange={e => act(() => adminSetRole(u.id, e.target.value))}
                      style={{ width: 'auto', padding: '4px 6px', fontSize: 12, borderRadius: 20 }}>
                      {ROLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </div>
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
                  {lim && !lim.error && <UserLimits key={JSON.stringify(lim.users.get(u.id) || {})} u={u} data={lim.users.get(u.id)} defaults={lim.defaults} isProd={isProd(u)} busy={busy}
                    onSave={(id, unl, l) => act(() => adminSetUserLimits(id, unl, l))} />}
                  <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 4 }}>
                    Регистрация {date(u.created_at)} · последний вход {date(u.last_sign_in_at)} · заказов создано {u.orders}{u.submitted != null ? `, оформлено ${u.submitted}` : ''}{u.last_order_at ? ` (последний ${date(u.last_order_at)})` : ''}
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}
      <BottomNav />
    </div>
  )
}
