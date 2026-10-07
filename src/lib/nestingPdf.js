// Карты раскроя в PDF: лист на страницу — схема листа (детали с номерами, размерами по сторонам и кромкой),
// сведения о листе с процентом использования материала и список деталей этого листа.
// Страница рисуется на canvas (так кириллица и линии получаются чёткими без встраивания шрифтов) и кладётся
// в PDF картинкой A4, 200 точек на дюйм.
import { zlibSync, strToU8 } from 'fflate'
import { sheetGeo } from './savedNesting'
import { placedHoles } from './partHoles'
import { detailMeta } from './partLabel'
import { orderTitle } from './orderUtils'
import { rawDetail } from './edgeCut'

const K = 1654 / 210                     // точек на мм
const PW = 1654, PH = 2339
const mm = v => v * K
const INK = '#1F1F1D', MUTED = '#6B6A66', LINE = '#B9B7B0', EDGE = '#E8590C', FILL = '#F3F0E8'
const r1 = v => Math.round(v * 10) / 10
const fmt = v => String(r1(v)).replace('.', ',')

const polyArea = pts => { let s = 0; for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; s += a.x * b.y - b.x * a.y } return Math.abs(s) / 2 }
const partArea = p => (Array.isArray(p.polygon) && p.polygon.length > 2 ? polyArea(p.polygon) : (Number(p.origX) || 0) * (Number(p.origY) || 0))

function text(ctx, s, x, y, { size = 3, bold = false, color = INK, align = 'left', max = 0, base = 'alphabetic' } = {}) {
  let px = mm(size)
  ctx.font = `${bold ? '600 ' : ''}${px}px Arial, Helvetica, sans-serif`
  s = String(s ?? '')
  if (max > 0 && ctx.measureText(s).width > mm(max)) {
    while (s.length > 1 && ctx.measureText(s + '…').width > mm(max)) s = s.slice(0, -1)
    s += '…'
  }
  ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = base
  ctx.fillText(s, mm(x), mm(y))
}
const rule = (ctx, x0, y0, x1, y1, w = 0.2, color = LINE) => { ctx.strokeStyle = color; ctx.lineWidth = mm(w); ctx.beginPath(); ctx.moveTo(mm(x0), mm(y0)); ctx.lineTo(mm(x1), mm(y1)); ctx.stroke() }

// кромка детали словами: «Белая: Дл, Шв, Шн»
function edgeText(d) {
  const sides = [['edge_left', 'Дл'], ['edge_right', 'Дп'], ['edge_top', 'Шв'], ['edge_bottom', 'Шн']]
  const by = new Map()
  for (const [k, s] of sides) { const v = d?.[k]; if (!v || v === 'false') continue; const n = v === 'default' || v === true ? 'кромка' : String(v); by.set(n, [...(by.get(n) || []), s]) }
  return [...by].map(([n, list]) => `${n}: ${list.join(', ')}`).join('; ')
}

/** Строки списка деталей листа: [{ no, di, name, size, qty, edge }] и номер по детали */
function sheetRows(sheet, details) {
  const cnt = new Map()
  for (const p of sheet.placed) cnt.set(p.detailIndex, (cnt.get(p.detailIndex) || 0) + 1)
  const rows = [...cnt].sort((a, b) => a[0] - b[0]).map(([di, qty], i) => {
    const d = details[di] || {}, raw = rawDetail(d), m = detailMeta(d)
    const blank = d._cut ? ` (готовая ${fmt(raw.length)}×${fmt(raw.width)})` : ''
    return { no: i + 1, di, name: [m?.des, d.display_name || d.name].filter(Boolean).join('  ') || 'Деталь', size: `${fmt(d.length)} × ${fmt(d.width)}${blank}`, qty, edge: edgeText(raw) }
  })
  return { rows, noOf: new Map(rows.map(r => [r.di, r.no])) }
}

