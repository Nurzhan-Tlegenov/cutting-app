// β-постпроцессор: просмотр деталей заказа прямо в настройках станка. Меняете настройку ниже — схема деталей
// перестраивается сразу (правила положения, присадка, фрезеровка). Повернуть / перевернуть деталь — тут же.
import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { fetchOrderDetails } from '../lib/orderDetails'
import { cutDetails, parseEdgeTypes } from '../lib/edgeCut'
import { detailMatKey } from '../lib/detailMaterial'
import { orderTitle } from '../lib/orderUtils'
import { getUserSettings, saveUserSettings } from '../lib/userSettings'
import Drill6PartsView from './Drill6PartsView'

const COLS = 'id, order_number, order_name, edge_types, material_name, material_thickness, created_at'

export default function Drill6LivePreview({ post }) {
  const { user } = useAuth()
  const [orders, setOrders] = useState(null)
  const [orderId, setOrderId] = useState(() => getUserSettings(user).d6PreviewOrder || '')
  const [order, setOrder] = useState(null)
  const [details, setDetails] = useState(null)
  const [matKey, setMatKey] = useState('')
  const [man, setMan] = useState(() => getUserSettings(user).d6Man || {})
  const [err, setErr] = useState('')
  useEffect(() => {
    let alive = true
    ;(async () => {
      let r = await supabase.from('orders').select(COLS).order('created_at', { ascending: false }).limit(40)
      if (r.error) r = await supabase.from('orders').select('id, order_number, order_name, edge_types, material_name, created_at').order('created_at', { ascending: false }).limit(40)
      if (alive) { if (r.error) setErr(r.error.message); setOrders(r.data || []) }
    })()
    return () => { alive = false }
  }, [])
  useEffect(() => {
    if (!orderId || !orders) return
    let alive = true
    const o = orders.find(x => x.id === orderId)
    if (!o) return
    fetchOrderDetails(orderId).then(({ data, error }) => {
      if (!alive) return
      if (error) { setErr(error.message); return }
      setErr(''); setOrder(o); setDetails(cutDetails(data || [], parseEdgeTypes(o.edge_types)))
    })
    return () => { alive = false }
  }, [orderId, orders])
  // материалы заказа: по каждому — свои детали и толщина
  const mats = useMemo(() => {
    const m = new Map()
    for (const d of details || []) {
      const key = detailMatKey(d, order)
      if (!m.has(key)) { const [name, th] = key.split('|'); m.set(key, { key, name: name || 'Без материала', thickness: Number(th) || 16, details: [] }) }
      m.get(key).details.push(d)
    }
    return [...m.values()]
  }, [details, order])
  const mat = mats.find(x => x.key === matKey) || mats[0] || null
  const pick = id => { setDetails(null); setOrderId(id); setMatKey(''); saveUserSettings({ d6PreviewOrder: id }, user) }
  const onMan = next => { setMan(next); saveUserSettings({ d6Man: next }, user) }
  return (
    <div style={{ position: 'sticky', top: 0, zIndex: 5, background: 'var(--bg)', border: '1px solid var(--amber)', borderRadius: 12, padding: '8px 10px', margin: '8px 0', maxHeight: '55vh', overflowY: 'auto' }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>👁 Детали на станке — сразу с этими настройками</div>
      <select value={orderId} onChange={e => pick(e.target.value)} style={{ width: '100%', padding: '7px 8px', fontSize: 13 }}>
        <option value="">— выберите заказ —</option>
        {(orders || []).map(o => <option key={o.id} value={o.id}>{o.order_number} · {orderTitle(o)}</option>)}
      </select>
      {err && <div style={{ fontSize: 12, color: 'var(--danger)', marginTop: 4 }}>{err}</div>}
      {orderId && !details && !err && <div style={{ fontSize: 12, color: 'var(--text-hint)', marginTop: 6 }}>Загружаем детали…</div>}
      {mats.length > 1 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
          {mats.map(m => <button key={m.key} type="button" onClick={() => setMatKey(m.key)} style={{ padding: '5px 10px', borderRadius: 14, fontSize: 12, border: '0.5px solid ' + (m.key === mat?.key ? 'var(--blue)' : 'var(--border-md)'), background: m.key === mat?.key ? 'var(--blue-light)' : 'transparent', color: 'var(--text)', cursor: 'pointer' }}>{m.name} · {m.thickness} мм</button>)}
        </div>
      )}
      {mat && <div style={{ marginTop: 6 }}><Drill6PartsView mat={mat} order={order} post={post} man={man} onMan={onMan} maxWidth={Math.min(520, (typeof window !== 'undefined' ? window.innerWidth : 400) - 60)} /></div>}
      {!orderId && <div style={{ fontSize: 11.5, color: 'var(--text-hint)', marginTop: 6 }}>Выберите заказ — увидите каждую деталь так, как она ляжет на станок: присадку, пазы, вырезы, лапы и упор. Повёрнутое здесь — так же выйдет в программе.</div>}
    </div>
  )
}
