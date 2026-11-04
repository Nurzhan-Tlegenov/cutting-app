// Мастер-аккаунт: справочник пользователей для карточки «кто это» (UserCard.jsx) — один на страницу, обновляется раз в минуту.
import { useEffect, useState } from 'react'
import { adminUsers, adminMemberships, adminRefBy } from './adminApi'
import { adminPostAccess, adminUserPosts } from './postAccess'

const TTL = 60000
let cache = null          // { at, promise }
const subs = new Set()

async function loadDirectory() {
  const [u, m, pa, up, rb] = await Promise.all([adminUsers(), adminMemberships(), adminPostAccess(), adminUserPosts(), adminRefBy()])
  const users = new Map((u.error ? [] : u.data || []).map(x => [x.id, x]))
  const members = new Map()
  for (const x of m.error ? [] : m.data || []) { if (!members.has(x.user_id)) members.set(x.user_id, []); members.get(x.user_id).push(x) }
  const granted = new Map(), asks = new Map(), usage = new Map()
  for (const p of pa.error ? [] : pa.data?.posts || []) for (const a of p.access || []) {
    if (!granted.has(a.user_id)) granted.set(a.user_id, [])
    granted.get(a.user_id).push({ name: p.name, kind: p.kind, at: a.granted_at, runs: a.runs, last: a.last })
  }
  for (const q of pa.error ? [] : pa.data?.requests || []) { if (!asks.has(q.user_id)) asks.set(q.user_id, []); asks.get(q.user_id).push(q) }
  for (const x of pa.error ? [] : pa.data?.usage || []) usage.set(x.user_id, x)
  const own = new Map((up.error ? [] : up.data || []).map(x => [x.user_id, x]))
  // кто кого пригласил: refBy — пригласивший этого пользователя, invited — кого пригласил он
  const refBy = new Map(), invited = new Map()
  for (const x of rb.error ? [] : rb.data || []) {
    refBy.set(x.user_id, x)
    if (!invited.has(x.ref_by)) invited.set(x.ref_by, [])
    invited.get(x.ref_by).push(x)
  }
  return { users, members, granted, asks, usage, own, refBy, invited, error: u.error || '', noMembers: !!m.error }
}

/** Справочник пользователей для мастер-аккаунта (общий для всей страницы, обновляется не чаще раза в минуту) */
export function useAdminDirectory(on = true) {
  const [dir, setDir] = useState(null)
  useEffect(() => {
    if (!on) return
    let alive = true
    const set = d => { if (alive) setDir(d) }
    subs.add(set)
    if (!cache || Date.now() - cache.at > TTL) cache = { at: Date.now(), promise: loadDirectory() }
    cache.promise.then(set)
    return () => { alive = false; subs.delete(set) }
  }, [on])
  return dir
}
export function refreshAdminDirectory() {
  cache = { at: Date.now(), promise: loadDirectory() }
  cache.promise.then(d => subs.forEach(f => f(d)))
}


const place = (...v) => v.map(x => String(x || '').trim()).filter(Boolean).join(', ')
const isProd = u => !!u?.production_id && (u.production_status ?? 'approved') === 'approved'

/** Кто это — одной строкой: производство / сотрудник / клиент · страна, город */
export function whoLine(dir, id) {
  const u = dir?.users.get(id)
  if (!u) return ''
  const work = (dir.members.get(id) || []).filter(m => m.active !== false)
  const role = isProd(u) ? `🏭 ${u.production_name || 'производство'}`
    : u.production_id ? `🏭 ${u.production_name || 'производство'} (${u.production_status === 'rejected' ? 'отклонено' : 'ждёт подтверждения'})`
      : work.length ? `👷 сотрудник: ${work.map(m => m.production_name).join(', ')}`
        : u.role === 'admin' ? 'администратор' : 'клиент'
  return [role, place(u.country || u.production_country, u.city || u.production_city)].filter(Boolean).join(' · ')
}

