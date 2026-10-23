// Настройки отчётов производства для его клиентов (productions.report_settings, migration_production_reports.sql).
// Производство настраивает PDF у себя (настройки за аккаунтом: pdfEstimate, pdfSummary, pdfTpl, pdfStatsPage) —
// копия уходит в карточку производства, и PDF карт раскроя у клиента с этим производством выводится так же:
// страница статистики и сметы, порядок и вид строк, свой макет листа.
import { supabase } from './supabase'
import { getUserSettings } from './userSettings'
import { normalizePdfTpl } from './nestingPdf'

let timer = null
/** Отправить настройки отчётов своему производству (после правки; ошибки — молча: колонки может не быть) */
export function syncProductionReports(user) {
  if (!user?.id) return
  clearTimeout(timer)
  timer = setTimeout(async () => {
    const st = getUserSettings(user)
    const report = { estimate: !!st.pdfEstimate, summary: st.pdfSummary || {}, tpl: st.pdfTpl?.custom ? st.pdfTpl : null, statsPage: !!st.pdfStatsPage, at: new Date().toISOString() }
    try { await supabase.from('productions').update({ report_settings: report }).eq('owner_id', user.id) } catch { /* нет колонки — у клиентов будет вид по умолчанию */ }
  }, 600)
}

/** Настройки отчётов производства для PDF клиента: { estimate, summary, tpl, statsPage } (нет — смета включена, вид стандартный) */
export function clientReport(production) {
  const r = production?.report_settings
  const rs = r && typeof r === 'object' ? r : {}
  return {
    estimate: rs.estimate !== false,
    summary: rs.summary && typeof rs.summary === 'object' ? rs.summary : {},
    tpl: rs.tpl?.custom ? normalizePdfTpl(rs.tpl) : null,
    statsPage: !!rs.statsPage,
  }
}
