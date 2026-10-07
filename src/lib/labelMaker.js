// Бирка детали: шаблон (размер + какие параметры показывать), рисование на canvas и файлы для стола бирковки.
// Шаблон идёт за аккаунтом (user_metadata.app_settings.labelTpl).
//
// Файлы для линии раскроя (как в образцах):
//   List_<заказ>.xml            — список листов: программа раскроя, файл бирок, картинка листа, толщина;
//   Label_<N>_<заказ>.cyc       — бирки листа N: картинка бирки и точка наклейки X, Y (центр детали на листе), R — поворот;
//   <N>_<заказ>_<0001>.bmp      — картинка бирки;   <N>_<заказ>.jpg — картинка листа.
// На линии сначала идёт бирковка листа, затем раскрой.
import qrcode from 'qrcode-generator'
import { zipSync, strToU8 } from 'fflate'
import { getUserSettings, saveUserSettings } from './userSettings'
import { loadLabelImages, saveLabelImage } from './materialTextures'
import { detailMeta } from './partLabel'
import { isTwoSided } from './partInfo'
import { placedTurns, placedHoles } from './partHoles'
import { rotatePointTimes, getAllDrillPoints, getGrooveRects } from './drillGeometry'
import { detailEdgeList } from './edgeLength'
import { sheetGeo } from './savedNesting'

// Бирка собирается из элементов: каждый можно поставить в любое место бирки и задать ему размер.
// Элемент шаблона: { id, type, x, y, w, h (мм), size (высота шрифта, мм), bold, img }.
// img — своя картинка вместо текста: печатается, только когда у детали этот параметр есть
// (например, значок сверла вместо слов «нижняя присадка»).
export const LABEL_ITEMS = [
  ['order', 'Заказ', 'text'],
  ['material', 'Материал', 'text'],
  ['title', 'Обозначение + наименование', 'text'],
  ['name', 'Наименование', 'text'],
  ['des', 'Обозначение', 'text'],
  ['pos', 'Позиция', 'text'],
  ['prefix', 'Изделие (префикс)', 'text'],
  ['size', 'Размер и количество', 'text'],
  ['curved', 'Криволинейная кромка', 'text'],
  ['work', 'Вся обработка одной строкой', 'text'],
  ['faceHoles', 'Отверстия в пласть — с лица', 'text'],
  ['backHoles', 'Отверстия с изнанки (нижняя присадка)', 'text'],
  ['endHoles', 'Отверстия в торец', 'text'],
  ['grooves', 'Пазы', 'text'],
  ['pockets', 'Выемки', 'text'],
  ['cutouts', 'Вырезы', 'text'],
  ['twoSided', 'Обработка с двух сторон', 'text'],
  ['edgeList', 'Кромка — списком', 'text'],
  ['length', 'Длина', 'text'],
  ['width', 'Ширина', 'text'],
  ['thickness', 'Толщина', 'text'],
  ['qty', 'Количество', 'text'],
  ['image', 'Своя картинка (логотип)', 'text'],
  ['sheet', 'Номер карты', 'text'],
  ['num', 'Номер детали на листе', 'text'],
  ['edgeTop', 'Кромка — сверху', 'text'],
  ['edgeBottom', 'Кромка — снизу', 'text'],
  ['edgeLeft', 'Кромка — слева', 'text'],
  ['edgeRight', 'Кромка — справа', 'text'],
  ['part', 'Чертёж детали', 'pic'],
  ['map', 'Карта раскроя — деталь чёрным', 'pic'],
  ['qr', 'QR-код', 'pic'],
]
// Из чего собирается строка QR-кода — выбирает пользователь; порядок — как в этом списке
export const QR_PARTS = [
  ['text', 'Свой текст'],
  ['number', 'Номер заказа (присвоен приложением)'],
  ['order', 'Название заказа'],
  ['des', 'Обозначение детали'],
  ['name', 'Наименование детали'],
  ['pos', 'Позиция'],
  ['prefix', 'Изделие (префикс)'],
  ['material', 'Материал'],
  ['size', 'Размер'],
  ['sheet', 'Номер карты'],
  ['num', 'Номер детали на листе'],
]
const QR_DEFAULT = { parts: ['number', 'sheet', 'num', 'des', 'size'], sep: ';', text: '', latin: false }
// кириллица -> латиница (как в именах файлов образца: «Белый» -> «Belij»)
const LAT = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'j', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'i', ь: '', э: 'e', ю: 'yu', я: 'ya',
  ә: 'a', ғ: 'g', қ: 'k', ң: 'n', ө: 'o', ұ: 'u', ү: 'u', һ: 'h', і: 'i' }
