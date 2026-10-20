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
  // Присадочная голова (у станков, где кроме фрезерного шпинделя есть сверлильная группа): свёрла, отмеченные
  // «в присадочной голове», включаются своей командой, а не командой шпинделя, и сверлят всё одним проходом по листу
  drillHead: false,
  cmdHeadStart: '',
  cmdHeadEnd: '',
})

// Шестисторонний сверлильно-присадочный станок: программа — XML (формат SWJ), один файл на деталь (см. drill6Xml.js).
// Лицевая пласть — синхронно с фрезерным ЧПУ: сверху (Face 5), отдельной настройки нет.
export const DEFAULT_DRILL6 = () => ({
  ...DEFAULT_POST(), kind: 'drill6', name: 'Шестисторонний присадочный (XML)', ext: 'XML',
  nameTpl: '{NOMER}_{ZAKAZ}',     // начало названия файла; дальше — ^номер детали. Код детали должен быть уникален во всех заказах — поэтому с номером заказа
  folderTpl: '{ZAKAZ}',
  d6Tools: [],                    // инструменты станка (номера — как в станке) и обработка по видам — см. d6OpsOf в drill6Xml.js
  d6Ops: null,                    // null — всё «авто»: инструмент в XML не пишется, его назначает система управления станка
  d6All: false,                   // выводить и детали без обработки
  d6Name: 'label',                // имя файла: 'label' — код QR с бирки, 'own' — свой конструктор (d6Qr), см. drill6Xml.js
  d6Folder: '{ZAKAZ}/XML',        // папка для XML, вложенные через «/»
})
export const isDrill6 = p => p?.kind === 'drill6'
// Пильный центр (KDT): одна программа XML на материал — дерево резов по всем листам (см. beamSawXml.js).
// β: только у мастер-аккаунта и бета-тестеров «Пильный центр» (normalizeCnc(…, { beam: true })) — у них есть
// по умолчанию (id постоянный — не плодится при каждом открытии), после своих постпроцессоров; у остальных его нет вовсе.
export const BEAM_POST_ID = 'kdt-beam'
export const DEFAULT_BEAMSAW = () => ({
  ...DEFAULT_POST(), id: BEAM_POST_ID, kind: 'beamsaw', name: 'Пильный центр KDT (XML)', ext: 'xml',
  nameTpl: '{ZAKAZ}_{MAT}',       // название программы (латиницей, см. programName)
  folderTpl: '{ZAKAZ}',
})
export const isBeamSaw = p => p?.kind === 'beamsaw'
/** Раскроечный фрезер (G-код по листам) — не шестисторонний и не пильный центр */
export const isRouterPost = p => !!p && !isDrill6(p) && !isBeamSaw(p)
const kindDefault = p => (isDrill6(p) ? DEFAULT_DRILL6() : isBeamSaw(p) ? DEFAULT_BEAMSAW() : DEFAULT_POST())
export const KINDS = [['router', 'Раскроечный фрезер (G-код)'], ['drill6', 'Шестисторонний присадочный (XML)'], ['beamsaw', 'Пильный центр (XML KDT)']]
/** Пильный центр, которым выпускается XML: открытый в настройках, иначе первый */
export const sawPost = cnc => cnc.posts.find(p => p.id === cnc.post && isBeamSaw(p)) || cnc.posts.find(isBeamSaw) || null

export const DEFAULT_MILL = () => ({
  id: uid(), type: 'mill', name: 'Компрессионная 6 мм', t: 1, d: 6, maxPass: 20, edgeH: 25, rpm: 18000, feed: 8000,
  inFeed: 3000, inLen: 30, outFeed: 2000, outLen: 50, step: 5,
})
// edgeH — высота режущей кромки фрезы: глубже неё фреза резать не может (проверяется при выпуске программы);
// пусто/0 — без ограничения (у инструментов, заведённых раньше, поля нет — как было).
// У сверла inFeed/inLen — подача врезания и глубина врезания: первые inLen мм сверло идёт на подаче врезания,
// плавно разгоняясь до основной, чтобы не сколоть пласть; без них — сразу на основной (как было).
export const DEFAULT_DRILL = () => ({ id: uid(), type: 'drill', name: 'Сверло 8 мм', t: 2, d: 8, rpm: 3500, feed: 2500, inFeed: 500, inLen: 3 })

