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
import { detailMeta } from './partLabel'
import { isTwoSided } from './partInfo'
import { placedTurns, placedHoles } from './partHoles'
import { rotatePointTimes, getAllDrillPoints, getGrooveRects } from './drillGeometry'
import { detailEdgeList } from './edgeLength'
import { sheetGeo } from './savedNesting'

// Бирка собирается из элементов: каждый можно поставить в любое место бирки и задать ему размер.
// Элемент шаблона: { id, type, x, y, w, h (мм), size (высота шрифта, мм), bold }.
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
  ['work', 'Отверстия, пазы — текстом', 'text'],
  ['sheet', 'Номер карты', 'text'],
  ['num', 'Номер детали на листе', 'text'],
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
export const itemTitle = type => (LABEL_ITEMS.find(x => x[0] === type) || [])[1] || type
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
  { type: 'qr', x: 58, y: 6.5, w: 21, h: 21 },
  { type: 'map', x: 46.5, y: 30, w: 32.5, h: 22 },
]
// место нового элемента — там же, где он стоит в раскладке по умолчанию, иначе — посередине
export function newLabelItem(type, tpl) {
  const d = DEFAULT_ITEMS.find(i => i.type === type), kx = tpl.w / BASE.w, ky = tpl.h / BASE.h
  const it = d ? { ...d, x: d.x * kx, y: d.y * ky, w: d.w * kx, ...(d.h ? { h: d.h * ky } : {}), ...(d.size ? { size: d.size * Math.min(kx, ky) } : {}) }
    : itemKind(type) === 'pic' ? { type, x: tpl.w * 0.3, y: tpl.h * 0.3, w: tpl.w * 0.3, h: tpl.h * 0.3 } : { type, x: tpl.w * 0.1, y: tpl.h * 0.45, w: tpl.w * 0.5, size: 2.6 * Math.min(kx, ky) }
  return { ...it, id: type + '_' + Math.random().toString(36).slice(2, 7) }
}
export const DEFAULT_LABEL = () => { const t = { enabled: false, w: BASE.w, h: BASE.h, edges: true, rot: true, qr: { ...QR_DEFAULT } }; return { ...t, items: DEFAULT_ITEMS.map(i => newLabelItem(i.type, t)) } }
export function normalizeLabel(raw) {
  const d = DEFAULT_LABEL(), t = raw && typeof raw === 'object' ? raw : {}
  const n = (v, def, lo, hi) => { const x = Number(v); return isFinite(x) && x > 0 ? Math.max(lo, Math.min(hi, x)) : def }
  const w = n(t.w, d.w, 20, 200), h = n(t.h, d.h, 15, 200)
  let items = Array.isArray(t.items) ? t.items.filter(i => i && LABEL_ITEMS.some(x => x[0] === i.type)) : null
  if (!items) {                                            // шаблон прежнего вида (галочки) — раскладка по умолчанию с теми же полями
    const f = t.fields, base = { w, h }
    items = DEFAULT_ITEMS.filter(i => !f || (i.type === 'title' ? f.name !== false || f.des !== false : f[i.type] !== false)).map(i => newLabelItem(i.type, base))
  }
  items = items.map(i => {
    const pic = itemKind(i.type) === 'pic', iw = Math.max(3, Math.min(w, Number(i.w) || 20))
    const o = { id: i.id || i.type + '_' + Math.random().toString(36).slice(2, 7), type: i.type, w: iw, bold: !!i.bold, align: i.align === 'right' ? 'right' : 'left' }
    if (pic) o.h = Math.max(3, Math.min(h, Number(i.h) || 20)); else o.size = Math.max(1.2, Math.min(20, Number(i.size) || 2.6))
    const ih = pic ? o.h : o.size * 1.25
    o.x = Math.max(0, Math.min(w - iw, Number(i.x) || 0)); o.y = Math.max(0, Math.min(h - ih, Number(i.y) || 0))
    return o
  })
  return { enabled: !!t.enabled, w, h, edges: t.edges ?? (t.fields ? t.fields.edges !== false : true), rot: t.rot !== false, items,
    qr: { parts: Array.isArray(t.qr?.parts) ? t.qr.parts.filter(k => QR_PARTS.some(x => x[0] === k)) : [...QR_DEFAULT.parts], sep: typeof t.qr?.sep === 'string' ? t.qr.sep.slice(0, 3) : ';', text: String(t.qr?.text || '').slice(0, 60), latin: !!t.qr?.latin } }
}
/** Новый размер бирки — элементы растягиваются вместе с ней */
export function resizeLabel(tpl, w, h) {
  const kx = w / tpl.w, ky = h / tpl.h, k = Math.min(kx, ky)
  return normalizeLabel({ ...tpl, w, h, items: tpl.items.map(i => ({ ...i, x: i.x * kx, y: i.y * ky, w: i.w * kx, ...(i.h ? { h: i.h * ky } : {}), ...(i.size ? { size: i.size * k } : {}) })) })
}
export const getLabelTpl = user => normalizeLabel(getUserSettings(user).labelTpl)
export const saveLabelTpl = (tpl, user) => saveUserSettings({ labelTpl: tpl }, user)

