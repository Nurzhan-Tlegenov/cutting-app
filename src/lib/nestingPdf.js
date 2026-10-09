// Карты раскроя в PDF: лист на страницу — крупная схема листа (детали с номерами позиций, размерами по сторонам
// и кромкой), справа колонкой список деталей листа (позиция, длина, ширина, количество; кромка — чертами под размером:
// одна черта — закромлена одна сторона, две — обе), под схемой — сведения о листе, процент использования и метраж кромки.
// Страница рисуется на canvas (так кириллица и линии получаются чёткими без встраивания шрифтов) и кладётся
// в PDF картинкой A4, 200 точек на дюйм.
import { zlibSync, strToU8 } from 'fflate'
import { sheetGeo } from './savedNesting'
import { placedHoles, placedTurns } from './partHoles'
import { orderTitle } from './orderUtils'
import { rawDetail, overMm, parseEdgeTypes } from './edgeCut'
import { detailEdgeList, contourSegments, segmentSide, holeEdgeSegments } from './edgeLength'
import { rotatePointTimes } from './drillGeometry'

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

// Номер позиции детали — тот же, что в задании на раскрой в бланке заказа (порядок строк заказа),
// а не счёт заново на каждом листе: по нему деталь находят в заказе и на любом листе
function orderPos(d, di) {
  const so = rawDetail(d || {})?.sort_order
  return so !== null && so !== undefined && so !== '' && Number.isFinite(Number(so)) ? Number(so) + 1 : di + 1
}

