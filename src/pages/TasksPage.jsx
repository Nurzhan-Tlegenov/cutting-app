// Мои задачи — канбан клиента: свои этапы (замер, закуп материала, …), карточки-задачи с подзадачами (галочки и
// индикатор «3 из 5»), сроком и напоминанием, связью с заказом (создать заказ из задачи или привязать готовый).
// Карточку переносят на другой этап: удержать палец ~0,5 с и вести (мышью — просто тянуть).
// Видит только сам пользователь; мастер-аккаунт открывает доску любого пользователя только для чтения (?u=<id>).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { MenuButton } from '../components/NavDrawer'
import BottomNav from '../components/BottomNav'
import { useBackClose } from '../lib/backStack'
import { useDesktop } from '../hooks/useDesktop'
import { sendState, orderTitle } from '../lib/orderUtils'
import {
  loadBoard, addColumn, updateColumn, deleteColumn, addCard, updateCard, deleteCard, myOrders, ordersByIds,
  progress, dueInfo, newItemId, toLocalInput, fromLocalInput, COLORS,
} from '../lib/tasks'

const TONE = { late: ['var(--danger)', 'var(--danger-light)'], today: ['var(--amber)', 'var(--amber-light)'], soon: ['var(--blue)', 'var(--blue-light)'], '': ['var(--text-muted)', 'var(--bg2)'] }
const chip = (fg, bg) => ({ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11.5, padding: '2px 7px', borderRadius: 10, color: fg, background: bg, whiteSpace: 'nowrap' })
const iconBtn = { width: 30, height: 30, borderRadius: 15, border: 'none', background: 'transparent', color: 'var(--text-hint)', padding: 0, cursor: 'pointer', fontSize: 16, flexShrink: 0 }
const between = (a, b) => (a == null && b == null ? 1 : a == null ? b - 1 : b == null ? a + 1 : (a + b) / 2)

/** Индикатор подзадач: полоска + «3/5» */
function Progress({ done, total, big }) {
  if (!total) return null
  const all = done === total
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: big ? 4 : 6 }}>
      <div style={{ flex: 1, height: big ? 6 : 4, borderRadius: 3, background: 'var(--bg2)', overflow: 'hidden' }}>
        <div style={{ width: `${(done / total) * 100}%`, height: '100%', background: all ? 'var(--teal)' : 'var(--blue)', transition: 'width .25s' }} />
      </div>
      <span style={{ fontSize: 11.5, color: all ? 'var(--teal)' : 'var(--text-muted)', fontWeight: 600 }}>{all ? '✓ ' : ''}{done}/{total}</span>
    </div>
  )
}