export const LABEL_PX_MM = 8                               // точек на мм (≈ 203 dpi — термопринтер)
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
  const drills = (c?.drillings || []).filter(x => x.installed !== false)
  const face = drills.filter(x => x.kind !== 'edge').length, end = drills.filter(x => x.kind === 'edge').length
  const grooves = (c?.grooves || []).length, pockets = (c?.holes || []).filter(h => h.type === 'pocket').length
  const cutouts = (c?.holes || []).filter(h => h.type !== 'pocket').length
  const work = [face && `отв. в пласть ${face}`, end && `в торец ${end}`, grooves && `пазов ${grooves}`, pockets && `выемок ${pockets}`, cutouts && `вырезов ${cutouts}`].filter(Boolean)
  return {
    order: [order.order_number, order.order_name].filter(Boolean).join(' '), orderNumber: order.order_number || '', orderName: order.order_name || '', materialName: mat.name || '',
    num: pi + 1, sheet: si + 1, sheets: mat.sheets.length,
    name: d.name || p.label || 'Деталь', des: m.des || '', pos: m.pos != null ? String(m.pos) : '', prefix: d.prefix || p.prefix || '',
    material: [mat.name, mat.thickness ? `${mat.thickness} мм` : ''].filter(Boolean).join(' · '),
    length: Number(d.length) || 0, width: Number(d.width) || 0, sizeX: even ? DW : DL, sizeY: even ? DL : DW, thickness: mat.thickness, qty: Number(d.qty) || 1,
    sides, sidesCw: { top: sides.left, bottom: sides.right, left: sides.bottom, right: sides.top }, curved: Object.entries(curved).map(([name, mm]) => `${name} ${(mm / 1000).toFixed(2)} м`),
    work, twoSided: isTwoSided(d, mat.thickness),
  }
}

/**
 * Чертёж детали в прямоугольнике (x, y, w, h) — так, как она лежит на карте раскроя (тот же поворот, Y вверх):
 * контур, вырезы, выемки и пазы лицевой стороны, отверстия в пласть (кружки) и в торец (полоса на глубину),
 * Кромка на чертеже не показывается. Обработка с изнанки не показывается.
 */
