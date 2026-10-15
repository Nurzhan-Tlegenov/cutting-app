// Импорт деталировки из PDF, сохранённого программой SketchCut (Lite / Pro).
// В PDF это не таблица, а текст и линии, поэтому читаем страницу как чертёж:
//   — таблица «Детали»: #, Длина, Ширина, Кол-во, Поворот, Наименование;
//   — кромка показана чёрточками под размером: одна чёрточка под длиной — кромка на одной стороне
//     по длине, две — на обеих; так же под шириной;
//   — на первой странице — виды кромки («Тип 1: 2») и их метраж («Длина 2 — 21,96 м.»): по метражу
//     проверяем, что кромку прочитали верно, и определяем, какой вид кромки нарисован какой линией.
// Модуль без React. parseSketchCut — чистая функция (её можно проверить без браузера).
import { importRetry } from './lazyRetry.js'

const num = v => {
  const s = String(v ?? '').replace(/\s/g, '').replace(',', '.')
  return /^-?\d+(\.\d+)?$/.test(s) ? parseFloat(s) : NaN
}
const low = s => String(s ?? '').trim().toLowerCase()

// Название вида кромки: SketchCut чаще всего хранит просто толщину («2», «0.4»)
function edgeName(raw) {
  const n = num(raw)
  return Number.isNaN(n) ? String(raw).trim().slice(0, 30) : `${String(n).replace('.', ',')} мм`
}
function edgeThick(raw) {
  const n = num(raw)
  if (!Number.isNaN(n)) return n
  const m = String(raw).match(/(\d+(?:[.,]\d+)?)\s*(?:мм|mm)/i)
  return m ? parseFloat(m[1].replace(',', '.')) : null
}

// ---------- Чтение PDF: текст + линии ----------

let pdfjsReady = null
function loadPdfjs() {
  if (!pdfjsReady) {
    pdfjsReady = importRetry(async () => {
      // «legacy»-сборка — чтобы работало и на телефонах со старым браузером
      const [lib, worker] = await Promise.all([
        import('pdfjs-dist/legacy/build/pdf.mjs'),
        import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
      ])
      lib.GlobalWorkerOptions.workerSrc = worker.default
      return lib
    }).catch(err => { pdfjsReady = null; throw err })
  }
  return pdfjsReady
}

const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
]
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]

// Страница -> { texts: [{ str, x, y, w, h }], lines: [{ x0, x1, y, style }], rects: [{ x0, y0, x1, y1 }] }
// Координаты — в пунктах, начало в левом верхнем углу, Y вниз. У текста y — базовая линия.
export async function pageGeometry(page, OPS) {
  const [, , , pageH] = page.view
  const H = pageH
  const tc = await page.getTextContent()
  const texts = []
  for (const it of tc.items) {
    const str = (it.str || '').trim()
    if (!str) continue
    const t = it.transform
    texts.push({ str, x: t[4], y: H - t[5], w: it.width || 0, h: it.height || Math.abs(t[3]) || 10 })
  }

  const ops = await page.getOperatorList()
  const lines = [], rects = []
  let ctm = [1, 0, 0, 1, 0, 0], lw = 1, color = '', dash = ''
  const stack = []
  const isStroke = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke])
  const isFill = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke])
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i], a = ops.argsArray[i]
    if (fn === OPS.save) stack.push({ ctm, lw, color, dash })
    else if (fn === OPS.restore) { const s = stack.pop(); if (s) ({ ctm, lw, color, dash } = s) }
    else if (fn === OPS.transform) ctm = mul(ctm, a)
    else if (fn === OPS.setLineWidth) lw = a[0]
    else if (fn === OPS.setDash) dash = (a[0] || []).length ? 'd' : ''
    else if (fn === OPS.setStrokeRGBColor || fn === OPS.setStrokeColor) color = Array.from(a).map(v => (typeof v === 'number' ? Math.round(v) : v)).join(',')
    else if (fn === OPS.constructPath) {
      const paint = a[0], box = a[2]
      if (!box || !(isStroke.has(paint) || isFill.has(paint))) continue
      const [ax, ay] = apply(ctm, box[0], box[1]), [bx, by] = apply(ctm, box[2], box[3])
      const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx)
      const y0 = H - Math.max(ay, by), y1 = H - Math.min(ay, by)
      const w = x1 - x0, h = y1 - y0
      if (w < 6) continue
      const scale = Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2])) || 1
      if (h < 0.6 && isStroke.has(paint)) {
        // горизонтальная линия
        lines.push({ x0, x1, y: (y0 + y1) / 2, style: `${(lw * scale).toFixed(2)}|${color}|${dash}`, lw: lw * scale })
      } else if (h <= 3.5 && isFill.has(paint) && !isStroke.has(paint)) {
        // линия, нарисованная узким закрашенным прямоугольником
        lines.push({ x0, x1, y: (y0 + y1) / 2, style: `${h.toFixed(2)}|f|`, lw: h })
      } else if (h >= 8) rects.push({ x0, y0, x1, y1 })
    }
  }
  return { texts, lines, rects }
}

