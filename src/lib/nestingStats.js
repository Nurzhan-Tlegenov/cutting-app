// Статистика раскроя: всё, что можно сложить и посчитать по готовым картам — листы, детали, длина и число резов,
// периметр деталей, кромка (прямая / толстая / криволинейная), отверстия, пазы, выемки, вырезы.
// По ней производство считает стоимость (pricing.js), она же выводится в кабинете производства и в PDF.
// Модуль без React.
import { sheetGeo } from './savedNesting.js'
import { partFeatures } from './gcode.js'
import { detailEdgeList } from './edgeLength.js'
import { rawDetail, overMm, parseEdgeTypes } from './edgeCut.js'
import { decomposeCuts } from './cutLines.js'
import { beamSheetCuts } from './beamSawXml.js'

const loopLen = pts => { let l = 0; for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; l += Math.hypot(b[0] - a[0], b[1] - a[1]) } return l }
const loopArea = pts => { let s = 0; for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; s += a[0] * b[1] - b[0] * a[1] } return Math.abs(s) / 2 }
const r2 = v => Math.round(v * 100) / 100
const THICK_FROM = 1          // кромка толще 1 мм считается «толстой» (обычно 2 мм), до 1 мм — «тонкой» (0,4–1 мм)

export const emptyStats = () => ({
  sheets: [], sheetCount: 0, offcutSheets: 0, parts: 0, kerf: 0, method: 'nesting',
  cutM: 0, cuts: 0, perimM: 0, partsM2: 0, sheetsM2: 0,
  trimM: 0, trimCuts: 0,
  offcutSizes: {},   // деловые остатки: { 'длина×ширина': шт } (обрезки, отмеченные на картах)   // пильный центр: опил (обрезка кромок листа, торцовка, подрезка узких) — уже входит в cutM / cuts
  edgeM: 0, edgeThinM: 0, edgeThickM: 0, edgeCurvedM: 0, edgeCurvedParts: 0,
  edgeByType: {},   // кромка по видам заказа: { название: м } (виды — из Excel или из бланка заказа; толщина — edgeTypeT)
  edgeTypeT: {},
  holes: 0, edgeHoles: 0, grooves: 0, grooveM: 0, pockets: 0, cutouts: 0, shapedParts: 0,
  drillM2: 0, drillParts: 0,   // детали с присадкой (отверстия в пласть, с изнанки, в торец): их площадь — для цены «присадка за м²»
  hdf: false,   // материал заказа — ХДФ / ДВП: распил в прайс-листе по своим ценам
})

/**
 * mat — { sheets, details, result, thickness } (как у savedNestings или вариант раскроя на экране).
 * method — 'nesting' (фрезер ЧПУ: режется контур каждой детали) | 'guillotine' (форматно-раскроечный: сквозные резы).
 */
