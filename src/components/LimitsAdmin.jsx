import Hint from './Hint'
import { useState } from 'react'
import { LIMIT_KEYS, isCap, datePlus, dayStartIso, dmy, ymd } from '../lib/limits'

// Мастер-аккаунт: лимиты бесплатного использования — общие пороги (кабинет клиента и кабинет производства)
// и личные у отдельного пользователя: снять ограничения или поставить свои пороги. Пустое поле — без лимита
// (в общих) или «как у всех» (в личных).
const num = v => { const s = String(v ?? '').trim(); if (s === '') return null; const n = Math.floor(Number(s.replace(',', '.'))); return isFinite(n) && n >= 0 ? n : null }
const GROUPS = [['client', 'Кабинет клиента'], ['production', 'Кабинет производства']]
const TERMS = [['', 'Бессрочно'], ['2w', '2 недели'], ['3w', '3 недели'], ['1m', 'Месяц'], ['date', 'До даты…']]

// Срок: период или своя дата → 'ГГГГ-ММ-ДД' (с этого дня — снова общие лимиты) или '' — бессрочно
function TermPicker({ term, setTerm, date, setDate }) {
  const until = term === 'date' ? date : term ? datePlus(term) : ''
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-muted)' }}>
        <span style={{ flex: '1 1 auto' }}>Срок</span>
        <select value={term} onChange={e => { setTerm(e.target.value); if (e.target.value === 'date' && !date) setDate(datePlus('1m')) }} style={{ padding: '5px 8px', fontSize: 12.5 }}>
          {TERMS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
        </select>
        {term === 'date' && <input type="date" value={date} min={ymd(new Date())} onChange={e => setDate(e.target.value)} style={{ padding: '4px 6px', fontSize: 12.5 }} />}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 2 }}>
        {until ? `Действует до ${dmy(dayStartIso(until))} — с этого дня снова лимиты как у всех.` : 'Без срока — пока не измените сами.'}
      </div>
    </div>
  )
}

const limText = (l, group = 'prod') => LIMIT_KEYS.filter(([k, , c]) => l?.[k] != null && (group === 'prod' || c === 'client')).map(([k, label]) => `${label.split(' (')[0].toLowerCase()} ${l[k]}`).join(' · ') || 'без лимитов'

