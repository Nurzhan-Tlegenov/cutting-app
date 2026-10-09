// Что выводить в PDF карт раскроя из кабинета производства: статистика раскроя, смета (стоимость работ) и своё оформление листа.
// Настройки хранятся за аккаунтом: pdfSummary { off: [скрытые строки статистики], price: 'lines' | 'total' | 'none' },
// pdfEstimate (галочка «Смета» у кнопки PDF в раскрое), pdfTpl (макет листа из конструктора).
import { getUserSettings } from './userSettings'
import { nestingStats, sumStats, statsPayload, statsRows } from './nestingStats'
import { fetchQuote, fetchFixedQuote, money, GROUP_TITLE, lineTitle, lineUnit } from './pricing'
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
    return quote.lines.map(l => ({
      title: lineTitle(l.key), qty: `${num(l.qty)} ${lineUnit(l.key)}`, sum: num(l.sum),
      // у раскроя листа по ступеням цена у листов может быть разной — показываем среднюю
      rate: l.rate != null ? num(l.rate) : Number(l.qty) > 0 ? `≈ ${num(l.sum / l.qty)}` : '',
    }))
  }
  return (quote.groups || []).map(g => ({ title: GROUP_TITLE[g.group] || g.group, qty: '', rate: '', sum: num(g.sum) }))
}

/** Страница «Статистика и стоимость» для PDF. cfg — pdfSummary; estimate === false — без сметы */
export function pdfSummaryOf(stats, quote, cfg = {}, estimate = true) {
  const off = new Set(cfg.off || [])
  const lines = quoteLines(quote)
  const priced = lines.length > 0 && estimate && cfg.price !== 'none'
  return {
    rows: stats ? statsRows(stats).filter(r => !off.has(r.key)).map(r => ({ label: r.label, value: r.value })) : [],
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
    if (order.id && order.status && order.status !== 'draft') quote = await fetchFixedQuote(order.id)
    if (!quote) quote = await fetchQuote(order.production_id, statsPayload(stats))
    else if (quote.hidden) quote = null
  }
  return { stats, quote }
}
