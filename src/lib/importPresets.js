// Сохранённые настройки колонок импорта Excel/CSV («Свойство на бирку», длина, кромка…).
// Колонки запоминаются по названию в шапке, а не по номеру: если в следующем файле колонки переставлены
// или добавлены новые — назначение всё равно встанет на свои колонки. Файл без шапки — по номерам колонок.
// Хранятся за аккаунтом (userSettings.importPresets), настроек может быть несколько.
import { MULTI_ROLES } from './importDetails'

const cell = v => String(v ?? '').trim()
const norm = s => cell(s).toLowerCase().replace(/\s+/g, ' ')

/** Название колонки ci в шапке (как в окне импорта: строка шапки, а если пусто — строка над ней) */
export const headerOf = (rows, headerRow, ci) => (headerRow < 0 ? '' : cell(rows[headerRow]?.[ci]) || cell(rows[headerRow - 1]?.[ci]))

/** Настройка из текущего выбора колонок */
export function makePreset(name, rows, headerRow, roles) {
  const width = Math.max(roles.length, rows[0]?.length || 0)
  const cols = []
  for (let ci = 0; ci < width; ci++) {
    const h = headerOf(rows, headerRow, ci)
    if (h) cols.push({ h, role: roles[ci] || '' })
  }
  return { id: Math.random().toString(36).slice(2, 10), name: String(name || '').trim().slice(0, 60) || 'Настройка', headerRow, cols, roles: [...roles], at: Date.now() }
}

/** Сколько колонок настройки нашлось в шапке файла (0 — не подходит) */
export function presetMatch(p, rows, headerRow) {
  if (!p) return 0
  if (headerRow < 0 || !p.cols?.length) return p.headerRow < 0 && (p.roles || []).length === (rows[0]?.length || 0) ? 1 : 0
  const have = new Set()
  for (let ci = 0; ci < (rows[0]?.length || 0); ci++) { const h = norm(headerOf(rows, headerRow, ci)); if (h) have.add(h) }
  return p.cols.filter(c => have.has(norm(c.h))).length
}

/** Назначение колонок по настройке. Колонки, которых в настройке нет (новые), остаются как распознало приложение */
export function applyPreset(p, rows, headerRow, autoRoles) {
  const width = Math.max(autoRoles.length, rows[0]?.length || 0)
  if (headerRow < 0 || !p.cols?.length) return Array.from({ length: width }, (_, ci) => p.roles?.[ci] ?? autoRoles[ci] ?? '')
  const byName = new Map(p.cols.map(c => [norm(c.h), c.role]))
  const out = Array.from({ length: width }, (_, ci) => {
    const k = norm(headerOf(rows, headerRow, ci))
    return k && byName.has(k) ? byName.get(k) : (autoRoles[ci] || '')
  })
  // одиночная роль (длина, ширина…) — только у одной колонки: приоритет у колонки из настройки
  const seen = new Set()
  out.forEach((r, ci) => {
    if (!r || MULTI_ROLES.has(r)) return
    const fromPreset = byName.has(norm(headerOf(rows, headerRow, ci)))
    if (seen.has(r)) { if (!fromPreset) out[ci] = '' } else seen.add(r)
  })
  return out
}

/** Лучшая подходящая настройка для файла: больше совпавших колонок, при равенстве — последняя применённая */
export function bestPreset(list, rows, headerRow) {
  let best = null, bestScore = 0
  for (const p of list || []) {
    const s = presetMatch(p, rows, headerRow)
    const need = headerRow < 0 ? 1 : Math.max(2, Math.ceil((p.cols?.length || 0) * 0.6))   // большая часть колонок на месте
    if (s >= need && (s > bestScore || (s === bestScore && (p.at || 0) > (best?.at || 0)))) { best = p; bestScore = s }
  }
  return best
}