function drawSheet(ctx, bx, by, bw, bh, sheet, geo, details, noOf) {
  const s = Math.min(bw / geo.sheetW, bh / geo.sheetL)                    // мм бумаги на мм листа
  const x0 = bx + (bw - geo.sheetW * s) / 2, y0 = by
  const X = v => mm(x0 + v * s), Y = v => mm(y0 + (geo.sheetL - v) * s)   // v — от левого нижнего угла листа
  ctx.fillStyle = '#E9E6DD'; ctx.fillRect(X(0), Y(geo.sheetL), mm(geo.sheetW * s), mm(geo.sheetL * s))
  ctx.fillStyle = '#FFFFFF'; ctx.fillRect(X(geo.marginL), Y(geo.marginB + geo.usableY), mm(geo.usableX * s), mm(geo.usableY * s))
  // деловые обрезки
  for (const o of sheet.manualOffcuts || []) {
    const ox = Math.max(0, geo.marginL + o.x), oy = Math.max(0, geo.marginB + o.y), ow = Math.min(geo.sheetW, geo.marginL + o.x + o.w) - ox, oh = Math.min(geo.sheetL, geo.marginB + o.y + o.h) - oy
    ctx.fillStyle = 'rgba(232,89,12,0.08)'; ctx.fillRect(X(ox), Y(oy + oh), mm(ow * s), mm(oh * s))
    ctx.strokeStyle = EDGE; ctx.lineWidth = mm(0.25); ctx.setLineDash([mm(1.4), mm(1)]); ctx.strokeRect(X(ox), Y(oy + oh), mm(ow * s), mm(oh * s)); ctx.setLineDash([])
    if (ow * s > 16 && oh * s > 8) {
      text(ctx, 'обрезок', x0 + (ox + ow / 2) * s, y0 + (geo.sheetL - oy - oh / 2) * s - 0.6, { size: 2.4, color: EDGE, align: 'center' })
      text(ctx, `${Math.round(o.h)} × ${Math.round(o.w)}`, x0 + (ox + ow / 2) * s, y0 + (geo.sheetL - oy - oh / 2) * s + 2.6, { size: 2.6, bold: true, color: EDGE, align: 'center' })
    }
  }
  for (const p of sheet.placed) {
    const w = Number(p.origX) || 0, h = Number(p.origY) || 0
    const px = geo.marginL + p.x, py = geo.marginB + p.y                  // левый нижний угол детали на листе
    ctx.fillStyle = FILL; ctx.strokeStyle = INK; ctx.lineWidth = mm(0.28); ctx.lineJoin = 'round'
    const path = pts => { ctx.beginPath(); pts.forEach((q, i) => (i ? ctx.lineTo(X(px + q.x), Y(py + q.y)) : ctx.moveTo(X(px + q.x), Y(py + q.y)))); ctx.closePath() }
    const shaped = Array.isArray(p.polygon) && p.polygon.length > 2
    path(shaped ? p.polygon : [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }])
    ctx.fill(); ctx.stroke()
    const d = details[p.detailIndex]
    for (const hole of (d ? placedHoles(p, d) : [])) { ctx.fillStyle = '#FFFFFF'; path(hole); ctx.fill(); ctx.stroke() }
    // кромка — жирная линия с отступом внутрь, со стороны, где она стоит (стороны уже повёрнуты вместе с деталью)
    const g = Math.min(1.1 / s, Math.min(w, h) * 0.12)
    ctx.strokeStyle = EDGE; ctx.lineWidth = mm(0.7); ctx.lineCap = 'butt'
    const seg = (ax, ay, bx2, by2) => { ctx.beginPath(); ctx.moveTo(X(px + ax), Y(py + ay)); ctx.lineTo(X(px + bx2), Y(py + by2)); ctx.stroke() }
    if (p.edgeTop) seg(g, h - g, w - g, h - g)
    if (p.edgeBottom) seg(g, g, w - g, g)
    if (p.edgeLeft) seg(g, g, g, h - g)
    if (p.edgeRight) seg(w - g, g, w - g, h - g)
    // подписи: номер по списку — в середине, размеры — вдоль сторон внутри детали
    const pw = w * s, ph = h * s, cx = x0 + (px + w / 2) * s, cy = y0 + (geo.sheetL - py - h / 2) * s
    const no = String(noOf.get(p.detailIndex) ?? '')
    const ns = Math.max(2.2, Math.min(5, Math.min(pw, ph) * 0.42))
    if (pw > 3.2 && ph > 3.2) text(ctx, no, cx, cy, { size: ns, bold: true, align: 'center', base: 'middle' })
    const ds = Math.max(1.9, Math.min(2.6, Math.min(pw, ph) * 0.16))
    if (pw > 13 && ph > ns + ds * 2.4 + 2) text(ctx, fmt(w), cx, y0 + (geo.sheetL - py - h) * s + ds + 1.6, { size: ds, color: MUTED, align: 'center' })
    if (ph > 13 && pw > ns + ds * 2.4 + 2) {
      ctx.save(); ctx.translate(mm(x0 + px * s + ds + 1.4), mm(cy)); ctx.rotate(-Math.PI / 2)
      ctx.font = `${mm(ds)}px Arial, Helvetica, sans-serif`; ctx.fillStyle = MUTED; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'
      ctx.fillText(fmt(h), 0, 0); ctx.restore()
    }
  }
  ctx.strokeStyle = INK; ctx.lineWidth = mm(0.4); ctx.strokeRect(X(0), Y(geo.sheetL), mm(geo.sheetW * s), mm(geo.sheetL * s))
  return { right: x0 + geo.sheetW * s, bottom: y0 + geo.sheetL * s }
}

