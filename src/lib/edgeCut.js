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
import { trimEdgeGroove } from './edgeGrooves'

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

/** Подрезка по сторонам, заданная самой моделью при импорте (contour.edgeTrim: { left: true, top: false, … }) */
export function edgeTrimOf(contour) {
  let c = contour
  if (typeof c === 'string') { try { c = JSON.parse(c) } catch { return null } }
  const t = c?.edgeTrim
  return t && typeof t === 'object' ? t : null
}

// ─── Припуск из модели (Базис: «Припуск» в свойствах облицовки торца — Allowance) ─────────────────────────────
// Хранится у детали по сторонам: contour.allow = { left: 80, … } (стороны — как у детали в заказе). Деталь в раскрой
// больше на припуск с этой стороны. Что делать с припуском — решает производство (Настройки → Лист и рез → «Припуск
// из модели»), его выбор пишется в виды кромки заказа под служебным ключом ALLOW_KEY: { mode, mm }:
//   'off' — не учитывать (по умолчанию: у работающих пользователей ничего не меняется); 'model' — как в модели;
//   'own' — свой припуск mm там, где в модели он есть.
// На стороне с кромкой, где задана прифуговка (производства или вида кромки), решает прифуговка — припуск модели не
// добавляется второй раз (в Базисе припуск у кромки — это и есть прифуговка конструктора).
// ─── Узкие детали на кромочном станке: у станка есть наименьшая ширина детали (например, 50 мм) ─────────────────
// Деталь с кромкой, у которой размер поперёк кромки меньше, в раскрой идёт шире — до этого размера; её кромят,
// потом упиливают лишнее. Лишнее — со стороны без кромки (обе стороны с кромкой — справа/сверху, тогда эту сторону
// кромят после подрезки). Это не припуск: задаётся производством (Настройки → Лист и рез), пишется в виды кромки
// заказа под ключом NARROW_KEY: { mm }.
export const NARROW_KEY = '__narrow'
export const narrowMm = types => Math.max(0, num(String(parseEdgeTypes(types)[NARROW_KEY]?.mm ?? '').replace(',', '.')))
/** Сколько нарастить с каждой стороны детали W×L (готовая) -> { left|right|top|bottom: мм } | null */
export function narrowApplied(edges, types, W, L) {
  const min = narrowMm(types)
  if (!(min > 0) || !edges) return null
  const has = s => !!edgeKey(edges[s])
  const out = {}
  // кромка слева/справа — деталь идёт по станку вдоль длины, поперёк — ширина W
  if ((has('left') || has('right')) && num(W) > 0 && num(W) < min - EPS) out[has('right') && !has('left') ? 'left' : 'right'] = r2(min - num(W))
  if ((has('top') || has('bottom')) && num(L) > 0 && num(L) < min - EPS) out[has('top') && !has('bottom') ? 'bottom' : 'top'] = r2(min - num(L))
  return Object.keys(out).length ? out : null
}
const withNarrow = (k, edges, types, W, L) => {
  const n = narrowApplied(edges, types, W, L)
  if (!n) return k
  const d = k ? { ...k } : { l: 0, r: 0, b: 0, t: 0 }
  for (const [s, v] of Object.entries(n)) d[s[0]] = r2((d[s[0]] || 0) - v)
  return d
}

