// Карты раскроя в PDF: лист на страницу — крупная схема листа (детали с номерами позиций, размерами по сторонам
// и кромкой), справа колонкой список деталей листа (позиция, длина, ширина, количество; кромка — чертами под размером:
// одна черта — закромлена одна сторона, две — обе), под схемой — сведения о листе, процент использования и метраж кромки.
// Страница рисуется на canvas (так кириллица и линии получаются чёткими без встраивания шрифтов) и кладётся
// в PDF картинкой A4, 200 точек на дюйм.
import { sameColorMap } from './sameParts'
import { zlibSync, strToU8 } from 'fflate'
import { sheetGeo } from './savedNesting'
import { placedHoles, placedTurns } from './partHoles'
import { orderTitle } from './orderUtils'
import { rawDetail, overMm, parseEdgeTypes } from './edgeCut'
import { detailEdgeList, holeEdgeSegments } from './edgeLength'
import { rotatePointTimes, getAllDrillPoints, getGrooveRects } from './drillGeometry'
import { insetEdgeLines } from './edgeLines'
import { computeCutLines } from './cutLines'
import { sameMaps } from './beamSaw'
import { nestingStats } from './nestingStats'
import { partListRows, colHead } from './partList'

const K = 1654 / 210                     // точек на мм
const PW = 1654, PH = 2339
const mm = v => v * K
const INK = '#1F1F1D', MUTED = '#6B6A66', DIM = '#3A3936', CUT = '#7B1FA2', LINE = '#B9B7B0', EDGE = '#E8590C', FILL = '#F3F0E8', BRAND = '#009BDE'
const r1 = v => Math.round(v * 10) / 10
const fmt = v => String(r1(v)).replace('.', ',')

const polyArea = pts => { let s = 0; for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; s += a.x * b.y - b.x * a.y } return Math.abs(s) / 2 }
const partArea = p => (Array.isArray(p.polygon) && p.polygon.length > 2 ? polyArea(p.polygon) : (Number(p.origX) || 0) * (Number(p.origY) || 0))

/** Текст по строкам в ширину w мм (переносы по словам и по \n), не больше maxLines строк -> строки */
function wrapLines(ctx, s, w, size, bold = false, maxLines = 99) {
  ctx.font = `${bold ? '600 ' : ''}${mm(size)}px Arial, Helvetica, sans-serif`
  const out = []
  for (const para of String(s ?? '').split(/\r?\n/)) {
    let line = ''
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const t = line ? `${line} ${word}` : word
      if (ctx.measureText(t).width <= mm(w) || !line) line = t
      else { out.push(line); line = word }
    }
    out.push(line)
  }
  while (out.length && !out[out.length - 1]) out.pop()
  if (out.length > maxLines) { out.length = maxLines; out[maxLines - 1] = out[maxLines - 1].replace(/.{0,2}$/, '') + '…' }
  return out
}
/** Примечания заказа для PDF: [[подпись, текст]] — из бланка заказа и от производства */
const orderNotes = (order, L = {}) => [[L.noOrderNote ? '' : 'Примечание к заказу', order?.order_note], [L.noProdNote ? '' : 'Примечание производства', order?.prod_note]]
  .map(([k, v]) => [k, String(v ?? '').trim()]).filter(([k, v]) => k && v)
/** Нарисовать примечания блоком шириной w с (x, y) -> высота блока, мм. dry — только посчитать */
function notesBlock(ctx, notes, x, y, w, { size = 3, maxLines = 4, dry = false } = {}) {
  let yy = y
  for (const [k, v] of notes) {
    const lines = wrapLines(ctx, `${k}: ${v}`, w, size, false, maxLines)
    lines.forEach((ln, i) => {
      yy += size * 1.3
      if (dry) return
      if (i === 0) {
        // подпись — жирным, сам текст — обычным
        text(ctx, `${k}:`, x, yy, { size, bold: true })
        ctx.font = `600 ${mm(size)}px Arial, Helvetica, sans-serif`
        const kw = ctx.measureText(`${k}: `).width / K
        text(ctx, ln.slice(k.length + 2), x + kw, yy, { size, max: w - kw })
      } else text(ctx, ln, x, yy, { size })
    })
    yy += 1
  }
  return yy - y
}
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

