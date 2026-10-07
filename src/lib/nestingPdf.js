// Карты раскроя в PDF: лист на страницу — крупная схема листа (детали с номерами позиций, размерами по сторонам
// и кромкой), справа колонкой список деталей листа (позиция, длина, ширина, количество; кромка — чертами под размером:
// одна черта — закромлена одна сторона, две — обе), под схемой — сведения о листе, процент использования и метраж кромки.
// Страница рисуется на canvas (так кириллица и линии получаются чёткими без встраивания шрифтов) и кладётся
// в PDF картинкой A4, 200 точек на дюйм.
import { zlibSync, strToU8 } from 'fflate'
import { sheetGeo } from './savedNesting'
import { placedHoles } from './partHoles'
import { orderTitle } from './orderUtils'
import { rawDetail, overMm, parseEdgeTypes } from './edgeCut'
import { detailEdgeList } from './edgeLength'

const K = 1654 / 210                     // точек на мм
const PW = 1654, PH = 2339
const mm = v => v * K
const INK = '#1F1F1D', MUTED = '#6B6A66', LINE = '#B9B7B0', EDGE = '#E8590C', FILL = '#F3F0E8', BRAND = '#009BDE'
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

const on = v => !!v && v !== 'false'
const m2 = v => v.toFixed(2).replace('.', ',')

