import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { productionBoard, stageAccept, stageUnaccept, stageDone, startOrderStages, planStages, stageMove, since, clock } from '../lib/posts'
import { ruleOf } from '../lib/stageParts'
import { orderTitle } from '../lib/orderUtils'
import StageParts from './StageParts'
import StageReturn from './StageReturn'
import StageProgress from './StageProgress'
import { OrderOps } from './ProductionPosts'
import CncLoader from './CncLoader'
import PostIcon, { POST_ICONS, iconFromFile } from './PostIcon'
import LabelImageEditor from './LabelImageEditor'
import { savePostRule } from '../lib/stageParts'
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
  const [stamp, setStamp] = useState(null)
  const [ret, setRet] = useState(null)
  const [iconFor, setIconFor] = useState(null)                     // пост, для которого выбирается значок                           // { orderId, title } — выбор поста, на который вернуть
  const [peek, setPeek] = useState(null)                            // мелкая карточка, открытая крупно: { q, idle }
  const [iconImgSrc, setIconImgSrc] = useState(null)               // своя картинка поста: файл — в редактор (убрать фон)
  const iconFileRef = useRef(null)
  // сохранить значок поста: из набора (icon) или свою картинку (iconImg — PNG 96×96)
  const saveIcon = async patch => {
    const p = iconFor
    if (!p) return
    const base = p.rule && p.rule.list ? p.rule : { ...ruleOf(p.rule, p.name), ...(p.rule || {}) }
    const next = { ...base, ...patch }
    if (!next.iconImg) delete next.iconImg
    const { error } = await savePostRule(p.id, next)
    if (error) window.alert(/not allowed/.test(error.message) ? 'Менять значки может руководитель или начальник производства.' : error.message)
    setIconFor(null); load()
  }
  const colRefs = useRef({})
  // галерея: сколько колонок-постов на экране (щипок двумя пальцами или −/+); 0 — компьютер, колонки по ширине
  const [gcols, setGcols] = useKeptState('boardCols', window.innerWidth < 760 ? 1 : 0)
  // вид доски: rows — посты сверху вниз (удобно на телефоне), cols — колонками слева направо (монитор)
  const [layout, setLayout] = useKeptState('boardLayout2', window.innerWidth < 760 ? 'lanes' : 'cols')
  // дорожки: посты значками слева сверху вниз, заказы поста — строкой вправо; щипок / −+ меняют размер карточек (галерея)
  const rows = layout === 'lanes'
  const [cardW, setCardW] = useKeptState('boardCardW', 150)
  const CW = Math.max(72, Math.min(380, Number(cardW) || 150))
  // канбан: удержание карточки — и переносим её пальцем на другой пост
  const [drag, setDrag] = useState(null)          // { q, from, x, y, over }
  const press = useRef(null), dragged = useRef(false), boardRef = useRef(null), dragRef = useRef(null)
  useEffect(() => { dragRef.current = drag }, [drag])
  const load = async () => {
    const r = await productionBoard(prodId)
    if (r.error) { setErr(r.error); setData(d => d || { posts: [], items: [], idle: [] }); return }
    setErr(''); setData(r.data || { posts: [], items: [], idle: [] }); setStamp(new Date())
  }
  useEffect(() => {
    Promise.resolve().then(load)
    const t = setInterval(() => { if (!document.hidden) load() }, 15000)
    const vis = () => { if (!document.hidden) load() }
    document.addEventListener('visibilitychange', vis)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', vis) }
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
  // пока тянем карточку — страница не листается (иначе палец уводит экран, а не заказ)
  useEffect(() => {
    if (!drag) return
    const stop = e => e.preventDefault()
    document.addEventListener('touchmove', stop, { passive: false })
    return () => document.removeEventListener('touchmove', stop)
  }, [!!drag])   // eslint-disable-line react-hooks/exhaustive-deps
  // щипок по доске: пальцы сводим — больше постов на экране (как галерея карт раскроя), разводим — крупнее
  // щипок: пока пальцы на экране — доска плавно масштабируется; отпустили — число постов на экране = во сколько раз свели/развели
  const pinch = useRef(null), pinchAt = useRef(0), fingers = useRef(0)
  // сколько пальцев на экране — считается на всём окне (второй палец отменяет перенос: это щипок)
  useEffect(() => {
    const dn = e => { if (e.pointerType === 'touch') { fingers.current++; if (fingers.current > 1 && press.current) { clearTimeout(press.current.t); press.current = null } } }
    const upf = e => { if (e.pointerType === 'touch') fingers.current = Math.max(0, fingers.current - 1) }
    window.addEventListener('pointerdown', dn, true); window.addEventListener('pointerup', upf, true); window.addEventListener('pointercancel', upf, true)
    return () => { window.removeEventListener('pointerdown', dn, true); window.removeEventListener('pointerup', upf, true); window.removeEventListener('pointercancel', upf, true) }
  }, [])
  const cancelPress = () => { if (press.current) { clearTimeout(press.current.t); press.current = null } }
  const onTouchStart = e => {
    if (e.touches.length >= 2) { cancelPress(); pinchAt.current = Date.now(); if (dragRef.current) { dragged.current = true; setDrag(null) } }   // второй палец — это щипок, не перенос
    if (e.touches.length !== 2 || dragRef.current) return
    const [a, b] = e.touches, el = boardRef.current, r = el.getBoundingClientRect()
    pinch.current = { d0: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1, k: 1, cols: gcols || Math.max(1, Math.round(r.width / 260)) }
    el.style.transformOrigin = `${(a.clientX + b.clientX) / 2 - r.left}px ${(a.clientY + b.clientY) / 2 - r.top}px`
    el.style.transition = 'none'
  }
  const onTouchMove = e => {
    const P = pinch.current
    if (!P || e.touches.length !== 2) return
    const [a, b] = e.touches
    P.k = Math.max(0.25, Math.min(4, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / P.d0))
    boardRef.current.style.transform = `scale(${P.k})`
  }
  const onTouchEnd = e => {
    const P = pinch.current
    if (!P || e.touches.length >= 2) return
    pinch.current = null
    const el = boardRef.current
    el.style.transition = 'transform 160ms ease-out'; el.style.transform = 'scale(1)'
    if (dragRows.current) { setCardW(w => Math.round(Math.max(72, Math.min(380, (Number(w) || 150) * P.k)))); return }   // дорожки: крупнее / мельче карточки
    const next = Math.max(1, Math.min((data?.posts?.length || 0) + 1, Math.round(P.cols / P.k)))
    if (next !== P.cols) setGcols(next)
  }
  const colAt = (x, y) => document.elementFromPoint(x, y)?.closest?.('[data-col]')?.getAttribute('data-col') || null
  const dragProps = (q, from) => ({
    onPointerDown: e => {
      if (!e.isPrimary || fingers.current > 1) { cancelPress(); return }     // два пальца — щипок
      if (e.button > 0 || e.target.closest('button, input, label, a')) return
      if (Date.now() - pinchAt.current < 600) return                         // только что был щипок
      dragged.current = false
      const x = e.clientX, y = e.clientY
      press.current = { x, y, t: setTimeout(() => {
        press.current = null
        if (fingers.current > 1 || Date.now() - pinchAt.current < 600) return
        dragged.current = true
        try { navigator.vibrate?.(30) } catch { /* без вибрации */ }
        setDrag({ q, from, x, y, x0: x, y0: y, over: from })
      }, 800) }
    },
    onPointerMove: e => {
      const p = press.current
      if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 8) { clearTimeout(p.t); press.current = null }
    },
    onPointerUp: () => cancelPress(),
    onPointerCancel: () => cancelPress(),
    onContextMenu: e => e.preventDefault(),
  })
  // щипок увеличивает только доску, не весь экран: браузеру жест двумя пальцами по доске не отдаём
  useEffect(() => {
    const el = boardRef.current
    if (!el) return
    const stop2 = e => { if (e.touches && e.touches.length >= 2) e.preventDefault() }
    const stopG = e => e.preventDefault()
    el.addEventListener('touchstart', stop2, { passive: false })
    el.addEventListener('touchmove', stop2, { passive: false })
    el.addEventListener('gesturestart', stopG); el.addEventListener('gesturechange', stopG)
    return () => { el.removeEventListener('touchstart', stop2); el.removeEventListener('touchmove', stop2); el.removeEventListener('gesturestart', stopG); el.removeEventListener('gesturechange', stopG) }
  }, [!!data])   // eslint-disable-line react-hooks/exhaustive-deps
  const ghostRef = useRef(null)
  const dragRows = useRef(false)
  useEffect(() => { dragRows.current = rows }, [rows])
  useEffect(() => {
    if (!drag) return
    const pos = { x: drag.x, y: drag.y }
    let over = drag.over, raf = 0
    const place = () => { const g = ghostRef.current; if (g) g.style.transform = `translate(${pos.x - 70}px, ${pos.y - 26}px)` }
    // у края экрана доска едет сама — плавно, пока палец там
    const tick = () => {
      const el = boardRef.current
      if (dragRows.current) { const edge = 70; if (pos.y < edge) window.scrollBy(0, -12); else if (pos.y > window.innerHeight - edge) window.scrollBy(0, 12) }
      else if (el) { const r = el.getBoundingClientRect(), edge = 40; if (pos.x < r.left + edge) el.scrollLeft -= 10; else if (pos.x > r.right - edge) el.scrollLeft += 10 }
      const c = colAt(pos.x, pos.y)
      if (c && c !== over) { over = c; setDrag(d => (d ? { ...d, over: c } : d)) }
      raf = requestAnimationFrame(tick)
    }
    const move = e => { pos.x = e.clientX; pos.y = e.clientY; place() }
    // защита от случайного переноса: бросить можно, только если карточку реально увели (≥ 60 px) на другой пост
    const up = () => { cancelAnimationFrame(raf); const d = dragRef.current; setDrag(null); if (d && Math.hypot(pos.x - d.x0, pos.y - d.y0) >= 60) drop({ ...d, over }) }
    place(); raf = requestAnimationFrame(tick)
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up)
    return () => { cancelAnimationFrame(raf); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up) }
  }, [!!drag])   // eslint-disable-line react-hooks/exhaustive-deps
  async function drop(d) {
    const to = d.over, q = d.q
    if (!to || to === d.from) return
    if (to === IDLE) { window.alert('Вернуть в «Принят, не пущен» нельзя — верните заказ на нужный пост.'); return }
    const post = data.posts.find(p => p.id === to)
    const fromIdx = data.posts.findIndex(p => p.id === d.from), toIdx = data.posts.findIndex(p => p.id === to)
    const text = d.from === IDLE ? `Пустить заказ «${orderTitle(q)}» в работу сразу на пост «${post?.name}»?`
      : toIdx < fromIdx ? `Вернуть заказ «${orderTitle(q)}» на пост «${post?.name}»?\nДальше он снова пройдёт посты после него.`
      : `Перенести заказ «${orderTitle(q)}» вперёд на пост «${post?.name}»?\nТекущий пост будет отмечен выполненным, посты между — пропущены.`
    if (!window.confirm(text)) return
    setBusy(q.stage_id || 'o' + q.order_id)
    let r = {}
    if (d.from === IDLE) { r = await startOrderStages(q.order_id); if (!r.error) await planStages(q.order_id) }
    if (!r.error) r = await stageMove(q.order_id, to)
    setBusy('')
    if (r.error) window.alert(r.error)
    else if (r.data === 'no_stage') window.alert(`Пост «${post?.name}» не добавился в маршрут заказа. Выполните migration_stage_move_new_post.sql в Supabase (SQL Editor) — один раз.`)
    await load(); onChange?.(); window.dispatchEvent(new Event('notices-seen'))
  }
  if (!data) return <CncLoader compact label="Загружаем техпроцесс…" />
  const cols = [{ id: IDLE, name: 'Принят, не пущен' }, ...data.posts]
  const byPost = id => (id === IDLE ? data.idle : data.items.filter(q => q.post_id === id))
  const goCol = id => { setTimeout(() => colRefs.current[id]?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: rows ? 'start' : 'nearest' }), 30) }
  // мелко: только названия; совсем мелко (дорожки уже 120 px) — название в одну-две строки и цветная точка состояния.
  // Размер текста — в rem: следует настройке размера шрифта телефона. Тап по мелкой карточке — она крупно поверх доски.
  const tiny = rows && CW < 120
  const compact = rows ? CW < 175 : gcols >= 3                                   // мелко — только названия; тап по заказу — крупно, к его посту
  const maxCols = cols.length
  const btn = kind => ({ padding: '5px 10px', borderRadius: 16, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap',
    border: kind === 'main' || kind === 'ok' ? 'none' : `0.5px solid ${kind === 'warn' ? 'var(--amber)' : kind === 'blue' ? 'var(--blue)' : 'var(--border-md)'}`,
    background: kind === 'main' ? 'var(--blue)' : kind === 'ok' ? 'var(--teal)' : 'transparent',
    color: kind === 'main' || kind === 'ok' ? 'white' : kind === 'warn' ? 'var(--amber)' : kind === 'blue' ? 'var(--blue)' : 'var(--text-muted)' })
  const meta = q => [q.material_name, q.sheets > 0 && `л. ${q.sheets}`, `дет. ${q.parts}`].filter(Boolean).join(' · ')

  const stageCard = (q, full = false) => {
    const isNew = q.status === 'queued', withParts = ruleOf(q.rule, q.post_name).list !== 'none'
    const key = q.stage_id, cmp = compact && !full, tn = tiny && !full
    return (
      <div key={key} className="card" {...(full ? {} : dragProps(q, q.post_id))} style={{ padding: tn ? '4px 6px' : cmp ? '6px 8px' : '8px 10px', borderRadius: tn ? 8 : undefined, border: isNew ? '1px solid var(--amber)' : undefined, opacity: drag?.q === q ? 0.35 : 1, userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' }}>
        <div onClick={() => { if (dragged.current) return; if (cmp) { setPeek({ q, idle: false }); return } navigate(`/orders/${q.order_id}`) }} style={{ cursor: 'pointer' }}>
          {tn ? (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 4 }}>
              <span style={{ flex: '0 0 auto', width: 7, height: 7, borderRadius: '50%', marginTop: '0.3rem', background: isNew ? 'var(--amber)' : 'var(--blue)' }} />
              <span style={{ fontWeight: 500, fontSize: '0.72rem', lineHeight: 1.2, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', wordBreak: 'break-word' }}>{orderTitle(q)}</span>
            </div>
          ) : <>
          <div style={{ fontWeight: 500, fontSize: cmp ? '0.82rem' : 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{orderTitle(q)}</div>
          <div style={{ fontSize: cmp ? '0.7rem' : 11.5, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{q.own ? 'свой заказ' : q.client_name || '—'} · {meta(q)}</div>
          </>}
        </div>
        {!tn && <div style={{ fontSize: cmp ? '0.68rem' : 11, color: isNew ? 'var(--amber)' : 'var(--text-muted)', marginTop: 2, ...(cmp ? { overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' } : {}) }}>
          {isNew ? `Новый · пришёл ${clock(q.queued_at)}, ждёт принятия${q.members?.length ? ` (${q.members.join(', ')})` : ''} · ${since(q.queued_at)}`
            : `Принял ${q.accepted_me ? 'вы' : q.accepted_by || '—'} ${clock(q.accepted_at)} · увидел через ${since(q.queued_at, q.accepted_at)}, в работе ${since(q.accepted_at)}`}
          {q.next_post ? ` → ${q.next_post}` : ' · последний'}
        </div>}
        {!cmp && <StageProgress orderId={q.order_id} rule={q.rule} postName={q.post_name} scanned={q.scanned} onOpen={withParts ? () => setParts({ stage: q, orderId: q.order_id }) : undefined} onSkipped={load} />}
        {!cmp && <div style={{ display: 'flex', gap: 5, marginTop: 6, flexWrap: 'wrap' }}>
          {/* принять — только сотрудники поста (если за постом закреплены); руководитель двигает сам заказ — перетаскиванием */}
          {isNew && q.can_accept !== false && <button type="button" disabled={busy === key} style={btn('main')} onClick={() => act(key, () => stageAccept(key))}>✓ Принять</button>}
          {!isNew && q.can_unaccept && <button type="button" disabled={busy === key} style={btn()} onClick={() => act(key, () => stageUnaccept(key), `Отменить принятие на посту «${q.post_name}»?\nЗаказ снова будет новым на этом посту.`)}>✕ Отменить принятие</button>}
          {!isNew && <button type="button" disabled={busy === key} style={btn('ok')} onClick={() => (withParts ? setParts({ stage: q, orderId: q.order_id })
            : act(key, () => stageDone(key), `Пост «${q.post_name}» выполнен?\n${q.next_post ? `Заказ перейдёт на пост «${q.next_post}».` : 'Это последний пост — заказ будет исполнен.'}`))}>✓ Выполнено</button>}
          {withParts && <button type="button" style={btn('blue')} onClick={() => setParts({ stage: q, orderId: q.order_id })}>📦 Детали</button>}
          {q.has_prev && <button type="button" disabled={busy === key} style={btn('warn')} onClick={() => setRet({ orderId: q.order_id, title: orderTitle(q) })}>↩ Вернуть</button>}
        </div>}
      </div>
    )
  }
  const idleCard = (q, full = false) => {
    const key = 'o' + q.order_id, cmp = compact && !full, tn = tiny && !full
    return (
      <div key={key} className="card" {...(full ? {} : dragProps(q, IDLE))} style={{ padding: tn ? '4px 6px' : cmp ? '6px 8px' : '8px 10px', borderRadius: tn ? 8 : undefined, border: '1px dashed var(--amber)', opacity: drag?.q === q ? 0.35 : 1, userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' }}>
        <div onClick={() => { if (dragged.current) return; if (cmp) { setPeek({ q, idle: true }); return } navigate(`/orders/${q.order_id}`) }} style={{ cursor: 'pointer' }}>
          <div style={{ fontWeight: 500, fontSize: tn ? '0.72rem' : cmp ? '0.82rem' : 14, lineHeight: tn ? 1.2 : undefined, overflow: 'hidden', ...(tn ? { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', wordBreak: 'break-word' } : { textOverflow: 'ellipsis', whiteSpace: 'nowrap' }) }}>{orderTitle(q)}</div>
          {!tn && <div style={{ fontSize: cmp ? '0.7rem' : 11.5, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{q.own ? 'свой заказ' : q.client_name || '—'} · {meta(q)}</div>}
          {!tn && q.accepted_at && <div style={{ fontSize: 11, color: 'var(--text-hint)' }}>принят {clock(q.accepted_at)}</div>}
        </div>
        {!cmp && openOps === q.order_id && <div style={{ marginTop: 6 }}><OrderOps orderId={q.order_id} /></div>}
        {!cmp && <div style={{ display: 'flex', gap: 5, marginTop: 6, flexWrap: 'wrap' }}>
          <button type="button" disabled={busy === key} style={btn('ok')} onClick={() => act(key, async () => { const r = await startOrderStages(q.order_id); if (!r.error) await planStages(q.order_id); return r },
            `Пустить заказ «${orderTitle(q)}» в работу?\nОн встанет на первый пост техпроцесса.`)}>▶ Пустить в работу</button>
          <button type="button" style={btn(openOps === q.order_id ? 'blue' : '')} onClick={() => setOpenOps(v => (v === q.order_id ? '' : q.order_id))}>Операции {openOps === q.order_id ? '▴' : '▾'}</button>
        </div>}
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
        <button type="button" title={rows ? 'Колонками слева направо (удобно на мониторе)' : 'Сверху вниз (удобно на телефоне)'} onClick={() => setLayout(rows ? 'cols' : 'lanes')}
          style={{ flex: '0 0 auto', marginLeft: 'auto', padding: '3px 9px', borderRadius: 14, fontSize: 12, border: '0.5px solid var(--blue)', background: 'transparent', color: 'var(--blue)' }}>{rows ? '⇆ Колонки' : '☰ Дорожки'}</button>
        <span style={{ flex: '0 0 auto', display: 'inline-flex', gap: 3 }}>
          <button type="button" title="Мельче" onClick={() => (rows ? setCardW(w => Math.max(72, Math.round((Number(w) || 150) / 1.25))) : setGcols(c => Math.min(maxCols, (c || 1) + 1)))} style={{ padding: '3px 9px', borderRadius: 14, fontSize: 13, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text-muted)' }}>−</button>
          <button type="button" title="Крупнее" onClick={() => (rows ? setCardW(w => Math.min(380, Math.round((Number(w) || 150) * 1.25))) : setGcols(c => Math.max(1, (c || 2) - 1)))} style={{ padding: '3px 9px', borderRadius: 14, fontSize: 13, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text-muted)' }}>+</button>
        </span>
        <button type="button" onClick={load} title="Обновить" style={{ flex: '0 0 auto', padding: '4px 9px', borderRadius: 14, fontSize: 11.5, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text-muted)' }}>⟳{stamp ? ` ${stamp.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}` : ''}</button>
      </div>
      {!data.posts.length ? (
        <p style={{ fontSize: 13, color: 'var(--text-hint)', padding: '16px 0' }}>Рабочих постов ещё нет. Создайте их во вкладке «⚙ Настройки» → «Рабочие посты»: раскрой, кромление, присадка, сборка…</p>
      ) : !total ? (
        <p style={{ fontSize: 13, color: 'var(--text-hint)', padding: '6px 0 10px' }}>Сейчас в работе заказов нет. Принятые заказы появятся в колонке «Принят, не пущен».</p>
      ) : null}
      {rows ? (
        <div ref={boardRef} onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd} onTouchCancel={onTouchEnd}
          style={{ touchAction: 'pan-x pan-y', display: 'flex', flexDirection: 'column', gap: 6, paddingBottom: 8 }}>
          {cols.map(c => {
            const list = byPost(c.id)
            if (c.id === IDLE && !list.length && data.items.length) return null
            const target = drag && drag.over === c.id && drag.from !== c.id
            return (
              <div key={c.id} ref={el => { colRefs.current[c.id] = el }} data-col={c.id}
                style={{ display: 'flex', alignItems: 'stretch', minHeight: tiny ? 40 : compact ? 64 : 84, gap: tiny ? 4 : 6, borderRadius: 'var(--radius)', background: target ? 'var(--blue-light)' : 'transparent', outline: target ? '2px dashed var(--blue)' : 'none' }}>
                {/* пост — значком слева */}
                <div title={c.name} style={{ flex: `0 0 ${tiny ? 40 : 54}px`, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, padding: '4px 2px', borderRadius: 'var(--radius)', background: 'var(--bg2)' }}>
                  <span onClick={() => c.id !== IDLE && setIconFor(c)} style={{ position: 'relative', lineHeight: 1, color: c.id === IDLE ? 'var(--amber)' : 'var(--blue-dark)', cursor: c.id !== IDLE ? 'pointer' : 'default' }}>{c.id === IDLE ? <span style={{ fontSize: 20 }}>▶</span> : <PostIcon icon={c.rule?.icon} img={c.rule?.iconImg} name={c.name} size={tiny ? 18 : 24} />}
                    {list.length > 0 && <span style={{ position: 'absolute', top: -6, right: -12, minWidth: 16, height: 16, padding: '0 4px', borderRadius: 8, fontSize: 10, fontWeight: 700, lineHeight: '16px', textAlign: 'center', color: 'white', background: c.id === IDLE ? 'var(--amber)' : 'var(--blue)' }}>{list.length}</span>}
                  </span>
                  <span style={{ maxWidth: tiny ? 38 : 52, fontSize: tiny ? 8 : 9.5, lineHeight: 1.15, textAlign: 'center', color: c.id === IDLE ? 'var(--amber)' : 'var(--text-muted)', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: tiny ? 1 : 2, WebkitBoxOrient: 'vertical', wordBreak: 'break-word' }}>{c.id === IDLE ? 'Не пущены' : c.name}</span>
                </div>
                {/* заказы поста — строкой вправо, листаются вбок */}
                <div style={{ flex: 1, minWidth: 0, display: 'flex', gap: tiny ? 4 : 6, overflowX: 'auto', alignItems: 'flex-start', padding: '2px 0', background: 'var(--bg2)', borderRadius: 'var(--radius)', paddingLeft: 4, paddingRight: 4 }}>
                  {list.length ? list.map(q => (
                    <div key={q.stage_id || q.order_id} style={{ flex: `0 0 ${CW}px`, maxWidth: CW, paddingTop: 2, paddingBottom: 2 }}>{c.id === IDLE ? idleCard(q) : stageCard(q)}</div>
                  )) : <div style={{ alignSelf: 'center', fontSize: 11.5, color: 'var(--text-hint)', padding: '0 6px' }}>{drag ? 'сюда' : 'пусто'}</div>}
                </div>
              </div>
            )
          })}
        </div>
      ) : (
      <div ref={boardRef} onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd} onTouchCancel={onTouchEnd}
        style={{ touchAction: 'pan-x pan-y', display: 'flex', gap: gcols >= 3 ? 6 : 10, overflowX: 'auto', scrollSnapType: gcols === 1 && !drag ? 'x mandatory' : 'none', paddingBottom: 8, alignItems: 'flex-start' }}>
        {cols.map(c => {
          const list = byPost(c.id)
          if (c.id === IDLE && !list.length && data.items.length) return null      // пустую «не пущены» прячем, если есть работа
          return (
            <div key={c.id} ref={el => { colRefs.current[c.id] = el }}
              data-col={c.id}
              style={{ flex: gcols ? `0 0 calc((100% - ${(gcols - 1) * (gcols >= 3 ? 6 : 10)}px) / ${gcols})` : '1 0 250px', maxWidth: gcols ? 'none' : 360, minWidth: 0, scrollSnapAlign: 'start',
                background: drag && drag.over === c.id && drag.from !== c.id ? 'var(--blue-light)' : 'var(--bg2)', outline: drag && drag.over === c.id && drag.from !== c.id ? '2px dashed var(--blue)' : 'none',
                borderRadius: 'var(--radius)', padding: compact ? 5 : 8, minHeight: drag ? 200 : 80 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 6 }}>
                <span style={{ fontWeight: 600, fontSize: compact ? 11.5 : 13, color: c.id === IDLE ? 'var(--amber)' : 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{c.id === IDLE ? '▶ ' : compact ? '' : '📍 '}{c.name}</span>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{list.length}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {list.length ? list.map(q => (c.id === IDLE ? idleCard(q) : stageCard(q))) : <div style={{ fontSize: 12, color: 'var(--text-hint)', padding: '6px 2px' }}>пусто</div>}
              </div>
            </div>
          )
        })}
      </div>
      )}
      <p style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 2 }}>Удержите заказ (около секунды) и перенесите пальцем на нужный пост — вперёд или назад. {rows ? 'Заказы поста листаются вбок. Щипок двумя пальцами или −/+ — карточки крупнее или мельче.' : 'Щипок двумя пальцами — больше или меньше постов на экране.'}</p>
      {drag && (
        <div ref={ghostRef} style={{ position: 'fixed', left: 0, top: 0, transform: `translate(${drag.x - 70}px, ${drag.y - 26}px)`, willChange: 'transform', width: 140, zIndex: 500, pointerEvents: 'none', padding: '7px 9px', borderRadius: 10, background: 'var(--bg)', border: '1.5px solid var(--blue)', boxShadow: '0 6px 18px rgba(0,0,0,0.25)', fontSize: 12.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {orderTitle(drag.q)}
          <div style={{ fontSize: 10.5, fontWeight: 400, color: 'var(--blue)' }}>→ {drag.over === IDLE ? 'не пущен' : data.posts.find(p => p.id === drag.over)?.name || '…'}</div>
        </div>
      )}
      {/* мелкая карточка — крупно поверх доски: прочитать и нажать «Принять» / «Выполнено» */}
      {peek && (() => {
        const q = peek.idle ? data.idle.find(x => x.order_id === peek.q.order_id) : data.items.find(x => x.stage_id === peek.q.stage_id)
        if (!q) return null
        return (
          <div onClick={() => setPeek(null)} style={{ position: 'fixed', inset: 0, zIndex: 290, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, animation: 'soft-in .18s ease-out' }}>
            <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 380, animation: 'peek-in .22s cubic-bezier(.32,.72,0,1)' }}>
              <div style={{ fontSize: 11, color: 'white', marginBottom: 4, textShadow: '0 1px 2px rgba(0,0,0,.4)' }}>{peek.idle ? 'Не пущен в работу' : q.post_name}</div>
              {peek.idle ? idleCard(q, true) : stageCard(q, true)}
            </div>
          </div>
        )
      })()}
      {iconFor && !iconImgSrc && (
        <div onClick={() => setIconFor(null)} style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
          <div onClick={e => e.stopPropagation()} className="card" style={{ width: '100%', maxWidth: 460, borderRadius: '16px 16px 0 0', paddingBottom: 'calc(16px + env(safe-area-inset-bottom))' }}>
            <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 8 }}>Значок поста «{iconFor.name}»</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(76px, 1fr))', gap: 6 }}>
              {POST_ICONS.map(([k, label]) => {
                const on = !iconFor.rule?.iconImg && (iconFor.rule?.icon || '') === k
                return (
                  <button key={k} type="button" onClick={() => saveIcon({ icon: k, iconImg: undefined })}
                    style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '8px 4px', borderRadius: 10, cursor: 'pointer',
                      border: `1px solid ${on ? 'var(--blue)' : 'var(--border-md)'}`, background: on ? 'var(--blue-light)' : 'transparent', color: on ? 'var(--blue-dark)' : 'var(--text)' }}>
                    <PostIcon icon={k} size={28} />
                    <span style={{ fontSize: 10, lineHeight: 1.15, color: 'var(--text-muted)', textAlign: 'center' }}>{label}</span>
                  </button>
                )
              })}
              {/* своя картинка с телефона или компьютера: можно убрать фон, сохраняется маленьким значком */}
              <button type="button" onClick={() => iconFileRef.current?.click()}
                style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '8px 4px', borderRadius: 10, cursor: 'pointer',
                  border: `1px ${iconFor.rule?.iconImg ? 'solid var(--blue)' : 'dashed var(--blue)'}`, background: iconFor.rule?.iconImg ? 'var(--blue-light)' : 'transparent', color: 'var(--blue)' }}>
                {iconFor.rule?.iconImg ? <PostIcon img={iconFor.rule.iconImg} size={28} /> : <span style={{ fontSize: 22, lineHeight: '28px' }}>＋</span>}
                <span style={{ fontSize: 10, lineHeight: 1.15, textAlign: 'center' }}>{iconFor.rule?.iconImg ? 'Своя (заменить)' : 'Своя картинка'}</span>
              </button>
            </div>
            <input ref={iconFileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) setIconImgSrc(f) }} />
            <button type="button" className="btn-secondary" style={{ marginTop: 10 }} onClick={() => setIconFor(null)}>Отмена</button>
          </div>
        </div>
      )}
      {iconImgSrc && <LabelImageEditor src={iconImgSrc} onCancel={() => setIconImgSrc(null)}
        onDone={async blob => { setIconImgSrc(null); try { await saveIcon({ icon: 'own', iconImg: await iconFromFile(blob) }) } catch (e) { window.alert(String(e?.message || e)) } }} />}
      {ret && <StageReturn orderId={ret.orderId} title={ret.title} onClose={ch => { setRet(null); if (ch) { load(); onChange?.(); window.dispatchEvent(new Event('notices-seen')) } }} />}
      {parts && <StageParts stage={parts.stage} orderId={parts.orderId} onClose={ch => { setParts(null); if (ch) { load(); onChange?.() } }} />}
    </div>
  )
}
