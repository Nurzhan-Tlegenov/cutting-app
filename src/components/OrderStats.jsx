import { useState } from 'react'
import { money } from '../lib/pricing'

// Статистика заказов производства за период: заявки, что в работе и исполнено, листы, суммы и объёмы работ.
// Используется в кабинете производства (своё) и в мастер-аккаунте (все производства).
export const PERIODS = [['day', 'Сегодня'], ['week', 'Неделя'], ['month', 'Месяц'], ['prev', 'Прошлый месяц'], ['year', 'Год'], ['all', 'Всё время'], ['custom', 'Свои даты']]
export const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const n2 = v => (Math.round((Number(v) || 0) * 100) / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })
const chip = on => ({ flex: '0 0 auto', padding: '5px 10px', fontSize: 12, borderRadius: 14, cursor: 'pointer', border: `0.5px solid ${on ? 'var(--blue)' : 'var(--border-md)'}`, background: on ? 'var(--blue)' : 'transparent', color: on ? 'white' : 'var(--text-muted)' })

export function periodRange(kind, from, to) {
  const now = new Date(), y = now.getFullYear(), m = now.getMonth()
  if (kind === 'day') return [new Date(y, m, now.getDate()), null]
  if (kind === 'week') { const d = new Date(y, m, now.getDate()); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return [d, null] }   // с понедельника
  if (kind === 'month') return [new Date(y, m, 1), null]
  if (kind === 'prev') return [new Date(y, m - 1, 1), new Date(y, m, 1)]
  if (kind === 'year') return [new Date(y, 0, 1), null]
  if (kind === 'custom') return [from ? new Date(from + 'T00:00:00') : null, to ? new Date(new Date(to + 'T00:00:00').getTime() + 864e5) : null]
  return [null, null]
}
// дата, по которой заказ попадает в период: исполнен — когда исполнен, в работе — когда принят, иначе — когда отправлен
export const orderDate = o => new Date((o.status === 'done' && (o.done_at || o.accepted_at)) || ((o.status === 'inwork') && o.accepted_at) || o.submitted_at || o.created_at)
export const isWork = o => o.status === 'inwork' || o.status === 'discussion'

/** Итоги по списку заказов */
export function totals(list) {
  const t = { all: list.length, fresh: 0, work: 0, done: 0, sheetsDone: 0, sheetsWork: 0, parts: 0, noPrice: 0, sumDone: {}, sumWork: {}, st: {} }
  const add = (o, cur, v) => { o[cur] = (o[cur] || 0) + v }
  for (const o of list) {
    const accepted = o.status === 'inwork' || o.status === 'done'
    if (o.status === 'new') t.fresh++
    if (isWork(o)) t.work++
    if (o.status === 'done') { t.done++; t.sheetsDone += o.sheets || 0 }
    if (o.status === 'inwork') t.sheetsWork += o.sheets || 0
    if (!accepted) continue
    t.parts += Number(o.parts) || 0
    if (o.total == null) t.noPrice++
    else add(o.status === 'done' ? t.sumDone : t.sumWork, o.currency || '', Number(o.total) || 0)
    const s = o.stats || {}
    for (const k of ['cut_m', 'edge_thin_m', 'edge_thick_m', 'edge_curved_m', 'holes', 'edge_holes', 'groove_m', 'pockets', 'cutouts', 'shaped_parts']) t.st[k] = (t.st[k] || 0) + (Number(s[k]) || 0)
  }
  return t
}
const sums = o => Object.entries(o).filter(([, v]) => v > 0).map(([cur, v]) => money(v, cur)).join(' + ') || '—'

// Что показывать в итогах — пользователь отмечает галочками (см. Results). По умолчанию — всё.
export const RESULT_ITEMS = [
  ['counts', 'Заявки: всего, новые, в работе, исполнено'],
  ['sumDone', 'Заработано (исполненные заказы)'],
  ['sumWork', 'Сумма заказов в работе'],
  ['sheets', 'Листы'],
  ['parts', 'Детали'],
  ['cut', 'Рез, м'],
  ['edge', 'Кромка, м'],
  ['edgeCurved', 'Криволинейная кромка, м'],
  ['holes', 'Отверстия'],
  ['grooves', 'Пазы, м'],
  ['pockets', 'Выемки'],
  ['cutouts', 'Вырезы'],
  ['shaped', 'Фигурные детали'],
  ['byOrder', 'Раскладка по заказам'],
]
const on = (show, k) => !show || show[k] !== false
/** Объёмы работ из статистики заказа (или суммы по заказам): [[ключ, название, значение, единица]] — только ненулевые и отмеченные */
function works(st, show) {
  const s = st || {}
  return [
    ['cut', 'Рез', Number(s.cut_m) || 0, 'м'],
    ['edge', 'Кромка', (Number(s.edge_thin_m) || 0) + (Number(s.edge_thick_m) || 0), 'м'],
    ['edgeCurved', 'Кромка криволинейная', Number(s.edge_curved_m) || 0, 'м'],
    ['holes', 'Отверстия', (Number(s.holes) || 0) + (Number(s.edge_holes) || 0), 'шт.'],
    ['grooves', 'Пазы', Number(s.groove_m) || 0, 'м'],
    ['pockets', 'Выемки', Number(s.pockets) || 0, 'шт.'],
    ['cutouts', 'Вырезы', Number(s.cutouts) || 0, 'шт.'],
    ['shaped', 'Фигурные детали', Number(s.shaped_parts) || 0, 'шт.'],
  ].filter(r => r[2] > 0 && on(show, r[0]))
}

