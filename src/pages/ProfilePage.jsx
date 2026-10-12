import { fetchNotices } from '../lib/notices'
import LangPicker from '../components/LangPicker'
import { useState, useEffect } from 'react'
import { useAuth } from '../context/AuthContext'
import { useNavigate } from 'react-router-dom'
import BottomNav from '../components/BottomNav'
import { getUserSettings, saveUserSettings, fetchUserSettings } from '../lib/userSettings'
import { myWorkplaces, openWorkplace, openOwnProduction, prodView, workPid, permsText, clientAccess } from '../lib/workplaces'
import { myProduction } from '../lib/productionApi'

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
  const [cardOpen, setCardOpen] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  // мастер: сколько заявок на регистрацию, запросов пароля и производств ждут его решения
  // уведомления по источникам: красная пометка на кабинете, откуда пришло сообщение
  const [notes, setNotes] = useState(null)
  useEffect(() => {
    let alive = true
    const load = () => fetchNotices({ user, isMaster }).then(n => { if (alive) setNotes(n) })
    load()
    window.addEventListener('notices-seen', load)
    return () => { alive = false; window.removeEventListener('notices-seen', load) }
  }, [user, isMaster])
  const waiting = notes?.users || 0
  const countOf = id => {
    if (!notes) return 0
    if (id === 'client') return notes.orders
    if (id === 'own') return notes.ownNew + (notes.ownId ? notes.byProd[notes.ownId] || 0 : 0)
    if (id.startsWith('work:')) return id.slice(5) === notes.ownId ? 0 : notes.byProd[id.slice(5)] || 0
    return 0
  }
  const srcOf = it => (it.src?.startsWith('work:') && it.pid && it.pid === notes?.ownId ? 'own' : it.src)
  const openNotice = it => {
    const src = srcOf(it)
    if (src === 'users') { navigate('/users'); return }
    if (src === 'client') { setCabinet('client'); navigate(it.to); return }
    if (src?.startsWith('work:') && src.length > 5) openWorkplace(src.slice(5)); else openOwnProduction()
    setCabinet('production'); navigate('/production')
  }
  const badge = n => n > 0 ? <span style={{ minWidth: 20, height: 20, padding: '0 6px', borderRadius: 10, background: 'var(--danger)', color: 'white', fontSize: 11.5, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{n}</span> : null
  const [mills, setMills] = useState(() => getUserSettings(user).facadeMills || [])
  useEffect(() => { let alive = true; fetchUserSettings(user).then(s => { if (alive) setMills(s.facadeMills || []) }); return () => { alive = false } }, [user])
  const removeMill = key => { const next = mills.filter(m => m.key !== key); setMills(next); saveUserSettings({ facadeMills: next }, user) }

  async function handleSignOut() {
    setLoggingOut(true)
    await signOut()
    navigate('/auth')
  }

  const isOperator = profile?.role === 'operator' || profile?.role === 'admin'
  // Кабинеты. Сотрудник производства видит первым производство, которое его пригласило, затем «Клиент»,
  // последним — своё производство (или «Создать своё производство»). Остальные — «Клиент», затем «Производство».
  const [wps, setWps] = useState([])
  const [own, setOwn] = useState(null)
  const [access, setAccess] = useState(null)
  useEffect(() => {
    let alive = true
    myWorkplaces().then(r => { if (alive) setWps(r.data || []) })
    myProduction(user?.id).then(p => { if (alive) setOwn(p || null) })
    clientAccess().then(a => { if (alive) setAccess(a) })
    return () => { alive = false }
  }, [user?.id])
  const workView = wps.length > 0 && (own ? prodView() === 'work' : prodView() !== 'own')
  const curPid = wps.some(w => w.production_id === workPid()) ? workPid() : wps[0]?.production_id
  const pickCabinet = id => {
    if (id === 'client') { setCabinet('client'); navigate('/orders'); return }
    if (id.startsWith('work:')) openWorkplace(id.slice(5)); else openOwnProduction()
    setCabinet('production'); navigate('/production')
  }
  const clientNote = access?.staff && !access.ok
    ? (access.request === 'new' ? 'Заявка на кабинет клиента ждёт одобрения администратора' : 'Подавать свои заказы — после одобрения администратора: откройте и отправьте заявку')
    : 'Заказы: ввод и импорт деталей, контуры, кромка, раскрой до готовых карт'
  const ownCard = own
    ? ['own', own.name || 'Своё производство', (own.status ?? 'approved') === 'approved' ? 'Своё производство: заявки, статусы, ЧПУ, бирки, сотрудники' : 'Заявка на регистрацию производства ждёт подтверждения']
    : ['own', wps.length ? 'Создать своё производство' : 'Производство', wps.length ? 'Регистрация своего производства — после подтверждения администратором' : 'Заявки: принятые карты раскроя, статусы, ЧПУ и бирки']
  const CABINETS = wps.length
    ? [...wps.map(w => [`work:${w.production_id}`, `${w.production_name}${w.city ? `, ${w.city}` : ''}`, `Рабочее место: ${w.name || 'сотрудник'} · ${permsText(w.perms)}`]),
      ['client', 'Клиент', clientNote], ownCard]
    : [['client', 'Клиент', clientNote], ownCard]
  const isOn = id => (id === 'client' ? cabinet === 'client'
    : cabinet !== 'production' ? false
    : id.startsWith('work:') ? workView && id.slice(5) === curPid : !workView)
  const initials = profile?.full_name
    ? profile.full_name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
    : (user?.email?.[0] || '?').toUpperCase()

  return (
    <div className="page" style={{ paddingBottom: 100 }}>
      <h1 style={{ fontSize: 18, fontWeight: 500, marginBottom: 20, paddingTop: 8 }}>Профиль</h1>

      {/* карточка профиля свёрнута: значок, имя и кабинет; тап — телефон, почта, язык */}
      <div className="card" style={{ marginBottom: 12, padding: cardOpen ? undefined : '10px 14px' }}>
        <div onClick={() => setCardOpen(v => !v)} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: cardOpen ? 16 : 0, cursor: 'pointer' }}>
          <div style={{
            width: cardOpen ? 52 : 40, height: cardOpen ? 52 : 40, borderRadius: '50%',
            background: isOperator ? 'var(--amber-light)' : 'var(--blue-light)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: cardOpen ? 20 : 16, fontWeight: 600,
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
              {isMaster ? 'Мастер-аккаунт' : cabinet === 'production' ? (workView ? `Сотрудник · ${wps.find(w => w.production_id === curPid)?.production_name || ''}` : 'Кабинет производства') : 'Кабинет клиента'}
            </div>
          </div>
          <span style={{ marginLeft: 'auto', color: 'var(--text-hint)', fontSize: 13, transform: cardOpen ? 'rotate(180deg)' : 'none' }}>▾</span>
        </div>

        {cardOpen && <>
        <LangPicker style={{ marginBottom: 10 }} />
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
        </>}
      </div>

      {/* Кабинеты: клиент и производство — переключаются здесь */}
      <p className="section-title">Кабинет</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
        {CABINETS.map(([id, label, note]) => {
          const on = isOn(id)
          return (
            <button key={id} type="button" onClick={() => pickCabinet(id)} className="card"
              style={{ width: '100%', textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px',
                border: on ? '1.5px solid var(--blue)' : '0.5px solid var(--border)', background: on ? 'var(--blue-light)' : 'var(--bg)' }}>
              <span style={{ width: 18, height: 18, borderRadius: '50%', flexShrink: 0, border: on ? '5px solid var(--blue)' : '1.5px solid var(--border-md)', background: 'var(--bg)' }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500, fontSize: 15, color: on ? 'var(--blue-dark)' : 'var(--text)' }}>{label}{on ? ' · сейчас' : ''}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{note}</div>
              </div>
              {badge(countOf(id))}
              <span style={{ color: 'var(--blue)', fontSize: 18 }}>→</span>
            </button>
          )
        })}
      </div>

      {/* что именно пришло — тап открывает нужный кабинет и место */}
      {notes?.list?.length > 0 && (
        <div className="card" style={{ marginBottom: 14, padding: '8px 12px', border: '1px solid var(--danger)' }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--danger)', marginBottom: 4 }}>Новое: {notes.list.length}</div>
          {notes.list.slice(0, 8).map(it => {
            const src = srcOf(it)
            const from = src === 'users' ? 'Мастер' : src === 'client' ? 'Клиент' : src === 'own' ? (own?.name || 'Своё производство')
              : wps.find(w => `work:${w.production_id}` === src)?.production_name || 'Производство'
            return (
              <div key={it.key} onClick={() => openNotice(it)} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '7px 0', borderTop: '0.5px solid var(--border)', cursor: 'pointer' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--danger)', flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 11, color: 'var(--text-hint)' }}>{from}</div>
                  <div style={{ fontSize: 13 }}>{it.text}</div>
                </div>
                <span style={{ color: 'var(--blue)' }}>→</span>
              </div>
            )
          })}
          {notes.list.length > 8 && <div style={{ fontSize: 12, color: 'var(--text-hint)', paddingTop: 4 }}>и ещё {notes.list.length - 8}</div>}
        </div>
      )}

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
        <button onClick={() => navigate('/all-productions')} className="card"
          style={{ width: '100%', marginBottom: 12, textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 500, fontSize: 15, color: 'var(--text)' }}>Заказы всех производств</div>
            <div style={{ fontSize: 12, color: 'var(--text-hint)' }}>Заявки, что в работе и исполнено, листы и суммы по каждому производству за период</div>
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
