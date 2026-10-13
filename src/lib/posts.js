// Рабочие посты производства (см. migration_posts.sql): техпроцесс, по которому заказ идёт как по канбану.
import { supabase } from './supabase'
import { ruleOf, defaultRule, stageParts, loadOrderParts } from './stageParts'

export const POSTS_SQL_HINT = 'Рабочие посты ещё не включены в базе: выполните migration_posts.sql в Supabase (SQL Editor) — один раз.'
export const POST_PRESETS = ['Раскрой', 'Кромление', 'Присадка', 'Сборка', 'Упаковка', 'Доставка']
export const STAGE_LABEL = { waiting: 'ждёт', queued: 'новый', accepted: 'в работе', done: 'выполнено', skipped: 'пропущен' }

const call = async (fn, args) => {
  const { data, error } = await supabase.rpc(fn, args)
  if (!error) return { data }
  const m = String(error.message || '')
  if (/post_page/i.test(m) && /function|schema cache|PGRST202/i.test(m)) return { error: 'Ссылка на пост ещё не включена в базе: выполните migration_post_link.sql в Supabase (SQL Editor) — один раз.', missing: true }
  if (/function|schema cache|PGRST202|order_stages|production_posts/i.test(m)) return { error: POSTS_SQL_HINT, missing: true }
  if (m.includes('not allowed')) return { error: 'Нет прав на это действие.' }
  if (m.includes('stage: not queued')) return { error: 'Этот заказ уже принял другой сотрудник.' }
  if (m.includes('stage: not active')) return { error: 'Этап уже выполнен.' }
  if (m.includes('stage: members only')) return { error: 'Принять заказ на этом посту могут только закреплённые за ним сотрудники.' }
  if (m.includes('stage: accept first')) return { error: 'Сначала нажмите «Принять» — потом «Выполнено».' }
  return { error: m }
}

export const postsList = () => call('posts_list')
export const savePost = (id, name, active = null) => call('save_post', { p_id: id || null, p_name: name || '', p_active: active })
export const deletePost = id => call('delete_post', { p_id: id })
export const orderPosts = ids => call('order_posts', { p_ids: ids })
export const setPostMembers = (postId, users) => call('set_post_members', { p_post: postId, p_users: users })
export const stageAccept = id => call('stage_accept', { p_stage: id })
export const stageDone = id => call('stage_done', { p_stage: id })
export const stageSkip = id => call('stage_skip', { p_stage: id })
export const stageBack = orderId => call('stage_back', { p_order: orderId })
export const startOrderStages = orderId => call('start_order_stages', { p_order: orderId })
export const orderStages = orderId => call('order_stages_of', { p_order: orderId })
export const myPostQueue = () => call('my_post_queue')
/** Один пост по ссылке /post/<id>: { post, queue } — только своим (сотрудник поста, владелец, начальник) */
export const postPage = id => call('post_page', { p_post: id })
export const postLink = id => `${window.location.origin}/post/${id}`
export const productionStageMap = () => call('production_stage_map')

// Операции заказа (migration_stage_ops.sql): галочки постов «по галочке» и пропуск постов без деталей
const OPS_HINT = 'Галочки операций ещё не включены в базе: выполните migration_stage_ops.sql в Supabase (SQL Editor) — один раз.'
export async function orderOps(orderId) { const r = await call('order_ops_of', { p_order: orderId }); return r.missing ? { error: OPS_HINT, missing: true } : r }
export async function setOrderOp(orderId, postId, on) { const r = await call('set_order_op', { p_order: orderId, p_post: postId, p_on: !!on }); return r.missing ? { error: OPS_HINT } : r }
/**
 * Пропустить посты кромления / присадки, для которых у заказа нет деталей (нет кромки — кромление не нужно, нет присадки —
 * присадка не нужна). Решается по деталям заказа и правилу поста. -> сколько постов пропущено
 */
