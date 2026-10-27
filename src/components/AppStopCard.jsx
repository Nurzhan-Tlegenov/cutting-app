import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

// Мастер-аккаунт: остановить / восстановить работу приложения и журнал — кто заходил, пока оно стояло, и что написал.
const dt = v => (v ? new Date(v).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '')
const SQL_HINT = 'Чтобы кнопка заработала, выполните в Supabase → SQL Editor файл migration_app_stop.sql.'

export default function AppStopCard() {
  const [log, setLog] = useState(null)        // { on, since, rows }
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const load = async () => {
    const { data, error } = await supabase.rpc('admin_stop_log')
    if (error) { setErr(/function|does not exist|schema cache/i.test(error.message) ? SQL_HINT : error.message); setLog({ on: false, rows: [] }); return }
    setErr(''); setLog(data)
  }
  useEffect(() => {
    let alive = true
    supabase.rpc('admin_stop_log').then(({ data, error }) => {
      if (!alive) return
      if (error) { setErr(/function|does not exist|schema cache/i.test(error.message) ? SQL_HINT : error.message); setLog({ on: false, rows: [] }); return }
      setLog(data)
    })
    return () => { alive = false }
  }, [])
  const toggle = async () => {
    const next = !log?.on
    if (next && !window.confirm('Остановить приложение?\n\nУ всех, кроме мастер-аккаунта, вместо приложения будет заставка с логотипом. Написать разработчику с неё можно. Вернуть — кнопкой «Восстановить работу».')) return
    setBusy(true)
    const { error } = await supabase.rpc('admin_set_app_stop', { p_on: next })
    if (error) setErr(/function|does not exist|schema cache/i.test(error.message) ? SQL_HINT : error.message)
    window.dispatchEvent(new Event('app-stop-changed'))
    await load(); setBusy(false)
  }
  if (!log) return null
  const on = !!log.on
  const rows = log.rows || []
  const msgs = rows.filter(r => r.kind === 'message')
  // заходы — по людям: кто, сколько раз, когда последний
  const visits = new Map()
  for (const r of rows.filter(x => x.kind === 'visit')) {
    const k = r.user_id || 'anon'
    const v = visits.get(k) || { name: r.user_id ? (r.user_name || r.user_phone || 'без имени') : 'без входа (не вошли в аккаунт)', phone: r.user_phone, n: 0, last: r.at }
    v.n++; if (r.at > v.last) v.last = r.at
    visits.set(k, v)
  }
  const vlist = [...visits.values()].sort((a, b) => String(b.last).localeCompare(String(a.last)))
  const btn = { padding: '8px 14px', borderRadius: 10, border: 'none', fontSize: 13, fontWeight: 600, cursor: busy ? 'default' : 'pointer', color: '#fff', background: on ? '#1F7A38' : 'var(--danger)', whiteSpace: 'nowrap' }
  return (
    <div className="card" style={{ marginBottom: 12, border: on ? '1.5px solid var(--danger)' : undefined }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 500, fontSize: 15, color: on ? 'var(--danger)' : undefined }}>{on ? '⛔ Приложение остановлено' : 'Приложение работает'}</div>
          <div style={{ fontSize: 12, color: 'var(--text-hint)', marginTop: 2 }}>
            {on ? `С ${dt(log.since)} у всех, кроме мастер-аккаунта, — заставка с логотипом. Ниже — кто заходил и что написал.`
              : 'Профилактика: остановка закрывает приложение для всех, кроме мастер-аккаунта. С заставки можно написать разработчику.'}
          </div>
        </div>
        <button type="button" disabled={busy} onClick={toggle} style={btn}>{on ? 'Восстановить работу' : 'Остановить приложение'}</button>
      </div>
      {err && <div style={{ fontSize: 12, color: 'var(--amber)', marginTop: 6 }}>{err}</div>}
      {(on || rows.length > 0) && (
        <div style={{ marginTop: 10, fontSize: 12.5 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)', marginBottom: 4 }}>
            <span>{on ? 'За время остановки' : `Последняя остановка (с ${dt(log.since)})`}: заходили {vlist.length}, сообщений {msgs.length}</span>
            <button type="button" onClick={load} style={{ border: 'none', background: 'transparent', color: 'var(--blue)', fontSize: 12, cursor: 'pointer' }}>обновить</button>
          </div>
          {msgs.map(m => (
            <div key={m.id} style={{ background: 'var(--amber-light)', borderRadius: 8, padding: '6px 8px', marginBottom: 4 }}>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                {dt(m.at)} · {m.user_name || m.name || 'без имени'}{(m.user_phone || m.phone) ? <> · <a href={`tel:${String(m.user_phone || m.phone).replace(/[^\d+]/g, '')}`} style={{ color: 'var(--blue)' }}>{m.user_phone || m.phone}</a></> : null}
              </div>
              <div style={{ whiteSpace: 'pre-wrap', color: 'var(--text)' }}>{m.body}</div>
            </div>
          ))}
          {vlist.map((v, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, padding: '3px 0', borderTop: i ? '0.5px solid var(--border)' : 'none', color: 'var(--text-muted)' }}>
              <span style={{ flex: 1, minWidth: 0, color: 'var(--text)' }}>{v.name}{v.phone ? ` · ${v.phone}` : ''}</span>
              <span style={{ whiteSpace: 'nowrap' }}>{v.n} раз · {dt(v.last)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
