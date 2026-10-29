// Склад деловых остатков производства (см. migration_remnants_stock.sql): список, ввод, ячейки, перерезка, списание, журнал.
import { supabase } from './supabase'
import { mm } from './mmFmt'

export const STOCK_SQL_HINT = 'Склад остатков ещё не включён в базе: выполните migration_remnants_stock.sql в Supabase (SQL Editor) — один раз.'

const KNOWN = {
  'not allowed': 'Нет прав на это действие. Менять склад могут владелец, начальник производства и ответственные за склад.',
  'stock: reason required': 'Производство требует указать причину.',
  'stock: not found': 'Остаток не найден — возможно, его уже удалили.',
  'stock: not free': 'Остаток списан или в резерве — перерезать нельзя.',
  'stock: already used': 'Остаток уже списан.',
  'stock: bad size': 'Укажите длину и ширину больше нуля.',
}
const errText = error => {
  const m = String(error?.message || '')
  if (/function|schema cache|PGRST202|relation .* does not exist|42P01/i.test(m)) return { error: STOCK_SQL_HINT, missing: true }
  const k = Object.keys(KNOWN).find(x => m.includes(x))
  return { error: k ? KNOWN[k] : m }
}
const call = async (fn, args) => {
  const { data, error } = await supabase.rpc(fn, args)
  return error ? errText(error) : { data }
}

export const stockInfo = prodId => call('stock_info', { p_prod: prodId })
export async function stockList(prodId) {
  const { data, error } = await supabase.from('remnants').select('*').eq('production_id', prodId).order('id', { ascending: false }).limit(5000)
  return error ? errText(error) : { data: data || [] }
}
export async function stockEvents(remId) {
  const { data, error } = await supabase.from('remnant_events').select('*').eq('remnant_id', remId).order('at', { ascending: true })
  return error ? errText(error) : { data: data || [] }
}
// журнал склада за период: перерезано, списано, удалено — с кем и когда
export async function stockJournal(prodId, fromIso) {
  let q = supabase.from('remnant_events').select('*').eq('production_id', prodId).in('action', ['recut', 'writeoff', 'delete', 'restore']).order('at', { ascending: false }).limit(500)
  if (fromIso) q = q.gte('at', fromIso)
  const { data, error } = await q
  return error ? errText(error) : { data: data || [] }
}
export const stockAdd = (prodId, rows) => call('stock_add', { p_prod: prodId, p_rows: rows })
export const stockEdit = (id, patch, reason = null) => call('stock_edit', { p_id: id, p_patch: patch, p_reason: reason })
export const stockCell = (id, cell) => call('stock_cell', { p_id: id, p_cell: cell || '' })
export const stockRecut = (id, length, width, reason) => call('stock_recut', { p_id: id, p_length: length, p_width: width, p_reason: reason || '' })
export const stockWriteoff = (id, qty, kind, reason) => call('stock_writeoff', { p_id: id, p_qty: qty, p_kind: kind, p_reason: reason || '' })
export const stockRestore = (id, reason = null) => call('stock_restore', { p_id: id, p_reason: reason })
export const stockDelete = (id, reason = null) => call('stock_delete', { p_id: id, p_reason: reason })
export const stockSetSettings = (prodId, settings) => call('stock_settings_set', { p_prod: prodId, p_settings: settings })

// причины списания
export const KINDS = [['order', 'В заказ'], ['defect', 'Брак'], ['claim', 'Рекламация'], ['other', 'Прочее']]
export const kindText = k => (KINDS.find(x => x[0] === k) || ['', ''])[1]

export const sizeText = r => `${mm(r.length)} × ${mm(r.width)}`
export const num = v => { const n = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : 0 }

// материал без толщины, регистра и лишних пробелов — для поиска и подбора «похожих»
export const normMaterial = s => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\b\d+([.,]\d+)?\s*(мм|mm)\b/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

const dt = iso => { try { return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) } catch { return '' } }
export const dateText = dt
export const dayText = iso => { try { return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }) } catch { return '' } }

const sz = o => (o && o.length != null && o.width != null ? `${mm(o.length)} × ${mm(o.width)}` : '')
const FIELD = { length: 'длина', width: 'ширина', qty: 'кол-во', material: 'материал', thickness: 'толщина', cell: 'ячейка', note: 'примечание' }
const val = v => (v == null || v === '' ? '—' : String(v))

/** Запись журнала по-человечески: «Перерезан 1200 × 600 → 800 × 600» */
export function eventText(e) {
  const b = e.before || {}, a = e.after || {}
  switch (e.action) {
    case 'create': return `Внесён на склад: ${sz(a)}${a.qty > 1 ? `, ${a.qty} шт` : ''}${a.cell ? `, ячейка ${a.cell}` : ''}`
    case 'cell': return a.cell ? (b.cell ? `Ячейка: ${b.cell} → ${a.cell}` : `Ячейка указана: ${a.cell}`) : `Ячейка убрана (была ${val(b.cell)})`
    case 'edit': return 'Исправлено: ' + Object.keys(a).map(k => `${FIELD[k] || k} ${val(b[k])} → ${val(a[k])}`).join(', ')
    case 'recut':
      if (a.to) return `1 шт отрезана в остаток №${a.to}, здесь осталось ${a.qty} шт`
      return `Перерезан: ${sz(b)} → ${sz(a)}${b.from ? ` (из остатка №${b.from})` : ''}`
    case 'writeoff':
      if (a.to) return `Списано ${e.qty} шт (${kindText(a.kind).toLowerCase()}) — отдельной строкой №${a.to}, осталось ${a.qty} шт`
      return `Списан${e.qty > 1 ? ` (${e.qty} шт)` : ''}: ${kindText(a.kind).toLowerCase()}${b.from ? ` (из остатка №${b.from})` : ''}`
    case 'restore': return 'Возвращён на склад'
    case 'label': return 'Бирка выпущена'
    case 'delete': return `Удалён насовсем: ${sz(b)}${b.material ? `, ${b.material}` : ''}`
    default: return e.action
  }
}
