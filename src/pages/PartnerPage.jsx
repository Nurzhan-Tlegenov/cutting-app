import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { MenuButton } from '../components/NavDrawer'
import BottomNav from '../components/BottomNav'
import CncLoader from '../components/CncLoader'
import { partnerMe } from '../lib/support'
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
