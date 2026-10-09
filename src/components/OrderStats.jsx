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

export function Totals({ t }) {
  const edge = (t.st.edge_thin_m || 0) + (t.st.edge_thick_m || 0)
  const work = [['Рез', t.st.cut_m, 'м'], ['Кромка', edge, 'м'], ['в т. ч. криволинейная', t.st.edge_curved_m, 'м'], ['Отверстия', (t.st.holes || 0) + (t.st.edge_holes || 0), 'шт.'], ['Пазы', t.st.groove_m, 'м'],
    ['Выемки', t.st.pockets, 'шт.'], ['Вырезы', t.st.cutouts, 'шт.'], ['Фигурные детали', t.st.shaped_parts, 'шт.']].filter(r => r[1] > 0)
  return (
    <>
      <div style={{ display: 'flex', gap: 6 }}>
        {[['Заявок', t.all], ['Новые', t.fresh], ['В работе', t.work], ['Исполнено', t.done]].map(([l, v]) => (
          <div key={l} style={{ flex: 1, minWidth: 0, textAlign: 'center', background: 'var(--bg2)', borderRadius: 'var(--radius)', padding: '4px 2px' }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>{v}</div>
            <div style={{ fontSize: 10, color: 'var(--text-hint)' }}>{l}</div>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 13, marginTop: 6, lineHeight: 1.6 }}>
        <div>Исполнено: <b>{sums(t.sumDone)}</b> · листов <b>{t.sheetsDone}</b></div>
        <div style={{ color: 'var(--text-muted)' }}>В работе: {sums(t.sumWork)} · листов {t.sheetsWork}</div>
        {t.noPrice > 0 && <div style={{ fontSize: 11, color: 'var(--amber)' }}>Без зафиксированной цены: {t.noPrice} — в суммы не вошли</div>}
      </div>
      {work.length > 0 && (
        <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 4 }}>
          Принято в работу и исполнено — деталей {n2(t.parts)}{work.map(([l, v, u]) => ` · ${l.toLowerCase()} ${n2(v)} ${u}`).join('')}
        </div>
      )}
    </>
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
