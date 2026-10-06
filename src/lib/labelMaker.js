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
import { placedTurns } from './partHoles'
import { rotateEdgesTimes } from './drillGeometry'
import { detailEdgeList } from './edgeLength'
import { sheetGeo } from './savedNesting'

export const LABEL_FIELDS = [
  ['order', 'Заказ'],
  ['num', 'Номер детали на листе'],
  ['material', 'Материал'],
  ['name', 'Наименование'],
  ['des', 'Обозначение'],
  ['pos', 'Позиция'],
  ['prefix', 'Изделие (префикс)'],
  ['size', 'Размер и количество'],
  ['edges', 'Кромка по сторонам'],
  ['curved', 'Криволинейная кромка'],
  ['holes', 'Отверстия, пазы, обработка с двух сторон'],
  ['sheet', 'Номер карты'],
  ['qr', 'QR-код'],
  ['map', 'Карта раскроя — деталь выделена чёрным'],
]
const ON = ['order', 'num', 'material', 'name', 'des', 'size', 'edges', 'curved', 'holes', 'sheet', 'qr', 'map']
export const DEFAULT_LABEL = () => ({ enabled: false, w: 85, h: 59, fields: Object.fromEntries(LABEL_FIELDS.map(([k]) => [k, ON.includes(k)])) })
export function normalizeLabel(raw) {
  const d = DEFAULT_LABEL(), t = raw && typeof raw === 'object' ? raw : {}
  const n = (v, def, lo, hi) => { const x = Number(v); return isFinite(x) && x > 0 ? Math.max(lo, Math.min(hi, x)) : def }
  return { enabled: !!t.enabled, w: n(t.w, d.w, 20, 200), h: n(t.h, d.h, 15, 200), fields: { ...d.fields, ...t.fields } }
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
  const sides = rotateEdgesTimes({ top: edgeName(d.edge_top), right: edgeName(d.edge_right), bottom: edgeName(d.edge_bottom), left: edgeName(d.edge_left) }, placedTurns(p, d))
  const curved = {}
  detailEdgeList(d).filter(e => e.curved).forEach(e => { curved[e.name] = (curved[e.name] || 0) + e.mm })
  const drills = (c?.drillings || []).filter(x => x.installed !== false)
  const face = drills.filter(x => x.kind !== 'edge').length, end = drills.filter(x => x.kind === 'edge').length
  const grooves = (c?.grooves || []).length, pockets = (c?.holes || []).filter(h => h.type === 'pocket').length
  const cutouts = (c?.holes || []).filter(h => h.type !== 'pocket').length
  const work = [face && `отв. в пласть ${face}`, end && `в торец ${end}`, grooves && `пазов ${grooves}`, pockets && `выемок ${pockets}`, cutouts && `вырезов ${cutouts}`].filter(Boolean)
  return {
    order: [order.order_number, order.order_name].filter(Boolean).join(' '), orderNumber: order.order_number || '',
    num: pi + 1, sheet: si + 1, sheets: mat.sheets.length,
    name: d.name || p.label || 'Деталь', des: m.des || '', pos: m.pos != null ? String(m.pos) : '', prefix: d.prefix || p.prefix || '',
    material: [mat.name, mat.thickness ? `${mat.thickness} мм` : ''].filter(Boolean).join(' · '),
    length: Number(d.length) || 0, width: Number(d.width) || 0, thickness: mat.thickness, qty: Number(d.qty) || 1,
    sides, curved: Object.entries(curved).map(([name, mm]) => `${name} ${(mm / 1000).toFixed(2)} м`),
    work, twoSided: isTwoSided(d, mat.thickness),
    qr: [order.order_number, `L${si + 1}`, `N${pi + 1}`, m.des || d.name || '', `${d.length}x${d.width}x${mat.thickness || ''}`].join(';'),
  }
}

/** Контуры деталей листа в координатах листа (мм, Y вверх) */
export function sheetOutlines(sheet, geo) {
  return (sheet.placed || []).map(p => {
    const pts = Array.isArray(p.polygon) && p.polygon.length > 2 ? p.polygon.map(q => [q.x, q.y]) : [[0, 0], [p.origX, 0], [p.origX, p.origY], [0, p.origY]]
    return pts.map(([x, y]) => [geo.marginL + p.x + x, geo.marginB + p.y + y])
  })
}

