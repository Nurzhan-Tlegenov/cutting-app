// Кромка: толщина, подрезка и прифуговка -> размер детали в раскрой.
//
// У каждого вида кромки свои настройки: { t — толщина, мм; trim — подрезать деталь на толщину кромки;
// joint — прифуговка, мм (0 — нет) }. Ключ — название кромки, 'default' — кромка без названия.
// С каждой закромленной стороны деталь в раскрое меньше на (trim ? t : 0) − joint.
// Пример: готовая 600, кромка 2 мм с двух сторон, прифуговка 0,5 → 600 − 2·2 + 2·0,5 = 597.
// Если подрезка не включена и прифуговки нет — деталь идёт в раскрой как есть.
//
// Размеры и присадка в заказе всегда хранятся «по готовой детали». Для раскроя, карты, DXF, G-кода и бирок
// деталь пересчитывается здесь (cutDetail): меняются размеры, контур, вырезы и пазы; у присадки в контуре
// ставится пометка cut — её учитывает getAllDrillPoints (отверстия остаются на своих местах относительно
// готовой детали). Кромка на фигурных участках и в вырезах размер пока не меняет.

const num = v => Number(v) || 0
const r2 = v => Math.round(v * 100) / 100
const EPS = 0.05
const SIDES = ['left', 'right', 'bottom', 'top']

export const edgeKey = v => (!v || v === 'false' ? null : v === true ? 'default' : String(v))

/** Настройки видов кромки заказа (колонка orders.edge_types: jsonb или текст) */
export function parseEdgeTypes(v) {
  if (!v) return {}
  if (typeof v === 'string') { try { v = JSON.parse(v) } catch { return {} } }
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
}

/** На сколько мм деталь меньше в раскрое со стороны с такой кромкой (может быть отрицательным — прифуговка без подрезки) */
export function edgeDelta(type) {
  if (!type) return 0
  return r2((type.trim ? num(type.t) : 0) - num(type.joint))
}

/** edges — { left, right, top, bottom }: название кромки | 'default' | null. -> { l, r, b, t } или null, если размер не меняется */
export function sideDeltas(edges, types) {
  if (!edges || !types) return null
  const d = {}
  let any = false
  for (const s of SIDES) {
    const k = edgeKey(edges[s])
    d[s[0]] = k ? edgeDelta(types[k]) : 0
    if (d[s[0]]) any = true
  }
  return any ? d : null
}

/** Размер в раскрой: [длина, ширина] (кромка слева/справа идёт вдоль длины и уменьшает ширину) */
export function cutSize(length, width, edges, types) {
  const k = sideDeltas(edges, types)
  if (!k) return null
  return [r2(num(length) - k.b - k.t), r2(num(width) - k.l - k.r)]
}

function resolvePos(sides, offsets, W, H, iw, ih) {
  let x = (W - iw) / 2, y = (H - ih) / 2, w = iw, h = ih
  if (sides.includes('left') && sides.includes('right')) { x = offsets.left ?? 0; w = W - (offsets.left ?? 0) - (offsets.right ?? 0) }
  else if (sides.includes('left')) x = offsets.left ?? 0
  else if (sides.includes('right')) x = W - iw - (offsets.right ?? 0)
  if (sides.includes('top') && sides.includes('bottom')) { y = offsets.bottom ?? 0; h = H - (offsets.bottom ?? 0) - (offsets.top ?? 0) }
  else if (sides.includes('bottom')) y = offsets.bottom ?? 0
  else if (sides.includes('top')) y = H - ih - (offsets.top ?? 0)
  return { x, y, w, h }
}

/** Контур готовой детали W×L -> контур заготовки (система координат — от её левого нижнего угла) */
export function cutContour(c, W, L, k) {
  const Wc = W - k.l - k.r, Lc = L - k.b - k.t
  // точка на стороне готовой детали остаётся на стороне заготовки; остальные — на своём месте
  const mx = x => (Math.abs(x) < EPS ? 0 : Math.abs(x - W) < EPS ? r2(Wc) : r2(Math.min(Wc, Math.max(0, x - k.l))))
  const my = y => (Math.abs(y) < EPS ? 0 : Math.abs(y - L) < EPS ? r2(Lc) : r2(Math.min(Lc, Math.max(0, y - k.b))))
  const verts = vs => vs.map(v => ({ ...v, x: mx(num(v.x)), y: my(num(v.y)) }))
  const out = { ...c, cut: k }
  if (Array.isArray(c.vertices) && c.vertices.length > 2) out.vertices = verts(c.vertices)
  if (Array.isArray(c.holes)) {
    out.holes = c.holes.map(h => {
      const sides = h.sides || [], offsets = h.offsets || {}
      if (h.type === 'circle') {
        const d = num(h.d) || 100
        const p = resolvePos(sides, offsets, W, L, d, d)
        return { ...h, sides: ['left', 'bottom'], offsets: { left: r2(p.x - k.l), bottom: r2(p.y - k.b) } }
      }
      const hw = h.hw || 200, hh = h.hh || 100
      const p = resolvePos(sides, offsets, W, L, hw, hh)
      const x0 = mx(p.x), x1 = mx(p.x + p.w), y0 = my(p.y), y1 = my(p.y + p.h)
      return {
        ...h, sides: ['left', 'bottom'], offsets: { left: x0, bottom: y0 }, hw: r2(x1 - x0), hh: r2(y1 - y0),
        ...(Array.isArray(h.vertices) && h.vertices.length > 2 ? { vertices: verts(h.vertices) } : {}),
      }
    })
  }
  if (Array.isArray(c.grooves)) {
    out.grooves = c.grooves.map(g => {
      const hor = g.dir === 'horizontal'
      const gw = hor ? (g.length || 100) : (g.width || 8), gh = hor ? (g.width || 8) : (g.length || 100)
      const p = resolvePos(g.sides || [], g.offsets || {}, W, L, gw, gh)
      const x0 = mx(p.x), x1 = mx(p.x + p.w), y0 = my(p.y), y1 = my(p.y + p.h)
      return { ...g, sides: ['left', 'bottom'], offsets: { left: x0, bottom: y0 }, length: r2(hor ? x1 - x0 : y1 - y0), width: r2(hor ? y1 - y0 : x1 - x0) }
    })
  }
  return out
}

