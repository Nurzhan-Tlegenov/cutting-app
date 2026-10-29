// «Чьи деловые остатки этого раскроя?» — у бирок и программ ЧПУ. Мои (производства) — сами попадают на склад
// остатков без ячейки (её потом впишут сканом бирки), без дублей при повторном выпуске; остатки клиента — бирки
// печатаются, на склад не идут. Выбор хранится в заказе (orders.offcuts_owner).
import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { stockFromNesting, nestingRemnants } from '../lib/stock'

export default function OffcutOwner({ order, mats, onChange }) {
  const { user } = useAuth()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [can, setCan] = useState(false)          // выбор — только у производства (его склад)
  useEffect(() => {
    let alive = true
    ;(async () => {
      let pid = order?.production_id
      if (!pid && user?.id) { const { data } = await supabase.from('productions').select('id').eq('owner_id', user.id).maybeSingle(); pid = data?.id }
      if (!pid) return
      const { data, error } = await supabase.rpc('stock_access', { p_prod: pid })
      if (alive && !error && data) setCan(true)
    })()
    return () => { alive = false }
  }, [order?.production_id, user?.id])
  const n = nestingRemnants(order, mats).length
  if (!order || !n || !can) return null
  const cur = order.offcuts_owner || ''
  const set = async v => {
    if (v === cur || busy) return
    setBusy(true); setMsg('')
    const r = await stockFromNesting(order.id, v, v === 'production' ? nestingRemnants(order, mats) : [])
    setBusy(false)
    if (r.error) { setMsg(r.missing ? r.error : 'Не получилось: ' + r.error); return }
    onChange?.(v)
    const a = r.data?.added || 0, d = r.data?.removed || 0
    setMsg(v === 'production' ? `На склад остатков: +${a}${d ? `, убрано старых ${d}` : ''}. Ячейку впишут сканом бирки.` : `Остатки клиента — на склад не идут${d ? ` (убрано со склада: ${d})` : ''}.`)
  }
  const b = on => ({ flex: 1, padding: '7px 10px', borderRadius: 16, border: on ? 'none' : '0.5px solid var(--border-md)', fontSize: 12.5, cursor: 'pointer', background: on ? 'var(--blue)' : 'transparent', color: on ? 'white' : 'var(--text)' })
  return (
    <div className="no-print" style={{ margin: '0 0 10px', padding: '8px 10px', border: `0.5px solid ${cur ? 'var(--border-md)' : 'var(--amber)'}`, borderRadius: 'var(--radius)' }}>
      <div style={{ fontSize: 12.5, fontWeight: 500, marginBottom: 6 }}>Деловые остатки этого раскроя ({n} шт) — чьи?{!cur && <span style={{ color: 'var(--amber)', fontWeight: 400 }}> не выбрано</span>}</div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" disabled={busy} style={b(cur === 'production')} onClick={() => set('production')}>Мои — на склад</button>
        <button type="button" disabled={busy} style={b(cur === 'client')} onClick={() => set('client')}>Клиента — не на склад</button>
      </div>
      {msg && <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 5 }}>{msg}</div>}
    </div>
  )
}