// Фирменный знак страницы: логотип и адрес приложения. Всегда в левом верхнем углу каждой страницы PDF —
// в стандартном виде и в любом своём макете; убрать или передвинуть его в конструкторе нельзя.
// -> правый край знака, мм (от него начинается заголовок)
const SITE = 'raskroypro.com'
function drawBrand(ctx, backing = false) {
  const x = 10, y = 8.5, h = 11
  if (backing) { ctx.fillStyle = '#FFFFFF'; ctx.fillRect(mm(x - 1), mm(y - 1), mm(38), mm(h + 2)) }
  const lw = drawLogo(ctx, x, y, h)
  ctx.font = `600 ${mm(3)}px Arial, Helvetica, sans-serif`
  const tw = ctx.measureText(SITE).width / K
  text(ctx, SITE, x + lw + 2, y + h * 0.62, { size: 3, bold: true, color: BRAND })
  return x + lw + 2 + tw
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

function drawSheet(ctx, bx, by, bw, bh, sheet, geo, details, noOf, opt = {}) {
  const s = Math.min(bw / geo.sheetW, bh / geo.sheetL)                    // мм бумаги на мм листа
  const x0 = bx + (bw - geo.sheetW * s) / 2, y0 = by
  const X = v => mm(x0 + v * s), Y = v => mm(y0 + (geo.sheetL - v) * s)   // v — от левого нижнего угла листа
  ctx.fillStyle = '#E9E6DD'; ctx.fillRect(X(0), Y(geo.sheetL), mm(geo.sheetW * s), mm(geo.sheetL * s))
  ctx.fillStyle = '#FFFFFF'; ctx.fillRect(X(geo.marginL), Y(geo.marginB + geo.usableY), mm(geo.usableX * s), mm(geo.usableY * s))
  // деловые обрезки
  for (const o of sheet.manualOffcuts || []) {
    const ox = Math.max(0, geo.marginL + o.x), oy = Math.max(0, geo.marginB + o.y), ow = Math.min(geo.sheetW, geo.marginL + o.x + o.w) - ox, oh = Math.min(geo.sheetL, geo.marginB + o.y + o.h) - oy
    // деловой обрезок — заметно: заливка, косая штриховка, рамка и размер (на маленьком — только размер)
    ctx.fillStyle = 'rgba(232,89,12,0.14)'; ctx.fillRect(X(ox), Y(oy + oh), mm(ow * s), mm(oh * s))
    ctx.save(); ctx.beginPath(); ctx.rect(X(ox), Y(oy + oh), mm(ow * s), mm(oh * s)); ctx.clip()
    ctx.strokeStyle = 'rgba(232,89,12,0.35)'; ctx.lineWidth = mm(0.15)
    for (let t = -oh * s; t < ow * s; t += 2.2) { ctx.beginPath(); ctx.moveTo(X(ox) + mm(t), Y(oy)); ctx.lineTo(X(ox) + mm(t + oh * s), Y(oy + oh)); ctx.stroke() }
    ctx.restore()
    ctx.strokeStyle = EDGE; ctx.lineWidth = mm(0.4); ctx.setLineDash([mm(1.4), mm(1)]); ctx.strokeRect(X(ox), Y(oy + oh), mm(ow * s), mm(oh * s)); ctx.setLineDash([])
    const ocx = x0 + (ox + ow / 2) * s, ocy = y0 + (geo.sheetL - oy - oh / 2) * s, dimTxt = `${Math.round(o.h)} × ${Math.round(o.w)}`
    if (ow * s > 16 && oh * s > 9) {
      text(ctx, 'обрезок', ocx, ocy - 0.8, { size: 2.8, color: EDGE, align: 'center' })
      text(ctx, dimTxt, ocx, ocy + 3, { size: 3.2, bold: true, color: EDGE, align: 'center' })
    } else if (ow * s > 9 && oh * s > 3.5) {
      text(ctx, dimTxt, ocx, ocy, { size: Math.min(2.6, oh * s * 0.6), bold: true, color: EDGE, align: 'center', base: 'middle' })
    }
  }
  for (const p of sheet.placed) {
    const w = Number(p.origX) || 0, h = Number(p.origY) || 0
    const px = geo.marginL + p.x, py = geo.marginB + p.y                  // левый нижний угол детали на листе
    const sameRgb = opt.sameFill && opt.sameFill[p.detailIndex]          // одинаковые детали — своим цветом (галочка «Одинаковые»)
    ctx.fillStyle = sameRgb ? `rgba(${sameRgb},${opt.sameAlpha})` : FILL; ctx.strokeStyle = INK; ctx.lineWidth = mm(0.28); ctx.lineJoin = 'round'
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
    const edgeLines = d && contour ? insetEdgeLines(d, contour, g) : null
    if (!edgeLines) {
      // прямоугольная деталь без контура: стороны уже повёрнуты вместе с деталью
      if (p.edgeTop) seg(g, h - g, w - g, h - g)
      if (p.edgeBottom) seg(g, g, w - g, g)
      if (p.edgeLeft) seg(g, g, g, h - g)
      if (p.edgeRight) seg(w - g, g, w - g, h - g)
    }
    if (contour) {
      const dW = Number(d.width) || 0, dL = Number(d.length) || 0, turns = placedTurns(p, d)
      ctx.save(); ctx.strokeStyle = EDGE; ctx.lineWidth = mm(0.7); ctx.lineCap = 'butt'; ctx.lineJoin = 'round'
      const curve = pts => {
        ctx.beginPath()
        pts.forEach(([qx, qy], k) => { const r = rotatePointTimes(qx, qy, dW, dL, turns); if (k) ctx.lineTo(X(px + r.x), Y(py + r.y)); else ctx.moveTo(X(px + r.x), Y(py + r.y)) })
        ctx.stroke()
      }
      ;(edgeLines || []).forEach(curve)
      const cut = contour.holes || []
      cut.forEach(hh => holeEdgeSegments(hh).forEach(sg => curve(sg.pts)))
      if (cut.length === holes.length) cut.forEach((hh, hi) => { if (hh.edge) { path(holes[hi]); ctx.stroke() } })   // вырез закромлен целиком
      ctx.restore()
      // Присадка — то же, что видно на карте раскроя в приложении: пазы и отверстия лицевой стороны, отверстия в торец
      const at = (qx, qy) => { const r = rotatePointTimes(qx, qy, dW, dL, turns); return [X(px + r.x), Y(py + r.y)] }
      const grooves = getGrooveRects(contour, dW, dL, true)
      if (grooves.length) {
        ctx.save(); ctx.fillStyle = 'rgba(250,199,117,0.75)'; ctx.strokeStyle = '#BA7517'; ctx.lineWidth = mm(0.12)
        for (const gr of grooves) {
          ctx.beginPath()
          gr.pts.forEach(([qx, qy], k) => { const [sx, sy] = at(qx, qy); if (k) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy) })
          ctx.closePath(); ctx.fill(); ctx.stroke()
        }
        ctx.restore()
      }
      const drills = getAllDrillPoints(contour, dW, dL, true)
      if (drills.length) {
        ctx.save(); ctx.fillStyle = '#6A4A17'
        for (const pt of drills) {
          const [sx, sy] = at(pt.x, pt.y)
          if (pt.edge && pt.depth > 0) {
            // отверстие в торец — полоса шириной в диаметр от края вглубь детали на глубину сверления
            const [ex, ey] = at(pt.x + pt.dx * pt.depth, pt.y + pt.dy * pt.depth)
            ctx.strokeStyle = 'rgba(106,74,23,0.85)'; ctx.lineCap = 'butt'; ctx.lineWidth = Math.max(mm(0.22), mm((pt.d || 8) * s))
            ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke()
            continue
          }
          const r = Math.max(mm(0.2), mm((pt.d || 8) * s / 2))
          ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2)
          // с лица — закрашенный кружок, с изнанки — пустой (только для сведения)
          if (pt.back) { ctx.strokeStyle = '#7B1FA2'; ctx.lineWidth = mm(0.1); ctx.stroke() } else ctx.fill()
        }
        ctx.restore()
      }
    }
    // подписи: номер позиции — в середине, размеры — вдоль сторон внутри детали (ширина — у верхней, длина — у левой).
    // На мелкой детали всё уменьшается, пока помещается; на совсем мелкой — номер и размер одной-двумя строками
    const pw = w * s, ph = h * s, cx = x0 + (px + w / 2) * s, cy = y0 + (geo.sheetL - py - h / 2) * s
    // подписи на карте (свой макет PDF): opt.dims — 'sides' размеры по сторонам (как было) | 'line' — номер и «Д×Ш»
    // одной строкой | 'none' — без размеров; opt.dimK — крупность подписей; opt.noNum — без номера позиции
    const dimsMode = opt.dims || 'sides', dk = opt.dimK || 1
    const no = opt.noNum ? '' : String(noOf.get(p.detailIndex) ?? '')
    const sw = fmt(w), sh = fmt(h)
    const tw = (str, size, bold) => { ctx.font = `${bold ? '600 ' : ''}${mm(size)}px Arial, Helvetica, sans-serif`; return ctx.measureText(str).width / K }
    const vtext = (str, x, y, size, opt = {}) => {                         // текст снизу вверх
      ctx.save(); ctx.translate(mm(x), mm(y)); ctx.rotate(-Math.PI / 2)
      ctx.font = `${opt.bold ? '600 ' : ''}${mm(size)}px Arial, Helvetica, sans-serif`; ctx.fillStyle = opt.color || INK
      ctx.textAlign = 'center'; ctx.textBaseline = opt.base || 'alphabetic'; ctx.fillText(str, 0, 0); ctx.restore()
    }
    if (dimsMode === 'none') {
      if (no) text(ctx, no, cx, cy, { size: Math.max(1.2, Math.min(4 * dk, Math.min(pw, ph) * 0.35)), bold: true, align: 'center', base: 'middle' })
      continue
    }
    let placed = false
    for (const k of dimsMode === 'line' ? [] : [1, 0.88, 0.76, 0.65, 0.55, 0.45]) {
      // размеры по сторонам — главное на распечатке (по ним режут): крупно; номер позиции — скромнее
      const ds = Math.max(1.5, Math.min(5.2 * dk, Math.min(pw, ph) * 0.26 * dk) * k)
      const ns = Math.max(1.8, Math.min(4 * dk, Math.min(pw, ph) * 0.3 * dk) * k)
      const eL = p.edgeLeft ? 0.9 : 0, eT = p.edgeTop ? 0.9 : 0           // размер не наезжает на полоску кромки
      const bandL = ds + 1.2 + eL, bandT = ds + 1.2 + eT                  // полосы под размер у левой и верхней стороны
      const fitTop = tw(sw, ds, true) <= pw - bandL - 0.8, fitLeft = tw(sh, ds, true) <= ph - bandT - 0.8
      const fitNo = ph / 2 - ns / 2 >= bandT + 0.3 && pw / 2 - tw(no, ns, true) / 2 >= bandL + 0.3
      if (!(fitTop && fitLeft && fitNo)) continue
      if (no) text(ctx, no, cx, cy, { size: ns, bold: true, align: 'center', base: 'middle' })
      text(ctx, sw, cx, y0 + (geo.sheetL - py - h) * s + ds + 0.9 + eT, { size: ds, bold: true, color: DIM, align: 'center' })
      vtext(sh, x0 + px * s + ds + 0.8 + eL, cy, ds, { bold: true, color: DIM })
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
      const one = Math.min(3.8 * dk, (short - 0.4) * 0.8, (long - 0.8) / Math.max(0.1, tw(no ? `${no}  ${dims}` : dims, 1.05, true)))
      const two = no ? Math.min(3.8 * dk, (short - 0.4) / 2.3, (long - 0.8) / Math.max(0.1, tw(dims, 1, true), tw(no, 1.15, true))) : 0
      if (one >= two) {
        const size = Math.max(0.9, one), wn = no ? tw(no, size, true) : 0, gap = no ? size * 0.5 : 0, total = wn + gap + tw(dims, size, true)
        if (vert) {
          vtext(no, cx, cy + total / 2 - wn / 2, size, { bold: true, base: 'middle' })
          vtext(dims, cx, cy - total / 2 + (total - wn - gap) / 2, size, { bold: true, color: DIM, base: 'middle' })
        } else {
          text(ctx, no, cx - total / 2 + wn / 2, cy, { size, bold: true, align: 'center', base: 'middle' })
          text(ctx, dims, cx + total / 2 - (total - wn - gap) / 2, cy, { size, bold: true, color: DIM, align: 'center', base: 'middle' })
        }
      } else {
        const size = Math.max(0.9, two), off = size * 0.6
        if (vert) {
          vtext(no, cx - off, cy, size * 1.15, { bold: true, base: 'middle' })
          vtext(dims, cx + off, cy, size, { bold: true, color: DIM, base: 'middle' })
        } else {
          text(ctx, no, cx, cy - off, { size: size * 1.15, bold: true, align: 'center', base: 'middle' })
          text(ctx, dims, cx, cy + off, { size, bold: true, color: DIM, align: 'center', base: 'middle' })
        }
      }
    }
  }
  // Пила (форматник): линии реза — те же, что на карте в приложении (сквозные резы по центру пропила, до края листа)
  if (opt.cuts) {
    const kerf = Number(geo.kerf) || 0, uy = geo.usableY
    const items = sheet.placed.map(p => ({ x: p.x, y: uy - p.y - (p.h - kerf), w: p.w, h: p.h }))
    const offs = (sheet.manualOffcuts || []).map(o => ({ ...o, y: uy - o.y - o.h }))
    let res = null
    try { res = computeCutLines(items, geo.usableX, uy, kerf, offs) } catch { res = null }
    if (res) {
      ctx.save(); ctx.strokeStyle = CUT; ctx.lineWidth = mm(0.4); ctx.setLineDash([mm(1.6), mm(0.9)])
      const toY = sy => geo.marginB + (uy - sy)                       // экранная Y рабочей зоны -> от низа листа
      for (const l of res.lines) {
        let a = l.from, b = l.to
        if (l.v) {
          if (a <= 0.5) a -= geo.marginT; if (b >= uy - 0.5) b += geo.marginB
          const xx = geo.marginL + l.pos
          ctx.beginPath(); ctx.moveTo(X(xx), Y(toY(a))); ctx.lineTo(X(xx), Y(toY(b))); ctx.stroke()
        } else {
          if (a <= 0.5) a -= geo.marginL; if (b >= geo.usableX - 0.5) b += geo.marginR
          const yy = toY(l.pos)
          ctx.beginPath(); ctx.moveTo(X(geo.marginL + a), Y(yy)); ctx.lineTo(X(geo.marginL + b), Y(yy)); ctx.stroke()
        }
      }
      ctx.restore()
    }
  }
  ctx.strokeStyle = INK; ctx.lineWidth = mm(0.4); ctx.strokeRect(X(0), Y(geo.sheetL), mm(geo.sheetW * s), mm(geo.sheetL * s))
  return { right: x0 + geo.sheetW * s, bottom: y0 + geo.sheetL * s }
}