export const toLatin = str => String(str || '').replace(/[а-яёәғқңөұүһі]/gi, ch => { const l = LAT[ch.toLowerCase()] ?? ch; return ch === ch.toLowerCase() ? l : l.charAt(0).toUpperCase() + l.slice(1) })
export function labelQr(tpl, info) {
  const q = tpl.qr || QR_DEFAULT
  const val = { text: q.text, number: info.orderNumber, order: info.orderName, des: info.des, name: info.name, pos: info.pos, prefix: info.prefix, material: info.materialName,
    size: `${r1(info.length)}x${r1(info.width)}x${info.thickness || ''}`, sheet: `L${info.sheet}`, num: `N${info.num}` }
  const out = QR_PARTS.filter(([k]) => q.parts.includes(k)).map(([k]) => String(val[k] ?? '').trim()).filter(Boolean).join(q.sep)
  return (q.latin ? toLatin(out) : out).replace(/\s+/g, '_')        // пробелов в коде нет — вместо них прочерк
}
export const itemKind = type => (LABEL_ITEMS.find(x => x[0] === type) || [])[2] || 'text'
// свойства детали из импорта (contour.meta) — элементы вида «meta:<имя>»
const META_NAMES = { des: 'Обозначение', pos: 'Позиция', material: 'Материал детали', product: 'Изделие', block: 'Блок', thickness: 'Толщина детали', id: 'ID детали', texDir: 'Направление текстуры', comment: 'Комментарий', note: 'Примечание' }
export const itemTitle = type => (type.startsWith('meta:') ? `Свойство: ${META_NAMES[type.slice(5)] || type.slice(5)}` : (LABEL_ITEMS.find(x => x[0] === type) || [])[1] || type)
const knownType = type => typeof type === 'string' && (type.startsWith('meta:') || LABEL_ITEMS.some(x => x[0] === type))
/** Свойства, вшитые в детали заказа, — их тоже можно вывести на бирку: [[тип, название]] */
export function metaItems(details) {
  const keys = new Set()
  for (const d of details || []) { const m = detailMeta(d); if (m) for (const [k, v] of Object.entries(m)) if ((typeof v === 'string' && v.trim()) || typeof v === 'number') keys.add(k) }
  return [...keys].filter(k => !['des', 'pos'].includes(k)).map(k => ['meta:' + k, itemTitle('meta:' + k)])
}
/** Элемент рисуется прямоугольником с высотой (картинка), а не строкой текста */
/** Текст идёт вдоль бирки по вертикали (кромка слева и справа) */
export const isVert = it => it.type === 'edgeLeft' || it.type === 'edgeRight'
const EDGE_TYPES = ['edgeTop', 'edgeBottom', 'edgeLeft', 'edgeRight']
/** Размер рамки элемента на бирке, мм: [ширина, высота] */
export const itemBox = it => (isBox(it) ? [it.w, it.h] : isVert(it) ? [it.size * 1.25, it.w] : [it.w, it.size * 1.25])
export const isBox = it => itemKind(it.type) === 'pic' || !!it.img || it.type === 'image'
// Картинки шаблона. В шаблоне — ссылка «ref:<id>», сама картинка хранится отдельно (за аккаунтом) в хорошем качестве.
const IMAGES = new Map()
let imgUser = null, imgStore = null, imgStoreUid
const imageStore = () => { const uid = imgUser?.id || null; if (!imgStore || imgStoreUid !== uid) { imgStoreUid = uid; imgStore = loadLabelImages(imgUser) } return imgStore }
export async function preloadLabelImages(tpl) {
  const need = (tpl.items || []).filter(i => i.img && !IMAGES.get(i.img)?.complete)
  if (!need.length) return
  const store = need.some(i => i.img.startsWith('ref:')) ? await imageStore() : {}
  await Promise.all(need.map(i => new Promise(res => {
    const src = i.img.startsWith('ref:') ? store[i.img.slice(4)] : i.img
    if (!src) { res(); return }
    const im = new Image(); im.onload = im.onerror = () => res(); im.src = src; IMAGES.set(i.img, im)
  })))
}
/**
 * Файл (PNG, JPG, BMP, SVG…) или адрес картинки -> ссылка «ref:<id>» для шаблона. Картинка сохраняется как есть,
 * до 1400 точек по большей стороне — это больше, чем принтер бирок может напечатать на всю ширину бирки.
 */
