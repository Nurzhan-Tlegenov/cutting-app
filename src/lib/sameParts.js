// Подсветка одинаковых деталей на карте раскроя (галочка «Одинаковые» рядом с «Кромка»).
// Одинаковые — одинаковое обозначение (нет обозначения — наименование), те же длина и ширина и та же кромка по сторонам.
// Цвет — только у групп, где деталей 2 шт. и больше; деталь в единственном экземпляре остаётся серой.
// Галочка включена — цвет везде: карта листа, все листы, карточка заказа, PDF карт раскроя (и его печать). Детали с обработкой снизу / с двух
// сторон остаются фиолетовыми, как и были, — им цвет не даётся. Цвета спокойные, полупрозрачные (прозрачность — ползунок).
import { backSide } from './partInfo'
import { detailMeta, metaDes } from './partLabel'
import { getUserSettings } from './userSettings'

// rgb без прозрачности; без фиолетового (обработка снизу), оранжевого (мелкие у края, выбранная) и яркого красного (наложение)
export const SAME_COLORS = ['33,150,243', '67,160,71', '236,64,122', '0,172,193', '124,179,66', '121,85,72', '0,121,107', '96,125,139', '229,115,115', '57,73,171', '175,180,43', '255,167,38']

const num = v => Math.round((Number(v) || 0) * 10) / 10
const edge = e => (e ? (typeof e === 'object' ? String(e.name || e.type || 1) : String(e)) : '')

/** { индекс детали: 'r,g,b' } — только для одинаковых деталей (2 шт. и больше) */
export function sameColorMap(details) {
  const groups = new Map()
  ;(details || []).forEach((d, i) => {
    if (!d || backSide(d)) return
    // контур не сравниваем: в нём лежат служебные данные импорта (позиция, id) — у одинаковых деталей они разные
    const des = metaDes(detailMeta(d) || {}) || String(d.name || '')
    const key = [des.trim().toLowerCase(), num(d.length), num(d.width),
      edge(d.edge_left), edge(d.edge_right), edge(d.edge_top), edge(d.edge_bottom)].join('|')
    const g = groups.get(key) || { idx: [], qty: 0 }
    g.idx.push(i); g.qty += Math.max(1, Number(d.qty) || 1)
    groups.set(key, g)
  })
  const out = {}
  let c = 0
  for (const g of groups.values()) {
    if (g.qty < 2) continue
    const rgb = SAME_COLORS[c++ % SAME_COLORS.length]
    for (const i of g.idx) out[i] = rgb
  }
  return out
}

/** Подсветка одинаковых по настройке пользователя: прозрачность (0 — выключена) */
export function userSameAlpha(user) {
  const st = getUserSettings(user)
  if (st.nestShowSame !== true) return 0
  const v = Number(st.nestSameAlpha)
  return v >= 0.1 && v <= 0.6 ? v : 0.22
}
