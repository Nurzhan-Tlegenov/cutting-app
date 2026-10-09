import { fetchNotices } from '../lib/notices'
import { useState, useEffect } from 'react'
import { useAuth } from '../context/AuthContext'
import { useNavigate } from 'react-router-dom'
import BottomNav from '../components/BottomNav'
import { getUserSettings, saveUserSettings, fetchUserSettings } from '../lib/userSettings'

const KIND = { mill: 'Фреза по траектории', round: 'Скругление кромки', pocket: 'Выемка' }

// Рисунок профиля фрезы: поверхность пласти сверху, материал снизу
function MillIcon({ profile, depth }) {
  if (!profile || profile.length < 3) return <div style={{ width: 64, height: 40, borderRadius: 6, background: 'var(--bg2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: 'var(--text-hint)' }}>{depth ? `↧ ${depth}` : ''}</div>
  const us = profile.map(p => p[0]), ds = profile.map(p => p[1])
  const u0 = Math.min(...us), u1 = Math.max(...us), d1 = Math.max(...ds, 1)
  const pad = Math.max(2, (u1 - u0) * 0.25), w = u1 - u0 + pad * 2, h = d1 * 1.6
  const pts = profile.map(p => `${(p[0] - u0 + pad).toFixed(2)},${p[1].toFixed(2)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width={64} height={40} preserveAspectRatio="xMidYMin meet" style={{ borderRadius: 6, background: 'var(--bg2)', flexShrink: 0 }}>
      <rect x={0} y={0} width={w} height={h} fill="#cbb89a" />
      <polygon points={pts} fill="#ffffff" stroke="#185FA5" strokeWidth={Math.max(w, h) / 60} />
    </svg>
  )
}

export default function ProfilePage() {
  const { profile, user, signOut, cabinet, setCabinet, isMaster, setContactEmail } = useAuth()
  // почта для восстановления пароля — необязательная, меняется здесь
  const contactEmail = user?.user_metadata?.contact_email || ''
  const [mail, setMail] = useState(null)             // null — не редактируем; строка — идёт ввод
  const [mailErr, setMailErr] = useState('')
  const saveMail = async () => {
    const v = (mail || '').trim()
    if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { setMailErr('Проверьте адрес почты'); return }
    const err = await setContactEmail(v)
    if (err) setMailErr(err); else { setMailErr(''); setMail(null) }
  }
  const navigate = useNavigate()
  const [loggingOut, setLoggingOut] = useState(false)
  // мастер: сколько заявок на регистрацию, запросов пароля и производств ждут его решения
  const [waiting, setWaiting] = useState(0)
  useEffect(() => { let alive = true; if (isMaster) fetchNotices({ user, isMaster }).then(n => { if (alive) setWaiting(n.users) }); return () => { alive = false } }, [user, isMaster])
  const [mills, setMills] = useState(() => getUserSettings(user).facadeMills || [])
  useEffect(() => { let alive = true; fetchUserSettings(user).then(s => { if (alive) setMills(s.facadeMills || []) }); return () => { alive = false } }, [user])
  const removeMill = key => { const next = mills.filter(m => m.key !== key); setMills(next); saveUserSettings({ facadeMills: next }, user) }

  async function handleSignOut() {
    setLoggingOut(true)
    await signOut()
    navigate('/auth')
  }

  const isOperator = profile?.role === 'operator' || profile?.role === 'admin'
  const pickCabinet = mode => { setCabinet(mode); navigate(mode === 'production' ? '/production' : '/orders') }
  const CABINETS = [
    ['client', 'Клиент', 'Заказы: ввод и импорт деталей, контуры, кромка, раскрой до готовых карт'],
    ['production', 'Производство', 'Заявки: принятые карты раскроя, статусы, ЧПУ и бирки'],
  ]
  const initials = profile?.full_name
    ? profile.full_name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
    : (user?.email?.[0] || '?').toUpperCase()

  return (
    <div className="page" style={{ paddingBottom: 100 }}>
      <h1 style={{ fontSize: 18, fontWeight: 500, marginBottom: 20, paddingTop: 8 }}>Профиль</h1>

      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16 }}>
          <div style={{
            width: 52, height: 52, borderRadius: '50%',
            background: isOperator ? 'var(--amber-light)' : 'var(--blue-light)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 20, fontWeight: 600,
            color: isOperator ? 'var(--amber)' : 'var(--blue)',
            flexShrink: 0
          }}>
            {initials}
          </div>
          <div>
            <div style={{ fontWeight: 500, fontSize: 16 }}>
              {profile?.full_name || 'Пользователь'}
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-hint)' }}>
              {isMaster ? 'Мастер-аккаунт' : cabinet === 'production' ? 'Кабинет производства' : 'Кабинет клиента'}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {[
            ['Телефон', profile?.phone],
            ['WhatsApp', profile?.whatsapp],
          ].filter(([, val]) => val).map(([label, val]) => (
            <div key={label} style={{
              display: 'flex', justifyContent: 'space-between',
              padding: '10px 0', borderBottom: '0.5px solid var(--border)'
            }}>
              <span style={{ color: 'var(--text-hint)', fontSize: 13 }}>{label}</span>
              <span style={{ fontSize: 13 }}>{val}</span>
            </div>
          ))}
          <div style={{ padding: '10px 0' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <span style={{ color: 'var(--text-hint)', fontSize: 13, flex: '0 0 auto' }}>Почта</span>
              {mail === null ? (
                <span style={{ fontSize: 13, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {contactEmail || <span style={{ color: 'var(--text-hint)' }}>не указана</span>}
                  <span onClick={() => { setMail(contactEmail); setMailErr('') }} style={{ color: 'var(--blue)', marginLeft: 8, cursor: 'pointer' }}>{contactEmail ? 'Изменить' : 'Указать'}</span>
                </span>
              ) : (
                <span style={{ display: 'flex', gap: 6, flex: 1, minWidth: 0, justifyContent: 'flex-end' }}>
                  <input type="email" inputMode="email" autoComplete="email" placeholder="name@mail.com" value={mail} onChange={e => setMail(e.target.value)} style={{ padding: '5px 8px', fontSize: 13, minWidth: 0 }} />
                  <button type="button" onClick={saveMail} style={{ flex: '0 0 auto', padding: '5px 10px', borderRadius: 20, border: 'none', background: 'var(--blue)', color: 'white', fontSize: 12 }}>Сохранить</button>
                </span>
              )}
            </div>
            {mailErr ? <p className="error-text" style={{ marginTop: 4 }}>{mailErr}</p>
              : <p style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 3 }}>Необязательно. Нужна для восстановления пароля; вход — по номеру телефона.</p>}
          </div>
        </div>
      </div>

      {/* Кабинеты: клиент и производство — переключаются здесь */}
      <p className="section-title">Кабинет</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
        {CABINETS.map(([id, label, note]) => {
          const on = cabinet === id
          return (
            <button key={id} type="button" onClick={() => pickCabinet(id)} className="card"
              style={{ width: '100%', textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px',
                border: on ? '1.5px solid var(--blue)' : '0.5px solid var(--border)', background: on ? 'var(--blue-light)' : 'var(--bg)' }}>
              <span style={{ width: 18, height: 18, borderRadius: '50%', flexShrink: 0, border: on ? '5px solid var(--blue)' : '1.5px solid var(--border-md)', background: 'var(--bg)' }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500, fontSize: 15, color: on ? 'var(--blue-dark)' : 'var(--text)' }}>{label}{on ? ' · сейчас' : ''}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{note}</div>
              </div>
              <span style={{ color: 'var(--blue)', fontSize: 18 }}>→</span>
            </button>
          )
        })}
      </div>

      <button onClick={() => navigate('/scan')} className="card"
        style={{ width: '100%', marginBottom: 12, textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 22 }}>📷</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 500, fontSize: 15, color: 'var(--text)' }}>Сканер QR-кода бирки</div>
          <div style={{ fontSize: 12, color: 'var(--text-hint)' }}>Навели камеру на бирку — открылась эта деталь в 3D-модели заказа</div>
        </div>
        <span style={{ color: 'var(--blue)', fontSize: 18 }}>→</span>
      </button>

      {isMaster && <p className="section-title">Мастер-аккаунт</p>}
      {isMaster && (
        <button onClick={() => navigate('/users')} className="card"
          style={{ width: '100%', marginBottom: 12, textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 500, fontSize: 15, color: 'var(--text)' }}>Пользователи и регистрация
              {waiting > 0 && <span style={{ marginLeft: 8, padding: '1px 7px', borderRadius: 9, background: 'var(--danger)', color: 'white', fontSize: 11, fontWeight: 600 }}>ждут ответа: {waiting}</span>}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-hint)' }}>Кто зарегистрирован и как работает, заявки, закрыть или открыть регистрацию</div>
          </div>
          <span style={{ color: 'var(--blue)', fontSize: 18 }}>→</span>
        </button>
      )}

      {isMaster && (
        <button onClick={() => navigate('/all-orders')} className="card"
          style={{ width: '100%', marginBottom: 12, textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 500, fontSize: 15, color: 'var(--text)' }}>Заказы всех клиентов</div>
            <div style={{ fontSize: 12, color: 'var(--text-hint)' }}>Открыть заказ любого аккаунта, чтобы разобраться с ошибкой по обращению</div>
          </div>
          <span style={{ color: 'var(--blue)', fontSize: 18 }}>→</span>
        </button>
      )}

      {isMaster && (
        <button onClick={() => navigate('/messages')} className="card"
          style={{ width: '100%', marginBottom: 12, textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 500, fontSize: 15, color: 'var(--text)' }}>Обращения и файлы для отладки</div>
            <div style={{ fontSize: 12, color: 'var(--text-hint)' }}>Что пишут пользователи, присланные ими файлы, новости для всех</div>
          </div>
          <span style={{ color: 'var(--blue)', fontSize: 18 }}>→</span>
        </button>
      )}

      {cabinet === 'client' && <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ fontWeight: 500, fontSize: 15, marginBottom: 4 }}>Фасадные фрезы</div>
        <p style={{ fontSize: 12, color: 'var(--text-hint)', marginBottom: mills.length ? 8 : 0 }}>
          Типы фрезеровки фасадов. Добавляются сами при импорте модели из Базиса; по ним фасады показываются объёмно в 3D.
          {!mills.length && ' Пока пусто — импортируйте модель с фрезерованными фасадами.'}
        </p>
        {mills.map(m => (
          <div key={m.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: '0.5px solid var(--border)' }}>
            <MillIcon profile={m.profile} depth={m.depth} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name || 'Без названия'}{m.sign ? ` · ${m.sign}` : ''}</div>
              <div style={{ fontSize: 11, color: 'var(--text-hint)' }}>
                {KIND[m.kind] || m.kind}{m.depth ? ` · глубина ${m.depth} мм` : ''}{m.width ? ` · ширина ${m.width} мм` : ''}
              </div>
            </div>
            <button onClick={() => removeMill(m.key)} title="Убрать из каталога"
              style={{ background: 'none', border: 'none', color: 'var(--text-hint)', fontSize: 16, cursor: 'pointer' }}>✕</button>
          </div>
        ))}
      </div>}

      <button
        onClick={handleSignOut}
        disabled={loggingOut}
        style={{
          width: '100%', padding: 12,
          background: 'var(--bg)', border: '0.5px solid var(--danger)',
          borderRadius: 'var(--radius)', fontSize: 15,
          color: 'var(--danger)', cursor: 'pointer'
        }}>
        {loggingOut ? 'Выход...' : 'Выйти из аккаунта'}
      </button>

      <BottomNav />
    </div>
  )
}
