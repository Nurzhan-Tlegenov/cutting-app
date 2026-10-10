// Рабочие посты производства (см. migration_posts.sql): техпроцесс, по которому заказ идёт как по канбану.
import { supabase } from './supabase'

export const POSTS_SQL_HINT = 'Рабочие посты ещё не включены в базе: выполните migration_posts.sql в Supabase (SQL Editor) — один раз.'
export const POST_PRESETS = ['Раскрой', 'Кромление', 'Присадка', 'Сборка', 'Упаковка', 'Доставка']
export const STAGE_LABEL = { waiting: 'ждёт', queued: 'новый', accepted: 'в работе', done: 'выполнено', skipped: 'пропущен' }

const call = async (fn, args) => {
  const { data, error } = await supabase.rpc(fn, args)
  if (!error) return { data }
  const m = String(error.message || '')
  if (/function|schema cache|PGRST202|order_stages|production_posts/i.test(m)) return { error: POSTS_SQL_HINT, missing: true }
  if (m.includes('not allowed')) return { error: 'Нет прав на это действие.' }
  if (m.includes('stage: not queued')) return { error: 'Этот заказ уже принял другой сотрудник.' }
  if (m.includes('stage: not active')) return { error: 'Этап уже выполнен.' }
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
export const productionStageMap = () => call('production_stage_map')

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
