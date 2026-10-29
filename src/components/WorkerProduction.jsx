import { useEffect, useState } from 'react'
import { useNoticeFocus } from '../lib/noticeNav'
import { useNavigate, useLocation } from 'react-router-dom'
import { productionOrders, productionSetStatus, productionReturnOrder, orderMarks } from '../lib/productionApi'
import { orderFaults, faultText } from '../lib/nestingCheck'
import { limitFromError } from '../lib/limits'
import { STATUS_LABELS, STATUS_BADGE, orderTitle } from '../lib/orderUtils'
import { permsText, workPid, openWorkplace } from '../lib/workplaces'
import { myPostQueue, stageAccept, stageUnaccept, stageDone, since, clock, planStages } from '../lib/posts'
import { StageTrack } from './ProductionPosts'
import StageParts from './StageParts'
import StageReturn from './StageReturn'
import StageProgress from './StageProgress'
import ProductionBoard from './ProductionBoard'
import { ruleOf } from '../lib/stageParts'
import CncLoader from './CncLoader'
import OrderEdge from './OrderEdge'
import { useKeptState } from '../hooks/useKeptState'

// Кабинет производства у сотрудника (своего производства нет, есть рабочие места по приглашению).
// Сотрудник закреплён за рабочими постами: видит заказы, которые сейчас на его постах — новые (принять) и в работе
// (выполнено). «Выполнено» — заказ сам уходит на следующий пост. Начальник производства (all) видит ещё и все заказы.
// Кнопки ЧПУ и бирок — по полномочиям. Цен и итогов здесь нет.
const date = v => (v ? new Date(v).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '')
const FILTERS = [['new', 'Новые'], ['work', 'В работе'], ['all', 'Все']]
const marksOf = o => orderMarks(o).map(m => <span key={m.key} title={m.text} style={{ fontSize: 11, lineHeight: '16px', borderRadius: 9, padding: '0 7px', border: `0.5px solid ${m.on ? 'var(--blue)' : 'var(--border-md)'}`, background: m.on ? 'var(--blue)' : 'transparent', color: m.on ? 'white' : 'var(--text-hint)' }}>{m.short}</span>)

