// Мастер-аккаунт: тихий просмотр заказов пользователя («👁 Заказы пользователя» из сообщений / «Пользователей»).
// Пока режим включён, запись в заказы (orders) не уходит в базу: можно открыть его заказ, покроить на его
// настройках, пересчитать — пользователь ничего не увидит, его заказ не меняется. Выход — «Выйти из просмотра».
const KEY = 'peekUser'
export function getPeek() { try { return JSON.parse(sessionStorage.getItem(KEY) || 'null') } catch { return null } }
export function setPeek(v) {
  try { v ? sessionStorage.setItem(KEY, JSON.stringify(v)) : sessionStorage.removeItem(KEY) } catch { /* без памяти */ }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('peek'))
}
/** Запрос к базе, который в режиме просмотра не выполняется: изменения заказов и функции производства над ними */
export function peekBlocked(url, method) {
  if (!getPeek()) return false
  const m = String(method || 'GET').toUpperCase()
  if (m === 'GET' || m === 'HEAD') return false
  const u = String(url || '')
  return /\/rest\/v1\/orders(\?|$)/.test(u) || /\/rest\/v1\/rpc\/production_(save|order|return)/.test(u)
}