export function nestingStats({ order, mat, method }) {
  const st = emptyStats()
  if (!mat) return st
  st.method = method === 'guillotine' ? 'guillotine' : 'nesting'
  st.hdf = order?.material_kind === 'hdf'
  const details = mat.details || []
  const T = Number(mat.thickness) || Number(order?.material_thickness) || 16
  const types = parseEdgeTypes(order?.edge_types)
  const over = overMm(types)
  const thickOf = name => Number(String((types[name === 'Кромка' ? 'default' : name] || {}).t ?? '').replace(',', '.')) || 0
  for (const sh of mat.sheets || []) {
    if (!sh?.placed?.length) continue
    const geo = sheetGeo(order, mat.result, sh)
    st.kerf = geo.kerf || st.kerf
    const row = { parts: sh.placed.length, cutM: 0, cuts: 0, perimM: 0, offcut: sh.stock === 'offcut', usedPct: 0 }
    let used = 0, contourM = 0, contours = 0
    for (const p of sh.placed) {
      const d = details[p.detailIndex]
      const f = partFeatures(p, d, T)
      const per = loopLen(f.outline)
      row.perimM += per / 1000; used += loopArea(f.outline)
      contourM += per / 1000; contours++
      for (const c of f.cutouts) { contourM += (c.circle ? 2 * Math.PI * c.circle.r : loopLen(c.pts)) / 1000; contours++; st.cutouts++ }
      if (Array.isArray(p.polygon) && p.polygon.length > 2 && !(f.outline.length === 4 && Math.abs(loopArea(f.outline) - p.origX * p.origY) < 1)) st.shapedParts++
      st.holes += f.holes.length; st.edgeHoles += f.skipped.edge
      if (f.holes.length || f.skipped.edge || f.skipped.back) { st.drillM2 += loopArea(f.outline) / 1e6; st.drillParts++ }
      st.pockets += f.pockets.length
      for (const g of f.grooves) { st.grooves++; st.grooveM += Math.max(g.x1 - g.x0, g.y1 - g.y0) / 1000 }
      // кромка этой детали
      if (d) {
        let curved = false
        for (const e of detailEdgeList(rawDetail(d))) {
          const m = (e.mm + over) / 1000
          st.edgeM += m
          st.edgeByType[e.name] = (st.edgeByType[e.name] || 0) + m
          if (thickOf(e.name) > 0) st.edgeTypeT[e.name] = thickOf(e.name)
          if (e.curved) { st.edgeCurvedM += m; curved = true }
          else if (thickOf(e.name) > THICK_FROM) st.edgeThickM += m
          else st.edgeThinM += m
        }
        if (curved) st.edgeCurvedParts++
      }
    }
    // пильный центр: резы — как в программе станка, вместе с опилом (обрезка кромок листа, торцовка) и подрезкой узких
    const beam = st.method === 'guillotine' && mat.result?.beamSaw ? beamSheetCuts(sh, geo) : null
    if (beam) {
      row.cutM = beam.len / 1000; row.cuts = beam.cuts; row.trimM = beam.trimLen / 1000
      st.trimM += row.trimM; st.trimCuts += beam.trimCuts
    } else if (st.method === 'guillotine') {
      // пила: сквозные резы по карте (берём тот порядок резов, что короче — как на экране)
      const rects = sh.placed.map(p => ({ x: p.x, y: p.y, w: Number(p.w) || p.origX + geo.kerf, h: Number(p.h) || p.origY + geo.kerf }))
      const a = decomposeCuts(rects, geo.usableX, geo.usableY, geo.kerf, 'v'), b = decomposeCuts(rects, geo.usableX, geo.usableY, geo.kerf, 'h')
      const len = r => r.lines.reduce((t, l) => t + (l.to - l.from), 0)
      const best = a.unsplit.length !== b.unsplit.length ? (a.unsplit.length < b.unsplit.length ? a : b) : (len(a) <= len(b) ? a : b)
      row.cutM = len(best) / 1000; row.cuts = best.lines.length
    } else { row.cutM = contourM; row.cuts = contours }
    for (const o of sh.manualOffcuts || []) {
      const L = Math.round(Number(o.h) || 0), W = Math.round(Number(o.w) || 0)
      if (L > 0 && W > 0) { const k = `${Math.max(L, W)}×${Math.min(L, W)}`; st.offcutSizes[k] = (st.offcutSizes[k] || 0) + 1 }
    }
    const area = geo.usableX * geo.usableY
    row.usedPct = area > 0 ? used / area * 100 : 0
    st.sheets.push(row)
    st.sheetCount++; if (row.offcut) st.offcutSheets++
    st.parts += row.parts; st.cutM += row.cutM; st.cuts += row.cuts; st.perimM += row.perimM
    st.partsM2 += used / 1e6; st.sheetsM2 += area / 1e6
  }
  return st
}

/** Сложить статистику нескольких материалов одного заказа */
export function sumStats(list) {
  const t = emptyStats()
  for (const s of list || []) {
    if (!s) continue
    for (const k of Object.keys(t)) {
      if (k === 'sheets') t.sheets.push(...s.sheets)
      else if (k === 'edgeByType') for (const [n, v] of Object.entries(s.edgeByType || {})) t.edgeByType[n] = (t.edgeByType[n] || 0) + v
      else if (k === 'edgeTypeT') Object.assign(t.edgeTypeT, s.edgeTypeT || {})
      else if (k === 'offcutSizes') for (const [n, v] of Object.entries(s.offcutSizes || {})) t.offcutSizes[n] = (t.offcutSizes[n] || 0) + v
      else if (k === 'kerf') t.kerf = t.kerf || s.kerf
      else if (k === 'method') t.method = s.method || t.method
      else if (k === 'hdf') t.hdf = t.hdf || !!s.hdf
      else t[k] += s[k] || 0
    }
  }
  return t
}

/** Статистика в том виде, в каком её ждёт база (production_quote) */
// order — чтобы передать тип изделия для цены присадки за м² (orders.drill_kind: 'large' — шкафы, крупные детали)
export function statsPayload(st, order = null) {
  return {
    sheets: st.sheets.map(s => ({ parts: s.parts })),
    parts: st.parts, cut_m: r2(st.cutM),
    edge_thin_m: r2(st.edgeThinM), edge_thick_m: r2(st.edgeThickM), edge_curved_m: r2(st.edgeCurvedM), edge_curved_parts: st.edgeCurvedParts,
    holes: st.holes, edge_holes: st.edgeHoles, drill_m2: r2(st.drillM2), drill_parts: st.drillParts, groove_m: r2(st.grooveM), pockets: st.pockets, cutouts: st.cutouts, shaped_parts: st.shapedParts,
    ...(st.hdf ? { hdf: true } : {}),
    ...(order?.drill_kind === 'large' ? { drill_kind: 'large' } : {}),   // ХДФ / ДВП — база берёт цены распила ХДФ (migration_hdf_prices.sql)
  }
}