export default function TasksPage() {
  const { user, isMaster } = useAuth()
  const navigate = useNavigate()
  const { search } = useLocation()
  const qs = useMemo(() => new URLSearchParams(search), [search])
  const viewUser = isMaster && qs.get('u') ? qs.get('u') : user?.id
  const readOnly = viewUser !== user?.id
  const [cols, setCols] = useState(null)
  const [cards, setCards] = useState([])
  const [orders, setOrders] = useState(new Map())
  const [error, setError] = useState('')
  const [showDone, setShowDone] = useState(() => { try { return localStorage.getItem('tasksShowDone') === '1' } catch { return false } })
  const [openId, setOpenId] = useState(qs.get('card'))
  // вид доски, как у техпроцесса: дорожки (этапы сверху вниз, задачи строкой вправо) или колонки слева направо
  const [layout, setLayoutRaw] = useState(() => { try { return localStorage.getItem('tasksLayout') || 'lanes' } catch { return 'lanes' } })
  const setLayout = v => { setLayoutRaw(v); try { localStorage.setItem('tasksLayout', v) } catch { /* без памяти */ } }
  const lanes = layout === 'lanes'
  const [cardW, setCardWRaw] = useState(() => { try { return Number(localStorage.getItem('tasksCardW')) || (window.innerWidth < 760 ? 180 : 230) } catch { return 180 } })
  const setCardW = f => setCardWRaw(w => { const v = Math.max(150, Math.min(400, Math.round(f(w)))); try { localStorage.setItem('tasksCardW', String(v)) } catch { /* без памяти */ } return v })
  const CW = cardW
  const desk = useDesktop()
  const [drag, setDrag] = useState(null)              // { card, x, y, x0, y0, over, idx }
  const boardRef = useRef(null), press = useRef(null), dragged = useRef(false), dragRef = useRef(null), ghostRef = useRef(null)
  useEffect(() => { dragRef.current = drag }, [drag])

  const load = useCallback(async () => {
    if (!viewUser) return
    const r = await loadBoard(viewUser, !readOnly)
    if (r.error) { setError(r.error); setCols([]); return }
    setError(''); setCols(r.columns); setCards(r.cards)
    const ids = [...new Set(r.cards.map(c => c.order_id).filter(Boolean))]
    const os = await ordersByIds(ids)
    setOrders(new Map(os.map(o => [o.id, o])))
  }, [viewUser, readOnly])
  useEffect(() => { Promise.resolve().then(load) }, [load])
  useEffect(() => { const c = qs.get('card'); if (c) Promise.resolve().then(() => setOpenId(c)) }, [qs])
  // вернулись из бланка заказа или вкладка снова на экране — статусы заказов могли поменяться
  useEffect(() => { const on = () => { if (document.visibilityState === 'visible') load() }; document.addEventListener('visibilitychange', on); return () => document.removeEventListener('visibilitychange', on) }, [load])

  const byCol = useMemo(() => {
    const m = new Map((cols || []).map(c => [c.id, []]))
    const first = cols?.[0]?.id
    for (const k of cards) {
      if (!showDone && k.done_at) continue
      const list = m.get(k.column_id) || m.get(first)
      if (list) list.push(k)
    }
    for (const list of m.values()) list.sort((a, b) => (!!a.done_at - !!b.done_at) || a.sort - b.sort)
    return m
  }, [cols, cards, showDone])
  const doneCount = cards.filter(k => k.done_at).length
  const lateCount = cards.filter(k => dueInfo(k)?.tone === 'late').length

  // ── правки: сразу на экране, потом в базу; ошибка — показать и перечитать ──
  const fail = async r => { if (r?.error) { window.alert(r.error); await load(); return true } return false }
  const patchCard = async (id, patch) => {
    setCards(list => list.map(k => (k.id === id ? { ...k, ...patch } : k)))
    const r = await updateCard(id, patch)
    if (!(await fail(r)) && r.data) setCards(list => list.map(k => (k.id === id ? r.data : k)))
  }
  const newCard = async (colId, title = '') => {
    const list = byCol.get(colId) || []
    const sort = between(list.length ? list[list.length - 1].sort : null, null)
    const r = await addCard({ column_id: colId, title, sort })
    if (await fail(r)) return null
    setCards(l => [...l, r.data]); return r.data
  }
  const quickAdd = async colId => {
    const t = window.prompt('Новая задача')
    if (t == null) return
    const c = await newCard(colId, t.trim())
    if (c && !t.trim()) setOpenId(c.id)
  }
  const newColumn = async () => {
    const name = window.prompt('Название этапа (например: Замер, Закуп материала, Монтаж)')
    if (!name?.trim()) return
    const last = cols[cols.length - 1]
    const r = await addColumn(name.trim(), between(last?.sort ?? null, null), COLORS[cols.length % COLORS.length])
    if (!(await fail(r))) { setCols(c => [...c, r.data]); setTimeout(() => boardRef.current?.scrollTo({ left: 1e6, behavior: 'smooth' }), 50) }
  }
  const renameColumn = async c => {
    const name = window.prompt('Название этапа', c.name)
    if (!name?.trim() || name.trim() === c.name) return
    setCols(l => l.map(x => (x.id === c.id ? { ...x, name: name.trim() } : x)))
    await fail(await updateColumn(c.id, { name: name.trim() }))
  }
  const moveColumn = async (c, dir) => {
    const i = cols.findIndex(x => x.id === c.id), j = i + dir
    if (j < 0 || j >= cols.length) return
    const next = [...cols]; [next[i], next[j]] = [next[j], next[i]]
    const a = next[i], b = next[j]
    const sa = b.sort, sb = a.sort                     // меняем местами значения порядка
    next[i] = { ...a, sort: sa }; next[j] = { ...b, sort: sb }
    setCols(next)
    await fail(await updateColumn(a.id, { sort: sa })); await fail(await updateColumn(b.id, { sort: sb }))
  }
  const recolor = async c => {
    const i = COLORS.indexOf(c.color), color = COLORS[(i + 1) % COLORS.length]
    setCols(l => l.map(x => (x.id === c.id ? { ...x, color } : x)))
    await fail(await updateColumn(c.id, { color }))
  }
  const removeColumn = async c => {
    const n = cards.filter(k => k.column_id === c.id).length
    if (cols.length <= 1) { window.alert('Должен остаться хотя бы один этап.'); return }
    if (!window.confirm(n ? `Удалить этап «${c.name}»? Задачи с него (${n}) перейдут на первый этап.` : `Удалить этап «${c.name}»?`)) return
    const to = cols.find(x => x.id !== c.id)
    if (n) {
      const ids = cards.filter(k => k.column_id === c.id).map(k => k.id)
      for (const id of ids) if (await fail(await updateCard(id, { column_id: to.id }))) return
    }
    if (await fail(await deleteColumn(c.id))) return
    await load()
  }

  // ── перенос карточки: удержать ~0,5 с (палец) или потянуть (мышь) ──
  const startDrag = (card, x, y) => {
    dragged.current = true
    try { navigator.vibrate?.(25) } catch { /* без вибрации */ }
    setDrag({ card, x, y, x0: x, y0: y, over: card.column_id, idx: null })
  }
  const cancelPress = () => { if (press.current) { clearTimeout(press.current.t); press.current = null } }
  const dragProps = card => (readOnly ? {} : {
    onPointerDown: e => {
      if (!e.isPrimary || e.button > 0 || e.target.closest('button, input, label, a, textarea')) return
      dragged.current = false
      const x = e.clientX, y = e.clientY, mouse = e.pointerType === 'mouse'
      press.current = { x, y, mouse, t: mouse ? 0 : setTimeout(() => { press.current = null; startDrag(card, x, y) }, 450) }
    },
    onPointerMove: e => {
      const p = press.current
      if (!p) return
      const d = Math.hypot(e.clientX - p.x, e.clientY - p.y)
      if (p.mouse && d > 6) { press.current = null; startDrag(card, e.clientX, e.clientY) }
      else if (!p.mouse && d > 8) cancelPress()                      // палец повёл сразу — это прокрутка, не перенос
    },
    onPointerUp: cancelPress,
    onPointerCancel: cancelPress,
    onContextMenu: e => e.preventDefault(),
  })
  const drop = (card, colId, idx) => {
    const list = (byCol.get(colId) || []).filter(k => k.id !== card.id)
    const sort = between(idx > 0 ? list[idx - 1]?.sort ?? null : null, list[idx]?.sort ?? null)
    if (colId === card.column_id && sort === card.sort) return
    patchCard(card.id, { column_id: colId, sort })
  }
  // пока тянем — страница не листается
  useEffect(() => {
    if (!drag) return
    const stop = e => e.preventDefault()
    document.addEventListener('touchmove', stop, { passive: false })
    return () => document.removeEventListener('touchmove', stop)
  }, [!!drag])   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!drag) return
    const pos = { x: drag.x, y: drag.y }
    let raf = 0
    const place = () => { const g = ghostRef.current; if (g) g.style.transform = `translate(${pos.x - 110}px, ${pos.y - 24}px)` }
    // куда упадёт: этап под пальцем и место среди его карточек
    const target = () => {
      const colEl = document.elementFromPoint(pos.x, pos.y)?.closest?.('[data-col]')
      if (!colEl) return null
      const els = [...colEl.querySelectorAll('[data-card]')].filter(el => el.getAttribute('data-card') !== dragRef.current?.card.id)
      let idx = els.length
      const byX = !!colEl.querySelector('[data-lane]')                 // дорожка: место — по горизонтали
      for (let i = 0; i < els.length; i++) { const r = els[i].getBoundingClientRect(); if (byX ? pos.x < r.left + r.width / 2 : pos.y < r.top + r.height / 2) { idx = i; break } }
      return { over: colEl.getAttribute('data-col'), idx }
    }
    const tick = () => {
      const el = boardRef.current
      // у края — листаем: доску (колонки) или дорожку этапа под пальцем
      const lane = document.elementFromPoint(pos.x, pos.y)?.closest?.('[data-col]')?.querySelector('[data-lane]')
      const sc = lane || el
      if (sc) { const r = sc.getBoundingClientRect(), edge = 44; if (pos.x < r.left + edge) sc.scrollLeft -= 12; else if (pos.x > r.right - edge) sc.scrollLeft += 12 }
      if (pos.y < 70) window.scrollBy(0, -10); else if (pos.y > window.innerHeight - 70) window.scrollBy(0, 10)
      const t = target()
      if (t) setDrag(d => (d && (d.over !== t.over || d.idx !== t.idx) ? { ...d, ...t } : d))
      raf = requestAnimationFrame(tick)
    }
    const move = e => { pos.x = e.clientX; pos.y = e.clientY; place() }
    const up = () => {
      cancelAnimationFrame(raf)
      const d = dragRef.current, t = target()
      setDrag(null)
      if (d && t && Math.hypot(pos.x - d.x0, pos.y - d.y0) >= 20) drop(d.card, t.over, t.idx)
    }
    place(); raf = requestAnimationFrame(tick)
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up)
    return () => { cancelAnimationFrame(raf); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up) }
  }, [!!drag])   // eslint-disable-line react-hooks/exhaustive-deps

  // карточка задачи (одна и та же в колонках и в дорожках)
  const cardView = (k, c) => {
    const p = progress(k), due = dueInfo(k), o = k.order_id ? orders.get(k.order_id) : null
    return (
      <div data-card={k.id} className="card" {...dragProps(k)} onClick={() => { if (!dragged.current) setOpenId(k.id) }}
        style={{ padding: '9px 10px', cursor: 'pointer', borderLeft: `3px solid ${c.color || 'var(--gray-mid)'}`, opacity: drag?.card.id === k.id ? 0.35 : k.done_at ? 0.6 : 1, userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none', touchAction: 'pan-x pan-y' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          {/* «выполнено» — только в карточке задачи: галочка на доске нажималась случайно, и задача пропадала */}
          {k.done_at && <span title="Выполнено" style={{ color: 'var(--teal)', fontSize: 14, lineHeight: '18px', flexShrink: 0 }}>✓</span>}
          <div style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 500, textDecoration: k.done_at ? 'line-through' : 'none', wordBreak: 'break-word' }}>{k.title || <span style={{ color: 'var(--text-hint)' }}>Без названия</span>}</div>
        </div>
        {k.note && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{k.note}</div>}
        <Progress {...p} />
        {(due || k.remind_at || o) && (
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 6 }}>
            {due && <span style={chip(...TONE[due.tone])}>📅 {due.text}</span>}
            {k.remind_at && !k.done_at && <span style={chip('var(--text-muted)', 'var(--bg2)')} title="Напоминание">{k.reminded_at ? '🔕' : '🔔'}</span>}
            {o && <span style={{ ...chip('var(--blue)', 'var(--blue-light)'), whiteSpace: 'normal' }}>📋 {orderTitle(o)} · {sendState(o).label}</span>}
          </div>
        )}
      </div>
    )
  }

  const open = cards.find(k => k.id === openId) || null
  const closeEditor = () => { setOpenId(null); if (qs.get('card')) navigate(readOnly ? `/tasks?u=${viewUser}` : '/tasks', { replace: true }) }

  return (
    <div className="page" style={{ paddingBottom: 100, maxWidth: 'none' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 8, paddingTop: 4, flexWrap: 'wrap' }}>
        <MenuButton />
        <h1 style={{ fontSize: 18, fontWeight: 500, flex: 1 }}>{readOnly ? 'Задачи пользователя' : 'Мои задачи'}</h1>
        {!readOnly && cols?.length > 0 && <button type="button" onClick={() => quickAdd(cols[0].id)} style={{ padding: '7px 12px', borderRadius: 18, border: 'none', background: 'var(--blue)', color: '#fff', fontSize: 14, fontWeight: 500, cursor: 'pointer' }}>+ Задача</button>}
      </div>
      {readOnly && <div style={{ fontSize: 12, color: 'var(--text-hint)', marginBottom: 8 }}>Мастер-аккаунт: только просмотр.</div>}
      {error && <div className="card" style={{ fontSize: 13, color: 'var(--danger)', marginBottom: 10 }}>{error}</div>}
      {!cols && <p style={{ fontSize: 13, color: 'var(--text-hint)' }}>Загружаем…</p>}
      {cols && cols.length > 0 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8, fontSize: 12.5, color: 'var(--text-muted)' }}>
          <span>Задач: <b>{cards.length - doneCount}</b></span>
          {lateCount > 0 && <span style={chip(...TONE.late)}>просрочено {lateCount}</span>}
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 4, alignItems: 'center' }}>
            <button type="button" title={lanes ? 'Колонками слева направо' : 'Этапы сверху вниз, задачи строкой (как техпроцесс)'} onClick={() => setLayout(lanes ? 'cols' : 'lanes')}
              style={{ padding: '3px 9px', borderRadius: 14, fontSize: 12, border: '0.5px solid var(--blue)', background: 'transparent', color: 'var(--blue)', cursor: 'pointer' }}>{lanes ? '⇆ Колонки' : '☰ Дорожки'}</button>
            {lanes && <>
              <button type="button" title="Мельче" onClick={() => setCardW(w => w / 1.2)} style={{ padding: '3px 9px', borderRadius: 14, fontSize: 13, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}>−</button>
              <button type="button" title="Крупнее" onClick={() => setCardW(w => w * 1.2)} style={{ padding: '3px 9px', borderRadius: 14, fontSize: 13, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}>+</button>
            </>}
          </span>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
            <input type="checkbox" checked={showDone} onChange={e => { setShowDone(e.target.checked); try { localStorage.setItem('tasksShowDone', e.target.checked ? '1' : '0') } catch { /* без памяти */ } }} style={{ width: 15, height: 15 }} />
            выполненные{doneCount ? ` (${doneCount})` : ''}
          </label>
        </div>
      )}
      {!readOnly && cols?.length > 0 && !cards.length && (
        <div style={{ fontSize: 12.5, color: 'var(--text-hint)', marginBottom: 8 }}>
          Этапы можно переименовать, переставить и добавить свои. Задачу переносят на другой этап: удержите карточку пальцем и ведите.
        </div>
      )}

      {cols && cols.length > 0 && (lanes ? (
        // дорожки, как доска техпроцесса: этапы сверху вниз, задачи этапа — строкой вправо (листаются вбок)
        <div ref={boardRef} style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingBottom: 12 }}>
          {cols.map((c, ci) => {
            const list = byCol.get(c.id) || [], hot = drag && drag.over === c.id
            return (
              <div key={c.id} data-col={c.id} style={{ display: 'flex', alignItems: 'stretch', gap: 6, minHeight: 92, borderRadius: 12, outline: hot ? '2px dashed var(--blue)' : 'none', background: hot ? 'var(--blue-light)' : 'transparent' }}>
                {/* этап — слева */}
                <div style={{ flex: `0 0 ${desk ? 150 : 86}px`, display: 'flex', flexDirection: 'column', gap: 3, padding: '6px 6px', borderRadius: 12, background: 'var(--bg3)', borderLeft: `4px solid ${c.color || 'var(--gray-mid)'}` }}>
                  <button type="button" disabled={readOnly} onClick={() => renameColumn(c)} style={{ border: 'none', background: 'transparent', padding: 0, textAlign: 'left', fontWeight: 600, fontSize: desk ? 13.5 : 12, lineHeight: 1.2, color: 'var(--text)', cursor: readOnly ? 'default' : 'pointer', wordBreak: 'break-word' }}>{c.name}</button>
                  <span style={{ fontSize: 11, color: 'var(--text-hint)' }}>задач {list.length}</span>
                  {!readOnly && (
                    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 0, marginTop: 'auto' }}>
                      <button type="button" aria-label="Цвет этапа" title="Цвет" style={{ ...iconBtn, width: 24, height: 24 }} onClick={() => recolor(c)}><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 5, background: c.color || 'var(--gray-mid)' }} /></button>
                      {ci > 0 && <button type="button" aria-label="Этап выше" style={{ ...iconBtn, width: 24, height: 24, fontSize: 13 }} onClick={() => moveColumn(c, -1)}>↑</button>}
                      {ci < cols.length - 1 && <button type="button" aria-label="Этап ниже" style={{ ...iconBtn, width: 24, height: 24, fontSize: 13 }} onClick={() => moveColumn(c, 1)}>↓</button>}
                      <button type="button" aria-label="Удалить этап" style={{ ...iconBtn, width: 24, height: 24, fontSize: 12 }} onClick={() => removeColumn(c)}>✕</button>
                    </span>
                  )}
                </div>
                {/* задачи этапа — строкой вправо */}
                <div data-lane style={{ flex: 1, minWidth: 0, display: 'flex', gap: 6, overflowX: 'auto', alignItems: 'flex-start', padding: 4, background: 'var(--bg3)', borderRadius: 12 }}>
                  {list.map((k, i) => (
                    <div key={k.id} style={{ display: 'flex', flex: '0 0 auto' }}>
                      {hot && drag.idx === i && drag.card.id !== k.id && <div style={{ width: 5, borderRadius: 3, background: 'var(--blue)', marginRight: 6 }} />}
                      <div style={{ width: CW }}>{cardView(k, c)}</div>
                    </div>
                  ))}
                  {hot && drag.idx === list.length && <div style={{ flex: '0 0 5px', alignSelf: 'stretch', borderRadius: 3, background: 'var(--blue)' }} />}
                  {!readOnly && <button type="button" onClick={() => quickAdd(c.id)} style={{ flex: '0 0 auto', alignSelf: 'stretch', minWidth: 44, border: '1px dashed var(--border-md)', borderRadius: 10, background: 'transparent', color: 'var(--text-muted)', fontSize: 13, padding: '0 10px', cursor: 'pointer' }}>{list.length ? '+' : '+ Задача'}</button>}
                  {readOnly && !list.length && <div style={{ alignSelf: 'center', fontSize: 12, color: 'var(--text-hint)', padding: '0 6px' }}>пусто</div>}
                </div>
              </div>
            )
          })}
          {!readOnly && <button type="button" onClick={newColumn} style={{ minHeight: 44, borderRadius: 12, border: '1px dashed var(--border-md)', background: 'transparent', color: 'var(--text-muted)', fontSize: 14, cursor: 'pointer' }}>+ Этап</button>}
        </div>
      ) : (
        <div ref={boardRef} style={{ display: 'flex', gap: 10, overflowX: 'auto', alignItems: 'flex-start', paddingBottom: 12, scrollSnapType: drag ? 'none' : 'x proximity', WebkitOverflowScrolling: 'touch', margin: '0 -16px', padding: '0 16px 12px' }}>
          {cols.map((c, ci) => {
            const list = byCol.get(c.id) || [], hot = drag && drag.over === c.id
            return (
              <div key={c.id} data-col={c.id} style={{ flex: '0 0 min(300px, 84vw)', scrollSnapAlign: 'start', background: hot ? 'var(--blue-light)' : 'var(--bg3)', borderRadius: 14, padding: 8, transition: 'background .15s', minHeight: 120 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 2px 8px' }}>
                  <button type="button" disabled={readOnly} onClick={() => recolor(c)} title="Цвет этапа" style={{ width: 12, height: 12, borderRadius: 6, border: 'none', padding: 0, background: c.color || 'var(--gray-mid)', cursor: readOnly ? 'default' : 'pointer', flexShrink: 0 }} />
                  <button type="button" disabled={readOnly} onClick={() => renameColumn(c)} style={{ flex: 1, minWidth: 0, textAlign: 'left', border: 'none', background: 'transparent', padding: '2px 4px', fontWeight: 600, fontSize: 14, color: 'var(--text)', cursor: readOnly ? 'default' : 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.name} <span style={{ color: 'var(--text-hint)', fontWeight: 400 }}>{list.length}</span>
                  </button>
                  {!readOnly && <>
                    {ci > 0 && <button type="button" aria-label="Этап левее" style={iconBtn} onClick={() => moveColumn(c, -1)}>‹</button>}
                    {ci < cols.length - 1 && <button type="button" aria-label="Этап правее" style={iconBtn} onClick={() => moveColumn(c, 1)}>›</button>}
                    <button type="button" aria-label="Удалить этап" style={{ ...iconBtn, fontSize: 14 }} onClick={() => removeColumn(c)}>✕</button>
                  </>}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {list.map((k, i) => (
                    <div key={k.id}>
                      {hot && drag.idx === i && drag.card.id !== k.id && <div style={{ height: 6, borderRadius: 3, background: 'var(--blue)', margin: '0 0 6px' }} />}
                      {cardView(k, c)}
                    </div>
                  ))}
                  {hot && drag.idx === list.length && <div style={{ height: 6, borderRadius: 3, background: 'var(--blue)' }} />}
                  {!list.length && !hot && <div style={{ fontSize: 12, color: 'var(--text-hint)', textAlign: 'center', padding: '10px 0' }}>{drag ? 'сюда' : 'пусто'}</div>}
                  {!readOnly && <button type="button" onClick={() => quickAdd(c.id)} style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', fontSize: 13.5, textAlign: 'left', padding: '6px 4px', cursor: 'pointer' }}>+ Добавить задачу</button>}
                </div>
              </div>
            )
          })}
          {!readOnly && (
            <button type="button" onClick={newColumn} style={{ flex: '0 0 170px', minHeight: 60, borderRadius: 14, border: '1px dashed var(--border-md)', background: 'transparent', color: 'var(--text-muted)', fontSize: 14, cursor: 'pointer' }}>+ Этап</button>
          )}
        </div>
      ))}

      {drag && (
        <div ref={ghostRef} style={{ position: 'fixed', left: 0, top: 0, zIndex: 3000, width: 220, pointerEvents: 'none', transform: `translate(${drag.x - 110}px, ${drag.y - 24}px)` }}>
          <div className="card" style={{ padding: '9px 10px', boxShadow: '0 10px 28px rgba(0,0,0,.22)', transform: 'rotate(-2deg)', fontSize: 14, fontWeight: 500 }}>{drag.card.title || 'Без названия'}</div>
        </div>
      )}

      {open && (
        <CardEditor key={open.id} card={open} cols={cols || []} order={open.order_id ? orders.get(open.order_id) : null} readOnly={readOnly} userId={user?.id}
          onPatch={patch => patchCard(open.id, patch)}
          onDelete={async () => { if (!window.confirm('Удалить задачу?')) return; const r = await deleteCard(open.id); if (!(await fail(r))) { setCards(l => l.filter(k => k.id !== open.id)); closeEditor() } }}
          onOrderLinked={o => setOrders(m => new Map(m).set(o.id, o))}
          onClose={closeEditor} />
      )}
      <BottomNav />
    </div>
  )
}

