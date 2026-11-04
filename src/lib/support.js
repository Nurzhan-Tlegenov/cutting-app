// Техподдержка (claude/support-spec.md, migration_support_staff.sql):
//   роль «Поддержка» — отдельная таблица support_staff, выдаёт мастер-аккаунт; is_support() — сотрудник или мастер.
import { useEffect, useState } from 'react'
import { supabase } from './supabase'

export const SUPPORT_SQL_HINT = 'Роль «Поддержка» ещё не включена в базе: выполните migration_support_staff.sql в Supabase (SQL Editor) — один раз.'
const isMissing = e => /PGRST202|PGRST205|42883|42P01|schema cache|Could not find the function/i.test(String(e?.message || '') + ' ' + String(e?.code || ''))

async function call(fn, args) {
  try {
    const { data, error } = await supabase.rpc(fn, args)
    if (error) return isMissing(error) ? { error: SUPPORT_SQL_HINT, missing: true } : { error: /not admin|not support/.test(String(error.message)) ? 'Нет прав на это действие.' : String(error.message || error) }
    return { data }
  } catch (e) { return { error: String(e?.message || e) } }
}

// ── «я в поддержке?» — один запрос на аккаунт, общий для меню и страниц
let mine = { uid: null, promise: null }
const subs = new Set()
function loadMine(uid) {
  if (mine.uid !== uid || !mine.promise) mine = { uid, promise: uid ? call('is_support').then(r => !!r.data) : Promise.resolve(false) }
  return mine.promise
}
/** true — сотрудник поддержки или мастер-аккаунт; undefined — ещё проверяем */
export function useIsSupport(uid) {
  const [on, setOn] = useState(undefined)
  useEffect(() => {
    let alive = true
    const set = v => { if (alive) setOn(v) }
    subs.add(set)
    loadMine(uid).then(set)
    return () => { alive = false; subs.delete(set) }
  }, [uid])
  return on
}
const recheckMine = () => { const uid = mine.uid; mine = { uid, promise: null }; loadMine(uid).then(v => subs.forEach(f => f(v))) }

// ── мастер-аккаунт: кто в поддержке (общий список для «Пользователей» и карточки пользователя)
let staffCache = null
const staffSubs = new Set()
const loadStaff = () => (staffCache = call('admin_support_staff'))
/** -> { data: [{ user_id, full_name, phone, country, city, active, added_at }] } | { error, missing } | undefined (грузим) */
export function useSupportStaff(on = true) {
  const [st, setSt] = useState(undefined)
  useEffect(() => {
    if (!on) return
    let alive = true
    const set = v => { if (alive) setSt(v) }
    staffSubs.add(set)
    ;(staffCache || loadStaff()).then(set)
    return () => { alive = false; staffSubs.delete(set) }
  }, [on])
  return st
}
/** Выдать / снять роль «Поддержка» */
export async function setSupport(userId, on) {
  const r = await call('admin_set_support', { p_user: userId, p_on: !!on })
  if (!r.error) { loadStaff().then(v => staffSubs.forEach(f => f(v))); recheckMine() }
  return r
}
export const isStaffIn = (st, id) => !!st?.data?.some(x => x.user_id === id && x.active)

/** Команда поддержки (имена): [{ user_id, full_name, master }] */
export const supportTeam = () => call('support_team')

// ═══════════ Доска обращений (migration_support_board.sql) ═══════════
export const BOARD_SQL_HINT = 'Доска обращений ещё не включена в базе: выполните migration_support_board.sql в Supabase (SQL Editor) — один раз.'
const callB = async (fn, args) => {
  const r = await call(fn, args)
  if (r.missing) return { error: BOARD_SQL_HINT, missing: true }
  if (r.error) {
    const m = r.error
    return { error: /card closed/.test(m) ? 'Карточка уже закрыта — обновите доску.' : /need reason/.test(m) ? 'Напишите причину для пользователя.'
      : /dev is master/.test(m) ? '«Нужен разработчик» закрывает мастер-аккаунт.' : /has open/.test(m) ? 'У этого пользователя уже есть открытая карточка — объедините с ней.'
        : /not in team/.test(m) ? 'Этот человек не в команде поддержки.' : m }
  }
  return r
}
/** Колонки доски: [ключ, название, цвет] */
export const SUPPORT_COLS = [
  ['new', 'Новые', 'var(--blue)'],
  ['work', 'В работе', 'var(--amber)'],
  ['details', 'Нужны подробности', 'var(--gray)'],
  ['dev', 'Нужен разработчик', '#7B1FA2'],
]
export const SUPPORT_CLOSED = { done: ['Сделано', 'var(--teal)'], rejected: ['Не берём', 'var(--danger)'] }
/** Шаблоны «Нужны подробности» */
export const DETAIL_TEMPLATES = [
  ['Программа', 'Пришлите, пожалуйста, программу со станка (файл), которая получилась, и напишите, что в ней не так.'],
  ['Модель', 'Пришлите, пожалуйста, модель или файл, из которого делали заказ (Базис, К3, SketchUp, DXF…).'],
  ['Скриншот', 'Пришлите, пожалуйста, скриншот экрана, где видна ошибка.'],
  ['Номер заказа', 'Напишите, пожалуйста, номер заказа (например, 261104_001).'],
  ['По шагам', 'Опишите, пожалуйста, по шагам: что делали, что ожидали увидеть и что получилось.'],
]
export const DONE_TEXT = 'Готово, исправили. Обновите приложение (закройте и откройте снова). Если что-то ещё не так — напишите нам.'

export const supportBoard = (archive = false, q = '') => callB('support_board', { p_archive: !!archive, p_q: q || '' })
export const supportCard = id => callB('support_card', { p_id: id })
export const supportFile = msgId => callB('support_file', { p_msg: msgId })
export const supportTake = id => callB('support_take', { p_id: id })
export const supportAssign = (id, userId) => callB('support_assign', { p_id: id, p_user: userId })
export const supportMove = (id, status, note = '') => callB('support_move', { p_id: id, p_status: status, p_note: note || '' })
export const supportReply = (id, body, status = null) => callB('support_reply', { p_id: id, p_body: body, p_status: status })
export const supportSummary = (id, text) => callB('support_set_summary', { p_id: id, p_text: text || '' })
export const supportDevDecide = (id, take, note = '') => callB('support_dev_decide', { p_id: id, p_take: !!take, p_note: note || '' })
export const supportClose = (id, status, message = '') => callB('support_close', { p_id: id, p_status: status, p_message: message || '' })
export const supportReopen = id => callB('support_reopen', { p_id: id })
export const supportMerge = (from, into) => callB('support_merge', { p_from: from, p_into: into })
export const supportArchiveLegacy = () => callB('support_archive_legacy')

/** «5 мин», «3 ч», «вчера», «12.10» */
export function supAgo(v) {
  if (!v) return ''
  const s = (Date.now() - new Date(v).getTime()) / 1000
  if (s < 60) return 'сейчас'
  if (s < 3600) return `${Math.floor(s / 60)} мин`
  if (s < 86400) return `${Math.floor(s / 3600)} ч`
  if (s < 172800) return 'вчера'
  return new Date(v).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })
}