export default function WorkerProduction({ wps }) {
  const navigate = useNavigate()
  const [pid, setPid] = useState(() => { const v = workPid(); return wps.some(w => w.production_id === v) ? v : wps[0].production_id })
  const wp = wps.find(w => w.production_id === pid) || wps[0]
  const perms = wp.perms || {}, chief = !!perms.all
  const can = k => chief || !!perms[k]
  const [queue, setQueue] = useState(null)         // заказы на моих постах
  const [orders, setOrders] = useState(null)       // все заказы — начальнику
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [openIds, setOpenIds] = useKeptState('wOpen', [])
  const open = new Set(openIds)
  const [filter, setFilter] = useKeptState('wFilter', 'work')
  const [wtab, setWtab] = useKeptState('wTab', 'posts')
  const loc = useLocation()
  useEffect(() => { const t = loc.state?.wtab; if (t) Promise.resolve().then(() => setWtab(t)) }, [loc.key])   // eslint-disable-line react-hooks/exhaustive-deps
  useNoticeFocus(() => Promise.resolve().then(() => setFilter('new')))   // по уведомлению: новый заказ на посту — раздел «Новые», строка подсвечена
  const [tick, setTick] = useState(0)
  const [parts, setParts] = useKeptState('wParts', null)       // открыт список деталей поста: { stage, orderId } — после обновления страницы открыт снова
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
  const pick = v => { setPid(v); openWorkplace(v) }

  const stage = async (q, fn, confirmText) => {
    if (confirmText && !window.confirm(confirmText)) return
    setBusy(q.stage_id)
    const r = await fn(q.stage_id)
    setBusy('')
    if (r.error) { setError(r.error); window.alert(r.error) }
    load(); window.dispatchEvent(new Event('notices-seen'))
  }
  // вернуть заказ на любой пройденный пост — выбор поста
  const [ret, setRet] = useState(null)
  const back = q => setRet({ orderId: q.order_id, title: orderTitle(q) })
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
    if (status === 'inwork') await planStages(o.id)          // посты без деталей у заказа — пропустить
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
  const toggle = id => setOpenIds(s => (s.includes(id) ? s.filter(x => x !== id) : [...s, id]))
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
      {/* шапка: производство, имя сотрудника и значок сканера — одной строкой, без лишнего */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {wps.length > 1 ? (
            <select value={pid} onChange={e => pick(e.target.value)} style={{ fontWeight: 600, fontSize: 15, padding: '4px 8px' }}>
              {wps.map(w => <option key={w.production_id} value={w.production_id}>{w.production_name}{w.city ? `, ${w.city}` : ''}</option>)}
            </select>
          ) : <div title={`Доступ: ${permsText(perms)}`} style={{ fontWeight: 600, fontSize: 16, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{wp.production_name}</div>}
        </div>
        <span style={{ flex: '0 1 auto', minWidth: 0, fontSize: 12.5, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{wp.name || ''}</span>
        <button type="button" title={can('stock') ? 'Деловые остатки — склад' : 'Деловые остатки — склад (просмотр)'} onClick={() => navigate(`/stock?p=${wp.production_id}`)}
          style={{ flex: '0 0 auto', height: 34, borderRadius: 17, border: '0.5px solid var(--border-md)', background: 'transparent', fontSize: 12.5, padding: '0 10px', cursor: 'pointer', color: 'var(--text)', whiteSpace: 'nowrap' }}>Остатки</button>
        <button type="button" title="Сканер бирки — деталь в 3D-модели (сборка)" onClick={() => navigate('/scan')}
          style={{ flex: '0 0 auto', width: 36, height: 34, borderRadius: 17, border: '0.5px solid var(--blue)', background: 'var(--blue-light)', fontSize: 16, padding: 0, cursor: 'pointer' }}>📷</button>
      </div>
      {error && <p className="error-text" style={{ marginBottom: 10 }}>{error}</p>}

      {/* начальнику — вкладки: мои посты, доска техпроцесса, все заказы */}
      {chief && (
        <div style={{ display: 'flex', gap: 4, marginBottom: 10, background: 'var(--bg2)', borderRadius: 18, padding: 3 }}>
          {[['posts', `Мои посты${queue?.length ? ` · ${queue.length}` : ''}`], ['board', 'Техпроцесс'], ['orders', 'Все заказы']].map(([k, l]) => (
            <button key={k} type="button" onClick={() => setWtab(k)}
              style={{ flex: 1, padding: '5px 6px', borderRadius: 15, border: 'none', fontSize: 12.5, fontWeight: wtab === k ? 600 : 400, whiteSpace: 'nowrap',
                background: wtab === k ? 'var(--bg)' : 'transparent', color: wtab === k ? 'var(--blue)' : 'var(--text-muted)', boxShadow: wtab === k ? '0 1px 2px rgba(0,0,0,0.12)' : 'none' }}>{l}</button>
          ))}
        </div>
      )}
      {(!chief || wtab === 'posts') && <>
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
                <div key={q.stage_id} data-focus={q.stage_id} className="card" style={{ padding: '9px 12px', border: isNew ? '1px solid var(--amber)' : undefined }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 500, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{orderTitle(q)}</div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{[q.material_name, q.sheets > 0 && `листов ${q.sheets}`, `деталей ${q.parts}`].filter(Boolean).join(' · ')}<OrderEdge orderId={q.order_id} /></div>
                      <div style={{ fontSize: 11.5, color: isNew ? 'var(--amber)' : 'var(--text-muted)' }}>
                        {isNew ? `Новый · пришёл ${clock(q.queued_at)}, ждёт принятия ${since(q.queued_at)}` : `В работе · принял ${q.accepted_me ? 'вы' : q.accepted_by || '—'} ${clock(q.accepted_at)} (увидел через ${since(q.queued_at, q.accepted_at)}), ${since(q.accepted_at)}`}
                        {q.next_post ? ` · дальше: ${q.next_post}` : ' · последний пост'}
                      </div>
                    </div>
                    {'gcode_at' in q && q.gcode_at && <div style={{ display: 'flex', gap: 4 }}>{marksOf(q)}</div>}
                  </div>
                  <StageProgress orderId={q.order_id} rule={q.rule} postName={q.post_name} scanned={q.scanned} onOpen={() => setParts({ stage: q, orderId: q.order_id })} onSkipped={load} />
                  <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                    {isNew && <button type="button" disabled={busy === q.stage_id} style={btn('main')} onClick={() => stage(q, stageAccept)}>✓ Принять</button>}
                    {!isNew && q.accepted_me && <button type="button" disabled={busy === q.stage_id} style={btn()} onClick={() => stage(q, stageUnaccept, `Отменить принятие заказа «${orderTitle(q)}»?\nОн снова будет новым на посту.`)}>✕ Отменить принятие</button>}
                    {ruleOf(q.rule, q.post_name).list !== 'none' && <button type="button" style={{ ...btn(), color: 'var(--blue)', borderColor: 'var(--blue)' }} onClick={() => setParts({ stage: q, orderId: q.order_id })}>📦 Список деталей</button>}
                    {!isNew && <button type="button" disabled={busy === q.stage_id} style={btn('ok')} onClick={() => (ruleOf(q.rule, q.post_name).list !== 'none' ? setParts({ stage: q, orderId: q.order_id })
                      : stage(q, stageDone, `Пост «${q.post_name}» выполнен?\n${q.next_post ? `Заказ перейдёт на пост «${q.next_post}».` : 'Это последний пост — заказ будет исполнен.'}`))}>✓ Выполнено</button>}
                    {orderBtns(q.order_id)}
                    <button type="button" disabled={busy === q.stage_id} style={{ ...btn(), color: 'var(--amber)', borderColor: 'var(--amber)' }} onClick={() => back(q)}>↩ Вернуть на пост</button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ))}

      </>}
      {chief && wtab === 'board' && <ProductionBoard prodId={wp.production_id} onChange={load} />}
      {chief && wtab === 'orders' && <>
      {(
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
                        <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 4, paddingLeft: 18 }}>
                          {[o.sheets > 0 && `Листов: ${o.sheets}`, `деталей: ${o.parts}`].filter(Boolean).join(' · ')}<OrderEdge orderId={o.id} style={{ fontWeight: 600, color: 'var(--text)' }} />
                        </div>
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
      </>}
      {ret && <StageReturn orderId={ret.orderId} title={ret.title} onClose={ch => { setRet(null); if (ch) { load(); window.dispatchEvent(new Event('notices-seen')) } }} />}
      {parts && <StageParts stage={parts.stage} orderId={parts.orderId} onClose={ch => { setParts(null); if (ch) { load(); window.dispatchEvent(new Event('notices-seen')) } }} />}
    </>
  )
}