// group: 'client' — аккаунты без производства (только лимиты клиента); 'prod' — аккаунты со своим производством
// (лимиты и как клиента, и как производства)
export function DefaultLimits({ group = 'client', title, note, defaults, next, onSave, onCancelNext, busy, raised = [], onExpireAll, onFind }) {
  const [v, setV] = useState(() => Object.fromEntries(LIMIT_KEYS.map(([k]) => [k, defaults?.[k] ?? ''])))
  const [allDate, setAllDate] = useState(() => datePlus('1m'))
  // с какого дня новые общие лимиты: сразу или с даты; тем, кому подняты, — тот же день
  const [when, setWhen] = useState('now')
  const [from, setFrom] = useState(() => datePlus('1m'))
  const [withRaised, setWithRaised] = useState(true)
  const save = () => {
    // у клиентов пороги производства не показываются — сохраняются прежними (пока у аккаунтов с производством
    // нет своих лимитов, они берутся отсюда)
    const keep = group === 'prod' ? {} : Object.fromEntries(LIMIT_KEYS.filter(([k, , c]) => c !== 'client' && defaults?.[k] != null).map(([k]) => [k, defaults[k]]))
    const lim = { ...keep, ...Object.fromEntries(LIMIT_KEYS.filter(([, , c]) => group === 'prod' || c === 'client').map(([k]) => [k, num(v[k])]).filter(([, n]) => n != null)) }
    if (when === 'date') {
      if (!from) return
      const at = dayStartIso(from)
      const also = withRaised && raised.length > 0
      if (!window.confirm(`С ${dmy(at)} общие лимиты: ${limText(lim, group)}.${also ? `\nТем, кому подняты лимиты (${raised.length}), — тоже с ${dmy(at)} как у всех.` : ''}\nДо этого дня всё работает как сейчас. Заказы ни у кого не пропадают.`)) return
      onSave(lim, at, also)
    } else onSave(lim, null, false)
  }
  return (
    <details className="card" style={{ marginBottom: 12, padding: '10px 12px' }}>
      <summary style={{ fontSize: 14, fontWeight: 500, cursor: 'pointer' }}>{title || 'Лимиты бесплатного использования'}</summary>
      {note && <div style={{ fontSize: 12, color: 'var(--text-muted)', margin: '6px 0' }}>{note}</div>}
      <Hint>
        Сколько чего может быть у пользователя одновременно: лимит заказов 3 — не больше трёх заказов в кабинете; удалил один — может завести ещё один. Пустое поле — без лимита. На мастер-аккаунт лимиты не действуют; отдельному пользователю их можно снять или повысить — в его карточке ниже.
      </Hint>
      {GROUPS.filter(([g]) => group === 'prod' || g === 'client').map(([g, title]) => (
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
      <div style={{ margin: '4px 0 8px', padding: '8px 10px', background: 'var(--bg2)', borderRadius: 'var(--radius)', fontSize: 12.5 }}>
        <div style={{ fontWeight: 500, marginBottom: 4 }}>Когда действуют эти цифры</div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, cursor: 'pointer' }}>
          <input type="radio" checked={when === 'now'} onChange={() => setWhen('now')} /> Сразу
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', cursor: 'pointer' }}>
          <input type="radio" checked={when === 'date'} onChange={() => setWhen('date')} /> С даты
          {when === 'date' && <input type="date" value={from} min={ymd(new Date())} onChange={e => setFrom(e.target.value)} style={{ padding: '4px 6px', fontSize: 12.5 }} />}
        </label>
        {when === 'date' && (
          <>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '6px 0' }}>
              {[['2w', '2 нед.'], ['3w', '3 нед.'], ['1m', 'Месяц']].map(([k, t]) => (
                <button key={k} type="button" onClick={() => setFrom(datePlus(k))} style={{ padding: '3px 10px', borderRadius: 14, fontSize: 12, border: '0.5px solid var(--border-md)', background: from === datePlus(k) ? 'var(--blue-light)' : 'transparent', color: 'var(--text-muted)' }}>{t}</button>
              ))}
            </div>
            {raised.length > 0 && (
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer', color: 'var(--text-muted)' }}>
                <input type="checkbox" checked={withRaised} onChange={e => setWithRaised(e.target.checked)} style={{ marginTop: 2 }} />
                <span>И тем{group === 'prod' ? ' аккаунтам с производством' : ' клиентам'}, кому подняты лимиты ({raised.length}), — с этого же дня как у всех</span>
              </label>
            )}
            <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 4 }}>
              До {from ? dmy(dayStartIso(from)) : '…'} всё работает по прежним лимитам. Заказы ни у кого не пропадают: что заведено раньше — доделывается.
            </div>
          </>
        )}
      </div>
      <button type="button" className="btn-primary" disabled={busy || (when === 'date' && !from)} onClick={save} style={{ padding: 9, fontSize: 14 }}>
        {when === 'date' ? `Сохранить — с ${from ? dmy(dayStartIso(from)) : '…'}` : 'Сохранить лимиты'}
      </button>
      {next?.at && (
        <div style={{ marginTop: 8, padding: '7px 10px', fontSize: 12, border: '0.5px solid var(--blue)', background: 'var(--blue-light)', borderRadius: 'var(--radius)' }}>
          Запланировано с <b>{dmy(next.at)}</b>: {limText(next.limits, group)}.
          <button type="button" disabled={busy} onClick={() => { if (window.confirm('Отменить запланированные общие лимиты?')) onCancelNext?.() }}
            style={{ marginLeft: 8, padding: '2px 10px', borderRadius: 14, fontSize: 11.5, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--danger)' }}>Отменить</button>
        </div>
      )}
      {onExpireAll && (
        <div style={{ marginTop: 12, paddingTop: 10, borderTop: '0.5px solid var(--border)' }}>
          <div style={{ fontSize: 12.5, fontWeight: 500, marginBottom: 4 }}>Только срок тем, кому подняты лимиты{group === 'prod' ? ' (аккаунты с производством)' : ' (клиенты)'} — общие лимиты не меняются</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-hint)', marginBottom: 6 }}>
            Сейчас поднятые лимиты (или «без ограничений») у {raised.length} польз. С выбранного дня у всех них — снова лимиты как у всех; кому продлить — поставьте новый срок в его карточке.
            Их заказы никуда не деваются: всё, что заведено до этого дня, можно доделать и отправить; новое — только в пределах лимита.
          </div>
          {raised.length > 0 && (
            <div style={{ marginBottom: 8, display: 'flex', flexDirection: 'column', gap: 3 }}>
              {raised.map(r => (
                <button key={r.id} type="button" onClick={() => onFind?.(r.find, r.id)} title="Открыть карточку"
                  style={{ display: 'flex', gap: 6, alignItems: 'baseline', textAlign: 'left', padding: '4px 8px', fontSize: 12, borderRadius: 6, border: '0.5px solid var(--border)', background: 'var(--bg2)', color: 'var(--text)' }}>
                  <span style={{ flex: 1 }}>{r.name}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-hint)', whiteSpace: 'nowrap' }}>
                    {r.data?.unlimited ? 'без ограничений' : 'свои пороги'}{r.data?.expires_at ? ` · до ${dmy(r.data.expires_at)}` : ' · бессрочно'}
                  </span>
                </button>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            {[['2w', '2 нед.'], ['3w', '3 нед.'], ['1m', 'Месяц']].map(([k, t]) => (
              <button key={k} type="button" onClick={() => setAllDate(datePlus(k))} style={{ padding: '4px 10px', borderRadius: 14, fontSize: 12, border: '0.5px solid var(--border-md)', background: allDate === datePlus(k) ? 'var(--blue-light)' : 'transparent', color: 'var(--text-muted)' }}>{t}</button>
            ))}
            <input type="date" value={allDate} min={ymd(new Date())} onChange={e => setAllDate(e.target.value)} style={{ padding: '4px 6px', fontSize: 12.5 }} />
          </div>
          <button type="button" className="btn-secondary" disabled={busy || !raised.length || !allDate} style={{ marginTop: 6, padding: 8, fontSize: 13 }}
            onClick={() => { if (window.confirm(`Поставить срок до ${dmy(dayStartIso(allDate))} всем ${raised.length} польз. с поднятыми лимитами?\nЗаказы у них останутся — доделать и отправить их можно и после этого дня.`)) onExpireAll(dayStartIso(allDate)) }}>
            Поставить срок до {allDate ? dmy(dayStartIso(allDate)) : '…'}
          </button>
        </div>
      )}
    </details>
  )
}

/** Строка лимитов в карточке пользователя: сколько использовано и личные настройки */
export function UserLimits({ u, data, defaults, isProd, onSave, busy }) {
  const [edit, setEdit] = useState(false)
  const [unl, setUnl] = useState(!!data?.unlimited)
  const [v, setV] = useState(() => Object.fromEntries(LIMIT_KEYS.map(([k]) => [k, data?.limits?.[k] ?? ''])))
  // срок: действующий — как был (своя дата); истёкший — по умолчанию месяц
  const [term, setTerm] = useState(() => data?.expires_at && !data?.expired ? 'date' : data?.expired ? '1m' : '')
  const [date, setDate] = useState(() => data?.expires_at && !data?.expired ? ymd(new Date(data.expires_at)) : '')
  if (u.role === 'admin') return <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 4 }}>Мастер-аккаунт — без лимитов</div>
  const keys = LIMIT_KEYS.filter(([, , c]) => c === 'client' || isProd)
  const own = data?.unlimited || Object.keys(data?.limits || {}).length > 0
  const live = own && !data?.expired   // личные настройки действуют (срок не вышел)
  const eff = k => (live && data?.unlimited ? null : live && data?.limits && k in data.limits ? data.limits[k] : defaults?.[k] ?? null)
  const used = k => data?.used?.[k] ?? 0
  const save = async () => {
    const until = term === 'date' ? date : term ? datePlus(term) : ''
    const lim = Object.fromEntries(keys.map(([k]) => [k, num(v[k])]).filter(([, n]) => n != null))
    const r = await onSave(u.id, unl, lim, until && (unl || Object.keys(lim).length) ? dayStartIso(until) : null)
    if (!r?.error) setEdit(false)
  }
  return (
    <div style={{ marginTop: 6, fontSize: 11.5 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ flex: 1, color: 'var(--text-hint)' }}>
          {live && data?.unlimited ? <b style={{ color: 'var(--teal)' }}>Без ограничений</b> : keys.map(([k, label], i) => {
            const lim = eff(k), full = lim != null && used(k) >= lim
            if (isCap(k)) return <span key={k}>{i ? ' · ' : ''}{label.toLowerCase()} <b style={{ color: 'var(--text-muted)' }}>{lim != null ? lim : 'без лимита'}</b></span>
            return <span key={k}>{i ? ' · ' : ''}{label.split(' (')[0].toLowerCase()} <b style={{ color: full ? 'var(--amber)' : 'var(--text-muted)' }}>{used(k)}{lim != null ? ` из ${lim}` : ''}</b></span>
          })}
          {live && !data?.unlimited && <span style={{ color: 'var(--blue)' }}> · свои пороги</span>}
          {live && data?.expires_at && <span style={{ color: 'var(--blue)' }}> до {dmy(data.expires_at)}</span>}
          {own && data?.expired && <span style={{ color: 'var(--amber)' }}> · поднятые лимиты истекли {dmy(data.expires_at)} — сейчас как у всех</span>}
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
          <TermPicker term={term} setTerm={setTerm} date={date} setDate={setDate} />
          <button type="button" className="btn-primary" disabled={busy} onClick={save} style={{ padding: 8, fontSize: 13 }}>Сохранить</button>
        </div>
      )}
    </div>
  )
}
