import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import BottomNav from '../components/BottomNav'
import { adminUsers, adminRequests, adminSetSignup, adminSetRequest, adminAllowPhone, adminSetRole, signupOpen } from '../lib/adminApi'

// Администратор: кто зарегистрирован, заявки на регистрацию и переключатель «регистрация открыта / по запросу».
const ROLES = [['client', 'Клиент'], ['operator', 'Производство'], ['admin', 'Администратор']]
const date = v => (v ? new Date(v).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '—')
const digits = v => String(v || '').replace(/\D/g, '')

export default function UsersPage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [users, setUsers] = useState(null)
  const [reqs, setReqs] = useState([])
  const [open, setOpen] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [phone, setPhone] = useState('')
  const [name, setName] = useState('')
  const [find, setFind] = useState('')
  const [kind, setKind] = useState('all')      // все / клиенты / производства
  const [ready, setReady] = useState(false)   // база ответила: функции на месте и вы администратор

  const load = async () => {
    const [u, r, o] = await Promise.all([adminUsers(), adminRequests(), signupOpen()])
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
  const prodCount = (users || []).filter(u => u.production_id).length
  const shown = (users || []).filter(u => kind === 'all' || (kind === 'prod' ? !!u.production_id : !u.production_id)).filter(u => !q || `${u.full_name || ''} ${u.phone || ''} ${u.email || ''}`.toLowerCase().includes(q) || (digits(q) && digits(u.phone || u.email).includes(digits(q))))
  const btn = (kind) => ({ padding: '6px 12px', borderRadius: 20, fontSize: 12, cursor: 'pointer', border: kind === 'main' ? 'none' : `0.5px solid ${kind === 'danger' ? 'var(--danger)' : 'var(--border-md)'}`, background: kind === 'main' ? 'var(--blue)' : 'transparent', color: kind === 'main' ? 'white' : kind === 'danger' ? 'var(--danger)' : 'var(--text-muted)', whiteSpace: 'nowrap' })
  const statusLabel = r => (r.registered ? 'зарегистрирован' : r.status === 'approved' ? 'одобрена — ждём регистрации' : 'отклонена')

  return (
    <div className="page" style={{ paddingBottom: 100 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, paddingTop: 8 }}>
        <button type="button" onClick={() => navigate('/profile')} style={{ background: 'none', border: 'none', color: 'var(--blue)', fontSize: 22, padding: 0, lineHeight: 1 }}>←</button>
        <h1 style={{ fontSize: 18, fontWeight: 500 }}>Пользователи</h1>
      </div>
      {error && <p className="error-text" style={{ marginBottom: 12 }}>{error}</p>}
      {users === null ? <p style={{ color: 'var(--text-hint)' }}>Загрузка…</p> : !ready ? (
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

          <p className="section-title">Заявки на регистрацию{fresh.length ? ` · новых ${fresh.length}` : ''}</p>
          <div className="card" style={{ marginBottom: 12 }}>
            {!fresh.length && <p style={{ fontSize: 12, color: 'var(--text-hint)', marginBottom: 8 }}>Новых заявок нет.</p>}
            {fresh.map(r => (
              <div key={r.id} style={{ padding: '8px 0', borderBottom: '0.5px solid var(--border)' }}>
                <div style={{ fontSize: 14, fontWeight: 500 }}>{r.full_name || 'Без имени'}</div>
                <div style={{ fontSize: 13 }}><a href={`tel:+${r.digits}`} style={{ color: 'var(--blue)' }}>{r.phone}</a> <span style={{ color: 'var(--text-hint)', fontSize: 11 }}>· {date(r.created_at)}</span></div>
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

          <p className="section-title">Зарегистрированы ({users.length})</p>
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            {[['all', `Все · ${users.length}`], ['client', `Клиенты · ${users.length - prodCount}`], ['prod', `Производства · ${prodCount}`]].map(([id, label]) => (
              <button key={id} type="button" onClick={() => setKind(id)} style={{ flex: 1, padding: '7px 4px', borderRadius: 20, border: 'none', fontSize: 12, background: kind === id ? 'var(--blue)' : 'var(--bg2)', color: kind === id ? 'white' : 'var(--text-muted)' }}>{label}</button>
            ))}
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
                  {u.production_id && (
                    <div style={{ fontSize: 12, marginTop: 6, padding: '6px 8px', background: 'var(--amber-light)', borderRadius: 'var(--radius)', color: 'var(--amber)' }}>
                      Производство «{u.production_name}»{u.production_city ? `, ${u.production_city}` : ''}: заявок получено <b>{u.received}</b> · принято <b>{u.accepted}</b> · исполнено <b>{u.done}</b>
                    </div>
                  )}
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
