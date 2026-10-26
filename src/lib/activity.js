// Вовлечённость пользователей (migration_activity.sql): отметка «пользователь в приложении», просмотры новостей,
// рейтинг активности для мастер-аккаунта.
import { supabase } from './supabase'

const isMissing = e => /PGRST202|PGRST205|42883|42P01|schema cache|Could not find the function/i.test(String(e?.message || '') + ' ' + String(e?.code || ''))
export const ACTIVITY_SQL_HINT = 'Активность пока не включена в базе: выполните migration_activity.sql в Supabase (SQL Editor) — один раз.'
const call = async (fn, args) => {
  try {
    const { data, error } = await supabase.rpc(fn, args)
    if (error) return { error: isMissing(error) ? ACTIVITY_SQL_HINT : error.message, missing: isMissing(error) }
    return { data }
  } catch (e) { return { error: String(e?.message || e) } }
}

// «Пользователь здесь» — не чаще раза в полчаса с одного устройства (сколько дней заходил и когда был последний раз)
const EVERY = 30 * 60 * 1000
let off = false   // база ещё без функции — не дёргаем её до перезапуска
export function touchActivity(userId) {
  if (!userId || off) return
  const key = 'act_ping_' + userId
  let last = 0
  try { last = Number(localStorage.getItem(key)) || 0 } catch { /* хранилище недоступно */ }
  if (Date.now() - last < EVERY) return
  try { localStorage.setItem(key, String(Date.now())) } catch { /* хранилище недоступно */ }
  call('touch_activity').then(r => { if (r.missing) off = true })
}

/** Пользователь увидел новости в «Сообщениях» */
export function markNewsSeen(ids) {
  if (!ids?.length) return
  call('mark_news_seen', { p_ids: ids })
}

/** Мастер: просмотры новостей -> { data: { byId: Map(id -> { viewers, audience }), users } } | { error, missing } */
export async function adminNewsViews() {
  const r = await call('admin_news_views')
  if (r.error) return r
  const byId = new Map((r.data?.news || []).map(n => [n.id, { viewers: n.viewers || [], audience: n.audience || 0 }]))
  return { data: { byId, users: r.data?.users || 0 } }
}

/** Мастер: активность пользователей за последние days дней (0 — за всё время) */
export const adminActivity = days => call('admin_activity', { p_days: days })

// Баллы рейтинга: дни в приложении и то, что человек сделал
export const SCORE = { days: 3, orders: 5, submitted: 5, parts: 0.05, messages: 2, news_seen: 1, received: 4, done: 4, stage_marks: 0.5 }
export const scoreOf = u => Math.round(Object.entries(SCORE).reduce((a, [k, w]) => a + (Number(u[k]) || 0) * w, 0))

/** Когда человек последний раз был в приложении (что из известного позже) */
export const lastSeenOf = u => [u.last_seen, u.last_sign_in_at, u.last_order_at].filter(Boolean).sort().pop() || null

/** Статус: active — заходил за 7 дней, rare — за 30, sleep — давно, never — не заходил после регистрации */
export function statusOf(u) {
  const t = lastSeenOf(u)
  if (!t) return 'never'
  const d = (Date.now() - new Date(t).getTime()) / 86400000
  return d <= 7 ? 'active' : d <= 30 ? 'rare' : 'sleep'
}
export const STATUS = {
  active: ['Активный', 'var(--teal)', 'var(--teal-light)'],
  rare: ['Заходит редко', 'var(--amber)', 'var(--amber-light)'],
  sleep: ['Неактивный', 'var(--text-muted)', 'var(--bg2)'],
  never: ['Не заходил', 'var(--danger)', 'var(--danger-light)'],
}
