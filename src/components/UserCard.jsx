// Мастер-аккаунт: «с кем имею дело» — кто этот пользователь, откуда, какое у него производство (или чей он сотрудник),
// какие постпроцессоры выданы и свои, сколько заказов. Строка под именем (UserLine) и карточка по нажатию (UserCardDialog)
// — в обращениях, переписке и «Постпроцессорах по запросу». Данные — один общий справочник на минуту (useAdminDirectory).
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { useAdminDirectory, whoLine } from '../lib/adminDirectory'
import { WriteToUserDialog } from './WriteToUser'

const digits = v => String(v || '').replace(/\D/g, '')
const telOf = u => digits(u?.phone) || (/@raskoypro\.local$/i.test(String(u?.email || '')) ? digits(String(u.email).split('@')[0]) : '')
const place = (...v) => v.map(x => String(x || '').trim()).filter(Boolean).join(', ')
const isProd = u => !!u?.production_id && (u.production_status ?? 'approved') === 'approved'
const date = v => (v ? new Date(v).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '—')
const ago = v => {
  if (!v) return '—'
  const d = Math.floor((Date.now() - new Date(v).getTime()) / 86400000)
  return d <= 0 ? 'сегодня' : d === 1 ? 'вчера' : `${d} дн. назад`
}

/** Строка «кто это» под именем; пусто, пока справочник не загрузился */
export function UserLine({ dir, id, style }) {
  const t = whoLine(dir, id)
  if (!t) return null
  return <span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-muted)', fontWeight: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', ...style }}>{t}</span>
}

/** Имя-ссылка: нажатие открывает карточку пользователя */
export function UserName({ id, name, dir, children, style, canWrite = true }) {
  const [open, setOpen] = useState(false)
  if (!id) return <span style={style}>{children || name}</span>
  return (
    <>
      <span role="button" tabIndex={0} title="Карточка пользователя" onClick={e => { e.stopPropagation(); setOpen(true) }}
        onKeyDown={e => { if (e.key === 'Enter') { e.stopPropagation(); setOpen(true) } }}
        style={{ cursor: 'pointer', color: 'var(--blue)', textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 3, ...style }}>{children || name || 'Пользователь'}</span>
      {open && <UserCardDialog id={id} name={name} dir={dir} canWrite={canWrite} onClose={() => setOpen(false)} />}
    </>
  )
}

const row = { display: 'flex', gap: 8, fontSize: 13, padding: '5px 0', borderTop: '0.5px solid var(--border)' }
const key = { width: 108, flexShrink: 0, color: 'var(--text-hint)', fontSize: 12.5 }
const chip = (fg, bg) => ({ fontSize: 11.5, padding: '2px 8px', borderRadius: 10, color: fg, background: bg, whiteSpace: 'nowrap' })
const REF_KIND = { friend: 'ссылка «знакомому»', client: 'ссылка производства', production: 'ссылка для производства' }
const KIND = { router: 'раскрой', drill6: 'присадка 6-стор.', beamsaw: 'пильный центр' }

