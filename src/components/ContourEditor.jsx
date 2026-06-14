import { useState, useRef, useEffect, useCallback } from 'react'

// ─── NumField ─────────────────────────────────────────────────────────────────
function NumField({ label, value, onChange, unit = 'мм' }) {
  const [raw, setRaw] = useState(String(value ?? 0))
  useEffect(() => {
    const ext = String(value ?? 0)
    if (Number(raw) !== Number(ext)) setRaw(ext)
  }, [value])
  const handleChange = (e) => {
    let v = e.target.value.replace(/[^0-9.,]/g, '').replace(',', '.')
    const parts = v.split('.')
    if (parts.length > 2) v = parts[0] + '.' + parts.slice(1).join('')
    setRaw(v)
    const num = parseFloat(v)
    if (!isNaN(num)) onChange(num)
  }
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      {label && <label style={{ fontSize: 10, color: 'var(--text-hint)', display: 'block', marginBottom: 2 }}>{label}</label>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <input type="text" inputMode="decimal" value={raw}
          onChange={handleChange}
          onBlur={() => setRaw(String(value ?? 0))}
          style={{ padding: '6px 6px', fontSize: 13, width: '100%' }} />
        <span style={{ fontSize: 10, color: 'var(--text-hint)', flexShrink: 0 }}>{unit}</span>
      </div>
    </div>
  )
}

// ─── Начальные вершины прямоугольника ─────────────────────────────────────────
function makeRect(w, h) {
  return [
    { x: 0, y: 0, r: 0 },
    { x: w, y: 0, r: 0 },
    { x: w, y: h, r: 0 },
    { x: 0, y: h, r: 0 },
  ]
}

// ─── Рисование пути по вершинам с радиусами ───────────────────────────────────
function buildPath(ctx, verts, sc, ox, oy) {
  if (!verts || verts.length < 2) return
  const n = verts.length
  const cv = verts.map(v => ({ x: ox + v.x * sc, y: oy + v.y * sc, r: (v.r || 0) * sc }))

  ctx.beginPath()
  for (let i = 0; i < n; i++) {
    const prev = cv[(i - 1 + n) % n]
    const curr = cv[i]
    const next = cv[(i + 1) % n]
    const r = curr.r

    if (r <= 0) {
      if (i === 0) ctx.moveTo(curr.x, curr.y)
      else ctx.lineTo(curr.x, curr.y)
    } else {
      // Вектора от curr к prev и от curr к next
      const dx0 = prev.x - curr.x, dy0 = prev.y - curr.y
      const dx1 = next.x - curr.x, dy1 = next.y - curr.y
      const d0 = Math.hypot(dx0, dy0), d1 = Math.hypot(dx1, dy1)
      if (d0 === 0 || d1 === 0) {
        if (i === 0) ctx.moveTo(curr.x, curr.y)
        else ctx.lineTo(curr.x, curr.y)
        continue
      }
      // Точки касания
      const t = Math.min(r, d0 / 2, d1 / 2)
      const tx0 = curr.x + (dx0 / d0) * t
      const ty0 = curr.y + (dy0 / d0) * t
      const tx1 = curr.x + (dx1 / d1) * t
      const ty1 = curr.y + (dy1 / d1) * t

      if (i === 0) ctx.moveTo(tx0, ty0)
      else ctx.lineTo(tx0, ty0)
      ctx.arcTo(curr.x, curr.y, tx1, ty1, t)
    }
  }
  ctx.closePath()
}

// ─── resolvePos для вырезов ───────────────────────────────────────────────────
function resolvePos(sides, offsets, panelW, panelH, itemW, itemH) {
  let x = (panelW - itemW) / 2, y = (panelH - itemH) / 2
  let w = itemW, h = itemH
  if (sides.includes('left') && sides.includes('right')) { x = offsets.left ?? 0; w = panelW - (offsets.left ?? 0) - (offsets.right ?? 0) }
  else if (sides.includes('left')) x = offsets.left ?? 0
  else if (sides.includes('right')) x = panelW - itemW - (offsets.right ?? 0)
  if (sides.includes('top') && sides.includes('bottom')) { y = offsets.top ?? 0; h = panelH - (offsets.top ?? 0) - (offsets.bottom ?? 0) }
  else if (sides.includes('top')) y = offsets.top ?? 0
  else if (sides.includes('bottom')) y = panelH - itemH - (offsets.bottom ?? 0)
  return { x, y, w, h }
}