export const DEFAULT_OPS = () => ({
  // контур детали: smallArea — мелкая деталь (м²), режется первой; passes — число проходов;
  // sideAllow / leftover — припуск первого прохода по контуру и остаток по глубине; smallOnly — проходы только для мелких
  outer: { tool: '', dir: 'ccw', entry: 'ramp', angle: 45, smallFirst: true, smallArea: 0.12, smallSide: 150, passes: 1, sideAllow: 0, leftover: 0.5, smallOnly: false },
  cutout: { tool: '', dir: 'cw', entry: 'ramp', angle: 45 },   // контур выреза (фреза идёт внутри)
  groove: { tool: '', entry: 'straight', angle: 45 },          // пазы: общий инструмент и вход фрезы
  grooves: {},                                                 // пазы по слоям (ширина × глубина): слой -> { tool }
  pockets: {},                                                 // выемки: слой -> { tool, mode: 'zigzag' | 'spiral', dir: 'cw' | 'ccw', entry, angle }
  holes: {},                                                   // отверстия: слой -> { tool, d, depth }
  // что не выводить в программу: contour — вырезы (деталь режется прямоугольником габарита), face — пазы и выемки с лица, holes — отверстия
  skip: { contour: false, face: false, holes: false },
})

// shared — общие постпроцессоры (мастер-аккаунт отметил «для всех»): видны каждому, в настройках пользователя не хранятся
export function normalizeCnc(raw, shared = [], { beam = false } = {}) {
  const c = raw && typeof raw === 'object' ? raw : {}
  const own = (Array.isArray(c.posts) ? c.posts : []).filter(p => p && !p.shared).map(p => ({ ...kindDefault(p), ...p }))
  const mine = own.length ? own : (shared.length ? [] : [DEFAULT_POST()])
  let posts = [...mine, ...shared.filter(p => !mine.some(q => q.id === p.id)).map(p => ({ ...kindDefault(p), ...p, shared: true }))]
  if (!posts.some(isRouterPost)) posts = [DEFAULT_POST(), ...posts]   // раскроечный станок есть всегда
  // пильный центр KDT — только с бета-доступом (после своих станков); без него — не показывается вовсе
  if (!beam) posts = posts.filter(p => !isBeamSaw(p))
  else if (!posts.some(isBeamSaw)) posts = [...posts, DEFAULT_BEAMSAW()]
  const tools = Array.isArray(c.tools) ? c.tools : []
  // своя обработка постпроцессора, настроенного по чужой программе (см. postTools.js)
  posts = posts.map(p => (p.ownOps && !p.shared ? { ...p, ownOps: normOps(p.ownOps) } : p))
  return {
    posts, post: posts.some(p => p.id === c.post) ? c.post : posts[0].id, tools,
    // «Мои постпроцессоры» — сохранённые кнопкой «Сохранить» настройки станка: { id, name, kind, at, post, ops? }
    // двойники с одним именем (сохраняли раньше без перезаписи) — остаётся самый свежий
    saved: (Array.isArray(c.saved) ? c.saved : []).filter(s => s && s.post && typeof s.post === 'object')
      .sort((a, b) => (b.at || 0) - (a.at || 0))
      .filter((s, i, a) => a.findIndex(x => x.kind === s.kind && String(x.name || '').trim().toLowerCase() === String(s.name || '').trim().toLowerCase()) === i),
    // какими постпроцессорами выпускать программы одновременно: раскроечный (один — G-код по листам) и присадочные (сколько угодно)
    router: posts.some(p => p.id === c.router && isRouterPost(p)) ? c.router : '',
    use6: (Array.isArray(c.use6) ? c.use6 : []).filter(id => posts.some(p => p.id === id && isDrill6(p))),
    // второй раскроечный станок — его G-код выпускается вместе с G-кодом основного, в свою папку
    router2: posts.some(p => p.id === c.router2 && isRouterPost(p)) ? c.router2 : '',
    ops: normOps(c.ops),
  }
}
export function normOps(raw) {
  const d = DEFAULT_OPS(), o = raw || {}
  return { outer: { ...d.outer, ...o.outer }, cutout: { ...d.cutout, ...o.cutout }, groove: { ...d.groove, ...o.groove }, grooves: { ...o.grooves }, pockets: { ...o.pockets }, holes: { ...o.holes }, skip: { ...d.skip, ...o.skip } }
}
export { postView, postBack, hasOwnTools } from './postTools'