/** Карточка пользователя (окно поверх всего, в т. ч. переписки) */
export function UserCardDialog({ id, name, dir: dir0, canWrite = true, onClose }) {
  const navigate = useNavigate()
  const loaded = useAdminDirectory(!dir0)
  const dir = dir0 || loaded
  const [write, setWrite] = useState(false)
  const u = dir?.users.get(id)
  const tel = telOf(u), wa = digits(u?.whatsapp) || tel
  const work = dir?.members.get(id) || []
  const granted = dir?.granted.get(id) || []
  const own = dir?.own.get(id)
  const asks = (dir?.asks.get(id) || []).filter(q => q.status === 'new')
  const usage = dir?.usage.get(id)
  const refBy = dir?.refBy?.get(id)
  const invited = dir?.invited?.get(id) || []
  const [showInv, setShowInv] = useState(false)
  const openUsers = () => { onClose(); navigate(`/users?open=${id}`) }
  if (write) return <WriteToUserDialog to={{ id, name: u?.full_name || name || '' }} onClose={() => { setWrite(false); onClose() }} />
  return createPortal(
    <div onClick={e => { e.stopPropagation(); onClose() }} style={{ position: 'fixed', inset: 0, zIndex: 2100, background: 'rgba(0,0,0,.38)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 560, maxHeight: '88vh', overflowY: 'auto', background: 'var(--bg)', borderRadius: '18px 18px 0 0', padding: '14px 16px calc(18px + env(safe-area-inset-bottom))' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 16.5, fontWeight: 600 }}>{u?.full_name || name || 'Пользователь'}</div>
            {dir && <UserLine dir={dir} id={id} style={{ whiteSpace: 'normal', fontSize: 12.5 }} />}
          </div>
          <button type="button" onClick={onClose} style={{ width: 32, height: 32, borderRadius: 16, border: 'none', background: 'var(--bg2)', fontSize: 18, cursor: 'pointer', color: 'var(--text-muted)', flexShrink: 0 }}>×</button>
        </div>
        {!dir && <div style={{ fontSize: 13, color: 'var(--text-hint)', padding: '16px 0' }}>Загружаем…</div>}
        {dir && !u && <div style={{ fontSize: 13, color: 'var(--text-hint)', padding: '12px 0' }}>{dir.error || 'Аккаунт не найден — возможно, удалён.'}</div>}
        {u && (
          <div style={{ marginTop: 10 }}>
            <div style={row}><span style={key}>Телефон</span><span style={{ flex: 1, minWidth: 0, display: 'flex', flexWrap: 'wrap', columnGap: 10, rowGap: 2, alignItems: 'baseline' }}>
              {tel ? <a href={`tel:+${tel}`} style={{ color: 'var(--blue)' }}>{u.phone || `+${tel}`}</a> : <span style={{ color: 'var(--text-hint)' }}>—</span>}
              {wa && <a href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer" style={{ color: 'var(--teal)', fontSize: 12.5 }}>WhatsApp</a>}
              {tel && <a href={`https://t.me/+${tel}`} target="_blank" rel="noreferrer" style={{ color: 'var(--blue)', fontSize: 12.5 }}>Telegram</a>}
            </span></div>
            {u.email && !/@raskoypro\.local$/i.test(u.email) && <div style={row}><span style={key}>Почта</span><span style={{ flex: 1, minWidth: 0, wordBreak: 'break-all' }}>{u.email}</span></div>}
            <div style={row}><span style={key}>Страна, город</span><span>{place(u.country, u.city) || <span style={{ color: 'var(--text-hint)' }}>не указаны</span>}</span></div>
            <div style={row}><span style={key}>Роль</span><span>{u.role === 'admin' ? 'Администратор' : u.role === 'operator' ? 'Производство' : 'Клиент'}</span></div>
            <div style={row}><span style={key}>В приложении</span><span>с {date(u.created_at)} · заходил {ago(u.last_sign_in_at)}</span></div>
            {refBy && <div style={row}><span style={key}>Пригласил</span><span style={{ flex: 1, minWidth: 0 }}>
              <UserName id={refBy.ref_by} name={refBy.ref_by_name} dir={dir} canWrite={canWrite} />
              <span style={{ color: 'var(--text-hint)', fontSize: 12 }}> · {REF_KIND[refBy.kind] || 'по ссылке'} · {date(refBy.at)}</span>
            </span></div>}
            {invited.length > 0 && <div style={row}><span style={key}>Пригласил сам</span><span style={{ flex: 1, minWidth: 0 }}>
              <span role="button" tabIndex={0} onClick={() => setShowInv(v => !v)} onKeyDown={e => { if (e.key === 'Enter') setShowInv(v => !v) }}
                style={{ cursor: 'pointer', color: 'var(--blue)' }}>{invited.length} чел. {showInv ? '▴' : '▾'}</span>
              {showInv && invited.map(x => (
                <div key={x.user_id} style={{ fontSize: 12.5, marginTop: 3 }}>
                  <UserName id={x.user_id} name={dir.users.get(x.user_id)?.full_name || 'Пользователь'} dir={dir} canWrite={canWrite} />
                  <span style={{ color: 'var(--text-hint)' }}> · {REF_KIND[x.kind] || 'по ссылке'} · {date(x.at)}</span>
                </div>
              ))}
            </span></div>}
            <div style={row}><span style={key}>Заказы</span><span>создано <b>{u.orders || 0}</b> · отправлено <b>{u.submitted || 0}</b>{u.last_order_at ? ` · последний ${ago(u.last_order_at)}` : ''}</span></div>

            {u.production_id && (
              <div style={{ marginTop: 10, padding: '8px 10px', background: 'var(--amber-light)', borderRadius: 'var(--radius)', fontSize: 13, color: 'var(--amber)' }}>
                <div style={{ fontWeight: 600 }}>🏭 Своё производство «{u.production_name}»{isProd(u) ? '' : u.production_status === 'rejected' ? ' — отклонено' : ' — ждёт подтверждения'}</div>
                <div>{place(u.production_country, u.production_city) || 'город не указан'}{u.production_phone ? ` · ${u.production_phone}` : ''}{u.production_created_at ? ` · с ${date(u.production_created_at)}` : ''}</div>
                {isProd(u) && <div>заявок получено <b>{u.received || 0}</b> · принято <b>{u.accepted || 0}</b> · исполнено <b>{u.done || 0}</b></div>}
              </div>
            )}
            {work.map((m, i) => (
              <div key={i} style={{ marginTop: 8, padding: '8px 10px', background: 'var(--bg2)', borderRadius: 'var(--radius)', fontSize: 13 }}>
                <div style={{ fontWeight: 600 }}>👷 Сотрудник производства «{m.production_name}»{m.active === false ? ' — отключён' : ''}</div>
                <div style={{ color: 'var(--text-muted)' }}>{[m.name, place(m.production_country, m.production_city), m.owner_name ? `владелец: ${m.owner_name}` : '', m.created_at ? `с ${date(m.created_at)}` : ''].filter(Boolean).join(' · ')}</div>
              </div>
            ))}
            {dir.noMembers && <div style={{ fontSize: 11.5, color: 'var(--text-hint)', marginTop: 6 }}>Чей сотрудник — появится после migration_admin_memberships.sql в Supabase.</div>}

            <div style={{ marginTop: 12, fontSize: 13, fontWeight: 600 }}>Постпроцессоры</div>
            {!granted.length && !own?.own?.length && !asks.length && <div style={{ fontSize: 12.5, color: 'var(--text-hint)', marginTop: 4 }}>Не выдавались, своих нет.</div>}
            {granted.map((g, i) => (
              <div key={'g' + i} style={{ ...row, alignItems: 'center' }}>
                <span style={chip('var(--teal)', 'var(--teal-light)')}>🔑 {g.name}</span>
                <span style={{ flex: 1, fontSize: 12, color: 'var(--text-muted)' }}>{KIND[g.kind] || ''} · выдан {date(g.at)} · программ {g.runs || 0} · {g.last ? ago(g.last) : 'не выпускал'}</span>
              </div>
            ))}
            {own?.own?.length > 0 && (
              <div style={{ ...row, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>⚙ Свои: {own.own.map((x, i) => <span key={i}>{i ? ', ' : ''}«{x.name}»{x.base ? <span style={{ color: 'var(--amber)' }}> на основе «{x.base}»</span> : null}</span>)}{own.own_runs > 0 ? ` · выпущено своими: ${own.own_runs}` : ''}</span>
              </div>
            )}
            {asks.map(q => <div key={q.id} style={{ ...row, fontSize: 12.5, color: 'var(--amber)' }}>⏳ Ждёт: {q.post_name ? `«${q.post_name}»` : 'свой станок'}{q.machine ? ` · ${q.machine}` : ''}</div>)}
            {usage && <div style={{ fontSize: 12, color: 'var(--text-hint)', marginTop: 4 }}>За 90 дней выпустил программ: {usage.runs} · последний раз {ago(usage.last)}</div>}

            <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
              {canWrite && <button type="button" className="btn-secondary" style={{ flex: 1, minWidth: 130 }} onClick={() => setWrite(true)}>✉ Написать</button>}
              <button type="button" className="btn-primary" style={{ flex: 1, minWidth: 130 }} onClick={openUsers}>В «Пользователях»</button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