// Обозначения присадки в легенде: отверстие в пласть, отверстие в торец, паз. x, y — начало и базовая линия текста, мм
function drillLegend(ctx, x, y) {
  ctx.fillStyle = '#6A4A17'; ctx.beginPath(); ctx.arc(mm(x + 1), mm(y - 0.9), mm(0.8), 0, Math.PI * 2); ctx.fill()
  text(ctx, 'отверстие', x + 3, y, { size: 2.5, color: MUTED })
  ctx.fillStyle = 'rgba(106,74,23,0.85)'; ctx.fillRect(mm(x + 21), mm(y - 1.5), mm(4), mm(1.1))
  text(ctx, 'в торец', x + 26.5, y, { size: 2.5, color: MUTED })
  ctx.fillStyle = 'rgba(250,199,117,0.75)'; ctx.strokeStyle = '#BA7517'; ctx.lineWidth = mm(0.12)
  ctx.fillRect(mm(x + 41), mm(y - 1.9), mm(5), mm(1.7)); ctx.strokeRect(mm(x + 41), mm(y - 1.9), mm(5), mm(1.7))
  text(ctx, 'паз', x + 47.5, y, { size: 2.5, color: MUTED })
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
// statsPage — «Статистика отдельно»: на странице листа только карта, список и условные обозначения (карта крупнее),
// сведения по листам и итог по материалу — отдельной страницей после карт
function preparePages({ order, mat, summary = null, tpl = null, ctx, sameAlpha = 0, statsPage = false }) {
  const sheets = (mat.sheets || []).filter(sh => sh?.placed?.length)
  const details = mat.details || []
  const sameOpt = sameAlpha > 0 ? { sameFill: sameColorMap(details), sameAlpha } : {}
  const custom = tpl?.custom && Array.isArray(tpl.items) && tpl.items.length ? tpl : null   // своё оформление листа (конструктор)
  const boxes = []                                   // где оказались элементы на странице — для рамок в конструкторе
  const matName = [mat.name || mat.label || order?.material_name || '', mat.thickness ? `${mat.thickness} мм` : ''].filter(Boolean).join(' · ')
  const geos = sheets.map(sh => sheetGeo(order, mat.result, sh))
  // пила: на листе — линии реза (по ним пилят)
  const cuts = (mat.method || mat.result?.method || order?.cutting_method) === 'guillotine'
  const used = sheets.map(sh => sh.placed.reduce((a, p) => a + partArea(p), 0))
  const totalUsed = used.reduce((a, b) => a + b, 0), totalArea = geos.reduce((a, g) => a + g.usableX * g.usableY, 0)
  const totalParts = sheets.reduce((a, sh) => a + sh.placed.length, 0)
  // кромка: на каждом листе и всего по листам этого файла
  const over = overMm(parseEdgeTypes(order?.edge_types))
  const edges = sheets.map(sh => sh.placed.reduce((a, p) => (details[p.detailIndex] ? addEdges(a, rawDetail(details[p.detailIndex]), over) : a), { total: 0, byName: {} }))
  const edgeAll = edges.reduce((a, e) => { a.total += e.total; for (const [k, v] of Object.entries(e.byName)) a.byName[k] = (a.byName[k] || 0) + v; return a }, { total: 0, byName: {} })
  const pages = []                                   // функции, рисующие страницу
  const notes = orderNotes(order)                    // примечания: из бланка заказа и от производства
  let pageNo = 0
  const header = (si, cont) => {
    pageNo++
    ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, PW, PH)
    const tx = drawBrand(ctx) + 4
    text(ctx, `Карта раскроя · ${orderTitle(order)}`, tx, 14.5, { size: 5, bold: true, max: 150 - tx })
    text(ctx, `${sheets[si].stock === 'offcut' ? 'Обрезок' : 'Лист'} ${si + 1} из ${sheets.length}${cont ? ' (продолжение)' : ''}`, 200, 14.5, { size: 5, bold: true, align: 'right' })
    text(ctx, matName, tx, 20.5, { size: 3.4, color: MUTED, max: 150 - tx })
    text(ctx, new Date().toLocaleDateString('ru-RU'), 200, 20.5, { size: 3, color: MUTED, align: 'right' })
    rule(ctx, 10, 25.5, 200, 25.5, 0.35, INK)
    text(ctx, `Сформировано в приложении RaskroyPro · ${SITE}`, 10, 292.5, { size: 2.4, color: MUTED })
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
    drillLegend(ctx, x + 92, y + 2.5)
    rule(ctx, x, y + 5.5, x + 7, y + 5.5, 0.38, EDGE); rule(ctx, x, y + 6.5, x + 7, y + 6.5, 0.38, EDGE)
    text(ctx, 'черта под размером в списке: одна — кромка с одной стороны, две — с двух', x + 9, y + 7, { size: 2.5, color: MUTED })
  }
  // β Пильный центр: одинаковые карты подписываются («карта ×3», «карта как лист 1»)
  const same = mat?.result?.beamSaw && mat.result.beamSettings?.mergeSame !== false ? sameMaps(sheets) : null
  // операции раскроя (резы, длина реза, периметр, присадка) — по листу и по всему материалу; считаются, только если
  // такие строки стоят в своём макете
  const OPS = ['sheetCuts', 'sheetCutM', 'sheetPerim', 'sheetHoles', 'sheetEdgeHoles', 'sheetGrooves', 'allCuts', 'allCutM', 'allPerim', 'allHoles', 'allEdgeHoles', 'allGrooves', 'allArea']
  const needOps = !!custom && custom.items.some(i => OPS.includes(i.type))
  const method = cuts ? 'guillotine' : 'nesting'
  const opsSheet = needOps ? sheets.map(sh => nestingStats({ order, mat: { ...mat, sheets: [sh] }, method })) : []
  const opsAll = needOps ? nestingStats({ order, mat: { ...mat, sheets }, method }) : null
  const opsVals = si => {
    if (!needOps) return {}
    const a = opsSheet[si], t = opsAll, n = v => m2(v)
    const cutWord = cuts ? 'Резов' : 'Контуров реза'
    const out = {
      sheetCuts: [`${cutWord} на листе`, String(a.cuts)], sheetCutM: ['Длина реза на листе', `${n(a.cutM)} м`], sheetPerim: ['Периметр деталей на листе', `${n(a.perimM)} м`],
      sheetHoles: ['Отверстий в пласть на листе', String(a.holes)], sheetEdgeHoles: ['Отверстий в торец на листе', String(a.edgeHoles)], sheetGrooves: ['Пазов на листе', `${a.grooves} шт · ${n(a.grooveM)} м`],
      allCuts: [`${cutWord} всего`, String(t.cuts)], allCutM: ['Длина реза всего', `${n(t.cutM)} м`], allPerim: ['Периметр деталей всего', `${n(t.perimM)} м`],
      allHoles: ['Отверстий в пласть всего', String(t.holes)], allEdgeHoles: ['Отверстий в торец всего', String(t.edgeHoles)], allGrooves: ['Пазов всего', `${t.grooves} шт · ${n(t.grooveM)} м`],
      allArea: ['Площадь деталей всего', `${n(t.partsM2)} м²`],
    }
    // операции, которых в заказе нет (нет присадки, пазов…), — пустые: строка на листе не печатается
    if (!t.holes) { out.sheetHoles[1] = ''; out.allHoles[1] = '' }
    if (!t.edgeHoles) { out.sheetEdgeHoles[1] = ''; out.allEdgeHoles[1] = '' }
    if (!t.grooves) { out.sheetGrooves[1] = ''; out.allGrooves[1] = '' }
    return out
  }
  // кромка по видам (как в заказе: из Excel или из бланка) с толщиной: «ПВХ 0,4 — 12,3 м · ПВХ 2 (2 мм) — 4,1 м»
  const eTypes = parseEdgeTypes(order?.edge_types)
  const byType = e => Object.entries(e.byName).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([n, v]) => {
    const t = Number(String((eTypes[n === 'Кромка' ? 'default' : n] || {}).t ?? '').replace(',', '.')) || 0, ts = String(t).replace('.', ',')
    return `${n}${t && !n.includes(ts) ? ` (${ts} мм)` : ''} — ${m2(v)} м`
  }).join(' · ')
  const pageValues = si => {
    const geo = geos[si], sheet = sheets[si], area = geo.usableX * geo.usableY
    return {
      ...opsVals(si),
      edgeTypesSheet: ['Кромка по видам', byType(edges[si])], edgeTypesAll: ['Кромка по видам, всего', byType(edgeAll)],
      orderNote: ['Примечание', String(order?.order_note || '').trim()], prodNote: ['Примечание производства', String(order?.prod_note || '').trim()],
      title: ['', `Карта раскроя · ${orderTitle(order)}`], order: ['Заказ', orderTitle(order)],
      sheetNo: ['', `${sheet.stock === 'offcut' ? 'Обрезок' : 'Лист'} ${si + 1} из ${sheets.length}${same && same[si].first !== si ? ` · карта как лист ${same[si].first + 1}` : same && same[si].count > 1 ? ` · карта ×${same[si].count}` : ''}`],
      material: ['Материал', matName], date: ['Дата', new Date().toLocaleDateString('ru-RU')],
      used: ['Использовано материала', `${Math.round(area > 0 ? used[si] / area * 100 : 0)} %`],
      sheetSize: ['Лист, мм', `${fmt(geo.sheetL)} × ${fmt(geo.sheetW)}`], usable: ['Рабочая область, мм', `${fmt(geo.usableY)} × ${fmt(geo.usableX)}`],
      kerf: ['Рез, мм', fmt(geo.kerf)], partsOnSheet: ['Деталей на листе', String(sheet.placed.length)], partsArea: ['Площадь деталей', `${m2(used[si] / 1e6)} м²`],
      offcuts: ['Обрезки, мм', (sheet.manualOffcuts || []).map(o => `${Math.round(o.h)}×${Math.round(o.w)}`).join(', ')],
      edgeSheet: ['Кромка на листе', edgeAll.total > 0 ? `${m2(edges[si].total)} м` : ''], edgeTotal: ['Кромка всего', edgeAll.total > 0 ? `${m2(edgeAll.total)} м` : ''],   // без кромки в заказе — не печатаются
      overs: ['', over > 0 ? `кромка со свесами ${fmt(over)} мм на сторону` : 'кромка без свесов'],
      totals: ['Всего', `листов ${sheets.length}, деталей ${totalParts}, использовано ${Math.round(totalArea > 0 ? totalUsed / totalArea * 100 : 0)} %`],
      footer: ['', `Сформировано в приложении RaskroyPro · ${SITE}`], pageNo: ['', `стр. ${pageNo}`],
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
        drawSheet(ctx, -bw / 2, -geo.sheetL * sc / 2, bw, bh, sheet, geo, details, noOf, { cuts, ...sameOpt, dims: it.dims, dimK: it.dimK, noNum: it.num === false })
        ctx.restore()
        boxes.push({ id: it.id, x: it.x, y: it.y, w: it.w, h: it.h, rot: 0, kind: 'box' })
      } else if (it.type === 'list') {
        let ly = listHead(ctx, it.x, it.y)
        for (let i = 0; i < first; i++) ly = listRow(ctx, it.x, ly, rows[i])
        if (rows.length > first) text(ctx, 'продолжение — на след. странице', it.x + LW, ly + 3, { size: 2.3, color: MUTED, align: 'right' })
        boxes.push({ id: it.id, x: it.x, y: it.y, w: LW, h: it.h, rot: 0, kind: 'tall' })
      } else if (it.type === 'legend') {
        legend(it.x, it.y)
        boxes.push({ id: it.id, x: it.x, y: it.y, w: 146, h: 8.5, rot: 0, kind: 'fixed' })
      } else if (it.type === 'line') {
        rule(ctx, it.x, it.y + 1, it.x + it.w, it.y + 1, 0.35, INK)
        boxes.push({ id: it.id, x: it.x, y: it.y, w: it.w, h: 2, rot: 0, kind: 'wide' })
      } else {
        const v = vals[it.type]
        const str = it.type === 'text' ? String(it.text || '') : !v ? '' : v[0] && it.label !== false ? `${v[0]}: ${v[1]}` : v[1]
        const size = Number(it.size) || 3
        if (it.type === 'orderNote' || it.type === 'prodNote') {
          // примечание — по строкам в ширину рамки элемента (на образце — серой подсказкой)
          const nw = Number(it.w) || 120, shownN = str || (v ? `${v[0]}: …` : '')
          const lines = wrapLines(ctx, shownN, nw, size, !!it.bold, it.lines || 6)
          ctx.save(); ctx.translate(mm(it.x), mm(it.y)); ctx.rotate(rot * Math.PI / 180)
          lines.forEach((ln, li) => text(ctx, ln, 0, li * size * 1.3, { size, bold: !!it.bold, color: !str ? LINE : it.muted ? MUTED : INK, base: 'top' }))
          ctx.restore()
          boxes.push({ id: it.id, x: it.x, y: it.y, w: nw, h: Math.max(1, lines.length) * size * 1.3, rot, kind: 'wide' })
          continue
        }
        const shown = str || (it.type === 'text' ? 'свой текст' : '')
        if (!shown || (v && !v[1])) continue
        ctx.save(); ctx.translate(mm(it.x), mm(it.y)); ctx.rotate(rot * Math.PI / 180)
        text(ctx, shown, 0, 0, { size, bold: !!it.bold, color: !str ? LINE : it.muted ? MUTED : INK, base: 'top' })
        const w = ctx.measureText(shown).width / K
        ctx.restore()
        boxes.push({ id: it.id, x: it.x, y: it.y, w: Math.max(3, w), h: size * 1.15, rot, kind: 'text' })
      }
    }
    drawBrand(ctx, true)          // знак приложения — всегда вверху, поверх всего, что на него поставили
  }
  // условные обозначения — внизу страницы листа
  const legendBottom = () => {
    let y = 282
    rule(ctx, 10, y - 0.9, 17, y - 0.9, 0.7, EDGE); text(ctx, 'сторона с кромкой', 19, y, { size: 2.5, color: MUTED })
    text(ctx, '12', 53, y + 0.1, { size: 3, bold: true, align: 'center' }); text(ctx, 'позиция по бланку заказа', 57, y, { size: 2.5, color: MUTED })
    drillLegend(ctx, 102, y)
    y = 286.5
    rule(ctx, 10, y - 1.5, 17, y - 1.5, 0.38, EDGE); rule(ctx, 10, y - 0.5, 17, y - 0.5, 0.38, EDGE)
    text(ctx, 'черта под размером в списке: одна — кромка с одной стороны, две — с двух', 19, y, { size: 2.5, color: MUTED })
  }
  const listItem = custom ? custom.items.find(i => i.type === 'list') : null
  sheets.forEach((sheet, si) => {
    const geo = geos[si], { rows, noOf } = sheetRows(sheet, details)
    const perCol = !custom ? PER_COL : listItem ? Math.max(1, Math.floor((listItem.h - 6) / LROW)) : rows.length
    const first = Math.min(rows.length, perCol)
    if (statsPage && !custom) {
      // «Статистика отдельно»: на странице листа — только карта на всю ширину и обозначения; список деталей листа
      // и сведения — на страницах статистики в конце
      pages.push(() => {
        header(si, false)
        const nh = notes.length ? notesBlock(ctx, notes, 10, LIST_TOP - 1, 190) + 2 : 0
        drawSheet(ctx, 10, LIST_TOP + nh, 190, 249 - nh, sheet, geo, details, noOf, { cuts, ...sameOpt })
        legendBottom()
      })
      return
    }
    pages.push(custom ? () => drawCustom(si, { sheet, geo, rows, noOf, first }) : () => {
      header(si, false)
      // примечания заказа — над схемой (схема на их высоту ниже)
      const nh = notes.length ? notesBlock(ctx, notes, 10, LIST_TOP - 1, 142) + 2 : 0
      // схема листа — слева, на всю ширину до списка
      const box = drawSheet(ctx, 10, LIST_TOP + nh, 142, 214 - nh, sheet, geo, details, noOf, { cuts, ...sameOpt })
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
      legendBottom()
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
  // «Статистика отдельно»: сведения по каждому листу таблицей и итог по материалу — страницей после карт
  if (statsPage && !custom && sheets.length) {
    const ROW = 6.2, TOP = 58, PER = Math.floor((278 - TOP) / ROW)
    const cols = [['Лист', 12, 'left'], ['Размер, мм', 58, 'right'], ['Использовано', 84, 'right'], ['Деталей', 104, 'right'], ['Площадь, м²', 128, 'right'], ['Кромка, м', 150, 'right'], ['Обрезки, мм', 154, 'left']]
    for (let from = 0; from < sheets.length; from += PER) {
      pages.push(() => {
        pageNo++
        ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, PW, PH)
        const tx = drawBrand(ctx) + 4
        text(ctx, `Статистика листов · ${orderTitle(order)}`, tx, 14.5, { size: 5, bold: true, max: 190 - tx })
        text(ctx, matName, tx, 20.5, { size: 3.4, color: MUTED, max: 150 - tx })
        text(ctx, new Date().toLocaleDateString('ru-RU'), 200, 20.5, { size: 3, color: MUTED, align: 'right' })
        rule(ctx, 10, 25.5, 200, 25.5, 0.35, INK)
        text(ctx, `Сформировано в приложении RaskroyPro · ${SITE}`, 10, 292.5, { size: 2.4, color: MUTED })
        text(ctx, `стр. ${pageNo}`, 200, 292.5, { size: 2.4, color: MUTED, align: 'right' })
        // итог по материалу
        const pctAll = Math.round(totalArea > 0 ? totalUsed / totalArea * 100 : 0)
        text(ctx, 'Использовано материала', 10, 34, { size: 2.6, color: MUTED })
        text(ctx, `${pctAll} %`, 10, 41.5, { size: 5.6, bold: true })
        text(ctx, `листов ${sheets.length}, деталей ${totalParts}, рез ${fmt(geos[0].kerf)} мм`, 10, 47, { size: 2.8, color: MUTED })
        edgeBlock(104, 34, sheets.length > 1 ? `Кромка всего, ${sheets.length} лист.` : 'Кромка всего', edgeAll, 96)
        text(ctx, over > 0 ? `со свесами ${fmt(over)} мм на сторону` : 'без свесов', 104, 47, { size: 2.5, color: MUTED })
        // таблица листов
        let y = TOP
        ctx.fillStyle = '#EFEDE6'; ctx.fillRect(mm(10), mm(y - 4.2), mm(190), mm(6))
        for (const [t, x, a] of cols) text(ctx, t, x, y, { size: 2.7, bold: true, color: MUTED, align: a })
        y += 1.6
        for (let si = from; si < Math.min(sheets.length, from + PER); si++) {
          y += ROW
          const g = geos[si], sh = sheets[si], area = g.usableX * g.usableY
          const v = [`${sh.stock === 'offcut' ? 'Обрезок' : 'Лист'} ${si + 1}${same && same[si].first !== si ? ` (как ${same[si].first + 1})` : ''}`, `${fmt(g.sheetL)} × ${fmt(g.sheetW)}`,
            `${Math.round(area > 0 ? used[si] / area * 100 : 0)} %`, String(sh.placed.length), m2(used[si] / 1e6), m2(edges[si].total),
            (sh.manualOffcuts || []).map(o => `${Math.round(o.h)}×${Math.round(o.w)}`).join(', ')]
          cols.forEach(([, x, a], ci) => text(ctx, v[ci], x, y, { size: 3, bold: ci === 0 || ci === 2, align: a, ...(ci === 6 ? { max: 46, color: MUTED } : {}) }))
          rule(ctx, 10, y + 1.8, 200, y + 1.8, 0.1)
        }
        if (notes.length && from + PER >= sheets.length && y + 12 < 280) notesBlock(ctx, notes, 10, y + 6, 190, { size: 3.2, maxLines: Math.max(1, Math.floor((280 - y - 8) / 4.2 / notes.length)) })
      })
    }
    // списки деталей листов — колонками (по 4 на странице), каждый лист со своей подписью
    const ops = []                       // [{ page, col, y, kind: 'title'|'head'|'row', ... }]
    let page = 0, col = 0, y = LIST_TOP
    const next = () => { col++; y = LIST_TOP; if (col > 3) { col = 0; page++ } }
    sheets.forEach((sheet, si) => {
      const { rows } = sheetRows(sheet, details)
      if (y + 5 + 6 + LROW > LIST_BOTTOM) next()
      const title = `${sheet.stock === 'offcut' ? 'Обрезок' : 'Лист'} ${si + 1} · ${sheet.placed.length} дет.`
      ops.push({ page, col, y, kind: 'title', t: title }); y += 5
      ops.push({ page, col, y, kind: 'head' }); y += 6
      for (const r of rows) {
        if (y + LROW > LIST_BOTTOM) { next(); ops.push({ page, col, y, kind: 'title', t: `${title} (прод.)` }); y += 5; ops.push({ page, col, y, kind: 'head' }); y += 6 }
        ops.push({ page, col, y, kind: 'row', r }); y += LROW
      }
      y += 4
    })
    const anyCut = sheets.some(sh => sheetRows(sh, details).rows.some(r => r.cut))
    for (let pg = 0; pg <= page; pg++) {
      pages.push(() => {
        pageNo++
        ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, PW, PH)
        const tx = drawBrand(ctx) + 4
        text(ctx, `Детали по листам · ${orderTitle(order)}`, tx, 14.5, { size: 5, bold: true, max: 190 - tx })
        text(ctx, matName, tx, 20.5, { size: 3.4, color: MUTED, max: 150 - tx })
        text(ctx, new Date().toLocaleDateString('ru-RU'), 200, 20.5, { size: 3, color: MUTED, align: 'right' })
        rule(ctx, 10, 25.5, 200, 25.5, 0.35, INK)
        for (const o of ops) {
          if (o.page !== pg) continue
          const x = 10 + o.col * (LW + 4.6)
          if (o.kind === 'title') text(ctx, o.t, x, o.y + 3.6, { size: 3, bold: true, max: LW })
          else if (o.kind === 'head') listHead(ctx, x, o.y)
          else listRow(ctx, x, o.y, o.r)
        }
        if (anyCut) text(ctx, 'Размеры в списке — заготовки (с учётом кромки).', 10, 288.5, { size: 2.4, color: MUTED })
        text(ctx, `Сформировано в приложении RaskroyPro · ${SITE}`, 10, 292.5, { size: 2.4, color: MUTED })
        text(ctx, `стр. ${pageNo}`, 200, 292.5, { size: 2.4, color: MUTED, align: 'right' })
      })
    }
  }
  // Статистика раскроя и стоимость работ — отдельной страницей после карт (вид — конструктор страницы статистики:
  // summary.layout { sections — порядок разделов 'stats' | 'cost' | 'notes', size — шрифт строк, мм, cols — 1 или 2 колонки })
  const hasSummary = summary && ((summary.rows || []).length || (summary.lines || []).length || summary.total != null)
  if (hasSummary) {
    // страницы статистики: сначала прогон — сколько их (длинный список деталей уходит на следующие), потом каждая рисуется
    const notesS = orderNotes(order, summary.layout)
    const partRows = summary.layout?.parts ? partListRows(order, { ...mat, sheets }, summary.layout.parts.cols) : null
    const starts = []
    let st = { sec: 0, row: 0 }
    for (let g = 0; st && g < 60; g++) { starts.push(st); st = drawSummaryPage(ctx, { order, matName, summary, notes: notesS, pageNo: 0, partRows, state: st }) }
    for (const s0 of starts) pages.push(() => { pageNo++; drawSummaryPage(ctx, { order, matName, summary, notes: notesS, pageNo, partRows, state: s0 }) })
  }
  return { pages, boxes }
}

/**
 * Страницы «Статистика раскроя»: разделы в заданном порядке. Длинный список деталей переносится на следующие страницы
 * (шапка таблицы повторяется). -> [состояние начала каждой страницы] — по нему страница рисуется ещё раз при сборке PDF.
 * state — { sec: номер раздела, row: строка списка деталей }
 */
const SUM_BOTTOM = 284
function drawSummaryPage(ctx, { order, matName, summary, notes, pageNo, partRows = null, state = { sec: 0, row: 0 } }) {
  const L = summary.layout || {}
  const sections = Array.isArray(L.sections) && L.sections.length ? L.sections : ['stats', 'cost', 'notes']
  const fs = Math.min(5, Math.max(2.4, Number(L.size) || 3.1)), step = fs * 1.75, cols = L.cols === 1 ? 1 : 2
  ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, PW, PH)
  const tx = drawBrand(ctx) + 4
  const cont = state.sec > 0 || state.row > 0
  text(ctx, `${L.title || 'Статистика раскроя'} · ${orderTitle(order)}${cont ? ' (продолжение)' : ''}`, tx, 14.5, { size: 5, bold: true, max: 190 - tx })
  text(ctx, matName, tx, 20.5, { size: 3.4, color: MUTED, max: 150 - tx })
  text(ctx, new Date().toLocaleDateString('ru-RU'), 200, 20.5, { size: 3, color: MUTED, align: 'right' })
  rule(ctx, 10, 25.5, 200, 25.5, 0.35, INK)
  text(ctx, `Сформировано в приложении RaskroyPro · ${SITE}`, 10, 292.5, { size: 2.4, color: MUTED })
  text(ctx, `стр. ${pageNo}`, 200, 292.5, { size: 2.4, color: MUTED, align: 'right' })
  let y = 34
  const draw = {
    stats: () => {
      const rows = summary.rows || []
      if (!rows.length) return
      text(ctx, 'Раскрой', 10, y, { size: 3.6, bold: true }); y += 3
      // одна или две колонки: подпись слева, значение справа
      const per = Math.ceil(rows.length / cols), colW = cols === 1 ? 190 : 92
      rows.forEach((r, i) => {
        const c = Math.floor(i / per), yy = y + step * ((i % per) + 1), x = 10 + c * (colW + 6)
        text(ctx, r.label, x, yy, { size: fs * 0.97, color: MUTED, max: colW - 40 })
        text(ctx, r.value, x + colW, yy, { size: fs, bold: true, align: 'right', max: 40 })
        rule(ctx, x, yy + 1.6, x + colW, yy + 1.6, 0.1)
      })
      y += step * per + 10
    },
    // деловые остатки: размеры и сколько штук — что ушло на склад
    offcuts: () => {
      const list = summary.offcuts || []
      if (!list.length) return
      text(ctx, 'Деловые остатки', 10, y, { size: 3.6, bold: true }); y += 6
      ctx.fillStyle = '#EFEDE6'; ctx.fillRect(mm(10), mm(y - 4.2), mm(100), mm(6))
      text(ctx, '№', 12, y, { size: 2.7, bold: true, color: MUTED })
      text(ctx, 'Длина, мм', 50, y, { size: 2.7, bold: true, color: MUTED, align: 'right' })
      text(ctx, 'Ширина, мм', 78, y, { size: 2.7, bold: true, color: MUTED, align: 'right' })
      text(ctx, 'Кол-во', 106, y, { size: 2.7, bold: true, color: MUTED, align: 'right' })
      y += 2
      list.forEach(([l, w, n], i) => {
        y += step
        text(ctx, String(i + 1), 12, y, { size: fs * 0.97, color: MUTED })
        text(ctx, String(l), 50, y, { size: fs, bold: true, align: 'right' })
        text(ctx, String(w), 78, y, { size: fs, bold: true, align: 'right' })
        text(ctx, `${n} шт`, 106, y, { size: fs, align: 'right' })
        rule(ctx, 10, y + 1.7, 110, y + 1.7, 0.1)
      })
      y += 10
    },
    cost: () => {
      const lines = summary.lines || []
      if (!lines.length && summary.total == null) return
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
          y += step
          text(ctx, l.title, 12, y, { size: fs, max: 96 })
          if (l.qty) text(ctx, l.qty, 136, y, { size: fs * 0.97, color: MUTED, align: 'right' })
          if (l.rate) text(ctx, l.rate, 168, y, { size: fs * 0.97, color: MUTED, align: 'right' })
          text(ctx, l.sum, 198, y, { size: fs, bold: true, align: 'right' })
          rule(ctx, 10, y + 1.7, 200, y + 1.7, 0.1)
        }
        y += 8
      }
      if (summary.total != null) {
        text(ctx, summary.minApplied ? 'Итого (минимальная сумма заказа)' : 'Итого', 12, y, { size: 3.8, bold: true })
        text(ctx, summary.total, 198, y, { size: 5, bold: true, align: 'right' })
        rule(ctx, 10, y + 2.4, 200, y + 2.4, 0.35, INK); y += 8
        text(ctx, 'Стоимость работ; материал и кромка в сумму не входят.', 12, y, { size: 2.5, color: MUTED }); y += 8
      }
    },
    notes: () => {
      if (!notes.length || y + 12 > SUM_BOTTOM) return
      y += notesBlock(ctx, notes, 10, y, 190, { size: fs, maxLines: Math.max(1, Math.floor((SUM_BOTTOM - y - 4) / (fs * 1.3) / notes.length)) }) + 6
    },
  }
  for (let si = state.sec; si < sections.length; si++) {
    const k = sections[si]
    if (k === 'parts') {
      const P = L.parts
      if (!P?.cols?.length || !partRows?.length) continue
      const from = si === state.sec ? state.row : 0
      // мало места до конца страницы — таблица начинается со следующей
      if (from === 0 && y > SUM_BOTTOM - 30 && y > 40) return { sec: si, row: 0 }
      const next = drawPartTable(ctx, { P, rows: partRows, from, y, fsBase: fs, cont: from > 0 })
      if (next.row < partRows.length) return { sec: si, row: next.row }
      y = next.y + 8
      continue
    }
    // раздел не влезает в остаток страницы — на следующую (кроме самого первого на странице)
    if (y > SUM_BOTTOM - 20 && y > 40 && si > state.sec) return { sec: si, row: 0 }
    draw[k]?.()
  }
  return null
}

