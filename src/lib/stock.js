// Склад деловых остатков производства (см. migration_remnants_stock.sql): список, ввод, ячейки, перерезка, списание, журнал.
import { supabase } from './supabase'
import { mm } from './mmFmt'
import { orderTitle } from './orderUtils'

export const STOCK_SQL_HINT = 'Склад остатков ещё не включён в базе: выполните migration_remnants_stock.sql в Supabase (SQL Editor) — один раз.'

const KNOWN = {
  'not allowed': 'Нет прав на это действие. Менять склад могут владелец, начальник производства и ответственные за склад.',
  'stock: reason required': 'Производство требует указать причину.',
  'stock: not found': 'Остаток не найден — возможно, его уже удалили.',
  'stock: not free': 'Остаток списан или в резерве — перерезать нельзя.',
  'stock: already used': 'Остаток уже списан.',
  'stock: reserved': 'Остаток в резерве за заказом — он пойдёт в раскрой, трогать его нельзя. Снять резерв можно, убрав его из раскроя заказа.',
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
// весь журнал склада (для выгрузки в Excel)
export async function stockAllEvents(prodId) {
  const { data, error } = await supabase.from('remnant_events').select('*').eq('production_id', prodId).order('at', { ascending: false }).limit(10000)
  return error ? errText(error) : { data: data || [] }
}
export const stockAdd = (prodId, rows) => call('stock_add', { p_prod: prodId, p_rows: rows })
export const stockEdit = (id, patch, reason = null) => call('stock_edit', { p_id: id, p_patch: patch, p_reason: reason })
export const stockCell = (id, cell) => call('stock_cell', { p_id: id, p_cell: cell || '' })
export const stockRecut = (id, length, width, reason) => call('stock_recut', { p_id: id, p_length: length, p_width: width, p_reason: reason || '' })
export const stockWriteoff = (id, qty, kind, reason) => call('stock_writeoff', { p_id: id, p_qty: qty, p_kind: kind, p_reason: reason || '' })
export const stockRestore = (id, reason = null) => call('stock_restore', { p_id: id, p_reason: reason })
export const stockDelete = (id, reason = null) => call('stock_delete', { p_id: id, p_reason: reason })
export const stockLabeled = ids => call('stock_labeled', { p_ids: ids })
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
    case 'create': return `${a.source === 'nesting' ? 'Пришёл из раскроя' + (a.order ? ` заказа ${a.order}` : '') : 'Внесён на склад'}: ${sz(a)}${a.qty > 1 ? `, ${a.qty} шт` : ''}${a.cell ? `, ячейка ${a.cell}` : ''}`
    case 'cell': return a.cell ? (b.cell ? `Ячейка: ${b.cell} → ${a.cell}` : `Ячейка указана: ${a.cell}`) : `Ячейка убрана (была ${val(b.cell)})`
    case 'edit': return 'Исправлено: ' + Object.keys(a).map(k => `${FIELD[k] || k} ${val(b[k])} → ${val(a[k])}`).join(', ')
    case 'recut':
      if (a.to) return `1 шт отрезана в остаток №${a.to}, здесь осталось ${a.qty} шт`
      return `Перерезан: ${sz(b)} → ${sz(a)}${b.from ? ` (из остатка №${b.from})` : ''}`
    case 'writeoff':
      if (a.to) return `Списано ${e.qty} шт (${kindText(a.kind).toLowerCase()}) — отдельной строкой №${a.to}, осталось ${a.qty} шт`
      return `Списан${e.qty > 1 ? ` (${e.qty} шт)` : ''}: ${kindText(a.kind).toLowerCase()}${a.order ? ` — заказ ${a.order}` : ''}${b.from ? ` (из остатка №${b.from})` : ''}`
    case 'restore': return 'Возвращён на склад'
    case 'reserve': return a.to ? `${e.qty} шт отделено в остаток №${a.to} под заказ` : `В резерве за заказом ${a.order || ''}${b.from ? ` (из остатка №${b.from})` : ''}`
    case 'release': return `Резерв снят (заказ ${b.order || ''})`
    case 'label': return 'Бирка выпущена'
    case 'delete': return `Удалён насовсем: ${sz(b)}${b.material ? `, ${b.material}` : ''}`
    default: return e.action
  }
}

/** Номер остатка склада из QR-кода бирки (OSTATOK;R123;…) или null */
export function remnantIdFromQr(text) {
  const m = /^\s*OSTATOK\W+R(\d+)\b/i.exec(String(text || ''))
  return m ? Number(m[1]) : null
}

/**
 * Бирка остатка из раскроя: OSTATOK<разделитель>1250x612x16<разделитель>материал<разделитель>заказ…
 * Части и разделитель выбирает пользователь в шаблоне; размер в коде есть всегда. Узнаём по виду:
 * размер — «ДxШ(xТ)», дата — дд.мм.гггг, номер карты — L5, остальной текст по порядку: материал, затем заказ / заказчик.
 * Состав кода выбирает производство: чего в коде нет, сотрудник впишет сам.
 * -> { key, length, width, thickness, material, texts, date, sheet } | null (не бирка остатка)
 */