const COLS = [[10, '№', 9], [19, 'Деталь', 62], [81, 'Длина × ширина, мм', 50], [131, 'Шт.', 10], [141, 'Кромка', 59]]
function tableHead(ctx, y) {
  ctx.fillStyle = '#EFEDE6'; ctx.fillRect(mm(10), mm(y), mm(190), mm(6.4))
  COLS.forEach(([x, t]) => text(ctx, t, x + 1.2, y + 4.4, { size: 2.7, bold: true, color: MUTED }))
  return y + 6.4
}
function tableRow(ctx, y, r) {
  text(ctx, r.no, COLS[0][0] + 1.2, y + 4.3, { size: 3, bold: true })
  text(ctx, r.name, COLS[1][0] + 1.2, y + 4.3, { size: 3, max: COLS[1][2] - 2 })
  text(ctx, r.size, COLS[2][0] + 1.2, y + 4.3, { size: 3, max: COLS[2][2] - 2 })
  text(ctx, r.qty, COLS[3][0] + 1.2, y + 4.3, { size: 3, bold: true })
  text(ctx, r.edge || '—', COLS[4][0] + 1.2, y + 4.3, { size: 2.8, color: r.edge ? EDGE : MUTED, max: COLS[4][2] - 2 })
  rule(ctx, 10, y + 6, 200, y + 6, 0.12)
  return y + 6
}

/**
 * mat — { name | label, thickness, result, sheets, details } (как у savedNestings; details — детали этого материала).
 * -> Uint8Array (PDF, A4)
 */
