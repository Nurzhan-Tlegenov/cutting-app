/**
 * Разбор XML-программ шестистороннего (и пятистороннего) присадочного станка — формат Syntec / SWJ
 * (спецификация «新代Xml檔說明» v1.51, WoodPanel CAD Xml Format). Для просмотрщика.
 *
 * Один файл может содержать несколько деталей (Panels > Panel). Координаты — готовой детали, вид сверху,
 * ноль — левый нижний угол, Length — по X, Width — по Y.
 */
const num = v => { const x = Number(String(v ?? '').replace(',', '.')); return isFinite(x) ? x : 0 }
const has = (el, k) => el.hasAttribute(k)
const attrs = el => Object.fromEntries([...el.attributes].map(a => [a.name, a.value]))

export const TYPE_NAMES = { 1: 'Отверстие в торец', 2: 'Отверстие в пласть', 3: 'Фрезеровка', 4: 'Паз' }
export const FACE_NAMES = { 1: 'торец верхний (Y = ширина)', 2: 'торец нижний (Y = 0)', 3: 'торец правый (X = длина)', 4: 'торец левый (X = 0)', 5: 'пласть верхняя', 6: 'пласть нижняя' }

/** text — содержимое файла, file — его имя. -> { panels: [...], error } */
export function parseDrillXml(text, file = '') {
  let doc
  try { doc = new DOMParser().parseFromString(String(text || '').replace(/^\uFEFF/, ''), 'application/xml') } catch (e) { return { panels: [], error: String(e?.message || e) } }
  const bad = doc.getElementsByTagName('parsererror')[0]
  if (bad) return { panels: [], error: 'Файл повреждён или это не XML: ' + (bad.textContent || '').split('\n')[0].slice(0, 120) }
  const panels = [...doc.getElementsByTagName('Panel')].map((p, pi) => {
    const L = num(p.getAttribute('Length')), W = num(p.getAttribute('Width')), T = num(p.getAttribute('Thickness'))
    const outline = [...(p.getElementsByTagName('Outline')[0]?.getElementsByTagName('Point') || [])].map(q => ({ X: num(q.getAttribute('X')), Y: num(q.getAttribute('Y')), R: num(q.getAttribute('Radius')) }))
    const ops = [...p.getElementsByTagName('Machining')].map((m, i) => {
      const type = num(m.getAttribute('Type'))
      const op = {
        i, type, face: num(m.getAttribute('Face')), gen: m.getAttribute('IsGenCode') !== '0',
        x: num(m.getAttribute('X')), y: num(m.getAttribute('Y')), z: has(m, 'Z') ? num(m.getAttribute('Z')) : null,
        d: num(m.getAttribute('Diameter')), depth: num(m.getAttribute('Depth')),
        endX: num(m.getAttribute('EndX')), endY: num(m.getAttribute('EndY')), width: num(m.getAttribute('Width')),
        offset: m.getAttribute('ToolOffset') || '', pocket: m.getAttribute('Pocket') === '1',
        tool: m.getAttribute('Drill') || m.getAttribute('ToolName') || m.getAttribute('CadDefineTool') || '',
        attrs: attrs(m),
      }
      if (type === 3) {
        const linesEl = m.getElementsByTagName('Lines')[0]
        op.closed = m.getAttribute('Closed') === '1' || linesEl?.getAttribute('Closed') === '1' || op.pocket
        op.segs = [...(linesEl?.getElementsByTagName('Line') || [])].map(l => ({ to: [num(l.getAttribute('EndX')), num(l.getAttribute('EndY'))], angle: num(l.getAttribute('Angle')) }))
      }
      return op
    })
    const edges = { 1: 0, 2: 0, 3: 0, 4: 0 }
    for (const e of p.getElementsByTagName('Edge')) { const f = num(e.getAttribute('Face')); if (f >= 1 && f <= 4) edges[f] = num(e.getAttribute('Thickness')) }
    return {
      key: `${file}#${pi}`, file, id: p.getAttribute('ID') || '', name: p.getAttribute('Name') || '', material: p.getAttribute('Material') || '',
      L, W, T, outline, ops, edges, grain: p.getAttribute('Grain') || '',
    }
  })
  if (!panels.length) return { panels, error: 'В файле нет деталей (элементов Panel)' }
  return { panels, error: '' }
}

/** Сводка по детали: сколько чего на каждой стороне */
export function panelSummary(p) {
  const c = { top: 0, bottom: 0, edge: 0, grooves: 0, mills: 0, pockets: 0, off: 0 }
  for (const o of p.ops) {
    if (!o.gen) c.off++
    if (o.type === 2) { if (o.face === 6) c.bottom++; else if (o.face === 5) c.top++; else c.edge++ }
    else if (o.type === 1) c.edge++
    else if (o.type === 4) c.grooves++
    else if (o.type === 3) { if (o.pocket) c.pockets++; else c.mills++ }
  }
  return c
}
