// Постпроцессоры по запросу (migration_post_access.sql): опубликованные мастером постпроцессоры видят только те,
// кому он их выдал; остальным — каталог названий и запрос. Каждый выпуск программ записывается (кто, каким постпроцессором).
import { supabase } from './supabase'

export const POST_ACCESS_HINT = 'Выдача постпроцессоров ещё не включена в базе: выполните migration_post_access.sql в Supabase (SQL Editor) — один раз.'
const missing = e => /post_requests|post_usage|shared_post_access|post_catalog|admin_post_access|admin_find_users|schema cache|PGRST20|42P01|42883/i.test(String(e?.message || '') + ' ' + String(e?.code || ''))
const res = ({ data, error }) => (error ? { error: missing(error) ? POST_ACCESS_HINT : error.message, missing: missing(error) } : { data })
export const PROGRAM_MAX = 300000            // знаков примера программы в запросе

/** Каталог: [{ id, name, kind, mine, asked }] — названия опубликованных постпроцессоров, без команд */
export const postCatalog = async () => res(await supabase.rpc('post_catalog'))

/** Запрос постпроцессора: { post_id?, machine, controller, note, program_name, program } */
export async function requestPost(r) {
  const program = r.program ? String(r.program).slice(0, PROGRAM_MAX) : null
  return res(await supabase.from('post_requests').insert({ post_id: r.post_id || null, machine: r.machine || null, controller: r.controller || null, note: r.note || null, program_name: r.program_name || null, program }))
}

/** Записать выпуск программ: posts — [{ id, name, kind, shared }]. Ошибка (нет таблицы) работу не останавливает */
export function logPostUse(user, posts, { orderId = null, sheets = null } = {}) {
  if (!user?.id) return
  const rows = posts.filter(Boolean).map(p => ({ user_id: user.id, post_id: p.id || null, post_name: p.name || '', kind: p.kind || 'router', shared: !!p.shared, order_id: orderId, sheets }))
  if (rows.length) supabase.from('post_usage').insert(rows).then(() => {}, () => {})
}

// ─── мастер-аккаунт ─────────────────────────────────────────────────────────
export const adminPostAccess = async () => res(await supabase.rpc('admin_post_access'))
export const adminFindUsers = async q => res(await supabase.rpc('admin_find_users', { p_q: q }))
export const grantPost = async (postId, userId, note = null) => res(await supabase.from('shared_post_access').upsert({ post_id: postId, user_id: userId, note }))
export const revokePost = async (postId, userId) => res(await supabase.from('shared_post_access').delete().eq('post_id', postId).eq('user_id', userId))
export const setRequestStatus = async (id, status) => res(await supabase.from('post_requests').update({ status, done_at: status === 'new' ? null : new Date().toISOString() }).eq('id', id))
export const deleteRequest = async id => res(await supabase.from('post_requests').delete().eq('id', id))
export const requestProgram = async id => res(await supabase.rpc('admin_post_request_program', { p_id: id }))