/** Строки списка деталей листа: [{ no, di, len, wid, qty, nl, nw }] и номер позиции по детали */
function sheetRows(sheet, details) {
  const cnt = new Map()
  for (const p of sheet.placed) cnt.set(p.detailIndex, (cnt.get(p.detailIndex) || 0) + 1)
  const rows = [...cnt].map(([di, qty]) => [di, qty, orderPos(details[di], di)]).sort((a, b) => a[2] - b[2] || a[0] - b[0]).map(([di, qty, no]) => {
    const d = details[di] || {}, raw = rawDetail(d)
    return { no, di, len: fmt(d.length), wid: fmt(d.width), qty, cut: !!d._cut,
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
    const holes = d ? placedHoles(p, d) : []
    for (const hole of holes) { ctx.fillStyle = '#FFFFFF'; path(hole); ctx.fill(); ctx.stroke() }
    // Кромка — жирная линия с отступом внутрь от контура. У детали с контуром она идёт по самим участкам контура
    // (прямым и криволинейным одинаково, с одним и тем же отступом): на скруглённом углу линия плавно переходит
    // с прямой стороны на дугу, без «прямоугольника» по габариту и без перехлёста.
    const g = Math.min(1.1 / s, Math.min(w, h) * 0.12)
    ctx.strokeStyle = EDGE; ctx.lineWidth = mm(0.7); ctx.lineCap = 'butt'; ctx.lineJoin = 'round'
    const seg = (ax, ay, bx2, by2) => { ctx.beginPath(); ctx.moveTo(X(px + ax), Y(py + ay)); ctx.lineTo(X(px + bx2), Y(py + by2)); ctx.stroke() }
    let contour = d?.contour
    if (typeof contour === 'string') { try { contour = JSON.parse(contour) } catch { contour = null } }
    const segs = contour && Array.isArray(contour.vertices) && contour.vertices.length >= 3 ? contourSegments(contour.vertices).filter(sg => sg.pts.length > 1) : []
    if (!segs.length) {
      // прямоугольная деталь без контура: стороны уже повёрнуты вместе с деталью
      if (p.edgeTop) seg(g, h - g, w - g, h - g)
      if (p.edgeBottom) seg(g, g, w - g, g)
      if (p.edgeLeft) seg(g, g, g, h - g)
      if (p.edgeRight) seg(w - g, g, w - g, h - g)
    }
    if (contour) {
      const dW = Number(d.width) || 0, dL = Number(d.length) || 0, turns = placedTurns(p, d)
      const native = { left: d.edge_left, right: d.edge_right, top: d.edge_top, bottom: d.edge_bottom }
      ctx.save(); ctx.strokeStyle = EDGE; ctx.lineWidth = mm(0.7); ctx.lineCap = 'butt'; ctx.lineJoin = 'round'
      const curve = pts => {
        ctx.beginPath()
        pts.forEach(([qx, qy], k) => { const r = rotatePointTimes(qx, qy, dW, dL, turns); if (k) ctx.lineTo(X(px + r.x), Y(py + r.y)); else ctx.moveTo(X(px + r.x), Y(py + r.y)) })
        ctx.stroke()
      }
      // направление обхода контура — чтобы знать, где «внутрь»
      const ring = segs.flatMap(sg => sg.pts)
      let twice = 0
      for (let i = 0; i < ring.length; i++) { const u = ring[i], v = ring[(i + 1) % ring.length]; twice += u[0] * v[1] - v[0] * u[1] }
      const sign = twice >= 0 ? 1 : -1
      const dirAt = (pts, end) => { const u = end ? pts[pts.length - 2] : pts[0], v = end ? pts[pts.length - 1] : pts[1]; const l = Math.hypot(v[0] - u[0], v[1] - u[1]) || 1; return [(v[0] - u[0]) / l, (v[1] - u[1]) / l] }
      const sharp = (da, db) => da[0] * db[0] + da[1] * db[1] < 0.9                 // излом больше ~25° — угол, а не плавный переход
      // укоротить ломаную на t с начала (или с конца)
      const trim = (pts, t, fromEnd) => {
        const q = fromEnd ? pts.slice().reverse() : pts.slice()
        let left = t
        while (q.length > 1) {
          const l = Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1])
          if (l > left) { const k = left / l; q[0] = [q[0][0] + (q[1][0] - q[0][0]) * k, q[0][1] + (q[1][1] - q[0][1]) * k]; break }
          left -= l; q.shift()
        }
        return fromEnd ? q.reverse() : q
      }
      segs.forEach((sg, i) => {
        const side = segmentSide(sg, dW, dL)
        if (!((side && on(native[side])) || sg.edge)) return
        const pts = sg.pts
        // отступ внутрь по нормали в каждой точке
        let line = pts.map((q, k) => {
          const u = pts[Math.max(0, k - 1)], v = pts[Math.min(pts.length - 1, k + 1)]
          const l = Math.hypot(v[0] - u[0], v[1] - u[1]) || 1
          return [q[0] - (v[1] - u[1]) / l * g * sign, q[1] + (v[0] - u[0]) / l * g * sign]
        })
        // у острого угла линия не доходит до него на величину отступа (как у прямоугольной детали); на плавном стыке — идёт без разрыва
        const prev = segs[(i - 1 + segs.length) % segs.length], next = segs[(i + 1) % segs.length]
        if (sharp(dirAt(prev.pts, true), dirAt(pts, false))) line = trim(line, g, false)
        if (sharp(dirAt(pts, true), dirAt(next.pts, false))) line = trim(line, g, true)
        if (line.length > 1) curve(line)
      })
      const cut = contour.holes || []
      cut.forEach(hh => holeEdgeSegments(hh).forEach(sg => curve(sg.pts)))
      if (cut.length === holes.length) cut.forEach((hh, hi) => { if (hh.edge) { path(holes[hi]); ctx.stroke() } })   // вырез закромлен целиком
      ctx.restore()
    }
    // подписи: номер позиции — в середине, размеры — вдоль сторон внутри детали (ширина — у верхней, длина — у левой).
    // На мелкой детали всё уменьшается, пока помещается; на совсем мелкой — номер и размер одной-двумя строками
    const pw = w * s, ph = h * s, cx = x0 + (px + w / 2) * s, cy = y0 + (geo.sheetL - py - h / 2) * s
    const no = String(noOf.get(p.detailIndex) ?? '')
    const sw = fmt(w), sh = fmt(h)
    const tw = (str, size, bold) => { ctx.font = `${bold ? '600 ' : ''}${mm(size)}px Arial, Helvetica, sans-serif`; return ctx.measureText(str).width / K }
    const vtext = (str, x, y, size, opt = {}) => {                         // текст снизу вверх
      ctx.save(); ctx.translate(mm(x), mm(y)); ctx.rotate(-Math.PI / 2)
      ctx.font = `${opt.bold ? '600 ' : ''}${mm(size)}px Arial, Helvetica, sans-serif`; ctx.fillStyle = opt.color || INK
      ctx.textAlign = 'center'; ctx.textBaseline = opt.base || 'alphabetic'; ctx.fillText(str, 0, 0); ctx.restore()
    }
    let placed = false
    for (const k of [1, 0.85, 0.72, 0.6, 0.5]) {
      const ds = Math.max(1.3, Math.min(2.6, Math.min(pw, ph) * 0.16) * k)
      const ns = Math.max(1.8, Math.min(5, Math.min(pw, ph) * 0.42) * k)
      const eL = p.edgeLeft ? 0.9 : 0, eT = p.edgeTop ? 0.9 : 0           // размер не наезжает на полоску кромки
      const bandL = ds + 1.2 + eL, bandT = ds + 1.2 + eT                  // полосы под размер у левой и верхней стороны
      const fitTop = tw(sw, ds) <= pw - bandL - 0.8, fitLeft = tw(sh, ds) <= ph - bandT - 0.8
      const fitNo = ph / 2 - ns / 2 >= bandT + 0.3 && pw / 2 - tw(no, ns, true) / 2 >= bandL + 0.3
      if (!(fitTop && fitLeft && fitNo)) continue
      text(ctx, no, cx, cy, { size: ns, bold: true, align: 'center', base: 'middle' })
      text(ctx, sw, cx, y0 + (geo.sheetL - py - h) * s + ds + 0.9 + eT, { size: ds, color: MUTED, align: 'center' })
      vtext(sh, x0 + px * s + ds + 0.8 + eL, cy, ds, { color: MUTED })
      placed = true
      break
    }
    if (!placed) {
      // мелкая деталь: вдоль длинной стороны — номер и размер «длина × ширина», как в списке справа.
      // Место считаем без полосок кромки, чтобы надпись на них не наезжала
      const eg = side => (side ? Math.min(1.6, Math.min(pw, ph) * 0.2) : 0.2)
      const il = eg(p.edgeLeft), ir = eg(p.edgeRight), it = eg(p.edgeTop), ib = eg(p.edgeBottom)
      const iw = pw - il - ir, ih = ph - it - ib
      const cx = x0 + px * s + il + iw / 2, cy = y0 + (geo.sheetL - py - h) * s + it + ih / 2
      const dims = d ? `${fmt(d.length)}×${fmt(d.width)}` : `${sh}×${sw}`
      const long = Math.max(iw, ih), short = Math.min(iw, ih), vert = ih > iw
      const one = Math.min(2.6, (short - 0.4) * 0.8, (long - 0.8) / Math.max(0.1, tw(`${no}  ${dims}`, 1, true)))
      const two = Math.min(2.6, (short - 0.4) / 2.3, (long - 0.8) / Math.max(0.1, tw(dims, 1), tw(no, 1.15, true)))
      if (one >= two) {
        const size = Math.max(0.9, one), wn = tw(no, size, true), gap = size * 0.5, total = wn + gap + tw(dims, size)
        if (vert) {
          vtext(no, cx, cy + total / 2 - wn / 2, size, { bold: true, base: 'middle' })
          vtext(dims, cx, cy - total / 2 + (total - wn - gap) / 2, size, { color: MUTED, base: 'middle' })
        } else {
          text(ctx, no, cx - total / 2 + wn / 2, cy, { size, bold: true, align: 'center', base: 'middle' })
          text(ctx, dims, cx + total / 2 - (total - wn - gap) / 2, cy, { size, color: MUTED, align: 'center', base: 'middle' })
        }
      } else {
        const size = Math.max(0.9, two), off = size * 0.6
        if (vert) {
          vtext(no, cx - off, cy, size * 1.15, { bold: true, base: 'middle' })
          vtext(dims, cx + off, cy, size, { color: MUTED, base: 'middle' })
        } else {
          text(ctx, no, cx, cy - off, { size: size * 1.15, bold: true, align: 'center', base: 'middle' })
          text(ctx, dims, cx, cy + off, { size, color: MUTED, align: 'center', base: 'middle' })
        }
      }
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
 * summary (необязательно, PDF из кабинета производства) — последняя страница «Статистика и стоимость»:
 *   { rows: [{ label, value }], lines: [{ title, qty, rate, sum }], total, currency, minApplied }
 * tpl (необязательно) — своё оформление листа из конструктора (normalizePdfTpl); без него — стандартный вид.
 * -> Uint8Array (PDF, A4)
 */
function preparePages({ order, mat, summary = null, tpl = null, ctx }) {
  const sheets = (mat.sheets || []).filter(sh => sh?.placed?.length)
  const details = mat.details || []
  const custom = tpl?.custom && Array.isArray(tpl.items) && tpl.items.length ? tpl : null   // своё оформление листа (конструктор)
  const boxes = []                                   // где оказались элементы на странице — для рамок в конструкторе
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
  // ── страница по своему макету: каждый элемент там, где его поставил пользователь ──
  const legend = (x, y) => {
    rule(ctx, x, y + 1.6, x + 7, y + 1.6, 0.7, EDGE); text(ctx, 'сторона с кромкой', x + 9, y + 2.5, { size: 2.5, color: MUTED })
    text(ctx, '12', x + 43, y + 2.6, { size: 3, bold: true, align: 'center' }); text(ctx, 'позиция по бланку заказа', x + 47, y + 2.5, { size: 2.5, color: MUTED })
    rule(ctx, x, y + 5.5, x + 7, y + 5.5, 0.38, EDGE); rule(ctx, x, y + 6.5, x + 7, y + 6.5, 0.38, EDGE)
    text(ctx, 'черта под размером в списке: одна — кромка с одной стороны, две — с двух', x + 9, y + 7, { size: 2.5, color: MUTED })
  }
  const pageValues = si => {
    const geo = geos[si], sheet = sheets[si], area = geo.usableX * geo.usableY
    return {
      title: ['', `Карта раскроя · ${orderTitle(order)}`], order: ['Заказ', orderTitle(order)],
      sheetNo: ['', `${sheet.stock === 'offcut' ? 'Обрезок' : 'Лист'} ${si + 1} из ${sheets.length}`],
      material: ['Материал', matName], date: ['Дата', new Date().toLocaleDateString('ru-RU')],
      used: ['Использовано материала', `${Math.round(area > 0 ? used[si] / area * 100 : 0)} %`],
      sheetSize: ['Лист, мм', `${fmt(geo.sheetL)} × ${fmt(geo.sheetW)}`], usable: ['Рабочая область, мм', `${fmt(geo.usableY)} × ${fmt(geo.usableX)}`],
      kerf: ['Рез, мм', fmt(geo.kerf)], partsOnSheet: ['Деталей на листе', String(sheet.placed.length)], partsArea: ['Площадь деталей', `${m2(used[si] / 1e6)} м²`],
      offcuts: ['Обрезки, мм', (sheet.manualOffcuts || []).map(o => `${Math.round(o.h)}×${Math.round(o.w)}`).join(', ')],
      edgeSheet: ['Кромка на листе', `${m2(edges[si].total)} м`], edgeTotal: ['Кромка всего', `${m2(edgeAll.total)} м`],
      overs: ['', over > 0 ? `кромка со свесами ${fmt(over)} мм на сторону` : 'кромка без свесов'],
      totals: ['Всего', `листов ${sheets.length}, деталей ${totalParts}, использовано ${Math.round(totalArea > 0 ? totalUsed / totalArea * 100 : 0)} %`],
      footer: ['', 'Сформировано в приложении RaskroyPro'], pageNo: ['', `стр. ${pageNo}`],
    }
  }
  const drawCustom = (si, { sheet, geo, rows, noOf, first }) => {
    pageNo++
    ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, PW, PH)
    const vals = pageValues(si)
    for (const it of custom.items) {
      const rot = Number(it.rot) || 0
      if (it.type === 'map') {
        // карта листа вписывается в свою рамку; поворот — вместе со всеми подписями на ней
        const turned = Math.abs(rot) % 180 === 90, bw = turned ? it.h : it.w, bh = turned ? it.w : it.h
        const sc = Math.min(bw / geo.sheetW, bh / geo.sheetL)
        ctx.save(); ctx.translate(mm(it.x + it.w / 2), mm(it.y + it.h / 2)); ctx.rotate(rot * Math.PI / 180)
        drawSheet(ctx, -bw / 2, -geo.sheetL * sc / 2, bw, bh, sheet, geo, details, noOf)
        ctx.restore()
        boxes.push({ id: it.id, x: it.x, y: it.y, w: it.w, h: it.h, rot: 0, kind: 'box' })
      } else if (it.type === 'list') {
        let ly = listHead(ctx, it.x, it.y)
        for (let i = 0; i < first; i++) ly = listRow(ctx, it.x, ly, rows[i])
        if (rows.length > first) text(ctx, 'продолжение — на след. странице', it.x + LW, ly + 3, { size: 2.3, color: MUTED, align: 'right' })
        boxes.push({ id: it.id, x: it.x, y: it.y, w: LW, h: it.h, rot: 0, kind: 'tall' })
      } else if (it.type === 'logo') {
        const w = drawLogo(ctx, it.x, it.y, it.h)
        boxes.push({ id: it.id, x: it.x, y: it.y, w, h: it.h, rot: 0, kind: 'square' })
      } else if (it.type === 'legend') {
        legend(it.x, it.y)
        boxes.push({ id: it.id, x: it.x, y: it.y, w: 118, h: 8.5, rot: 0, kind: 'fixed' })
      } else if (it.type === 'line') {
        rule(ctx, it.x, it.y + 1, it.x + it.w, it.y + 1, 0.35, INK)
        boxes.push({ id: it.id, x: it.x, y: it.y, w: it.w, h: 2, rot: 0, kind: 'wide' })
      } else {
        const v = vals[it.type]
        const str = it.type === 'text' ? String(it.text || '') : !v ? '' : v[0] && it.label !== false ? `${v[0]}: ${v[1]}` : v[1]
        const size = Number(it.size) || 3
        const shown = str || (it.type === 'text' ? 'свой текст' : '')
        if (!shown || (v && !v[1])) continue
        ctx.save(); ctx.translate(mm(it.x), mm(it.y)); ctx.rotate(rot * Math.PI / 180)
        text(ctx, shown, 0, 0, { size, bold: !!it.bold, color: !str ? LINE : it.muted ? MUTED : INK, base: 'top' })
        const w = ctx.measureText(shown).width / K
        ctx.restore()
        boxes.push({ id: it.id, x: it.x, y: it.y, w: Math.max(3, w), h: size * 1.15, rot, kind: 'text' })
      }
    }
  }
  const listItem = custom ? custom.items.find(i => i.type === 'list') : null
  sheets.forEach((sheet, si) => {
    const geo = geos[si], { rows, noOf } = sheetRows(sheet, details)
    const perCol = !custom ? PER_COL : listItem ? Math.max(1, Math.floor((listItem.h - 6) / LROW)) : rows.length
    const first = Math.min(rows.length, perCol)
    pages.push(custom ? () => drawCustom(si, { sheet, geo, rows, noOf, first }) : () => {
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
      text(ctx, '12', 53, y + 0.1, { size: 3, bold: true, align: 'center' }); text(ctx, 'позиция по бланку заказа', 57, y, { size: 2.5, color: MUTED })
      y = 286.5
      rule(ctx, 10, y - 1.5, 17, y - 1.5, 0.38, EDGE); rule(ctx, 10, y - 0.5, 17, y - 0.5, 0.38, EDGE)
      text(ctx, 'черта под размером в списке: одна — кромка с одной стороны, две — с двух', 19, y, { size: 2.5, color: MUTED })
    })
    if (custom && !listItem) return                  // список деталей на лист не вынесен — страниц продолжения нет
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
  // Статистика раскроя и стоимость работ — отдельной страницей после карт
  if (summary && ((summary.rows || []).length || (summary.lines || []).length || summary.total != null)) {
    pages.push(() => {
      pageNo++
      ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, PW, PH)
      const lw = drawLogo(ctx, 10, 7.5, 16.5), tx = 10 + lw + 4
      text(ctx, `Статистика раскроя · ${orderTitle(order)}`, tx, 14.5, { size: 5, bold: true, max: 190 - tx })
      text(ctx, matName, tx, 20.5, { size: 3.4, color: MUTED, max: 150 - tx })
      text(ctx, new Date().toLocaleDateString('ru-RU'), 200, 20.5, { size: 3, color: MUTED, align: 'right' })
      rule(ctx, 10, 25.5, 200, 25.5, 0.35, INK)
      text(ctx, 'Сформировано в приложении RaskroyPro', 10, 292.5, { size: 2.4, color: MUTED })
      text(ctx, `стр. ${pageNo}`, 200, 292.5, { size: 2.4, color: MUTED, align: 'right' })
      let y = 34
      const rows = summary.rows || []
      if (rows.length) {
        text(ctx, 'Раскрой', 10, y, { size: 3.6, bold: true }); y += 3
        // две колонки: подпись слева, значение справа
        const half = Math.ceil(rows.length / 2), colW = 92
        rows.forEach((r, i) => {
          const c = i < half ? 0 : 1, yy = y + 5.4 * ((i < half ? i : i - half) + 1), x = 10 + c * (colW + 6)
          text(ctx, r.label, x, yy, { size: 3, color: MUTED, max: colW - 34 })
          text(ctx, r.value, x + colW, yy, { size: 3.1, bold: true, align: 'right', max: 40 })
          rule(ctx, x, yy + 1.6, x + colW, yy + 1.6, 0.1)
        })
        y += 5.4 * half + 10
      }
      const lines = summary.lines || []
      if (lines.length || summary.total != null) {
        const cur = summary.currency ? `, ${summary.currency}` : ''
        text(ctx, 'Стоимость работ', 10, y, { size: 3.6, bold: true }); y += 6
        if (lines.length) {
          ctx.fillStyle = '#EFEDE6'; ctx.fillRect(mm(10), mm(y - 4.2), mm(190), mm(6))
          text(ctx, 'Операция', 12, y, { size: 2.7, bold: true, color: MUTED })
          text(ctx, 'Количество', 136, y, { size: 2.7, bold: true, color: MUTED, align: 'right' })
          text(ctx, `Цена${cur}`, 168, y, { size: 2.7, bold: true, color: MUTED, align: 'right' })
          text(ctx, `Сумма${cur}`, 198, y, { size: 2.7, bold: true, color: MUTED, align: 'right' })
          y += 2
          for (const l of lines) {
            y += 5.6
            text(ctx, l.title, 12, y, { size: 3.1, max: 96 })
            if (l.qty) text(ctx, l.qty, 136, y, { size: 3, color: MUTED, align: 'right' })
            if (l.rate) text(ctx, l.rate, 168, y, { size: 3, color: MUTED, align: 'right' })
            text(ctx, l.sum, 198, y, { size: 3.1, bold: true, align: 'right' })
            rule(ctx, 10, y + 1.7, 200, y + 1.7, 0.1)
          }
          y += 8
        }
        if (summary.total != null) {
          text(ctx, summary.minApplied ? 'Итого (минимальная сумма заказа)' : 'Итого', 12, y, { size: 3.8, bold: true })
          text(ctx, summary.total, 198, y, { size: 5, bold: true, align: 'right' })
          rule(ctx, 10, y + 2.4, 200, y + 2.4, 0.35, INK); y += 8
          text(ctx, 'Стоимость работ; материал и кромка в сумму не входят.', 12, y, { size: 2.5, color: MUTED })
        }
      }
    })
  }
  return { pages, boxes }
}

/**
 * Показать первую страницу (первый лист) на canvas — для конструктора листа.
 * -> рамки элементов: [{ id, x, y, w, h, rot, kind }] в мм
 */
export function drawPdfPreview(canvas, { order, mat, tpl }) {
  canvas.width = PW; canvas.height = PH
  const ctx = canvas.getContext('2d')
  const { pages, boxes } = preparePages({ order, mat, tpl: { ...tpl, custom: true }, ctx })
  if (pages[0]) pages[0](); else { ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, PW, PH) }
  return boxes
}

export async function buildNestingPdf({ order, mat, onProgress, summary = null, tpl = null }) {
  const cv = document.createElement('canvas'); cv.width = PW; cv.height = PH
  const ctx = cv.getContext('2d')
  const { pages } = preparePages({ order, mat, summary, tpl, ctx })
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

function download(file) {
  const url = URL.createObjectURL(file)
  const a = document.createElement('a'); a.href = url; a.download = file.name
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

// Окошко «PDF готов»: если телефон не дал открыть «Поделиться» сразу (PDF собирался дольше, чем живёт нажатие)
function askShare(file, title) {
  return new Promise(resolve => {
    const wrap = document.createElement('div')
    wrap.style.cssText = 'position:fixed;inset:0;z-index:5000;background:rgba(0,0,0,.45);display:flex;align-items:flex-end;justify-content:center'
    const box = document.createElement('div')
    box.style.cssText = 'width:100%;max-width:480px;background:var(--bg,#fff);color:var(--text,#111);border-radius:16px 16px 0 0;padding:16px 16px calc(16px + env(safe-area-inset-bottom));font-family:inherit'
    const h = document.createElement('div')
    h.textContent = 'PDF готов'; h.style.cssText = 'font-size:16px;font-weight:500;margin-bottom:4px'
    const sub = document.createElement('div')
    sub.textContent = file.name; sub.style.cssText = 'font-size:12px;color:var(--text-hint,#888);margin-bottom:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
    box.append(h, sub)
    const close = () => { wrap.remove(); resolve() }
    const btn = (label, primary, fn) => {
      const b = document.createElement('button')
      b.type = 'button'; b.textContent = label
      b.style.cssText = `display:block;width:100%;padding:12px;margin-top:8px;border-radius:10px;font-size:15px;cursor:pointer;border:0.5px solid var(--border-md,#ccc);background:${primary ? 'var(--blue,#009BDE)' : 'transparent'};color:${primary ? '#fff' : 'inherit'}`
      b.onclick = fn; box.append(b)
    }
    btn('Поделиться', true, async () => {
      try { await navigator.share({ files: [file], title }); close() } catch (e) { if (e?.name !== 'AbortError') { download(file); close() } }
    })
    btn('Скачать', false, () => { download(file); close() })
    btn('Отмена', false, close)
    wrap.onclick = e => { if (e.target === wrap) close() }
    wrap.append(box); document.body.append(wrap)
  })
}

/**
 * PDF карт раскроя: на телефоне сразу открывается «Поделиться» (мессенджер, почта, облако) — файл уходит клиенту
 * без скачивания. Где так нельзя (компьютер, старый браузер) — файл скачивается, как раньше.
 */
export async function saveNestingPdf({ order, mat, fileName, onProgress, summary = null, tpl = null }) {
  const data = await buildNestingPdf({ order, mat, onProgress, summary, tpl })
  const file = new File([data], fileName, { type: 'application/pdf' })
  const title = `Карта раскроя · ${orderTitle(order)}`
  let can
  try { can = !!navigator.share && !!navigator.canShare && navigator.canShare({ files: [file] }) } catch { can = false }
  const phone = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches
  if (!can || !phone) { download(file); return }
  try {
    await navigator.share({ files: [file], title })
  } catch (e) {
    if (e?.name === 'AbortError') return                       // человек сам закрыл меню
    await askShare(file, title)                                // нажатие «устарело», пока собирался PDF — спрашиваем ещё раз
  }
}

// ─── Конструктор листа: элементы страницы и шаблон ──────────────────────────────────────────────
// [тип, название, вид]: box — рамка с размером, text — строка текста (размер, жирность, поворот)
export const PDF_ITEMS = [
  ['map', 'Карта листа', 'box'], ['list', 'Список деталей', 'box'], ['logo', 'Знак RaskroyPro', 'box'], ['legend', 'Условные обозначения', 'box'], ['line', 'Линия', 'box'],
  ['title', 'Заголовок: карта раскроя и заказ', 'text'], ['order', 'Заказ', 'text'], ['sheetNo', 'Номер листа', 'text'], ['material', 'Материал', 'text'], ['date', 'Дата', 'text'],
  ['used', 'Использовано материала', 'text'], ['sheetSize', 'Размер листа', 'text'], ['usable', 'Рабочая область', 'text'], ['kerf', 'Ширина реза', 'text'],
  ['partsOnSheet', 'Деталей на листе', 'text'], ['partsArea', 'Площадь деталей', 'text'], ['offcuts', 'Обрезки', 'text'],
  ['edgeSheet', 'Кромка на листе', 'text'], ['edgeTotal', 'Кромка всего', 'text'], ['overs', 'Свесы кромки', 'text'], ['totals', 'Всего по заказу', 'text'],
  ['footer', 'Подпись приложения', 'text'], ['pageNo', 'Номер страницы', 'text'], ['text', 'Свой текст', 'text'],
]
export const pdfItemTitle = type => (PDF_ITEMS.find(x => x[0] === type) || [])[1] || type
export const pdfItemKind = type => (PDF_ITEMS.find(x => x[0] === type) || [])[2] || 'text'
const HAS_LABEL = new Set(['order', 'material', 'date', 'used', 'sheetSize', 'usable', 'kerf', 'partsOnSheet', 'partsArea', 'offcuts', 'edgeSheet', 'edgeTotal', 'totals'])
export const pdfItemHasLabel = type => HAS_LABEL.has(type)

const T = (type, x, y, size, extra = {}) => ({ type, x, y, size, ...extra })
const DEFAULT_ITEMS = [
  { type: 'logo', x: 10, y: 7.5, h: 16.5 },
  T('title', 30, 10.4, 5, { bold: true }), T('sheetNo', 168, 10.4, 5, { bold: true }),
  T('material', 30, 17.6, 3.4, { muted: true, label: false }), T('date', 183, 17.8, 3, { muted: true, label: false }),
  { type: 'line', x: 10, y: 24.5, w: 190 },
  { type: 'map', x: 10, y: 29, w: 142, h: 214, rot: 0 },
  { type: 'list', x: 156, y: 29, h: 258 },
  T('used', 10, 247, 4.4, { bold: true }), T('totals', 10, 254, 2.7, { muted: true }),
  T('sheetSize', 10, 260, 2.9), T('usable', 10, 264.4, 2.9), T('kerf', 10, 268.8, 2.9),
  T('partsOnSheet', 82, 260, 2.9), T('partsArea', 82, 264.4, 2.9), T('offcuts', 82, 268.8, 2.9),
  T('edgeSheet', 82, 247, 3.4, { bold: true }), T('edgeTotal', 82, 252.6, 2.9), T('overs', 10, 273.4, 2.5, { muted: true }),
  { type: 'legend', x: 10, y: 279.5 },
  T('footer', 10, 290.6, 2.4, { muted: true }), T('pageNo', 190, 290.6, 2.4, { muted: true }),
]
let pdfItemSeq = 0
const newId = () => `p${Date.now().toString(36)}${++pdfItemSeq}`
export const newPdfItem = type => {
  const base = type === 'map' ? { x: 20, y: 40, w: 100, h: 150, rot: 0 } : type === 'list' ? { x: 150, y: 40, h: 200 } : type === 'logo' ? { x: 10, y: 10, h: 16 }
    : type === 'legend' ? { x: 10, y: 270 } : type === 'line' ? { x: 10, y: 60, w: 190 } : { x: 20, y: 60, size: 3.2, ...(type === 'text' ? { text: '' } : {}) }
  return { id: newId(), type, ...base }
}
const clamp = (v, a, b, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(b, Math.max(a, n)) : d }
const normRot = r => { let v = Math.round((Number(r) || 0) / 90) * 90 % 360; if (v > 180) v -= 360; if (v <= -180) v += 360; return v }
/** Привести шаблон к рабочему виду (значения в допустимых пределах, у каждого элемента свой номер) */
export function normalizePdfTpl(raw) {
  const src = raw && Array.isArray(raw.items) && raw.items.length ? raw.items : DEFAULT_ITEMS
  const items = src.filter(i => i && PDF_ITEMS.some(x => x[0] === i.type)).map(i => {
    const o = { id: i.id || newId(), type: i.type, x: clamp(i.x, -20, 215, 10), y: clamp(i.y, -20, 300, 10) }
    if (i.type === 'map') Object.assign(o, { w: clamp(i.w, 20, 210, 142), h: clamp(i.h, 20, 297, 214), rot: normRot(i.rot) })
    else if (i.type === 'list') o.h = clamp(i.h, 20, 290, 258)
    else if (i.type === 'logo') o.h = clamp(i.h, 5, 60, 16.5)
    else if (i.type === 'line') o.w = clamp(i.w, 5, 210, 190)
    else if (i.type !== 'legend') Object.assign(o, { size: clamp(i.size, 1.5, 14, 3), bold: !!i.bold, muted: !!i.muted, rot: normRot(i.rot), ...(i.label === false ? { label: false } : {}), ...(i.type === 'text' ? { text: String(i.text || '').slice(0, 200) } : {}) })
    return o
  })
  return { custom: !!raw?.custom, items }
}