/** Таблица деталей: шапка (повторяется на каждой странице), строки с переносом по словам. -> { row: следующая строка, y } */
function drawPartTable(ctx, { P, rows, from, y, fsBase, cont }) {
  const cols = P.cols
  const fs = Math.min(4.5, Math.max(2, Number(P.size) || fsBase * 0.85)), lh = fs * 1.3, pad = 1
  // ширина колонок: своя (мм) или «авто» — по самому длинному тексту (шапка и значения), авто-колонки ужимаются,
  // если все вместе не влезают в 190 мм
  ctx.font = `${mm(fs)}px Arial, Helvetica, sans-serif`
  const want = cols.map((c, ci) => {
    if (Number(c.w) > 0) return Number(c.w)
    let w = 0
    ctx.font = `600 ${mm(fs * 0.9)}px Arial, Helvetica, sans-serif`
    for (const word of colHead(c).split(/\s+/)) w = Math.max(w, ctx.measureText(word).width / K)
    ctx.font = `${mm(fs)}px Arial, Helvetica, sans-serif`
    for (const r of rows) w = Math.max(w, ctx.measureText(r[ci] || '').width / K)
    return Math.min(70, w + 2 * pad + 0.5)
  })
  const isAuto = i => !(Number(cols[i].w) > 0)
  const fixed = cols.reduce((a, c, i) => a + (isAuto(i) ? 0 : want[i]), 0), auto = want.reduce((a, w, i) => a + (isAuto(i) ? w : 0), 0)
  const room = Math.max(0, 190 - fixed)
  let ws = want.slice()
  if (auto > room && room > 0) {
    // не влезает — ужимаются самые широкие авто-колонки (длинные названия переносятся), короткие (размеры, кромка) — как есть
    let lo = 0, hi = Math.max(...want)
    for (let it = 0; it < 30; it++) { const c = (lo + hi) / 2; const sum = want.reduce((a, w, i) => a + (isAuto(i) ? Math.min(w, c) : 0), 0); if (sum > room) hi = c; else lo = c }
    ws = want.map((w, i) => (isAuto(i) ? Math.max(6, Math.min(w, lo)) : w))
  } else if (auto > 0 && auto < room) {
    // свободное место — поровну по ширине авто-колонок: таблица во всю ширину страницы
    const k2 = room / auto
    ws = want.map((w, i) => (isAuto(i) ? w * k2 : w))
  }
  const xs = []; let x = 10; for (const w of ws) { xs.push(x); x += w }
  const right = Math.min(200, x)
  if (!cont) { text(ctx, 'Список деталей', 10, y, { size: 3.6, bold: true }); y += 3 }
  // шапка
  const headLines = cols.map((c, ci) => wrapLines(ctx, colHead(c), ws[ci] - 2 * pad, fs * 0.9, true, 3))
  const hh = Math.max(...headLines.map(l => l.length)) * fs * 0.9 * 1.3 + 2
  ctx.fillStyle = '#EFEDE6'; ctx.fillRect(mm(10), mm(y), mm(right - 10), mm(hh))
  headLines.forEach((ls, ci) => ls.forEach((ln, li) => text(ctx, ln, xs[ci] + pad, y + 1 + fs * 0.9 * 1.3 * (li + 1) - fs * 0.25, { size: fs * 0.9, bold: true, color: DIM })))
  const top = y
  y += hh
  rule(ctx, 10, y, right, y, 0.25, INK)
  let i = from
  for (; i < rows.length; i++) {
    const lines = rows[i].map((v, ci) => (P.wrap ? wrapLines(ctx, v, ws[ci] - 2 * pad, fs, false, 3) : [v]))
    const rh = Math.max(1, ...lines.map(l => l.length)) * lh + 1.2
    if (y + rh > SUM_BOTTOM) break
    lines.forEach((ls, ci) => ls.forEach((ln, li) => text(ctx, ln, xs[ci] + pad, y + lh * (li + 1) - fs * 0.2, { size: fs, max: P.wrap ? 0 : ws[ci] - 2 * pad })))
    y += rh
    rule(ctx, 10, y, right, y, 0.1)
  }
  // вертикальные линии колонок
  for (const xx of [...xs, right]) rule(ctx, xx, top, xx, y, 0.1)
  return { row: i, y }
}