export const ALLOW_KEY = '__allow'
export const ALLOW_JOINT_MAX = 3
export const ALLOW_MODES = [['off', 'Не учитывать'], ['model', 'Как в модели'], ['own', 'Свой припуск']]
export function allowOf(types) {
  const a = parseEdgeTypes(types)[ALLOW_KEY]
  const mode = ['model', 'off', 'own'].includes(a?.mode) ? a.mode : 'off'
  return { mode, mm: Math.max(0, num(String(a?.mm ?? '').replace(',', '.'))) }
}
/** Припуск из модели по сторонам детали (contour.allow) -> { left, right, bottom, top } | null */
export function modelAllow(contour) {
  let c = contour
  if (typeof c === 'string') { try { c = JSON.parse(c) } catch { return null } }
  const a = c?.allow
  if (!a || typeof a !== 'object') return null
  const out = {}
  for (const s of SIDES) if (num(a[s]) > 0) out[s] = num(a[s])
  return Object.keys(out).length ? out : null
}
/** Сколько припуска реально добавляется с каждой стороны (с учётом выбора производства и прифуговки) -> { left, … } */
export function allowApplied(edges, types, contour) {
  const a = modelAllow(contour)
  if (!a) return null
  const set = allowOf(types)
  if (set.mode === 'off') return null
  const out = {}
  for (const s of Object.keys(a)) {
    const k = edgeKey(edges?.[s])
    // у кромки с прифуговкой маленький припуск модели (до ALLOW_JOINT_MAX) — это прифуговка конструктора: решает
    // прифуговка производства/вида кромки. Большой припуск (под склейку, обрезку) — сверх прифуговки: деталь
    // сначала упиливают в размер, потом кромят
    if (k && num(types?.[k]?.joint) > 0 && a[s] <= ALLOW_JOINT_MAX) continue
    const v = set.mode === 'own' ? set.mm : a[s]
    if (v > 0) out[s] = v
  }
  return Object.keys(out).length ? out : null
}

/**
 * edges — { left, right, top, bottom }: название кромки | 'default' | null. -> { l, r, b, t } или null, если размер не меняется.
 * trim — подрезка по сторонам из модели (edgeTrimOf): где она задана, решает она, а не галочка вида кромки —
 * в Базисе одна и та же кромка у фасада с подрезкой, а у корпуса без. Толщина и прифуговка — из вида кромки.
 */
export function sideDeltas(edges, types, trim, contour = null) {
  if (!edges || !types) return null
  const d = {}
  let any = false
  const al = contour ? allowApplied(edges, types, contour) : null      // припуск из модели — деталь больше с этой стороны
  for (const s of SIDES) {
    const k = edgeKey(edges[s])
    const type = k ? types[k] : null
    d[s[0]] = !k ? 0 : typeof trim?.[s] === 'boolean' ? edgeDelta(type && { ...type, trim: trim[s] }) : edgeDelta(type)
    if (al?.[s]) d[s[0]] = r2(d[s[0]] - al[s])
    if (d[s[0]]) any = true
  }
  return any ? d : null
}

/** Деталь из модели с подрезкой хотя бы одной стороны — в списке задания у неё показывается размер в раскрой */
export const modelTrimmed = contour => Object.values(edgeTrimOf(contour) || {}).some(v => v === true) || !!modelAllow(contour)

/**
 * Что показывать в полях длины/ширины списка задания. У детали с подрезкой из модели — размер в раскрой
 * (как пойдёт на станок), а хранится по-прежнему готовая деталь: toFinished переводит введённое обратно.
 * -> { cut: true, l, w, dl, dw, toL(v), toW(v) } или { cut: false }
 */
export function listSize(detail, types) {
  const L = num(detail?.w), W = num(detail?.h)
  if (!(L > 0) || !(W > 0) || !(modelTrimmed(detail?.contour) || narrowApplied(detail?.edges, types, W, L))) return { cut: false }
  const cs = cutSize(L, W, detail.edges, types, detail.contour)
  if (!cs) return { cut: false }
  const dl = r2(L - cs[0]), dw = r2(W - cs[1])
  const back = d => v => (v === '' ? '' : r2(num(v) + d))
  return { cut: true, l: cs[0], w: cs[1], dl, dw, toL: back(dl), toW: back(dw) }
}

/** Размер в раскрой: [длина, ширина] (кромка слева/справа идёт вдоль длины и уменьшает ширину); contour — для подрезки из модели */
export function cutSize(length, width, edges, types, contour) {
  const k = withNarrow(sideDeltas(edges, types, edgeTrimOf(contour), contour), edges, types, width, length)
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
  if (Array.isArray(c.edgeGrooves)) out.edgeGrooves = c.edgeGrooves.map(g => trimEdgeGroove(g, k))
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
  let c = row.contour
  if (typeof c === 'string') { try { c = JSON.parse(c) } catch { c = null } }
  const W = num(row.width), L = num(row.length)
  const eds = { left: row.edge_left, right: row.edge_right, top: row.edge_top, bottom: row.edge_bottom }
  const k = withNarrow(sideDeltas(eds, types, edgeTrimOf(c), c), eds, types, W, L)
  if (!k) return row
  if (!(W - k.l - k.r > 1) || !(L - k.b - k.t > 1)) return row
  const cc = cutContour(c || {}, W, L, k)
  return { ...row, width: r2(W - k.l - k.r), length: r2(L - k.b - k.t), contour: JSON.stringify(cc), _parsedContour: undefined, _raw: row, _cut: k }
}

