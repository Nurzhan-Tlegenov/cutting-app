// Просьба пользователя «убрать тестовый заказ из итогов» в карточке обращения поддержки (мастер-аккаунт):
// те же кнопки, что были в «Сообщениях» — «Убрать из итогов» / «Вернуть в итоги», «Итоги производства».
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { adminProductionOrders } from '../lib/adminApi'
import { productionExcludeStats } from '../lib/productionApi'
import { orderTitle } from '../lib/orderUtils'

let cache = null        // заказы производств — один раз на открытую карточку (кнопок может быть несколько)

export default function ExcludeStatsRequest({ req, onDone, onError }) {
  const navigate = useNavigate()
  const [orders, setOrders] = useState(cache)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (orders) return
    let alive = true
    adminProductionOrders().then(r => {
      if (!alive) return
      if (r.error) { onError?.(r.error); setOrders([]); return }
      cache = r.data || []
      setOrders(cache)
    })
    return () => { alive = false }
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps
  const btn = { padding: '4px 10px', fontSize: 12, borderRadius: 'var(--radius)', border: '0.5px solid var(--border-md)', background: 'var(--bg)', cursor: 'pointer' }
  if (!orders) return <div style={{ fontSize: 12, color: 'var(--text-hint)', marginTop: 6 }}>ищем заказ…</div>
  const same = req.orderId ? orders.filter(o => o.id === req.orderId) : orders.filter(o => o.order_number === req.num)
  const o = same.length === 1 ? same[0] : same.find(x => x.status === 'done') || same[0] || null
  if (!o) return <button type="button" style={{ ...btn, marginTop: 6 }} onClick={() => navigate(`/all-productions?num=${encodeURIComponent(req.num)}`)}>Заказ не найден — открыть итоги</button>
  const set = async on => {
    if (on && !window.confirm(`Убрать заказ «${orderTitle(o)}»${o.order_number ? ` (№ ${o.order_number})` : ''} из итогов как тестовый?\nЕго сумма, листы и работы не будут считаться.`)) return
    setBusy(true)
    const r = await productionExcludeStats(o.id, on)
    setBusy(false)
    if (r.error) { onError?.(r.error); return }
    cache = (cache || []).map(x => (x.id === o.id ? { ...x, excluded: on } : x))
    setOrders(cache)
    onDone?.(o, on)
  }
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 }}>
      {o.excluded
        ? <><span style={{ fontSize: 12, color: 'var(--teal)' }}>✓ Уже не в итогах</span>
            <button type="button" style={btn} disabled={busy} onClick={() => set(false)}>Вернуть в итоги</button></>
        : <button type="button" style={{ ...btn, color: 'white', background: 'var(--amber)', borderColor: 'var(--amber)' }} disabled={busy} onClick={() => set(true)}>Убрать из итогов</button>}
      <button type="button" style={btn} onClick={() => navigate(`/all-productions?order=${o.id}`)}>Итоги производства</button>
    </div>
  )
}