// Знак приложения (тот же, что на значке): треугольник с «MD» и подписью RaskroyPro. x, y — левый верхний угол, h — высота, мм
function drawLogo(ctx, x, y, h) {
  const u = h / 1180, X = v => mm(x + v * u), Y = v => mm(y + v * u)
  ctx.fillStyle = BRAND; ctx.beginPath()
  ;[[519, 0], [1040, 897], [0, 897], [70, 777], [830, 777], [519, 240], [290, 637], [150, 637]].forEach(([a, b], i) => (i ? ctx.lineTo(X(a), Y(b)) : ctx.moveTo(X(a), Y(b))))
  ctx.closePath(); ctx.fill()
  const word = (s, left, base, size, len, weight) => {            // слово, растянутое ровно на заданную ширину
    ctx.save(); ctx.font = `${weight} ${mm(size * u)}px "Arial Black", Arial, Helvetica, sans-serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
    const w = ctx.measureText(s).width || 1
    ctx.translate(X(left), Y(base)); ctx.scale(mm(len * u) / w, 1); ctx.fillText(s, 0, 0); ctx.restore()
  }
  word('MD', 108, 760, 146, 266, 900)
  word('RaskroyPro', 15, 1120, 190, 1010, 700)
  return 1040 * u
}

// кромка одной детали, м по названиям (со свесом на каждую закромленную сторону)
function addEdges(acc, d, over, qty = 1) {
  for (const e of detailEdgeList(d)) { const v = (e.mm + over) / 1000 * qty; acc.total += v; acc.byName[e.name] = (acc.byName[e.name] || 0) + v }
  return acc
}

/** Строки списка деталей листа: [{ no, di, len, wid, qty, nl, nw }] и номер позиции по детали */
function sheetRows(sheet, details) {
  const cnt = new Map()
  for (const p of sheet.placed) cnt.set(p.detailIndex, (cnt.get(p.detailIndex) || 0) + 1)
  const rows = [...cnt].sort((a, b) => a[0] - b[0]).map(([di, qty], i) => {
    const d = details[di] || {}, raw = rawDetail(d)
    return { no: i + 1, di, len: fmt(d.length), wid: fmt(d.width), qty, cut: !!d._cut,
      nl: (on(raw.edge_left) ? 1 : 0) + (on(raw.edge_right) ? 1 : 0), nw: (on(raw.edge_top) ? 1 : 0) + (on(raw.edge_bottom) ? 1 : 0) }
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

// Список деталей колонкой: Поз. | Длина | Ширина | Шт. Под размером — черта на каждую закромленную сторону
const LW = 44, LROW = 6.6, LC = [4.5, 16.5, 30, 40.2]            // ширина колонки и середины столбцов, мм
function listHead(ctx, x, y) {
  ctx.fillStyle = '#EFEDE6'; ctx.fillRect(mm(x), mm(y), mm(LW), mm(6))
  ;['Поз.', 'Длина', 'Ширина', 'Шт.'].forEach((t, i) => text(ctx, t, x + LC[i], y + 4.1, { size: 2.6, bold: true, color: MUTED, align: 'center' }))
  return y + 6
}
function listRow(ctx, x, y, r) {
  const dim = (s, cx, n) => {
    text(ctx, s, cx, y + 3.7, { size: 3.1, align: 'center' })
    const w = ctx.measureText(s).width / K + 1.2
    for (let i = 0; i < n; i++) rule(ctx, cx - w / 2, y + 4.5 + i * 0.95, cx + w / 2, y + 4.5 + i * 0.95, 0.38, EDGE)
  }
  text(ctx, r.no, x + LC[0], y + 4.2, { size: 3.3, bold: true, align: 'center' })
  dim(r.len, x + LC[1], r.nl); dim(r.wid, x + LC[2], r.nw)
  text(ctx, r.qty, x + LC[3], y + 4.2, { size: 3.1, bold: true, align: 'center' })
  rule(ctx, x, y + LROW, x + LW, y + LROW, 0.12)
  return y + LROW
}
const LIST_TOP = 29, LIST_BOTTOM = 287
const PER_COL = Math.floor((LIST_BOTTOM - LIST_TOP - 6) / LROW)

/**
 * mat — { name | label, thickness, result, sheets, details } (как у savedNestings; details — детали этого материала).
 * -> Uint8Array (PDF, A4)
 */
export async function buildNestingPdf({ order, mat, onProgress }) {
  const sheets = (mat.sheets || []).filter(sh => sh?.placed?.length)
  const details = mat.details || []
  const cv = document.createElement('canvas'); cv.width = PW; cv.height = PH
  const ctx = cv.getContext('2d')
  const matName = [mat.name || mat.label || order?.material_name || '', mat.thickness ? `${mat.thickness} мм` : ''].filter(Boolean).join(' · ')
  const geos = sheets.map(sh => sheetGeo(order, mat.result, sh))
  const used = sheets.map(sh => sh.placed.reduce((a, p) => a + partArea(p), 0))
  const totalUsed = used.reduce((a, b) => a + b, 0), totalArea = geos.reduce((a, g) => a + g.usableX * g.usableY, 0)
  const totalParts = sheets.reduce((a, sh) => a + sh.placed.length, 0)
  // кромка: на каждом листе и всего по листам этого файла
  const over = overMm(parseEdgeTypes(order?.edge_types))
  const edges = sheets.map(sh => sh.placed.reduce((a, p) => (details[p.detailIndex] ? addEdges(a, rawDetail(details[p.detailIndex]), over) : a), { total: 0, byName: {} }))
  const edgeAll = edges.reduce((a, e) => { a.total += e.total; for (const [k, v] of Object.entries(e.byName)) a.byName[k] = (a.byName[k] || 0) + v; return a }, { total: 0, byName: {} })
  const pages = []                                   // функции, рисующие страницу
  let pageNo = 0
  const header = (si, cont) => {
    pageNo++
    ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, PW, PH)
    const lw = drawLogo(ctx, 10, 7.5, 16.5)
    const tx = 10 + lw + 4
    text(ctx, `Карта раскроя · ${orderTitle(order)}`, tx, 14.5, { size: 5, bold: true, max: 150 - tx })
    text(ctx, `${sheets[si].stock === 'offcut' ? 'Обрезок' : 'Лист'} ${si + 1} из ${sheets.length}${cont ? ' (продолжение)' : ''}`, 200, 14.5, { size: 5, bold: true, align: 'right' })
    text(ctx, matName, tx, 20.5, { size: 3.4, color: MUTED, max: 150 - tx })
    text(ctx, new Date().toLocaleDateString('ru-RU'), 200, 20.5, { size: 3, color: MUTED, align: 'right' })
    rule(ctx, 10, 25.5, 200, 25.5, 0.35, INK)
    text(ctx, 'Сформировано в приложении RaskroyPro', 10, 292.5, { size: 2.4, color: MUTED })
    text(ctx, `стр. ${pageNo}`, 200, 292.5, { size: 2.4, color: MUTED, align: 'right' })
  }
  const edgeBlock = (x, y, title, e, w) => {
    text(ctx, title, x, y, { size: 2.6, color: MUTED }); y += 4.6
    text(ctx, `${m2(e.total)} м`, x, y, { size: 3.8, bold: true, color: e.total > 0 ? INK : MUTED })
    const names = Object.entries(e.byName)
    if (names.length > 1) text(ctx, names.slice(0, 3).map(([n, v]) => `${n} ${m2(v)}`).join(' · '), x + 19, y, { size: 2.3, color: MUTED, max: w - 19 })
    return y + 5
  }
  sheets.forEach((sheet, si) => {
    const geo = geos[si], { rows, noOf } = sheetRows(sheet, details)
    const first = Math.min(rows.length, PER_COL)
    pages.push(() => {
      header(si, false)
      // схема листа — слева, на всю ширину до списка
      const box = drawSheet(ctx, 10, LIST_TOP, 142, 214, sheet, geo, details, noOf)
      // список деталей листа — колонкой справа
      const lx = 200 - LW
      let ly = listHead(ctx, lx, LIST_TOP)
      for (let i = 0; i < first; i++) ly = listRow(ctx, lx, ly, rows[i])
      if (rows.length > first) text(ctx, 'продолжение списка — на след. странице', 200, LIST_BOTTOM + 2.6, { size: 2.3, color: MUTED, align: 'right' })
      // сведения о листе — под схемой, сжато, три столбца
      const y0 = Math.min(box.bottom + 6, 249), c1 = 10, c2 = 50, c3 = 104
      const pct = geo.usableX * geo.usableY > 0 ? used[si] / (geo.usableX * geo.usableY) * 100 : 0
      let y = y0
      text(ctx, 'Использовано материала', c1, y, { size: 2.6, color: MUTED }); y += 6.4
      text(ctx, `${Math.round(pct)} %`, c1, y, { size: 5.6, bold: true }); y += 2.2
      ctx.fillStyle = '#E9E6DD'; ctx.fillRect(mm(c1), mm(y), mm(30), mm(1.4))
      ctx.fillStyle = INK; ctx.fillRect(mm(c1), mm(y), mm(30 * Math.min(100, pct) / 100), mm(1.4)); y += 6
      text(ctx, `Всего: листов ${sheets.length}, деталей ${totalParts}`, c1, y, { size: 2.6, color: MUTED, max: 37 }); y += 3.8
      text(ctx, `использовано ${Math.round(totalArea > 0 ? totalUsed / totalArea * 100 : 0)} %`, c1, y, { size: 2.6, color: MUTED })
      const info = [['Лист, мм', `${fmt(geo.sheetL)} × ${fmt(geo.sheetW)}`], ['Рабочая область', `${fmt(geo.usableY)} × ${fmt(geo.usableX)}`], ['Рез, мм', fmt(geo.kerf)],
        ['Деталей на листе', sheet.placed.length], ['Площадь деталей', `${m2(used[si] / 1e6)} м²`],
        ...((sheet.manualOffcuts || []).length ? [['Обрезки, мм', sheet.manualOffcuts.map(o => `${Math.round(o.h)}×${Math.round(o.w)}`).join(', ')]] : [])]
      y = y0
      for (const [k, v] of info) { text(ctx, k, c2, y, { size: 2.6, color: MUTED }); text(ctx, v, c2 + 25, y, { size: 2.9, bold: true, max: 26 }); y += 4.3 }
      y = edgeBlock(c3, y0, 'Кромка на этом листе', edges[si], 46)
      y = edgeBlock(c3, y, sheets.length > 1 ? `Кромка всего, ${sheets.length} лист.` : 'Кромка всего', edgeAll, 46)
      text(ctx, over > 0 ? `со свесами ${fmt(over)} мм на сторону` : 'без свесов', c3, y, { size: 2.5, color: MUTED }); y += 3.6
      if (rows.some(r => r.cut)) text(ctx, 'Размеры в списке — заготовки (с учётом кромки).', c3, y, { size: 2.5, color: MUTED, max: 46 })
      // условные обозначения — внизу страницы
      y = 282
      rule(ctx, 10, y - 0.9, 17, y - 0.9, 0.7, EDGE); text(ctx, 'сторона с кромкой', 19, y, { size: 2.5, color: MUTED })
      text(ctx, '12', 53, y + 0.1, { size: 3, bold: true, align: 'center' }); text(ctx, 'позиция по списку справа', 57, y, { size: 2.5, color: MUTED })
      y = 286.5
      rule(ctx, 10, y - 1.5, 17, y - 1.5, 0.38, EDGE); rule(ctx, 10, y - 0.5, 17, y - 0.5, 0.38, EDGE)
      text(ctx, 'черта под размером в списке: одна — кромка с одной стороны, две — с двух', 19, y, { size: 2.5, color: MUTED })
    })
    for (let from = first; from < rows.length; from += PER_COL * 4) {
      pages.push(() => {
        header(si, true)
        for (let c = 0; c < 4; c++) {
          const part = rows.slice(from + c * PER_COL, from + (c + 1) * PER_COL)
          if (!part.length) break
          const x = 10 + c * (LW + 4.6)
          let ty = listHead(ctx, x, LIST_TOP)
          for (const r of part) ty = listRow(ctx, x, ty, r)
        }
      })
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
