// Рабочие места производства (см. migration_workplaces.sql): сотрудники по приглашению, полномочия, назначение заказов.
import { supabase } from './supabase'

export const WP_SQL_HINT = 'Рабочие места ещё не включены в базе: выполните migration_workplaces.sql в Supabase (SQL Editor) — один раз.'
// полномочия сотрудника: [ключ, название, пояснение]
export const PERMS = [
  ['all', 'Начальник производства', 'видит все заказы, принимает их и назначает сотрудникам'],
  ['status', 'Статусы заказа', 'принять, исполнен, вернуть на доработку — в своих заказах'],
  ['cnc', 'Управляющие программы', 'G-код раскроя и XML присадки'],
  ['labels', 'Бирки', 'печать бирок и файлы маркировки'],
  ['prices', 'Цены', 'видеть цены, стоимость заказа и итоги'],
]
export const permsText = p => (p?.all ? 'начальник производства' + (p.prices ? ', цены' : '') : PERMS.filter(([k]) => k !== 'all' && p?.[k]).map(([, l]) => l.toLowerCase()).join(', ') || 'только просмотр своих заказов')

const call = async (fn, args) => {
  const { data, error } = await supabase.rpc(fn, args)
  if (!error) return { data }
  const m = String(error.message || '')
  if (/function|schema cache|PGRST202/i.test(m)) return { error: WP_SQL_HINT, missing: true }
  const known = { 'invite: used': 'Это приглашение уже принял другой человек. Попросите новую ссылку.', 'invite: expired': 'Срок приглашения истёк. Попросите новую ссылку.',
    'invite: not found': 'Приглашение не найдено — проверьте ссылку.', 'invite: own production': 'Это ваше собственное производство.', 'no production': 'Сначала зарегистрируйте производство.',
    'not a member': 'Этот человек не сотрудник вашего производства.', 'not allowed': 'Нет прав на это действие.' }
  const k = Object.keys(known).find(x => m.includes(x))
  return { error: k ? known[k] : m }
}

export const myWorkplaces = () => call('my_workplaces')
export const createInvite = (name, phone, perms) => call('create_invite', { p_name: name || '', p_phone: phone || '', p_perms: perms || {} })
export const inviteInfo = code => call('invite_info', { p_code: code })
export const acceptInvite = code => call('accept_invite', { p_code: code })
export const membersList = () => call('production_members_list')
export const setMember = (userId, { name = null, perms = null, active = null } = {}) => call('set_member', { p_user: userId, p_name: name, p_perms: perms, p_active: active })
export const removeMember = userId => call('remove_member', { p_user: userId })
export const cancelInvite = code => call('cancel_invite', { p_code: code })
export const assignOrder = (orderId, userId, on) => call('assign_order', { p_order: orderId, p_user: userId, p_on: !!on })
export const orderWorkers = orderId => call('order_workers_of', { p_order: orderId })
export const myOrderPerms = orderId => call('my_order_perms', { p_order: orderId })
export const inviteUrl = code => `${window.location.origin}/join/${code}`

// приглашение, открытое до входа: запоминаем, чтобы после входа / регистрации вернуться на него
const KEY = 'pendingInvite'
export const savePendingInvite = code => { try { localStorage.setItem(KEY, code) } catch { /* без памяти */ } }
export const pendingInvite = () => { try { return localStorage.getItem(KEY) || '' } catch { return '' } }
export const clearPendingInvite = () => { try { localStorage.removeItem(KEY) } catch { /* без памяти */ } }
