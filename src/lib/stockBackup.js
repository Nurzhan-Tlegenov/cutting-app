// Автокопия склада остатков в файл Excel на компьютере производства (резервная копия у себя).
// Файл выбирают один раз; дальше приложение само перезаписывает его раз в N часов (по умолчанию 3), пока оно открыто.
// Пишет, только если на складе что-то поменялось, и в свободную минуту браузера — чтобы не тормозить работу.
// Работает в браузерах на основе Chromium на компьютере: Chrome, Edge, Яндекс.Браузер, Opera (File System Access API).
// В Firefox, Safari и на телефонах этого нет — там кнопка «⬇ В Excel».
import { supabase } from './supabase'
import { buildStockXlsx } from './stockExcel'

export const BACKUP_HOURS = [[1, 'каждый час'], [3, 'каждые 3 часа'], [6, 'каждые 6 часов'], [12, 'каждые 12 часов'], [24, 'раз в сутки'], [0, 'только вручную']]
export const DEFAULT_HOURS = 3
export const backupSupported = () => typeof window !== 'undefined' && 'showSaveFilePicker' in window && window.isSecureContext

const KEY = pid => `stockBackup:${pid}`
const LIST = 'stockBackupList'
export function backupConf(pid) { try { return JSON.parse(localStorage.getItem(KEY(pid)) || 'null') } catch { return null } }
function saveConf(pid, c) {
  try {
    if (c) localStorage.setItem(KEY(pid), JSON.stringify(c)); else localStorage.removeItem(KEY(pid))
    const l = new Set(JSON.parse(localStorage.getItem(LIST) || '[]')); if (c) l.add(pid); else l.delete(pid)
    localStorage.setItem(LIST, JSON.stringify([...l]))
  } catch { /* без памяти */ }
  window.dispatchEvent(new CustomEvent('stock-backup', { detail: pid }))
}
const configured = () => { try { return JSON.parse(localStorage.getItem(LIST) || '[]') } catch { return [] } }

// ── файл (ссылку на него) браузер хранит в IndexedDB ──
const db = () => new Promise((res, rej) => { const r = indexedDB.open('raskroy-backup', 1); r.onupgradeneeded = () => r.result.createObjectStore('h'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
async function idb(mode, fn) { const d = await db(); return new Promise((res, rej) => { const t = d.transaction('h', mode); const q = fn(t.objectStore('h')); t.oncomplete = () => res(q?.result); t.onerror = () => rej(t.error) }) }
const getHandle = pid => idb('readonly', s => s.get(pid)).catch(() => null)
const putHandle = (pid, h) => idb('readwrite', s => s.put(h, pid))
const delHandle = pid => idb('readwrite', s => s.delete(pid)).catch(() => null)

/** Выбрать файл (нажатие пользователя) и сразу сохранить копию */
export async function chooseBackupFile(pid, prodName, suggestedName) {
  const h = await window.showSaveFilePicker({ suggestedName, types: [{ description: 'Таблица Excel', accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] } }] })
  await putHandle(pid, h)
  const old = backupConf(pid)
  saveConf(pid, { hours: old?.hours ?? DEFAULT_HOURS, file: h.name, prodName, lastAt: null, sig: null })
  return runBackup(pid, { force: true })
}
export function setBackupHours(pid, hours) { const c = backupConf(pid); if (c) saveConf(pid, { ...c, hours }) }
export async function stopBackup(pid) { await delHandle(pid); saveConf(pid, null) }

/** Есть ли разрешение писать в файл. После перезапуска браузера его спрашивают снова — только по нажатию (ask=true). */
export async function backupPermission(pid, ask = false) {
  const h = await getHandle(pid)
  if (!h) return 'nofile'
  const opt = { mode: 'readwrite' }
  let p = await h.queryPermission?.(opt)
  if (p !== 'granted' && ask) p = await h.requestPermission?.(opt)
  return p || 'prompt'
}

/** Сохранить копию: { ok, skipped, error } */
export async function runBackup(pid, { force = false } = {}) {
  const c = backupConf(pid), h = await getHandle(pid)
  if (!c || !h) return { error: 'Файл автокопии не выбран.' }
  if ((await h.queryPermission?.({ mode: 'readwrite' })) !== 'granted') return { error: 'need-permission' }
  const [a, b] = await Promise.all([
    supabase.from('remnants').select('*').eq('production_id', pid).order('id').limit(20000),
    supabase.from('remnant_events').select('*').eq('production_id', pid).order('at', { ascending: false }).limit(20000),
  ])
  if (a.error || b.error) return { error: (a.error || b.error).message }
  const rows = a.data || [], ev = b.data || []
  const sig = `${rows.length}:${rows.reduce((m, r) => (r.updated_at > m ? r.updated_at : m), '')}:${ev.length}:${ev[0]?.id || 0}`
  const now = new Date().toISOString()
  if (!force && sig === c.sig) { saveConf(pid, { ...c, lastAt: now }); return { ok: true, skipped: true } }
  try {
    const buf = await buildStockXlsx(rows, ev)
    const w = await h.createWritable()
    await w.write(buf); await w.close()
  } catch (e) { return { error: String(e?.message || e) } }
  saveConf(pid, { ...backupConf(pid), lastAt: now, savedAt: now, sig })
  return { ok: true }
}

const due = c => c && c.hours > 0 && (!c.lastAt || Date.now() - new Date(c.lastAt).getTime() >= c.hours * 3600e3)
const idle = fn => (window.requestIdleCallback ? window.requestIdleCallback(fn, { timeout: 60e3 }) : setTimeout(fn, 2000))

/** Проверка раз в 10 минут: пора — сохраняем в свободную минуту. Запускается один раз на всё приложение. */
let started = false
export function startBackupTimer() {
  if (started || !backupSupported()) return
  started = true
  let busy = false
  const tick = () => {
    if (busy) return
    const list = configured().filter(pid => due(backupConf(pid)))
    if (!list.length) return
    busy = true
    idle(async () => {
      for (const pid of list) { try { await runBackup(pid) } catch { /* в следующий раз */ } }
      busy = false
    })
  }
  setTimeout(tick, 30e3)
  setInterval(tick, 10 * 60e3)
}
