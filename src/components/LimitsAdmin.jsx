import { useState } from 'react'
import { LIMIT_KEYS } from '../lib/limits'

// Мастер-аккаунт: лимиты бесплатного использования — общие пороги (кабинет клиента и кабинет производства)
// и личные у отдельного пользователя: снять ограничения или поставить свои пороги. Пустое поле — без лимита
// (в общих) или «как у всех» (в личных).
const num = v => { const s = String(v ?? '').trim(); if (s === '') return null; const n = Math.floor(Number(s.replace(',', '.'))); return isFinite(n) && n >= 0 ? n : null }
const GROUPS = [['client', 'Кабинет клиента'], ['production', 'Кабинет производства']]

export function DefaultLimits({ defaults, onSave, busy }) {
  const [v, setV] = useState(() => Object.fromEntries(LIMIT_KEYS.map(([k]) => [k, defaults?.[k] ?? ''])))
  const save = () => onSave(Object.fromEntries(LIMIT_KEYS.map(([k]) => [k, num(v[k])]).filter(([, n]) => n != null)))
  return (
    <details className="card" style={{ marginBottom: 12, padding: '10px 12px' }}>
      <summary style={{ fontSize: 14, fontWeight: 500, cursor: 'pointer' }}>Лимиты бесплатного использования</summary>
      <p style={{ fontSize: 11.5, color: 'var(--text-hint)', margin: '6px 0 8px' }}>
        Сколько чего может быть у пользователя одновременно: лимит заказов 3 — не больше трёх заказов в кабинете; удалил один — может завести ещё один. Пустое поле — без лимита. На мастер-аккаунт лимиты не действуют; отдельному пользователю их можно снять или повысить — в его карточке ниже.
      </p>
      {GROUPS.map(([g, title]) => (
        <div key={g} style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 4 }}>{title}</div>
          {LIMIT_KEYS.filter(([, , c]) => c === g).map(([k, label]) => (
            <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 4 }}>
              <span style={{ flex: 1 }}>{label}</span>
              <input type="text" inputMode="numeric" value={v[k]} placeholder="без лимита" onChange={e => setV(x => ({ ...x, [k]: e.target.value.replace(/[^0-9]/g, '') }))} style={{ width: 96, padding: '5px 8px', fontSize: 13, textAlign: 'center' }} />
            </label>
          ))}
        </div>
      ))}
      <button type="button" className="btn-primary" disabled={busy} onClick={save} style={{ padding: 9, fontSize: 14 }}>Сохранить лимиты</button>
    </details>
  )
}

/** Строка лимитов в карточке пользователя: сколько использовано и личные настройки */
export function UserLimits({ u, data, defaults, isProd, onSave, busy }) {
  const [edit, setEdit] = useState(false)
  const [unl, setUnl] = useState(!!data?.unlimited)
  const [v, setV] = useState(() => Object.fromEntries(LIMIT_KEYS.map(([k]) => [k, data?.limits?.[k] ?? ''])))
  if (u.role === 'admin') return <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 4 }}>Мастер-аккаунт — без лимитов</div>
  const keys = LIMIT_KEYS.filter(([, , c]) => c === 'client' || isProd)
  const eff = k => (data?.unlimited ? null : data?.limits && k in data.limits ? data.limits[k] : defaults?.[k] ?? null)
  const used = k => data?.used?.[k] ?? 0
  const own = data?.unlimited || Object.keys(data?.limits || {}).length > 0
  const save = async () => {
    await onSave(u.id, unl, Object.fromEntries(keys.map(([k]) => [k, num(v[k])]).filter(([, n]) => n != null)))
    setEdit(false)
  }
  return (
    <div style={{ marginTop: 6, fontSize: 11.5 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ flex: 1, color: 'var(--text-hint)' }}>
          {data?.unlimited ? <b style={{ color: 'var(--teal)' }}>Без ограничений</b> : keys.map(([k, label], i) => {
            const lim = eff(k), full = lim != null && used(k) >= lim
            return <span key={k}>{i ? ' · ' : ''}{label.split(' (')[0].toLowerCase()} <b style={{ color: full ? 'var(--amber)' : 'var(--text-muted)' }}>{used(k)}{lim != null ? ` из ${lim}` : ''}</b></span>
          })}
          {own && !data?.unlimited && <span style={{ color: 'var(--blue)' }}> · свои пороги</span>}
        </span>
        <button type="button" onClick={() => setEdit(e => !e)} style={{ padding: '3px 10px', borderRadius: 14, fontSize: 11.5, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text-muted)' }}>{edit ? 'Закрыть' : 'Лимиты'}</button>
      </div>
      {edit && (
        <div style={{ marginTop: 6, padding: '8px 10px', background: 'var(--bg2)', borderRadius: 'var(--radius)' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', marginBottom: 6 }}>
            <input type="checkbox" checked={unl} onChange={e => setUnl(e.target.checked)} style={{ width: 17, height: 17 }} />
            Снять все ограничения
          </label>
          {!unl && keys.map(([k, label]) => (
            <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
              <span style={{ flex: 1 }}>{label}</span>
              <input type="text" inputMode="numeric" value={v[k]} placeholder={defaults?.[k] != null ? `как у всех: ${defaults[k]}` : 'как у всех: без лимита'}
                onChange={e => setV(x => ({ ...x, [k]: e.target.value.replace(/[^0-9]/g, '') }))} style={{ width: 132, padding: '5px 8px', fontSize: 12.5, textAlign: 'center' }} />
            </label>
          ))}
          {!unl && <div style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 6 }}>Пустое поле — как у всех. Чтобы повысить порог, впишите своё число.</div>}
          <button type="button" className="btn-primary" disabled={busy} onClick={save} style={{ padding: 8, fontSize: 13 }}>Сохранить</button>
        </div>
      )}
    </div>
  )
}
