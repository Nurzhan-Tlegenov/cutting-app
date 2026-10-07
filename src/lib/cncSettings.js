// Настройки ЧПУ: постпроцессоры (станок + команды), база инструментов, обработка контуров.
// Идут за аккаунтом (user_metadata.app_settings.cnc) — как и остальные настройки пользователя.
import { getUserSettings, saveUserSettings, fetchUserSettings } from './userSettings'

const uid = () => Math.random().toString(36).slice(2, 9)

export const DEFAULT_POST = () => ({
  id: uid(), name: 'Стандартный G-код (ISO)',
  // А. Основные
  fieldX: 2100, fieldY: 3000,     // рабочее поле станка
  originX: 0, originY: 0,         // начало обработки (смещение нуля листа)
  endX: 0, endY: 0,               // конечное положение: куда уходит шпиндель в конце программы
  zRef: 'bottom',                 // от какой пласти считается Z: 'bottom' — от стола (нижняя), 'top' — от верхней
  safeZ: 25,                      // высота безопасности от жертвенного стола
  rapid: 20000,                   // холостые перемещения, мм/мин (для расчёта времени)
  millOver: 0.15,                 // заглубление фрезы в жертвенный стол при сквозном резе
  drillOver: 1,                   // заглубление сверла при сквозном отверстии
  ext: 'nc',
  labelTable: false,              // у станка есть стол бирковки: вместе с G-кодом делаются файлы бирок (List.xml, Label_N.cyc, картинки)
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
  // контур детали: smallArea — мелкая деталь (м²), режется первой; passes — число проходов;
  // sideAllow / leftover — припуск первого прохода по контуру и остаток по глубине; smallOnly — проходы только для мелких
  outer: { tool: '', dir: 'ccw', entry: 'ramp', angle: 45, smallFirst: true, smallArea: 0.12, passes: 1, sideAllow: 0, leftover: 0.5, smallOnly: false },
  cutout: { tool: '', dir: 'cw', entry: 'ramp', angle: 45 },   // контур выреза (фреза идёт внутри)
  groove: { tool: '', entry: 'straight', angle: 45 },          // пазы: общий инструмент и вход фрезы
  grooves: {},                                                 // пазы по слоям (ширина × глубина): слой -> { tool }
  pockets: {},                                                 // выемки: слой -> { tool, mode: 'zigzag' | 'spiral', dir: 'cw' | 'ccw', entry, angle }
  holes: {},                                                   // отверстия: слой -> { tool, d, depth }
})

// shared — общие постпроцессоры (мастер-аккаунт отметил «для всех»): видны каждому, в настройках пользователя не хранятся
export function normalizeCnc(raw, shared = []) {
  const c = raw && typeof raw === 'object' ? raw : {}
  const own = (Array.isArray(c.posts) ? c.posts : []).filter(p => p && !p.shared).map(p => ({ ...DEFAULT_POST(), ...p }))
  const mine = own.length ? own : (shared.length ? [] : [DEFAULT_POST()])
  const posts = [...mine, ...shared.filter(p => !mine.some(q => q.id === p.id)).map(p => ({ ...DEFAULT_POST(), ...p, shared: true }))]
  const tools = Array.isArray(c.tools) ? c.tools : []
  const d = DEFAULT_OPS(), o = c.ops || {}
  return {
    posts, post: posts.some(p => p.id === c.post) ? c.post : posts[0].id, tools,
    ops: { outer: { ...d.outer, ...o.outer }, cutout: { ...d.cutout, ...o.cutout }, groove: { ...d.groove, ...o.groove }, grooves: { ...o.grooves }, pockets: { ...o.pockets }, holes: { ...o.holes } },
  }
}

export const getCnc = user => normalizeCnc(getUserSettings(user).cnc)
export const fetchCnc = async user => normalizeCnc((await fetchUserSettings(user)).cnc)
export const withShared = (cnc, shared) => normalizeCnc(cnc, shared)
export const saveCnc = (cnc, user) => saveUserSettings({ cnc: { ...cnc, posts: cnc.posts.filter(p => !p.shared) } }, user)
export const activePost = cnc => cnc.posts.find(p => p.id === cnc.post) || cnc.posts[0]
export const newId = uid
