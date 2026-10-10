// Настройки ЧПУ: постпроцессоры (станок + команды), база инструментов, обработка контуров.
// Идут за аккаунтом (user_metadata.app_settings.cnc) — как и остальные настройки пользователя.
import { getUserSettings, saveUserSettings, fetchUserSettings } from './userSettings'

const uid = () => Math.random().toString(36).slice(2, 9)

export const DEFAULT_POST = () => ({
  id: uid(), name: 'Стандартный G-код (ISO)',
  kind: 'router',                 // тип станка: 'router' — раскроечный фрезер (G-код по листам), 'drill6' — шестисторонний присадочный (XML по деталям)
  // А. Основные
  fieldX: 2100, fieldY: 3000,     // рабочее поле станка
  originX: 0, originY: 0,         // начало обработки (смещение нуля листа)
  endX: 0, endY: 0,               // конечное положение: куда уходит шпиндель в конце программы
  zRef: 'bottom',                 // от какой пласти считается Z: 'bottom' — от стола (нижняя), 'top' — от верхней
  safeZ: 25,                      // высота безопасности от жертвенного стола
  rapid: 20000,                   // холостые перемещения, мм/мин (для расчёта времени)
  millOver: 0.15,                 // заглубление фрезы в жертвенный стол при сквозном резе
  drillOver: 1,                   // заглубление сверла при сквозном отверстии
  arcs: 'lines',                 // скругления и дуги: 'lines' — мелкими отрезками G1 (отклонение до 0,005 мм), 'ij' — командами G2 / G3 с I, J
  ext: 'nc',
  folderTpl: '{ZAKAZ}',           // название папки заказа при сохранении (см. folderName)
  nameTpl: '{N}_{ZAKAZ}_{MAT}',   // из чего складывается название управляющей программы (см. programName)
  labelPos: 'center',             // где на детали клеится бирка: 'center' | 'bl' | 'br' | 'tl' | 'tr' (углы габарита детали на столе)
  labelDX: 0, labelDY: 0,         // коррекция точки наклейки бирки на маркировочном столе, мм (плюс и минус), см. buildLabelFiles
  labelTable: false,              // у станка есть маркировочный стол: вместе с G-кодом делаются файлы бирок (List.xml, Label_N.cyc, картинки)
  // Команды
  cmdStart: 'M16\nG54',
  cmdToolStart: 'G53 Z0\nM05\nM06 T{T}\nG43 H{T}\nM03 S{S}',
  cmdToolEnd: 'G53 Z0\nG54',
  cmdEnd: 'M05\nM30',
})

// Шестисторонний сверлильно-присадочный станок: программа — XML (формат SWJ), один файл на деталь (см. drill6Xml.js).
// Лицевая пласть — синхронно с фрезерным ЧПУ: сверху (Face 5), отдельной настройки нет.
export const DEFAULT_DRILL6 = () => ({
  ...DEFAULT_POST(), kind: 'drill6', name: 'Шестисторонний присадочный (XML)', ext: 'XML',
  nameTpl: '{NOMER}_{ZAKAZ}',     // начало названия файла; дальше — ^номер детали. Код детали должен быть уникален во всех заказах — поэтому с номером заказа
  folderTpl: '{ZAKAZ}',
  d6Tool: 'T2',                   // инструмент станка для пазов
  d6All: false,                   // выводить и детали без присадки
})
export const isDrill6 = p => p?.kind === 'drill6'
export const KINDS = [['router', 'Раскроечный фрезер (G-код)'], ['drill6', 'Шестисторонний присадочный (XML)']]

export const DEFAULT_MILL = () => ({
  id: uid(), type: 'mill', name: 'Компрессионная 6 мм', t: 1, d: 6, maxPass: 20, rpm: 18000, feed: 8000,
  inFeed: 3000, inLen: 30, outFeed: 2000, outLen: 50, step: 5,
})
export const DEFAULT_DRILL = () => ({ id: uid(), type: 'drill', name: 'Сверло 8 мм', t: 2, d: 8, rpm: 3500, feed: 2500 })