const n2 = v => (Math.round(v * 100) / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })
/** Строки статистики для экрана и PDF: [{ key, label, value }] (нулевые необязательные строки пропускаются) */
export function statsRows(st) {
  const saw = st.method === 'guillotine'
  const rows = [
    ['sheets', 'Листов', st.sheetCount - st.offcutSheets + (st.offcutSheets ? ` + ${st.offcutSheets} обрезк.` : ''), true],
    ['parts', 'Деталей', st.parts, true],
    ['perSheet', 'Деталей на листе', st.sheets.length ? `${Math.min(...st.sheets.map(s => s.parts))}–${Math.max(...st.sheets.map(s => s.parts))}` : 0, st.sheets.length > 1],
    ['partsM2', 'Площадь деталей', `${n2(st.partsM2)} м²`, true],
    ['used', 'Использование листов', st.sheetsM2 > 0 ? `${Math.round(st.partsM2 / st.sheetsM2 * 100)} %` : '—', st.sheetsM2 > 0],
    ['kerf', saw ? 'Ширина реза (пила)' : 'Ширина реза (фреза)', `${n2(st.kerf)} мм`, st.kerf > 0],
    ['cuts', saw ? 'Количество резов' : 'Количество контуров реза', st.cuts, true],
    ['cutM', saw ? 'Длина реза' : 'Длина реза (траектория)', `${n2(st.cutM)} м`, true],   // пильный центр: опил уже входит в сумму
    ['perimM', 'Периметр всех деталей', `${n2(st.perimM)} м`, true],
    ['shaped', 'Фигурных деталей', st.shapedParts, st.shapedParts > 0],
    ['cutouts', 'Вырезов', st.cutouts, st.cutouts > 0],
    ['edgeM', 'Кромка всего', `${n2(st.edgeM)} м`, st.edgeM > 0],
    ['edgeThin', 'Кромка прямая до 1 мм', `${n2(st.edgeThinM)} м`, st.edgeThinM > 0 && (st.edgeThickM > 0 || st.edgeCurvedM > 0)],
    ['edgeThick', 'Кромка прямая толще 1 мм', `${n2(st.edgeThickM)} м`, st.edgeThickM > 0],
    ['edgeCurved', 'Кромка криволинейная', `${n2(st.edgeCurvedM)} м · ${st.edgeCurvedParts} дет.`, st.edgeCurvedM > 0],
    ['holes', 'Отверстий в пласть', st.holes, st.holes > 0],
    ['edgeHoles', 'Отверстий в торец', st.edgeHoles, st.edgeHoles > 0],
    ['drillM2', 'Площадь деталей с присадкой', `${n2(st.drillM2)} м² · ${st.drillParts} дет.`, st.drillM2 > 0],
    ['grooves', 'Пазы', `${st.grooves} шт. · ${n2(st.grooveM)} м`, st.grooves > 0],
    ['pockets', 'Выемок', st.pockets, st.pockets > 0],
    ['offcuts', 'Деловые остатки', `${Object.values(st.offcutSizes || {}).reduce((a, v) => a + v, 0)} шт`, Object.keys(st.offcutSizes || {}).length > 0],
  ]
  // кромка по видам: каждый вид — своей строкой (ключ один — галочка и порядок в конструкторе на все сразу)
  const types = Object.entries(st.edgeByType || {}).filter(([, v]) => v > 0)
  if (types.length && !(types.length === 1 && types[0][0] === 'Кромка')) {
    const at = rows.findIndex(r => r[0] === 'edgeCurved') + 1
    const fmtT = t => String(Math.round(t * 100) / 100).replace('.', ',')
    rows.splice(at, 0, ...types.sort((a, b) => b[1] - a[1]).map(([n, v]) => {
      const t = st.edgeTypeT?.[n], tl = t && !String(n).includes(fmtT(t)) ? ` · ${fmtT(t)} мм` : ''
      return ['edgeTypes', `Кромка ${n}${tl}`, `${n2(v)} м`, true]
    }))
  }
  return rows.filter(r => r[3]).map(([key, label, value]) => ({ key, label, value: String(value) }))
}
