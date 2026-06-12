import { useState, useEffect, useRef } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import BottomNav from '../components/BottomNav'

const SHEET_DEFAULTS = {
  length: 2750, width: 1830,
  margin_top: 15, margin_left: 15, margin_bottom: 10, margin_right: 10,
  kerf: 4
}

function NumInput({ value, onChange, placeholder, inputRef }) {
  return (
    <input ref={inputRef} type="text" inputMode="numeric" pattern="[0-9]*"
      value={value} placeholder={placeholder}
      onChange={e => {
        const v = e.target.value.replace(/[^0-9]/g, '')
        onChange(v === '' ? '' : Number(v))
      }} />
  )
}

function EdgeBtn({ active, label, onClick, vertical, flipText }) {
  return (
    <button type="button" onClick={onClick} style={{
      border: active ? '1.5px solid var(--blue)' : '0.5px solid var(--border-md)',
      borderRadius: 'var(--radius)', background: active ? 'var(--blue-light)' : 'var(--bg2)',
      color: active ? 'var(--blue-dark)' : 'var(--text-hint)', fontWeight: active ? 500 : 400,
      fontSize: 10, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
      gap: 3, transition: 'all 0.15s', width: '100%', height: '100%',
    }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', flexShrink: 0, background: active ? 'var(--blue)' : 'var(--border-md)' }} />
      {vertical ? <span style={{ writingMode: 'vertical-rl', transform: flipText ? 'rotate(180deg)' : 'none', fontSize: 10 }}>{label}</span> : label}
    </button>
  )
}

function Toggle({ on }) {
  return (
    <div style={{ width: 36, height: 20, borderRadius: 10, background: on ? 'var(--blue)' : 'var(--border-md)', position: 'relative', transition: 'background 0.2s', flexShrink: 0 }}>
      <div style={{ width: 16, height: 16, borderRadius: '50%', background: 'white', position: 'absolute', top: 2, left: on ? 18 : 2, transition: 'left 0.2s' }} />
    </div>
  )
}

function DetailCard({ detail, index, onUpdate, onRemove, activeEdgeName, showEdge, autoFocus }) {
  const SIDES = ['Д1','Д2','Ш1','Ш2']
  const KEYS = ['top','bottom','left','right']
  const lengthRef = useRef(null)

  useEffect(() => {
    if (autoFocus && lengthRef.current) {
      setTimeout(() => { lengthRef.current?.focus(); lengthRef.current?.select() }, 50)
    }
  }, [autoFocus])

  const toggleEdge = (key) => {
    const newEdges = { ...detail.edges }
    if (activeEdgeName) {
      newEdges[key] = newEdges[key] === activeEdgeName ? null : activeEdgeName
    } else {
      newEdges[key] = newEdges[key] ? null : 'default'
    }
    onUpdate({ ...detail, edges: newEdges })
  }

  return (
    <div className="card" style={{ marginBottom: 8, padding: '10px 12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ fontSize: 12, color: 'var(--text-hint)', minWidth: 22 }}>#{index + 1}</div>
        <div style={{ display: 'flex', gap: 4, flex: 1 }}>
          <NumInput value={detail.w} placeholder="Длина" onChange={v => onUpdate({ ...detail, w: v })} inputRef={lengthRef} />
          <NumInput value={detail.h} placeholder="Ширина" onChange={v => onUpdate({ ...detail, h: v })} />
          <div style={{ width: 60, flexShrink: 0 }}>
            <NumInput value={detail.qty} placeholder="Кол" onChange={v => onUpdate({ ...detail, qty: v })} />
          </div>
        </div>
        <button type="button" onClick={onRemove}
          style={{ background: 'none', border: 'none', color: 'var(--text-hint)', fontSize: 18, cursor: 'pointer', padding: 0, lineHeight: 1, flexShrink: 0 }}>✕</button>
      </div>
      {showEdge && (
        <div style={{ display: 'flex', gap: 4, marginTop: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: 'var(--text-hint)', minWidth: 44 }}>Кромка:</span>
          {SIDES.map((side, i) => {
            const key = KEYS[i]
            const val = detail.edges[key]
            return (
              <button key={key} type="button" onClick={() => toggleEdge(key)}
                style={{ flex: 1, padding: '5px 2px', border: val ? '1.5px solid var(--blue)' : '0.5px solid var(--border-md)',
                  borderRadius: 'var(--radius)', background: val ? 'var(--blue-light)' : 'transparent',
                  fontSize: 10, color: val ? 'var(--blue-dark)' : 'var(--text-hint)', cursor: 'pointer', textAlign: 'center', lineHeight: 1.3 }}>
                <div>{side}</div>
                {val && <div style={{ fontSize: 9, fontWeight: 500, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{val === 'default' ? '✓' : val}</div>}
              </button>
            )
          })}
          <button type="button" onClick={() => onUpdate({ ...detail, rotatable: !detail.rotatable })}
            style={{ padding: '5px 6px', border: detail.rotatable ? '1.5px solid var(--teal)' : '0.5px solid var(--border-md)',
              borderRadius: 'var(--radius)', background: detail.rotatable ? 'var(--teal-light)' : 'transparent',
              fontSize: 10, color: detail.rotatable ? 'var(--teal)' : 'var(--text-hint)', cursor: 'pointer', flexShrink: 0 }}>↻</button>
        </div>
      )}
      {!showEdge && Object.entries(detail.edges).some(([,v]) => v) && (
        <div style={{ marginTop: 4, fontSize: 10, color: 'var(--blue)' }}>
          {[['top','Д1'],['bottom','Д2'],['left','Ш1'],['right','Ш2']].filter(([k]) => detail.edges[k]).map(([k,s]) => `${s}:${detail.edges[k] === 'default' ? '✓' : detail.edges[k]}`).join('  ')}
        </div>
      )}
    </div>
  )
}

function PrefixManager({ prefixes, active, onChange, onSetActive }) {
  const [input, setInput] = useState('')
  const add = () => {
    const val = input.trim()
    if (!val || prefixes.includes(val)) return
    onChange([...prefixes, val]); onSetActive(val); setInput('')
  }
  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <input type="text" placeholder="Кухня / Шкаф / Прихожая" value={input}
          onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()} style={{ flex: 1 }} />
        <button type="button" onClick={add} style={{ padding: '0 14px', background: 'var(--blue)', color: 'white', border: 'none', borderRadius: 'var(--radius)', cursor: 'pointer', fontSize: 20, lineHeight: 1 }}>+</button>
      </div>
      {prefixes.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <button type="button" onClick={() => onSetActive(null)}
            style={{ padding: '5px 12px', borderRadius: 20, fontSize: 12, border: '0.5px solid var(--border-md)', background: !active ? 'var(--text)' : 'transparent', color: !active ? 'white' : 'var(--text-muted)', cursor: 'pointer' }}>Без префикса</button>
          {prefixes.map(p => (
            <button key={p} type="button" onClick={() => onSetActive(p)}
              style={{ padding: '5px 12px', borderRadius: 20, fontSize: 12, border: '0.5px solid var(--border-md)', background: active === p ? 'var(--blue)' : 'transparent', color: active === p ? 'white' : 'var(--text-muted)', cursor: 'pointer' }}>{p}</button>
          ))}
        </div>
      )}
    </div>
  )
}

function EdgeManager({ edgeNames, activeEdge, onChange, onSetActive }) {
  const [input, setInput] = useState('')
  const add = () => {
    const val = input.trim()
    if (!val || edgeNames.includes(val)) return
    onChange([...edgeNames, val]); onSetActive(val); setInput('')
  }
  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <input type="text" placeholder="ПВХ 0.4мм / ПВХ 2мм / ABS" value={input}
          onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()} style={{ flex: 1 }} />
        <button type="button" onClick={add} style={{ padding: '0 14px', background: 'var(--blue)', color: 'white', border: 'none', borderRadius: 'var(--radius)', cursor: 'pointer', fontSize: 20, lineHeight: 1 }}>+</button>
      </div>
      {edgeNames.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {edgeNames.map(e => (
            <button key={e} type="button" onClick={() => onSetActive(activeEdge === e ? null : e)}
              style={{ padding: '5px 12px', borderRadius: 20, fontSize: 12, border: '0.5px solid var(--border-md)', background: activeEdge === e ? 'var(--blue)' : 'transparent', color: activeEdge === e ? 'white' : 'var(--text-muted)', cursor: 'pointer' }}>{e}</button>
          ))}
        </div>
      )}
    </div>
  )
}

