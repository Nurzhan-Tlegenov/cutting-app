// Подсветка одинаковых деталей на карте раскроя (галочка «Одинаковые» рядом с «Кромка»).
// Одинаковые — одинаковое обозначение (нет обозначения — наименование), те же длина и ширина и та же кромка по сторонам.
// Цвет — у каждой позиции (группы одинаковых деталей), в том числе в единственном экземпляре: своя позиция — свой цвет.
// Цветов столько, сколько позиций: первые 12 — из спокойной палитры, дальше — новые оттенки по кругу (с разной
// светлотой), чтобы у разных позиций цвет не повторялся.
// Галочка включена — цвет везде: карта листа, все листы, карточка заказа, PDF карт раскроя (и его печать). Детали с обработкой снизу / с двух
// сторон остаются фиолетовыми, как и были, — им цвет не даётся. Цвета спокойные, полупрозрачные (прозрачность — ползунок).
import { backSide } from './partInfo'
import { detailMeta, metaDes } from './partLabel'
import { getUserSettings } from './userSettings'

// rgb без прозрачности; без фиолетового (обработка снизу), оранжевого (мелкие у края, выбранная) и яркого красного (наложение)
export const SAME_COLORS = ['33,150,243', '67,160,71', '236,64,122', '0,172,193', '124,179,66', '121,85,72', '0,121,107', '96,125,139', '229,115,115', '57,73,171', '175,180,43', '255,167,38']

const num = v => Math.round((Number(v) || 0) * 10) / 10
const edge = e => (e ? (typeof e === 'object' ? String(e.name || e.type || 1) : String(e)) : '')

// Оттенки, которые заняты другими пометками: фиолетовый (обработка снизу), оранжевый (мелкие у края, выбранная), красный (наложение)
const BUSY_HUE = h => h < 14 || (h > 22 && h < 48) || (h > 262 && h < 312) || h > 342
function hslRgb(h, s, l) {
  s /= 100; l /= 100
  const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l)
  const f = n => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))))
  return `${f(0)},${f(8)},${f(4)}`
}
/** n-й цвет позиции: сначала палитра, потом золотой угол по кругу оттенков, без занятых оттенков */
export function sameColor(n) {
  if (n < SAME_COLORS.length) return SAME_COLORS[n]
  let k = n - SAME_COLORS.length, step = 0, h = 0
  do { h = (step++ * 137.508 + 200) % 360 } while (BUSY_HUE(h) || k-- > 0)
  const ring = Math.floor((n - SAME_COLORS.length) / 14) % 3   // следующие круги — светлее / темнее
  return hslRgb(h, [62, 48, 70][ring], [46, 34, 58][ring])
}

/** { индекс детали: 'r,g,b' } — у каждой позиции свой цвет (одинаковые детали — одним цветом) */
export function sameColorMap(details) {
  const groups = new Map()
  ;(details || []).forEach((d, i) => {
    if (!d || backSide(d)) return
    // контур не сравниваем: в нём лежат служебные данные импорта (позиция, id) — у одинаковых деталей они разные
    const des = metaDes(detailMeta(d) || {}) || String(d.name || '')
    const key = [des.trim().toLowerCase(), num(d.length), num(d.width),
      edge(d.edge_left), edge(d.edge_right), edge(d.edge_top), edge(d.edge_bottom)].join('|')
    const g = groups.get(key) || { idx: [] }
    g.idx.push(i)
    groups.set(key, g)
  })
  const out = {}
  let c = 0
  for (const g of groups.values()) {
    const rgb = sameColor(c++)
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
