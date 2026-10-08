import { useEffect, useMemo, useState } from 'react'
import { nestingStats, sumStats, statsPayload } from '../lib/nestingStats'
import { fetchQuote, fetchFixedQuote } from '../lib/pricing'

// номер объекта — чтобы понять, что раскрой тот же самый, не сравнивая его целиком
const ids = new WeakMap()
let seq = 0
const idOf = o => { if (!o || typeof o !== 'object') return 0; if (!ids.has(o)) ids.set(o, ++seq); return ids.get(o) }

/**
 * Статистика раскроя и стоимость работ выбранного производства.
 * mats — [{ sheets, details, result, thickness }] (один материал или все материалы заказа).
 * У оформленного заказа берётся цена, зафиксированная при оформлении (quote.fixed); если её нет — считается по текущему прайс-листу.
 * -> { stats, quote }: quote === undefined — считается, null — цен нет (скрыты или нет производства), { empty } — прайс не заполнен.
 */
export function useNestingQuote({ order, mats, method, productionId, enabled = true }) {
  const list = (mats || []).filter(Boolean)
  const sig = !enabled ? 'off' : list.map(m => `${idOf(m.sheets)}:${idOf(m.details)}:${idOf(m.result)}:${m.thickness || ''}`).join('|')
    + `|${method}|${order?.sheet_length}x${order?.sheet_width}|${order?.kerf_width}|${order?.margin_left},${order?.margin_right},${order?.margin_top},${order?.margin_bottom}|${JSON.stringify(order?.edge_types ?? '')}`
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stats = useMemo(() => (enabled ? sumStats(list.map(mat => nestingStats({ order, mat, method }))) : null), [sig])
  const payload = useMemo(() => (stats && stats.parts ? JSON.stringify(statsPayload(stats)) : ''), [stats])
  const [state, setState] = useState({ key: '', quote: undefined })
  const fixedId = order?.id && order.status && order.status !== 'draft' ? order.id : ''
  const key = productionId && payload ? `${productionId}|${fixedId}|${payload}` : ''
  useEffect(() => {
    if (!key) return
    let alive = true
    const t = setTimeout(async () => {
      let q = fixedId ? await fetchFixedQuote(fixedId) : null
      if (!q) q = await fetchQuote(productionId, JSON.parse(payload))
      else if (q.hidden) q = null
      if (alive) setState({ key, quote: q })
    }, 350)
    return () => { alive = false; clearTimeout(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return { stats, quote: !key ? null : state.key === key ? state.quote : undefined }
}