export async function imageToLabel(src) {
  const blob = typeof src === 'string' ? await (await fetch(src)).blob() : src
  const url = URL.createObjectURL(blob)
  try {
    const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Не удалось прочитать картинку')); i.src = url })
    const iw = im.naturalWidth || 600, ih = im.naturalHeight || 600                 // у SVG размеров может не быть
    const k = Math.min(1, 1400 / Math.max(iw, ih)), cv = document.createElement('canvas')
    cv.width = Math.max(1, Math.round(iw * k)); cv.height = Math.max(1, Math.round(ih * k))
    const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height); g.drawImage(im, 0, 0, cv.width, cv.height)
    let data = cv.toDataURL('image/png')
    if (data.length > 700000) data = cv.toDataURL('image/jpeg', 0.92)
    const id = Math.random().toString(36).slice(2, 10)
    const r = await saveLabelImage(imgUser, id, data)
    if (!r.ok) throw new Error('Не удалось сохранить картинку')
    ;(await imageStore())[id] = data
    return 'ref:' + id
  } finally { URL.revokeObjectURL(url) }
}
// Картинка в размере печати, переведённая в чёрные и белые точки с рассеиванием (полутона — как в газете):
// принтер бирок печатает только чёрным, так фотографии и серые логотипы выходят узнаваемо, а чёткие значки — чётко.
const PRINTS = new Map()
function printImage(key, im, w, h) {
  const id = `${key}|${w}|${h}`
  if (PRINTS.has(id)) return PRINTS.get(id)
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h
  const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.imageSmoothingQuality = 'high'; g.drawImage(im, 0, 0, w, h)
  const px = g.getImageData(0, 0, w, h), d = px.data, L = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) L[i] = (d[i * 4] * 3 + d[i * 4 + 1] * 6 + d[i * 4 + 2]) / 10
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, v = L[i] < 128 ? 0 : 255, e = L[i] - v
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255
    if (x + 1 < w) L[i + 1] += e * 7 / 16
    if (y + 1 < h) { if (x > 0) L[i + w - 1] += e * 3 / 16; L[i + w] += e * 5 / 16; if (x + 1 < w) L[i + w + 1] += e / 16 }
  }
  g.putImageData(px, 0, 0)
  if (PRINTS.size > 40) PRINTS.delete(PRINTS.keys().next().value)
  PRINTS.set(id, cv)
  return cv
}
// раскладка по умолчанию — как на образце бирки (85 × 59 мм)
const BASE = { w: 85, h: 59 }
const DEFAULT_ITEMS = [
  { type: 'order', x: 6.5, y: 6.5, w: 48, size: 3.1 },
  { type: 'material', x: 6.5, y: 10.6, w: 48, size: 2.5 },
  { type: 'title', x: 6.5, y: 14, w: 48, size: 2.8, bold: true },
  { type: 'size', x: 6.5, y: 18, w: 48, size: 3.6, bold: true },
  { type: 'part', x: 6.5, y: 23.5, w: 38, h: 25.5 },
  { type: 'sheet', x: 6.5, y: 50, w: 24, size: 2.8 },
  { type: 'num', x: 70, y: 1.2, w: 9, size: 3.2, bold: true, align: 'right' },
  // кромка по сторонам бирки — там же, где она у детали на карте
  { type: 'edgeTop', x: 14, y: 1.3, w: 54, size: 2.4, bold: true, align: 'center' },
  { type: 'edgeBottom', x: 21, y: 54.6, w: 43, size: 2.4, bold: true, align: 'center' },
  { type: 'edgeLeft', x: 1.3, y: 6, w: 47, size: 2.4, bold: true, align: 'center' },
  { type: 'edgeRight', x: 80.7, y: 6, w: 47, size: 2.4, bold: true, align: 'center' },
  { type: 'qr', x: 58, y: 6.5, w: 21, h: 21 },
  { type: 'map', x: 46.5, y: 30, w: 32.5, h: 22 },
]
// место нового элемента — там же, где он стоит в раскладке по умолчанию, иначе — посередине
export function newLabelItem(type, tpl) {
  const d = DEFAULT_ITEMS.find(i => i.type === type), kx = tpl.w / BASE.w, ky = tpl.h / BASE.h
  const it = d ? { ...d, x: d.x * kx, y: d.y * ky, w: d.w * (isVert(d) ? ky : kx), ...(d.h ? { h: d.h * ky } : {}), ...(d.size ? { size: d.size * Math.min(kx, ky) } : {}) }
    : itemKind(type) === 'pic' || type === 'image' ? { type, x: tpl.w * 0.3, y: tpl.h * 0.3, w: tpl.w * 0.3, h: tpl.h * 0.3 } : { type, x: tpl.w * 0.1, y: tpl.h * 0.45, w: tpl.w * 0.5, size: 2.6 * Math.min(kx, ky) }
  return { ...it, id: type + '_' + Math.random().toString(36).slice(2, 7) }
}
export const DEFAULT_LABEL = () => { const t = { enabled: false, w: BASE.w, h: BASE.h, edges: false, rot: true, qr: { ...QR_DEFAULT }, order: { prefix: 'Заказ', number: true, name: true }, part: { dims: false, dimSize: 2 } }; return { ...t, items: DEFAULT_ITEMS.map(i => newLabelItem(i.type, t)) } }
export function normalizeLabel(raw) {
  const d = DEFAULT_LABEL(), t = raw && typeof raw === 'object' ? raw : {}
  const n = (v, def, lo, hi) => { const x = Number(v); return isFinite(x) && x > 0 ? Math.max(lo, Math.min(hi, x)) : def }
  const w = n(t.w, d.w, 20, 200), h = n(t.h, d.h, 15, 200)
  let items = Array.isArray(t.items) ? t.items.filter(i => i && knownType(i.type)) : null
  if (!items) {                                            // шаблон прежнего вида (галочки) — раскладка по умолчанию с теми же полями
    const f = t.fields, base = { w, h }
    items = DEFAULT_ITEMS.filter(i => !f || (i.type === 'title' ? f.name !== false || f.des !== false : EDGE_TYPES.includes(i.type) ? f.edges !== false : f[i.type] !== false)).map(i => newLabelItem(i.type, base))
  }
  // прежняя галочка «кромка по сторонам» -> четыре обычных элемента, которые можно двигать и менять
  else if (t.edges === true && !items.some(i => EDGE_TYPES.includes(i.type))) items = [...items, ...EDGE_TYPES.map(k => newLabelItem(k, { w, h }))]
  items = items.map(i => {
    const pic = isBox(i), iw = Math.max(3, Math.min(isVert(i) ? h : w, Number(i.w) || 20))
    const o = { id: i.id || i.type + '_' + Math.random().toString(36).slice(2, 7), type: i.type, w: iw, bold: !!i.bold, align: ['right', 'center'].includes(i.align) ? i.align : 'left' }
    // черта у текста: снизу, сверху или без неё; у кромки по умолчанию — снизу
    o.ul = ['below', 'above', 'none'].includes(i.ul) ? i.ul : EDGE_TYPES.includes(i.type) ? 'below' : 'none'
    if (typeof i.img === 'string' && (i.img.startsWith('ref:') || (i.img.startsWith('data:image/') && i.img.length < 40000))) o.img = i.img
    if (pic) o.h = Math.max(3, Math.min(h, Number(i.h) || 10))
    if (itemKind(i.type) !== 'pic') o.size = Math.max(1.2, Math.min(20, Number(i.size) || 2.6))
    const [bw, bh] = itemBox(o)
    o.x = Math.max(0, Math.min(w - bw, Number(i.x) || 0)); o.y = Math.max(0, Math.min(h - bh, Number(i.y) || 0))
    return o
  })
  return { enabled: !!t.enabled, w, h, edges: false, rot: t.rot !== false, dpi: [203, 300, 600].includes(Number(t.dpi)) ? Number(t.dpi) : 203, items,
    // строка «Заказ»: своя подпись, номер от приложения и название заказа включаются отдельно
    order: { prefix: typeof t.order?.prefix === 'string' ? t.order.prefix.slice(0, 30) : 'Заказ', number: t.order?.number !== false, name: t.order?.name !== false },
    // чертёж детали: размеры торцевых отверстий от края и высота их цифр (мм)
    part: { dims: !!t.part?.dims, dimSize: Math.max(1, Math.min(6, Number(t.part?.dimSize) || 2)) },
    qr: { parts: Array.isArray(t.qr?.parts) ? t.qr.parts.filter(k => QR_PARTS.some(x => x[0] === k)) : [...QR_DEFAULT.parts], sep: typeof t.qr?.sep === 'string' ? t.qr.sep.slice(0, 3) : ';', text: String(t.qr?.text || '').slice(0, 60), latin: !!t.qr?.latin } }
}
/** Новый размер бирки — элементы растягиваются вместе с ней */
export function resizeLabel(tpl, w, h) {
  const kx = w / tpl.w, ky = h / tpl.h, k = Math.min(kx, ky)
  return normalizeLabel({ ...tpl, w, h, items: tpl.items.map(i => ({ ...i, x: i.x * kx, y: i.y * ky, w: i.w * (isVert(i) ? ky : kx), ...(i.h ? { h: i.h * ky } : {}), ...(i.size ? { size: i.size * k } : {}) })) })
}
export const getLabelTpl = user => { imgUser = user || imgUser; return normalizeLabel(getUserSettings(user).labelTpl) }
export const saveLabelTpl = (tpl, user) => saveUserSettings({ labelTpl: tpl }, user)

