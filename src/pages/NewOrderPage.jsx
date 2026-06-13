import { useState, useRef, useEffect } from 'react'
import ContourEditor from '../components/ContourEditor'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { getNextOrderNumber } from '../lib/orderUtils'
import BottomNav from '../components/BottomNav'

const SHEET_DEFAULTS = {
  length: 2750, width: 1830,
  margin_top: 15, margin_left: 15, margin_bottom: 10, margin_right: 10,
  kerf: 4
}

const NumInput = ({ value, onChange, placeholder, inputRef, onEnter, hint }) => {
  return (
    <input
      ref={inputRef}
      type="text" inputMode="numeric" pattern="[0-9]*"
      value={value} placeholder={placeholder}
      enterKeyHint={hint || (onEnter ? 'next' : 'done')}
      style={{ fontSize: 14, padding: '5px 6px' }}
      onChange={e => {
        const v = e.target.value.replace(/[^0-9]/g, '')
        onChange(v === '' ? '' : Number(v))
      }}
      onKeyDown={e => {
        if (e.key === 'Enter') {
          e.preventDefault()
          onEnter?.()
        }
      }}
    />
  )
}

// Компактная карточка детали
function DetailCard({ detail, index, onUpdate, onRemove, activeEdgeName, showEdge, autoFocus, onQtyEnter }) {
  const widthRef = useRef(null)
  const qtyRef = useRef(null)
  const SIDES = ['Д1','Д2','Ш1','Ш2']
  const KEYS = ['top','bottom','left','right']
  const lengthRef = useRef(null)
  const [showContour, setShowContour] = useState(false)

  const hasContour = detail.contour && (
    Object.values(detail.contour.corners || {}).some(c => c?.type && c.type !== 'none') ||
    (detail.contour.cutouts || []).length > 0 ||
    (detail.contour.grooves || []).length > 0
  )

  useEffect(() => {
    if (autoFocus && lengthRef.current) {
      // Используем requestAnimationFrame чтобы не гасить клавиатуру
      const raf = requestAnimationFrame(() => {
        lengthRef.current?.focus({ preventScroll: true })
        lengthRef.current?.select()
      })
      return () => cancelAnimationFrame(raf)
    }
  }, [autoFocus])

  const toggleEdge = (key) => {
    const newEdges = { ...detail.edges }
    if (activeEdgeName) {
      // Если текущая сторона уже этой кромкой — снимаем, иначе ставим
      newEdges[key] = newEdges[key] === activeEdgeName ? null : activeEdgeName
    } else {
      newEdges[key] = newEdges[key] ? null : 'default'
    }
    onUpdate({ ...detail, edges: newEdges })
  }

  return (
    <div className="card" style={{ marginBottom: 4, padding: '6px 10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {/* Номер + кнопка контура */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 28 }}>
          <div style={{ fontSize: 12, color: 'var(--text-hint)' }}>#{index + 1}</div>
          <button type="button" onClick={() => setShowContour(v => !v)}
            title="Редактор контура"
            style={{ background: hasContour ? 'var(--teal-light)' : 'var(--bg2)',
              border: `0.5px solid ${hasContour ? 'var(--teal)' : 'var(--border-md)'}`,
              borderRadius: 4, cursor: 'pointer', fontSize: 11, padding: '1px 3px',
              color: hasContour ? 'var(--teal)' : 'var(--text-hint)', marginTop: 2, lineHeight: 1.2 }}>
            {hasContour ? '✦' : '◇'}
          </button>
        </div>

        {/* Размеры */}
        <div style={{ display: 'flex', gap: 3, flex: 1 }}>
          <NumInput value={detail.w} placeholder="Длина" onChange={v => onUpdate({ ...detail, w: v })} inputRef={lengthRef} onEnter={() => widthRef.current?.focus()} hint="next" />
          <NumInput value={detail.h} placeholder="Ширина" onChange={v => onUpdate({ ...detail, h: v })} inputRef={widthRef} onEnter={() => qtyRef.current?.focus()} hint="next" />
          <div style={{ width: 56, flexShrink: 0 }}>
            <NumInput value={detail.qty} placeholder="Кол"
              onChange={v => onUpdate({ ...detail, qty: v })}
              inputRef={qtyRef}
              onEnter={onQtyEnter} hint="next" />
          </div>
        </div>

        {/* Удалить */}
        <button type="button" onClick={onRemove}
          style={{ background: 'none', border: 'none', color: 'var(--text-hint)', fontSize: 18, cursor: 'pointer', padding: 0, lineHeight: 1, flexShrink: 0 }}>
          ✕
        </button>
      </div>

      {/* Кромка — галочки */}
      {showEdge && (
        <div style={{ display: 'flex', gap: 4, marginTop: 4, alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: 'var(--text-hint)', minWidth: 44 }}>Кромка:</span>
          {SIDES.map((side, i) => {
            const key = KEYS[i]
            const val = detail.edges[key]
            const isActive = !!val
            return (
              <button key={key} type="button" onClick={() => toggleEdge(key)}
                style={{
                  flex: 1, padding: '5px 2px', border: isActive ? '1.5px solid var(--blue)' : '0.5px solid var(--border-md)',
                  borderRadius: 'var(--radius)', background: isActive ? 'var(--blue-light)' : 'transparent',
                  fontSize: 10, color: isActive ? 'var(--blue-dark)' : 'var(--text-hint)',
                  cursor: 'pointer', textAlign: 'center', lineHeight: 1.3
                }}>
                <div>{side}</div>
                {isActive && <div style={{ fontSize: 9, fontWeight: 500, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {val === 'default' ? '✓' : val}
                </div>}
              </button>
            )
          })}
          {/* Вращение */}
          <button type="button" onClick={() => onUpdate({ ...detail, rotatable: !detail.rotatable })}
            style={{
              padding: '5px 6px', border: detail.rotatable ? '1.5px solid var(--teal)' : '0.5px solid var(--border-md)',
              borderRadius: 'var(--radius)', background: detail.rotatable ? 'var(--teal-light)' : 'transparent',
              fontSize: 10, color: detail.rotatable ? 'var(--teal)' : 'var(--text-hint)', cursor: 'pointer', flexShrink: 0
            }}>↻</button>
        </div>
      )}

      {/* Показываем какие кромки назначены если кромка скрыта */}
      {!showEdge && Object.entries(detail.edges).some(([,v]) => v) && (
        <div style={{ marginTop: 4, fontSize: 10, color: 'var(--blue)' }}>
          {[['top','Д1'],['bottom','Д2'],['left','Ш1'],['right','Ш2']]
            .filter(([k]) => detail.edges[k])
            .map(([k,s]) => `${s}:${detail.edges[k] === 'default' ? '✓' : detail.edges[k]}`)
            .join('  ')}
        </div>
      )}



      {/* Редактор контура */}
      {showContour && (
        <ContourEditor detail={detail} onUpdate={onUpdate} />
      )}
    </div>
  )
}

let uid = 0
function newDetail() {
  uid++
  return {
    uid,
    w: '', h: '', qty: '',
    edges: { top: null, right: null, bottom: null, left: null },
    rotatable: false
  }
}

// Блок управления префиксами
function PrefixManager({ prefixes, active, onChange, onSetActive }) {
  const [input, setInput] = useState('')

  const add = () => {
    const val = input.trim()
    if (!val || prefixes.includes(val)) return
    onChange([...prefixes, val])
    onSetActive(val)
    setInput('')
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <input type="text" placeholder="Кухня / Шкаф / Прихожая" value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && add()}
          style={{ flex: 1 }} />
        <button type="button" onClick={add}
          style={{ padding: '0 14px', background: 'var(--blue)', color: 'white', border: 'none', borderRadius: 'var(--radius)', cursor: 'pointer', fontSize: 20, lineHeight: 1 }}>+</button>
      </div>
      {prefixes.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <button type="button" onClick={() => onSetActive(null)}
            style={{ padding: '5px 12px', borderRadius: 20, fontSize: 12, border: '0.5px solid var(--border-md)',
              background: !active ? 'var(--text)' : 'transparent', color: !active ? 'white' : 'var(--text-muted)', cursor: 'pointer' }}>
            Без префикса
          </button>
          {prefixes.map(p => (
            <button key={p} type="button" onClick={() => onSetActive(p)}
              style={{ padding: '5px 12px', borderRadius: 20, fontSize: 12, border: '0.5px solid var(--border-md)',
                background: active === p ? 'var(--blue)' : 'transparent',
                color: active === p ? 'white' : 'var(--text-muted)', cursor: 'pointer' }}>
              {p}
            </button>
          ))}
        </div>
      )}
      {active && <p style={{ fontSize: 11, color: 'var(--blue)', marginTop: 6 }}>Активный: «{active}» — новые детали получат этот префикс</p>}
    </div>
  )
}

// Блок управления кромками
function EdgeManager({ edgeNames, activeEdge, onChange, onSetActive }) {
  const [input, setInput] = useState('')

  const add = () => {
    const val = input.trim()
    if (!val || edgeNames.includes(val)) return
    onChange([...edgeNames, val])
    onSetActive(val)
    setInput('')
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <input type="text" placeholder="ПВХ 0.4мм / ПВХ 2мм / ABS" value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && add()}
          style={{ flex: 1 }} />
        <button type="button" onClick={add}
          style={{ padding: '0 14px', background: 'var(--blue)', color: 'white', border: 'none', borderRadius: 'var(--radius)', cursor: 'pointer', fontSize: 20, lineHeight: 1 }}>+</button>
      </div>
      {edgeNames.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {edgeNames.map(e => (
            <button key={e} type="button" onClick={() => onSetActive(activeEdge === e ? null : e)}
              style={{ padding: '5px 12px', borderRadius: 20, fontSize: 12, border: '0.5px solid var(--border-md)',
                background: activeEdge === e ? 'var(--blue)' : 'transparent',
                color: activeEdge === e ? 'white' : 'var(--text-muted)', cursor: 'pointer' }}>
              {e}
            </button>
          ))}
        </div>
      )}
      {activeEdge && <p style={{ fontSize: 11, color: 'var(--blue)', marginTop: 6 }}>Активная: «{activeEdge}» — нажми на сторону детали чтобы назначить</p>}
    </div>
  )
}

