import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { myWorkplaces, openWorkplace, openOwnProduction, prodView, workPid } from '../lib/workplaces'
import { myProduction } from '../lib/productionApi'
import { I } from '../lib/navIcons'
import { APP_COMMIT, appVersionText, NESTING_VERSION } from '../lib/version'
import { getUiScale, setUiScale, isTouchDevice, UI_SCALE_MIN, UI_SCALE_MAX } from '../lib/uiScale'

// Боковое меню (кнопка ☰ слева вверху или свайп от левого края): все кабинеты и их разделы в одном месте —
// производство (заказы, техпроцесс, настройки), рабочие места, клиент (заказы, новый заказ), мастер-аккаунт.
// Один тап — сразу нужный раздел нужного кабинета. Панель идёт за пальцем, закрывается свайпом влево.

let cache = null                                       // { wps, own } — один раз за запуск, обновляется при открытии
const W = () => Math.min(340, Math.round(window.innerWidth * 0.86))
const EASE = 'cubic-bezier(.32,.72,0,1)'                // кривая iOS: быстрый старт, мягкая остановка

/** Кнопка ☰ — ставится в шапку главных экранов. Красная точка — есть новое */
let lastBadge = 0
export function MenuButton({ style }) {
  const [n, setN] = useState(lastBadge)
  useEffect(() => {
    const on = e => setN(e.detail || 0)
    window.addEventListener('nav-badge', on)
    return () => window.removeEventListener('nav-badge', on)
  }, [])
  return (
    <button type="button" aria-label="Меню" onClick={() => window.dispatchEvent(new Event('nav-open'))}
      style={{ position: 'relative', flex: '0 0 auto', width: 38, height: 38, marginLeft: -6, borderRadius: 19, border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text)', WebkitTapHighlightColor: 'transparent', ...style }}>
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M4 7h16M4 12h16M4 17h10" /></svg>
      {n > 0 && <span style={{ position: 'absolute', top: 6, right: 5, width: 9, height: 9, borderRadius: '50%', background: 'var(--danger)', border: '1.5px solid var(--bg)' }} />}
    </button>
  )
}
// eslint-disable-next-line react-refresh/only-export-components
export const setMenuBadge = n => { lastBadge = n; window.dispatchEvent(new CustomEvent('nav-badge', { detail: n })) }

export const Ico = ({ d, size = 20 }) => <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d={d} /></svg>
const tabOf = key => { try { return JSON.parse(sessionStorage.getItem(`keep:/production#${key}`) || 'null') } catch { return null } }
const setTabKey = (key, v) => { try { sessionStorage.setItem(`keep:/production#${key}`, JSON.stringify(v)) } catch { /* без памяти */ } }

export default function NavDrawer({ notices, unread }) {
  const { user, profile, cabinet, setCabinet, isMaster } = useAuth()
  const navigate = useNavigate()
  const { pathname, search } = useLocation()
  const [open, setOpen] = useState(false)
  const [drag, setDrag] = useState(null)               // px, насколько панель выдвинута, пока её ведёт палец
  const [data, setData] = useState(cache)
  const [shut, setShut] = useState({})                 // свёрнутые разделы
  const panel = useRef(null)
  // ширина панели — по окну; после смены «Размера текста и кнопок» окно в CSS-пикселях другое — пересчитываем.
  // Обработчики жестов читают её через ref: раньше они переподписывались посреди жеста (ширина менялась), отпускание
  // пальца терялось, панель «залипала» — ни крестик, ни смахивание её не закрывали
  const [w, setW] = useState(W)
  const wRef = useRef(w)
  useEffect(() => { wRef.current = w }, [w])
  useEffect(() => { const on = () => setW(W()); window.addEventListener('resize', on); return () => window.removeEventListener('resize', on) }, [])
  const close = () => { setDrag(null); setOpen(false) }

  const refresh = () => Promise.all([myWorkplaces(), myProduction(user?.id)]).then(([r, p]) => { cache = { wps: r.data || [], own: p || null }; setData(cache) })
  useEffect(() => {
    const on = () => { setOpen(true); refresh() }
    window.addEventListener('nav-open', on)
    return () => window.removeEventListener('nav-open', on)
  }, [user?.id])   // eslint-disable-line react-hooks/exhaustive-deps

  // свайп от левого края экрана — панель выезжает за пальцем
  useEffect(() => {
    let st = null
    const down = e => { if (open || e.touches.length !== 1) return; const t = e.touches[0]; if (t.clientX < 18) st = { x: t.clientX, y: t.clientY, on: false } }
    const move = e => {
      if (!st) return
      const t = e.touches[0], dx = t.clientX - st.x, dy = t.clientY - st.y
      if (!st.on) { if (Math.abs(dy) > 14 && Math.abs(dy) > Math.abs(dx)) { st = null; return } if (dx > 10) { st.on = true; refresh() } else return }
      e.preventDefault()
      setDrag(Math.max(0, Math.min(wRef.current, dx)))
    }
    const up = e => {
      if (!st) return
      const on = st.on; st = null
      if (!on) return
      const x = e.changedTouches[0].clientX
      setDrag(null); setOpen(x > wRef.current * 0.33)
    }
    document.addEventListener('touchstart', down, { passive: true })
    document.addEventListener('touchmove', move, { passive: false })
    document.addEventListener('touchend', up)
    document.addEventListener('touchcancel', up)
    return () => { document.removeEventListener('touchstart', down); document.removeEventListener('touchmove', move); document.removeEventListener('touchend', up); document.removeEventListener('touchcancel', up) }
  }, [open])   // eslint-disable-line react-hooks/exhaustive-deps

  // открытая панель закрывается свайпом влево в любом месте экрана (панель или затемнение, сверху или снизу) —
  // панель идёт за пальцем; отпустили дальше трети или смахнули быстро — закрылась. Свои обработчики (не пассивные):
  // горизонтальный жест не отдаётся прокрутке списка.
  const root = useRef(null)
  useEffect(() => {
    const el = root.current
    if (!el || !open) return
    let s = null, swallow = false
    const down = e => { if (e.touches.length !== 1) { s = null; return } const t = e.touches[0]; s = { x: t.clientX, y: t.clientY, on: false, t: Date.now(), lx: t.clientX, lt: Date.now(), v: 0 } }
    const move = e => {
      if (!s) return
      const t = e.touches[0], dx = t.clientX - s.x, dy = t.clientY - s.y
      if (!s.on) {
        if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx) * 1.2) { s = null; return }   // вертикально — это прокрутка списка
        if (dx < -6 && Math.abs(dx) > Math.abs(dy)) s.on = true; else return
      }
      e.preventDefault()
      const now = Date.now(); s.v = (t.clientX - s.lx) / Math.max(1, now - s.lt); s.lx = t.clientX; s.lt = now
      const ww = wRef.current
      setDrag(Math.max(0, Math.min(ww, ww + Math.min(0, dx))))
    }
    const up = e => {
      if (!s) return
      const st = s; s = null
      if (!st.on) return
      swallow = true; setTimeout(() => { swallow = false }, 350)   // после смахивания тап по пункту не срабатывает
      const dx = (e.changedTouches[0]?.clientX ?? st.lx) - st.x
      setDrag(null); setOpen(!(st.v < -0.35 || dx < -wRef.current * 0.33))
    }
    const click = e => { if (swallow) { e.stopPropagation(); e.preventDefault() } }
    el.addEventListener('touchstart', down, { passive: true })
    el.addEventListener('touchmove', move, { passive: false })
    el.addEventListener('touchend', up)
    el.addEventListener('touchcancel', up)
    el.addEventListener('click', click, true)
    return () => { el.removeEventListener('touchstart', down); el.removeEventListener('touchmove', move); el.removeEventListener('touchend', up); el.removeEventListener('touchcancel', up); el.removeEventListener('click', click, true) }
  }, [open])

  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    try { navigator.vibrate?.(6) } catch { /* без вибрации */ }
    const esc = e => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', esc)
    return () => { document.body.style.overflow = prev; window.removeEventListener('keydown', esc) }
  }, [open])

  // закрытая панель прячется только после того, как доехала — иначе анимация закрытия не видна
  const [vis, setVis] = useState(false)
  const moving = open || drag != null
  useEffect(() => {
    if (moving) { Promise.resolve().then(() => setVis(true)); return }
    const t = setTimeout(() => setVis(false), 450)
    return () => clearTimeout(t)
  }, [moving])
  const shown = drag != null ? drag : open ? w : 0
  const k = shown / w
  if (!user) return null

  const wps = data?.wps || [], own = data?.own
  const ownOk = own && (own.status ?? 'approved') === 'approved'
  const workView = wps.length > 0 && (own ? prodView() === 'work' : prodView() !== 'own')
  const curPid = wps.some(x => x.production_id === workPid()) ? workPid() : wps[0]?.production_id
  const n = notices || {}

  // переходы
  const go = (to, state) => { close(); navigate(to, state ? { state } : undefined) }
  const goOwn = tab => { openOwnProduction(); if (tab) setTabKey('prodTab', tab); if (tab === 'settings') setTabKey('setSec', null); setCabinet('production'); go('/production', { tab }) }
  const goWork = (pid, wtab) => { openWorkplace(pid); if (wtab) setTabKey('wTab', wtab); setCabinet('production'); go('/production', { wtab }) }
  const goClient = to => { setCabinet('client'); go(to) }

  // что сейчас открыто — подсвечивается
  const onProd = cabinet === 'production' && pathname === '/production'
  const ownTab = tabOf('prodTab') || 'orders', wTab = tabOf('wTab') || 'posts'
  const isOwn = t => onProd && !workView && ownTab === t
  const isWork = (pid, t) => onProd && workView && curPid === pid && wTab === t
  const isClient = to => cabinet === 'client' && (to === '/orders' ? pathname === '/orders' || (pathname.startsWith('/orders/') && pathname !== '/orders/new') : pathname === to)

  const sections = []
  for (const x of wps) {
    const chief = !!x.perms?.all, cnt = n.byProd?.[x.production_id] || 0
    sections.push({ id: `w:${x.production_id}`, icon: I.factory, title: x.production_name, sub: `Рабочее место${x.name ? ' · ' + x.name : ''}`, badge: cnt, items: [
      { icon: I.posts, label: 'Мои посты', badge: cnt, on: isWork(x.production_id, 'posts'), act: () => goWork(x.production_id, 'posts') },
      ...(chief ? [
        { icon: I.board, label: 'Техпроцесс', on: isWork(x.production_id, 'board'), act: () => goWork(x.production_id, 'board') },
        { icon: I.orders, label: 'Все заказы', on: isWork(x.production_id, 'orders'), act: () => goWork(x.production_id, 'orders') },
      ] : []),
    ] })
  }
  const ownPosts = own?.id ? n.byProd?.[own.id] || 0 : 0
  const prodSec = ownOk
    ? { id: 'own', icon: I.factory, title: own.name || 'Производство', sub: 'Своё производство', badge: (n.ownNew || 0) + ownPosts, items: [
        { icon: I.orders, label: 'Заказы', badge: n.ownNew || 0, on: isOwn('orders'), act: () => goOwn('orders') },
        { icon: I.board, label: 'Техпроцесс', badge: ownPosts, on: isOwn('board'), act: () => goOwn('board') },
        { icon: I.gear, label: 'Настройки', on: isOwn('settings'), act: () => goOwn('settings') },
        { icon: I.share, label: 'Пригласить клиентов', on: pathname === '/invite' && search !== '?k=production', act: () => go('/invite?k=client') },
      ] }
    : { id: 'own', icon: I.factory, title: own ? own.name || 'Производство' : wps.length ? 'Своё производство' : 'Производство', sub: own ? 'Ждёт подтверждения' : 'Ещё не создано', items: [
        { icon: own ? I.factory : I.plus, label: own ? 'Открыть' : wps.length ? 'Создать своё производство' : 'Зарегистрировать производство', on: onProd && !workView, act: () => goOwn(null) },
      ] }
  const clientSec = { id: 'client', icon: I.bag, title: 'Клиент', sub: 'Мои заказы на раскрой', badge: n.orders || 0, items: [
    { icon: I.orders, label: 'Мои заказы', badge: n.orders || 0, on: isClient('/orders'), act: () => goClient('/orders') },
    { icon: I.plus, label: 'Новый заказ', on: isClient('/orders/new'), act: () => goClient('/orders/new') },
  ] }
  // сотруднику — сначала рабочее место, потом клиент, потом своё производство; остальным — производство, клиент
  if (wps.length) sections.push(clientSec, prodSec); else sections.unshift(prodSec, clientSec)
  // новые события — в самом верху: что случилось и куда ведёт, нажатие — сразу к нужной строке
  const fresh = n.list || []
  if (fresh.length) sections.unshift({ id: 'new', icon: I.msg, title: `Новое · ${fresh.length}`, badge: fresh.length, items: [
    ...fresh.slice(0, 4).map(x => ({ key: x.key, icon: I.msg, label: x.text, sub: x.where ? '→ ' + x.where : '', hot: true, act: () => go(x.to) })),
    ...(fresh.length > 4 ? [{ icon: I.msg, label: `Все уведомления (${fresh.length})`, act: () => go('/notices') }] : []),
  ] })
  const common = { id: 'common', icon: I.user, title: 'Общее', items: [
    { icon: I.msg, label: 'Уведомления', badge: fresh.length, on: pathname === '/notices', act: () => go('/notices') },
    { icon: I.scan, label: 'Сканер бирки', on: pathname === '/scan', act: () => go('/scan') },
    { icon: I.msg, label: 'Сообщения', badge: unread || 0, on: pathname === '/messages', act: () => go('/messages') },
    { icon: I.share, label: ownOk ? 'Пригласить производство' : 'Пригласить своё производство', on: pathname === '/invite' && (!ownOk || search === '?k=production'), act: () => go('/invite?k=production') },
    { icon: I.user, label: 'Профиль', badge: 0, on: pathname === '/profile', act: () => go('/profile') },
  ] }
  sections.push(common)
  if (isMaster) sections.push({ id: 'master', icon: I.crown, title: 'Мастер-аккаунт', badge: n.users || 0, items: [
    { icon: I.users, label: 'Пользователи и регистрация', badge: n.users || 0, on: pathname === '/users', act: () => go('/users') },
    { icon: I.chart, label: 'Активность пользователей', on: pathname === '/activity', act: () => go('/activity') },
    { icon: I.globe, label: 'Заказы всех клиентов', on: pathname === '/all-orders', act: () => go('/all-orders') },
    { icon: I.factory, label: 'Заказы всех производств', on: pathname === '/all-productions', act: () => go('/all-productions') },
    { icon: I.inbox, label: 'Обращения и файлы', on: false, act: () => go('/messages') },
  ] })

  const initials = (profile?.full_name || user?.email || '?').split(' ').map(s => s[0]).join('').slice(0, 2).toUpperCase()
  const where = cabinet === 'production' ? (workView ? wps.find(x => x.production_id === curPid)?.production_name : own?.name) || 'Производство' : 'Клиент'
  const pill = c => c > 0 ? <span style={{ minWidth: 20, height: 20, padding: '0 6px', borderRadius: 10, background: 'var(--danger)', color: '#fff', fontSize: 11.5, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{c > 99 ? '99+' : c}</span> : null
  const tr = drag != null ? 'none' : `transform .42s ${EASE}`

  // закладка у левого края: видно, что слева есть меню (нажать — откроется, или потянуть от края)
  const tab = !moving && !vis && (
    <button type="button" aria-label="Меню" onClick={() => { setOpen(true); refresh() }}
      style={{ position: 'fixed', left: 0, top: '42%', zIndex: 1050, width: 14, height: 56, padding: 0, border: 'none', borderRadius: '0 10px 10px 0',
        background: 'var(--blue)', opacity: 0.55, boxShadow: '1px 0 6px rgba(0,0,0,.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round"><path d="M9 6l6 6-6 6" /></svg>
    </button>
  )
  return createPortal(<>
    {tab}
    <div ref={root} style={{ position: 'fixed', inset: 0, zIndex: 1100, pointerEvents: moving ? 'auto' : 'none', visibility: moving || vis ? 'visible' : 'hidden' }}>
      <div onClick={close} style={{ position: 'absolute', inset: 0, background: '#000', opacity: k * 0.38, transition: drag != null ? 'none' : `opacity .42s ${EASE}`, WebkitTapHighlightColor: 'transparent' }} />
      <nav ref={panel}
        style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: w, transform: `translate3d(${shown - w}px,0,0)`, transition: tr, willChange: 'transform',
          background: 'var(--bg)', boxShadow: k > 0 ? '8px 0 32px rgba(0,0,0,.18)' : 'none', display: 'flex', flexDirection: 'column',
          paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)', borderRadius: '0 18px 18px 0', overflow: 'hidden' }}>
        {/* шапка: кто и где сейчас */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 16px 12px' }}>
          <div style={{ width: 42, height: 42, borderRadius: '50%', background: 'var(--blue-light)', color: 'var(--blue)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600, fontSize: 15, flexShrink: 0 }}>{initials}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{profile?.full_name || 'Пользователь'}</div>
            <div style={{ fontSize: 12, color: 'var(--text-hint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Сейчас: {where}</div>
          </div>
          <button type="button" aria-label="Закрыть" onClick={close} style={{ width: 34, height: 34, borderRadius: 17, border: 'none', background: 'var(--bg2)', color: 'var(--text-muted)', fontSize: 18, padding: 0, cursor: 'pointer' }}>×</button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain', padding: '0 10px 16px' }}>
          {!data && <div style={{ fontSize: 12, color: 'var(--text-hint)', padding: '6px 8px' }}>Загружаем…</div>}
          {sections.map((s, si) => {
            const closed = !!shut[s.id]
            return (
              <div key={s.id} style={{ marginTop: si ? 6 : 0, opacity: k, transform: `translate3d(${(1 - k) * -24 * (1 + si * 0.25)}px,0,0)`, transition: drag != null ? 'none' : `transform .5s ${EASE}, opacity .4s ${EASE}` }}>
                <button type="button" onClick={() => setShut(m => ({ ...m, [s.id]: !closed }))}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 8px 6px', border: 'none', background: 'transparent', textAlign: 'left', cursor: 'pointer', color: 'var(--text)' }}>
                  <span style={{ color: 'var(--text-hint)' }}><Ico d={s.icon} size={18} /></span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 12, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title}</span>
                    {s.sub && <span style={{ display: 'block', fontSize: 11, color: 'var(--text-hint)' }}>{s.sub}</span>}
                  </span>
                  {closed && pill(s.badge)}
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="var(--text-hint)" strokeWidth="2" strokeLinecap="round" style={{ transform: closed ? 'rotate(-90deg)' : 'none', transition: `transform .3s ${EASE}` }}><path d="M6 9l6 6 6-6" /></svg>
                </button>
                {/* плавное сворачивание: высота через сетку 0fr ↔ 1fr */}
                <div style={{ display: 'grid', gridTemplateRows: closed ? '0fr' : '1fr', transition: `grid-template-rows .34s ${EASE}` }}>
                  <div style={{ overflow: 'hidden' }}>
                    {s.items.map(it => (
                      <button key={it.key || it.label} type="button" onClick={it.act} className="nav-item"
                        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '11px 12px', margin: '1px 0', borderRadius: 12, border: 'none', textAlign: 'left', cursor: 'pointer',
                          background: it.on ? 'var(--blue-light)' : it.hot ? 'var(--amber-light)' : 'transparent', color: it.on ? 'var(--blue)' : 'var(--text)', fontSize: 15, fontWeight: it.on ? 600 : 400 }}>
                        <Ico d={it.icon} />
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: it.sub ? 'normal' : 'nowrap', fontSize: it.sub ? 14 : undefined, fontWeight: it.hot ? 500 : undefined }}>{it.label}</span>
                          {it.sub && <span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-hint)', fontWeight: 400, marginTop: 1 }}>{it.sub}</span>}
                        </span>
                        {pill(it.badge)}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
        {/* внизу меню — обучение: интерактивные туры для клиента и производства */}
        <div style={{ padding: '6px 10px 10px', borderTop: '0.5px solid var(--border)', opacity: k }}>
          <UiScaleRow />
          <button type="button" onClick={() => go('/help')} className="nav-item"
            style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '11px 12px', borderRadius: 12, border: 'none', textAlign: 'left', cursor: 'pointer',
              background: pathname === '/help' ? 'var(--blue-light)' : 'transparent', color: pathname === '/help' ? 'var(--blue)' : 'var(--text)', fontSize: 15, fontWeight: pathname === '/help' ? 600 : 400 }}>
            <span style={{ width: 22, height: 22, borderRadius: 11, border: '1.6px solid currentColor', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, flexShrink: 0 }}>?</span>
            <span style={{ flex: 1 }}>Обучение</span>
            <span style={{ fontSize: 11.5, color: 'var(--text-hint)' }}>видео и туры</span>
          </button>
          <div title={APP_COMMIT ? `сборка ${APP_COMMIT}` : undefined} style={{ fontSize: 11, color: 'var(--text-hint)', textAlign: 'center', marginTop: 4 }}>
            RaskroyPro · {appVersionText()} · раскрой {NESTING_VERSION}
          </div>
        </div>
      </nav>
    </div>
  </>,
    document.body,
  )
}

// «Размер текста и кнопок» — ползунок масштаба интерфейса под свой телефон (src/lib/uiScale.js)
function UiScaleRow() {
  const [v, setV] = useState(() => getUiScale())
  if (!isTouchDevice()) return null                 // на компьютере — Ctrl + / Ctrl −
  const pct = Math.round(v * 100)
  const step = d => setV(setUiScale(v + d))
  const b = { width: 40, height: 40, borderRadius: 20, border: '0.5px solid var(--border-md)', background: 'var(--bg2)', color: 'var(--text)', fontSize: 18, padding: 0, cursor: 'pointer', flexShrink: 0 }
  return (
    <div style={{ padding: '6px 12px 8px' }}>
      <div style={{ display: 'flex', alignItems: 'center', fontSize: 13, color: 'var(--text-muted)', marginBottom: 4 }}>
        <span style={{ flex: 1 }}>Размер текста и кнопок</span>
        <span style={{ fontWeight: 600, color: 'var(--text)' }}>{pct}%</span>
        {pct !== 100 && <button type="button" onClick={() => setV(setUiScale(1))} style={{ marginLeft: 8, border: 'none', background: 'transparent', color: 'var(--blue)', fontSize: 12, cursor: 'pointer', padding: 0 }}>сброс</button>}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button type="button" aria-label="Мельче" onClick={() => step(-0.05)} disabled={v <= UI_SCALE_MIN + 0.001} style={{ ...b, fontSize: 13 }}>A−</button>
        <input type="range" min={UI_SCALE_MIN * 100} max={UI_SCALE_MAX * 100} step={5} value={pct}
          onChange={e => setV(Number(e.target.value) / 100)} onPointerUp={e => setV(setUiScale(Number(e.target.value) / 100))} onTouchEnd={e => setV(setUiScale(Number(e.target.value) / 100))} onKeyUp={e => setV(setUiScale(Number(e.target.value) / 100))}
          style={{ flex: 1, minWidth: 0 }} />
        <button type="button" aria-label="Крупнее" onClick={() => step(0.05)} disabled={v >= UI_SCALE_MAX - 0.001} style={b}>A+</button>
      </div>
    </div>
  )
}