// ─── Получить позиции маркеров по вершинам ────────────────────────────────────
function getMarkers(verts, sc, ox, oy) {
  return (verts || []).map((v, i) => ({
    idx: i,
    x: ox + v.x * sc,
    y: oy + v.y * sc,
    r: v.r || 0,
    vertex: v,
  }))
}

// ─── Canvas ───────────────────────────────────────────────────────────────────
function ContourCanvas({ detail, contour, activeIdx, onTap }) {
  const ref = useRef(null)
  const w = Number(detail.w) || 0
  const h = Number(detail.h) || 0

  useEffect(() => {
    const canvas = ref.current
    if (!canvas || !w || !h) return
    const ctx = canvas.getContext('2d')
    const PW = canvas.width - 50, PH = canvas.height - 50
    const sc = Math.min(PW / w, PH / h)
    const dw = w * sc, dh = h * sc
    const ox = (canvas.width - dw) / 2, oy = (canvas.height - dh) / 2

    ctx.clearRect(0, 0, canvas.width, canvas.height)

    // Размеры
    const dimColor = '#888780'
    ctx.fillStyle = dimColor; ctx.font = '10px sans-serif'
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(`${w}`, ox + dw/2, oy - 10)
    ctx.save(); ctx.translate(ox - 12, oy + dh/2); ctx.rotate(-Math.PI/2)
    ctx.fillText(`${h}`, 0, 0); ctx.restore()
    ctx.strokeStyle = dimColor; ctx.lineWidth = 0.5; ctx.setLineDash([2,2])
    ctx.beginPath(); ctx.moveTo(ox, oy-5); ctx.lineTo(ox+dw, oy-5); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(ox-5, oy); ctx.lineTo(ox-5, oy+dh); ctx.stroke()
    ctx.setLineDash([])

    // Внешний контур
    const verts = contour.vertices || makeRect(w, h)
    buildPath(ctx, verts, sc, ox, oy)
    ctx.fillStyle = '#E6F1FB'; ctx.fill()
    ctx.strokeStyle = '#185FA5'; ctx.lineWidth = 1.5; ctx.stroke()

    // Holes (вырезы/выборки)
    ;(contour.holes || []).forEach(hole => {
      if (hole.vertices && hole.vertices.length >= 3) {
        buildPath(ctx, hole.vertices, sc, ox, oy)
        ctx.fillStyle = hole.type === 'pocket' ? 'rgba(250,199,117,0.4)' : '#fff'
        ctx.fill()
        ctx.strokeStyle = hole.type === 'pocket' ? '#BA7517' : '#E24B4A'
        ctx.lineWidth = 1; ctx.stroke()
      }
    })

    // Пазы
    ;(contour.grooves || []).forEach(g => {
      ctx.fillStyle = 'rgba(250,199,117,0.8)'; ctx.strokeStyle = '#BA7517'; ctx.lineWidth = 1
      const isH = g.dir === 'horizontal'
      const gW = isH ? (g.length||100) : (g.width||8)
      const gH = isH ? (g.width||8) : (g.length||100)
      const pos = resolvePos(g.sides||[], g.offsets||{}, w, h, gW, gH)
      ctx.fillRect(ox+pos.x*sc, oy+pos.y*sc, pos.w*sc, pos.h*sc)
      ctx.strokeRect(ox+pos.x*sc, oy+pos.y*sc, pos.w*sc, pos.h*sc)
    })

    // Маркеры внешнего контура
    const markers = getMarkers(verts, sc, ox, oy)
    markers.forEach(m => {
      const isActive = m.idx === activeIdx
      ctx.beginPath()
      ctx.arc(m.x, m.y, 3, 0, Math.PI * 2)
      ctx.fillStyle = isActive ? '#E24B4A' : '#185FA5'
      ctx.fill()
      ctx.strokeStyle = 'white'; ctx.lineWidth = 1; ctx.stroke()
    })

  }, [w, h, contour, activeIdx])

  const handleTap = (e) => {
    const canvas = ref.current
    if (!canvas || !w || !h) return
    const rect = canvas.getBoundingClientRect()
    const scaleX = canvas.width / rect.width
    const scaleY = canvas.height / rect.height
    const cx = (e.clientX - rect.left) * scaleX
    const cy = (e.clientY - rect.top) * scaleY

    const PW = canvas.width - 50, PH = canvas.height - 50
    const sc = Math.min(PW / w, PH / h)
    const dw = w * sc, dh = h * sc
    const ox = (canvas.width - dw) / 2, oy = (canvas.height - dh) / 2

    const verts = contour.vertices || makeRect(w, h)
    const markers = getMarkers(verts, sc, ox, oy)
    const TAP_R = 18
    for (const m of markers) {
      if (Math.hypot(cx - m.x, cy - m.y) <= TAP_R) {
        onTap(m.idx)
        return
      }
    }
    // Тап мимо — снимаем выбор
    onTap(null)
  }

  return (
    <canvas ref={ref} width={280} height={200}
      onClick={handleTap}
      style={{ width:'100%', maxWidth:280, borderRadius:8, display:'block', margin:'0 auto', cursor:'pointer', touchAction:'manipulation' }} />
  )
}