export const LABEL_PX_MM = 8                               // точек на мм при 203 dpi (обычный термопринтер)
const pxMm = tpl => ({ 300: 12, 600: 24 })[tpl?.dpi] || LABEL_PX_MM
const edgeName = v => (!v || v === 'false' ? '' : v === 'default' || v === true ? 'Кромка' : String(v))
const r1 = v => String(Math.round((Number(v) || 0) * 10) / 10)

/** Все свойства детали для бирки. mat — материал из savedNestings, si / pi — лист и деталь на нём */
export function labelInfo(order, mat, si, pi) {
  const sh = mat.sheets[si], p = sh.placed[pi], d = mat.details[p.detailIndex] || {}, m = detailMeta(d) || {}
  let c = d.contour
  if (typeof c === 'string') { try { c = JSON.parse(c) } catch { c = null } }
  // стороны бирки — как деталь лежит на листе
  // (тем же поворотом, что и контур детали на карте): сторона бирки = сторона детали на карте раскроя
  const DW = Number(d.width) || 0, DL = Number(d.length) || 0, turns = placedTurns(p, d)
  const sides = { top: '', right: '', bottom: '', left: '' }
  ;[['left', 0, DL / 2, d.edge_left], ['right', DW, DL / 2, d.edge_right], ['bottom', DW / 2, 0, d.edge_bottom], ['top', DW / 2, DL, d.edge_top]].forEach(([, x, y, v]) => {
    const q = rotatePointTimes(x, y, DW, DL, turns), bw = Number(p.origX) || DW, bh = Number(p.origY) || DL
    const dist = { left: q.x, right: bw - q.x, bottom: q.y, top: bh - q.y }
    const on = Object.keys(dist).sort((a, b) => dist[a] - dist[b])[0]
    if (edgeName(v)) sides[on] = edgeName(v)
  })
  // размер — как деталь лежит на карте: по горизонтали (X листа) × по вертикали (Y листа)
  const even = turns % 2 === 0
  const curved = {}
  detailEdgeList(d).filter(e => e.curved).forEach(e => { curved[e.name] = (curved[e.name] || 0) + e.mm })
  const holePts = c ? getAllDrillPoints(c, DW, DL, false) : []
  const face = holePts.filter(q => !q.edge && !q.back).length, back = holePts.filter(q => !q.edge && q.back).length, end = holePts.filter(q => q.edge).length
  const grooves = (c?.grooves || []).length, pockets = (c?.holes || []).filter(h => h.type === 'pocket').length
  const cutouts = (c?.holes || []).filter(h => h.type !== 'pocket').length
  const work = [face && `отв. в пласть ${face}`, back && `с изнанки ${back}`, end && `в торец ${end}`, grooves && `пазов ${grooves}`, pockets && `выемок ${pockets}`, cutouts && `вырезов ${cutouts}`].filter(Boolean)
  return {
    order: [order.order_number, order.order_name].filter(Boolean).join(' '), orderNumber: order.order_number || '', orderName: order.order_name || '', materialName: mat.name || '',
    num: pi + 1, sheet: si + 1, sheets: mat.sheets.length,
    name: d.name || p.label || 'Деталь', des: m.des || '', pos: m.pos != null ? String(m.pos) : '', prefix: d.prefix || p.prefix || '',
    material: [mat.name, mat.thickness ? `${mat.thickness} мм` : ''].filter(Boolean).join(' · '),
    length: Number(d.length) || 0, width: Number(d.width) || 0, sizeX: even ? DW : DL, sizeY: even ? DL : DW, thickness: mat.thickness, qty: Number(d.qty) || 1,
    faceHoles: face, backHoles: back, endHoles: end, grooves, pockets, cutouts, meta: m,
    edgeList: [...new Set([d.edge_left, d.edge_right, d.edge_top, d.edge_bottom].map(edgeName).filter(Boolean))],
    sides, sidesCw: { top: sides.left, bottom: sides.right, left: sides.bottom, right: sides.top }, curved: Object.entries(curved).map(([name, mm]) => `${name} ${(mm / 1000).toFixed(2)} м`),
    work, twoSided: isTwoSided(d, mat.thickness),
  }
}

/**
 * Чертёж детали в прямоугольнике (x, y, w, h) — так, как она лежит на карте раскроя (тот же поворот, Y вверх):
 * контур, вырезы, выемки и пазы лицевой стороны, отверстия в пласть (кружки) и в торец (полоса на глубину),
 * Кромка на чертеже не показывается. Обработка с изнанки не показывается.
 */
