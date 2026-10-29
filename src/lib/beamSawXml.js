// β Пильный центр: программа для пилы KDT — XML с деревом резов.
//   <panelN l w trimS/E… saw material thickness mcode texture>  — лист
//     <no.K l w trim x y layer id>                                  — заготовка (узел дерева резов)
//       <part cut type id code />  type 1 — деталь, 2 — полоса (режется дальше), 3 — деловой обрезок
//   l — длина, вдоль которой идут резы этого узла, w — поперёк; trim — торцовка в начале; cut — размер куска.
//   Каждый кусок (деталь, полоса, обрезок) — ещё и свой узел no.K с id = id куска; узлы — в глубину, соседи с конца.
//   В конце — таблица деталей для бирок (<table name="label">).
// Дерево резов строится по ТЕКУЩЕЙ карте (после ручных правок тоже): сквозные резы, оси по уровням чередуются.
import { orderTitle, toLatin } from './orderUtils'

const EPS = 0.5
const r1 = v => +(+v).toFixed(1)
const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// ── дерево резов по карте ────────────────────────────────────────────────
// items — куски в координатах рабочей зоны (Y сверху вниз), размеры с пропилом справа/снизу (как p.w/p.h у деталей).
// Регион: по оси axis длина A, поперёк B (тоже с пропилом). Куски группируются в слоты сквозными резами поперёк оси.
export function derive(items, axis, ox, oy, A, B, depth = 1) {
  if (depth > 40) throw new Error('карта не раскладывается на сквозные резы')
  const st = it => (axis === 'x' ? it.x : it.y), ln = it => (axis === 'x' ? it.w : it.h)
  const ac = it => (axis === 'x' ? it.h : it.w), as = it => (axis === 'x' ? it.y : it.x)
  const start = axis === 'x' ? ox : oy, across0 = axis === 'x' ? oy : ox
  const list = [...items].sort((a, b) => st(a) - st(b))
  const groups = []
  for (const it of list) {
    const g = groups[groups.length - 1]
    if (g && st(it) < g.end - EPS) { g.items.push(it); g.end = Math.max(g.end, st(it) + ln(it)) }
    else groups.push({ s: st(it), end: st(it) + ln(it), items: [it] })
  }
  if (groups.length === 1 && groups[0].items.length > 1 && depth > 1) {
    // все куски перекрываются по этой оси — сквозного реза нет; пробуем поперёк (лишний уровень)
    const other = axis === 'x' ? 'y' : 'x'
    const g = groups[0]
    const tryOther = deriveGroups(g.items, other)
    if (tryOther.length === 1) throw new Error('карта не раскладывается на сквозные резы')
  }
  const node = { axis, A, B, x: ox, y: oy, trim: groups.length ? groups[0].s - start : 0, slots: [] }
  groups.forEach((g, i) => {
    const next = groups[i + 1]
    const a = (next ? next.s : g.end) - g.s     // промежуток до следующего слота — в этот слот (уйдёт в его остаток)
    const sx = axis === 'x' ? g.s : ox, sy = axis === 'x' ? oy : g.s
    const one = g.items.length === 1 ? g.items[0] : null
    if (one && Math.abs(ln(one) - a) < EPS && Math.abs(ac(one) - B) < EPS && Math.abs(as(one) - across0) < EPS) node.slots.push({ a, item: one })
    else node.slots.push({ a, child: derive(g.items, axis === 'x' ? 'y' : 'x', sx, sy, B, a, depth + 1) })
  })
  return node
}
function deriveGroups(items, axis) {
  const st = it => (axis === 'x' ? it.x : it.y), ln = it => (axis === 'x' ? it.w : it.h)
  const out = []
  for (const it of [...items].sort((a, b) => st(a) - st(b))) {
    const g = out[out.length - 1]
    if (g && st(it) < g.end - EPS) g.end = Math.max(g.end, st(it) + ln(it))
    else out.push({ end: st(it) + ln(it) })
  }
  return out
}
/** Последний кусок заготовки — деловой обрезок до самого её конца (за ним ни деталей, ни реза) */
export function tailOffcut(node) {
  const last = node.slots[node.slots.length - 1]
  if (!last?.item?.offcut || node.slots.length < 2) return false
  const end = node.trim + node.slots.reduce((t, sl) => t + sl.a, 0)
  return end >= node.A - EPS
}
export const depthOf = n => 1 + Math.max(0, ...n.slots.map(s => (s.child ? depthOf(s.child) : 0)))

