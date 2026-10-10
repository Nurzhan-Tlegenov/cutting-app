// Уведомления внутри приложения: что произошло, пока человек не смотрел.
//   мастер-аккаунт — новые заявки на регистрацию, запросы на восстановление пароля, производства, ждущие подтверждения;
//   производство   — новые заявки (заказы, оформленные на него);
//   заказчик       — у его заказа изменился статус (принят, исполнен, возвращён на доработку…).
// Проверяется, пока приложение открыто (раз в 45 секунд и при возвращении в него). Отдельной базы не нужно:
// всё берётся из уже существующих списков; «какой статус заказа я уже видел» хранится на этом устройстве.
import { supabase } from './supabase'
import { myPostQueue } from './posts'
import { adminRequests, adminPasswordResets, adminUsers } from './adminApi'
import { myProduction, productionOrders } from './productionApi'
import { STATUS_LABELS, orderTitle } from './orderUtils'

const seenKey = uid => `orderSeen:${uid || ''}`
function readSeen(uid) { try { return JSON.parse(localStorage.getItem(seenKey(uid)) || 'null') } catch { return null } }
function writeSeen(uid, map) {
  try { localStorage.setItem(seenKey(uid), JSON.stringify(Object.fromEntries(Object.entries(map).slice(-400)))) } catch { /* без памяти */ }
}

/** Какие из заказов заказчика сменили статус с прошлого просмотра: Set id. Первый запуск — ничего (запоминаем как есть). */
export function changedOrders(uid, orders) {
  const seen = readSeen(uid)
  if (!seen) { writeSeen(uid, Object.fromEntries((orders || []).map(o => [o.id, o.status]))); return new Set() }
  const out = new Set()
  let grew = false
  for (const o of orders || []) {
    if (!(o.id in seen)) { seen[o.id] = o.status; grew = true }          // новый заказ — свой же, не новость
    else if (seen[o.id] !== o.status) out.add(o.id)
  }
  if (grew) writeSeen(uid, seen)
  return out
}
/** Статусы заказов просмотрены (список заказов открыт) */
export function markOrdersSeen(uid, orders) {
  const seen = readSeen(uid) || {}
  for (const o of orders || []) seen[o.id] = o.status
  writeSeen(uid, seen)
  window.dispatchEvent(new Event('notices-seen'))
}

/**
 * -> { users, production, orders, list: [{ key, text, to }] }
 *   users — сколько ждёт решения мастера; production — новых заявок производству; orders — заказов со сменившимся статусом.
 */
export async function fetchNotices({ user, isMaster }) {
  const res = { users: 0, production: 0, orders: 0, list: [] }
  if (!user?.id) return res
  const jobs = []
  if (isMaster) {
    jobs.push(Promise.all([adminRequests(), adminPasswordResets(), adminUsers()]).then(([rq, pr, us]) => {
      const reqs = (rq.data || []).filter(r => r.status === 'new')
      const resets = (pr.data || []).filter(r => r.status === 'new')
      const prods = (us.data || []).filter(u => u.production_status === 'pending')
      res.users = reqs.length + resets.length + prods.length
      for (const r of reqs) res.list.push({ key: `rq:${r.id}`, text: `Новая заявка на регистрацию: ${r.full_name || r.phone || 'без имени'}`, to: '/users' })
      for (const r of resets) res.list.push({ key: `pw:${r.id}`, text: `Просят восстановить пароль: ${r.full_name || r.phone || '+' + r.digits}`, to: '/users' })
      for (const u of prods) res.list.push({ key: `pd:${u.production_id}`, text: `Производство ждёт подтверждения: ${u.production_name || u.full_name || ''}`, to: '/users' })
    }).catch(() => {}))
  }
  jobs.push(myProduction(user.id).then(async p => {
    if (!p || (p.status ?? 'approved') !== 'approved') return
    const r = await productionOrders()
    const fresh = (r.data || []).filter(o => o.status === 'new' && !o.own)
    res.production = fresh.length
    for (const o of fresh) res.list.push({ key: `po:${o.id}`, text: `Новая заявка: ${orderTitle(o)}${o.client_name ? ' — ' + o.client_name : ''}`, to: '/production' })
  }).catch(() => {}))
  // заказы, пришедшие на мои рабочие посты (сотрудник производства): новые — ещё никто не принял
  jobs.push(myPostQueue().then(r => {
    const fresh = (r.data || []).filter(q => q.status === 'queued')
    res.production += fresh.length
    for (const q of fresh) res.list.push({ key: `ps:${q.stage_id}`, text: `Новый заказ на посту «${q.post_name}»: ${orderTitle(q)}`, to: '/production' })
  }).catch(() => {}))
  jobs.push(supabase.from('orders').select('id,status,order_name,order_number,created_at').eq('user_id', user.id).then(({ data }) => {
    const changed = changedOrders(user.id, data || [])
    res.orders = changed.size
    for (const o of data || []) if (changed.has(o.id)) res.list.push({ key: `os:${o.id}:${o.status}`, text: `Заказ «${orderTitle(o)}»: ${(STATUS_LABELS[o.status] || o.status).toLowerCase()}`, to: `/orders/${o.id}` })
  }).catch(() => {}))
  await Promise.all(jobs)
  return res
}
