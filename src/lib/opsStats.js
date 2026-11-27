// Итоги по операциям (ProductionPage → «Итоги»): запись операций заказа (statsPayload из nestingStats.js, хранится
// в базе без модели и чертежей) — в строки «операция — сколько», и их сумма за период по всем заказам.
// Строки сметы (quote.lines: { group, key, qty, rate, sum }) — по операциям прайса: сколько и на какую сумму.
import { PLATE_CLASSES, EDGE_CLASSES, HOLE_CLASSES, lineTitle, lineUnit } from './pricing'

const PL = Object.fromEntries(PLATE_CLASSES), EL = Object.fromEntries(EDGE_CLASSES), HL = Object.fromEntries(HOLE_CLASSES)
const num = v => Number(v) || 0
const dNum = k => Number(String(k).replace(',', '.')) || 0

/** запись операций одного заказа → Map(ключ → { label, unit, value, ord }) — только ненулевые */
export function flatOps(st) {
  const s = st || {}, out = new Map()
  const put = (key, label, unit, value, ord) => { const v = num(value); if (v > 0) out.set(key, { key, label, unit, value: v, ord }) }
  // листы: по толщине плиты; обрезки со склада — отдельно
  const sh = Array.isArray(s.sheets) ? s.sheets : []
  if (sh.length) {
    const byT = {}
    let off = 0
    for (const x of sh) { if (x?.o) off++; else byT[x?.t || ''] = (byT[x?.t || ''] || 0) + 1 }
    const ts = Object.keys(byT)
    if (ts.length === 1 && !ts[0]) put('sheets', 'Листы', 'шт.', byT[''], 10)
    else ts.forEach(t => put('sheets_' + t, t ? `Листы ${PL[t] || t}` : 'Листы', 'шт.', byT[t], 10 + PLATE_CLASSES.findIndex(c => c[0] === t) / 10))
    put('sheets_off', 'Обрезки со склада', 'шт.', off, 11)
  }
  put('parts', 'Детали', 'шт.', s.parts, 20)
  put('parts_m2', 'Площадь деталей', 'м²', s.parts_m2, 21)
  put('cut_m', 'Рез', 'м', s.cut_m, 30)
  put('upil_n', 'Упилы узких деталей', 'шт.', s.upil_n, 31)
  put('upil_m', 'Упилы узких деталей', 'м', s.upil_m, 32)
  // кромка: по толщине плиты и кромки (матрица), иначе — тонкая / толстая
  const em = s.em && typeof s.em === 'object' ? s.em : null
  if (em && Object.keys(em).length) {
    for (const [k, v] of Object.entries(em)) {
      const [p, e] = k.split('_'), m = num(v?.[0]) + num(v?.[1])
      put('em_' + k, `Кромка ${EL[e] || e} мм · плита ${PL[p] || p}`, 'м', m, 40 + PLATE_CLASSES.findIndex(c => c[0] === p) / 10 + EDGE_CLASSES.findIndex(c => c[0] === e) / 100)
    }
  } else {
    put('edge_thin_m', 'Кромка тонкая', 'м', s.edge_thin_m, 40)
    put('edge_thick_m', 'Кромка толстая', 'м', s.edge_thick_m, 41)
  }
  if (s.emg && typeof s.emg === 'object') for (const [k, v] of Object.entries(s.emg)) {
    const [p, e] = k.split('_')
    put('emg_' + k, `Кромка ${EL[e] || e} мм · склеенные ${PL[p] || p}`, 'м', num(v?.[0]) + num(v?.[1]), 45)
  }
  put('edge_curved_m', 'Кромка криволинейная', 'м', s.edge_curved_m, 46)
  put('edge_curved_parts', 'Детали с криволинейной кромкой', 'шт.', s.edge_curved_parts, 47)
  put('glue_n', 'Склейка', 'шт.', s.glue_n, 48)
  put('glue_m2', 'Склейка', 'м²', s.glue_m2, 49)
  // отверстия: по диаметрам (точно), иначе — по диапазонам; торцевые — отдельно
  const hdd = s.hdd && typeof s.hdd === 'object' ? s.hdd : null
  if (hdd && Object.keys(hdd).length) for (const [d, n] of Object.entries(hdd)) put('hdd_' + d, `Отверстия в пласть Ø${String(d).replace('.', ',')}`, 'шт.', n, 50 + dNum(d) / 1000)
  else if (s.hd && typeof s.hd === 'object') for (const [c, n] of Object.entries(s.hd)) put('hd_' + c, `Отверстия в пласть ${HL[c] || c}`, 'шт.', n, 50 + HOLE_CLASSES.findIndex(x => x[0] === c) / 10)
  else put('holes', 'Отверстия в пласть', 'шт.', s.holes, 50)
  const ehd = s.ehd && typeof s.ehd === 'object' ? s.ehd : null
  if (ehd && Object.keys(ehd).length) for (const [d, n] of Object.entries(ehd)) put('ehd_' + d, `Отверстия в торец Ø${String(d).replace('.', ',')}`, 'шт.', n, 55 + dNum(d) / 1000)
  else put('edge_holes', 'Отверстия в торец', 'шт.', s.edge_holes, 55)
  put('drill_m2', 'Присадка (площадь деталей)', 'м²', s.drill_m2, 58)
  put('groove_m', 'Пазы', 'м', s.groove_m, 60)
  put('groove_n_narrow', 'Пазы узкие', 'шт.', s.groove_n_narrow, 61)
  put('groove_n_wide', 'Пазы широкие', 'шт.', s.groove_n_wide, 62)
  put('pockets', 'Выемки', 'шт.', s.pockets, 70)
  put('cutouts', 'Вырезы', 'шт.', s.cutouts, 71)
  put('shaped_parts', 'Фигурные детали', 'шт.', s.shaped_parts, 72)
  return out
}

const sorted = m => [...m.values()].sort((a, b) => a.ord - b.ord || a.label.localeCompare(b.label, 'ru'))
/** строки операций одного заказа, по порядку */
export const opsRows = st => sorted(flatOps(st))

/** сумма операций по списку заказов (за период) */
export function sumOps(list) {
  const m = new Map()
  for (const o of list || []) for (const r of flatOps(o.stats).values()) {
    const cur = m.get(r.key)
    if (cur) cur.value += r.value; else m.set(r.key, { ...r })
  }
  return sorted(m)
}

/** строки сметы одного заказа → [{ key, title, qty, sum, currency }] */
export function lineRows(o) {
  const ls = Array.isArray(o?.lines) ? o.lines : []
  return ls.filter(l => l && (num(l.qty) > 0 || num(l.sum) > 0)).map(l => ({ key: l.key, title: lineTitle(l.key), unit: lineUnit(l.key), qty: num(l.qty), sum: num(l.sum), currency: o.currency || '' }))
}
/** суммы сметы по операциям за период: по ключу операции и валюте */
export function sumLines(list) {
  const m = new Map()
  for (const o of list || []) for (const l of lineRows(o)) {
    const k = l.key + '|' + l.currency, cur = m.get(k)
    if (cur) { cur.qty += l.qty; cur.sum += l.sum } else m.set(k, { ...l })
  }
  return [...m.values()].sort((a, b) => b.sum - a.sum)
}
