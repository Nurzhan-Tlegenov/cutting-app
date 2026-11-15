// Своя смета для PDF (кабинет производства): перед PDF можно поправить строки прайса (количество, цену, убрать строку),
// добавить свои строки (материал — листы × цена, доставка, упаковка…) или вовсе не брать прайс («Без прайса»).
// Прайс-лист производства от этого не меняется. Правки запоминаются за аккаунтом на заказ + материал
// (настройка estimateEdits, последние MAX заказов), чтобы повторный PDF вышел таким же.
// Модуль без React.
import { getUserSettings, saveUserSettings } from './userSettings'
import { lineTitle, lineUnit, money } from './pricing'

const MAX = 80
const num = v => { const n = Number(String(v ?? '').replace(',', '.').replace(/\s/g, '')); return Number.isFinite(n) ? n : 0 }
const r2 = v => Math.round(v * 100) / 100
const fmt = v => (Math.round(Number(v) * 100) / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })

export const estimateKey = (order, mat) => `${order?.id || 'new'}|${mat?.name || ''}|${mat?.thickness || ''}`
export const emptyEstimate = () => ({ noPrice: false, edits: {}, extra: [] })
/** Есть ли в смете свои правки */
export const isCustom = est => !!est && (est.noPrice || (est.extra || []).length > 0 || Object.keys(est.edits || {}).length > 0)

export function loadEstimate(user, key) {
  const all = getUserSettings(user).estimateEdits
  const e = all && typeof all === 'object' ? all[key] : null
  return e && typeof e === 'object' ? { ...emptyEstimate(), ...e } : emptyEstimate()
}
export function saveEstimate(user, key, est) {
  const all = { ...(getUserSettings(user).estimateEdits || {}) }
  delete all[key]
  if (isCustom(est)) all[key] = { ...est, at: Date.now() }
  // старые заказы — прочь, чтобы настройки аккаунта не разрастались
  const keys = Object.keys(all).sort((a, b) => (all[b].at || 0) - (all[a].at || 0))
  for (const k of keys.slice(MAX)) delete all[k]
  saveUserSettings({ estimateEdits: all }, user)
}

/** Строки прайса в смете: [{ key, title, unit, qty, rate, sum, off, edited }] — с правками */
export function baseLines(quote, est) {
  if (!quote || quote.empty || !Array.isArray(quote.lines)) return []
  const edits = est?.edits || {}
  return quote.lines.filter(l => Number(l.qty) > 0 || Number(l.sum) > 0).map(l => {
    const q0 = Number(l.qty) || 0, s0 = Number(l.sum) || 0
    const r0 = l.rate != null ? Number(l.rate) : q0 > 0 ? r2(s0 / q0) : 0
    const e = edits[l.key] || {}
    const qty = e.qty != null ? num(e.qty) : q0, rate = e.rate != null ? num(e.rate) : r0
    const edited = e.qty != null || e.rate != null
    return { key: l.key, title: lineTitle(l.key), unit: lineUnit(l.key), qty, rate, sum: edited ? r2(qty * rate) : s0, off: !!e.off, edited, avg: l.rate == null && !edited }
  })
}
/** Свои строки: [{ id, title, unit, qty, rate, sum }] */
export function extraLines(est) {
  return (est?.extra || []).map(x => ({ ...x, qty: num(x.qty), rate: num(x.rate), sum: r2(num(x.qty) * num(x.rate)) }))
}

/**
 * Итог сметы с правками. -> { lines: [строки для PDF], total, work, extras, minApplied, currency }
 * Минимальная сумма заказа из прайса относится только к работам; свои строки идут сверху.
 */
export function applyEstimate(quote, est) {
  const own = quote && !quote.empty && Array.isArray(quote.lines)
  const base = est?.noPrice || !own ? [] : baseLines(quote, est).filter(l => !l.off)
  const extra = extraLines(est).filter(x => String(x.title || '').trim() || x.sum)
  let work = r2(base.reduce((a, l) => a + l.sum, 0))
  const mn = Number(quote?.min) || 0
  const minApplied = !est?.noPrice && own && work > 0 && mn > 0 && work < mn
  if (minApplied) work = mn
  const extras = r2(extra.reduce((a, x) => a + x.sum, 0))
  const lines = [
    ...base.map(l => ({ title: l.title, qty: `${fmt(l.qty)} ${l.unit}`.trim(), rate: l.avg ? `≈ ${fmt(l.rate)}` : fmt(l.rate), sum: fmt(l.sum) })),
    ...extra.map(x => ({ title: String(x.title || '').trim() || 'Прочее', qty: x.qty ? `${fmt(x.qty)} ${x.unit || ''}`.trim() : '', rate: x.rate ? fmt(x.rate) : '', sum: fmt(x.sum) })),
  ]
  const currency = (est?.cur ?? '') || quote?.currency || ''
  return { lines, total: r2(work + extras), work, extras, minApplied, currency, totalText: money(work + extras, currency) }
}