export function drawPart(ctx, x0, y0, w0, h0, p, d, line = 1, rot = false, dimPx = 0) {
  let c = d?.contour
  if (typeof c === 'string') { try { c = JSON.parse(c) } catch { c = null } }
  const DW = Number(d?.width) || 0, DL = Number(d?.length) || 0, turns = placedTurns(p, d || {})
  const outline = Array.isArray(p.polygon) && p.polygon.length > 2 ? p.polygon.map(q => [q.x, q.y]) : [[0, 0], [p.origX, 0], [p.origX, p.origY], [0, p.origY]]
  const bw = Number(p.origX) || Math.max(...outline.map(q => q[0])), bh = Number(p.origY) || Math.max(...outline.map(q => q[1]))
  // rot — лист на бирке лежит горизонтально (длина листа — слева направо): деталь поворачивается вместе с картой
  const vw = rot ? bh : bw, vh = rot ? bw : bh
  const holePts = c ? getAllDrillPoints(c, DW, DL, true) : []
  // Размеры торцевых отверстий — как на чертеже: снаружи детали, выносные линии и размерная цепочка вдоль торца
  // (край → отверстие → отверстие → край). Торцы: l, r, b, t — в «родных» координатах детали.
  const fontOf = px => `${Math.max(6, Math.round(px))}px Arial, Helvetica, sans-serif`
  const dimFont = fontOf(dimPx)
  const groups = []
  if (dimPx > 0) {
    const NORM = { l: [-1, 0], r: [1, 0], b: [0, -1], t: [0, 1] }
    const dirOf = v => {                                   // направление на бирке для вектора в координатах детали
      const o = rotatePointTimes(DW / 2, DL / 2, DW, DL, turns), q = rotatePointTimes(DW / 2 + v[0], DL / 2 + v[1], DW, DL, turns)
      return rot ? [Math.round(q.y - o.y), Math.round(q.x - o.x)] : [Math.round(q.x - o.x), -Math.round(q.y - o.y)]
    }
    ctx.save(); ctx.font = dimFont
    for (const e of ['l', 'r', 'b', 't']) {
      const vert = e === 'l' || e === 'r', total = vert ? DL : DW
      const at = [...new Set(holePts.filter(q => q.edge && (q.dx ? (q.dx > 0 ? 'l' : 'r') : (q.dy > 0 ? 'b' : 't')) === e).map(q => Math.round((vert ? q.y : q.x) * 10) / 10))].filter(v => v > 0.05 && v < total - 0.05).sort((u, v) => u - v)
      if (!at.length) continue
      const nodes = [0, ...at, total], texts = nodes.slice(1).map((v, i) => r1(v - nodes[i]))
      groups.push({ e, vert, nodes, texts, n: dirOf(NORM[e]), tw: Math.max(...texts.map(t => ctx.measureText(t).width)) })
    }
    ctx.restore()
  }
  // Место под размеры — только с тех сторон, где они есть. Если размеры съедают больше половины блока,
  // цифры уменьшаются (до 60 %), чтобы сама деталь оставалась читаемой.
  let k, ox, oy, dpx = dimPx, O1 = 0, GAP = 0
  for (let pass = 0; pass < 4; pass++) {
    const sc = dpx / (dimPx || 1)
    O1 = dpx * 0.7; GAP = dpx * 0.3                        // размерная линия — на таком расстоянии от детали; зазор до цифр
    const m = { l: 2 * line, r: 2 * line, t: 2 * line, b: 2 * line }
    for (const g of groups) { const side = g.n[0] < 0 ? 'l' : g.n[0] > 0 ? 'r' : g.n[1] < 0 ? 't' : 'b'; m[side] = Math.max(m[side], O1 + GAP + dpx * 0.5 + g.tw * sc + line) }
    const w = Math.max(4, w0 - m.l - m.r), h = Math.max(4, h0 - m.t - m.b)
    k = Math.min(w / vw, h / vh); ox = x0 + m.l + (w - vw * k) / 2; oy = y0 + m.t + (h - vh * k) / 2
    if (!groups.length || pass === 3 || (m.l + m.r <= w0 * 0.5 && m.t + m.b <= h0 * 0.5)) break
    dpx *= 0.84
  }
  const S = (px, py) => (rot ? [ox + py * k, oy + px * k] : [ox + px * k, oy + (bh - py) * k])
  const R = (px, py) => { const q = rotatePointTimes(px, py, DW, DL, turns); return S(q.x, q.y) }      // из «родных» координат детали
  const poly = (pts, close = true) => { ctx.beginPath(); pts.forEach((q, i) => { if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]) }); if (close) ctx.closePath() }
  ctx.save()
  ctx.strokeStyle = '#000'; ctx.fillStyle = '#000'; ctx.lineJoin = 'round'; ctx.lineCap = 'butt'
  ctx.lineWidth = line * 1.5
  poly(outline.map(q => S(q[0], q[1]))); ctx.fillStyle = '#fff'; ctx.fill(); ctx.stroke(); ctx.fillStyle = '#000'
  if (c) {
    // вырезы — сплошной линией с крестом (сквозные), выемки — штриховой
    const holes = placedHoles(p, d), src = c.holes || []
    holes.forEach((hp, i) => {
      const hole = src.length === holes.length ? src[i] : null
      if (hole?.type === 'pocket' && hole.face === 'back') return
      const pts = hp.map(q => S(q.x, q.y))
      ctx.lineWidth = line; ctx.setLineDash(hole?.type === 'pocket' ? [4 * line, 3 * line] : [])
      poly(pts); ctx.stroke(); ctx.setLineDash([])
      if (hole && hole.type !== 'pocket' && hole.type !== 'circle' && pts.length === 4) { ctx.lineWidth = line * 0.6; ctx.beginPath(); ctx.moveTo(...pts[0]); ctx.lineTo(...pts[2]); ctx.moveTo(...pts[1]); ctx.lineTo(...pts[3]); ctx.stroke() }
    })
    // пазы лицевой стороны — контур со штриховкой
    getGrooveRects(c, DW, DL, true).forEach(r => {
      const pts = r.pts.map(([px, py]) => R(px, py))
      ctx.lineWidth = line; poly(pts); ctx.stroke()
      ctx.save(); poly(pts); ctx.clip(); ctx.lineWidth = line * 0.6
      const xs = pts.map(q => q[0]), ys = pts.map(q => q[1]), x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys)
      ctx.beginPath(); for (let t = x0 - (y1 - y0); t < x1; t += 5 * line) { ctx.moveTo(t, y1); ctx.lineTo(t + (y1 - y0), y0) } ctx.stroke()
      ctx.restore()
    })
    // отверстия: в пласть — кружок по диаметру, в торец — полоса от кромки на глубину
    holePts.forEach(pt => {
      const a = R(pt.x, pt.y)
      if (pt.edge) {
        const dep = pt.depth > 0 ? pt.depth : 20, b = R(pt.x + pt.dx * dep, pt.y + pt.dy * dep)
        ctx.lineWidth = Math.max(2 * line, (pt.d || 8) * k); ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke()
        return
      }
      ctx.beginPath(); ctx.arc(a[0], a[1], Math.max(1.6 * line, (pt.d || 8) * k / 2), 0, Math.PI * 2); ctx.fill()
    })
  }
  // размеры — тонкими линиями по целым точкам (без размытия), цифры без подложки
  if (groups.length) {
    const thin = Math.max(1, Math.round(line * 0.55)), snap = v => Math.round(v) + (thin % 2 ? 0.5 : 0)
    ctx.lineWidth = thin; ctx.lineCap = 'butt'; ctx.font = fontOf(dpx); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#000'
    const seg = (ax, ay, bx, by) => { ctx.beginPath(); ctx.moveTo(snap(ax), snap(ay)); ctx.lineTo(snap(bx), snap(by)); ctx.stroke() }
    for (const g of groups) {
      const [nx, ny] = g.n, P = g.nodes.map(v => (g.e === 'l' ? R(0, v) : g.e === 'r' ? R(DW, v) : g.e === 'b' ? R(v, 0) : R(v, DL)))
      const D = P.map(q => [q[0] + nx * O1, q[1] + ny * O1]), tk = Math.max(2, dpx * 0.22), last = D.length - 1
      P.forEach((q, i) => { seg(q[0] + nx * line, q[1] + ny * line, D[i][0] + nx * tk, D[i][1] + ny * tk); seg(D[i][0] - tk, D[i][1] + tk, D[i][0] + tk, D[i][1] - tk) })   // выносная линия и засечка
      seg(D[0][0], D[0][1], D[last][0], D[last][1])                                                                       // размерная линия
      let ang = Math.atan2(ny, nx); if (ang >= Math.PI / 2 - 1e-6) ang -= Math.PI; else if (ang < -Math.PI / 2 - 1e-6) ang += Math.PI
      // Цифры стоят поперёк размерной линии — каждой нужен шаг в высоту шрифта. Если отверстия ближе —
      // цифры раздвигаются вдоль линии (порядок сохраняется), от участка к цифре идёт короткая выноска.
      const L = Math.hypot(D[last][0] - D[0][0], D[last][1] - D[0][1]) || 1, ux = (D[last][0] - D[0][0]) / L, uy = (D[last][1] - D[0][1]) / L
      const mid = g.texts.map((_, i) => (((D[i][0] + D[i + 1][0]) / 2 - D[0][0]) * ux + ((D[i][1] + D[i + 1][1]) / 2 - D[0][1]) * uy))
      const pos = mid.slice(), pitch = dpx * 1.08
      for (let i = 1; i < pos.length; i++) if (pos[i] < pos[i - 1] + pitch) pos[i] = pos[i - 1] + pitch
      const shift = (mid.reduce((u, v) => u + v, 0) - pos.reduce((u, v) => u + v, 0)) / (pos.length || 1)
      g.texts.forEach((t, i) => {
        const u = pos[i] + shift, moved = Math.abs(u - mid[i]) > 1.5
        const bx = D[0][0] + ux * u + nx * (GAP + (moved ? dpx * 0.5 : 0)), by = D[0][1] + uy * u + ny * (GAP + (moved ? dpx * 0.5 : 0))
        if (moved) seg(D[0][0] + ux * mid[i], D[0][1] + uy * mid[i], bx, by)
        const tw = ctx.measureText(t).width, cx = bx + nx * (tw / 2 + 1), cy = by + ny * (tw / 2 + 1)
        ctx.save(); ctx.translate(Math.round(cx), Math.round(cy)); ctx.rotate(ang); ctx.fillText(t, 0, 0); ctx.restore()
      })
    }
  }
  ctx.restore()
}

