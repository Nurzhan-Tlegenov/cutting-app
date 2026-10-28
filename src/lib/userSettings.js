// Настройки пользователя, которые идут за аккаунтом (а не за устройством):
// подпись на карте раскроя и параметры раскроя по умолчанию для новых заказов
// (формат листа, диаметр фрезы/рез, отступы, мелкие детали, время, способ).
// Хранятся в таблице user_settings (migration_user_settings.sql). Раньше лежали в данных входа
// (user_metadata.app_settings), но те входят в ключ входа, который уходит с каждым запросом: настройки
// выросли — сервер стал отвечать «Bad Request» на всё. Пока миграции нет — по-старому. Копия в localStorage — на случай офлайна.
import { useState, useCallback, useEffect } from 'react'
import { supabase } from './supabase'

// Колонки orders, которые запоминаем как «мои настройки» для следующих заказов
export const ORDER_DEFAULT_COLS = [
  'sheet_length', 'sheet_width', 'kerf_width',
  'margin_top', 'margin_right', 'margin_bottom', 'margin_left',
  'small_parts_to_center', 'small_parts_max_square_side', 'small_parts_max_side',
  'small_parts_edge_gap', 'small_parts_end_side',
  'optimize_seconds', 'cutting_method',
]

let cache = null, cacheUid = undefined, timer = null, dirty = false
const lsKey = uid => 'appSettings:' + (uid || 'anon')
let row = { uid: undefined, data: null }       // настройки из таблицы
let tableOk = null                               // null — ещё не знаем, false — таблицы нет (миграция не выполнена)
const missing = e => /user_settings|schema cache|PGRST20|42P01/i.test(String(e?.message || '') + ' ' + String(e?.code || ''))

/** Загрузить настройки из таблицы (при входе). Старые настройки из данных входа переносятся в таблицу и оттуда убираются. */
export async function loadUserSettings(user) {
  const uid = user?.id
  if (!uid) return
  const { data, error } = await supabase.from('user_settings').select('data').eq('user_id', uid).maybeSingle()
  if (error) { if (missing(error)) tableOk = false; return }
  tableOk = true
  const legacy = user?.user_metadata?.app_settings
  let d = data?.data || null
  if (!d && legacy && typeof legacy === 'object') {
    const { error: e2 } = await supabase.from('user_settings').upsert({ user_id: uid, data: legacy, updated_at: new Date().toISOString() })
    if (!e2) d = legacy
  }
  if (d && legacy) supabase.auth.updateUser({ data: { app_settings: null } }).then(() => {}, () => {})   // ключ входа — снова маленький
  row = { uid, data: d || {} }
  if (!dirty) cache = null
}

function read(user) {
  const uid = user?.id || null
  if (cache && cacheUid === uid) return cache
  let local
  try { local = JSON.parse(localStorage.getItem(lsKey(uid)) || '{}') || {} } catch { local = {} }
  const remote = (row.uid === uid && row.data) || (tableOk ? {} : user?.user_metadata?.app_settings) || {}
  cache = { ...local, ...remote, orderDefaults: { ...(local.orderDefaults || {}), ...(remote.orderDefaults || {}) } }
  cacheUid = uid
  return cache
}

export function getUserSettings(user) { return read(user) }

export function saveUserSettings(patch, user) {
  const cur = read(user)
  cache = { ...cur, ...patch, orderDefaults: { ...(cur.orderDefaults || {}), ...(patch.orderDefaults || {}) } }
  try { localStorage.setItem(lsKey(cacheUid), JSON.stringify(cache)) } catch { /* без локальной копии */ }
  if (!cacheUid) return
  dirty = true
  clearTimeout(timer)
  const snapshot = cache
  timer = setTimeout(async () => {
    try {
      if (tableOk !== false) {
        const { error } = await supabase.from('user_settings').upsert({ user_id: cacheUid, data: snapshot, updated_at: new Date().toISOString() })
        if (!error) { row = { uid: cacheUid, data: snapshot }; tableOk = true; if (cache === snapshot) dirty = false; return }
        if (!missing(error)) return                 // сеть и т. п. — повторим при следующем изменении
        tableOk = false
      }
      await supabase.auth.updateUser({ data: { app_settings: snapshot } }); if (cache === snapshot) dirty = false
    } catch { /* повторим при следующем изменении */ }
  }, 800)
}

/** Свежие настройки с сервера (их могли поменять на другом устройстве) */
export async function fetchUserSettings(user) {
  if (dirty) return read(user)          // свои несохранённые правки новее
  try {
    const { data } = await supabase.auth.getUser()
    const u = data?.user
    if (u) { await loadUserSettings(u); cache = null; return read(u) }
  } catch { /* офлайн — берём то, что есть */ }
  return read(user)
}

/** Запомнить параметры заказа как настройки по умолчанию */
export function rememberOrderDefaults(patch, user) {
  const picked = {}
  for (const col of ORDER_DEFAULT_COLS) if (col in patch && patch[col] !== undefined) picked[col] = patch[col]
  if (Object.keys(picked).length) saveUserSettings({ orderDefaults: picked }, user)
}

/** Что писать на деталях карты раскроя — выбор идёт за аккаунтом */
export function useLabelMode(user) {
  const [mode, setMode] = useState(() => read(user).nestLabelMode || 'name')
  const uid = user?.id || null
  useEffect(() => {
    let alive = true
    fetchUserSettings(user).then(s => { if (alive) setMode(s.nestLabelMode || 'name') })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid])
  const set = useCallback(v => { setMode(v); saveUserSettings({ nestLabelMode: v }, user) }, [user])
  return [mode, set]
}
