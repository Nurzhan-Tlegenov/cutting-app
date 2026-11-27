import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { MenuButton } from '../components/NavDrawer'
import BottomNav from '../components/BottomNav'
import CncLoader from '../components/CncLoader'
import { partnerMe, partnerRegisterCompany } from '../lib/support'
import { siteOrigin } from '../lib/siteOrigin'
import { guessCountryName } from '../lib/phoneCountries'
import { accountsState, initOwner, switchTo, addAccountByPassword, createCompanyAccount, removeAccount } from '../lib/accounts'
import { myRefPeople } from '../lib/refLinks'

// «Официальный представитель RaskroyPro» (migration_partners.sql): статус выдаёт мастер-аккаунт технологу-внедренцу.
// Кого партнёр пригласил своими ссылками («Пригласить производство», «Пригласить знакомого») — закрепляется за ним;
// обращения этих пользователей приходят партнёру (раздел «Поддержка» → только свои клиенты), он отвечает им сам
// и при необходимости передаёт задачу разработчику («Нужен разработчик»).
export default function PartnerPage() {
  const { user, profile } = useAuth()
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
  const [, tick] = useState(0)
  useEffect(() => { const f = () => tick(x => x + 1); window.addEventListener('accounts', f); return () => window.removeEventListener('accounts', f) }, [])
  useEffect(() => { if (me && user) initOwner(user, String(profile?.full_name || '').trim() || 'Мой аккаунт', (me.clients || []).map(c => c.user_id)) }, [me, user?.id])   // eslint-disable-line react-hooks/exhaustive-deps
  const reload = () => partnerMe().then(r => { if (r.data) setMe(r.data) })
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
      <RegisterCompany onCreated={reload} />
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
        {!clients.length ? <p style={{ fontSize: 12.5, color: 'var(--text-hint)' }}>Пока никого. Зарегистрируйте компанию выше или отправьте производству ссылку «Пригласить производство» — после регистрации оно появится здесь.</p> : <>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 4px' }}>«Войти» — открыть аккаунт клиента на этом устройстве: настройки, постпроцессоры, заказы. Вернуться к себе — кнопкой в синей полосе сверху.</p>
          {clients.map(c => <ClientRow key={c.user_id} c={c} clientIds={clients.map(x => x.user_id)} />)}
        </>}
      </div>
      <BottomNav />
    </div>
  )
}

