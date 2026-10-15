// Сортировка списка деталей заказа. Работает и с деталями формы
// ({ w, h, qty, name, contour }), и со строками order_details
// ({ length, width, qty, name, contour — JSON-строка }).
import { detailMeta } from './partLabel.js'

export const SORT_MODES = [
  ['des', 'По обозначению'],
  ['name', 'По наименованию'],
  ['length', 'По длине (крупные сверху)'],
  ['width', 'По ширине (крупные сверху)'],
  ['qty', 'По количеству'],
]

const natural = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' })
const len = d => Number(d.w ?? d.length) || 0
const wid = d => Number(d.h ?? d.width) || 0

export function sortDetails(list, mode) {
  const des = d => detailMeta(d)?.des || ''
  const name = d => String(d.name || '')
  const cmp = {
    // детали без обозначения (введённые вручную) — в конец, в прежнем порядке
    des: (a, b) => (!des(a) - !des(b)) || natural.compare(des(a), des(b)),
    name: (a, b) => (!name(a) - !name(b)) || natural.compare(name(a), name(b)),
    length: (a, b) => len(b) - len(a) || wid(b) - wid(a),
    width: (a, b) => wid(b) - wid(a) || len(b) - len(a),
    qty: (a, b) => (Number(b.qty) || 0) - (Number(a.qty) || 0),
  }[mode]
  if (!cmp) return list
  return list.map((d, i) => [d, i]).sort((x, y) => cmp(x[0], y[0]) || x[1] - y[1]).map(x => x[0])
}
