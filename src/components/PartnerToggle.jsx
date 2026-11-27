import { useEffect, useState } from 'react'
import { adminPartners, setPartner, setPartnerClient, adminPartnerMap } from '../lib/support'
import { useAuth } from '../context/AuthContext'
import { sendReply } from '../lib/messages'

// Мастер-аккаунт: статус «Официальный представитель RaskroyPro» (migration_partners.sql) и «за каким партнёром закреплён» — в карточке пользователя.
// Общий список партнёров на все карточки (один запрос)
let cache = null
const subs = new Set()
const load = () => (cache = Promise.all([adminPartners(), adminPartnerMap()]).then(([a, b]) => ({ list: a.data || [], map: b.data || {}, error: a.error || b.error || '' })))
const reload = () => load().then(v => subs.forEach(f => f(v)))
function usePartners() {
  const [st, setSt] = useState(null)
  useEffect(() => {
    let alive = true
    const set = v => { if (alive) setSt(v) }
    subs.add(set)
    ;(cache || load()).then(set)
    return () => { alive = false; subs.delete(set) }
  }, [])
  return st
}

/** Пометка в списке пользователей: «🤝 представитель» / «клиент представителя Имя» */
export function PartnerBadge({ userId }) {
  const st = usePartners()
  if (!st || st.error) return null
  const p = st.list.find(x => x.user_id === userId && x.active)
  const by = st.map[userId]
  if (!p && !by) return null
  return <span title={p ? `Официальный представитель RaskroyPro · клиентов ${p.clients}` : `Клиент официального представителя ${by.name}`} style={{ fontSize: 10.5, padding: '1px 6px', borderRadius: 9, background: 'var(--blue-light, var(--bg2))', color: 'var(--blue)', whiteSpace: 'nowrap', flexShrink: 0, maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis' }}>{p ? `🤝 ${p.clients}` : `🤝 ${by.name}`}</span>
}

// сообщение человеку, когда ему выдали статус: придёт в «Сообщения» и уведомлением на телефон
const GRANT_TEXT = 'Вам выдан статус «Официальный представитель RaskroyPro» 🤝\n\n' +
  'Закройте и снова откройте приложение — в меню появится раздел «Официальный представитель RaskroyPro»:\n' +
  '• «Мои клиенты и приглашения» — кого вы пригласили; отправляйте производствам ссылку «Пригласить производство» — после регистрации они закрепятся за вами;\n' +
  '• «Обращения клиентов» — вопросы ваших клиентов приходят вам, вы отвечаете им сами. Если нужна доработка приложения — «Передать разработчику».'

export default function PartnerToggle({ userId, name = '', style, attach = false }) {
  const { user, profile } = useAuth()
  const st = usePartners()
  const [sent, setSent] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  if (!st) return null
  if (st.error) return <div style={{ fontSize: 11.5, color: 'var(--text-hint)', ...style }}>{st.error}</div>
  const me = st.list.find(x => x.user_id === userId)
  const on = !!me?.active
  const run = async f => { setBusy(true); setErr(''); const r = await f(); setBusy(false); if (r.error) setErr(r.error); else reload() }
  const toggle = () => {
    if (!on && !window.confirm(`Дать «${name || 'пользователю'}» статус «Официальный представитель RaskroyPro»?\n\nКого он пригласил и пригласит своими ссылками — закрепятся за ним. Обращения этих пользователей будут приходить ему (вы их тоже видите, с пометкой). Другие обращения он не видит.`)) return
    if (on && !window.confirm(`Снять статус официального представителя с «${name || 'пользователя'}»? Его клиенты останутся записаны за ним, но их обращения снова пойдут вам и поддержке.`)) return
    run(async () => {
      const r = await setPartner(userId, !on)
      if (!r.error && !on) { const m = await sendReply(user, profile, userId, GRANT_TEXT, name); setSent(m?.error ? `Статус выдан, но сообщение не ушло: ${m.error}` : 'Статус выдан — ему отправлено сообщение с подсказкой перезапустить приложение.') }
      return r
    })
  }
  const others = st.list.filter(x => x.active && x.user_id !== userId)
  return (
    <div style={style}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: busy ? 'wait' : 'pointer' }}>
        <input type="checkbox" checked={on} disabled={busy} onChange={toggle} style={{ width: 18, height: 18, margin: 0 }} />
        <span>🤝 Официальный представитель RaskroyPro{on ? ` · клиентов ${me.clients}` : ''}</span>
      </label>
      {attach && !on && others.length > 0 && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, marginTop: 6, color: 'var(--text-muted)' }}>
          Закреплён за представителем:
          <select value={st.map[userId]?.id || ''} disabled={busy}
            onChange={e => run(() => setPartnerClient(userId, e.target.value || null))} style={{ width: 'auto', minWidth: 0, flex: 1, padding: '4px 6px', fontSize: 12.5 }}>
            <option value="">— нет</option>
            {others.map(o => <option key={o.user_id} value={o.user_id}>{o.full_name || o.phone || 'партнёр'}</option>)}
          </select>
        </label>
      )}
      {sent && <div style={{ fontSize: 11.5, marginTop: 2, color: 'var(--teal)' }}>{sent}</div>}
      {err && <div className="error-text" style={{ fontSize: 11.5, marginTop: 2 }}>{err}</div>}
    </div>
  )
}