/** Контуры деталей листа в координатах листа (мм, Y вверх) */
export function sheetOutlines(sheet, geo) {
  return (sheet.placed || []).map(p => {
    const pts = Array.isArray(p.polygon) && p.polygon.length > 2 ? p.polygon.map(q => [q.x, q.y]) : [[0, 0], [p.origX, 0], [p.origX, p.origY], [0, p.origY]]
    return pts.map(([x, y]) => [geo.marginL + p.x + x, geo.marginB + p.y + y])
  })
}

/** Карта листа в прямоугольнике (x, y, w, h): контуры деталей, деталь hi — чёрная. Лежачий прямоугольник — лист кладётся длиной по горизонтали. */
export function drawSheetMap(ctx, x, y, w, h, sheet, geo, hi = -1, line = 1, rot = false) {
  // rot — лист лежит горизонтально: длина листа (Y) — слева направо, начало листа — слева
  const SW = rot ? geo.sheetL : geo.sheetW, SH = rot ? geo.sheetW : geo.sheetL
  const k = Math.min(w / SW, h / SH), ox = x + (w - SW * k) / 2, oy = y + (h - SH * k) / 2
  const T = ([px, py]) => (rot ? [ox + py * k, oy + px * k] : [ox + px * k, oy + (SH - py) * k])
  ctx.save()
  ctx.lineWidth = line; ctx.strokeStyle = '#000'; ctx.fillStyle = '#000'; ctx.lineJoin = 'round'
  ctx.strokeRect(ox, oy, SW * k, SH * k)
  sheetOutlines(sheet, geo).forEach((pts, i) => {
    ctx.beginPath()
    pts.forEach((q, j) => { const [a, b] = T(q); if (j) ctx.lineTo(a, b); else ctx.moveTo(a, b) })
    ctx.closePath()
    if (i === hi) ctx.fill()
    ctx.stroke()
  })
  ctx.restore()
}