/** Дерево резов листа: ось 1-го уровня — как посчитал раскрой (sheet.beamAxis), иначе та, где уровней меньше */
export function sheetCutTree(sheet, geo) {
  const k = geo.kerf, X = geo.usableX + k, Y = geo.usableY + k
  const parts = (sheet.placed || []).map(p => ({ x: p.x, y: p.y, w: p.w, h: p.h, part: p }))
  const offs = []
  for (const o of sheet.manualOffcuts || []) {
    // обрезок — в тех же координатах, что детали; может заходить в отступ — берём его часть в рабочей зоне, с пропилом как у детали
    const y = o.y
    const x0 = Math.max(0, o.x), y0 = Math.max(0, y), x1 = Math.min(geo.usableX, o.x + o.w), y1 = Math.min(geo.usableY, y + o.h)
    if (x1 - x0 > EPS && y1 - y0 > EPS) offs.push({ x: x0, y: y0, w: x1 - x0 + k, h: y1 - y0 + k, offcut: true, ow: o.w, oh: o.h })
  }
  const axes = sheet.beamAxis ? [sheet.beamAxis, sheet.beamAxis === 'x' ? 'y' : 'x'] : ['x', 'y']
  const tryTree = items => {
    let best = null
    for (const ax of axes) {
      try {
        const t = derive(items, ax, 0, 0, ax === 'x' ? X : Y, ax === 'x' ? Y : X)
        if (!best || depthOf(t) < depthOf(best)) best = t
        if (sheet.beamAxis) break
      } catch { /* другая ось */ }
    }
    return best
  }
  let best = tryTree([...parts, ...offs])
  if (best) return best
  // Деловой обрезок, отмеченный вручную («Вручную» на карте), может лечь поперёк реза — тогда его не вырезать насквозь.
  // Программа собирается без таких обрезков (они остаются просто остатком листа), остальные — как были
  if (!tryTree(parts)) throw new Error('карта не раскладывается на сквозные резы — детали сдвинуты вручную так, что их не разрезать пилой насквозь; пересчитайте раскрой или верните детали в ряд')
  const kept = []
  for (const o of offs) if (tryTree([...parts, ...kept, o])) kept.push(o)
  best = tryTree([...parts, ...kept])
  best.droppedOffcuts = offs.length - kept.length
  return best
}

/**
 * Резы листа пильного центра — ровно как в программе для станка (то же дерево резов): длина (мм) и число.
 * Входит всё, что пила реально режет: опил (обрезка кромок листа и торцовка заготовок на уровнях 3+), резы между
 * кусками, рез, отделяющий деловой обрезок (сам обрезок не торцуется), и подрезка узких деталей (пилятся с запасом,
 * потом подрезаются до размера — trimTo). Рез идёт поперёк заготовки, на всю её ширину.
 * -> { len, cuts, trimLen, trimCuts } | null (карту нельзя разрезать насквозь — тогда статистика считает как раньше)
 */
