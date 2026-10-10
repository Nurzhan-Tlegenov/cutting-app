import { useEffect, useState } from 'react'
import { PERMS, permsText, createInvite, setMember, removeMember, cancelInvite, inviteUrl, assignOrder, orderWorkers } from '../lib/workplaces'

// Рабочие места производства: сотрудники, приглашения по ссылке, полномочия; назначение заказа сотрудникам.
const chip = on => ({ padding: '4px 10px', borderRadius: 14, fontSize: 11.5, cursor: 'pointer', border: '0.5px solid ' + (on ? 'var(--blue)' : 'var(--border-md)'), background: on ? 'var(--blue-light)' : 'transparent', color: on ? 'var(--blue-dark)' : 'var(--text-muted)' })
const small = { padding: '4px 10px', borderRadius: 14, fontSize: 11.5, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text-muted)', whiteSpace: 'nowrap' }
const digits = v => String(v || '').replace(/\D/g, '')

function PermChips({ perms, onChange }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
      {PERMS.map(([k, label, hint]) => {
        const on = !!perms?.[k], implied = k !== 'all' && k !== 'prices' && perms?.all
        return <button key={k} type="button" title={hint} style={{ ...chip(on || implied), opacity: implied && !on ? 0.6 : 1 }} onClick={() => onChange({ ...perms, [k]: !on })}>{on || implied ? '✓ ' : ''}{label}</button>
      })}
    </div>
  )
}

// ссылка приглашения: скопировать, отправить в WhatsApp или через меню телефона
function InviteLink({ inv, onCancel }) {
  const url = inviteUrl(inv.code)
  const [copied, setCopied] = useState(false)
  const text = `Приглашение на рабочее место${inv.name ? ` «${inv.name}»` : ''} в производстве. Откройте ссылку и зарегистрируйтесь (или войдите): ${url}`
  const copy = async () => { try { await navigator.clipboard.writeText(url); setCopied(true) } catch { window.prompt('Скопируйте ссылку', url) } }
  return (
    <div style={{ padding: '7px 9px', background: 'var(--bg2)', borderRadius: 'var(--radius)', marginTop: 6 }}>
      <div style={{ fontSize: 12.5 }}><b style={{ fontWeight: 500 }}>{inv.name || 'Сотрудник'}</b>{inv.phone ? ` · ${inv.phone}` : ''} <span style={{ color: 'var(--text-hint)' }}>— ждёт принятия до {new Date(inv.expires_at).toLocaleDateString('ru-RU')}</span></div>
      <div style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 5 }}>Доступ: {permsText(inv.perms)}</div>
      <input readOnly value={url} onFocus={e => e.target.select()} style={{ fontSize: 12, padding: '5px 8px', marginBottom: 5 }} />
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
        <button type="button" style={{ ...small, color: 'var(--blue)', borderColor: 'var(--blue)' }} onClick={copy}>{copied ? '✓ Скопировано' : 'Скопировать'}</button>
        <a href={`https://wa.me/${digits(inv.phone)}?text=${encodeURIComponent(text)}`} target="_blank" rel="noreferrer" style={{ ...small, textDecoration: 'none', color: 'var(--teal)', borderColor: 'var(--teal)' }}>WhatsApp</a>
        {navigator.share && <button type="button" style={small} onClick={() => navigator.share({ title: 'Приглашение на производство', text, url }).catch(() => {})}>Поделиться</button>}
        <button type="button" style={{ ...small, color: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={onCancel}>Отменить</button>
      </div>
    </div>
  )
}