function fitText(ctx, text, maxW, size, weight = '') {
  let s = size
  const set = () => { ctx.font = `${weight} ${Math.round(s)}px Arial, Helvetica, sans-serif`.trim() }
  set()
  while (s > size * 0.6 && ctx.measureText(text).width > maxW) { s -= 1; set() }
  let t = text
  while (t.length > 1 && ctx.measureText(t).width > maxW) t = t.slice(0, -2) + '…'
  return t
}

/** Текст элемента бирки */
export function labelText(type, info, tpl = null) {
  switch (type) {
    case 'order': { const o = tpl?.order || { prefix: 'Заказ', number: true, name: true }; return [o.prefix, o.number && info.orderNumber, o.name && info.orderName].filter(Boolean).join(' ') }
    case 'material': return info.material
    case 'title': return [info.des, info.name].filter(Boolean).join(' ')
    case 'name': return info.name
    case 'des': return info.des
    case 'pos': return info.pos ? `Поз. ${info.pos}` : ''
    case 'prefix': return info.prefix
    case 'size': return `${r1(info.length)} x ${r1(info.width)} x ${info.qty} шт`
    case 'curved': return info.curved.length ? `Крив. кромка: ${info.curved.join('; ')}` : ''
    case 'work': return [...info.work, info.twoSided ? '⇅ с двух сторон' : ''].filter(Boolean).join(', ')
    case 'sheet': return `Карта  ${info.sheet}`
    case 'num': return String(info.num)
    case 'edgeTop': case 'edgeBottom': case 'edgeLeft': case 'edgeRight': {
      // сторона бирки = сторона детали на карте (карта и деталь на бирке повёрнуты одинаково)
      const rot = tpl ? tpl.rot !== false : true, side = type.slice(4).toLowerCase(), name = (rot ? info.sidesCw : info.sides)[side]
      const horiz = side === 'top' || side === 'bottom'
      return name ? `${name} · ${r1(horiz === rot ? info.sizeY : info.sizeX)}` : ''
    }
    case 'faceHoles': return info.faceHoles ? `Отв. в пласть: ${info.faceHoles}` : ''
    case 'backHoles': return info.backHoles ? `Нижняя присадка: ${info.backHoles}` : ''
    case 'endHoles': return info.endHoles ? `Отв. в торец: ${info.endHoles}` : ''
    case 'grooves': return info.grooves ? `Пазов: ${info.grooves}` : ''
    case 'pockets': return info.pockets ? `Выемок: ${info.pockets}` : ''
    case 'cutouts': return info.cutouts ? `Вырезов: ${info.cutouts}` : ''
    case 'twoSided': return info.twoSided ? '⇅ обработка с двух сторон' : ''
    case 'edgeList': return info.edgeList.length ? `Кромка: ${info.edgeList.join(', ')}` : ''
    case 'length': return r1(info.length)
    case 'width': return r1(info.width)
    case 'thickness': return info.thickness ? `${r1(info.thickness)} мм` : ''
    case 'qty': return `${info.qty} шт`
    case 'image': return ' '
    default: { const v = type.startsWith('meta:') ? info.meta?.[type.slice(5)] : ''; return v == null ? '' : String(v) }
  }
}

/**
 * Нарисовать бирку. canvas — уже нужного размера (мм × LABEL_PX_MM); info — labelInfo();
 * sheetCtx — { sheet, geo, index, detail } для карты и чертежа детали.
 */
export function drawLabel(canvas, tpl, info, sheetCtx = null) {
  const ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height
  const mm = W / tpl.w, line = Math.max(1, mm * 0.17), rot = tpl.rot !== false
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H)
  ctx.fillStyle = '#000'; ctx.textBaseline = 'middle'

  for (const it of tpl.items || []) {
    const x = it.x * mm, y = it.y * mm, w = it.w * mm
    if (it.type === 'qr') {
      const text = labelQr(tpl, info)
      if (!text) continue
      try {
        const qr = qrcode(0, 'M'); qr.addData(unescape(encodeURIComponent(text))); qr.make()
        const n = qr.getModuleCount(), cell = Math.max(1, Math.floor(Math.min(w, it.h * mm) / n))
        for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect(Math.round(x) + c * cell, Math.round(y) + r * cell, cell, cell)
      } catch { /* слишком длинная строка — без QR */ }
    } else if (it.type === 'map') {
      if (sheetCtx) drawSheetMap(ctx, x, y, w, it.h * mm, sheetCtx.sheet, sheetCtx.geo, sheetCtx.index, line, rot)
    } else if (it.type === 'part') {
      const p = sheetCtx?.sheet.placed[sheetCtx.index]
      if (p) drawPart(ctx, x, y, w, it.h * mm, p, sheetCtx.detail, line, rot, tpl.part?.dims ? tpl.part.dimSize * mm : 0)
    } else {
      const text = labelText(it.type, info, tpl)
      if (!text) continue                                   // параметра у детали нет — ни текста, ни картинки
      if (it.img || it.type === 'image') {
        const im = IMAGES.get(it.img)
        if (im?.complete && im.naturalWidth) {
          const bh = it.h * mm, k = Math.min(w / im.naturalWidth, bh / im.naturalHeight)
          ctx.drawImage(printImage(it.img, im, Math.max(1, Math.round(im.naturalWidth * k)), Math.max(1, Math.round(im.naturalHeight * k))), Math.round(x), Math.round(y))
        }
        continue
      }
      const t = fitText(ctx, text, w, it.size * mm, it.bold ? 'bold' : ''), sz = it.size * mm
      const ax = it.align === 'right' ? w : it.align === 'center' ? w / 2 : 0
      ctx.textAlign = it.align === 'right' ? 'right' : it.align === 'center' ? 'center' : 'left'
      ctx.save()
      // кромка слева читается снизу вверх, справа — сверху вниз; рамка элемента — узкая и высокая
      if (it.type === 'edgeLeft') { ctx.translate(x, y + w); ctx.rotate(-Math.PI / 2) } else if (it.type === 'edgeRight') { ctx.translate(x + sz * 1.25, y); ctx.rotate(Math.PI / 2) } else ctx.translate(x, y)
      ctx.fillText(t, ax, sz * 0.62)
      if (it.ul === 'below' || it.ul === 'above') { const tw = ctx.measureText(t).width, x0 = it.align === 'right' ? w - tw : it.align === 'center' ? (w - tw) / 2 : 0, th = Math.max(1, Math.round(sz * 0.09)); ctx.fillRect(x0, it.ul === 'below' ? sz * 1.16 : 0, tw, th) }
      ctx.restore()
    }
  }
  return canvas
}

