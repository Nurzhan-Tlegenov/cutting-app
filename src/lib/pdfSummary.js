// Что выводить в PDF карт раскроя из кабинета производства: статистика раскроя, смета (стоимость работ) и своё оформление листа.
// Настройки хранятся за аккаунтом: pdfSummary { off: [скрытые строки статистики], price: 'lines' | 'total' | 'none' },
// pdfEstimate (галочка «Смета» у кнопки PDF в раскрое), pdfTpl (макет листа из конструктора).
import { getUserSettings } from './userSettings'
import { nestingStats, sumStats, statsPayload, statsRows } from './nestingStats'
import { fetchQuote, fetchFixedQuote, freshFixedQuote, money, GROUP_TITLE, lineTitle, lineUnit } from './pricing'
import { normalizePdfTpl } from './nestingPdf'

const num = v => (Math.round(Number(v) * 100) / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })

/** Своё оформление листа, если пользователь его настраивал; иначе null — стандартный вид */
export function userPdfTpl(user) {
  const raw = getUserSettings(user).pdfTpl
  return raw?.custom ? normalizePdfTpl(raw) : null
}

/** Строки сметы: операция, количество, цена за единицу, сумма */
export function quoteLines(quote) {
  if (!quote || quote.empty || !(Number(quote.total) > 0)) return []
  if (quote.lines) {
    // только операции, которые есть в заказе: нулевые строки (нет присадки, пазов…) не выводятся
    return quote.lines.filter(l => Number(l.qty) > 0 || Number(l.sum) > 0).map(l => ({
      title: lineTitle(l.key), qty: `${num(l.qty)} ${lineUnit(l.key)}`, sum: num(l.sum),
      // у раскроя листа по ступеням цена у листов может быть разной — показываем среднюю
      rate: l.rate != null ? num(l.rate) : Number(l.qty) > 0 ? `≈ ${num(l.sum / l.qty)}` : '',
    }))
  }
  return (quote.groups || []).filter(g => Number(g.sum) > 0).map(g => ({ title: GROUP_TITLE[g.group] || g.group, qty: '', rate: '', sum: num(g.sum) }))
}

/** Страница «Статистика и стоимость» для PDF. cfg — pdfSummary; estimate === false — без сметы */
/** Строки статистики в порядке, заданном в конструкторе страницы статистики (cfg.order — ключи); новые — в конце */
export function orderRows(rows, order) {
  if (!Array.isArray(order) || !order.length) return rows
  const at = new Map(order.map((k, i) => [k, i]))
  return rows.map((r, i) => [r, at.has(r.key) ? at.get(r.key) : 1000 + i]).sort((a, b) => a[1] - b[1]).map(x => x[0])
}
/** Вид страницы статистики: порядок разделов, шрифт строк, колонки */
export function summaryLayout(cfg = {}) {
  // разделы: раскрой, деловые остатки, смета, примечания, список деталей (новые — в конце порядка, если порядок уже задан)
  const ok = ['stats', 'offcuts', 'cost', 'notes', 'parts']
  const sec = Array.isArray(cfg.sections) ? cfg.sections.filter(k => ok.includes(k)) : []
  const all = [...new Set([...sec, ...ok])].filter(k => (k !== 'parts' || cfg.parts?.on) && (k !== 'offcuts' || !cfg.noOffcuts))
  // примечания — каждое своей галочкой: клиента (бланк заказа) и производства; noNotes — старая общая галочка «не выводить»
  // по умолчанию обе включены: раз примечание написали — оно важно (старая общая галочка noNotes больше не действует)
  const noOrder = !!cfg.noOrderNote, noProd = !!cfg.noProdNote
  return { sections: noOrder && noProd ? all.filter(k => k !== 'notes') : all, size: Number(cfg.size) || 3.1, cols: cfg.cols === 1 ? 1 : 2, noOrderNote: noOrder, noProdNote: noProd,
    parts: cfg.parts?.on ? { cols: Array.isArray(cfg.parts.cols) ? cfg.parts.cols.filter(c => c && c.type) : [], wrap: cfg.parts.wrap !== false, size: Number(cfg.parts.size) || 0 } : null }
}
export function pdfSummaryOf(stats, quote, cfg = {}, estimate = true) {
  const off = new Set(cfg.off || [])
  const lines = quoteLines(quote)
  const priced = lines.length > 0 && estimate && cfg.price !== 'none'
  return {
    rows: stats ? orderRows(statsRows(stats), cfg.order).filter(r => !off.has(r.key)).map(r => ({ key: r.key, label: r.label, value: r.value })) : [],
    layout: summaryLayout(cfg),
    // деловые остатки: [[длина, ширина, шт]] — крупные первыми
    offcuts: stats ? Object.entries(stats.offcutSizes || {}).map(([k, n]) => [...k.split('×').map(Number), n]).sort((a, b) => b[0] * b[1] - a[0] * a[1]) : [],
    lines: priced && cfg.price !== 'total' ? lines : [],
    total: priced ? money(quote.total, quote.currency) : null,
    currency: priced ? quote.currency : '', minApplied: priced && !!quote.min_applied,
  }
}

/** Статистика и стоимость без React: у оформленного заказа — зафиксированная цена, иначе по текущему прайс-листу */
export async function statsAndQuote({ order, mats, method }) {
  const stats = sumStats((mats || []).map(mat => nestingStats({ order, mat, method })))
  let quote = null
  if (order?.production_id && stats.parts) {
    if (order.id && order.status && order.status !== 'draft') quote = await freshFixedQuote(order.id, await fetchFixedQuote(order.id), statsPayload(stats, order))
    if (!quote) quote = await fetchQuote(order.production_id, statsPayload(stats, order))
    else if (quote.hidden) quote = null
  }
  return { stats, quote }
}