export function drawPart(ctx, x0, y0, w0, h0, p, d, line = 1, rot = false) {
  const m = 2 * line, x = x0 + m, y = y0 + m, w = Math.max(4, w0 - 2 * m), h = Math.max(4, h0 - 2 * m)
  let c = d?.contour
  if (typeof c === 'string') { try { c = JSON.parse(c) } catch { c = null } }
  const DW = Number(d?.width) || 0, DL = Number(d?.length) || 0, turns = placedTurns(p, d || {})
  const outline = Array.isArray(p.polygon) && p.polygon.length > 2 ? p.polygon.map(q => [q.x, q.y]) : [[0, 0], [p.origX, 0], [p.origX, p.origY], [0, p.origY]]
  const bw = Number(p.origX) || Math.max(...outline.map(q => q[0])), bh = Number(p.origY) || Math.max(...outline.map(q => q[1]))
  // rot — лист на бирке лежит горизонтально (длина листа — слева направо): деталь поворачивается вместе с картой
  const vw = rot ? bh : bw, vh = rot ? bw : bh
  const k = Math.min(w / vw, h / vh), ox = x + (w - vw * k) / 2, oy = y + (h - vh * k) / 2
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
    getAllDrillPoints(c, DW, DL, true).forEach(pt => {
      const a = R(pt.x, pt.y)
      if (pt.edge) {
        const dep = pt.depth > 0 ? pt.depth : 20, b = R(pt.x + pt.dx * dep, pt.y + pt.dy * dep)
        ctx.lineWidth = Math.max(2 * line, (pt.d || 8) * k); ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke()
        return
      }
      ctx.beginPath(); ctx.arc(a[0], a[1], Math.max(1.6 * line, (pt.d || 8) * k / 2), 0, Math.PI * 2); ctx.fill()
    })
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
export function labelText(type, info) {
  switch (type) {
    case 'order': return `Заказ ${info.order}`
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
    default: return ''
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

  // кромка — по сторонам бирки: там же, где она у детали на карте (карта и деталь на бирке повёрнуты одинаково)
  if (tpl.edges) {
    const pad = 5.5 * mm, sides = rot ? info.sidesCw : info.sides, lenH = rot ? info.sizeY : info.sizeX, lenV = rot ? info.sizeX : info.sizeY
    const side = (name, len, cx, cy, ang, maxW) => {
      if (!name) return
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(ang)
      const t = fitText(ctx, `${name} · ${r1(len)}`, maxW, 2.4 * mm, 'bold')
      ctx.textAlign = 'center'; ctx.fillText(t, 0, 0)
      const tw = ctx.measureText(t).width
      ctx.fillRect(-tw / 2, 1.4 * mm, tw, Math.max(1, 0.25 * mm))
      ctx.restore()
    }
    side(sides.top, lenH, W / 2, pad / 2, 0, W - pad * 2 - 12 * mm)
    side(sides.bottom, lenH, W / 2, H - pad / 2 - 0.3 * mm, 0, W * 0.5)
    side(sides.right, lenV, W - pad / 2, H / 2, Math.PI / 2, H - pad * 2)
    side(sides.left, lenV, pad / 2, H / 2, -Math.PI / 2, H - pad * 2)
  }
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
      if (p) drawPart(ctx, x, y, w, it.h * mm, p, sheetCtx.detail, line, rot)
    } else {
      const text = labelText(it.type, info)
      if (!text) continue
      const t = fitText(ctx, text, w, it.size * mm, it.bold ? 'bold' : '')
      ctx.textAlign = it.align === 'right' ? 'right' : 'left'
      ctx.fillText(t, it.align === 'right' ? x + w : x, y + it.size * mm * 0.62)
    }
  }
  return canvas
}

export const labelPx = tpl => ({ w: Math.round(tpl.w * LABEL_PX_MM / 4) * 4, h: Math.round(tpl.h * LABEL_PX_MM) })

/** canvas -> BMP, 1 бит на точку (чёрно-белая — как печатает термопринтер; файл в 20 раз меньше полноцветного) */
export function canvasToBmp(canvas) {
  const w = canvas.width, h = canvas.height, px = canvas.getContext('2d').getImageData(0, 0, w, h).data
  const row = Math.ceil(w / 32) * 4, off = 62, size = off + row * h
  const out = new Uint8Array(size), dv = new DataView(out.buffer)
  out[0] = 0x42; out[1] = 0x4D
  dv.setUint32(2, size, true); dv.setUint32(10, off, true); dv.setUint32(14, 40, true)
  dv.setInt32(18, w, true); dv.setInt32(22, h, true); dv.setUint16(26, 1, true); dv.setUint16(28, 1, true)
  dv.setUint32(34, row * h, true); dv.setInt32(38, 7992, true); dv.setInt32(42, 7992, true)      // 203 dpi
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
  const ox = Number(post?.originX) || 0, oy = Number(post?.originY) || 0
  for (const { si, nc } of sheets) {
    const sheet = mat.sheets[si], geo = sheetGeo(order, mat.result, sheet), stem = `${si + 1}_${base}`
    const cyc = `Label_${stem}.cyc`, jpg = `${stem}.jpg`
    const cycles = []
    sheet.placed.forEach((p, pi) => {
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h
      drawLabel(cv, tpl, labelInfo(order, mat, si, pi), { sheet, geo, index: pi, detail: mat.details[p.detailIndex] })
      const bmp = `${stem}_${String(pi + 1).padStart(4, '0')}.bmp`
      files.push({ name: bmp, data: canvasToBmp(cv) })
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
