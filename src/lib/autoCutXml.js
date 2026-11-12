// β Пильный центр HUAHUA (HP-280 и др.) с AutoCUT (King-stone) на стойке: программа — проект .CUT (XML).
// Образец со станка клиента — stol_stefanovich.CUT (AutoCUT 10.26). Наш раскрой пишется туда как готовое решение:
//   <Data> материал → <Objective> детали (Shape: X×Y, Turn — можно вращать, Count, Value — площадь, Edge «л|п|в|н»)
//          <Condition> лист (Shape: X×Y, Sx/Sy — обрезка кромок листа)
//          <Solutions><Solution><Layouts><Layout> — лист: дерево резов из вложенных <Part>:
//            узел: X Y — размер, Px Py — левый верхний угол от угла листа, Side — опил в начале узла;
//            деталь: UID — номер в <Objective>, Angle="90" — повёрнута; Spare="True" — обрезок (UID — номер в <Spares>);
//            Grouped="N" — у первого из N одинаковых соседей подряд (станок режет их пачкой).
// Дерево — то же, что у программы KDT (sheetCutTree): сквозные резы, оси по уровням чередуются.
import { orderTitle, toLatin } from './orderUtils'
import { sheetCutTree } from './beamSawXml'

const EPS = 0.5
const r1 = v => +(+v).toFixed(1)
const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const oleDate = d => +(d.getTime() / 86400000 + 25569 - d.getTimezoneOffset() / 1440).toFixed(10)   // дата Excel/OLE (как Update у AutoCUT)
const edgeStr = e => (e ? (typeof e === 'object' ? String(e.name || e.type || 'кромка') : e === true ? 'кромка' : String(e)) : '')

/**
 * Проект AutoCUT по сохранённому раскрою одного материала (листы mat.sheets — уже выбранные).
 * -> { text, fileName, panels, parts }
 */