/**
 * Строка order_details -> деталь для раскроя. Если размер не меняется — та же строка.
 * Иначе новая строка: width / length — размер заготовки, contour — пересчитан, _raw — исходная строка
 * (её и нужно править и сохранять), _cut — { l, r, b, t }.
 */
export function cutDetail(row, types) {
  if (!row || !types) return row
  const k = sideDeltas({ left: row.edge_left, right: row.edge_right, top: row.edge_top, bottom: row.edge_bottom }, types)
  if (!k) return row
  const W = num(row.width), L = num(row.length)
  if (!(W - k.l - k.r > 1) || !(L - k.b - k.t > 1)) return row
  let c = row.contour
  if (typeof c === 'string') { try { c = JSON.parse(c) } catch { c = null } }
  const cc = cutContour(c || {}, W, L, k)
  return { ...row, width: r2(W - k.l - k.r), length: r2(L - k.b - k.t), contour: JSON.stringify(cc), _parsedContour: undefined, _raw: row, _cut: k }
}

export const cutDetails = (rows, types) => (rows || []).map(r => cutDetail(r, types))
export const rawDetail = d => d?._raw || d

// ─── Виды кромки в бланке заказа ────────────────────────────────────────────
export const EDGE_TYPES_HINT = 'Заказ сохранён, но толщину кромки, подрезку и прифуговку сохранить не удалось: в базе нет колонки. Выполните migration_edge_types.sql в Supabase (SQL Editor) и сохраните заказ ещё раз.'
export const blankType = () => ({ t: '', trim: false, joint: 0 })

/** Толщина кромок из импортированной модели (Базис пишет её в свойствах детали) -> { название: { t, trim, joint } } */
export function typesFromItems(items) {
  const out = {}
  for (const it of items || []) {
    const info = it.contour?.meta?.edges
    if (!info) continue
    for (const side of SIDES) {
      const name = edgeKey(it.edges?.[side]), t = num(info[side]?.thick)
      if (name && t > 0 && !out[name]) out[name] = { t, trim: false, joint: 0 }
    }
  }
  return out
}

// ─── Свесы: запас к длине кромки на каждую закромленную сторону ────────────────────────────────
// Хранится вместе с видами кромки заказа под служебным ключом. По умолчанию включено, 30 мм (по 15 с каждого конца).
// Клиент со своей кромкой отключает галочку в раскрое — метраж сразу пересчитывается без свесов.
export const OVER_KEY = '__over'
export const OVER_DEFAULT = 30
export function overOf(types) {
  const o = types?.[OVER_KEY]
  const mm = o && o.mm !== undefined && o.mm !== null && o.mm !== '' ? num(String(o.mm).replace(',', '.')) : OVER_DEFAULT
  return { on: o ? o.on !== false : true, mm }
}
/** Сколько мм добавлять к длине кромки на каждую закромленную сторону (0 — свесы отключены) */
export const overMm = types => { const o = overOf(types); return o.on ? o.mm : 0 }

/** Что сохранять в заказ: только те виды кромки, что в нём есть, с числами */
export function typesToSave(types, names) {
  const out = {}
  const ov = overOf(types)
  if (!ov.on || ov.mm !== OVER_DEFAULT) out[OVER_KEY] = ov          // обычные свесы (включены, 30 мм) не записываем
  for (const n of ['default', ...(names || [])]) {
    const v = types?.[n]
    if (!v) continue
    const t = num(String(v.t).replace(',', '.')), joint = num(String(v.joint).replace(',', '.'))
    if (t > 0 || v.trim || joint > 0) out[n] = { t, trim: !!v.trim, joint }
  }
  return out
}