export const getCnc = user => normalizeCnc(getUserSettings(user).cnc)
export const fetchCnc = async user => normalizeCnc((await fetchUserSettings(user)).cnc)
export const withShared = (cnc, shared, opts) => normalizeCnc(cnc, shared, opts)
export const saveCnc = (cnc, user) => saveUserSettings({ cnc: { ...cnc, posts: cnc.posts.filter(p => !p.shared) } }, user)
/** Постпроцессор, открытый в настройках (его правят вкладки «Основные» и «Команды») */
export const activePost = cnc => cnc.posts.find(p => p.id === cnc.post) || cnc.posts[0]
/** Раскроечный станок, которым выпускается G-код по листам: выбранный для выпуска, иначе открытый в настройках, иначе первый */
export const routerPost = cnc => cnc.posts.find(p => p.id === cnc.router && isRouterPost(p))
  || cnc.posts.find(p => p.id === cnc.post && isRouterPost(p)) || cnc.posts.find(isRouterPost) || cnc.posts[0]
/** Второй раскроечный станок (G-код вместе с основным) — если выбран и это не тот же, что основной */
export const secondRouter = cnc => { const r = routerPost(cnc), p = cnc.posts.find(q => q.id === cnc.router2 && isRouterPost(q)); return p && p.id !== r?.id ? p : null }
/** Второй постпроцессор для выпуска: второй раскроечный или (первый отмеченный) шестисторонний */
export const secondPost = cnc => secondRouter(cnc) || drillPosts(cnc)[0] || null
/** Выбрать второй постпроцессор: раскроечный — G-код вторым станком, шестисторонний — файлы по деталям; '' — выключить */
export const setSecondPost = (cnc, id) => {
  const p = cnc.posts.find(q => q.id === id)
  if (!p || isBeamSaw(p)) return { ...cnc, router2: '', use6: [] }
  return isDrill6(p) ? { ...cnc, router2: '', use6: [p.id] } : { ...cnc, router2: p.id, use6: [] }
}
/** Присадочные станки, которые выпускают программы вместе с G-кодом */
export const drillPosts = cnc => cnc.posts.filter(p => isDrill6(p) && (cnc.use6 || []).includes(p.id))
/** Выбрать постпроцессор в настройках: раскроечный сразу становится станком для G-кода (как раньше) */
export const pickPost = (cnc, id) => { const p = cnc.posts.find(q => q.id === id); return { ...cnc, post: id, ...(p && isRouterPost(p) ? { router: id } : {}) } }
/** Включить / выключить выпуск программ присадочным станком */
export const toggleUse6 = (cnc, id, on) => ({ ...cnc, use6: on ? [...new Set([...(cnc.use6 || []), id])] : (cnc.use6 || []).filter(x => x !== id) })
export const newId = uid

