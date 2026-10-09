// Администратор: список пользователей и регистрация по запросу (см. migration_users_admin.sql).
// Всё идёт через функции базы — они сами проверяют, что вызывает администратор.
import { supabase } from './supabase'

const isMissing = e => /PGRST202|42883|schema cache|Could not find the function/i.test(String(e?.message || '') + ' ' + String(e?.code || ''))
export const ADMIN_SQL_HINT = 'База ещё не обновлена: выполните migration_security_all.sql в Supabase (SQL Editor) — один раз.'

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

// ── Восстановление пароля через администратора (migration_password_reset.sql) ──
export const RESET_SQL_HINT = 'Восстановление пароля ещё не включено: выполните migration_password_reset.sql в Supabase (SQL Editor) — один раз.'
/** С экрана входа: попросить код для смены пароля. -> {} | { error } */
export async function requestPasswordReset(phone) {
  const r = await call('request_password_reset', { p_phone: phone || '' })
  if (r.error) return { error: r.missing ? 'Восстановление пароля пока недоступно. Напишите нам.' : /bad phone/.test(r.error) ? 'Проверьте номер телефона' : r.error }
  return {}
}
/** С экрана входа: новый пароль по коду. -> { ok: true } | { error } */
export async function confirmPasswordReset(phone, code, password) {
  const r = await call('confirm_password_reset', { p_phone: phone || '', p_code: code || '', p_password: password || '' })
  if (r.error) return { error: r.missing ? 'Восстановление пароля пока недоступно. Напишите нам.' : r.error }
  const text = { bad: 'Код не подошёл. Проверьте номер телефона и код.', expired: 'Срок действия кода вышел. Запросите новый.', blocked: 'Слишком много попыток. Попросите выдать новый код.', weak: 'Пароль минимум 6 символов' }[r.data]
  return text ? { error: text } : { ok: true }
}
export const adminPasswordResets = () => call('admin_password_resets')
export const adminIssueReset = id => call('admin_issue_reset', { p_id: id })
export const adminCloseReset = id => call('admin_close_reset', { p_id: id })

// Заказы всех производств со статистикой и зафиксированной ценой — только администратору (migration_admin_productions.sql)
export const PRODS_SQL_HINT = 'Раздел ещё не включён: выполните migration_admin_productions.sql в Supabase (SQL Editor) — один раз.'
export async function adminProductionOrders() {
  try {
    const { data, error } = await supabase.rpc('admin_production_orders')
    if (error) return { error: /PGRST202|42883|schema cache|Could not find the function/i.test(`${error.message} ${error.code}`) ? PRODS_SQL_HINT : error.message }
    return { data: data || [] }
  } catch (e) { return { error: String(e?.message || e) } }
}