/** Превью страницы статистики для конструктора (образец заказа). -> canvas */
export function drawSummaryPreview(canvas, { order, mat, summary }) {
  canvas.width = PW; canvas.height = PH
  const ctx = canvas.getContext('2d')
  const matName = [mat?.name || '', mat?.thickness ? `${mat.thickness} мм` : ''].filter(Boolean).join(' · ')
  const partRows = summary?.layout?.parts ? partListRows(order, mat, summary.layout.parts.cols) : null
  drawSummaryPage(ctx, { order, matName, summary, notes: orderNotes(order, summary?.layout), pageNo: (mat?.sheets?.length || 0) + 1, partRows })
  return canvas

}

/**
 * Показать первую страницу (первый лист) на canvas — для конструктора листа.
 * -> рамки элементов: [{ id, x, y, w, h, rot, kind }] в мм
 */
/** Образец для конструктора в настройках производства (заказа под рукой нет): два листа с деталями, кромкой и обрезком */
export function demoPdfSample() {
  const E = 'ПВХ 0,4', E2 = 'ПВХ 2'
  const det = (name, L, W, e, pos) => ({ name, length: L, width: W, qty: 1, edge_top: e[0] || null, edge_right: e[1] || null, edge_bottom: e[2] || null, edge_left: e[3] || null,
    contour: JSON.stringify({ vertices: [{ x: 0, y: 0, r: 0 }, { x: W, y: 0, r: 0 }, { x: W, y: L, r: 0 }, { x: 0, y: L, r: 0 }], holes: [], grooves: [], layout: [], meta: { pos }, drillings: [] }) })
  const details = [det('Бок', 720, 560, [E2, E, E, E], '1'), det('Полка', 764, 540, [E2], '2'), det('Крышка', 800, 560, [E2, E, E, E], '3'), det('Цоколь', 764, 100, [E], '4'), det('Дно ящика', 450, 380, [], '5')]
  const k = 4
  const P = (di, x, y, rot) => { const d = details[di], w = rot ? d.length : d.width, h = rot ? d.width : d.length; return { detailIndex: di, x, y, w: w + k, h: h + k, origX: w, origY: h, ...(rot ? { rotated: true, rotation: 90 } : {}) } }
  const s1 = { placed: [P(0, 0, 0), P(0, 564, 0), P(2, 1128, 0), P(1, 0, 804), P(1, 544, 804), P(1, 1088, 804), P(3, 0, 1572, true), P(3, 768, 1572, true), P(4, 0, 1676), P(4, 384, 1676), P(4, 768, 1676)] }
  const s2 = { placed: [P(0, 0, 0), P(0, 564, 0), P(2, 1128, 0), P(1, 0, 804)], manualOffcuts: [{ x: 544, y: 808, w: 1266, h: 1922 }] }
  const order = { id: null, order_number: '261023_001', order_name: 'Образец', order_note: 'Фасады — текстура вертикально', prod_note: 'Кромка 2 мм — только по фасадам', material_name: 'ЛДСП Белый', material_thickness: 16, sheet_length: 2750, sheet_width: 1830, margin_left: 10, margin_right: 10, margin_top: 10, margin_bottom: 10, kerf_width: k }
  const mat = { key: 'demo', name: 'ЛДСП Белый', thickness: 16, details, sheets: [s1, s2], result: { sheets: [s1, s2] } }
  return { order, mat }
}

