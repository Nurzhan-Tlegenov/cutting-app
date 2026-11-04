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