export async function readPdfPages(file) {
  const pdfjs = await loadPdfjs()
  const data = new Uint8Array(await file.arrayBuffer())
  const doc = await pdfjs.getDocument({ data }).promise
  try {
    const pages = []
    for (let p = 1; p <= doc.numPages; p++) pages.push(await pageGeometry(await doc.getPage(p), pdfjs.OPS))
    return pages
  } finally {
    doc.destroy?.()
  }
}

// ---------- Разбор страниц SketchCut ----------

const HEAD = {
  num: /^(#|№|n)$/i,
  length: /^(длина|length)$/i,
  width: /^(ширина|width)$/i,
  qty: /^(кол-?во|количество|qty|quantity|count)$/i,
  rot: /^(поворот|rotat\w*|turn)$/i,
  name: /^(наименование|название|name|description)$/i,
}

// Шапка таблицы «Детали» на странице -> { y, cols: { length: [x0, x1], ... } } или null
function findHeader(pg) {
  for (const t of pg.texts) {
    if (!HEAD.length.test(t.str)) continue
    const row = pg.texts.filter(o => Math.abs(o.y - t.y) < 3)
    const pick = re => row.find(o => re.test(o.str))
    const found = { length: t, width: pick(HEAD.width), qty: pick(HEAD.qty), rot: pick(HEAD.rot), name: pick(HEAD.name) }
    // у маленькой таблицы «Детали на листе» (на картах раскроя) нет ни поворота, ни названия — её не берём
    if (!found.width || !(found.rot || found.name)) continue
    const cols = {}
    const centers = Object.entries(found).filter(([, o]) => o).map(([k, o]) => [k, o.x + o.w / 2]).sort((a, b) => a[1] - b[1])
    centers.forEach(([k, cx], i) => {
      const o = found[k], cy = o.y - o.h / 2
      // ячейка шапки — самый маленький прямоугольник вокруг надписи
      const cell = pg.rects
        .filter(r => r.x0 <= cx && cx <= r.x1 && r.y0 - 1 <= cy && cy <= r.y1 + 1 && r.y1 - r.y0 < 60)
        .sort((p, q) => (p.x1 - p.x0) - (q.x1 - q.x0))[0]
      if (cell) cols[k] = [cell.x0, cell.x1]
      else {
        const prev = centers[i - 1]?.[1], next = centers[i + 1]?.[1]
        cols[k] = [prev != null ? (prev + cx) / 2 : cx - 40, next != null ? (cx + next) / 2 : cx + 200]
      }
    })
    const bottom = Math.max(...pg.rects.filter(r => Math.abs(r.x0 - cols.length[0]) < 1.5 && r.y0 - 1 <= t.y && t.y <= r.y1 + 3).map(r => r.y1), t.y + 2)
    return { y: bottom, cols }
  }
  return null
}

// Строки таблицы: ячейки колонки «Длина» ниже шапки -> [[y0, y1], ...]
function rowBands(pg, cols, fromY) {
  const [cx0, cx1] = cols.length
  const seen = new Set(), bands = []
  for (const r of pg.rects) {
    if (Math.abs(r.x0 - cx0) > 1.5 || Math.abs(r.x1 - cx1) > 1.5) continue
    const h = r.y1 - r.y0
    if (r.y0 < fromY - 1 || h < 8 || h > 80) continue
    const key = Math.round(r.y0)
    if (seen.has(key)) continue
    seen.add(key); bands.push([r.y0, r.y1])
  }
  return bands.sort((a, b) => a[0] - b[0])
}

// Чёрточки под размером в ячейке -> [стиль линии, ...] (не больше двух, сверху вниз)
function underlines(pg, [x0, x1], [y0, y1]) {
  const out = []
  const sorted = pg.lines
    .filter(l => (l.x0 + l.x1) / 2 > x0 && (l.x0 + l.x1) / 2 < x1 && l.x0 >= x0 - 1 && l.x1 <= x1 + 1)
    .filter(l => l.y > y0 + 1.2 && l.y < y1 - 1.2)             // не границы ячейки
    .filter(l => l.x1 - l.x0 >= (x1 - x0) * 0.25)
    .sort((a, b) => a.y - b.y)
  for (const l of sorted) {
    if (out.length && Math.abs(out[out.length - 1].y - l.y) < 0.8) continue   // та же линия, нарисованная дважды
    out.push(l)
  }
  return out.slice(0, 2).map(l => l.style)
}

function cellText(pg, [x0, x1], [y0, y1]) {
  return pg.texts
    .filter(t => { const cx = t.x + t.w / 2, cy = t.y - t.h * 0.35; return cx > x0 && cx < x1 && cy > y0 && cy < y1 })
    .sort((a, b) => (Math.abs(a.y - b.y) > 3 ? a.y - b.y : a.x - b.x))
    .map(t => t.str).join(' ').trim()
}

// Значение в шапке страницы: «Материал: ЛДСП белый      Толщина: 16»
function headerValue(pg, labelRe, stopRe) {
  const lab = pg.texts.find(t => labelRe.test(t.str))
  if (!lab) return ''
  const tail = lab.str.replace(labelRe, '').trim()
  const row = pg.texts.filter(t => t !== lab && Math.abs(t.y - lab.y) < 3 && t.x > lab.x).sort((a, b) => a.x - b.x)
  const parts = tail ? [tail] : []
  for (const t of row) {
    if (stopRe.test(t.str) || /:$/.test(t.str)) break
    parts.push(t.str)
  }
  return parts.join(' ').trim()
}

// Виды кромки и их метраж со страницы «Результаты»
function readEdgeTypes(pages) {
  const types = []
  for (const pg of pages) {
    for (const t of pg.texts) {
      const m = t.str.match(/^(?:Тип|Type)\s*(\d+)\s*:\s*(.*)$/i)
      if (!m || !m[2].trim()) continue
      const raw = m[2].trim()
      if (types.some(x => x.raw === raw)) continue
      let meters = null
      const lab = pg.texts.find(o => o.str === `Длина ${raw}` || o.str === `Length ${raw}`)
      if (lab) {
        const val = pg.texts
          .filter(o => o !== lab && Math.abs(o.y - lab.y) < 3 && o.x > lab.x)
          .sort((a, b) => a.x - b.x)
          .map(o => o.str.match(/^(\d+(?:[.,]\d+)?)\s*(?:м|m)\.?$/i)).find(Boolean)
        if (val) meters = parseFloat(val[1].replace(',', '.'))
      }
      types.push({ n: Number(m[1]), raw, name: edgeName(raw), thick: edgeThick(raw), meters })
    }
    if (types.length) break
  }
  return types.sort((a, b) => a.n - b.n)
}

function permutations(arr, k) {
  if (k === 0) return [[]]
  const out = []
  arr.forEach((x, i) => {
    for (const rest of permutations(arr.filter((_, j) => j !== i), k - 1)) out.push([x, ...rest])
  })
  return out
}

// Какой линией нарисован какой вид кромки: подбираем так, чтобы метраж совпал с указанным в файле
function matchStyles(rows, types) {
  const meters = {}                                              // стиль -> метры
  for (const r of rows) {
    for (const s of r.lenLines) meters[s] = (meters[s] || 0) + r.w * r.qty / 1000
    for (const s of r.widLines) meters[s] = (meters[s] || 0) + r.h * r.qty / 1000
  }
  const styles = Object.keys(meters)
  const total = styles.reduce((s, k) => s + meters[k], 0)
  const map = {}
  if (!styles.length) return { map, total, checked: false, ok: true, fileTotal: null }
  const known = types.filter(t => t.meters != null)
  const fileTotal = known.length ? known.reduce((s, t) => s + t.meters, 0) : null
  const close = (a, b) => Math.abs(a - b) <= 0.011 + b * 0.001   // в файле метраж округлён до сотых

  if (!types.length) {
    styles.forEach(s => { map[s] = 'default' })
    return { map, total, checked: false, ok: true, fileTotal }
  }
  if (types.length >= styles.length && styles.length <= 5 && known.length === types.length) {
    for (const perm of permutations(types, styles.length)) {
      const rest = types.filter(t => !perm.includes(t))
      if (perm.every((t, i) => close(meters[styles[i]], t.meters)) && rest.every(t => t.meters < 0.011)) {
        perm.forEach((t, i) => { map[styles[i]] = t.name })
        return { map, total, checked: true, ok: true, fileTotal }
      }
    }
  }
  // Не сошлось (или метража в файле нет): толще линия — толще кромка
  const byLine = [...styles].sort((a, b) => parseFloat(b) - parseFloat(a))
  const used = known.some(t => t.meters > 0) ? types.filter(t => !(t.meters < 0.011)) : types
  const byThick = [...(used.length ? used : types)].sort((a, b) => (b.thick ?? -1) - (a.thick ?? -1) || a.n - b.n)
  byLine.forEach((s, i) => { map[s] = byThick[Math.min(i, byThick.length - 1)].name })
  return { map, total, checked: fileTotal != null, ok: fileTotal == null ? true : close(total, fileTotal), fileTotal }
}

export function looksLikeSketchCut(pages) {
  return pages.some(pg => pg.texts.some(t => /sketchcut/i.test(t.str)))
}

// pages (из readPdfPages) -> { orderName, items, groups, skipped, scene: null, pdf: {...} }
export function parseSketchCut(pages) {
  const rows = []
  let cols = null, skipped = 0, material = '', thickness = null, orderName = ''
  for (const pg of pages) {
    const head = findHeader(pg)
    let fromY = 0
    if (head) { cols = head.cols; fromY = head.y }
    // продолжение таблицы на следующей странице может идти без шапки; карты раскроя — не таблица деталей
    else if (!cols || pg.texts.some(t => /детали на листе|parts on sheet/i.test(t.str))) continue

    if (!material) material = headerValue(pg, /^(Материал|Material)\s*:/i, /^(Толщина|Thickness)/i)
    if (!thickness) { const t = num(headerValue(pg, /^(Толщина|Thickness)\s*:/i, /^$/)); if (t > 0) thickness = t }
    if (!orderName) orderName = headerValue(pg, /^(Заказ|Order)\s*:/i, /^(Дата|Date)/i)

    for (const band of rowBands(pg, cols, fromY)) {
      const lenTxt = cellText(pg, cols.length, band), widTxt = cellText(pg, cols.width, band)
      if (!lenTxt && !widTxt) continue
      const w = Math.round(num(lenTxt)), h = Math.round(num(widTxt))
      if (!(w > 0) || !(h > 0)) { skipped++; continue }
      let qty = cols.qty ? Math.round(num(cellText(pg, cols.qty, band))) : 1
      if (!(qty > 0)) qty = 1
      const rot = cols.rot ? low(cellText(pg, cols.rot, band)) : ''
      rows.push({
        w, h, qty,
        name: cols.name ? cellText(pg, cols.name, band).slice(0, 80) : '',
        rotatable: /^(да|yes|\+|y)$/.test(rot),
        lenLines: underlines(pg, cols.length, band),
        widLines: underlines(pg, cols.width, band),
      })
    }
  }
  if (!cols) throw new Error('в PDF не нашлась таблица «Детали» (нужен PDF, сохранённый из SketchCut)')
  if (!rows.length) throw new Error('в таблице «Детали» нет строк с размерами')

  const types = readEdgeTypes(pages)
  const match = matchStyles(rows, types)
  const groupKey = `${material}|${thickness ?? ''}`
  const items = rows.map(r => ({
    name: r.name, w: r.w, h: r.h, qty: r.qty, prefix: '', rotatable: r.rotatable,
    material, thickness, groupKey,
    // одна чёрточка под длиной — Дл, две — Дл и Дп; под шириной — Шв, затем Шн
    edges: {
      left: r.lenLines[0] ? match.map[r.lenLines[0]] || 'default' : null,
      right: r.lenLines[1] ? match.map[r.lenLines[1]] || 'default' : null,
      top: r.widLines[0] ? match.map[r.widLines[0]] || 'default' : null,
      bottom: r.widLines[1] ? match.map[r.widLines[1]] || 'default' : null,
    },
  }))
  const pieces = items.reduce((s, it) => s + it.qty, 0)

  // сколько деталей должно быть по самому файлу («Количество деталей: 20»)
  let filePieces = null
  for (const pg of pages) {
    const lab = pg.texts.find(t => /^(Количество деталей|Number of parts)\s*:?$/i.test(t.str))
    if (!lab) continue
    const v = pg.texts.filter(o => o !== lab && Math.abs(o.y - lab.y) < 3 && o.x > lab.x).sort((a, b) => a.x - b.x).map(o => num(o.str)).find(n => n >= 0)
    if (v != null && !Number.isNaN(v)) { filePieces = v; break }
  }

  const usedNames = new Set(items.flatMap(it => Object.values(it.edges)).filter(v => v && v !== 'default'))
  const edgeTypes = {}
  for (const t of types) if (usedNames.has(t.name) && t.thick > 0) edgeTypes[t.name] = { t: t.thick, trim: false, joint: 0 }

  return {
    orderName, scene: null, skipped, items,
    groups: [{ key: groupKey, material, thickness, count: items.length, pieces }],
    edgeTypes,
    pdf: {
      pieces, filePieces,
      edgeMeters: Math.round(match.total * 100) / 100, fileEdgeMeters: match.fileTotal,
      edgeChecked: match.checked, edgeOk: match.ok,
      edgeTypes: types.map(t => ({ name: t.name, meters: t.meters })),
    },
  }
}

export async function readSketchCutPdf(file) {
  const pages = await readPdfPages(file)
  if (!pages.some(pg => pg.texts.length)) throw new Error('в этом PDF нет текста — похоже, это скан или фотография. Нужен PDF, сохранённый прямо из программы')
  return parseSketchCut(pages)
}
