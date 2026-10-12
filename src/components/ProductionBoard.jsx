import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { productionBoard, stageAccept, stageDone, startOrderStages, planStages, since, clock } from '../lib/posts'
import { ruleOf } from '../lib/stageParts'
import { orderTitle } from '../lib/orderUtils'
import StageParts from './StageParts'
import StageReturn from './StageReturn'
import StageProgress from './StageProgress'
import { OrderOps } from './ProductionPosts'
import CncLoader from './CncLoader'
import { useKeptState } from '../hooks/useKeptState'

// Доска техпроцесса: колонка на каждый пост (в порядке техпроцесса) и первая — «Принят, не пущен».
// Видно, какой заказ на каком посту; отсюда же принять на посту, «Выполнено», вернуть на предыдущий пост, пустить в работу.
// Обновляется сама каждые 15 с — заказы переходят по колонкам почти в реальном времени.
// Телефон — колонки листаются пальцем вбок (по одной на экран), сверху — переход к посту; компьютер — колонки рядом.
const IDLE = '__idle'

export default function ProductionBoard({ prodId = null, onChange }) {
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  const [parts, setParts] = useKeptState('boardParts', null)    // { stage, orderId } — открыт список деталей поста
  const [openOps, setOpenOps] = useState('')                     // у какого «не пущенного» заказа раскрыты операции
  const [narrow, setNarrow] = useState(() => window.innerWidth < 760)
  const [stamp, setStamp] = useState(null)
  const [ret, setRet] = useState(null)                           // { orderId, title } — выбор поста, на который вернуть
  const colRefs = useRef({})
  const load = async () => {
    const r = await productionBoard(prodId)
    if (r.error) { setErr(r.error); setData(d => d || { posts: [], items: [], idle: [] }); return }
    setErr(''); setData(r.data || { posts: [], items: [], idle: [] }); setStamp(new Date())
  }
  useEffect(() => {
    Promise.resolve().then(load)
    const t = setInterval(() => { if (!document.hidden) load() }, 15000)
    const vis = () => { if (!document.hidden) load() }
    const rs = () => setNarrow(window.innerWidth < 760)
    document.addEventListener('visibilitychange', vis); window.addEventListener('resize', rs)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', vis); window.removeEventListener('resize', rs) }
  }, [prodId])   // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (key, fn, confirmText) => {
    if (confirmText && !window.confirm(confirmText)) return
    setBusy(key)
    const r = await fn()
    setBusy('')
    if (r?.error) window.alert(r.error)
    else if (r?.data === false) window.alert('Это первый пост заказа — возвращать некуда.')
    await load(); onChange?.(); window.dispatchEvent(new Event('notices-seen'))
  }
  if (!data) return <CncLoader compact label="Загружаем техпроцесс…" />
  const cols = [{ id: IDLE, name: 'Принят, не пущен' }, ...data.posts]
  const byPost = id => (id === IDLE ? data.idle : data.items.filter(q => q.post_id === id))
  const goCol = id => colRefs.current[id]?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' })
  const btn = kind => ({ padding: '5px 10px', borderRadius: 16, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap',
    border: kind === 'main' || kind === 'ok' ? 'none' : `0.5px solid ${kind === 'warn' ? 'var(--amber)' : kind === 'blue' ? 'var(--blue)' : 'var(--border-md)'}`,
    background: kind === 'main' ? 'var(--blue)' : kind === 'ok' ? 'var(--teal)' : 'transparent',
    color: kind === 'main' || kind === 'ok' ? 'white' : kind === 'warn' ? 'var(--amber)' : kind === 'blue' ? 'var(--blue)' : 'var(--text-muted)' })
  const meta = q => [q.material_name, q.sheets > 0 && `л. ${q.sheets}`, `дет. ${q.parts}`].filter(Boolean).join(' · ')

  const stageCard = q => {
    const isNew = q.status === 'queued', withParts = ruleOf(q.rule, q.post_name).list !== 'none'
    const key = q.stage_id
    return (
      <div key={key} className="card" style={{ padding: '8px 10px', border: isNew ? '1px solid var(--amber)' : undefined }}>
        <div onClick={() => navigate(`/orders/${q.order_id}`)} style={{ cursor: 'pointer' }}>
          <div style={{ fontWeight: 500, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{orderTitle(q)}</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{q.own ? 'свой заказ' : q.client_name || '—'} · {meta(q)}</div>
        </div>
        <div style={{ fontSize: 11, color: isNew ? 'var(--amber)' : 'var(--text-muted)', marginTop: 2 }}>
          {isNew ? `Новый · пришёл ${clock(q.queued_at)}, ждёт ${since(q.queued_at)}` : `В работе · принял ${q.accepted_me ? 'вы' : q.accepted_by || '—'} ${clock(q.accepted_at)}, идёт ${since(q.accepted_at)}`}
          {q.next_post ? ` → ${q.next_post}` : ' · последний'}
        </div>
        <StageProgress orderId={q.order_id} rule={q.rule} postName={q.post_name} scanned={q.scanned} onOpen={withParts ? () => setParts({ stage: q, orderId: q.order_id }) : undefined} onSkipped={load} />
        <div style={{ display: 'flex', gap: 5, marginTop: 6, flexWrap: 'wrap' }}>
          {isNew && <button type="button" disabled={busy === key} style={btn('main')} onClick={() => act(key, () => stageAccept(key))}>✓ Принять</button>}
          {!isNew && <button type="button" disabled={busy === key} style={btn('ok')} onClick={() => (withParts ? setParts({ stage: q, orderId: q.order_id })
            : act(key, () => stageDone(key), `Пост «${q.post_name}» выполнен?\n${q.next_post ? `Заказ перейдёт на пост «${q.next_post}».` : 'Это последний пост — заказ будет исполнен.'}`))}>✓ Выполнено</button>}
          {withParts && <button type="button" style={btn('blue')} onClick={() => setParts({ stage: q, orderId: q.order_id })}>📦 Детали</button>}
          {q.has_prev && <button type="button" disabled={busy === key} style={btn('warn')} onClick={() => setRet({ orderId: q.order_id, title: orderTitle(q) })}>↩ Вернуть</button>}
        </div>
      </div>
    )
  }
  const idleCard = q => {
    const key = 'o' + q.order_id
    return (
      <div key={key} className="card" style={{ padding: '8px 10px', border: '1px dashed var(--amber)' }}>
        <div onClick={() => navigate(`/orders/${q.order_id}`)} style={{ cursor: 'pointer' }}>
          <div style={{ fontWeight: 500, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{orderTitle(q)}</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{q.own ? 'свой заказ' : q.client_name || '—'} · {meta(q)}</div>
          {q.accepted_at && <div style={{ fontSize: 11, color: 'var(--text-hint)' }}>принят {clock(q.accepted_at)}</div>}
        </div>
        {openOps === q.order_id && <div style={{ marginTop: 6 }}><OrderOps orderId={q.order_id} /></div>}
        <div style={{ display: 'flex', gap: 5, marginTop: 6, flexWrap: 'wrap' }}>
          <button type="button" disabled={busy === key} style={btn('ok')} onClick={() => act(key, async () => { const r = await startOrderStages(q.order_id); if (!r.error) await planStages(q.order_id); return r },
            `Пустить заказ «${orderTitle(q)}» в работу?\nОн встанет на первый пост техпроцесса.`)}>▶ Пустить в работу</button>
          <button type="button" style={btn(openOps === q.order_id ? 'blue' : '')} onClick={() => setOpenOps(v => (v === q.order_id ? '' : q.order_id))}>Операции {openOps === q.order_id ? '▴' : '▾'}</button>
        </div>
      </div>
    )
  }

  const total = data.items.length + data.idle.length
  return (
    <div>
      {err && <p style={{ fontSize: 12, color: 'var(--amber)', marginBottom: 8 }}>{err}</p>}
      {/* переход к посту: на телефоне колонки листаются вбок, этой строкой — сразу к нужной */}
      <div style={{ display: 'flex', gap: 5, overflowX: 'auto', paddingBottom: 4, marginBottom: 6 }}>
        {cols.map(c => {
          const n = byPost(c.id).length
          return <button key={c.id} type="button" onClick={() => goCol(c.id)}
            style={{ flex: '0 0 auto', padding: '4px 9px', borderRadius: 14, fontSize: 11.5, border: `0.5px solid ${n ? (c.id === IDLE ? 'var(--amber)' : 'var(--blue)') : 'var(--border-md)'}`,
              background: 'transparent', color: n ? (c.id === IDLE ? 'var(--amber)' : 'var(--blue)') : 'var(--text-hint)', whiteSpace: 'nowrap' }}>{c.id === IDLE ? '▶ Не пущены' : c.name} · {n}</button>
        })}
        <button type="button" onClick={load} title="Обновить" style={{ flex: '0 0 auto', marginLeft: 'auto', padding: '4px 9px', borderRadius: 14, fontSize: 11.5, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text-muted)' }}>⟳{stamp ? ` ${stamp.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}` : ''}</button>
      </div>
      {!data.posts.length ? (
        <p style={{ fontSize: 13, color: 'var(--text-hint)', padding: '16px 0' }}>Рабочих постов ещё нет. Создайте их во вкладке «⚙ Настройки» → «Рабочие посты»: раскрой, кромление, присадка, сборка…</p>
      ) : !total ? (
        <p style={{ fontSize: 13, color: 'var(--text-hint)', padding: '6px 0 10px' }}>Сейчас в работе заказов нет. Принятые заказы появятся в колонке «Принят, не пущен».</p>
      ) : null}
      <div style={{ display: 'flex', gap: 10, overflowX: 'auto', scrollSnapType: narrow ? 'x mandatory' : 'none', paddingBottom: 8, alignItems: 'flex-start' }}>
        {cols.map(c => {
          const list = byPost(c.id)
          if (c.id === IDLE && !list.length && data.items.length) return null      // пустую «не пущены» прячем, если есть работа
          return (
            <div key={c.id} ref={el => { colRefs.current[c.id] = el }}
              style={{ flex: narrow ? '0 0 86%' : '1 0 250px', maxWidth: narrow ? 'none' : 360, scrollSnapAlign: 'start', background: 'var(--bg2)', borderRadius: 'var(--radius)', padding: 8, minHeight: 80 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 6 }}>
                <span style={{ fontWeight: 600, fontSize: 13, color: c.id === IDLE ? 'var(--amber)' : 'var(--text)' }}>{c.id === IDLE ? '▶ ' : '📍 '}{c.name}</span>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{list.length}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {list.length ? list.map(q => (c.id === IDLE ? idleCard(q) : stageCard(q))) : <div style={{ fontSize: 12, color: 'var(--text-hint)', padding: '6px 2px' }}>пусто</div>}
              </div>
            </div>
          )
        })}
      </div>
      {ret && <StageReturn orderId={ret.orderId} title={ret.title} onClose={ch => { setRet(null); if (ch) { load(); onChange?.(); window.dispatchEvent(new Event('notices-seen')) } }} />}
      {parts && <StageParts stage={parts.stage} orderId={parts.orderId} onClose={ch => { setParts(null); if (ch) { load(); onChange?.() } }} />}
    </div>
  )
}
