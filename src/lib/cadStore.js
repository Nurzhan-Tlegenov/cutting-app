// Проекты конструктора: таблица cad_projects (migration_cad_projects.sql).
// Пока таблицы в базе нет — проекты хранятся в браузере (localStorage), чтобы можно было работать сразу.
import { supabase } from './supabase'

export const CAD_SQL_HINT = 'Проекты пока хранятся только на этом устройстве: выполните migration_cad_projects.sql в Supabase (SQL Editor) — один раз, и они будут сохраняться в аккаунте.'
const isMissing = e => /cad_projects|PGRST205|42P01|schema cache/i.test(`${e?.message || ''} ${e?.code || ''}`)
const lsKey = uid => 'cadProjects:' + (uid || 'anon')
const lsRead = uid => { try { return JSON.parse(localStorage.getItem(lsKey(uid)) || '[]') } catch { return [] } }
const lsWrite = (uid, list) => { try { localStorage.setItem(lsKey(uid), JSON.stringify(list)) } catch { /* место кончилось */ } }
let local = false
export const isLocal = () => local

/** -> [{ id, name, updated_at }] */
export async function listProjects(uid) {
  const { data, error } = await supabase.from('cad_projects').select('id, name, updated_at').order('updated_at', { ascending: false })
  if (error) {
    if (!isMissing(error)) throw error
    local = true
    return lsRead(uid).map(({ id, name, updated_at }) => ({ id, name, updated_at })).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
  }
  local = false
  return data || []
}

export async function loadProject(uid, id) {
  if (!local) {
    const { data, error } = await supabase.from('cad_projects').select('id, name, data, updated_at').eq('id', id).maybeSingle()
    if (!error) return data ? { ...data.data, id: data.id, name: data.name } : null
    if (!isMissing(error)) throw error
    local = true
  }
  const x = lsRead(uid).find(p => p.id === id)
  return x ? { ...x.data, id: x.id, name: x.name } : null
}

/** project — { id?, name, ... } -> id */
export async function saveProject(uid, project) {
  const { id, ...data } = project
  const now = new Date().toISOString()
  if (!local) {
    const row = { name: project.name || 'Проект', data, updated_at: now }
    const q = id && !String(id).startsWith('l_')
      ? supabase.from('cad_projects').update(row).eq('id', id).select('id').single()
      : supabase.from('cad_projects').insert(row).select('id').single()
    const { data: r, error } = await q
    if (!error) return r.id
    if (!isMissing(error)) throw error
    local = true
  }
  const list = lsRead(uid)
  const lid = id || 'l_' + Math.random().toString(36).slice(2, 10)
  const rec = { id: lid, name: project.name || 'Проект', data, updated_at: now }
  lsWrite(uid, [rec, ...list.filter(p => p.id !== lid)])
  return lid
}

export async function deleteProject(uid, id) {
  if (!local && !String(id).startsWith('l_')) {
    const { error } = await supabase.from('cad_projects').delete().eq('id', id)
    if (!error) return
    if (!isMissing(error)) throw error
  }
  lsWrite(uid, lsRead(uid).filter(p => p.id !== id))
}
