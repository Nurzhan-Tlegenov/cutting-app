import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { productionOrders, productionSetStatus, productionReturnOrder, orderMarks } from '../lib/productionApi'
import { orderFaults, faultText } from '../lib/nestingCheck'
import { limitFromError } from '../lib/limits'
import { STATUS_LABELS, STATUS_BADGE, orderTitle } from '../lib/orderUtils'
import { permsText } from '../lib/workplaces'
import { myPostQueue, stageAccept, stageDone, since, clock } from '../lib/posts'
import { StageTrack } from './ProductionPosts'
import ProductionForm from './ProductionForm'
import CncLoader from './CncLoader'

// Кабинет производства у сотрудника (своего производства нет, есть рабочие места по приглашению).
// Сотрудник закреплён за рабочими постами: видит заказы, которые сейчас на его постах — новые (принять) и в работе
// (выполнено). «Выполнено» — заказ сам уходит на следующий пост. Начальник производства (all) видит ещё и все заказы.
// Кнопки ЧПУ и бирок — по полномочиям. Цен и итогов здесь нет.
const date = v => (v ? new Date(v).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '')
const FILTERS = [['new', 'Новые'], ['work', 'В работе'], ['all', 'Все']]
const marksOf = o => orderMarks(o).map(m => <span key={m.key} title={m.text} style={{ fontSize: 11, lineHeight: '16px', borderRadius: 9, padding: '0 7px', border: `0.5px solid ${m.on ? 'var(--blue)' : 'var(--border-md)'}`, background: m.on ? 'var(--blue)' : 'transparent', color: m.on ? 'white' : 'var(--text-hint)' }}>{m.short}</span>)