export async function buildNestingPdf({ order, mat, onProgress }) {
  const sheets = (mat.sheets || []).filter(sh => sh?.placed?.length)
  const cv = document.createElement('canvas'); cv.width = PW; cv.height = PH
  const ctx = cv.getContext('2d')
  const matName = [mat.name || mat.label || order?.material_name || '', mat.thickness ? `${mat.thickness} мм` : ''].filter(Boolean).join(' · ')
  const geos = sheets.map(sh => sheetGeo(order, mat.result, sh))
  const used = sheets.map(sh => sh.placed.reduce((a, p) => a + partArea(p), 0))
  const totalUsed = used.reduce((a, b) => a + b, 0), totalArea = geos.reduce((a, g) => a + g.usableX * g.usableY, 0)
  const totalParts = sheets.reduce((a, sh) => a + sh.placed.length, 0)
  const pages = []                                   // функции, рисующие страницу
  const header = (si, cont) => {
    ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, PW, PH)
    text(ctx, `Карта раскроя · ${orderTitle(order)}`, 10, 15, { size: 5, bold: true, max: 140 })
    text(ctx, `${sheets[si].stock === 'offcut' ? 'Обрезок' : 'Лист'} ${si + 1} из ${sheets.length}${cont ? ' (продолжение)' : ''}`, 200, 15, { size: 5, bold: true, align: 'right' })
    text(ctx, matName, 10, 21, { size: 3.4, color: MUTED, max: 130 })
    text(ctx, new Date().toLocaleDateString('ru-RU'), 200, 21, { size: 3, color: MUTED, align: 'right' })
    rule(ctx, 10, 24, 200, 24, 0.35, INK)
  }
  sheets.forEach((sheet, si) => {
    const geo = geos[si], { rows, noOf } = sheetRows(sheet, mat.details || [])
    const first = Math.min(rows.length, 13)
    pages.push(() => {
      header(si, false)
      const box = drawSheet(ctx, 10, 28, 112, 160, sheet, geo, mat.details || [], noOf)
      // сведения о листе
      const ix = 128
      let y = 33
      const pct = geo.usableX * geo.usableY > 0 ? used[si] / (geo.usableX * geo.usableY) * 100 : 0
      text(ctx, 'Использовано материала', ix, y, { size: 3, color: MUTED }); y += 9
      text(ctx, `${Math.round(pct)} %`, ix, y, { size: 9, bold: true }); y += 4
      ctx.fillStyle = '#E9E6DD'; ctx.fillRect(mm(ix), mm(y), mm(72), mm(2.2))
      ctx.fillStyle = INK; ctx.fillRect(mm(ix), mm(y), mm(72 * Math.min(100, pct) / 100), mm(2.2)); y += 9
      const info = [['Лист, мм', `${fmt(geo.sheetL)} × ${fmt(geo.sheetW)}`], ['Рабочая область, мм', `${fmt(geo.usableY)} × ${fmt(geo.usableX)}`], ['Рез, мм', fmt(geo.kerf)],
        ['Деталей на листе', sheet.placed.length], ['Площадь деталей, м²', (used[si] / 1e6).toFixed(2).replace('.', ',')],
        ...((sheet.manualOffcuts || []).length ? [['Деловые обрезки', sheet.manualOffcuts.map(o => `${Math.round(o.h)}×${Math.round(o.w)}`).join(', ')]] : [])]
      for (const [k, v] of info) { text(ctx, k, ix, y, { size: 2.8, color: MUTED }); text(ctx, v, ix, y + 4.6, { size: 3.6, bold: true, max: 72 }); y += 10.5 }
      y += 2; rule(ctx, ix, y, 200, y, 0.15); y += 6
      text(ctx, 'Всего по материалу', ix, y, { size: 2.8, color: MUTED }); y += 4.8
      text(ctx, `листов ${sheets.length} · деталей ${totalParts}`, ix, y, { size: 3.4, bold: true }); y += 4.8
      text(ctx, `использовано ${Math.round(totalArea > 0 ? totalUsed / totalArea * 100 : 0)} %`, ix, y, { size: 3.4, bold: true }); y += 9
      // условные обозначения
      ctx.strokeStyle = EDGE; ctx.lineWidth = mm(0.7); ctx.beginPath(); ctx.moveTo(mm(ix), mm(y - 1)); ctx.lineTo(mm(ix + 9), mm(y - 1)); ctx.stroke()
      text(ctx, 'сторона с кромкой', ix + 11, y, { size: 2.8, color: MUTED }); y += 5.5
      text(ctx, '12', ix + 4.5, y, { size: 3.4, bold: true, align: 'center' }); text(ctx, 'номер детали по списку ниже', ix + 11, y, { size: 2.8, color: MUTED }); y += 5.5
      text(ctx, 'Размеры на детали — как она лежит на листе.', ix, y, { size: 2.6, color: MUTED })
      // список деталей листа
      let ty = tableHead(ctx, Math.max(box.bottom + 5, 193))
      for (let i = 0; i < first; i++) ty = tableRow(ctx, ty, rows[i])
      if (rows.length > first) text(ctx, 'продолжение списка — на следующей странице', 200, 290, { size: 2.6, color: MUTED, align: 'right' })
    })
    for (let from = first; from < rows.length; from += 42) {
      pages.push(() => { header(si, true); let ty = tableHead(ctx, 28); for (const r of rows.slice(from, from + 42)) ty = tableRow(ctx, ty, r) })
    }
  })
  // PDF: страница — картинка A4
  const chunks = [], offsets = []
  let size = 0
  const put = d => { const b = typeof d === 'string' ? strToU8(d) : d; chunks.push(b); size += b.length }
  const obj = (n, body, stream) => { offsets[n] = size; put(`${n} 0 obj\n${body}\n`); if (stream) { put('stream\n'); put(stream); put('\nendstream\n') } put('endobj\n') }
  put('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')
  const kids = []
  let n = 3
  for (let i = 0; i < pages.length; i++) {
    pages[i]()
    const px = ctx.getImageData(0, 0, PW, PH).data, rgb = new Uint8Array(PW * PH * 3)
    for (let a = 0, b = 0; a < px.length; a += 4, b += 3) { rgb[b] = px[a]; rgb[b + 1] = px[a + 1]; rgb[b + 2] = px[a + 2] }
    const img = zlibSync(rgb, { level: 6 }), content = 'q 595.28 0 0 841.89 0 0 cm /Im0 Do Q'
    const page = n, cont = n + 1, im = n + 2; n += 3
    kids.push(`${page} 0 R`)
    obj(page, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /XObject << /Im0 ${im} 0 R >> >> /Contents ${cont} 0 R >>`)
    obj(cont, `<< /Length ${content.length} >>`, content)
    obj(im, `<< /Type /XObject /Subtype /Image /Width ${PW} /Height ${PH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${img.length} >>`, img)
    onProgress?.(i + 1, pages.length)
    await new Promise(r => setTimeout(r))             // не замораживаем экран
  }
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>')
  obj(2, `<< /Type /Pages /Count ${kids.length} /Kids [${kids.join(' ')}] >>`)
  const xref = size
  put(`xref\n0 ${n}\n0000000000 65535 f \n`)
  for (let i = 1; i < n; i++) put(String(offsets[i]).padStart(10, '0') + ' 00000 n \n')
  put(`trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  const out = new Uint8Array(size)
  let o = 0
  for (const c of chunks) { out.set(c, o); o += c.length }
  return out
}

/** Скачать PDF карт раскроя */
export async function saveNestingPdf({ order, mat, fileName, onProgress }) {
  const data = await buildNestingPdf({ order, mat, onProgress })
  const url = URL.createObjectURL(new Blob([data], { type: 'application/pdf' }))
  const a = document.createElement('a'); a.href = url; a.download = fileName
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}
