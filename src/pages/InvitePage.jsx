import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { MenuButton } from '../components/NavDrawer'
import BottomNav from '../components/BottomNav'
import RefShare from '../components/RefShare'
import { myProduction } from '../lib/productionApi'
import { myRefPeople, refSendCode } from '../lib/refLinks'

// «Пригласить»: личные ссылки — клиентам (от своего производства) и производству (от любого пользователя).
// По ссылке регистрируются без одобрения мастер-аккаунта, только с подтверждением номера: Telegram — код приходит сам,
// WhatsApp — код отправляете вы, отсюда, одним нажатием.
export default function InvitePage() {
  const { user, profile } = useAuth()
  const loc = useLocation()
  const first = new URLSearchParams(loc.search).get('k') === 'production' ? 'production' : 'client'
  const [prod, setProd] = useState(undefined)
  const [people, setPeople] = useState(null)
  const [err, setErr] = useState('')
  const [sent, setSent] = useState({})
  useEffect(() => {
    let alive = true
    myProduction(user?.id).then(p => { if (alive) setProd(p || null) })
    myRefPeople().then(r => { if (!alive) return; if (r.data) setPeople(r.data); else if (!r.missing) setErr(r.error || '') })
    return () => { alive = false }
  }, [user?.id])
  const ownOk = prod && (prod.status ?? 'approved') === 'approved'
  const name = String(profile?.full_name || '').trim()

  // код в WhatsApp: номер, сам код и ссылка, по которой номер и код подставятся сами
  const sendCode = async p => {
    const r = await refSendCode(p.id)
    if (r.error || r.data?.error) { setErr(r.data?.error === 'registered' ? 'Этот человек уже зарегистрировался.' : r.error || 'Не удалось получить код'); return }
    const { code, digits, ref } = r.data
    const link = `${window.location.origin}/auth?code=${code}&tel=${digits}${ref ? `&r=${ref}` : ''}`
    const text = `Код для регистрации в RaskroyPro: ${code}\n\nОткройте ссылку — номер и код уже подставлены, останется придумать пароль:\n${link}\n\nКод действует 3 дня.`
    window.open(`https://wa.me/${digits}?text=${encodeURIComponent(text)}`, '_blank')
    setSent(s => ({ ...s, [p.id]: true }))
  }

  const block = kind => kind === 'client'
    ? (
      <div key="client" className="card" style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 2 }}>Пригласить клиентов</div>
        {ownOk ? <>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
            Отправьте клиенту ссылку. Он зарегистрируется <b>без ожидания одобрения</b> — только подтвердит номер телефона,
            а в раскрое у него сразу будет выбрано ваше производство «{prod.name}» с вашим резом и отступами.
          </p>
          <RefShare kind="client" production={prod.name} />
        </> : <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {prod ? 'Ссылка для клиентов появится, когда ваше производство подтвердят.' : prod === null ? 'Ссылка для клиентов есть у производства. Сначала зарегистрируйте своё производство («Производство» в меню).' : 'Проверяем…'}
        </p>}
      </div>
    ) : (
      <div key="production" className="card" style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 2 }}>Пригласить производство</div>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
          Отправьте ссылку цеху, где вы режете. По ней он зарегистрирует своё производство <b>без ожидания подтверждения</b> —
          и сразу появится у вас в списке «Где будете резать?».
        </p>
        <RefShare kind="production" name={name} />
      </div>
    )

  const pending = people?.pending || []
  return (
    <div className="page" style={{ paddingBottom: 100 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 12, paddingTop: 4 }}><MenuButton /><h1 style={{ fontSize: 18, fontWeight: 500 }}>Пригласить по ссылке</h1></div>

      {pending.length > 0 && (
        <div className="card" style={{ marginBottom: 12, border: '1px solid var(--amber)' }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Ждут код · {pending.length}</div>
          {pending.map(p => (
            <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderTop: '0.5px solid var(--border)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.full_name || 'без имени'} <span style={{ color: 'var(--text-hint)', fontWeight: 400 }}>+{p.digits}</span></div>
                <div style={{ fontSize: 11, color: 'var(--text-hint)' }}>
                  {p.kind === 'production' ? 'производство · ' : ''}
                  {p.messenger === 'telegram' ? (p.verified ? 'Telegram — код пришёл в бот, ждём регистрацию' : 'Telegram — ещё не подтвердил номер в боте') : sent[p.id] || p.code_sent_at ? 'WhatsApp — код отправлен' : 'WhatsApp — отправьте ему код'}
                </div>
              </div>
              <button type="button" onClick={() => sendCode(p)} className={p.messenger === 'whatsapp' && !sent[p.id] && !p.code_sent_at ? 'btn-primary' : 'btn-secondary'}
                style={{ padding: '6px 10px', fontSize: 12, flexShrink: 0, ...(p.messenger === 'whatsapp' && !sent[p.id] && !p.code_sent_at ? { background: '#25D366' } : {}) }}>
                {sent[p.id] || p.code_sent_at ? 'Ещё раз' : 'Код в WhatsApp'}
              </button>
            </div>
          ))}
          <p style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 6 }}>Код отправляйте только на номер человека, которого вы пригласили: он подтверждает, что номер его.</p>
        </div>
      )}

      {(first === 'production' ? ['production', 'client'] : ['client', 'production']).map(block)}

      {people && <p style={{ fontSize: 12, color: 'var(--text-hint)', textAlign: 'center' }}>Зарегистрировались по вашим ссылкам: {people.registered || 0}</p>}
      {err && <p className="error-text" style={{ fontSize: 12 }}>{err}</p>}
      <BottomNav />
    </div>
  )
}