// ─── Меню вершины ─────────────────────────────────────────────────────────────
function VertexMenu({ idx, vertex, total, onChange, onInsertBefore, onInsertAfter, onDelete, onClose }) {
  const canDelete = total > 3

  return (
    <div style={{ background:'var(--bg2)', borderRadius:'var(--radius)', padding:12, marginTop:8,
      border:'1.5px solid var(--blue)' }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10 }}>
        <span style={{ fontSize:13, fontWeight:500, color:'var(--blue)' }}>
          Точка #{idx + 1} · ({Math.round(vertex.x)}, {Math.round(vertex.y)})
        </span>
        <button type="button" onClick={onClose}
          style={{ background:'none', border:'none', fontSize:18, color:'var(--text-hint)', cursor:'pointer', padding:0, lineHeight:1 }}>✕</button>
      </div>

      {/* Радиус */}
      <div style={{ marginBottom:12 }}>
        <NumField label="Радиус скругления R"
          value={vertex.r || 0}
          onChange={v => onChange({ ...vertex, r: v })} />
        <p style={{ fontSize:10, color:'var(--text-hint)', marginTop:3 }}>0 = острый угол</p>
      </div>

      {/* Действия */}
      <div style={{ display:'flex', gap:6 }}>
        <button type="button" onClick={onInsertBefore}
          style={{ flex:1, padding:'7px 4px', border:'0.5px solid var(--border-md)', borderRadius:'var(--radius)',
            background:'transparent', fontSize:11, color:'var(--text-muted)', cursor:'pointer' }}>
          + До
        </button>
        <button type="button" onClick={onInsertAfter}
          style={{ flex:1, padding:'7px 4px', border:'0.5px solid var(--border-md)', borderRadius:'var(--radius)',
            background:'transparent', fontSize:11, color:'var(--text-muted)', cursor:'pointer' }}>
          + После
        </button>
        {canDelete && (
          <button type="button" onClick={onDelete}
            style={{ flex:1, padding:'7px 4px', border:'0.5px solid var(--danger)', borderRadius:'var(--radius)',
              background:'transparent', fontSize:11, color:'var(--danger)', cursor:'pointer' }}>
            Удалить
          </button>
        )}
      </div>
    </div>
  )
}