export function drawPdfPreview(canvas, { order, mat, tpl }) {
  canvas.width = PW; canvas.height = PH
  const ctx = canvas.getContext('2d')
  const { pages, boxes } = preparePages({ order, mat, tpl: { ...tpl, custom: true }, ctx })
  if (pages[0]) pages[0](); else { ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, PW, PH) }
  return boxes
}

export async function buildNestingPdf({ order, mat, onProgress, summary = null, tpl = null, same = 0, statsPage = false }) {
  const cv = document.createElement('canvas'); cv.width = PW; cv.height = PH
  const ctx = cv.getContext('2d')
  const { pages } = preparePages({ order, mat, summary, tpl, ctx, sameAlpha: same, statsPage })
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
export async function saveNestingPdf({ order, mat, fileName, onProgress, summary = null, tpl = null, same = 0, statsPage = false }) {
  const data = await buildNestingPdf({ order, mat, onProgress, summary, tpl, same, statsPage })
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
  ['map', 'Карта листа', 'box'], ['list', 'Список деталей', 'box'], ['legend', 'Условные обозначения', 'box'], ['line', 'Линия', 'box'],
  ['title', 'Заголовок: карта раскроя и заказ', 'text'], ['order', 'Заказ', 'text'], ['sheetNo', 'Номер листа', 'text'], ['material', 'Материал', 'text'], ['date', 'Дата', 'text'],
  ['used', 'Использовано материала', 'text'], ['sheetSize', 'Размер листа', 'text'], ['usable', 'Рабочая область', 'text'], ['kerf', 'Ширина реза', 'text'],
  ['partsOnSheet', 'Деталей на листе', 'text'], ['partsArea', 'Площадь деталей', 'text'], ['offcuts', 'Обрезки', 'text'],
  ['edgeSheet', 'Кромка на листе', 'text'], ['edgeTotal', 'Кромка всего', 'text'], ['overs', 'Свесы кромки', 'text'], ['totals', 'Всего по заказу', 'text'],
  ['sheetCuts', 'Резов на листе', 'text'], ['sheetCutM', 'Длина реза на листе', 'text'], ['sheetPerim', 'Периметр деталей на листе', 'text'],
  ['sheetHoles', 'Отверстий в пласть на листе', 'text'], ['sheetEdgeHoles', 'Отверстий в торец на листе', 'text'], ['sheetGrooves', 'Пазов на листе', 'text'],
  ['allCuts', 'Резов всего', 'text'], ['allCutM', 'Длина реза всего', 'text'], ['allPerim', 'Периметр деталей всего', 'text'],
  ['allHoles', 'Отверстий в пласть всего', 'text'], ['allEdgeHoles', 'Отверстий в торец всего', 'text'], ['allGrooves', 'Пазов всего', 'text'], ['allArea', 'Площадь деталей всего', 'text'],
  ['edgeTypesSheet', 'Кромка по видам на листе', 'text'], ['edgeTypesAll', 'Кромка по видам всего', 'text'],
  ['orderNote', 'Примечание к заказу', 'text'], ['prodNote', 'Примечание производства', 'text'],
  ['footer', 'Подпись приложения', 'text'], ['pageNo', 'Номер страницы', 'text'], ['text', 'Свой текст', 'text'],
]
export const pdfItemTitle = type => (PDF_ITEMS.find(x => x[0] === type) || [])[1] || type
export const pdfItemKind = type => (PDF_ITEMS.find(x => x[0] === type) || [])[2] || 'text'
const HAS_LABEL = new Set(['order', 'material', 'date', 'used', 'sheetSize', 'usable', 'kerf', 'partsOnSheet', 'partsArea', 'offcuts', 'edgeSheet', 'edgeTotal', 'totals',
  'sheetCuts', 'sheetCutM', 'sheetPerim', 'sheetHoles', 'sheetEdgeHoles', 'sheetGrooves', 'allCuts', 'allCutM', 'allPerim', 'allHoles', 'allEdgeHoles', 'allGrooves', 'allArea', 'orderNote', 'prodNote', 'edgeTypesSheet', 'edgeTypesAll'])
export const pdfItemHasLabel = type => HAS_LABEL.has(type)

const T = (type, x, y, size, extra = {}) => ({ type, x, y, size, ...extra })
const DEFAULT_ITEMS = [
  T('title', 49, 10.4, 5, { bold: true }), T('sheetNo', 168, 10.4, 5, { bold: true }),
  T('material', 49, 17.6, 3.4, { muted: true, label: false }), T('date', 183, 17.8, 3, { muted: true, label: false }),
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
  const base = type === 'map' ? { x: 20, y: 40, w: 100, h: 150, rot: 0 } : type === 'list' ? { x: 150, y: 40, h: 200 }
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
    if (i.type === 'map') Object.assign(o, { w: clamp(i.w, 20, 210, 142), h: clamp(i.h, 20, 297, 214), rot: normRot(i.rot),
      ...(['line', 'none'].includes(i.dims) ? { dims: i.dims } : {}), ...(i.dimK && Math.abs(i.dimK - 1) > 0.01 ? { dimK: clamp(i.dimK, 0.5, 2.5, 1) } : {}), ...(i.num === false ? { num: false } : {}) })
    else if (i.type === 'list') o.h = clamp(i.h, 20, 290, 258)
    // левый верхний угол занят знаком приложения: текст оттуда сдвигается правее, чтобы знак его не закрыл
    if (i.type !== 'map' && i.type !== 'line' && o.y < 20 && o.y > -4 && o.x < 48) o.x = 49
    if (i.type === 'orderNote' || i.type === 'prodNote') o.w = clamp(i.w, 20, 200, 120)
    if (i.type === 'line') o.w = clamp(i.w, 5, 210, 190)
    else if (i.type !== 'legend' && i.type !== 'map' && i.type !== 'list') Object.assign(o, { size: clamp(i.size, 1.5, 14, 3), bold: !!i.bold, muted: !!i.muted, rot: normRot(i.rot), ...(i.label === false ? { label: false } : {}), ...(i.type === 'text' ? { text: String(i.text || '').slice(0, 200) } : {}) })
    return o
  })
  return { custom: !!raw?.custom, items }
}

