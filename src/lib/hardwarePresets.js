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
