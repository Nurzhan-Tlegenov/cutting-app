import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { MenuButton } from '../components/NavDrawer'
import BottomNav from '../components/BottomNav'
import CncLoader from '../components/CncLoader'
import { partnerMe, partnerRegisterCompany } from '../lib/support'
import { siteOrigin } from '../lib/siteOrigin'
import { guessCountryName } from '../lib/phoneCountries'
import { myRefPeople } from '../lib/refLinks'

// «Официальный представитель RaskroyPro» (migration_partners.sql): статус выдаёт мастер-аккаунт технологу-внедренцу.
// Кого партнёр пригласил своими ссылками («Пригласить производство», «Пригласить знакомого») — закрепляется за ним;
// обращения этих пользователей приходят партнёру (раздел «Поддержка» → только свои клиенты), он отвечает им сам
// и при необходимости передаёт задачу разработчику («Нужен разработчик»).
export default function PartnerPage() {
  const { user, profile, signOut } = useAuth()
  const navigate = useNavigate()
  const [me, setMe] = useState(undefined)
  const [err, setErr] = useState('')
  const [wait, setWait] = useState([])   // зарегистрировались по ссылке и ждут код от вас (WhatsApp / MAX)
  useEffect(() => {
    let alive = true
    partnerMe().then(r => { if (!alive) return; if (r.error) setErr(r.error); setMe(r.data || null) })
    myRefPeople().then(r => { if (alive && r.data) setWait((r.data.pending || []).filter(p => p.messenger !== 'telegram' && !p.code_sent_at)) })
    return () => { alive = false }
  }, [user?.id])
  const head = <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 10, paddingTop: 4 }}><MenuButton /><h1 style={{ fontSize: 18, fontWeight: 500, flex: 1 }}>Официальный представитель RaskroyPro</h1></div>
  if (me === undefined) return <div className="page"><CncLoader label="Открываем…" /></div>
  if (!me) return (
    <div className="page" style={{ paddingBottom: 100 }}>{head}
      <div className="card"><p style={{ fontSize: 13, color: 'var(--text-muted)' }}>{err || 'Статус «Официальный представитель RaskroyPro» выдаёт разработчик — технологам, которые внедряют приложение на производствах. Напишите в поддержку, если хотите стать партнёром.'}</p></div>
      <BottomNav />
    </div>
  )
  const clients = me.clients || []
  return (
    <div className="page" style={{ paddingBottom: 100 }}>{head}
      <div className="card" style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>🤝 Официальный представитель RaskroyPro</div>
        <div style={{ fontSize: 14, marginTop: 2 }}>{String(profile?.full_name || '').trim() || 'Имя не указано — заполните в «Профиле»'}{me.title ? ` · ${me.title}` : ''}</div>
        <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '6px 0 10px', lineHeight: 1.45 }}>
          Производства и пользователи, которых вы пригласили своей ссылкой, закрепляются за вами. Их обращения приходят вам — в «Обращения клиентов»:
          вы отвечаете им сами, а если нужна доработка приложения — «Нужен разработчик», задача уходит разработчику.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn-primary" style={{ flex: '1 1 160px' }} onClick={() => navigate('/invite?k=production')}>Пригласить производство</button>
          <button type="button" className="btn-secondary" style={{ flex: '1 1 160px' }} onClick={() => navigate('/support')}>Обращения клиентов</button>
        </div>
      </div>
      <RegisterCompany signOut={signOut} />
      {wait.length > 0 && (
        <div className="card" style={{ marginBottom: 10, border: '1px solid var(--amber)' }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Ждут код от вас · {wait.length}</div>
          <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '4px 0 8px' }}>
            {wait.map(p => p.full_name || '+' + p.digits).join(', ')} — регистрируются по вашей ссылке через {wait.some(p => p.contact_app === 'max') ? 'MAX' : 'WhatsApp'}. Код готов — отправьте его одним нажатием.
          </p>
          <button type="button" className="btn-primary" onClick={() => navigate('/invite')}>Отправить код</button>
        </div>
      )}
      <div className="card">
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Мои клиенты · {clients.length}</div>
        {!clients.length ? <p style={{ fontSize: 12.5, color: 'var(--text-hint)' }}>Пока никого. Отправьте производству ссылку «Пригласить производство» — после регистрации оно появится здесь.</p> : clients.map(c => (
          <div key={c.user_id} style={{ padding: '7px 0', borderTop: '0.5px solid var(--border)' }}>
            <div style={{ fontSize: 13.5, fontWeight: 500 }}>{c.production || c.name || 'Без имени'}</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-hint)' }}>
              {[c.production ? c.name : '', [c.city, c.country].filter(Boolean).join(', '), c.production && c.production_status && c.production_status !== 'approved' ? 'производство ждёт подтверждения' : '',
                `заказов: ${c.orders || 0}`, `с ${new Date(c.at).toLocaleDateString('ru-RU')}`].filter(Boolean).join(' · ')}
            </div>
          </div>
        ))}
      </div>
      <BottomNav />
    </div>
  )
}