const REMIND = [['', 'Без напоминания'], ['due', 'В срок'], ['1h', 'За 1 час до срока'], ['1d', 'За день до срока'], ['custom', 'Своё время']]
const remindAt = (kind, due, custom) => {
  if (!kind) return null
  if (kind === 'custom') return custom || null
  if (!due) return null
  const t = new Date(due).getTime()
  return new Date(kind === '1h' ? t - 3600e3 : kind === '1d' ? t - 86400e3 : t).toISOString()
}
const remindKind = c => {
  if (!c.remind_at) return ''
  if (!c.due_at) return 'custom'
  const d = new Date(c.due_at).getTime() - new Date(c.remind_at).getTime()
  return d === 0 ? 'due' : d === 3600e3 ? '1h' : d === 86400e3 ? '1d' : 'custom'
}

/** Карточка задачи: название, заметка, подзадачи, этап, срок и напоминание, заказ */
function CardEditor({ card, cols, order, readOnly, userId, onPatch, onDelete, onOrderLinked, onClose }) {
  const navigate = useNavigate()
  useBackClose(true, onClose)
  const [title, setTitle] = useState(card.title || '')
  const [note, setNote] = useState(card.note || '')
  const [item, setItem] = useState('')
  const [rk, setRk] = useState(() => remindKind(card))
  const [pick, setPick] = useState(null)              // список заказов для привязки
  const list = Array.isArray(card.checklist) ? card.checklist : []
  const p = progress(card)
  const ro = readOnly
  const field = { width: '100%', padding: '8px 10px', fontSize: 14, borderRadius: 8, border: '1px solid var(--border-md)', background: 'var(--bg)', color: 'var(--text)', fontFamily: 'inherit' }
  const saveText = () => { const patch = {}; if (title !== (card.title || '')) patch.title = title; if (note !== (card.note || '')) patch.note = note || null; if (Object.keys(patch).length) onPatch(patch) }
  const close = () => { saveText(); onClose() }
  // компьютер: окно задачи посередине экрана, переносится за верхнюю полосу и растягивается за угол; место и размер запоминаются
  const desk = useDesktop()
  const winRef = useRef(null)
  const downOut = useRef(null)
  const [win, setWin] = useState(() => {
    let s
    try { s = JSON.parse(localStorage.getItem('taskWin') || 'null') } catch { s = null }
    const vw = window.innerWidth, vh = window.innerHeight
    const w = Math.min(s?.w || 560, vw - 40), h = Math.min(s?.h || Math.round(vh * 0.75), vh - 40)
    const x = s ? Math.min(Math.max(0, s.x), vw - 120) : Math.round((vw - w) / 2)
    const y = s ? Math.min(Math.max(0, s.y), vh - 60) : Math.round((vh - h) / 2)
    return { x, y, w, h }
  })
  const saveWin = () => {
    const el = winRef.current
    if (!desk || !el) return
    const r = el.getBoundingClientRect()
    const next = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
    setWin(next)
    try { localStorage.setItem('taskWin', JSON.stringify(next)) } catch { /* без памяти */ }
  }
  const startMove = e => {
    if (e.button !== 0 || e.target.closest('button, input, label, select, textarea')) return
    e.preventDefault()
    const el = winRef.current, r = el.getBoundingClientRect()
    const dx = e.clientX - r.left, dy = e.clientY - r.top
    const move = ev => { el.style.left = Math.min(Math.max(0, ev.clientX - dx), window.innerWidth - 120) + 'px'; el.style.top = Math.min(Math.max(0, ev.clientY - dy), window.innerHeight - 50) + 'px' }
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); saveWin() }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }
  const setList = l => onPatch({ checklist: l })
  const addItem = () => { const t = item.trim(); if (!t) return; setList([...list, { id: newItemId(), t, done: false }]); setItem('') }
  const setDue = v => { const due = fromLocalInput(v); onPatch({ due_at: due, ...(rk && rk !== 'custom' ? { remind_at: remindAt(rk, due) } : {}) }) }
  const setRemind = k => { setRk(k); if (k !== 'custom') onPatch({ remind_at: remindAt(k, card.due_at) }) }
  const toOrder = () => { saveText(); navigate('/orders/new', { state: { task: { id: card.id, title: title.trim(), note: [note.trim(), ...list.filter(x => !x.done).map(x => '• ' + x.t)].filter(Boolean).join('\n') } } }) }
  const openPick = async () => setPick(await myOrders(userId))
  const btn = (bg, fg) => ({ padding: '8px 12px', borderRadius: 8, border: bg === 'transparent' ? '1px solid var(--border-md)' : 'none', background: bg, color: fg, fontSize: 13.5, cursor: 'pointer' })

  return (
    // закрыть щелчком мимо окна — только если и нажали мимо (потянули угол окна и отпустили снаружи — не закрываем)
    <div onMouseDown={e => { downOut.current = e.target === e.currentTarget }} onClick={e => { if (e.target === e.currentTarget && downOut.current !== false) close() }} style={{ position: 'fixed', inset: 0, zIndex: 2000, background: desk ? 'rgba(0,0,0,.12)' : 'rgba(0,0,0,.35)', display: 'flex', alignItems: desk ? 'flex-start' : 'flex-end', justifyContent: desk ? 'flex-start' : 'center' }}>
      <div ref={winRef} data-editor onClick={e => e.stopPropagation()} onMouseUp={saveWin}
        style={desk
          ? { position: 'absolute', left: win.x, top: win.y, width: win.w, height: win.h, minWidth: 360, minHeight: 260, maxWidth: '96vw', maxHeight: '94vh', resize: 'both', overflow: 'auto', background: 'var(--bg)', borderRadius: 14, padding: '0 16px 20px', boxShadow: '0 12px 40px rgba(0,0,0,.25)' }
          : { width: '100%', maxWidth: 560, maxHeight: '92vh', overflowY: 'auto', background: 'var(--bg)', borderRadius: '16px 16px 0 0', padding: '14px 16px 24px', boxShadow: '0 -8px 30px rgba(0,0,0,.2)' }}>
        <div onPointerDown={desk ? startMove : undefined} title={desk ? 'Потяните, чтобы перенести окно' : undefined}
          style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, ...(desk ? { position: 'sticky', top: 0, zIndex: 2, background: 'var(--bg)', padding: '12px 0 8px', cursor: 'move', borderBottom: '0.5px solid var(--border)' } : {}) }}>
          {!ro && <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={!!card.done_at} onChange={e => {
              const on = e.target.checked
              // не все подзадачи выполнены — переспросить
              if (on && p.total > p.done && !window.confirm(`Не выполнено подзадач: ${p.total - p.done} из ${p.total}. Всё равно отметить задачу выполненной?`)) return
              onPatch({ done_at: on ? new Date().toISOString() : null })
            }} style={{ width: 18, height: 18 }} />Выполнено
          </label>}
          <span style={{ flex: 1 }} />
          {!ro && <button type="button" onClick={onDelete} style={{ ...btn('transparent', 'var(--danger)'), padding: '6px 10px' }}>Удалить</button>}
          <button type="button" aria-label="Закрыть" onClick={close} style={{ width: 34, height: 34, borderRadius: 17, border: 'none', background: 'var(--bg2)', fontSize: 18, cursor: 'pointer', color: 'var(--text-muted)' }}>×</button>
        </div>

        <input type="text" value={title} readOnly={ro} placeholder="Что сделать" onChange={e => setTitle(e.target.value)} onBlur={saveText}
          style={{ ...field, fontSize: 17, fontWeight: 600, border: 'none', padding: '4px 0', background: 'transparent' }} />
        <textarea value={note} readOnly={ro} placeholder="Заметка: адрес, размеры, телефон клиента…" rows={3} onChange={e => setNote(e.target.value)} onBlur={saveText}
          style={{ ...field, marginTop: 6, resize: 'vertical' }} />

        {/* подзадачи */}
        <div style={{ marginTop: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>Подзадачи</span>
            {p.total > 0 && <span style={{ fontSize: 12, color: 'var(--text-hint)' }}>выполнено {p.done} из {p.total}</span>}
          </div>
          <Progress {...p} big />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 6 }}>
            {list.map((x, i) => (
              <div key={x.id || i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
                <input type="checkbox" checked={!!x.done} disabled={ro} onChange={e => setList(list.map(y => (y === x ? { ...y, done: e.target.checked } : y)))} style={{ width: 18, height: 18, flexShrink: 0 }} />
                <input type="text" defaultValue={x.t} readOnly={ro} onBlur={e => { const t = e.target.value.trim(); if (t && t !== x.t) setList(list.map(y => (y === x ? { ...y, t } : y))) }}
                  style={{ flex: 1, minWidth: 0, border: 'none', background: 'transparent', fontSize: 14, padding: '4px 0', color: x.done ? 'var(--text-hint)' : 'var(--text)', textDecoration: x.done ? 'line-through' : 'none' }} />
                {!ro && <button type="button" aria-label="Убрать" onClick={() => setList(list.filter(y => y !== x))} style={{ ...iconBtn, width: 26, height: 26, fontSize: 13 }}>✕</button>}
              </div>
            ))}
          </div>
          {!ro && (
            <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
              <input type="text" value={item} placeholder="Новая подзадача" onChange={e => setItem(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addItem() } }} style={{ ...field, flex: 1 }} />
              <button type="button" onClick={addItem} disabled={!item.trim()} style={btn('var(--blue)', '#fff')}>+</button>
            </div>
          )}
        </div>

        {/* этап, срок, напоминание */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginTop: 16 }}>
          <label style={{ fontSize: 12, color: 'var(--text-hint)' }}>Этап
            <select value={card.column_id || ''} disabled={ro} onChange={e => onPatch({ column_id: e.target.value })} style={{ ...field, marginTop: 3 }}>
              {cols.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label style={{ fontSize: 12, color: 'var(--text-hint)' }}>Срок
            <input type="datetime-local" value={toLocalInput(card.due_at)} readOnly={ro} onChange={e => setDue(e.target.value)} style={{ ...field, marginTop: 3 }} />
          </label>
          <label style={{ fontSize: 12, color: 'var(--text-hint)' }}>Напомнить
            <select value={rk} disabled={ro} onChange={e => setRemind(e.target.value)} style={{ ...field, marginTop: 3 }}>
              {REMIND.map(([k, l]) => <option key={k} value={k} disabled={!card.due_at && ['due', '1h', '1d'].includes(k)}>{l}</option>)}
            </select>
          </label>
          {rk === 'custom' && (
            <label style={{ fontSize: 12, color: 'var(--text-hint)' }}>Когда напомнить
              <input type="datetime-local" value={toLocalInput(card.remind_at)} readOnly={ro} onChange={e => onPatch({ remind_at: fromLocalInput(e.target.value) })} style={{ ...field, marginTop: 3 }} />
            </label>
          )}
        </div>
        {card.remind_at && (
          <div style={{ fontSize: 11.5, color: 'var(--text-hint)', marginTop: 5 }}>
            {card.reminded_at ? 'Напоминание уже пришло.' : `Напоминание придёт ${new Date(card.remind_at).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })} — уведомлением на телефон (включите уведомления в разделе «Уведомления»).`}
          </div>
        )}

        {/* заказ */}
        <div style={{ marginTop: 16, paddingTop: 12, borderTop: '0.5px solid var(--border)' }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Заказ на раскрой</div>
          {order ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" onClick={() => navigate(`/orders/${order.id}`)} style={{ ...btn('var(--blue-light)', 'var(--blue)'), flex: 1, textAlign: 'left' }}>
                📋 {orderTitle(order)} <span style={{ color: 'var(--text-muted)' }}>· {sendState(order).label}</span>
              </button>
              {!ro && <button type="button" onClick={() => onPatch({ order_id: null })} style={btn('transparent', 'var(--text-muted)')}>Отвязать</button>}
            </div>
          ) : ro ? <div style={{ fontSize: 12.5, color: 'var(--text-hint)' }}>Не привязан.</div> : (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button type="button" onClick={toOrder} style={btn('var(--blue)', '#fff')}>➕ Создать заказ из задачи</button>
              <button type="button" onClick={openPick} style={btn('transparent', 'var(--blue)')}>🔗 Привязать готовый заказ</button>
            </div>
          )}
          {pick && !order && (
            <div style={{ marginTop: 8, maxHeight: 240, overflowY: 'auto', border: '0.5px solid var(--border)', borderRadius: 10 }}>
              {!pick.length && <div style={{ fontSize: 12.5, color: 'var(--text-hint)', padding: 10 }}>Заказов пока нет.</div>}
              {pick.map(o => (
                <button key={o.id} type="button" onClick={() => { onOrderLinked(o); onPatch({ order_id: o.id }); setPick(null) }}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 12px', border: 'none', borderBottom: '0.5px solid var(--border)', background: 'transparent', cursor: 'pointer', color: 'var(--text)', fontSize: 13.5 }}>
                  {orderTitle(o)} <span style={{ color: 'var(--text-hint)', fontSize: 12 }}>· {sendState(o).label} · {new Date(o.created_at).toLocaleDateString('ru-RU')}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
