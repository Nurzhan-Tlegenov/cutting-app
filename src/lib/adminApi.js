// Администратор: список пользователей и регистрация по запросу (см. migration_users_admin.sql).
// Всё идёт через функции базы — они сами проверяют, что вызывает администратор.
import { supabase } from './supabase'

const isMissing = e => /PGRST202|42883|schema cache|Could not find the function/i.test(String(e?.message || '') + ' ' + String(e?.code || ''))
export const ADMIN_SQL_HINT = 'Выполните migration_users_admin.sql в Supabase (SQL Editor) — один раз.'

async function call(fn, args) {
  try {
    const { data, error } = await supabase.rpc(fn, args)
    if (error) return { error: isMissing(error) ? ADMIN_SQL_HINT : /not admin|permission denied/i.test(error.message) ? 'Этот раздел доступен только администратору.' : error.message, missing: isMissing(error) }
    return { data }
  } catch (e) { return { error: String(e?.message || e) } }
}

/** Открыта ли свободная регистрация. Если база ещё не обновлена — считаем, что открыта (как было раньше). */
export async function signupOpen() {
  const r = await call('signup_open')
  return r.error ? true : r.data !== false
}
/** Заявка на регистрацию. -> { status: 'open' | 'new' | 'approved' | 'rejected' } | { error } */
export async function requestSignup(name, phone, comment) {
  const r = await call('request_signup', { p_name: name || '', p_phone: phone || '', p_comment: comment || '' })
  if (r.error) return { error: /bad phone/.test(r.error) ? 'Проверьте номер телефона' : r.error }
  return { status: r.data }
}

export const adminUsers = () => call('admin_users')
export const adminRequests = () => call('admin_requests')
export const adminSetSignup = open => call('admin_set_signup', { p_open: !!open })
export const adminSetRequest = (id, status) => call('admin_set_request', { p_id: id, p_status: status })
export const adminAllowPhone = (phone, name) => call('admin_allow_phone', { p_phone: phone, p_name: name || '' })
export const adminSetRole = (userId, role) => call('admin_set_role', { p_user: userId, p_role: role })
