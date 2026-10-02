// Свои текстуры материалов для 3D: картинка привязана к названию материала
// и идёт за аккаунтом (таблица material_textures, см.
// migration_material_textures.sql). Если таблицы ещё нет — картинки
// сохраняются только на этом устройстве (localStorage).
import { supabase } from './supabase'

const key = name => String(name || '').trim().toLowerCase()
const lsKey = uid => 'matTextures:' + (uid || 'anon')

function readLocal(uid) {
  try { return JSON.parse(localStorage.getItem(lsKey(uid)) || '{}') || {} } catch { return {} }
}
function writeLocal(uid, obj) {
  try { localStorage.setItem(lsKey(uid), JSON.stringify(obj)); return true } catch { return false }
}

/** -> { map: { ключ: { name, data, size, rot } }, cloud: true|false } */
export async function loadTextures(user) {
  const uid = user?.id || null
  const map = readLocal(uid)
  let cloud = false
  if (uid) {
    try {
      const { data, error } = await supabase.from('material_textures').select('name,data,size_mm,rot').eq('user_id', uid)
      if (!error && Array.isArray(data)) {
        cloud = true
        for (const r of data) map[key(r.name)] = { name: r.name, data: r.data, size: Number(r.size_mm) || 600, rot: !!r.rot }
      }
    } catch { cloud = false }
  }
  return { map, cloud }
}

/** tex = { data, size, rot } -> { ok, cloud } */
export async function saveTexture(user, name, tex) {
  const uid = user?.id || null
  if (uid) {
    try {
      const { error } = await supabase.from('material_textures')
        .upsert({ user_id: uid, name, data: tex.data, size_mm: tex.size, rot: !!tex.rot, updated_at: new Date().toISOString() }, { onConflict: 'user_id,name' })
      if (!error) return { ok: true, cloud: true }
    } catch { /* ниже — на устройство */ }
  }
  const all = readLocal(uid)
  all[key(name)] = { name, ...tex }
  return { ok: writeLocal(uid, all), cloud: false }
}

export async function deleteTexture(user, name) {
  const uid = user?.id || null
  if (uid) { try { await supabase.from('material_textures').delete().eq('user_id', uid).eq('name', name) } catch { /* нет таблицы */ } }
  const all = readLocal(uid)
  delete all[key(name)]
  writeLocal(uid, all)
}

export const textureKey = key

/** Картинка с телефона -> JPEG не больше max px по большей стороне (data URL) */
export function fileToTexture(file, max = 512) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height))
      const cv = document.createElement('canvas')
      cv.width = Math.max(1, Math.round(img.width * k)); cv.height = Math.max(1, Math.round(img.height * k))
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height)
      URL.revokeObjectURL(url)
      resolve(cv.toDataURL('image/jpeg', 0.82))
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Не удалось прочитать картинку')) }
    img.src = url
  })
}