/** Итоги по списку заказов. show — что показывать ({ ключ: false } — скрыто), см. RESULT_ITEMS */
export function Totals({ t, show }) {
  const rows = [
    on(show, 'sheets') && ['Листы', `${t.sheetsDone + t.sheetsWork}`, `исполнено ${t.sheetsDone} · в работе ${t.sheetsWork}`],
    on(show, 'parts') && t.parts > 0 && ['Детали', n2(t.parts), ''],
    ...works(t.st, show).map(([, l, v, u]) => [l, `${n2(v)} ${u}`, '']),
  ].filter(Boolean)
  return (
    <>
      {on(show, 'counts') && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
          {[['Заявок', t.all], ['Новые', t.fresh], ['В работе', t.work], ['Исполнено', t.done]].map(([l, v]) => (
            <div key={l} style={{ flex: 1, minWidth: 0, textAlign: 'center', background: 'var(--bg2)', borderRadius: 'var(--radius)', padding: '4px 2px' }}>
              <div style={{ fontSize: 15, fontWeight: 600 }}>{v}</div>
              <div style={{ fontSize: 10, color: 'var(--text-hint)' }}>{l}</div>
            </div>
          ))}
        </div>
      )}
      <div style={{ fontSize: 13, lineHeight: 1.6 }}>
        {on(show, 'sumDone') && <div>Заработано (исполнено): <b>{sums(t.sumDone)}</b></div>}
        {on(show, 'sumWork') && <div style={{ color: 'var(--text-muted)' }}>В работе: {sums(t.sumWork)}</div>}
        {t.noPrice > 0 && (on(show, 'sumDone') || on(show, 'sumWork')) && <div style={{ fontSize: 11, color: 'var(--amber)' }}>Без зафиксированной цены: {t.noPrice} — в суммы не вошли</div>}
      </div>
      {rows.length > 0 && (
        <div style={{ marginTop: 6, borderTop: '0.5px solid var(--border)' }}>
          <div style={{ fontSize: 11, color: 'var(--text-hint)', margin: '5px 0 2px' }}>Выполненные работы (принято в работу и исполнено)</div>
          {rows.map(([l, v, note]) => (
            <div key={l} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 13, padding: '2px 0' }}>
              <span style={{ flex: 1, minWidth: 0, color: 'var(--text-muted)' }}>{l}{note && <span style={{ fontSize: 11, color: 'var(--text-hint)' }}> · {note}</span>}</span>
              <b style={{ fontWeight: 500 }}>{v}</b>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

const day = v => new Date(v).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' })
/** Раскладка по заказам: какие работы и на какую сумму сделаны по каждому принятому или исполненному заказу */
export function OrderBreakdown({ list, show, onOpen }) {
  const rows = list.filter(o => o.status === 'done' || o.status === 'inwork').sort((a, b) => orderDate(b) - orderDate(a))
  if (!rows.length) return <p style={{ fontSize: 12, color: 'var(--text-hint)', marginTop: 6 }}>За этот период принятых и исполненных заказов нет.</p>
  const money1 = on(show, 'sumDone') || on(show, 'sumWork')
  return (
    <div style={{ marginTop: 8, borderTop: '0.5px solid var(--border)' }}>
      <div style={{ fontSize: 11, color: 'var(--text-hint)', margin: '5px 0 2px' }}>По заказам · {rows.length}</div>
      {rows.map(o => {
        const parts = [on(show, 'sheets') && `листов ${o.sheets || 0}`, on(show, 'parts') && `деталей ${n2(o.parts)}`, ...works(o.stats, show).map(([, l, v, u]) => `${l.toLowerCase()} ${n2(v)} ${u}`)].filter(Boolean)
        const title = String(o.order_name || '').trim() || o.order_number || 'Заказ'
        return (
          <div key={o.id} onClick={onOpen && !o.deleted ? () => onOpen(o) : undefined} style={{ padding: '6px 0', borderTop: '0.5px solid var(--border)', cursor: onOpen && !o.deleted ? 'pointer' : 'default' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
              {money1 && <b style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap' }}>{o.total != null ? money(o.total, o.currency) : '—'}</b>}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-hint)' }}>
              {day(orderDate(o))} · {o.status === 'done' ? 'исполнен' : 'в работе'}{o.deleted ? ' · заказ удалён заказчиком' : ''}
            </div>
            {parts.length > 0 && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{parts.join(' · ')}</div>}
          </div>
        )
      })}
    </div>
  )
}

/**
 * «Итоги» кабинета производства: свёрнутый блок — период, итоги, раскладка по заказам и настройка, что показывать.
 * list — строки статистики; show / onShow — отмеченные пункты (хранятся в настройках аккаунта); per — usePeriod().
 */
export function Results({ list, per, show, onShow, onOpen }) {
  const [open, setOpen] = useState(() => { try { return sessionStorage.getItem('resultsOpen') === '1' } catch { return false } })
  const [setup, setSetup] = useState(false)
  const toggle = () => setOpen(v => { try { sessionStorage.setItem('resultsOpen', v ? '0' : '1') } catch { /* без памяти */ } return !v })
  const inP = per.inPeriod(list), t = totals(inP)
  const label = PERIODS.find(p => p[0] === per.period)?.[1] || ''
  return (
    <div style={{ marginTop: 8, border: '0.5px solid var(--border-md)', borderRadius: 'var(--radius)' }}>
      <button type="button" onClick={toggle} aria-expanded={open}
        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: 'var(--bg2)', border: 'none', borderRadius: 'var(--radius)', cursor: 'pointer', textAlign: 'left', color: 'var(--text)' }}>
        <span style={{ fontWeight: 500, fontSize: 14 }}>Итоги</span>
        <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {label.toLowerCase()}: исполнено {t.done}{on(show, 'sumDone') && Object.keys(t.sumDone).length ? ` · ${sums(t.sumDone)}` : ''}
        </span>
        <span style={{ color: 'var(--text-hint)', fontSize: 12, transform: open ? 'rotate(180deg)' : 'none' }}>▾</span>
      </button>
      {open && (
        <div style={{ padding: '8px 10px 10px' }}>
          {per.picker}
          <Totals t={t} show={show} />
          {on(show, 'byOrder') && <OrderBreakdown list={inP} show={show} onOpen={onOpen} />}
          <button type="button" onClick={() => setSetup(v => !v)}
            style={{ marginTop: 10, background: 'none', border: 'none', padding: 0, color: 'var(--blue)', fontSize: 12, cursor: 'pointer' }}>⚙ Что показывать в итогах {setup ? '▴' : '▾'}</button>
          {setup && (
            <div style={{ marginTop: 6, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 10px' }}>
              {RESULT_ITEMS.map(([k, l]) => (
                <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer', gridColumn: k === 'counts' || k === 'byOrder' ? '1 / -1' : 'auto' }}>
                  <input type="checkbox" checked={on(show, k)} onChange={e => onShow({ ...(show || {}), [k]: e.target.checked })} style={{ width: 16, height: 16, flex: '0 0 auto' }} />
                  {l}
                </label>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Выбор периода: состояние запоминается под ключом key. -> { period, from, to, inPeriod(list), picker } */
export function usePeriod(key, def = 'month') {
  const keep = (k, d) => { try { return sessionStorage.getItem(key + k) ?? d } catch { return d } }
  const save = (k, v) => { try { sessionStorage.setItem(key + k, v) } catch { /* без памяти */ } }
  const [period, setP] = useState(() => { const p = keep('period', def); return PERIODS.some(x => x[0] === p) ? p : def })
  const [from, setF] = useState(() => keep('from', iso(new Date(new Date().getFullYear(), new Date().getMonth(), 1))))
  const [to, setT] = useState(() => keep('to', iso(new Date())))
  const setPeriod = v => { setP(v); save('period', v) }, setFrom = v => { setF(v); save('from', v) }, setTo = v => { setT(v); save('to', v) }
  const inPeriod = list => { const [a, b] = periodRange(period, from, to); return list.filter(o => { const d = orderDate(o); return (!a || d >= a) && (!b || d < b) }) }
  const picker = (
    <>
      <div style={{ display: 'flex', gap: 6, overflowX: 'auto', marginBottom: 8, paddingBottom: 2 }}>
        {PERIODS.map(([k, label]) => <button key={k} type="button" onClick={() => setPeriod(k)} style={chip(period === k)}>{label}</button>)}
      </div>
      {period === 'custom' && (
        <div className="row2" style={{ marginBottom: 8 }}>
          <div><label className="label">С</label><input type="date" value={from} onChange={e => setFrom(e.target.value)} /></div>
          <div><label className="label">По</label><input type="date" value={to} onChange={e => setTo(e.target.value)} /></div>
        </div>
      )}
    </>
  )
  return { period, from, to, inPeriod, picker }
}
