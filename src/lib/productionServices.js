// Услуги производства: короткие вопросы «да / нет» при регистрации (и в настройках производства).
// Ответы видны заказчику в окне «Где будете резать?» значками; если в заказе есть то, чего производство не делает
// (фигурные детали без ЧПУ, криволинейная кромка, присадка), — заказчик видит предупреждение. Ничего не блокируется.
import { supabase } from './supabase'

// parent — вопрос показывается, только если на родительский ответили «да»
export const SERVICE_QUESTIONS = [
  { key: 'saw', group: 'Раскрой', q: 'Режете на форматно-раскроечном станке (пила)?', short: 'Пила' },
  { key: 'cnc', group: 'Раскрой', q: 'Есть фрезер с ЧПУ (нестинг)?', short: 'ЧПУ' },
  { key: 'shaped', group: 'Раскрой', q: 'Режете фигурные детали — радиусы, вырезы, произвольный контур?', short: 'Фигурные', parent: 'cnc' },
  { key: 'hdf', group: 'Раскрой', q: 'Режете ХДФ / ДВП (задние стенки)?', short: 'ХДФ' },
  { key: 'edge', group: 'Кромка', q: 'Кромите прямолинейные детали?', short: 'Кромка' },
  { key: 'edge_curved', group: 'Кромка', q: 'Делаете криволинейную кромку?', short: 'Крив. кромка', parent: 'edge' },
  { key: 'edge_client', group: 'Кромка', q: 'Принимаете кромку заказчика?', short: 'Кромка заказчика', parent: 'edge' },
  { key: 'drill', group: 'Присадка', q: 'Делаете присадку (сверление)?', short: 'Присадка' },
  { key: 'client_material', group: 'Материал', q: 'Работаете с материалом заказчика?', short: 'Материал заказчика' },
  { key: 'stock', group: 'Материал', q: 'Продаёте материал со своего склада?', short: 'Свой склад' },
]
export const EXTRA_SERVICES = [['pack', 'Упаковка'], ['delivery', 'Доставка'], ['assembly', 'Сборка'], ['install', 'Установка']]

export const parseServices = v => {
  if (!v) return {}
  if (typeof v === 'object') return v
  try { return JSON.parse(v) || {} } catch { return {} }
}
export const servicesKnown = s => Object.keys(parseServices(s)).length > 0
const visible = (s, q) => !q.parent || s[q.parent] === true

/** Ответы для сохранения: только видимые вопросы (ответ на скрытый вопрос не хранится) и выбранные дополнительные */
export function cleanServices(s) {
  const out = {}
  SERVICE_QUESTIONS.forEach(q => { if (visible(s, q) && typeof s[q.key] === 'boolean') out[q.key] = s[q.key] })
  EXTRA_SERVICES.forEach(([k]) => { if (s[k] === true) out[k] = true })
  return out
}
/** Что не отвечено из обязательного (раскрой) -> текст ошибки или '' */
export function servicesProblem(s) {
  if (typeof s.saw !== 'boolean' || typeof s.cnc !== 'boolean') return 'Ответьте на вопросы о раскрое: пила и ЧПУ'
  if (!s.saw && !s.cnc) return 'Отметьте, на чём режете: пила или ЧПУ'
  if (s.cnc && typeof s.shaped !== 'boolean') return 'Ответьте, режете ли фигурные детали'
  return ''
}
/** Значки услуг: ['Пила', 'ЧПУ', 'Фигурные', …] */
export function serviceBadges(raw) {
  const s = parseServices(raw)
  return [...SERVICE_QUESTIONS.filter(q => visible(s, q) && s[q.key] === true).map(q => q.short),
    ...EXTRA_SERVICES.filter(([k]) => s[k] === true).map(([, l]) => l)]
}
/** Чего производство не делает из нужного заказу. needs: { shaped, edge, curvedEdge, drill, hdf } -> ['фигурные детали', …] */
export function missingServices(raw, needs = {}) {
  const s = parseServices(raw)
  if (!servicesKnown(s)) return []        // производство ещё не указало услуги — не знаем
  const out = []
  if (needs.shaped && !(s.cnc && s.shaped)) out.push('фигурные детали')
  if (needs.hdf && s.hdf === false) out.push('ХДФ')
  if (needs.edge && s.edge === false) out.push('кромка')
  if (needs.curvedEdge && s.edge !== false && !s.edge_curved) out.push('криволинейная кромка')
  if (needs.drill && !s.drill) out.push('присадка')
  return out
}

export const SERVICES_SQL_HINT = 'Услуги производства ещё не сохраняются: выполните migration_production_services.sql в Supabase (SQL Editor) — один раз.'
/** Сохранить услуги своего производства. -> {} | { error, missing } */
export async function saveProductionServices(s) {
  try {
    const { error } = await supabase.rpc('production_set_services', { p_services: cleanServices(s) })
    if (!error) return {}
    const missing = /PGRST202|42883|schema cache|Could not find the function/i.test(`${error.message} ${error.code}`)
    return { error: missing ? SERVICES_SQL_HINT : error.message, missing }
  } catch (e) { return { error: String(e?.message || e) } }
}