/** Размер картинки бирки в точках; preview — для экрана (без лишнего разрешения) */
export const labelPx = (tpl, preview = false) => { const k = preview ? 12 : pxMm(tpl); return { w: Math.round(tpl.w * k / 4) * 4, h: Math.round(tpl.h * k) } }

/** canvas -> BMP, 1 бит на точку (чёрно-белая — как печатает термопринтер; файл в 20 раз меньше полноцветного) */
export function canvasToBmp(canvas, dpi = 203) {
  const w = canvas.width, h = canvas.height, px = canvas.getContext('2d').getImageData(0, 0, w, h).data
  const row = Math.ceil(w / 32) * 4, off = 62, size = off + row * h
  const out = new Uint8Array(size), dv = new DataView(out.buffer)
  out[0] = 0x42; out[1] = 0x4D
  dv.setUint32(2, size, true); dv.setUint32(10, off, true); dv.setUint32(14, 40, true)
  dv.setInt32(18, w, true); dv.setInt32(22, h, true); dv.setUint16(26, 1, true); dv.setUint16(28, 1, true)
  dv.setUint32(34, row * h, true); dv.setInt32(38, Math.round(dpi * 39.37), true); dv.setInt32(42, Math.round(dpi * 39.37), true)
  dv.setUint32(46, 2, true); dv.setUint32(50, 2, true)
  dv.setUint32(54, 0x00000000, true); dv.setUint32(58, 0x00FFFFFF, true)                          // палитра: 0 — чёрный, 1 — белый
  for (let y = 0; y < h; y++) {
    const o = off + (h - 1 - y) * row
    for (let x = 0, i = y * w * 4; x < w; x++, i += 4) if ((px[i] * 3 + px[i + 1] * 6 + px[i + 2]) / 10 >= 140) out[o + (x >> 3)] |= 0x80 >> (x & 7)
  }
  return out
}
const canvasToJpg = canvas => new Promise(res => canvas.toBlob(async b => res(b ? new Uint8Array(await b.arrayBuffer()) : new Uint8Array()), 'image/jpeg', 0.92))
const xml = (cycles) => '﻿' + ['<?xml version="1.0" encoding="UTF-8"?>', '<CycleFile>', ...cycles.flatMap(([name, fields]) => [`  <Cycle Name="${name}">`,
  ...fields.map(([k, v]) => `    <Field Name="${k}" Value="${String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}"/>`), '  </Cycle>']), '</CycleFile>', ''].join('\r\n')

/**
 * Файлы стола бирковки для выбранных листов.
 * sheets: [{ si, nc }] — номер листа и имя его программы раскроя; base — общая часть имени (заказ); post — постпроцессор (начало обработки).
 * -> [{ name, data: Uint8Array }]
 */
export async function buildLabelFiles({ order, mat, sheets, base, post, tpl }) {
  const files = [], list = [], { w, h } = labelPx(tpl)
  await preloadLabelImages(tpl)
  const ox = Number(post?.originX) || 0, oy = Number(post?.originY) || 0
  for (const { si, nc } of sheets) {
    const sheet = mat.sheets[si], geo = sheetGeo(order, mat.result, sheet), stem = `${si + 1}_${base}`
    const cyc = `Label_${stem}.cyc`, jpg = `${stem}.jpg`
    const cycles = []
    sheet.placed.forEach((p, pi) => {
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h
      drawLabel(cv, tpl, labelInfo(order, mat, si, pi), { sheet, geo, index: pi, detail: mat.details[p.detailIndex] })
      const bmp = `${stem}_${String(pi + 1).padStart(4, '0')}.bmp`
      files.push({ name: bmp, data: canvasToBmp(cv, tpl.dpi) })
      // точка наклейки — центр детали; бирки клеятся в одном положении (R = 0), как в образцах
      const pts = Array.isArray(p.polygon) && p.polygon.length > 2 ? p.polygon : [{ x: 0, y: 0 }, { x: p.origX, y: p.origY }]
      const xs = pts.map(q => q.x), ys = pts.map(q => q.y), R = 0
      cycles.push(['Cycle_Label', [['LabelName', bmp], ['X', r1(ox + geo.marginL + p.x + (Math.min(...xs) + Math.max(...xs)) / 2)], ['Y', r1(oy + geo.marginB + p.y + (Math.min(...ys) + Math.max(...ys)) / 2)], ['R', R]]])
    })
    files.push({ name: cyc, data: strToU8(xml(cycles)) })
    const map = document.createElement('canvas'); map.width = 500; map.height = 500
    const c = map.getContext('2d'); c.fillStyle = '#fff'; c.fillRect(0, 0, 500, 500)
    drawSheetMap(c, 10, 10, 480, 480, sheet, geo, -1, 2)
    files.push({ name: jpg, data: await canvasToJpg(map) })
    list.push(['Cycle_List', [['PlateID', nc], ['LabelName', cyc], ['LargeImage', jpg], ['SmallImage', jpg], ['Color', 'Black'], ['Thickness', r1(mat.thickness)]]])
  }
  files.unshift({ name: `List_${base}.xml`, data: strToU8(xml(list)) })
  return files
}

export const zipFiles = files => zipSync(Object.fromEntries(files.map(f => [f.name, typeof f.data === 'string' ? strToU8(f.data) : f.data])), { level: 6 })
