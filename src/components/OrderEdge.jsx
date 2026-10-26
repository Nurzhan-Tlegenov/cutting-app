// Метраж кромки заказа — в карточках заказов у сотрудников производства (начальник производства, посты): видно сразу,
// сколько кромки нужно на заказ, без вопроса руководителю. Считается так же, как в статистике заказа: по готовым деталям,
// со свесами (edgeTotals). Детали заказа подгружаются один раз и запоминаются.
import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { edgeTotals } from '../lib/edgeLength'
import { rawDetail, overMm, parseEdgeTypes } from '../lib/edgeCut'

const cache = new Map()   // orderId -> Promise<{ total, curved } | null>
function loadEdge(orderId) {
  if (!cache.has(orderId)) {
    cache.set(orderId, (async () => {
      try {
        const [{ data: o }, { data: d, error }] = await Promise.all([
          supabase.from('orders').select('edge_types').eq('id', orderId).maybeSingle(),
          supabase.from('order_details').select('*').eq('order_id', orderId),
        ])
        if (error || !d) return null
        const t = edgeTotals(d.map(rawDetail), overMm(parseEdgeTypes(o?.edge_types)))
        return { total: t.total || 0, curved: t.curved || 0 }
      } catch { return null }
    })())
  }
  return cache.get(orderId)
}

/** «кромка 167,89 м» (пусто — у заказа нет кромки или детали не прочитались) */
export default function OrderEdge({ orderId, prefix = ' · ', style }) {
  const [v, setV] = useState(null)
  useEffect(() => { let on = true; loadEdge(orderId).then(r => { if (on) setV(r) }); return () => { on = false } }, [orderId])
  if (!v || !(v.total > 0)) return null
  const n = x => (Math.round(x * 100) / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })
  return <span style={style}>{prefix}кромка {n(v.total)} м{v.curved > 0 ? ` (крив. ${n(v.curved)})` : ''}</span>
}