export const cutDetails = (rows, types) => (rows || []).map(r => cutDetail(r, types))
export const rawDetail = d => d?._raw || d

// ─── Виды кромки в бланке заказа ────────────────────────────────────────────
export const EDGE_TYPES_HINT = 'Заказ сохранён, но толщину кромки, подрезку и прифуговку сохранить не удалось: в базе нет колонки. Выполните migration_edge_types.sql в Supabase (SQL Editor) и сохраните заказ ещё раз.'
export const blankType = () => ({ t: '', trim: false, joint: 0 })

/** Толщина кромок из импортированной модели (Базис пишет её в свойствах детали; К3 — ещё подрезку и прифуговку) -> { название: { t, trim, joint } } */
// Галочка «подрезка» у вида — только если в модели подрезаны все стороны с этой кромкой (у самих импортированных деталей
// подрезка всё равно идёт по сторонам — contour.edgeTrim); галочка — это то, что получат детали, добавленные потом вручную.
export function typesFromItems(items) {
  const out = {}
  for (const it of items || []) {
    const info = it.contour?.meta?.edges
    if (!info) continue
    for (const side of SIDES) {
      const name = edgeKey(it.edges?.[side]), t = num(info[side]?.thick)
      if (!name || !(t > 0)) continue
      if (!out[name]) out[name] = { t, trim: !!info[side]?.trim, joint: num(info[side]?.joint) || 0 }
      else if (!info[side]?.trim) out[name].trim = false
    }
  }
  return out
}

/** Импорт: виды кромки, уже заданные в заказе/аккаунте, остаются как есть; но если у такого вида не указана толщина — берётся из модели */
export function mergeModelTypes(prev, fromModel) {
  const out = { ...fromModel, ...(prev || {}) }
  for (const [k, m] of Object.entries(fromModel || {})) {
    const p = prev?.[k]
    if (p && !(num(String(p.t ?? '').replace(',', '.')) > 0) && num(m.t) > 0) out[k] = { ...p, t: m.t }
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

// ─── Обозначение кромки: производство заменяет длинное название из модели коротким («ПВХ 0,4 мм Egger W1000…» → «0,4 бел.»).
// Хранится в видах кромки заказа под служебным ключом { исходное: обозначение }; сами детали не меняются.
// Обозначение идёт на бирку и в статистику заказа.
export const NAMES_KEY = '__names'
export function edgeAliases(types) {
  const v = parseEdgeTypes(types)[NAMES_KEY]
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
}
/** Название кромки с учётом обозначения производства */
export const edgeAlias = (name, al) => (name && al && typeof al[name] === 'string' && al[name].trim() ? al[name].trim() : name)

/** Что сохранять в заказ: только те виды кромки, что в нём есть, с числами */
export function typesToSave(types, names) {
  const out = {}
  const ov = overOf(types)
  if (!ov.on || ov.mm !== OVER_DEFAULT) out[OVER_KEY] = ov          // обычные свесы (включены, 30 мм) не записываем
  if (types?.[NAMES_KEY] && Object.keys(types[NAMES_KEY]).length) out[NAMES_KEY] = types[NAMES_KEY]   // обозначения кромки от производства
  if (types?.[ALLOW_KEY]) out[ALLOW_KEY] = allowOf(types)                // выбор производства о припуске из модели
  if (narrowMm(types) > 0) out[NARROW_KEY] = { mm: narrowMm(types) }     // наименьшая ширина детали на кромочном станке
  for (const n of ['default', ...(names || [])]) {
    const v = types?.[n]
    if (!v) continue
    const t = num(String(v.t).replace(',', '.')), joint = num(String(v.joint).replace(',', '.'))
    if (t > 0 || v.trim || joint > 0) out[n] = { t, trim: !!v.trim, joint }
  }
  return out
}