// ─── SideOffsetPicker ─────────────────────────────────────────────────────────
const SIDE_BTNS = [
  { id: 'top', label: '↑ Верх' }, { id: 'bottom', label: '↓ Низ' },
  { id: 'left', label: '← Лево' }, { id: 'right', label: '→ Право' },
]
function SideOffsetPicker({ activeSides = [], offsets = {}, onChange }) {
  const toggle = (id) => {
    const next = activeSides.includes(id) ? activeSides.filter(s => s !== id) : [...activeSides, id]
    onChange({ sides: next, offsets })
  }
  const setOffset = (id, val) => onChange({ sides: activeSides, offsets: { ...offsets, [id]: val } })
  return (
    <div>
      <label style={{ fontSize: 11, color: 'var(--text-hint)', display: 'block', marginBottom: 6 }}>Привязка к сторонам</label>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
        {SIDE_BTNS.map(s => (
          <button key={s.id} type="button" onClick={() => toggle(s.id)}
            style={{ padding: '5px 10px', borderRadius: 20, fontSize: 11, border: 'none',
              background: activeSides.includes(s.id) ? 'var(--blue)' : 'var(--bg3)',
              color: activeSides.includes(s.id) ? 'white' : 'var(--text-muted)', cursor: 'pointer' }}>
            {s.label}
          </button>
        ))}
      </div>
      {activeSides.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          {activeSides.map(id => (
            <NumField key={id} label={`Отступ ${SIDE_BTNS.find(s => s.id === id)?.label}`}
              value={offsets[id] ?? 0} onChange={v => setOffset(id, v)} />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Свёртываемый блок ────────────────────────────────────────────────────────
function CollapsibleItem({ title, onRemove, children }) {
  const [open, setOpen] = useState(true)
  return (
    <div style={{ background:'var(--bg2)', borderRadius:'var(--radius)', marginBottom:8, overflow:'hidden' }}>
      <div style={{ display:'flex', alignItems:'center', padding:'8px 10px', cursor:'pointer' }} onClick={() => setOpen(v => !v)}>
        <span style={{ fontSize:13, fontWeight:500, flex:1 }}>{title}</span>
        <span style={{ fontSize:12, color:'var(--text-hint)', marginRight:8 }}>{open ? '▲' : '▼'}</span>
        <button type="button" onClick={e=>{e.stopPropagation();onRemove()}}
          style={{ background:'none', border:'none', color:'var(--text-hint)', cursor:'pointer', fontSize:16, padding:0 }}>✕</button>
      </div>
      {open && <div style={{ padding:'0 10px 10px' }}>{children}</div>}
    </div>
  )
}

// ─── Главный компонент ────────────────────────────────────────────────────────
export default function ContourEditor({ detail, onUpdate }) {
  const w = Number(detail.w) || 0
  const h = Number(detail.h) || 0

  // Нормализуем контур в новый формат
  const rawContour = detail.contour || {}
  const contour = {
    vertices: rawContour.vertices || makeRect(w, h),
    holes:    rawContour.holes    || [],
    grooves:  rawContour.grooves  || [],
  }

  const [tab, setTab] = useState('contour')
  const [activeIdx, setActiveIdx] = useState(null)

  const upd = (patch) => onUpdate({ ...detail, contour: { ...contour, ...patch } })

  const setVertices = (verts) => upd({ vertices: verts })

  const handleTap = (idx) => {
    setActiveIdx(idx)
    setTab('contour')
  }

  // Вершина: изменить
  const updateVertex = (idx, newV) => {
    const verts = [...contour.vertices]
    verts[idx] = newV
    setVertices(verts)
  }

  // Вставить точку до или после
  const insertVertex = (idx, after = false) => {
    const verts = contour.vertices
    const n = verts.length
    const i = after ? idx : (idx - 1 + n) % n
    const j = (i + 1) % n
    const a = verts[i], b = verts[j]
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, r: 0 }
    const newVerts = [...verts]
    newVerts.splice(after ? idx + 1 : idx, 0, mid)
    setVertices(newVerts)
    setActiveIdx(after ? idx + 1 : idx)
  }

  // Удалить точку
  const deleteVertex = (idx) => {
    const verts = contour.vertices.filter((_, i) => i !== idx)
    setVertices(verts)
    setActiveIdx(null)
  }

  // Holes
  const addHole = (type) => {
    const size = Math.min(w, h) * 0.3
    const cx = w / 2, cy = h / 2, s = size / 2
    const verts = [
      { x: cx-s, y: cy-s, r: 0 }, { x: cx+s, y: cy-s, r: 0 },
      { x: cx+s, y: cy+s, r: 0 }, { x: cx-s, y: cy+s, r: 0 },
    ]
    upd({ holes: [...contour.holes, { type, vertices: verts, depth: type === 'pocket' ? 10 : 0 }] })
  }
  const updHole = (i, patch) => {
    const holes = [...contour.holes]
    holes[i] = { ...holes[i], ...patch }
    upd({ holes })
  }

  // Grooves
  const addGroove = () => {
    upd({ grooves: [...contour.grooves, { dir:'horizontal', length:100, width:8, depth:10, sides:[], offsets:{} }] })
  }
  const updGroove = (i, patch) => {
    const gs = [...contour.grooves]
    gs[i] = { ...gs[i], ...patch }
    upd({ grooves: gs })
  }

  const hasContour = contour.vertices.length > 4 ||
    contour.vertices.some(v => v.r > 0) ||
    contour.holes.length > 0 || contour.grooves.length > 0

  const activeVertex = activeIdx !== null ? contour.vertices[activeIdx] : null

  return (
    <div style={{ marginTop:10, borderTop:'0.5px solid var(--border)', paddingTop:10 }}>

      {/* Canvas */}
      {w > 0 && h > 0 && (
        <div style={{ marginBottom:8 }}>
          <p style={{ fontSize:11, color:'var(--text-hint)', textAlign:'center', marginBottom:4 }}>
            Нажми на точку чтобы изменить
          </p>
          <ContourCanvas detail={detail} contour={contour} activeIdx={activeIdx} onTap={handleTap} />
        </div>
      )}

      {/* Меню активной вершины */}
      {activeVertex && tab === 'contour' && (
        <VertexMenu
          idx={activeIdx}
          vertex={activeVertex}
          total={contour.vertices.length}
          onChange={v => updateVertex(activeIdx, v)}
          onInsertBefore={() => insertVertex(activeIdx, false)}
          onInsertAfter={() => insertVertex(activeIdx, true)}
          onDelete={() => deleteVertex(activeIdx)}
          onClose={() => setActiveIdx(null)} />
      )}

      {/* Вкладки */}
      <div style={{ display:'flex', gap:4, margin:'10px 0 10px', background:'var(--bg2)', borderRadius:'var(--radius)', padding:3 }}>
        {[['contour','Контур'],['holes','Вырезы'],['grooves','Пазы']].map(([id,label])=>(
          <button key={id} type="button" onClick={()=>{ setTab(id); if(id!=='contour') setActiveIdx(null) }}
            style={{ flex:1, padding:'6px 4px', border:'none', borderRadius:6, fontSize:12,
              background: tab===id?'var(--bg)':'transparent',
              color: tab===id?'var(--blue)':'var(--text-hint)',
              fontWeight: tab===id?500:400, cursor:'pointer' }}>
            {label}
          </button>
        ))}
      </div>

      {/* КОНТУР — быстрые кнопки */}
      {tab==='contour' && !activeVertex && (
        <div style={{ display:'flex', gap:6 }}>
          <button type="button"
            onClick={() => setVertices(contour.vertices.map(v => ({ ...v, r: 50 })))}
            style={{ flex:1, padding:'8px', border:'0.5px solid var(--border-md)', borderRadius:'var(--radius)',
              background:'transparent', fontSize:12, color:'var(--text-muted)', cursor:'pointer' }}>
            ⌒ Скруглить все R50
          </button>
          <button type="button"
            onClick={() => setVertices(makeRect(w, h))}
            style={{ flex:1, padding:'8px', border:'0.5px solid var(--border-md)', borderRadius:'var(--radius)',
              background:'transparent', fontSize:12, color:'var(--text-muted)', cursor:'pointer' }}>
            ↺ Сбросить форму
          </button>
        </div>
      )}

      {/* ВЫРЕЗЫ */}
      {tab==='holes' && (
        <div>
          <div style={{ display:'flex', gap:8, marginBottom:12 }}>
            <button type="button" onClick={() => addHole('cutout')}
              style={{ flex:1, padding:'8px', border:'0.5px dashed var(--border-md)', borderRadius:'var(--radius)',
                background:'transparent', fontSize:12, color:'var(--text-muted)', cursor:'pointer' }}>
              + Сквозной вырез
            </button>
            <button type="button" onClick={() => addHole('pocket')}
              style={{ flex:1, padding:'8px', border:'0.5px dashed var(--border-md)', borderRadius:'var(--radius)',
                background:'transparent', fontSize:12, color:'var(--text-muted)', cursor:'pointer' }}>
              + Выборка
            </button>
          </div>
          {!contour.holes.length && <p style={{ fontSize:12, color:'var(--text-hint)', textAlign:'center' }}>Нет вырезов</p>}
          {contour.holes.map((hole, i) => (
            <CollapsibleItem key={i}
              title={`${hole.type === 'pocket' ? '▣ Выборка' : '□ Сквозной'} #${i+1}`}
              onRemove={() => upd({ holes: contour.holes.filter((_,j)=>j!==i) })}>
              {hole.type === 'pocket' && (
                <div style={{ marginBottom:8 }}>
                  <NumField label="Глубина" value={hole.depth ?? 10} onChange={v => updHole(i, { depth: v })} />
                </div>
              )}
              <p style={{ fontSize:11, color:'var(--text-hint)', marginBottom:6 }}>
                {hole.vertices?.length || 0} точек · редактирование формы в контуре
              </p>
            </CollapsibleItem>
          ))}
        </div>
      )}

      {/* ПАЗЫ */}
      {tab==='grooves' && (
        <div>
          <button type="button" onClick={addGroove}
            style={{ width:'100%', padding:'8px', border:'0.5px dashed var(--border-md)', borderRadius:'var(--radius)',
              background:'transparent', fontSize:12, color:'var(--text-muted)', cursor:'pointer', marginBottom:12 }}>
            + Добавить паз
          </button>
          {!contour.grooves.length && <p style={{ fontSize:12, color:'var(--text-hint)', textAlign:'center' }}>Нет пазов</p>}
          {contour.grooves.map((g, i) => (
            <CollapsibleItem key={i} title={`Паз #${i+1}`}
              onRemove={() => upd({ grooves: contour.grooves.filter((_,j)=>j!==i) })}>
              <label style={{ fontSize:11, color:'var(--text-hint)', display:'block', marginBottom:6 }}>Направление</label>
              <div style={{ display:'flex', gap:6, marginBottom:10 }}>
                {[['horizontal','↔ Горизонтальный'],['vertical','↕ Вертикальный']].map(([id,label])=>(
                  <button key={id} type="button" onClick={() => updGroove(i, { dir: id })}
                    style={{ flex:1, padding:'6px 4px', borderRadius:'var(--radius)', border:'none', fontSize:11,
                      background: (g.dir||'horizontal')===id?'var(--blue)':'var(--bg3)',
                      color: (g.dir||'horizontal')===id?'white':'var(--text-muted)', cursor:'pointer' }}>
                    {label}
                  </button>
                ))}
              </div>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:6, marginBottom:10 }}>
                <NumField label="Длина" value={g.length??100} onChange={v=>updGroove(i,{length:v})} />
                <NumField label="Ширина" value={g.width??8} onChange={v=>updGroove(i,{width:v})} />
                <NumField label="Глубина" value={g.depth??10} onChange={v=>updGroove(i,{depth:v})} />
              </div>
              <SideOffsetPicker activeSides={g.sides||[]} offsets={g.offsets||{}}
                onChange={({sides,offsets})=>updGroove(i,{sides,offsets})} />
            </CollapsibleItem>
          ))}
        </div>
      )}

      {/* Сброс */}
      {hasContour && (
        <button type="button"
          onClick={() => { upd({ vertices: makeRect(w, h), holes: [], grooves: [] }); setActiveIdx(null) }}
          style={{ width:'100%', marginTop:8, padding:'6px', border:'0.5px solid var(--danger)',
            borderRadius:'var(--radius)', background:'transparent', fontSize:11, color:'var(--danger)', cursor:'pointer' }}>
          Сбросить контур
        </button>
      )}
    </div>
  )
}