export function beamSheetCuts(sheet, geo) {
  let tree
  try { tree = sheetCutTree(sheet, geo) } catch { return null }
  const k = geo.kerf
  const res = { len: 0, cuts: 0, trimLen: 0, trimCuts: 0 }
  const add = (l, trim) => { res.len += l; res.cuts++; if (trim) { res.trimLen += l; res.trimCuts++ } }
  const sheetLen = ax => (ax === 'x' ? geo.sheetW : geo.sheetL)
  const startMargin = ax => (ax === 'x' ? geo.marginL : geo.marginT)
  const endMargin = ax => (ax === 'x' ? geo.marginR : geo.marginB)
  const walk = (node, layer, wReal) => {
    // торцовка / обрезка кромки в начале заготовки (1-й и 2-й уровни — от края листа: отступ листа + свой зазор)
    const trim = layer <= 2 ? startMargin(node.axis) + node.trim : node.trim
    if (trim > EPS) add(wReal, true)
    const tail = tailOffcut(node) ? node.slots[node.slots.length - 1] : null
    let pos = node.trim
    const slots = node.slots.filter(sl => sl !== tail)
    for (const sl of slots) {
      pos += sl.a
      // рез после куска; последний — только если дальше что-то остаётся (обрезок, отход)
      if (node.A - pos > EPS || tail) add(wReal, false)
      if (sl.child) walk(sl.child, layer + 1, sl.a - k)
    }
    // куски дошли до конца заготовки 1-го/2-го уровня — край листа обрезается (опил в конце)
    if (!tail && layer <= 2 && node.A - pos <= EPS && endMargin(node.axis) > EPS) add(wReal, true)
  }
  walk(tree, 1, sheetLen(tree.axis === 'x' ? 'y' : 'x'))
  // подрезка узких деталей: один рез вдоль детали
  for (const p of sheet.placed || []) {
    const t = p.trimTo
    if (!t) continue
    const W = Number(p.origX) || 0, H = Number(p.origY) || 0
    add(Math.max(W, H), true)
  }
  return res
}

// ── XML ───────────────────────────────────────────────────────────────────
const stamp = d => [d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()].map(v => String(v).padStart(2, '0')).join('')
const edgeStr = e => (e ? (typeof e === 'object' ? String(e.name || e.type || 'кромка') : e === true ? 'кромка' : String(e)) : '')   // в заказе кромка — да/нет по стороне

/**
 * XML программы для KDT по сохранённому раскрою одного материала.
 * mat — { name, thickness, result, sheets, details }, geoOf(sheet) — геометрия листа (sheetGeo), order — заказ.
 * -> { text, fileName, panels, parts }
 */
