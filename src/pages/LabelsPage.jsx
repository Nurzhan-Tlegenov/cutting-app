import { useEffect, useMemo, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { savedNestings } from '../lib/savedNesting'
import { detailMeta } from '../lib/partLabel'
import { isTwoSided } from '../lib/partInfo'

// Бирки деталей по принятому раскрою — по листам, в порядке укладки. Первая версия: просмотр и печать.
const EDGES = [['edge_left', 'Дл'], ['edge_right', 'Дп'], ['edge_top', 'Шв'], ['edge_bottom', 'Шн']]
const CSS = `
.lbl-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.lbl { border: 1px solid #2C2C2A; border-radius: 4px; padding: 6px 8px; background: #fff; font-size: 11px; line-height: 1.35; break-inside: avoid; }
.lbl b { font-size: 13px; }
@media print {
  .no-print, .bottom-nav { display: none !important; }
  body { background: #fff; }
  .page { max-width: none; padding: 0; }
  .lbl-sheet { break-before: page; }
  .lbl-sheet:first-of-type { break-before: auto; }
}`

export default function LabelsPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [order, setOrder] = useState(null)
  const [details, setDetails] = useState([])
  const [loading, setLoading] = useState(true)
  const [matKey, setMatKey] = useState('')
  useEffect(() => {
    let alive = true
    ;(async () => {
      const { data: o } = await supabase.from('orders').select('*').eq('id', id).single()
      const { data: d } = await supabase.from('order_details').select('*').eq('order_id', id).order('sort_order')
      if (alive) { setOrder(o || null); setDetails(d || []); setLoading(false) }
    })()
    return () => { alive = false }
  }, [id])
  const mats = useMemo(() => savedNestings(order, details), [order, details])
  const mat = mats.find(m => m.key === matKey) || mats[0] || null
  if (loading) return <div className="page"><p style={{ color: 'var(--text-hint)', paddingTop: 40 }}>Загрузка...</p></div>
  if (!order) return <div className="page"><p>Заказ не найден</p></div>
  const total = mat ? mat.sheets.reduce((a, s) => a + s.placed.length, 0) : 0
  return (
    <div className="page" style={{ paddingBottom: 40 }}>
      <style>{CSS}</style>
      <div className="no-print" style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, paddingTop: 4 }}>
        <button onClick={() => navigate(-1)} style={{ background: 'none', border: 'none', color: 'var(--blue)', fontSize: 22, padding: 0 }}>←</button>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 500 }}>Бирки</div>
          <div style={{ fontSize: 12, color: 'var(--text-hint)' }}><span style={{ fontFamily: 'monospace' }}>{order.order_number}</span> · {total} шт.</div>
        </div>
        {mat && <button onClick={() => window.print()} style={{ padding: '8px 14px', borderRadius: 20, border: 'none', background: 'var(--blue)', color: 'white', fontSize: 13 }}>🖨 Печать</button>}
      </div>
      {!mat && <div className="card no-print"><p style={{ fontSize: 13, color: 'var(--text-muted)' }}>У заказа нет сохранённого раскроя — бирки строятся по листам раскроя.</p></div>}
      {mats.length > 1 && (
        <select className="no-print" value={mat.key} onChange={e => setMatKey(e.target.value)} style={{ marginBottom: 10 }}>
          {mats.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
        </select>
      )}
      {mat && mat.sheets.map((sh, si) => (
        <div key={si} className="lbl-sheet" style={{ marginBottom: 14 }}>
          <p className="section-title">{sh.stock === 'offcut' ? 'Обрезок' : 'Лист'} {si + 1} · {sh.placed.length} дет.</p>
          <div className="lbl-grid">
            {sh.placed.map((p, pi) => {
              const d = mat.details[p.detailIndex] || {}, m = detailMeta(d) || {}
              const edges = EDGES.filter(([k]) => d[k]).map(([k, l]) => `${l}${d[k] && d[k] !== 'default' && d[k] !== true ? ' ' + d[k] : ''}`)
              return (
                <div key={pi} className="lbl">
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, color: '#5F5E5A' }}>
                    <span style={{ fontFamily: 'monospace' }}>{order.order_number}</span><span>Л{si + 1}·{pi + 1}</span>
                  </div>
                  <div><b>{m.des ? m.des + ' ' : ''}{d.name || p.label || 'Деталь'}</b></div>
                  {d.prefix && <div style={{ color: '#185FA5' }}>{d.prefix}</div>}
                  <div style={{ fontSize: 13 }}>{d.length}×{d.width}{mat.thickness ? `×${mat.thickness}` : ''}</div>
                  <div style={{ color: '#5F5E5A' }}>{mat.name || '—'}{m.pos ? ` · поз. ${m.pos}` : ''}</div>
                  <div>Кромка: {edges.length ? edges.join(', ') : 'нет'}</div>
                  {isTwoSided(d, mat.thickness) && <div style={{ color: '#7B1FA2' }}>⇅ обработка с двух сторон</div>}
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
