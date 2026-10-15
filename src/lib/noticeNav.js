// Переход по уведомлению прямо к нужной строке: заявка на регистрацию, заявка производству, заказ, заказ на посту.
// Ссылка вида /go?t=<куда>&f=<что подсветить>[&p=<производство>] — одинаковая для плашки в приложении,
// списка «Новое» в меню и push-уведомления в шторке телефона.
import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { openOwnProduction, openWorkplace } from './workplaces'

// куда ведёт уведомление — подпись, чтобы было понятно заранее
export const WHERE = {
  users: 'Пользователи и регистрация',
  own: 'Производство → Заказы → Новые',
  work: 'Рабочее место → Мои посты',
  client: 'Клиент → Мои заказы',
  msg: 'Сообщения',
}
export const goUrl = (t, f, p) => `/go?t=${t}${f ? `&f=${encodeURIComponent(f)}` : ''}${p ? `&p=${encodeURIComponent(p)}` : ''}`
export const whereOf = url => { try { return WHERE[new URL(url, window.location.origin).searchParams.get('t')] || '' } catch { return '' } }

const setKept = (key, v) => { try { sessionStorage.setItem(`keep:/production#${key}`, JSON.stringify(v)) } catch { /* без памяти */ } }

/** Разбор ссылки /go: переключает кабинет и отдаёт, куда перейти и что подсветить */
export function resolveGo(search, setCabinet) {
  const q = new URLSearchParams(search)
  const t = q.get('t'), f = q.get('f') || null, p = q.get('p') || ''
  if (t === 'users') return ['/users', { focus: f }]
  if (t === 'own') { openOwnProduction(); setKept('prodTab', 'orders'); setCabinet('production'); return ['/production', { tab: 'orders', focus: f }] }
  if (t === 'work') { openWorkplace(p); setKept('wTab', 'posts'); setCabinet('production'); return ['/production', { wtab: 'posts', focus: f }] }
  if (t === 'client') { setCabinet('client'); return ['/orders', { focus: f }] }
  if (t === 'msg') return ['/messages', null]
  return ['/', null]
}

/** Найти строку с data-focus, прокрутить к ней и подсветить. Строка может появиться не сразу — ждём до 8 с */
export function flashFocus(id) {
  if (!id) return
  const sel = `[data-focus="${(window.CSS?.escape || (s => s))(id)}"]`
  let n = 0
  const tick = () => {
    const el = document.querySelector(sel)
    if (!el) { if (++n < 53) setTimeout(tick, 150); return }
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    el.classList.remove('notice-flash'); void el.offsetWidth; el.classList.add('notice-flash')
    setTimeout(() => el.classList.remove('notice-flash'), 3200)
  }
  tick()
}

/** На странице: пришли по уведомлению — подсветить нужную строку (onFocus — например, развернуть карточку) */
export function useNoticeFocus(onFocus) {
  const loc = useLocation()
  useEffect(() => {
    const f = loc.state?.focus
    if (!f) return
    onFocus?.(f)
    flashFocus(f)
  }, [loc.key])   // eslint-disable-line react-hooks/exhaustive-deps
}
