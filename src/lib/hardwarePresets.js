// База фурнитуры пользователя (таблица hardware_presets, своя у каждого аккаунта) —
// те же записи, что в редакторе контура во вкладке «Присадка».
import { supabase } from './supabase'

/** -> [{ id, name, face, edge }] */
export async function loadHardwarePresets(userId) {
  if (!userId) return []
  try {
    const { data, error } = await supabase.from('hardware_presets').select('*').eq('user_id', userId).order('created_at', { ascending: true })
    if (error) return []
    return (data || []).map(row => ({ id: row.id, name: row.name, face: row.face || null, edge: row.edge || null }))
  } catch { return [] }
}

/** Записать крепёж в базу (по названию: есть такой — обновить). -> { id, name, face, edge } или null */
export async function saveHardwarePreset(userId, name, spec) {
  if (!userId || !name) return null
  try {
    const { data: found } = await supabase.from('hardware_presets').select('id').eq('user_id', userId).ilike('name', name).limit(1)
    const q = found?.[0]?.id
      ? supabase.from('hardware_presets').update({ name, face: spec.face, edge: spec.edge }).eq('id', found[0].id).eq('user_id', userId)
      : supabase.from('hardware_presets').insert({ user_id: userId, name, face: spec.face, edge: spec.edge })
    const { data, error } = await q.select().single()
    if (error || !data) return null
    return { id: data.id, name: data.name, face: data.face || null, edge: data.edge || null }
  } catch { return null }
}