export function buildAutoCut({ order, mat, geoOf, date = new Date() }) {
  const material = mat.name || order?.material_name || ''
  const thick = mat.thickness || order?.material_thickness || 16
  const grain = (mat.details || []).some(d => d.rotatable === false)
  const title = orderTitle(order)

  // детали: одна Shape на деталь заказа (размер — как пилится, без поворота), Count — сколько на выбранных листах
  const shapes = [], uidOf = new Map()
  const shapeOf = p => {
    if (uidOf.has(p.detailIndex)) return uidOf.get(p.detailIndex)
    const d = (mat.details || [])[p.detailIndex] || {}
    const X = r1(p.rotated ? p.origY : p.origX), Y = r1(p.rotated ? p.origX : p.origY)
    const edges = [d.edge_left, d.edge_right, d.edge_top, d.edge_bottom].map(edgeStr)
    const uid = shapes.length
    shapes.push({ name: d.display_name || d.name || `P${String(uid + 1).padStart(3, '0')}`, X, Y, turn: d.rotatable !== false, count: 0, edges,
      pos: d.prefix || d.position || '', note: d.note || '' })
    uidOf.set(p.detailIndex, uid)
    return uid
  }
  // листы разных размеров (обрезки) — свои Condition
  const conds = [], condOf = geo => {
    const k = `${r1(geo.sheetW)}x${r1(geo.sheetL)}x${r1(geo.marginL)}x${r1(geo.marginT)}`
    let i = conds.findIndex(c => c.k === k)
    if (i < 0) { i = conds.length; conds.push({ k, X: r1(geo.sheetW), Y: r1(geo.sheetL), Sx: r1(geo.marginL), Sy: r1(geo.marginT), n: 0 }) }
    conds[i].n++
    return i
  }
  const spares = []
  const addSpare = (X, Y) => { spares.push({ X: r1(X), Y: r1(Y) }); return spares.length - 1 }

  let kerf = 0, partsN = 0, unitArea = 0, sheetArea = 0, spareArea = 0
  const layouts = []
  mat.sheets.forEach((sheet, si) => {
    const geo = geoOf(sheet)
    const k = geo.kerf
    kerf = k
    let tree
    try { tree = sheetCutTree(sheet, geo) } catch (e) { throw new Error(`лист ${si + 1}: ${e?.message || e}`, { cause: e }) }
    const cid = condOf(geo)
    const uids = new Map()
    let uArea = 0, sArea = 0
    const startMargin = ax => (ax === 'x' ? geo.marginL : geo.marginT)
    // узел дерева: rect — его прямоугольник на листе (абсолютный), layer — уровень (1 — лист)
    const nodeXml = (node, rect, layer, ind) => {
      const ax = node.axis
      const side = r1(layer <= 2 ? startMargin(ax) + node.trim : node.trim)
      const along0 = ax === 'x' ? rect.x : rect.y, alongLen = ax === 'x' ? rect.w : rect.h
      let pos = along0 + side
      const kids = []
      for (const sl of node.slots) {
        const len = sl.a - k
        const r = ax === 'x' ? { x: pos, y: rect.y, w: len, h: rect.h } : { x: rect.x, y: pos, w: rect.w, h: len }
        if (sl.child) kids.push({ sig: null, lines: nodeXml(sl.child, r, layer + 1, ind + '  '), r })
        else if (sl.item?.part) {
          const p = sl.item.part, uid = shapeOf(p), s = shapes[uid]
          s.count++; partsN++; uids.set(uid, (uids.get(uid) || 0) + 1)
          const X = r1(p.origX), Y = r1(p.origY), ang = Math.abs(X - s.X) > EPS ? ' Angle="90"' : ''
          uArea += X * Y
          const px = geo.marginL + p.x, py = geo.marginT + p.y
          kids.push({ sig: `p${uid}${ang}`, attrs: `X="${X}" Y="${Y}" Px="${r1(px)}" Py="${r1(py)}" UID="${uid}"${ang}` })
        } else if (sl.item?.offcut) {
          const sp = addSpare(r.w, r.h); sArea += r.w * r.h
          kids.push({ sig: null, attrs: `X="${r1(r.w)}" Y="${r1(r.h)}" Px="${r1(r.x)}" Py="${r1(r.y)}" UID="${sp}" Spare="True"` })
        }
        pos += sl.a
      }
      // остаток до конца узла (обрезок / край листа) — Spare, как у AutoCUT
      const rest = along0 + alongLen - pos
      if (rest > EPS) {
        const r = ax === 'x' ? { x: pos, y: rect.y, w: rest, h: rect.h } : { x: rect.x, y: pos, w: rect.w, h: rest }
        const sp = addSpare(r.w, r.h); sArea += r.w * r.h
        kids.push({ sig: null, attrs: `X="${r1(r.w)}" Y="${r1(r.h)}" Px="${r1(r.x)}" Py="${r1(r.y)}" UID="${sp}" Spare="True"` })
      }
      // одинаковые детали подряд — Grouped у первой
      for (let i = 0; i < kids.length;) {
        let j = i + 1
        while (kids[i].sig && j < kids.length && kids[j].sig === kids[i].sig) j++
        if (j - i > 1) kids[i].grouped = j - i
        i = j
      }
      const out = []
      for (const c of kids) {
        if (c.lines) { out.push(...c.lines); continue }
        out.push(`${ind}  <Part ${c.attrs}${c.grouped ? ` Grouped="${c.grouped}"` : ''}/>`)
      }
      if (layer === 1) return { side, lines: out }
      const head = `${ind}<Part X="${r1(rect.w)}" Y="${r1(rect.h)}"${rect.x > EPS ? ` Px="${r1(rect.x)}"` : ''}${rect.y > EPS ? ` Py="${r1(rect.y)}"` : ''}${side > 0 ? ` Side="${side}"` : ''}>`
      return [head, ...out, `${ind}</Part>`]
    }
    const root = nodeXml(tree, { x: 0, y: 0, w: geo.sheetW, h: geo.sheetL }, 1, '            ')
    const sa = geo.sheetW * geo.sheetL
    unitArea += uArea; sheetArea += sa; spareArea += sArea
    const uidsTxt = [...uids].sort((a, b) => a[0] - b[0]).map(([u, n]) => (n > 1 ? `${u}*${n}` : `${u}`)).join(',') + ','
    const c = conds[cid]
    layouts.push([
      `            <Layout ID="${si}" SheetID="${cid}" Count="1" Cut="False" Side="${root.side}" SheetName="XZ${cid ? cid + 1 : ''}" X="${c.X}" Y="${c.Y}" SX="${c.Sx}" SY="${c.Sy}" UIDS="${uidsTxt}" UnitCount="${[...uids.values()].reduce((a, b) => a + b, 0)}" UnitArea="${r1(uArea)}" SheetArea="${r1(sa)}" SpareArea="${r1(sArea)}" CutIn="-1">`,
      ...root.lines,
      '            </Layout>',
    ].join('\r\n'))
  })

  const now = oleDate(date)
  const out = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<AutoCUT xmlns="http://www.King-stone.com" ver="700">',
    `  <Project Name="${esc(title)}" Owner="RaskroyPro" Selected="0" ApplictionVer="10.26.1.3" CutTime="0" Update="${now}" DefaultLevel="0" UserFields="Edge,F1,F2,F3,F4,F5,F6,F7,F8,F9,F10,F11,">`,
    `    <Data Class="3" DBID="1" Type="XZ" TypeName="${esc(material)}" UnitPrice="0" Ply="${r1(thick)}" TypeFace="${esc(material)}" Grain="${grain ? 'True' : 'False'}" InputTime="${now}">`,
    `      <Objective Type="Shape" Count="${shapes.length}">`,
    // F1 — заказ, F2 — позиция, F3 — примечание (поля бирки AutoCUT)
    ...shapes.map(s => `        <Shape Name="${esc(s.name)}" X="${s.X}" Y="${s.Y}" Turn="${s.turn ? 'True' : 'False'}" Count="${s.count}" Value="${r1(s.X * s.Y)}" Edge="${esc(s.edges.join('|'))}" F1="${esc(title)}" F2="${esc(s.pos)}" F3="${esc(s.note)}"/>`),
    '      </Objective>',
    `      <Condition Type="Shape" Count="${conds.length}">`,
    ...conds.map((c, i) => `        <Shape Name="XZ${i ? i + 1 : ''}" X="${c.X}" Y="${c.Y}" Turn="False" Sx="${c.Sx}" Sy="${c.Sy}" Count="9999"/>`),
    '      </Condition>',
    '      <Solutions Selected="0">',
    `        <Solution SolverName="RaskroyPro" SolveGap="${r1(kerf)}" AlgCase="0" AlgNest="21" SolveParams="CutGap=${r1(kerf)}," SolveRate="10" SolveLevel="5" SolveTime="0" DateTime="${now}" UnitCounts="${shapes.map(s => s.count).join(',')},"`
      + ` SheetCounts="${conds.map(c => c.n).join(',')}," SumUnitArea="${r1(unitArea)}" SumSheetArea="${r1(sheetArea)}" SumSpareArea="${r1(spareArea)}">`,
    '          <Layouts>',
    ...layouts,
    '          </Layouts>',
    `          <Spares Type="Shape" Count="${spares.length}">`,
    ...spares.map(s => `            <Shape Name="#${s.X}x${s.Y}" X="${s.X}" Y="${s.Y}" Turn="False" Count="1" Value="${r1(s.X * s.Y)}"/>`),
    '          </Spares>',
    '        </Solution>',
    '      </Solutions>',
    '    </Data>',
    '  </Project>',
    '</AutoCUT>',
    '',
  ]
  const base = toLatin(`${title}_${material}_${thick}`).replace(/[^\w.-]+/g, '_').replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '') || 'autocut'
  return { text: out.join('\r\n'), fileName: `${base}.CUT`, panels: mat.sheets.length, parts: partsN }
}
