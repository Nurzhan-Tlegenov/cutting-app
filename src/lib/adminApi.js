// Администратор: список пользователей и регистрация по запросу (см. migration_users_admin.sql).
// Всё идёт через функции базы — они сами проверяют, что вызывает администратор.
import { supabase, SUPABASE_URL } from './supabase'

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
export async function requestSignup(name, phone, comment, country = '', city = '') {
  let r = await call('request_signup', { p_name: name || '', p_phone: phone || '', p_comment: comment || '', p_country: country || '', p_city: city || '' })
  // база ещё без страны и города в заявке — они уходят в комментарий, чтобы не потеряться
  if (r.error && /PGRST202|schema cache|Could not find the function|request_signup/i.test(r.error))
    r = await call('request_signup', { p_name: name || '', p_phone: phone || '', p_comment: [[country, city].filter(Boolean).join(', '), comment].filter(Boolean).join(' · ') })
  if (r.error) return { error: /bad phone/.test(r.error) ? 'Проверьте номер телефона' : r.error }
  return { status: r.data }
}

// ── Подтверждение номера (migration_phone_verify.sql, функция бота supabase/functions/tg-bot) ──
export const TG_BOT = 'RaskroyProBot'
export const tgStartLink = token => `https://t.me/${TG_BOT}?start=${token}`
export const VERIFY_SQL_HINT = 'Подтверждение номера ещё не включено: выполните migration_phone_verify.sql в Supabase (SQL Editor) — один раз.'

/** Заявка с выбором мессенджера. -> { status, registered, messenger, tg_token, verified, code_issued } | { error }
 *  База ещё без новой функции — заявка уходит по-старому (без подтверждения), чтобы человек не застрял. */
export async function requestSignup2(name, phone, comment, country, city, messenger) {
  const r = await call('request_signup2', { p_name: name || '', p_phone: phone || '', p_comment: comment || '', p_country: country || '', p_city: city || '', p_messenger: messenger })
  if (r.missing) { const old = await requestSignup(name, phone, comment, country, city); return old.error ? old : { status: old.status, legacy: true } }
  if (r.error) return { error: /bad phone/.test(r.error) ? 'Проверьте номер телефона' : r.error }
  return r.data || {}
}
/** Код из Telegram / WhatsApp перед регистрацией. -> { ok } | { error } */
export async function confirmSignupCode(phone, code) {
  const r = await call('confirm_signup_code', { p_phone: phone || '', p_code: code || '' })
  if (r.missing) return { ok: true }   // база ещё старая — код не требуется
  if (r.error) return { error: r.error }
  const text = { bad: 'Код не подошёл. Проверьте номер телефона и код.', expired: 'Срок действия кода вышел. Попросите администратора выдать новый.',
    blocked: 'Слишком много попыток. Попросите администратора выдать новый код.', nocode: 'Код ещё не выдан. Дождитесь сообщения с кодом.',
    registered: 'Этот номер уже зарегистрирован — войдите на вкладке «Вход».' }[r.data]
  return text ? { error: text } : { ok: true }
}
export const adminApproveRequest = id => call('admin_approve_request', { p_id: id })
/** Вызов функции бота (только мастер): { action: 'setup' } | { action: 'send_code', request_id } */
export async function tgBot(body) {
  // «Простой» запрос (text/plain, без заголовков авторизации): шлюз Supabase пропускает его так же, как сообщения Telegram,
  // а права мастера функция проверяет сама по токену входа в теле запроса.
  try {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token) return { error: 'Войдите заново' }
    const r = await fetch(`${SUPABASE_URL}/functions/v1/tg-bot`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ ...body, jwt: session.access_token }),
    })
    if (r.status === 404) return { error: 'Функция tg-bot не найдена в Supabase (Edge Functions)' }
    const data = await r.json().catch(() => null)
    if (!data) return { error: `Функция tg-bot ответила ${r.status}` }
    return data.error ? { error: { no_telegram: 'Номер ещё не подтверждён в Telegram — отправьте код в WhatsApp.', not_approved: 'Заявка не одобрена.' }[data.error] || data.error } : data
  } catch (e) { return { error: /Failed to fetch|NetworkError|Load failed/i.test(String(e?.message)) ? 'Нет связи с функцией tg-bot' : String(e?.message || e) } }
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
    return { data: data || [] }   // тестовые (excluded) — в суммы не идут, это решает страница
  } catch (e) { return { error: String(e?.message || e) } }
}