export default function NewOrderPage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [orderName, setOrderName] = useState('')
  const [materialName, setMaterialName] = useState('')

  // Префиксы
  const [prefixes, setPrefixes] = useState([])
  const [activePrefix, setActivePrefix] = useState(null)

  // Кромки
  const [edgeNames, setEdgeNames] = useState([])
  const [activeEdge, setActiveEdge] = useState(null)

  // Детали
  const [details, setDetails] = useState([newDetail()])
  const [showEdge, setShowEdge] = useState(true)

  const [sheetLength, setSheetLength] = useState(2750)
  const [sheetWidth, setSheetWidth] = useState(1830)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const [lastAddedUid, setLastAddedUid] = useState(null)
  const detailRefs = useRef({})
  const newDetailFocusRef = useRef(null) // будет установлен новой деталью

  const addDetail = (fromEnter = false) => {
    const d = { ...newDetail(), prefix: activePrefix }
    setLastAddedUid(d.uid)
    if (fromEnter) {
      // Помечаем что нужен автофокус И клавиатура не должна гаснуть
      d._focusOnMount = true
    }
    setDetails(prev => [...prev, d])
    setTimeout(() => {
      detailRefs.current[d.uid]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 60)
    return d.uid
  }

  const onQtyEnter = () => { addDetail(true) }
  const removeDetail = (u) => setDetails(d => d.filter(x => x.uid !== u))
  const updateDetail = (u, updated) => setDetails(d => d.map(x => x.uid === u ? updated : x))

  async function handleSave() {
    const valid = details.filter(d => d.w > 0 && d.h > 0)
    if (!valid.length) { setError('Добавьте хотя бы одну деталь с размерами'); return }
    setSaving(true); setError('')
    try {
      const orderNumber = await getNextOrderNumber(supabase)
      const { data: order, error: oErr } = await supabase.from('orders').insert({
        user_id: user.id,
        order_number: orderNumber,
        order_name: orderName || null,
        material_name: materialName || 'Без названия',
        sheet_length: Number(sheetLength) || SHEET_DEFAULTS.length,
        sheet_width: Number(sheetWidth) || SHEET_DEFAULTS.width,
        margin_top: SHEET_DEFAULTS.margin_top,
        margin_right: SHEET_DEFAULTS.margin_right,
        margin_bottom: SHEET_DEFAULTS.margin_bottom,
        margin_left: SHEET_DEFAULTS.margin_left,
        kerf_width: SHEET_DEFAULTS.kerf,
        status: 'draft'
      }).select().single()
      if (oErr) throw oErr

      const rows = details.map((d, i) => {
        const pfx = d.prefix || null
        const name = `Деталь ${i + 1}`
        return {
          order_id: order.id,
          prefix: pfx,
          name,
          display_name: pfx ? `${pfx} ${name}` : name,
          length: Number(d.w),
          width: Number(d.h),
          qty: Number(d.qty) || 1,
          edge_top: d.edges.top || null,
          edge_right: d.edges.right || null,
          edge_bottom: d.edges.bottom || null,
          edge_left: d.edges.left || null,
          rotatable: d.rotatable,
          sort_order: i
        }
      })
      const { error: dErr } = await supabase.from('order_details').insert(rows)
      if (dErr) throw dErr
      navigate(`/orders/${order.id}`)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const validCount = details.filter(d => d.w > 0 && d.h > 0).length

  // Группируем детали по префиксу для отображения
  const grouped = details.reduce((acc, d) => {
    const key = d.prefix || ''
    if (!acc[key]) acc[key] = []
    acc[key].push(d)
    return acc
  }, {})

  return (
    <div className="page" style={{ paddingBottom: 100 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20, paddingTop: 8 }}>
        <button type="button" onClick={() => navigate('/orders')}
          style={{ background: 'none', border: 'none', color: 'var(--blue)', fontSize: 22, padding: 0, lineHeight: 1, cursor: 'pointer' }}>←</button>
        <h1 style={{ fontSize: 18, fontWeight: 500 }}>Новый заказ</h1>
      </div>

      {/* Материал */}
      <div style={{ marginBottom: 14 }}>
        <p className="section-title">Материал</p>
        <div className="card">
          <label className="label">Название заказа</label>
          <input type="text" placeholder="Кухня Ивановых / Шкаф-купе" value={orderName}
            onChange={e => setOrderName(e.target.value)} style={{ marginBottom: 10 }} />
          <label className="label">Материал</label>
          <input type="text" placeholder="ЛДСП Белый 16мм" value={materialName}
            onChange={e => setMaterialName(e.target.value)} />
        </div>
      </div>

      {/* Параметры листа */}
      <div style={{ marginBottom: 14 }}>
        <p className="section-title">Параметры листа</p>
        <div className="card" style={{ padding: '8px 12px' }}>
          {/* Формат листа — редактируемый */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
            <label className="label" style={{ marginBottom: 0, minWidth: 70 }}>Формат листа</label>
            <input type="text" inputMode="numeric" value={sheetLength}
              onChange={e => { const v = e.target.value.replace(/[^0-9]/g,''); setSheetLength(v===''?'':Number(v)) }}
              style={{ width: 70, padding: '4px 6px', fontSize: 13, textAlign: 'center' }} />
            <span style={{ fontSize: 12, color: 'var(--text-hint)' }}>×</span>
            <input type="text" inputMode="numeric" value={sheetWidth}
              onChange={e => { const v = e.target.value.replace(/[^0-9]/g,''); setSheetWidth(v===''?'':Number(v)) }}
              style={{ width: 70, padding: '4px 6px', fontSize: 13, textAlign: 'center' }} />
            <span style={{ fontSize: 12, color: 'var(--text-hint)' }}>мм</span>
          </div>
          {/* Отступы — только просмотр */}
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: 'var(--text-hint)', minWidth: 70 }}>Отступы/рез</span>
            <span style={{ fontSize: 11, color: 'var(--text-hint)' }}>
              ↑{SHEET_DEFAULTS.margin_top} →{SHEET_DEFAULTS.margin_right} ↓{SHEET_DEFAULTS.margin_bottom} ←{SHEET_DEFAULTS.margin_left} · рез {SHEET_DEFAULTS.kerf} мм
            </span>
          </div>
        </div>
      </div>

      {/* Префиксы */}
      <div style={{ marginBottom: 14 }}>
        <p className="section-title">Префиксы групп</p>
        <div className="card">
          <PrefixManager prefixes={prefixes} active={activePrefix}
            onChange={setPrefixes} onSetActive={setActivePrefix} />
        </div>
      </div>

      {/* Кромки */}
      <div style={{ marginBottom: 14 }}>
        <p className="section-title">Виды кромки</p>
        <div className="card">
          <EdgeManager edgeNames={edgeNames} activeEdge={activeEdge}
            onChange={setEdgeNames} onSetActive={setActiveEdge} />
        </div>
      </div>

      {/* Импорт */}
      <div style={{ marginBottom: 14 }}>
        <p className="section-title">Импорт деталей</p>
        <div className="card" style={{ background: 'var(--bg2)' }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" disabled style={{ flex: 1, padding: '10px 6px', border: '0.5px dashed var(--border-md)', borderRadius: 'var(--radius)', background: 'transparent', color: 'var(--text-hint)', fontSize: 13, cursor: 'not-allowed', textAlign: 'center' }}>
              📊 Excel / CSV
            </button>
            <button type="button" disabled style={{ flex: 1, padding: '10px 6px', border: '0.5px dashed var(--border-md)', borderRadius: 'var(--radius)', background: 'transparent', color: 'var(--text-hint)', fontSize: 13, cursor: 'not-allowed', textAlign: 'center' }}>
              📐 OBJ / DXF
            </button>
          </div>
          <p style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 8, textAlign: 'center' }}>Импорт будет доступен в следующем обновлении</p>
        </div>
      </div>

      {/* Детали */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <p className="section-title" style={{ marginBottom: 0 }}>
            Детали ({details.length}) {validCount > 0 && `· ${validCount} заполнено`}
          </p>
          <button type="button" onClick={() => setShowEdge(v => !v)}
            style={{ fontSize: 12, color: 'var(--blue)', background: 'none', border: '0.5px solid var(--blue-mid)', borderRadius: 20, padding: '3px 10px', cursor: 'pointer' }}>
            {showEdge ? 'Скрыть кромку' : 'Показать кромку'}
          </button>
        </div>

        {/* Вращение для всех */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'var(--bg)', border: '0.5px solid var(--border)', borderRadius: 'var(--radius)', marginBottom: 10 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-hint)" strokeWidth="1.5"><path d="M21 2v6h-6M3 12a9 9 0 0115-6.7L21 8M3 22v-6h6M21 12a9 9 0 01-15 6.7L3 16"/></svg>
          <span style={{ fontSize: 13, color: 'var(--text-muted)', flex: 1 }}>Вращение для всех</span>
          <button type="button" onClick={() => setDetails(d => d.map(x => ({ ...x, rotatable: true })))} style={{ padding: '4px 12px', border: '0.5px solid var(--border-md)', borderRadius: 'var(--radius)', background: 'transparent', fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}>Вкл</button>
          <button type="button" onClick={() => setDetails(d => d.map(x => ({ ...x, rotatable: false })))} style={{ padding: '4px 12px', border: '0.5px solid var(--border-md)', borderRadius: 'var(--radius)', background: 'transparent', fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}>Выкл</button>
        </div>

        {/* Заголовок колонок */}
        <div style={{ display: 'flex', gap: 8, paddingLeft: 30, paddingRight: 28, marginBottom: 4 }}>
          <div style={{ flex: 1, fontSize: 11, color: 'var(--text-hint)' }}>Длина</div>
          <div style={{ flex: 1, fontSize: 11, color: 'var(--text-hint)' }}>Ширина</div>
          <div style={{ width: 60, fontSize: 11, color: 'var(--text-hint)' }}>Кол-во</div>
        </div>

        {/* Детали сгруппированные */}
        {Object.entries(grouped).map(([pfx, dets]) => (
          <div key={pfx}>
            {pfx && (
              <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--blue)', marginBottom: 4, marginTop: 8,
                padding: '4px 8px', background: 'var(--blue-light)', borderRadius: 'var(--radius)', display: 'inline-block' }}>
                {pfx}
              </div>
            )}
            {dets.map((d) => {
              const globalIndex = details.findIndex(x => x.uid === d.uid)
              return (
                <DetailCard key={d.uid} detail={d} index={globalIndex}
                  onUpdate={u => updateDetail(d.uid, u)}
                  onRemove={() => removeDetail(d.uid)}
                  activeEdgeName={activeEdge}
                  showEdge={showEdge}
                  autoFocus={d.uid === lastAddedUid} />
              )
            })}
          </div>
        ))}

        <button type="button" onClick={addDetail}
          style={{ width: '100%', padding: 10, border: '0.5px dashed var(--border-md)',
            borderRadius: 'var(--radius)', background: 'transparent', color: 'var(--text-hint)', fontSize: 14, cursor: 'pointer', marginTop: 4 }}>
          + Добавить деталь {activePrefix ? `(${activePrefix})` : ''}
        </button>
      </div>

      {error && <p className="error-text" style={{ marginBottom: 12 }}>{error}</p>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button type="button" className="btn-primary" onClick={handleSave} disabled={saving || !validCount}>
          {saving ? 'Сохранение...' : `Сохранить заказ (${validCount} дет.)`}
        </button>
      </div>
      <BottomNav />
    </div>
  )
}