/** Карта листа в прямоугольнике (x, y, w, h): контуры деталей, деталь hi — чёрная. Лежачий прямоугольник — лист кладётся длиной по горизонтали. */
export function drawSheetMap(ctx, x, y, w, h, sheet, geo, hi = -1, line = 1) {
  const rot = w > h && geo.sheetL > geo.sheetW
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

/**
 * Нарисовать бирку. canvas — уже нужного размера (мм × LABEL_PX_MM); info — labelInfo(); sheetCtx — { sheet, geo, index } для карты.
 */
export function drawLabel(canvas, tpl, info, sheetCtx = null) {
  const ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height, f = tpl.fields || {}
  const u = Math.min(H / 472, W / 684)                    // единица вёрстки — как на образце 684 × 472
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H)
  ctx.fillStyle = '#000'; ctx.textBaseline = 'middle'
  const pad = Math.round((f.edges ? 44 : 14) * u)

  // кромка — по четырём сторонам бирки, как деталь лежит на листе
  if (f.edges) {
    const side = (text, cx, cy, ang, maxW) => {
      if (!text) return
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(ang)
      const t = fitText(ctx, text, maxW, 19 * u, 'bold')
      ctx.textAlign = 'center'; ctx.fillText(t, 0, 0)
      const tw = ctx.measureText(t).width
      ctx.fillRect(-tw / 2, 11 * u, tw, Math.max(1, 2 * u))
      ctx.restore()
    }
    side(info.sides.top, W / 2, pad / 2, 0, W - pad * 2 - 90 * u)
    side(info.sides.bottom, W / 2, H - pad / 2 - 2 * u, 0, W * 0.5)
    side(info.sides.right, W - pad / 2, H / 2, Math.PI / 2, H - pad * 2)
    side(info.sides.left, pad / 2, H / 2, -Math.PI / 2, H - pad * 2)
  }
  if (f.num) { ctx.font = `bold ${Math.round(24 * u)}px Arial, Helvetica, sans-serif`; ctx.textAlign = 'right'; ctx.fillText(String(info.num), W - pad - 4 * u, pad / 2 + 4 * u) }

  // правая колонка: QR и карта
  const colW = f.qr || f.map ? Math.round(Math.min(W * 0.36, H * 0.62)) : 0
  const colX = W - pad - colW
  let colY = pad + 8 * u
  const bottom = H - pad - 6 * u
  if (f.qr && info.qr) {
    const size = Math.min(colW * 0.68, (bottom - colY) * (f.map ? 0.46 : 0.9))
    try {
      const qr = qrcode(0, 'M'); qr.addData(unescape(encodeURIComponent(info.qr))); qr.make()
      const n = qr.getModuleCount(), cell = Math.max(1, Math.floor(size / n)), qx = Math.round(colX + colW - cell * n)
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect(qx + c * cell, Math.round(colY) + r * cell, cell, cell)
      colY += cell * n + 14 * u
    } catch { /* слишком длинная строка — без QR */ }
  }
  if (f.map && sheetCtx && bottom - colY > 30 * u) drawSheetMap(ctx, colX, colY, colW, bottom - colY, sheetCtx.sheet, sheetCtx.geo, sheetCtx.index, Math.max(1, 1.4 * u))

  // текст — слева
  const tx = pad + 8 * u, tw = (colW ? colX - 12 * u : W - pad) - tx
  let y = pad + 26 * u
  ctx.textAlign = 'left'
  const line = (text, size, weight = '', gap = 1.35) => {
    if (!text) return
    const t = fitText(ctx, text, tw, size * u, weight)
    ctx.fillText(t, tx, y); y += size * u * gap
  }
  if (f.order) line(`Заказ ${info.order}`, 25)
  if (f.material) line(info.material, 20)
  if (f.prefix) line(info.prefix, 20)
  const title = [f.des && info.des, f.name && info.name].filter(Boolean).join(' ')
  line(title, 22, 'bold')
  if (f.pos && info.pos) line(`Поз. ${info.pos}`, 20)
  if (f.size) { y += 10 * u; line(`${r1(info.length)} x ${r1(info.width)} x ${info.qty} шт`, 28, 'bold', 1.5) }
  if (f.curved && info.curved.length) info.curved.forEach(t => line(`Крив. кромка: ${t}`, 17))
  if (f.holes) { line(info.work.join(', '), 17); if (info.twoSided) line('⇅ обработка с двух сторон', 17, 'bold') }
  if (f.sheet) { ctx.font = `${Math.round(22 * u)}px Arial, Helvetica, sans-serif`; ctx.textAlign = 'left'; ctx.fillText(`Карта  ${info.sheet}`, tx, H - pad / 2 - 2 * u) }
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
      drawLabel(cv, tpl, labelInfo(order, mat, si, pi), { sheet, geo, index: pi })
      const bmp = `${stem}_${String(pi + 1).padStart(4, '0')}.bmp`
      files.push({ name: bmp, data: canvasToBmp(cv) })
      // точка наклейки — центр детали; узкая деталь — бирка поворачивается вдоль неё
      const pts = Array.isArray(p.polygon) && p.polygon.length > 2 ? p.polygon : [{ x: 0, y: 0 }, { x: p.origX, y: p.origY }]
      const xs = pts.map(q => q.x), ys = pts.map(q => q.y)
      const bw = Math.max(...xs) - Math.min(...xs), bh = Math.max(...ys) - Math.min(...ys)
      const R = bw < tpl.w && bh >= tpl.w ? 90 : 0
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