export async function planStages(orderId) {
  const st = await orderStages(orderId)
  // вид поста: по его правилу, а если «без списка деталей» — по названию (кромление / присадка): нужен ли пост, решают детали заказа
  const kindOf = s => { const r = ruleOf(s.rule, s.name); if (['edge', 'drill'].includes(r.list)) return r; const d = defaultRule(s.name); return ['edge', 'drill'].includes(d.list) ? d : null }
  const open = (st.data || []).filter(s => (s.status === 'waiting' || s.status === 'queued') && !Number(s.scanned) && kindOf(s))
  if (!open.length) return 0
  const d = await loadOrderParts(orderId)
  // деталей не видно (нет доступа или ещё не загрузились) — ничего не пропускаем: иначе заказ проскочит посты
  if (!d.order || !d.rows.length) return 0
  const empty = open.filter(s => { try { return !stageParts(d.order, d.rows, kindOf(s)).length } catch { return false } }).map(s => s.post_id).filter(Boolean)
  if (!empty.length) return 0
  // база сама перепроверяет: сколько деталей видело приложение, есть ли кромка, не «без списка деталей» ли пост
  const r = await call('stage_auto_skip_v2', { p_order: orderId, p_posts: empty, p_seen: d.rows.length })
  return r.error ? 0 : Number(r.data) || 0
}

/** Сколько прошло: «25 мин», «3 ч 10 мин», «2 дн 4 ч» */
export function since(from, to = null) {
  if (!from) return ''
  const m = Math.max(0, Math.round(((to ? new Date(to) : new Date()) - new Date(from)) / 60000))
  if (m < 60) return `${m} мин`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} ч${m % 60 ? ` ${m % 60} мин` : ''}`
  return `${Math.floor(h / 24)} дн${h % 24 ? ` ${h % 24} ч` : ''}`
}
export const clock = v => (v ? new Date(v).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '')

/** Доска техпроцесса (migration_production_board.sql): { posts, items (заказы на постах), idle (принят, не пущен) } */
export async function productionBoard(prodId = null) {
  const r = await call('production_board', { p_prod: prodId })
  if (r.missing) return { error: 'Доска техпроцесса ещё не включена в базе: выполните migration_production_board.sql в Supabase (SQL Editor) — один раз.', missing: true }
  return r
}

/** Вернуть заказ на выбранный пройденный пост (migration_stage_return.sql); старой базе — на предыдущий */
export async function stageReturn(orderId, stageId) {
  const r = await call('stage_return', { p_order: orderId, p_stage: stageId })
  if (r.missing) return stageBack(orderId)
  return r
}

/** Перенести заказ на пост (канбан, migration_stage_move.sql) -> { data: 'ok' | 'same' | 'no_stage' } | { error } */
export async function stageMove(orderId, postId) {
  const r = await call('stage_move', { p_order: orderId, p_post: postId })
  if (r.missing) return { error: 'Перенос заказов по доске ещё не включён в базе: выполните migration_stage_move.sql в Supabase (SQL Editor) — один раз.' }
  return r
}

const LOG_HINT = 'Журнал техпроцесса ещё не включён в базе: выполните migration_stage_log.sql в Supabase (SQL Editor) — один раз.'
/** Отменить «Принять» на посту (migration_stage_log.sql) */
export async function stageUnaccept(stageId) { const r = await call('stage_unaccept', { p_stage: stageId }); return r.missing ? { error: LOG_HINT } : r }
/** Журнал движения заказа по постам: [{ kind, post, at, who, me }] | null — нет доступа */
export async function orderStageLog(orderId) { const r = await call('order_stage_log', { p_order: orderId }); return r.missing ? { error: LOG_HINT, missing: true } : r }
export const STAGES_UNFINISHED = 'Заказ ещё идёт по техпроцессу: «Исполнен» ставится сам, когда выполнен последний пост.'

/** Вернуть заказ (и исполненный) в техпроцесс на выбранный пост (migration_stage_reopen.sql) */
export async function stageReopen(orderId, stageId) {
  const r = await call('stage_reopen', { p_order: orderId, p_stage: stageId })
  if (r.missing) return { error: 'Возврат в техпроцесс ещё не включён в базе: выполните migration_stage_reopen.sql в Supabase (SQL Editor) — один раз.' }
  return r
}