let uid = 0
function makeDetail(d) {
  uid++
  return {
    uid, dbId: d?.id || null,
    w: d?.length || '', h: d?.width || '', qty: d?.qty || '',
    prefix: d?.prefix || null,
    edges: { top: d?.edge_top || null, right: d?.edge_right || null, bottom: d?.edge_bottom || null, left: d?.edge_left || null },
    rotatable: d?.rotatable || false
  }
}

export default function EditOrderPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const [orderName, setOrderName] = useState('')
  const [materialName, setMaterialName] = useState('')
  const [prefixes, setPrefixes] = useState([])
  const [activePrefix, setActivePrefix] = useState(null)
  const [edgeNames, setEdgeNames] = useState([])
  const [activeEdge, setActiveEdge] = useState(null)
  const [details, setDetails] = useState([])
  const [showEdge, setShowEdge] = useState(true)
  const [lastAddedUid, setLastAddedUid] = useState(null)

  useEffect(() => { fetchOrder() }, [id])

  async function fetchOrder() {
    const { data: o } = await supabase.from('orders').select('*').eq('id', id).single()
    const { data: d } = await supabase.from('order_details').select('*').eq('order_id', id).order('sort_order')
    if (o) {
      setOrderName(o.order_name || '')
      setMaterialName(o.material_name || '')
    }
    if (d && d.length > 0) {
      // Восстанавливаем префиксы
      const pfxSet = [...new Set(d.filter(x => x.prefix).map(x => x.prefix))]
      setPrefixes(pfxSet)
      setDetails(d.map(makeDetail))
      // Восстанавливаем кромки
      const edgeSet = new Set()
      d.forEach(x => {
        if (x.edge_top && x.edge_top !== 'default') edgeSet.add(x.edge_top)
        if (x.edge_right && x.edge_right !== 'default') edgeSet.add(x.edge_right)
        if (x.edge_bottom && x.edge_bottom !== 'default') edgeSet.add(x.edge_bottom)
        if (x.edge_left && x.edge_left !== 'default') edgeSet.add(x.edge_left)
      })
      setEdgeNames([...edgeSet])
    }
    setLoading(false)
  }

  const addDetail = () => {
    const d = { ...makeDetail(null), prefix: activePrefix }
    setLastAddedUid(d.uid)
    setDetails(prev => [...prev, d])
  }
  const removeDetail = (u) => setDetails(d => d.filter(x => x.uid !== u))
  const updateDetail = (u, updated) => setDetails(d => d.map(x => x.uid === u ? updated : x))

  const grouped = details.reduce((acc, d) => {
    const key = d.prefix || ''
    if (!acc[key]) acc[key] = []
    acc[key].push(d)
    return acc
  }, {})

  async function handleSave() {
    const valid = details.filter(d => Number(d.w) > 0 && Number(d.h) > 0)
    if (!valid.length) { setError('Добавьте хотя бы одну деталь с размерами'); return }
    setSaving(true); setError('')
    try {
      // Обновляем заказ
      const { error: oErr } = await supabase.from('orders').update({
        order_name: orderName || null,
        material_name: materialName || 'Без названия',
        nesting_result: null
      }).eq('id', id)
      if (oErr) throw new Error('Ошибка обновления заказа: ' + oErr.message)

      // Удаляем старые детали
      const { error: dErr } = await supabase.from('order_details').delete().eq('order_id', id)
      if (dErr) throw new Error('Ошибка удаления деталей: ' + dErr.message)

      // Вставляем только заполненные детали
      let sortIdx = 0
      const rows = valid.map((d) => {
        const pfx = d.prefix || null
        const name = `Деталь ${sortIdx + 1}`
        sortIdx++
        return {
          order_id: id, prefix: pfx, name,
          display_name: pfx ? `${pfx} ${name}` : name,
          length: Number(d.w), width: Number(d.h), qty: Number(d.qty) || 1,
          edge_top: d.edges.top || null, edge_right: d.edges.right || null,
          edge_bottom: d.edges.bottom || null, edge_left: d.edges.left || null,
          rotatable: d.rotatable, sort_order: sortIdx - 1
        }
      })

      const { error: iErr } = await supabase.from('order_details').insert(rows)
      if (iErr) throw new Error('Ошибка сохранения деталей: ' + iErr.message)

      navigate(`/orders/${id}`)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const validCount = details.filter(d => d.w > 0 && d.h > 0).length

  if (loading) return <div className="page"><p style={{ color: 'var(--text-hint)', paddingTop: 40, textAlign: 'center' }}>Загрузка...</p></div>

  return (
    <div className="page" style={{ paddingBottom: 100 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, paddingTop: 8 }}>
        <button type="button" onClick={() => navigate(`/orders/${id}`)}
          style={{ background: 'none', border: 'none', color: 'var(--blue)', fontSize: 22, padding: 0, lineHeight: 1, cursor: 'pointer' }}>←</button>
        <h1 style={{ fontSize: 18, fontWeight: 500 }}>Редактирование заказа</h1>
      </div>

      <div style={{ marginBottom: 14 }}>
        <p className="section-title">Название заказа</p>
        <div className="card">
          <input type="text" placeholder="Например: Кухня Ивановых" value={orderName}
            onChange={e => setOrderName(e.target.value)} style={{ marginBottom: 10 }} />
          <label className="label">Материал</label>
          <input type="text" placeholder="ЛДСП Белый 16мм" value={materialName}
            onChange={e => setMaterialName(e.target.value)} />
        </div>
      </div>

      <div style={{ marginBottom: 14 }}>
        <p className="section-title">Параметры листа</p>
        <div className="card" style={{ background: 'var(--bg2)' }}>
          <div className="row2" style={{ marginBottom: 6 }}>
            <div><label className="label">Длина</label><div style={{ fontWeight: 500, color: 'var(--text-muted)' }}>{SHEET_DEFAULTS.length} мм</div></div>
            <div><label className="label">Ширина</label><div style={{ fontWeight: 500, color: 'var(--text-muted)' }}>{SHEET_DEFAULTS.width} мм</div></div>
          </div>
          <p style={{ fontSize: 11, color: 'var(--text-hint)' }}>Устанавливает производство</p>
        </div>
      </div>

      <div style={{ marginBottom: 14 }}>
        <p className="section-title">Префиксы групп</p>
        <div className="card">
          <PrefixManager prefixes={prefixes} active={activePrefix} onChange={setPrefixes} onSetActive={setActivePrefix} />
        </div>
      </div>

      <div style={{ marginBottom: 14 }}>
        <p className="section-title">Виды кромки</p>
        <div className="card">
          <EdgeManager edgeNames={edgeNames} activeEdge={activeEdge} onChange={setEdgeNames} onSetActive={setActiveEdge} />
        </div>
      </div>

      <div style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <p className="section-title" style={{ marginBottom: 0 }}>Детали ({details.length})</p>
          <button type="button" onClick={() => setShowEdge(v => !v)}
            style={{ fontSize: 12, color: 'var(--blue)', background: 'none', border: '0.5px solid var(--blue-mid)', borderRadius: 20, padding: '3px 10px', cursor: 'pointer' }}>
            {showEdge ? 'Скрыть кромку' : 'Показать кромку'}
          </button>
        </div>
        <div style={{ display: 'flex', gap: 8, paddingLeft: 30, paddingRight: 28, marginBottom: 4 }}>
          <div style={{ flex: 1, fontSize: 11, color: 'var(--text-hint)' }}>Длина</div>
          <div style={{ flex: 1, fontSize: 11, color: 'var(--text-hint)' }}>Ширина</div>
          <div style={{ width: 60, fontSize: 11, color: 'var(--text-hint)' }}>Кол-во</div>
        </div>

        {Object.entries(grouped).map(([pfx, dets]) => (
          <div key={pfx}>
            {pfx && <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--blue)', marginBottom: 4, marginTop: 8, padding: '4px 8px', background: 'var(--blue-light)', borderRadius: 'var(--radius)', display: 'inline-block' }}>{pfx}</div>}
            {dets.map((d) => {
              const globalIndex = details.findIndex(x => x.uid === d.uid)
              return (
                <DetailCard key={d.uid} detail={d} index={globalIndex}
                  onUpdate={u => updateDetail(d.uid, u)}
                  onRemove={() => removeDetail(d.uid)}
                  activeEdgeName={activeEdge} showEdge={showEdge}
                  autoFocus={d.uid === lastAddedUid} />
              )
            })}
          </div>
        ))}

        <button type="button" onClick={addDetail}
          style={{ width: '100%', padding: 10, border: '0.5px dashed var(--border-md)', borderRadius: 'var(--radius)', background: 'transparent', color: 'var(--text-hint)', fontSize: 14, cursor: 'pointer', marginTop: 4 }}>
          + Добавить деталь {activePrefix ? `(${activePrefix})` : ''}
        </button>
      </div>

      <div style={{ background: 'var(--amber-light)', border: '0.5px solid var(--amber)', borderRadius: 'var(--radius)', padding: '10px 12px', marginBottom: 12, fontSize: 13, color: 'var(--amber)' }}>
        ⚠ После сохранения раскрой будет сброшен — нужно выполнить заново
      </div>

      {error && <p className="error-text" style={{ marginBottom: 12 }}>{error}</p>}

      <button type="button" className="btn-primary" onClick={handleSave} disabled={saving || !validCount}>
        {saving ? 'Сохранение...' : `Сохранить изменения (${validCount} дет.)`}
      </button>
      <BottomNav />
    </div>
  )
}