export function parseRemnantQr(text) {
  const t = String(text || '').trim()
  const m = /^OSTATOK(\W)/i.exec(t)
  if (!m) return null
  const sep = m[1]
  const toks = t.slice(m[0].length).split(sep).map(x => x.trim()).filter(Boolean)
  const out = { key: t, length: 0, width: 0, thickness: 0, material: '', texts: [], date: '', sheet: '' }
  for (const k of toks) {
    const sz = /^(\d+(?:[.,]\d+)?)\s*[xх×*]\s*(\d+(?:[.,]\d+)?)(?:\s*[xх×*]\s*(\d+(?:[.,]\d+)?)?)?$/i.exec(k)
    if (sz && !out.length) { out.length = num(sz[1]); out.width = num(sz[2]); out.thickness = num(sz[3]); continue }
    if (/^\d{2}\.\d{2}\.\d{4}$/.test(k)) { out.date = k; continue }
    if (/^L\d+$/i.test(k)) { out.sheet = k.slice(1); continue }
    if (/^R\d+$/i.test(k)) continue
    out.texts.push(k)
  }
  out.material = out.texts[0] || ''
  return out
}
/** Уже внесённый на склад остаток с этой бирки (внесён сканом или привязан к бирке) */
export async function stockByKey(prodId, key) {
  const r = await call('stock_by_key', { p_prod: prodId, p_key: key })
  if (r.error && r.missing) {          // база без migration_remnants_nesting.sql — как раньше
    const { data, error } = await supabase.from('remnants').select('*').eq('production_id', prodId).eq('source_key', key).maybeSingle()
    return error ? errText(error) : { data }
  }
  return r
}
/** Остаток пришёл из раскроя сам («Мои остатки»), ещё без ячейки и без бирки-кода: похожий по размеру и материалу */
export async function stockAutoMatch(prodId, p) {
  const { data } = await supabase.from('remnants').select('*').eq('production_id', prodId).eq('source', 'nesting').eq('status', 'free').is('cell', null).is('label_key', null).limit(500)
  const near = (a, b) => Math.abs(num(a) - num(b)) <= 1.5
  const m = normMaterial(p.material)
  return (data || []).filter(r => ((near(r.length, p.length) && near(r.width, p.width)) || (near(r.length, p.width) && near(r.width, p.length)))
    && (!m || materialMatch(m, r.material))).sort((a, b) => b.id - a.id)[0] || null
}
export const stockLinkLabel = (id, key, cell) => call('stock_link_label', { p_id: id, p_key: key || '', p_cell: cell || '' })

// ── раскрой ──
/** Остатки склада производства для раскроя: { allowed, own, items } */
/** Выпустили программы ЧПУ — остатки из резерва заказа списываются «в заказ» */
export const stockUseOrder = orderId => call('stock_use_order', { p_order: orderId })
export const stockForNesting = (prodId, orderId) => call('stock_for_nesting', { p_prod: prodId, p_order: orderId || null })
/** Резерв остатков за заказом (прежний резерв снимается). Ошибка «занят» -> { error, busy: [номера] } */
export async function stockReserve(orderId, items) {
  const { data, error } = await supabase.rpc('stock_reserve', { p_order: orderId, p_items: items })
  if (!error) return { data }
  const m = /stock: busy ([\d,]+)/.exec(String(error.message || ''))
  if (m) return { error: `Остатки ${m[1].split(',').map(x => '№' + x).join(', ')} уже заняты другим заказом. Уберите их из «Обрезков со склада» и пересчитайте раскрой.`, busy: m[1].split(',').map(Number) }
  return errText(error)
}
/** Остатки из раскроя: owner 'production' — на склад (без дублей), 'client' — не на склад */
export const stockFromNesting = (orderId, owner, items) => call('stock_from_nesting', { p_order: orderId, p_owner: owner, p_items: items })

const GENERIC = new Set(['лдсп', 'мдф', 'хдф', 'двп', 'дсп', 'лмдф', 'плита', 'панель', 'egger', 'kronospan', 'увадрев', 'кроношпан'])
/** Сравнение материалов без регистра, пробелов и толщины: 'exact' | 'similar' | null */
export function materialMatch(a, b) {
  const x = normMaterial(a), y = normMaterial(b)
  if (!x || !y) return null
  if (x === y) return 'exact'
  // общие слова материала (ЛДСП, МДФ…) похожести не дают — только декор / цвет
  const ok = w => w.length >= 3 && !GENERIC.has(w)
  const wx = x.split(' ').filter(ok), wy = new Set(y.split(' ').filter(ok))
  return wx.some(w => wy.has(w)) ? 'similar' : null
}

/** Все деловые остатки сохранённого раскроя заказа — строки для склада (ключ — заказ, материал, лист, номер, размер) */
export function nestingRemnants(order, mats) {
  const out = []
  for (const m of mats || []) {
    (m.sheets || []).forEach((sh, si) => (sh.manualOffcuts || []).map(o => ({ w: Math.round(o.w), h: Math.round(o.h) })).filter(o => o.w > 0 && o.h > 0).forEach((o, k) => out.push({
      key: `auto:${order.id}:${m.key}:${si}:${k}:${o.h}x${o.w}`, length: o.h, width: o.w, material: m.name || order.material_name || '', thickness: m.thickness || '',
      note: `из раскроя заказа ${orderTitle(order)}, карта ${si + 1}`,
    })))
  }
  return out
}
/** При выпуске бирок / программ: остатки производства — на склад (если так выбрано у заказа). Ошибки не мешают выпуску */
export async function syncOrderRemnants(order, mats) {
  if (order?.offcuts_owner !== 'production') return null
  try { return await stockFromNesting(order.id, 'production', nestingRemnants(order, mats)) } catch { return null }
}

