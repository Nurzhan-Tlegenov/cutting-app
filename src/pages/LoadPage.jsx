// Мастер-аккаунт: «Нагрузка» — как быстро база отвечает пользователям, в какие часы просаживается, что тормозит,
// сколько места занято (migration_load.sql; замеры — src/lib/perf.js у каждого пользователя).
import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { getUserSettings, saveUserSettings } from '../lib/userSettings'
import { MenuButton } from '../components/NavDrawer'
import BottomNav from '../components/BottomNav'
import CncLoader from '../components/CncLoader'

const HINT = 'Страница «Нагрузка» ещё не включена в базе: выполните migration_load.sql в Supabase (SQL Editor) — один раз. Замеры начнут приходить от пользователей сразу после этого (раз в 5 минут от каждого, кто в приложении).'
const MB = 1024 * 1024
const size = b => (b == null ? '—' : b >= 1024 * MB ? `${(b / 1024 / MB).toFixed(2)} ГБ` : b >= MB ? `${(b / MB).toFixed(1)} МБ` : `${Math.round(b / 1024)} КБ`)
const ms = v => (v == null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)} с` : `${Math.round(v)} мс`)
const clamp = v => Math.max(0, Math.min(100, v))
// время ответа -> нагрузка, %: до 150 мс — свободно, 2,5 с в худших запросах — предел
const speedLoad = p95 => (p95 == null ? null : clamp((p95 - 150) / (2500 - 150) * 100))
const color = v => (v >= 80 ? 'var(--danger)' : v >= 55 ? 'var(--amber)' : 'var(--teal)')
// понятные названия мест, где идут запросы
const PLACE = { orders: 'Заказы', order_details: 'Детали заказов', profiles: 'Профили', productions: 'Производства', app_messages: 'Сообщения', user_settings: 'Настройки аккаунта',
  production_members: 'Сотрудники производств', shared_posts: 'Постпроцессоры', task_cards: 'Мои задачи', task_columns: 'Мои задачи (этапы)', pushes: 'Уведомления' }
const placeOf = p => {
  if (!p) return '—'
  if (p === '/storage') return 'Файлы (модели, картинки)'
  if (p.startsWith('/auth/')) return 'Вход / ключ входа' + (p.length > 6 ? ` (${p.slice(6)})` : '')
  if (p.startsWith('/functions')) return 'Отправка уведомлений'
  const m = /\/rest\/v1\/rpc\/(.+)/.exec(p)
  if (m) return `Функция ${m[1]}`
  const t = /\/rest\/v1\/([^/]+)/.exec(p)?.[1]
  return t ? PLACE[t] || t : p
}

export default function LoadPage() {
  const { isMaster, user } = useAuth()
  const [d, setD] = useState(null)
  const [err, setErr] = useState('')
  const [at, setAt] = useState(null)
  const [lim, setLim] = useState(() => getUserSettings(user).loadLimits || { db: '', files: '' })   // лимиты тарифа, ГБ
  const load = async () => {
    const { data, error } = await supabase.rpc('admin_load')
    if (error) { setErr(/admin_load|PGRST20|42883|schema cache/i.test(String(error.message) + ' ' + String(error.code)) ? HINT : error.message); setD({}) }
    else { setErr(''); setD(data || {}) }
    setAt(new Date())
  }
  useEffect(() => { Promise.resolve().then(load); const t = setInterval(load, 60000); return () => clearInterval(t) }, [])
  if (!isMaster) return <div className="page"><p>Раздел доступен только мастер-аккаунту.</p><BottomNav /></div>
  const setLimit = (k, v) => { const next = { ...lim, [k]: v.replace(/[^0-9.,]/g, '') }; setLim(next); saveUserSettings({ loadLimits: next }, user) }
  const gb = v => Number(String(v || '').replace(',', '.')) || 0

  // «батарейка»: нагрузка — по самому узкому месту (скорость, ошибки, заполненность базы и файлов)
  const h = d?.hour || {}, now = d?.now || {}
  const files = (d?.storage || []).reduce((a, b) => a + Number(b.bytes || 0), 0)
  const parts = [
    ['Скорость ответа', speedLoad(h.p95 ?? now.p95), h.p95 != null ? `худшие запросы за час — ${ms(h.p95)}` : 'замеров за час ещё нет'],
    ['Ошибки запросов', h.n ? clamp((h.err / h.n) * 100 * 10) : null, h.n ? `${((h.err / h.n) * 100).toFixed(1)} % запросов за час не прошли` : ''],
    ['Место в базе', gb(lim.db) ? clamp(d?.db?.bytes / (gb(lim.db) * 1024 * MB) * 100) : null, gb(lim.db) ? `${size(d?.db?.bytes)} из ${lim.db} ГБ` : 'впишите лимит тарифа ниже'],
    ['Место для файлов', gb(lim.files) ? clamp(files / (gb(lim.files) * 1024 * MB) * 100) : null, gb(lim.files) ? `${size(files)} из ${lim.files} ГБ` : 'впишите лимит тарифа ниже'],
  ]
  const known = parts.filter(p => p[1] != null)
  const loadPct = known.length ? Math.round(Math.max(...known.map(p => p[1]))) : null
  const free = loadPct == null ? null : 100 - loadPct
  const hours = d?.hours || [], days = d?.days || []
  const maxH = Math.max(300, ...hours.map(x => x.p95 || 0)), maxD = Math.max(300, ...days.map(x => x.p95 || 0))
  const card = { padding: '10px 12px', marginBottom: 10 }
  const head = t => <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 6 }}>{t}</div>
  const bars = (list, max, label) => (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 110, padding: '4px 0' }}>
      {list.map((x, i) => {
        const p95 = x.p95 || 0, p50 = x.p50 || 0
        return (
          <div key={i} title={`${label(x)}: обычно ${ms(p50)}, худшие ${ms(p95)}, запросов ${x.n}, людей ${x.users}${x.err ? `, ошибок ${x.err}` : ''}`}
            style={{ flex: 1, minWidth: 6, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center', height: '100%' }}>
            <div style={{ width: '100%', height: `${p95 / max * 100}%`, position: 'relative' }}>
              <div style={{ position: 'absolute', inset: 0, background: color(speedLoad(p95)), opacity: 0.35, borderRadius: '3px 3px 0 0' }} />
              <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: `${p95 ? p50 / p95 * 100 : 0}%`, background: color(speedLoad(p95)), borderRadius: 2, opacity: 0.9 }} />
            </div>
            <div style={{ fontSize: 9, color: 'var(--text-hint)', marginTop: 2, whiteSpace: 'nowrap' }}>{label(x)}</div>
          </div>
        )
      })}
    </div>
  )

  return (
    <div className="page page-read" style={{ paddingBottom: 100 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 10, paddingTop: 4 }}>
        <MenuButton /><h1 style={{ flex: 1, fontSize: 18, fontWeight: 500 }}>Нагрузка</h1>
        <button type="button" onClick={load} style={{ padding: '5px 12px', borderRadius: 16, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer' }}>↻ {at ? at.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : ''}</button>
      </div>
      {err && <div className="card" style={{ fontSize: 13, color: err === HINT ? 'var(--amber)' : 'var(--danger)', marginBottom: 10 }}>{err}</div>}
      {!d && <CncLoader label="Загружаем…" />}

      {d && !err && (<>
        {/* батарейка */}
        <div className="card" style={card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ width: 92, height: 44, border: '3px solid var(--text-muted)', borderRadius: 8, padding: 3, position: 'relative', flexShrink: 0 }}>
              <div style={{ position: 'absolute', right: -9, top: 12, width: 5, height: 14, background: 'var(--text-muted)', borderRadius: '0 3px 3px 0' }} />
              <div style={{ height: '100%', width: `${free ?? 0}%`, background: free == null ? 'var(--bg2)' : color(loadPct), borderRadius: 4, transition: 'width .4s' }} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 24, fontWeight: 700, color: free == null ? 'var(--text-hint)' : color(loadPct) }}>{free == null ? '—' : `${free} %`}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{free == null ? 'запас — появится с первыми замерами' : loadPct >= 80 ? 'запаса почти нет — пора расширять тариф или искать, что тормозит' : loadPct >= 55 ? 'запас есть, но в часы пик тесновато' : 'запас хороший'}</div>
            </div>
          </div>
          <div style={{ marginTop: 8 }}>
            {parts.map(([l, v]) => (
              <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginTop: 4 }}>
                <span style={{ width: 128, color: 'var(--text-muted)' }}>{l}</span>
                <div style={{ flex: 1, height: 6, background: 'var(--bg2)', borderRadius: 3 }}><div style={{ width: `${v ?? 0}%`, height: '100%', background: v == null ? 'transparent' : color(v), borderRadius: 3 }} /></div>
                <span style={{ width: 40, textAlign: 'right', fontWeight: 600 }}>{v == null ? '—' : `${Math.round(v)}%`}</span>
              </div>
            ))}
            <div style={{ fontSize: 10.5, color: 'var(--text-hint)', marginTop: 6 }}>{parts.map(p => p[2] && `${p[0]}: ${p[2]}`).filter(Boolean).join(' · ')}</div>
          </div>
        </div>

        {/* сейчас */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 8, marginBottom: 10 }}>
          {[['👥 Сейчас в приложении', now.online ?? 0, 'за 15 минут'], ['⚡ Обычный ответ', ms(now.p50 ?? h.p50), 'половина запросов быстрее'], ['🐢 Худшие ответы', ms(now.p95 ?? h.p95), '5 % запросов медленнее'],
            ['❌ Ошибки за час', h.n ? `${h.err} из ${h.n}` : '—', 'сеть, сбои базы'], ['🧑 Пользователей', d.users ?? '—', `заказов ${d.orders ?? '—'}`], ['🔌 Подключений к базе', d.db?.conns ?? '—', 'сейчас']].map(([l, v, s]) => (
            <div key={l} className="card" style={{ padding: '8px 10px' }}>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{l}</div>
              <div style={{ fontSize: 18, fontWeight: 600, marginTop: 2 }}>{v}</div>
              <div style={{ fontSize: 10.5, color: 'var(--text-hint)' }}>{s}</div>
            </div>
          ))}
        </div>

        <div className="card" style={card}>
          {head('Скорость по часам — последние сутки')}
          {hours.length ? bars(hours, maxH, x => String(new Date(x.t).getHours()).padStart(2, '0')) : <div style={{ fontSize: 12.5, color: 'var(--text-hint)' }}>Замеров ещё нет — они приходят раз в 5 минут от каждого, кто в приложении.</div>}
          <div style={{ fontSize: 10.5, color: 'var(--text-hint)' }}>Столбик — худшие ответы за час, тёмная часть — обычный ответ. Зелёный — быстро, жёлтый — тесновато, красный — просадка. Наведите на столбик — подробности.</div>
        </div>
        {days.length > 1 && (
          <div className="card" style={card}>
            {head('По дням — 2 недели')}
            {bars(days, maxD, x => new Date(x.t).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }))}
          </div>
        )}

        {(d.via || []).length > 0 && (
          <div className="card" style={card}>
            {head('Напрямую и через зеркало — сутки')}
            {(d.via || []).map(v => (
              <div key={v.via} style={{ display: 'flex', gap: 8, fontSize: 12.5, padding: '4px 0', borderTop: '0.5px solid var(--border)' }}>
                <span style={{ flex: 1 }}>{v.via === 'mirror' ? 'Зеркало (ru.raskroypro.com)' : 'Напрямую'}</span>
                <span style={{ color: 'var(--text-muted)' }}>людей {v.users} · обычно {ms(v.p50)} · худшие {ms(v.p95)}</span>
              </div>
            ))}
          </div>
        )}

        <div className="card" style={card}>
          {head('Что дольше всего ждут — сутки')}
          {!(d.top || []).length && <div style={{ fontSize: 12.5, color: 'var(--text-hint)' }}>Пока нет данных.</div>}
          {(d.top || []).map(t => (
            <div key={t.p} style={{ display: 'flex', gap: 8, fontSize: 12.5, padding: '5px 0', borderTop: '0.5px solid var(--border)' }}>
              <span style={{ flex: 1, minWidth: 0 }}>{placeOf(t.p)}<span style={{ display: 'block', fontSize: 10.5, color: 'var(--text-hint)' }}>{t.p}</span></span>
              <span style={{ textAlign: 'right', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>в среднем {ms(t.avg)}<span style={{ display: 'block', fontSize: 10.5, color: 'var(--text-hint)' }}>макс. {ms(t.mx)} · {t.n} раз · всего {t.total_s} с</span></span>
            </div>
          ))}
        </div>

        <div className="card" style={card}>
          {head('Место')}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, padding: '4px 0' }}>
            <span style={{ flex: 1 }}>База данных: <b>{size(d.db?.bytes)}</b></span>
            <label style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: 0 }}>лимит тарифа, ГБ <input type="text" inputMode="decimal" value={lim.db || ''} onChange={e => setLimit('db', e.target.value)} style={{ width: 64, padding: '4px 6px', marginLeft: 4 }} /></label>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, padding: '4px 0' }}>
            <span style={{ flex: 1 }}>Файлы: <b>{size(files)}</b></span>
            <label style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: 0 }}>лимит тарифа, ГБ <input type="text" inputMode="decimal" value={lim.files || ''} onChange={e => setLimit('files', e.target.value)} style={{ width: 64, padding: '4px 6px', marginLeft: 4 }} /></label>
          </div>
          {(d.storage || []).map(b => <div key={b.bucket} style={{ fontSize: 11.5, color: 'var(--text-muted)', paddingLeft: 10 }}>{b.bucket}: {size(Number(b.bytes))} · файлов {b.files}</div>)}
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 8 }}>Самые большие таблицы:</div>
          {(d.db?.tables || []).map(t => <div key={t.name} style={{ fontSize: 11.5, color: 'var(--text-muted)', paddingLeft: 10 }}>{PLACE[t.name] ? `${PLACE[t.name]} (${t.name})` : t.name}: {size(Number(t.bytes))}{t.rows > 0 ? ` · ~${t.rows} строк` : ''}</div>)}
          <div style={{ fontSize: 10.5, color: 'var(--text-hint)', marginTop: 6 }}>Лимиты — из вашего тарифа в Supabase (Settings → Billing / Usage). Вписанные здесь — для процентов в «батарейке», на базу они не влияют.</div>
        </div>

        {Array.isArray(d.slow) && d.slow.length > 0 && (
          <div className="card" style={card}>
            {head('Самые тяжёлые запросы в базе (с её перезапуска)')}
            {d.slow.map((s, i) => (
              <div key={i} style={{ fontSize: 11.5, padding: '5px 0', borderTop: '0.5px solid var(--border)' }}>
                <div style={{ display: 'flex', gap: 8 }}><b style={{ flex: 1 }}>в среднем {ms(Number(s.mean_ms))}</b><span style={{ color: 'var(--text-muted)' }}>{s.calls} раз · всего {s.total_s} с</span></div>
                <div style={{ color: 'var(--text-hint)', fontFamily: 'monospace', fontSize: 10.5, wordBreak: 'break-all' }}>{s.q}</div>
              </div>
            ))}
            <div style={{ fontSize: 10.5, color: 'var(--text-hint)', marginTop: 6 }}>Это подсказка разработчику: что оптимизировать в первую очередь. Можно переслать в «Сообщения» скриншотом.</div>
          </div>
        )}
      </>)}
      <BottomNav />
    </div>
  )
}