export default function WorkerProduction({ wps, onRegister }) {
  const navigate = useNavigate()
  const [pid, setPid] = useState(() => { try { const v = localStorage.getItem('workPid'); return wps.some(w => w.production_id === v) ? v : wps[0].production_id } catch { return wps[0].production_id } })
  const wp = wps.find(w => w.production_id === pid) || wps[0]
  const perms = wp.perms || {}, chief = !!perms.all
  const can = k => chief || !!perms[k]
  const [queue, setQueue] = useState(null)         // заказы на моих постах
  const [orders, setOrders] = useState(null)       // все заказы — начальнику
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [open, setOpen] = useState(() => new Set())
  const [filter, setFilter] = useState('work')
  const [tick, setTick] = useState(0)
  const load = async () => {
    const q = await myPostQueue()
    if (q.error) setError(q.error); else setError('')
    setQueue((q.data || []).filter(x => x.production_id === wp.production_id))
    if (chief) {
      const r = await productionOrders()
      setOrders((r.data || []).filter(o => !o.production_id || o.production_id === wp.production_id))
    }
    setTick(t => t + 1)
  }
  useEffect(() => {
    Promise.resolve().then(load)
    const timer = setInterval(() => { if (!document.hidden) load() }, 45000)   // новые заказы на посту — без перезагрузки
    return () => clearInterval(timer)
  }, [pid])   // eslint-disable-line react-hooks/exhaustive-deps
  const pick = v => { setPid(v); try { localStorage.setItem('workPid', v) } catch { /* без памяти */ } }

  const stage = async (q, fn, confirmText) => {
    if (confirmText && !window.confirm(confirmText)) return
    setBusy(q.stage_id)
    const r = await fn(q.stage_id)
    setBusy('')
    if (r.error) { setError(r.error); window.alert(r.error) }
    load(); window.dispatchEvent(new Event('notices-seen'))
  }
  const setStatus = async (o, status) => {
    if (status === 'inwork') {
      const f = await orderFaults(o.id)
      if (f.length) { window.alert(faultText(f, 'Принять такой заказ в работу нельзя. Откройте заказ и исправьте раскрой или верните заказ на доработку.')); return }
    }
    if (status === 'done' && !window.confirm(`Заказ «${orderTitle(o)}» исполнен целиком?\nОн уйдёт из списка производства.`)) return
    setBusy(o.id)
    const r = await productionSetStatus(o.id, status)
    setBusy('')
    const lim = r.error && limitFromError(r.error)
    if (lim) { window.alert(lim.text); return }
    if (r.error) { setError(r.error); return }
    load()
  }
  const returnOrder = async o => {
    const note = window.prompt(`Вернуть заказ «${orderTitle(o)}» заказчику на доработку?\nЧто нужно поправить:`, '')
    if (note === null) return
    setBusy(o.id)
    const r = await productionReturnOrder(o.id, note)
    setBusy('')
    if (r.error) setError(r.error); else load()
  }
  const toggle = id => setOpen(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const btn = kind => ({ padding: '6px 12px', borderRadius: 20, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap', border: kind === 'main' ? 'none' : '0.5px solid var(--border-md)', background: kind === 'main' ? 'var(--blue)' : kind === 'ok' ? 'var(--teal)' : 'transparent', color: kind === 'main' || kind === 'ok' ? 'white' : 'var(--text-muted)', ...(kind === 'ok' ? { border: 'none' } : {}) })
  const orderBtns = id => (
    <>
      <button type="button" style={btn()} onClick={() => navigate(`/orders/${id}`)}>Открыть</button>
      {can('cnc') && <button type="button" style={btn()} onClick={() => navigate(`/orders/${id}/cnc`)}>ЧПУ</button>}
      {can('labels') && <button type="button" style={btn()} onClick={() => navigate(`/orders/${id}/labels`)}>Бирки</button>}
    </>
  )

  // очередь по постам: сначала новые (принять), затем в работе
  const posts = [...new Map((queue || []).map(q => [q.post_id, q.post_name])).entries()]
  const live = (orders || []).filter(o => o.status !== 'done')
  const shown = live.filter(o => filter === 'all' || (filter === 'new' ? o.status === 'new' : o.status === 'discussion' || o.status === 'inwork'))
  return (
    <>
      <div className="card" style={{ marginBottom: 12 }}>
        {wps.length > 1 ? (
          <select value={pid} onChange={e => pick(e.target.value)} style={{ marginBottom: 6, fontWeight: 500 }}>
            {wps.map(w => <option key={w.production_id} value={w.production_id}>{w.production_name}{w.city ? `, ${w.city}` : ''}</option>)}
          </select>
        ) : <div style={{ fontWeight: 500, fontSize: 16 }}>{wp.production_name}</div>}
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Ваше рабочее место: <b style={{ fontWeight: 500 }}>{wp.name || 'сотрудник'}</b></div>
        <div style={{ fontSize: 11.5, color: 'var(--text-hint)' }}>Доступ: {permsText(perms)}{wp.owner_name ? ` · руководитель: ${wp.owner_name}` : ''}</div>
      </div>
      {error && <p className="error-text" style={{ marginBottom: 10 }}>{error}</p>}

      <p className="section-title">Мои посты{queue?.length ? ` · ${queue.length}` : ''}</p>
      {queue === null ? <CncLoader compact label="Загружаем заказы…" /> : !queue.length ? (
        <p style={{ fontSize: 13, color: 'var(--text-hint)', textAlign: 'center', padding: '18px 0' }}>На ваших постах сейчас нет заказов. Когда заказ дойдёт до вашего поста, он появится здесь, придёт уведомление.</p>
      ) : posts.map(([postId, postName]) => (
        <div key={postId} style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--blue)', margin: '2px 0 5px' }}>📍 {postName}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {queue.filter(q => q.post_id === postId).map(q => {
              const isNew = q.status === 'queued'
              return (
                <div key={q.stage_id} className="card" style={{ padding: '9px 12px', border: isNew ? '1px solid var(--amber)' : undefined }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 500, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{orderTitle(q)}</div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{[q.material_name, q.sheets > 0 && `листов ${q.sheets}`, `деталей ${q.parts}`].filter(Boolean).join(' · ')}</div>
                      <div style={{ fontSize: 11.5, color: isNew ? 'var(--amber)' : 'var(--text-muted)' }}>
                        {isNew ? `Новый · пришёл ${clock(q.queued_at)}, ждёт ${since(q.queued_at)}` : `В работе · принял ${q.accepted_me ? 'вы' : q.accepted_by || '—'} ${clock(q.accepted_at)}, ${since(q.accepted_at)}`}
                        {q.next_post ? ` · дальше: ${q.next_post}` : ' · последний пост'}
                      </div>
                    </div>
                    {'gcode_at' in q && q.gcode_at && <div style={{ display: 'flex', gap: 4 }}>{marksOf(q)}</div>}
                  </div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                    {isNew
                      ? <button type="button" disabled={busy === q.stage_id} style={btn('main')} onClick={() => stage(q, stageAccept)}>✓ Принять</button>
                      : <button type="button" disabled={busy === q.stage_id} style={btn('ok')} onClick={() => stage(q, stageDone, `Пост «${q.post_name}» выполнен?\n${q.next_post ? `Заказ перейдёт на пост «${q.next_post}».` : 'Это последний пост — заказ будет исполнен.'}`)}>✓ Выполнено</button>}
                    {orderBtns(q.order_id)}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ))}

      {chief && (
        <>
          <p className="section-title" style={{ marginTop: 14 }}>Все заказы производства</p>
          <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            {FILTERS.map(([id, label]) => {
              const n = live.filter(o => id === 'all' || (id === 'new' ? o.status === 'new' : o.status === 'discussion' || o.status === 'inwork')).length
              return <button key={id} type="button" onClick={() => setFilter(id)} style={{ flex: 1, padding: '7px 4px', borderRadius: 20, border: 'none', fontSize: 12, background: filter === id ? 'var(--blue)' : 'var(--bg2)', color: filter === id ? 'white' : 'var(--text-muted)' }}>{label}{n ? ` · ${n}` : ''}</button>
            })}
          </div>
          {orders === null ? <CncLoader compact label="Загружаем заказы…" /> : !shown.length ? <p style={{ fontSize: 13, color: 'var(--text-hint)', textAlign: 'center', padding: '18px 0' }}>В этом разделе пусто.</p> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {shown.map(o => {
                const isOpen = open.has(o.id)
                return (
                  <div key={o.id} className="card" style={{ padding: isOpen ? '8px 12px 10px' : '7px 12px' }}>
                    <div onClick={() => toggle(o.id)} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
                      <span style={{ width: 10, fontSize: 11, lineHeight: '20px', color: 'var(--text-hint)' }}>{isOpen ? '▾' : '▸'}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 500, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{orderTitle(o)}</div>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{[o.material_name, o.sheets > 0 && `листов ${o.sheets}`, `деталей ${o.parts}`, date(o.submitted_at)].filter(Boolean).join(' · ')}</div>
                        {o.client_name && <div style={{ fontSize: 12 }}>{o.client_name}{o.client_phone ? ` · ${o.client_phone}` : ''}</div>}
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
                        <span className={`badge ${STATUS_BADGE[o.status] || 'badge-new'}`}>{STATUS_LABELS[o.status] || o.status}</span>
                        {'gcode_at' in o && (o.status === 'inwork' || o.gcode_at) && <div style={{ display: 'flex', gap: 4 }}>{marksOf(o)}</div>}
                      </div>
                    </div>
                    {isOpen && (
                      <>
                        <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                          {o.status !== 'inwork' && <button type="button" disabled={busy === o.id} style={btn('main')} onClick={() => setStatus(o, 'inwork')}>✓ Принять в работу</button>}
                          {orderBtns(o.id)}
                          <button type="button" disabled={busy === o.id} style={{ ...btn(), color: 'var(--amber)', borderColor: 'var(--amber)' }} onClick={() => returnOrder(o)}>↩ На доработку</button>
                        </div>
                        <StageTrack orderId={o.id} status={o.status} manage refresh={tick} onChange={load} />
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}
      <details className="card" style={{ marginTop: 16, padding: '10px 12px' }}>
        <summary style={{ fontSize: 12.5, color: 'var(--text-muted)', cursor: 'pointer' }}>У вас есть и своё производство? Зарегистрировать</summary>
        <div style={{ marginTop: 8 }}><ProductionForm onDone={onRegister} /></div>
      </details>
    </>
  )
}