// ── «Мои постпроцессоры»: сохранённые настройки, которые можно применить снова ──
// Пользователь пробует разные настройки: сохранил удачную под именем — потом применяет к открытому постпроцессору.
// Для раскроечного вместе со станком сохраняется и обработка контуров (ops): она влияет на G-код так же, как команды.
export const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase()
const strip = p => { const q = { ...p }; delete q.id; delete q.shared; delete q.forAll; delete q.ownerId; return q }
export function saveSnapshot(cnc, name) {
  const post = activePost(cnc)
  const nm = String(name || post.name).trim() || post.name
  // свои инструменты станка (настроенного по чужой программе) — тоже в сохранённое: без них его обработка (ownOps)
  // ссылается в пустоту, и после самонастройки или удаления их было бы не вернуть
  const own = (cnc.tools || []).filter(t => t.postId === post.id).map(t => ({ ...t }))
  const snap = { id: uid(), name: nm, kind: post.kind || 'router', at: Date.now(), post: strip(post), ...(isRouterPost(post) ? { ops: cnc.ops } : {}), ...(own.length ? { tools: own } : {}) }
  // то же имя — тот же сохранённый вариант: перезаписывается, а не копится второй с тем же именем
  const list = cnc.saved || [], same = list.find(x => sameName(x.name, nm))
  return { ...cnc, saved: same ? list.map(x => (x === same ? { ...snap, id: same.id } : x)) : [...list, snap] }
}
/** Применить сохранённые настройки: к открытому постпроцессору того же типа (его имя и id остаются), иначе — новым постпроцессором */
export function applySnapshot(cnc, snapId, asNew = false) {
  const snap = (cnc.saved || []).find(s => s.id === snapId)
  if (!snap) return cnc
  const cur = activePost(cnc)
  const same = (cur.kind || 'router') === (snap.kind || 'router') && !cur.shared
  let next
  if (same && !asNew) {
    next = { ...cnc, posts: cnc.posts.map(p => (p.id === cur.id ? { ...p, ...snap.post, id: p.id, name: p.name, shared: false, forAll: p.forAll } : p)) }
  } else {
    const p = { ...kindDefault({ kind: snap.kind }), ...snap.post, id: uid(), name: snap.name, shared: false, forAll: false }
    next = { ...cnc, posts: [...cnc.posts, p], post: p.id, ...(isRouterPost(p) ? { router: p.id } : {}) }
    if (snap.kind === 'drill6') next = toggleUse6(next, p.id, true)
  }
  if (snap.ops && snap.kind === 'router') next = { ...next, ops: { ...DEFAULT_OPS(), ...snap.ops } }
  // свои инструменты станка: вместо текущих своих — сохранённые (с новыми id, ссылки в его обработке — на них)
  if (Array.isArray(snap.tools) && snap.tools.length) {
    const target = activePost(next)
    const map = new Map(snap.tools.map(t => [t.id, uid()]))
    const tools = [...(next.tools || []).filter(t => t.postId !== target.id), ...snap.tools.map(t => ({ ...t, id: map.get(t.id), postId: target.id }))]
    const fix = o => (o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, k === 'tool' && map.has(v) ? map.get(v) : (v && typeof v === 'object' ? fix(v) : v)])) : o)
    next = { ...next, tools, posts: next.posts.map(p => (p.id === target.id && p.ownOps ? { ...p, ownOps: fix(p.ownOps) } : p)) }
  }
  return next
}
/** Автокопия перед изменением, которое перезаписывает настройки станка (самонастройка, удаление): в «Мои постпроцессоры»
 *  под именем «<станок> · до <чего> <дата время>» — чтобы уже настроенное можно было вернуть кнопкой «Применить». */
export function backupPost(cnc, what) {
  const post = activePost(cnc)
  const when = new Date().toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  return saveSnapshot(cnc, `${post.name} · до ${what} ${when}`)
}
export const removeSnapshot = (cnc, snapId) => ({ ...cnc, saved: (cnc.saved || []).filter(s => s.id !== snapId) })
export const renameSnapshot = (cnc, snapId, name) => ({ ...cnc, saved: (cnc.saved || []).map(s => (s.id === snapId ? { ...s, name } : s)) })

/** Правка общего постпроцессора (не мастер-аккаунт): своя копия с правкой, и выпуск программ переходит на неё —
 *  иначе копия есть, а программы по-прежнему выпускаются общим станком (переименовали — «не сохранилось»). */
export function forkShared(cnc, post, patch = {}) {
  const p = { ...post, ...patch, id: uid(), shared: false, forAll: false, ownerId: undefined, name: patch.name || post.name + ' (мой)' }
  const swap = id => (id === post.id ? p.id : id)
  return { ...cnc, posts: [...cnc.posts, p], post: p.id, router: swap(cnc.router), router2: swap(cnc.router2), use6: (cnc.use6 || []).map(swap) }
}