export const DEFAULT_OPS = () => ({
  // контур детали: smallArea — мелкая деталь (м²), режется первой; passes — число проходов;
  // sideAllow / leftover — припуск первого прохода по контуру и остаток по глубине; smallOnly — проходы только для мелких
  outer: { tool: '', dir: 'ccw', entry: 'ramp', angle: 45, smallFirst: true, smallArea: 0.12, smallSide: 150, passes: 1, sideAllow: 0, leftover: 0.5, smallOnly: false },
  cutout: { tool: '', dir: 'cw', entry: 'ramp', angle: 45 },   // контур выреза (фреза идёт внутри)
  groove: { tool: '', entry: 'straight', angle: 45 },          // пазы: общий инструмент и вход фрезы
  grooves: {},                                                 // пазы по слоям (ширина × глубина): слой -> { tool }
  pockets: {},                                                 // выемки: слой -> { tool, mode: 'zigzag' | 'spiral', dir: 'cw' | 'ccw', entry, angle }
  holes: {},                                                   // отверстия: слой -> { tool, d, depth }
})

// shared — общие постпроцессоры (мастер-аккаунт отметил «для всех»): видны каждому, в настройках пользователя не хранятся
export function normalizeCnc(raw, shared = []) {
  const c = raw && typeof raw === 'object' ? raw : {}
  const own = (Array.isArray(c.posts) ? c.posts : []).filter(p => p && !p.shared).map(p => ({ ...(isDrill6(p) ? DEFAULT_DRILL6() : DEFAULT_POST()), ...p }))
  const mine = own.length ? own : (shared.length ? [] : [DEFAULT_POST()])
  let posts = [...mine, ...shared.filter(p => !mine.some(q => q.id === p.id)).map(p => ({ ...(isDrill6(p) ? DEFAULT_DRILL6() : DEFAULT_POST()), ...p, shared: true }))]
  if (!posts.some(p => !isDrill6(p))) posts = [DEFAULT_POST(), ...posts]   // раскроечный станок есть всегда
  const tools = Array.isArray(c.tools) ? c.tools : []
  const d = DEFAULT_OPS(), o = c.ops || {}
  return {
    posts, post: posts.some(p => p.id === c.post) ? c.post : posts[0].id, tools,
    // какими постпроцессорами выпускать программы одновременно: раскроечный (один — G-код по листам) и присадочные (сколько угодно)
    router: posts.some(p => p.id === c.router && !isDrill6(p)) ? c.router : '',
    use6: (Array.isArray(c.use6) ? c.use6 : []).filter(id => posts.some(p => p.id === id && isDrill6(p))),
    ops: { outer: { ...d.outer, ...o.outer }, cutout: { ...d.cutout, ...o.cutout }, groove: { ...d.groove, ...o.groove }, grooves: { ...o.grooves }, pockets: { ...o.pockets }, holes: { ...o.holes } },
  }
}

export const getCnc = user => normalizeCnc(getUserSettings(user).cnc)
export const fetchCnc = async user => normalizeCnc((await fetchUserSettings(user)).cnc)
export const withShared = (cnc, shared) => normalizeCnc(cnc, shared)
export const saveCnc = (cnc, user) => saveUserSettings({ cnc: { ...cnc, posts: cnc.posts.filter(p => !p.shared) } }, user)
/** Постпроцессор, открытый в настройках (его правят вкладки «Основные» и «Команды») */
export const activePost = cnc => cnc.posts.find(p => p.id === cnc.post) || cnc.posts[0]
/** Раскроечный станок, которым выпускается G-код по листам: выбранный для выпуска, иначе открытый в настройках, иначе первый */
export const routerPost = cnc => cnc.posts.find(p => p.id === cnc.router && !isDrill6(p))
  || cnc.posts.find(p => p.id === cnc.post && !isDrill6(p)) || cnc.posts.find(p => !isDrill6(p)) || cnc.posts[0]
/** Присадочные станки, которые выпускают программы вместе с G-кодом */
export const drillPosts = cnc => cnc.posts.filter(p => isDrill6(p) && (cnc.use6 || []).includes(p.id))
/** Выбрать постпроцессор в настройках: раскроечный сразу становится станком для G-кода (как раньше) */
export const pickPost = (cnc, id) => { const p = cnc.posts.find(q => q.id === id); return { ...cnc, post: id, ...(p && !isDrill6(p) ? { router: id } : {}) } }
/** Включить / выключить выпуск программ присадочным станком */
export const toggleUse6 = (cnc, id, on) => ({ ...cnc, use6: on ? [...new Set([...(cnc.use6 || []), id])] : (cnc.use6 || []).filter(x => x !== id) })
export const newId = uid
