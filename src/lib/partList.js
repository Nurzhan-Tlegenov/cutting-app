// Список деталей (деталировка) на странице статистики PDF: те детали материала, что участвуют в раскрое, по строке на
// позицию. Колонки — те же параметры, что можно поставить на бирку (наименование, обозначение, позиция, размеры, кромка
// по сторонам, обработка, свойства из Базиса и колонки таблицы импорта), в своём порядке, с шириной «авто» или своей.
// Настройка — в конструкторе страницы статистики: pdfSummary.parts = { on, cols: [{ type, title, w }], wrap }.
import { LABEL_ITEMS, itemTitle, metaItems, userItems, labelInfo, labelText } from './labelMaker'

// параметры бирки, которые бывают колонкой (картинки и то, что относится к одной детали на листе, — нет)
const SKIP = new Set(['image', 'sheet', 'num', 'part', 'map', 'qr'])
export const ROW_NO = 'rowNo'
// короткие заголовки колонок по умолчанию (своё название колонки можно написать в конструкторе)
const HEAD = { [ROW_NO]: '№', pos: 'Поз.', name: 'Наименование', des: 'Обозначение', title: 'Обозначение и наименование', length: 'Длина', width: 'Ширина',
  qty: 'Кол-во', thickness: 'Толщ.', size: 'Размер', edgeTop: 'Кромка верх', edgeBottom: 'Кромка низ', edgeLeft: 'Кромка лев.', edgeRight: 'Кромка прав.',
  edgeList: 'Кромка', faceHoles: 'Отв. пласть', backHoles: 'Отв. изнанка', endHoles: 'Отв. торец', grooves: 'Пазы', pockets: 'Выемки', cutouts: 'Вырезы',
  curved: 'Крив. кромка', work: 'Обработка', twoSided: '2 стороны', prefix: 'Изделие', block: 'Блок', group: 'Группа', blockPath: 'Блок / группа', order: 'Заказ', material: 'Материал' }

/** Все параметры, которые можно сделать колонкой: [[тип, название]]; details — детали заказа (их свойства из импорта) */
export function partListItems(details = [], extraTypes = []) {
  const base = [[ROW_NO, '№ строки'], ...LABEL_ITEMS.filter(([t, , k]) => k === 'text' && !SKIP.has(t)).map(([t, l]) => [t, l])]
  const more = [...metaItems(details), ...userItems(details)]
  // свойства, которые стоят на бирке (своя бирка пользователя), — даже если в образце их нет
  for (const t of extraTypes) if ((t.startsWith('user:') || t.startsWith('meta:')) && !more.some(x => x[0] === t)) more.push([t, itemTitle(t)])
  return [...base, ...more]
}
export const colHead = c => String(c?.title ?? '').trim() || HEAD[c?.type] || itemTitle(c?.type || '')

/** Колонки по умолчанию: то, что стоит на бирке пользователя (текстом), иначе — стандартный набор */
export function defaultPartCols(labelTpl) {
  const fromLabel = (labelTpl?.items || []).map(i => i.type).filter(t => t && !SKIP.has(t) && (t.startsWith('user:') || t.startsWith('meta:') || LABEL_ITEMS.some(x => x[0] === t && x[2] === 'text')))
  const uniq = [...new Set(fromLabel)]
  // «Размер и количество» на бирке — в таблице удобнее отдельными колонками
  const expanded = uniq.flatMap(t => (t === 'size' ? ['length', 'width', 'qty'] : [t]))
  const types = expanded.length ? [ROW_NO, ...new Set(expanded)] : [ROW_NO, 'pos', 'name', 'length', 'width', 'qty', 'edgeTop', 'edgeBottom', 'edgeLeft', 'edgeRight']
  if (!types.includes('qty')) types.push('qty')
  return types.map(type => ({ type }))
}

const r1 = v => String(Math.round(Number(v) * 10) / 10).replace('.', ',')
/**
 * Строки таблицы: детали материала, которые легли в раскрой, — по одной на позицию заказа, в порядке заказа.
 * -> [[текст ячейки, …]] в порядке колонок
 */
export function partListRows(order, mat, cols) {
  const sheets = mat?.sheets || [], details = mat?.details || []
  if (!sheets.length || !cols?.length) return []
  const count = new Map()
  for (const sh of sheets) for (const p of sh?.placed || []) if (p?.detailIndex != null) count.set(p.detailIndex, (count.get(p.detailIndex) || 0) + 1)
  const tpl = { rot: false, edgeDims: false }      // кромка — по сторонам детали, как в заказе, без размера стороны
  const out = []
  for (const di of [...count.keys()].sort((a, b) => a - b)) {
    const d = details[di]
    if (!d) continue
    const W = Number(d.width) || 0, L = Number(d.length) || 0, qty = count.get(di)
    let info
    try { info = labelInfo(order, mat, 0, 0, { detailIndex: di, x: 0, y: 0, w: W, h: L, origX: W, origY: L, rotation: 0, rotated: false }) } catch { info = null }
    const cell = type => {
      switch (type) {
        case ROW_NO: return String(out.length + 1)
        case 'length': return r1(L)
        case 'width': return r1(W)
        case 'qty': return String(qty)
        case 'size': return `${r1(L)} × ${r1(W)} × ${qty} шт`
        default: return info ? String(labelText(type, { ...info, qty }, tpl, '') || '') : ''
      }
    }
    out.push(cols.map(c => cell(c.type)))
  }
  return out
}