// «Зарегистрировать компанию»: представитель вводит название и телефон производства → сразу код.
// Дальше он сам входит по ссылке с этим кодом под номером компании и придумывает пароль —
// аккаунт создан, производство подтверждается сразу и закрепляется за представителем.
function RegisterCompany({ signOut }) {
  const [open, setOpen] = useState(false)
  const [f, setF] = useState({ name: '', phone: '+', country: guessCountryName() || '', city: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [res, setRes] = useState(null)   // { code, digits, ref, name }
  const [copied, setCopied] = useState(false)
  const set = (k, v) => setF(p => ({ ...p, [k]: v }))
  const link = res ? `${siteOrigin()}/auth?code=${res.code}&tel=${res.digits}&r=${res.ref}` : ''
  async function make() {
    setErr('')
    if (f.name.trim().length < 2) { setErr('Введите название компании'); return }
    if (f.phone.replace(/\D/g, '').length < 10) { setErr('Введите телефон компании полностью, с кодом страны'); return }
    if (f.country.trim().length < 2 || f.city.trim().length < 2) { setErr('Укажите страну и город'); return }
    setBusy(true)
    const r = await partnerRegisterCompany(f.name.trim(), f.phone, f.country.trim(), f.city.trim())
    setBusy(false)
    const d = r.data || {}
    if (r.error) { setErr(r.error); return }
    if (d.error === 'registered') { setErr('Этот номер уже зарегистрирован в RaskroyPro — пусть компания просто войдёт под ним'); return }
    if (d.error === 'phone') { setErr('Неверный номер телефона'); return }
    if (d.error === 'name') { setErr('Введите название компании'); return }
    if (!d.code) { setErr('Не получилось сформировать код — попробуйте ещё раз'); return }
    setRes(d)
  }
  async function copy() {
    try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 2000) } catch { window.prompt('Скопируйте ссылку', link) }
  }
  async function goNow() {
    try { localStorage.setItem('regCompany', res.name || f.name.trim()) } catch { /* без памяти */ }
    await signOut()
    window.location.assign(link)
  }
  if (!open) return (
    <div className="card" style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 14, fontWeight: 600 }}>Зарегистрировать компанию самому</div>
      <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '4px 0 8px' }}>Производство не хочет разбираться с регистрацией? Введите его название и телефон — код сформируется сразу, и вы сами создадите ему аккаунт.</p>
      <button type="button" className="btn-primary" onClick={() => setOpen(true)}>Зарегистрировать компанию</button>
    </div>
  )
  return (
    <div className="card" style={{ marginBottom: 10, border: '1px solid var(--blue)' }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Регистрация компании</div>
      {!res ? <>
        <label className="label">Название производства (компании) *</label>
        <input type="text" placeholder="Например: Мебель-Профи" value={f.name} onChange={e => set('name', e.target.value)} />
        <label className="label" style={{ marginTop: 8 }}>Телефон компании * (под ним компания будет входить)</label>
        <input type="tel" inputMode="tel" placeholder="+7 700 000 00 00" value={f.phone} onChange={e => set('phone', e.target.value)} />
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <div style={{ flex: 1 }}><label className="label">Страна *</label><input type="text" value={f.country} onChange={e => set('country', e.target.value)} /></div>
          <div style={{ flex: 1 }}><label className="label">Город *</label><input type="text" value={f.city} onChange={e => set('city', e.target.value)} /></div>
        </div>
        {err && <p className="error-text" style={{ marginTop: 8 }}>{err}</p>}
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button type="button" className="btn-primary" style={{ flex: 1 }} disabled={busy} onClick={make}>{busy ? 'Формируем…' : 'Сформировать код'}</button>
          <button type="button" className="btn-secondary" onClick={() => { setOpen(false); setErr('') }}>Отмена</button>
        </div>
      </> : <>
        <div style={{ fontSize: 13 }}>{res.name} · +{res.digits}</div>
        <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: 4, color: 'var(--blue)', margin: '6px 0' }}>{res.code}</div>
        <p style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.45, margin: '0 0 8px' }}>
          Код действует 3 дня. По ссылке номер и код уже введены — останется <b>придумать пароль</b> компании, затем заполнить данные производства (название подставится само).
          Производство подтвердится сразу и закрепится за вами. Потом выйдите и войдите обратно в свой аккаунт.
          Удобнее — открыть ссылку в другом браузере или в режиме инкогнито, тогда из своего аккаунта выходить не нужно.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn-primary" style={{ flex: '1 1 160px' }} onClick={goNow}>Выйти и зарегистрировать сейчас</button>
          <button type="button" className="btn-secondary" style={{ flex: '1 1 160px' }} onClick={copy}>{copied ? 'Скопировано ✓' : 'Скопировать ссылку'}</button>
        </div>
        <button type="button" className="btn-secondary" style={{ width: '100%', marginTop: 8 }} onClick={() => { setRes(null); setF(p => ({ ...p, name: '', phone: '+' })) }}>Ещё одну компанию</button>
      </>}
    </div>
  )
}
