// Мои задачи — канбан клиента (migration_tasks.sql): свои этапы-колонки, карточки с подзадачами, сроком, напоминанием
// и связью с заказом. Видит только сам пользователь; мастер-аккаунт — только чтение (статистика использования).
import { supabase } from './supabase'

export const TASKS_SQL_HINT = 'Задачи ещё не включены в базе: выполните migration_tasks.sql в Supabase (SQL Editor) — один раз.'
// этапы, с которыми доска создаётся в первый раз — потом их можно переименовать, переставить, удалить, добавить свои
export const DEFAULT_COLUMNS = ['Входящие', 'Замер', 'Закуп материала', 'В работе', 'Готово']
export const COLORS = ['#378ADD', '#1D9E75', '#BA7517', '#D85A30', '#7F77DD', '#888780']

const missing = e => /task_cards|task_columns|schema cache|does not exist|PGRST20/i.test(String(e?.message || ''))
const err = e => (missing(e) ? TASKS_SQL_HINT : String(e?.message || e || 'Ошибка'))
const uid = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36))
export const newItemId = uid

/** Доска пользователя: { columns, cards } | { error }. Своя пустая доска создаётся с этапами по умолчанию */
export async function loadBoard(userId, own = true) {
  const [c, k] = await Promise.all([
    supabase.from('task_columns').select('*').eq('user_id', userId).order('sort'),
    supabase.from('task_cards').select('*').eq('user_id', userId).is('archived_at', null).order('sort'),
  ])
  if (c.error || k.error) return { error: err(c.error || k.error), missing: missing(c.error || k.error) }
  let columns = c.data || []
  if (!columns.length && own) {
    const { data, error } = await supabase.from('task_columns').insert(DEFAULT_COLUMNS.map((name, i) => ({ name, sort: i + 1, color: COLORS[i % COLORS.length] }))).select('*')
    if (error) return { error: err(error) }
    columns = (data || []).sort((a, b) => a.sort - b.sort)
  }
  return { columns, cards: k.data || [] }
}

export async function addColumn(name, sort, color) {
  const { data, error } = await supabase.from('task_columns').insert({ name, sort, color }).select('*').single()
  return error ? { error: err(error) } : { data }
}
export async function updateColumn(id, patch) {
  const { error } = await supabase.from('task_columns').update(patch).eq('id', id)
  return error ? { error: err(error) } : {}
}
export async function deleteColumn(id) {
  const { error } = await supabase.from('task_columns').delete().eq('id', id)
  return error ? { error: err(error) } : {}
}
export async function addCard(card) {
  const { data, error } = await supabase.from('task_cards').insert(card).select('*').single()
  return error ? { error: err(error) } : { data }
}
export async function updateCard(id, patch) {
  const { data, error } = await supabase.from('task_cards').update(patch).eq('id', id).select('*').single()
  return error ? { error: err(error) } : { data }
}
export async function deleteCard(id) {
  const { error } = await supabase.from('task_cards').delete().eq('id', id)
  return error ? { error: err(error) } : {}
}
/** Привязать созданный заказ к задаче (из бланка заказа) */
export const linkOrder = (cardId, orderId) => updateCard(cardId, { order_id: orderId })

/** Заказы пользователя для привязки и статусы привязанных: Map id -> order */
export async function myOrders(userId) {
  const { data } = await supabase.from('orders').select('id, order_name, order_number, status, returned_at, created_at')
    .eq('user_id', userId).order('created_at', { ascending: false }).limit(200)
  return data || []
}
export async function ordersByIds(ids) {
  if (!ids.length) return []
  const { data } = await supabase.from('orders').select('id, order_name, order_number, status, returned_at, created_at').in('id', ids)
  return data || []
}

/** Подзадачи: { done, total } */
export function progress(card) {
  const list = Array.isArray(card?.checklist) ? card.checklist : []
  return { done: list.filter(x => x.done).length, total: list.length }
}

/** Срок: { text, tone: 'late' | 'today' | 'soon' | '' } */
export function dueInfo(card, now = new Date()) {
  if (!card?.due_at) return null
  const d = new Date(card.due_at)
  const day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((day(d) - day(now)) / 86400000)
  const hm = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  const timed = hm !== '00:00'
  const text = days === 0 ? `сегодня${timed ? ' ' + hm : ''}` : days === 1 ? `завтра${timed ? ' ' + hm : ''}` : days === -1 ? 'вчера'
    : d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' }) + (timed ? ' ' + hm : '')
  const late = !card.done_at && (timed ? d < now : days < 0)
  return { text, tone: card.done_at ? '' : late ? 'late' : days === 0 ? 'today' : days <= 2 ? 'soon' : '' }
}

/** Мастер-аккаунт: статистика задач */
export async function adminTaskStats(days) {
  const { data, error } = await supabase.rpc('admin_task_stats', { p_days: days })
  return error ? { error: /function|schema cache|PGRST202/i.test(error.message) ? TASKS_SQL_HINT : error.message } : { data }
}

// datetime-local <-> ISO
export const toLocalInput = v => {
  if (!v) return ''
  const d = new Date(v), p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}
export const fromLocalInput = s => (s ? new Date(s).toISOString() : null)