export function buildBeamSawXml({ order, mat, geoOf, date = new Date() }) {
  const ts = stamp(date)
  const material = mat.name || order?.material_name || ''
  const thick = mat.thickness || order?.material_thickness || 16
  const texture = (mat.details || []).some(d => !d.rotatable)
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<project>']
  const rows = [], offRows = []      // детали и деловые обрезки с их кодами — для бирок (код = имя файла бирки)
  let code = 0, oc = 0, dropped = 0
  // максимальная ширина полосы (настройка пильного центра): раскрой её соблюдает; если карту правили вручную
  // (сдвинули детали, отметили обрезки) и полоса вышла шире — программа собирается, но с предупреждением
  const maxStrip = Number(mat.result?.beamSettings?.maxStrip) || 0
  const wide = []
  mat.sheets.forEach((sheet, si) => {
    const geo = geoOf(sheet)
    const k = geo.kerf
    let tree
    try { tree = sheetCutTree(sheet, geo) } catch (e) { throw new Error(`лист ${si + 1}: ${e?.message || e}`, { cause: e }) }
    dropped += tree.droppedOffcuts || 0
    if (maxStrip > 0) for (const sl of tree.slots || []) if (!sl.item?.offcut && sl.a - k > maxStrip + 0.5) wide.push(`лист ${si + 1}: полоса ${Math.round(sl.a - k)} мм`)
    const mcode = `T${ts}${si + 1}`
    // деловой обрезок в конце листа (1-й уровень) — край листа у него не торцуется: торцовка в конце = 0
    const endOff = tailOffcut(tree)
    const trimEL = endOff && tree.axis === 'y' ? 0 : geo.marginB, trimEW = endOff && tree.axis === 'x' ? 0 : geo.marginR
    out.push(`  <panel${si + 1} l="${r1(geo.sheetL)}" w="${r1(geo.sheetW)}" trimSLength="${r1(geo.marginT)}" trimSWidth="${r1(geo.marginL)}" trimELength="${r1(trimEL)}" trimEWidth="${r1(trimEW)}" num="1" material="${esc(material)}" thickness="${r1(thick)}" saw="${r1(k)}" mcode="${mcode}" texture="${texture ? 'True' : 'False'}">`)
    // узлы: номер no.K по порядку вывода, id узла = id куска в родителе (у листа 0)
    let no = 0, nextId = 0
    const lines = []
    // реальные размеры узла: 1-й и 2-й уровни — от края до края листа (с отступами), глубже — размер куска
    const sheetLen = ax => (ax === 'x' ? geo.sheetW : geo.sheetL)
    const startMargin = ax => (ax === 'x' ? geo.marginL : geo.marginT)
    const emit = (node, id, layer, lReal, wReal) => {
      no++
      const ax = node.axis
      const trim = layer <= 2 ? startMargin(ax) + node.trim : node.trim
      // координаты: y — вдоль оси 1-го уровня, x — поперёк, от угла листа
      const sx = geo.marginL + node.x, sy = geo.marginT + node.y
      const [cy, cx] = tree.axis === 'x' ? [sx, sy] : [sy, sx]
      // 2-й уровень: полоса идёт от края листа — по своей оси от 0
      const head = `    <no.${no} l="${r1(lReal)}" w="${r1(wReal)}" trim="${r1(trim)}" x="${r1(layer <= 2 ? 0 : cx)}" y="${r1(layer === 1 ? 0 : cy)}" layer="${layer}" id="${id}"`
      const kids = []
      // деловой обрезок в конце заготовки — это её остаток: его не отпиливаем (лишний рез и опил края не нужны),
      // бирка обрезка остаётся (offRows)
      const tail = tailOffcut(node) ? node.slots[node.slots.length - 1] : null
      if (tail) {
        oc++
        offRows.push({ code: `OC${oc}`, si, w: Math.round(tail.item.ow ?? tail.item.w - k), h: Math.round(tail.item.oh ?? tail.item.h - k) })
      }
      const partLines = node.slots.filter(sl => sl !== tail).map(sl => {
        const cut = sl.a - k
        const myId = ++nextId
        if (sl.item?.part) {
          code++
          const p = sl.item.part
          rows.push({ code, p, si, mcode })
          kids.push({ leaf: true, id: myId, l: wReal, w: cut, layer: layer + 1, sl })
          return `      <part cut="${r1(cut)}" type="1" id="${myId}" code="${code}" print_code="" />`
        }
        if (sl.item?.offcut) {
          oc++
          offRows.push({ code: `OC${oc}`, si, w: Math.round(sl.item.ow ?? sl.item.w - k), h: Math.round(sl.item.oh ?? sl.item.h - k) })
          kids.push({ leaf: true, id: myId, l: wReal, w: cut, layer: layer + 1, sl })
          return `      <part cut="${r1(cut)}" type="3" id="${myId}" code="OC${oc}" print_code="" />`
        }
        kids.push({ leaf: false, id: myId, l: wReal, w: cut, layer: layer + 1, sl })
        return `      <part cut="${r1(cut)}" type="2" id="${myId}" code="" print_code="" />`
      })
      lines.push(partLines.length ? `${head}>` : `${head} />`)
      if (partLines.length) { lines.push(...partLines); lines.push(`    </no.${no}>`) }
      // соседи — с конца, в глубину
      for (const c of kids.slice().reverse()) {
        if (c.leaf) {
          no++
          const it = c.sl.item
          const px = geo.marginL + it.x, py = geo.marginT + it.y
          const [ly, lx] = tree.axis === 'x' ? [px, py] : [py, px]
          lines.push(`    <no.${no} l="${r1(c.l)}" w="${r1(c.w)}" trim="0" x="${r1(lx)}" y="${r1(ly)}" layer="${c.layer}" id="${c.id}" />`)
        } else emit(c.sl.child, c.id, c.layer, c.l, c.w)
      }
    }
    const rootL = sheetLen(tree.axis), rootW = sheetLen(tree.axis === 'x' ? 'y' : 'x')
    emit(tree, 0, 1, rootL, rootW)
    out.push(...lines)
    out.push(`  </panel${si + 1}>`)
  })
  // таблица деталей для бирок
  const COLS = ['Выбор', 'Наименование материала', 'Толщ.', 'Наименование детали', 'Длина', 'Ширина', 'Кол.', 'Текстура', 'Кромка', 'Штрих код', 'Припуск', 'Заказ', 'Примечание', 'Информация о детали',
    'Табл.сопост.кромка лев.', 'Табл.сопост.кромка прав', 'Табл.сопост.кромка верх', 'Табл.сопост.кромка низ', 'паз верх', 'паз низ', 'паз лево', 'паз право',
    'длина пильны', 'ширина пильный', 'длина готовая', 'ширина готовая', 'Наименование файла', 'Номер готовой детали', '№ карты', 'Общ.№ карты', 'Поворот', 'Текущее значение']
  out.push(`  <table name="label" lenghtIndex="4" widthIndex="5" textureIndex="7" materialIndex="1" thicknessIndex="2" quantityIndex="6" codeIndex="9" edgeIndex="8" ${COLS.map((c, i) => `columns${i + 1}="${esc(c)}"`).join(' ')}>`)
  const title = orderTitle(order)
  const fileTitle = `${title} ${material}`.trim()
  for (const { code: c, p, si } of rows) {
    const d = (mat.details || [])[p.detailIndex] || {}
    const L = r1(p.trimTo ? p.trimTo.length : d.length ?? p.origY), W = r1(p.trimTo ? p.trimTo.width : d.width ?? p.origX)
    const sawL = r1(p.rotated ? p.origX : p.origY), sawW = r1(p.rotated ? p.origY : p.origX)
    const edges = [d.edge_left, d.edge_right, d.edge_top, d.edge_bottom].map(edgeStr)
    const v = ['True', material, r1(thick), d.display_name || d.name || p.label || '', sawL, sawW, 1, d.rotatable === false ? '1(T_L)' : 'Без текстуры(T_N)',
      edges.join('|'), '', '0|0|0|0', title, p.trimTo ? `УПЛ ${Math.min(p.trimTo.width, p.trimTo.length)}` : (d.note || ''), d.prefix || d.position || '',
      ...edges, '', '', '', '', sawL, sawW, L, W, fileTitle, c, si + 1, si + 1, p.rotated ? 'true' : 'false', 1]
    out.push(`    <row code="${c}" ${v.map((x, i) => `columns${i + 1}="${esc(x)}"`).join(' ')} />`)
  }
  // деловые остатки — тоже строками таблицы: без строки у станка нет команды печатать бирку (файл OC*.emf лежит, но не печатается)
  for (const { code: c, si, w, h } of offRows) {
    const v = ['True', material, r1(thick), 'Деловой остаток', r1(h), r1(w), 1, 'Без текстуры(T_N)', '|||', '', '0|0|0|0', title, 'Деловой остаток', '',
      '', '', '', '', '', '', '', '', r1(h), r1(w), r1(h), r1(w), fileTitle, c, si + 1, si + 1, 'false', 1]
    out.push(`    <row code="${c}" ${v.map((x, i) => `columns${i + 1}="${esc(x)}"`).join(' ')} />`)
  }
  out.push('  </table>', '</project>', '')
  const base = toLatin(`${title}_${material}_${thick}`).replace(/[^\w.-]+/g, '_').replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '') || 'beamsaw'
  return { text: out.join('\r\n'), fileName: `${base}.xml`, panels: mat.sheets.length, parts: rows.length, rows, offRows, droppedOffcuts: dropped, wideStrips: wide, maxStrip }
}

/** Сохранить XML: на телефоне — «Поделиться», иначе скачать */
export async function saveBeamSawXml(args) {
  const { text, fileName } = buildBeamSawXml(args)
  const file = new File(['﻿' + text], fileName, { type: 'application/xml' })
  let can
  try { can = !!navigator.share && !!navigator.canShare && navigator.canShare({ files: [file] }) } catch { can = false }
  const phone = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches
  if (can && phone) { try { await navigator.share({ files: [file], title: fileName }); return { ok: true } } catch (e) { if (e?.name === 'AbortError') return { ok: false } } }
  const url = URL.createObjectURL(file)
  const a = document.createElement('a'); a.href = url; a.download = file.name
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
  return { ok: true }
}