/** Раздел «Сотрудники» у владельца производства. data — { members, invites } из membersList(), onReload — перечитать */
export function StaffSection({ data, error, onReload }) {
  const [form, setForm] = useState(null)       // новое приглашение: { name, phone, perms }
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [edit, setEdit] = useState(null)       // user_id сотрудника, у которого открыты полномочия
  const act = async fn => { setBusy(true); setErr(''); const r = await fn(); setBusy(false); if (r?.error) setErr(r.error); else onReload() }
  const members = data?.members || [], invites = data?.invites || []
  const invite = () => act(async () => { const r = await createInvite(form.name, form.phone, form.perms); if (!r.error) setForm(null); return r })
  return (
    <details style={{ marginTop: 8 }}>
      <summary style={{ fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}>Сотрудники (рабочие места){members.length ? ` · ${members.filter(m => m.active).length}` : ''}</summary>
      {error ? <p style={{ fontSize: 11.5, color: 'var(--amber)', marginTop: 6 }}>{error}</p> : (
        <div style={{ marginTop: 6 }}>
          <p style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 6 }}>Сотрудник заходит по ссылке-приглашению и работает в своём аккаунте (он может быть и клиентом приложения). Начальник производства видит все заказы и назначает их; остальные видят только назначенные им заказы.</p>
          {err && <p className="error-text" style={{ marginBottom: 6 }}>{err}</p>}
          {members.map(m => (
            <div key={m.user_id} style={{ padding: '7px 0', borderTop: '0.5px solid var(--border)', opacity: m.active ? 1 : 0.55 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ flex: 1, minWidth: 0, fontSize: 13 }}>
                  <b style={{ fontWeight: 500 }}>{m.name || m.full_name || 'Сотрудник'}</b>
                  <span style={{ fontSize: 11.5, color: 'var(--text-hint)' }}>{m.full_name && m.full_name !== m.name ? ` · ${m.full_name}` : ''}{m.phone ? ` · ${m.phone}` : ''}{!m.active ? ' · отключён' : ''}</span>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{permsText(m.perms)}{m.orders ? ` · заказов в работе: ${m.orders}` : ''}</div>
                </div>
                <button type="button" style={small} onClick={() => setEdit(edit === m.user_id ? null : m.user_id)}>{edit === m.user_id ? 'Готово' : 'Права'}</button>
              </div>
              {edit === m.user_id && (
                <div style={{ marginTop: 6 }}>
                  <PermChips perms={m.perms} onChange={p => act(() => setMember(m.user_id, { perms: p }))} />
                  <div style={{ display: 'flex', gap: 5, marginTop: 6 }}>
                    <button type="button" disabled={busy} style={small} onClick={() => { const n = window.prompt('Как называть сотрудника (имя, должность)', m.name || ''); if (n != null) act(() => setMember(m.user_id, { name: n })) }}>Переименовать</button>
                    <button type="button" disabled={busy} style={small} onClick={() => act(() => setMember(m.user_id, { active: !m.active }))}>{m.active ? 'Отключить' : 'Включить'}</button>
                    <button type="button" disabled={busy} style={{ ...small, color: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={() => { if (window.confirm(`Убрать сотрудника «${m.name || m.full_name || ''}»? Его назначения на заказы снимутся.`)) act(() => removeMember(m.user_id)) }}>Убрать</button>
                  </div>
                </div>
              )}
            </div>
          ))}
          {invites.map(inv => <InviteLink key={inv.code} inv={inv} onCancel={() => act(() => cancelInvite(inv.code))} />)}
          {form ? (
            <div style={{ marginTop: 8, padding: '8px 10px', border: '0.5px solid var(--border-md)', borderRadius: 'var(--radius)' }}>
              <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 6 }}>Новое рабочее место</div>
              <input type="text" placeholder="Имя или должность (например, Присадчик Асхат)" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} style={{ marginBottom: 6 }} />
              <input type="tel" placeholder="Телефон сотрудника (если регистрация закрыта)" value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} style={{ marginBottom: 6 }} />
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 4 }}>Полномочия</div>
              <PermChips perms={form.perms} onChange={p => setForm(f => ({ ...f, perms: p }))} />
              <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                <button type="button" className="btn-primary" disabled={busy} onClick={invite} style={{ padding: 8, fontSize: 13 }}>Создать ссылку-приглашение</button>
                <button type="button" className="btn-secondary" onClick={() => setForm(null)} style={{ padding: 8, fontSize: 13 }}>Отмена</button>
              </div>
            </div>
          ) : (
            <button type="button" style={{ ...small, marginTop: 8, color: 'var(--blue)', borderColor: 'var(--blue)' }} onClick={() => setForm({ name: '', phone: '', perms: { cnc: true, labels: true } })}>+ Пригласить сотрудника</button>
          )}
        </div>
      )}
    </details>
  )
}

/** Кому назначен заказ: нажатие на сотрудника назначает или снимает. members — активные сотрудники производства */
export function OrderAssign({ orderId, members }) {
  const [on, setOn] = useState(null)
  const [err, setErr] = useState('')
  useEffect(() => { let alive = true; orderWorkers(orderId).then(r => { if (alive) setOn(new Set((r.data || []).map(w => w.user_id))) }); return () => { alive = false } }, [orderId])
  const list = (members || []).filter(m => m.active && !m.perms?.all)
  if (!list.length || !on) return null
  const toggle = async m => {
    const next = !on.has(m.user_id)
    setOn(s => { const n = new Set(s); if (next) n.add(m.user_id); else n.delete(m.user_id); return n })
    const r = await assignOrder(orderId, m.user_id, next)
    if (r.error) { setErr(r.error); setOn(s => { const n = new Set(s); if (next) n.delete(m.user_id); else n.add(m.user_id); return n }) }
  }
  return (
    <div style={{ marginTop: 8 }} onClick={e => e.stopPropagation()}>
      <div style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 4 }}>Сотрудники на заказе — нажмите, чтобы назначить или снять:</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
        {list.map(m => <button key={m.user_id} type="button" style={chip(on.has(m.user_id))} onClick={() => toggle(m)}>{on.has(m.user_id) ? '✓ ' : ''}{m.name || m.full_name || 'Сотрудник'}</button>)}
      </div>
      {err && <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 3 }}>{err}</div>}
    </div>
  )
}
