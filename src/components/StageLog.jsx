import { useEffect, useState } from 'react'
import { orderStageLog, since, clock } from '../lib/posts'
import { StageTrack } from './ProductionPosts'

// Журнал техпроцесса: как заказ шёл по постам — пришёл на пост, кто принял и через сколько увидел, кто выполнил,
// кто перенёс без принятия, возвраты. Видят руководитель, начальник и сотрудники производства (заказчик — нет).

const KIND = {
  queued: ['var(--amber)', e => `Пришёл на пост «${e.post}»`],
  accepted: ['var(--blue)', (e, p) => `${e.me ? 'Вы приняли' : `Принял ${e.who || '—'}`}${p ? ` · увидел через ${since(p.at, e.at)}` : ''}`],
  unaccepted: ['var(--text-hint)', e => `${e.me ? 'Вы отменили' : `${e.who || '—'} отменил`} принятие`],
  done: ['var(--teal)', (e, p) => `Выполнено · ${e.me ? 'вы' : e.who || '—'}${p ? ` · в работе ${since(p.at, e.at)}` : ''}`],
  passed: ['var(--danger)', e => `Перенесён дальше без принятия · ${e.me ? 'вы' : e.who || '—'}`],
  skipped: ['var(--text-hint)', e => `Пост «${e.post}» пропущен`],
  returned: ['var(--amber)', e => `Возвращён на пост «${e.post}»${e.who ? ` · ${e.me ? 'вы' : e.who}` : ''}`],
}

/** Лента событий. log — [{ kind, post, stage_id, at, who, me }] */
export function StageLogList({ log }) {
  if (!log?.length) return <div style={{ fontSize: 12, color: 'var(--text-hint)' }}>Событий пока нет.</div>
  // для «увидел через» и «в работе» — предыдущее событие того же поста
  const lastOf = {}
  const rows = log.map((e, i) => {
    const head = (i === 0 || log[i - 1].post !== e.post) && e.kind !== 'queued' && e.kind !== 'returned' && e.kind !== 'skipped'
    const k = e.stage_id || e.post
    const prev = lastOf[k]
    const ref = e.kind === 'accepted' ? findQueued(log, e)
      : e.kind === 'done' ? (prev?.kind === 'accepted' ? prev : null) : null
    lastOf[k] = e
    return { e, ref, head }
  })
  return (
    <div style={{ position: 'relative', paddingLeft: 16 }}>
      <div style={{ position: 'absolute', left: 4, top: 6, bottom: 6, width: 1.5, background: 'var(--border-md)' }} />
      {rows.map(({ e, ref, head }, i) => {
        const [color, text] = KIND[e.kind] || ['var(--text-hint)', () => e.kind]
        return (
          <div key={i} style={{ position: 'relative', padding: '3px 0 5px' }}>
            <span style={{ position: 'absolute', left: -15.5, top: 7, width: 9, height: 9, borderRadius: '50%', background: color, border: '2px solid var(--bg)' }} />
            <div style={{ fontSize: 12.5, color: 'var(--text)', lineHeight: 1.35 }}>
              {head && <b style={{ fontWeight: 500 }}>{e.post}: </b>}{text(e, ref)}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-hint)' }}>{clock(e.at)}</div>
          </div>
        )
      })}
    </div>
  )
}
// когда заказ последний раз встал на этот пост (для «увидел через»)
function findQueued(log, e) {
  const k = e.stage_id || e.post
  let q = null
  for (const x of log) { if (x === e) break; if ((x.stage_id || x.post) === k && (x.kind === 'queued' || x.kind === 'returned' || x.kind === 'unaccepted')) q = x }
  return q
}

/** Техпроцесс в карточке заказа: маршрут по постам, принять / отменить, журнал. Заказчику не показывается */
export default function OrderTechProcess({ orderId, status, manage = false }) {
  const [log, setLog] = useState(undefined)            // undefined — загрузка, null — нет доступа
  const [tick, setTick] = useState(0)
  const [open, setOpen] = useState(true)
  useEffect(() => {
    let alive = true
    orderStageLog(orderId).then(r => { if (alive) setLog(r.missing ? [] : r.error ? null : r.data ?? null) })
    return () => { alive = false }
  }, [orderId, tick])
  if (log === undefined || log === null) return null
  if (!log.length && !['inwork', 'done'].includes(status)) return null
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <p className="section-title" style={{ marginBottom: 4 }}>Техпроцесс</p>
      <StageTrack orderId={orderId} status={status} manage={manage} refresh={tick} onChange={() => setTick(t => t + 1)} />
      <div onClick={() => setOpen(v => !v)} style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10, cursor: 'pointer', fontSize: 12.5, fontWeight: 500, color: 'var(--text-muted)' }}>
        История движения{log.length ? ` · ${log.length}` : ''}<span style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .25s' }}>▾</span>
      </div>
      {open && <div style={{ marginTop: 6 }}><StageLogList log={log} /></div>}
    </div>
  )
}