function ClientRow({ c, clientIds }) {
  const acc = (accountsState()?.list || []).find(a => a.id === c.user_id && a.rt)
  const [add, setAdd] = useState(false)
  const [f, setF] = useState({ login: c.phone || '', password: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const label = c.production || c.name || 'Без имени'
  async function go() { setErr(''); setBusy(true); const r = await switchTo(c.user_id, '/'); setBusy(false); if (r.error) { setErr(r.error); setAdd(true) } }
  async function save() {
    setErr(''); setBusy(true)
    const r = await addAccountByPassword(f.login, f.password, label, clientIds)
    setBusy(false)
    if (r.error) { setErr(r.error); return }
    setAdd(false); setF(p => ({ ...p, password: '' }))
  }
  return (
    <div style={{ padding: '7px 0', borderTop: '0.5px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 500 }}>{label}</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-hint)' }}>
            {[c.production ? c.name : '', [c.city, c.country].filter(Boolean).join(', '), c.production && c.production_status && c.production_status !== 'approved' ? 'производство ждёт подтверждения' : '',
              `заказов: ${c.orders || 0}`, `с ${new Date(c.at).toLocaleDateString('ru-RU')}`].filter(Boolean).join(' · ')}
          </div>
        </div>
        {acc ? <button type="button" className="btn-primary" style={{ padding: '5px 12px' }} disabled={busy} onClick={go}>{busy ? '…' : 'Войти'}</button>
          : <button type="button" className="btn-secondary" style={{ padding: '5px 10px' }} onClick={() => setAdd(o => !o)}>Добавить вход</button>}
      </div>
      {add && (
        <div style={{ marginTop: 6, padding: 8, background: 'var(--bg2)', borderRadius: 'var(--radius)' }}>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 6px' }}>Номер и пароль аккаунта компании — вводятся один раз, дальше «Войти» без пароля.</p>
          <input type="text" inputMode="tel" placeholder="Телефон (или почта)" value={f.login} onChange={e => setF(p => ({ ...p, login: e.target.value }))} />
          <input type="password" placeholder="Пароль компании" style={{ marginTop: 6 }} value={f.password} onChange={e => setF(p => ({ ...p, password: e.target.value }))} />
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <button type="button" className="btn-primary" style={{ flex: 1 }} disabled={busy || !f.password} onClick={save}>{busy ? 'Проверяем…' : 'Сохранить вход'}</button>
            {acc && <button type="button" className="btn-secondary" onClick={() => { removeAccount(c.user_id); setAdd(false) }}>Забыть вход</button>}
          </div>
        </div>
      )}
      {err && <p className="error-text" style={{ marginTop: 4 }}>{err}</p>}
    </div>
  )
}

// «Зарегистрировать компанию»: представитель вводит название и телефон производства → код → придумывает пароль —
// аккаунт компании создаётся прямо здесь (accounts.js, без выхода из своего аккаунта), производство подтверждено
// и закреплено за представителем; дальше «Войти» — и он уже в аккаунте компании.
function RegisterCompany({ onCreated }) {
  const [open, setOpen] = useState(false)
  const [f, setF] = useState({ name: '', phone: '+', country: guessCountryName() || '', city: '' })
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [res, setRes] = useState(null)   // { code, digits, ref, name }
  const [done, setDone] = useState(null)  // { id, productionError }
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
    if (d.error === 'registered') { setErr('Этот номер уже зарегистрирован в RaskroyPro. Если компания закреплена за вами — «Добавить вход» в списке клиентов ниже'); return }
    if (d.error === 'phone') { setErr('Неверный номер телефона'); return }
    if (d.error === 'name') { setErr('Введите название компании'); return }
    if (!d.code) { setErr('Не получилось сформировать код — попробуйте ещё раз'); return }
    setRes(d)
  }
  async function create() {
    setErr('')
    if (pw.length < 6) { setErr('Пароль минимум 6 символов'); return }
    setBusy(true)
    const r = await createCompanyAccount({ name: res.name || f.name.trim(), digits: res.digits, code: res.code, ref: res.ref, password: pw, country: f.country.trim(), city: f.city.trim() })
    setBusy(false)
    if (r.error) { setErr(r.error); return }
    setDone(r); onCreated?.()
  }
  async function copy() {
    try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 2000) } catch { window.prompt('Скопируйте ссылку', link) }
  }
  const reset = () => { setRes(null); setDone(null); setPw(''); setErr(''); setF(p => ({ ...p, name: '', phone: '+' })) }
  if (!open) return (
    <div className="card" style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 14, fontWeight: 600 }}>Зарегистрировать компанию самому</div>
      <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '4px 0 8px' }}>Название и телефон производства → код → пароль. Аккаунт компании создаётся прямо здесь, без выхода из вашего аккаунта, и сразу закрепляется за вами.</p>
      <button type="button" className="btn-primary" onClick={() => setOpen(true)}>Зарегистрировать компанию</button>
    </div>
  )
  return (
    <div className="card" style={{ marginBottom: 10, border: '1px solid var(--blue)' }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Регистрация компании</div>
      {done ? <>
        <p style={{ fontSize: 13, margin: '0 0 8px' }}>✅ Аккаунт «{res.name}» (+{res.digits}) создан{done.productionError ? '' : ', производство подтверждено'}. Передайте компании номер и пароль.</p>
        {done.productionError && <p className="error-text" style={{ marginBottom: 8 }}>Производство не создалось: {done.productionError}. Войдите в аккаунт и зарегистрируйте его в «Производство».</p>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn-primary" style={{ flex: '1 1 160px' }} onClick={() => switchTo(done.id, '/production')}>Войти и настроить</button>
          <button type="button" className="btn-secondary" style={{ flex: '1 1 160px' }} onClick={reset}>Ещё одну компанию</button>
        </div>
      </> : !res ? <>
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
        <div style={{ fontSize: 13, color: 'var(--text-muted)', margin: '4px 0' }}>Код: <b style={{ fontSize: 18, letterSpacing: 3, color: 'var(--blue)' }}>{res.code}</b> (действует 3 дня)</div>
        <label className="label" style={{ marginTop: 6 }}>Придумайте пароль для компании *</label>
        <input type="text" autoComplete="new-password" placeholder="минимум 6 символов" value={pw} onChange={e => setPw(e.target.value)} />
        {err && <p className="error-text" style={{ marginTop: 8 }}>{err}</p>}
        <button type="button" className="btn-primary" style={{ width: '100%', marginTop: 10 }} disabled={busy} onClick={create}>{busy ? 'Создаём аккаунт…' : 'Создать аккаунт компании'}</button>
        <p style={{ fontSize: 12, color: 'var(--text-hint)', margin: '8px 0 6px' }}>Или пусть компания зарегистрируется сама — отправьте ей ссылку: номер и код в ней уже введены, останется придумать пароль.</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn-secondary" style={{ flex: 1 }} onClick={copy}>{copied ? 'Скопировано ✓' : 'Скопировать ссылку'}</button>
          <button type="button" className="btn-secondary" onClick={reset}>Отмена</button>
        </div>
      </>}
    </div>
  )
}
