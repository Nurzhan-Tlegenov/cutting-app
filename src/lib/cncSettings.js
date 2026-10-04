// Настройки ЧПУ: постпроцессоры (станок + команды), база инструментов, обработка контуров.
// Идут за аккаунтом (user_metadata.app_settings.cnc) — как и остальные настройки пользователя.
import { getUserSettings, saveUserSettings, fetchUserSettings } from './userSettings'

const uid = () => Math.random().toString(36).slice(2, 9)

export const DEFAULT_POST = () => ({
  id: uid(), name: 'Стандартный G-код (ISO)',
  // А. Основные
  fieldX: 2100, fieldY: 3000,     // рабочее поле станка
  originX: 0, originY: 0,         // начало обработки (смещение нуля листа)
  safeZ: 25,                      // высота безопасности от жертвенного стола
  rapid: 20000,                   // холостые перемещения, мм/мин (для расчёта времени)
  millOver: 0.15,                 // заглубление фрезы в жертвенный стол при сквозном резе
  drillOver: 1,                   // заглубление сверла при сквозном отверстии
  ext: 'nc',
  // Команды
  cmdStart: 'M16\nG54',
  cmdToolStart: 'G53 Z0\nM05\nM06 T{T}\nG43 H{T}\nM03 S{S}',
  cmdToolEnd: 'G53 Z0\nG54',
  cmdEnd: 'M05\nM30',
})

export const DEFAULT_MILL = () => ({
  id: uid(), type: 'mill', name: 'Компрессионная 6 мм', t: 1, d: 6, maxPass: 20, rpm: 18000, feed: 8000,
  inFeed: 3000, inLen: 30, outFeed: 2000, outLen: 50, step: 5,
})
export const DEFAULT_DRILL = () => ({ id: uid(), type: 'drill', name: 'Сверло 8 мм', t: 2, d: 8, rpm: 3500, feed: 2500 })

export const DEFAULT_OPS = () => ({
  outer: { tool: '', dir: 'ccw', entry: 'ramp', angle: 45 },   // контур детали
  cutout: { tool: '', dir: 'cw', entry: 'ramp', angle: 45 },   // контур выреза (фреза идёт внутри)
  groove: { tool: '' },                                        // пазы
  pockets: {},                                                 // выемки: слой -> { tool }
  holes: {},                                                   // отверстия: слой -> { tool, d, depth }
})

export function normalizeCnc(raw) {
  const c = raw && typeof raw === 'object' ? raw : {}
  const posts = Array.isArray(c.posts) && c.posts.length ? c.posts.map(p => ({ ...DEFAULT_POST(), ...p })) : [DEFAULT_POST()]
  const tools = Array.isArray(c.tools) ? c.tools : []
  const d = DEFAULT_OPS(), o = c.ops || {}
  return {
    posts, post: posts.some(p => p.id === c.post) ? c.post : posts[0].id, tools,
    ops: { outer: { ...d.outer, ...o.outer }, cutout: { ...d.cutout, ...o.cutout }, groove: { ...d.groove, ...o.groove }, pockets: { ...o.pockets }, holes: { ...o.holes } },
  }
}

export const getCnc = user => normalizeCnc(getUserSettings(user).cnc)
export const fetchCnc = async user => normalizeCnc((await fetchUserSettings(user)).cnc)
export const saveCnc = (cnc, user) => saveUserSettings({ cnc }, user)
export const activePost = cnc => cnc.posts.find(p => p.id === cnc.post) || cnc.posts[0]
export const newId = uid
