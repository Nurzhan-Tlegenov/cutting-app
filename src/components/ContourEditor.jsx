import { useState, useRef, useEffect } from 'react'

function NumField({ label, value, onChange, unit = 'мм', allowNegative = false }) {
  const [raw, setRaw] = useState(String(value ?? 0))

  // Синхронизируем если value изменился снаружи
  useEffect(() => {
    const external = String(value ?? 0)
    if (Number(raw) !== Number(external)) setRaw(external)
  }, [value])

  const handleChange = (e) => {
    let v = e.target.value
    // Разрешаем: цифры, точку, запятую (→ точка), минус в начале если allowNegative
    if (allowNegative) {
      v = v.replace(/[^0-9.,-]/g, '').replace(',', '.')
      // Минус только в начале
      if (v.startsWith('-')) v = '-' + v.slice(1).replace(/-/g, '')
    } else {
      v = v.replace(/[^0-9.,]/g, '').replace(',', '.')
    }
    // Не больше одной точки
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

const SIDE_BTNS = [
  { id: 'top', label: '↑ Верх' },
  { id: 'bottom', label: '↓ Низ' },
  { id: 'left', label: '← Лево' },
  { id: 'right', label: '→ Право' },
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
            <NumField key={id}
              label={`Отступ ${SIDE_BTNS.find(s => s.id === id)?.label}`}
              value={offsets[id] ?? 0}
              onChange={v => setOffset(id, v)} />
          ))}
        </div>
      )}
    </div>
  )
}

// Вычисляем позицию элемента по привязкам
function resolvePos(sides, offsets, panelW, panelH, itemW, itemH) {
  let x = (panelW - itemW) / 2
  let y = (panelH - itemH) / 2
  let w = itemW, h = itemH

  if (sides.includes('left') && sides.includes('right')) {
    x = offsets.left ?? 0
    w = panelW - (offsets.left ?? 0) - (offsets.right ?? 0)
  } else if (sides.includes('left')) {
    x = offsets.left ?? 0
  } else if (sides.includes('right')) {
    x = panelW - itemW - (offsets.right ?? 0)
  }

  if (sides.includes('top') && sides.includes('bottom')) {
    y = offsets.top ?? 0
    h = panelH - (offsets.top ?? 0) - (offsets.bottom ?? 0)
  } else if (sides.includes('top')) {
    y = offsets.top ?? 0
  } else if (sides.includes('bottom')) {
    y = panelH - itemH - (offsets.bottom ?? 0)
  }

  return { x, y, w, h }
}

// ─── Превью ───────────────────────────────────────────────────────────────────
function ContourPreview({ w, h, contour }) {
  const ref = useRef(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas || !w || !h) return
    const ctx = canvas.getContext('2d')
    const PW = canvas.width - 50, PH = canvas.height - 50
    const sc = Math.min(PW / w, PH / h)
    const dw = w * sc, dh = h * sc
    const ox = (canvas.width - dw) / 2, oy = (canvas.height - dh) / 2
    const toC = v => (v || 0) * sc

    ctx.clearRect(0, 0, canvas.width, canvas.height)

    // Размеры детали по сторонам (как на чертеже)
    const dimColor = '#888780'
    const dimFont = '10px sans-serif'
    ctx.fillStyle = dimColor
    ctx.font = dimFont
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    // Верхний размер (длина = w)
    ctx.fillText(`${w}`, ox + dw/2, oy - 8)
    // Левый размер (ширина = h) — вертикально
    ctx.save()
    ctx.translate(ox - 10, oy + dh/2)
    ctx.rotate(-Math.PI/2)
    ctx.fillText(`${h}`, 0, 0)
    ctx.restore()

    // Линии размеров
    ctx.strokeStyle = dimColor
    ctx.lineWidth = 0.5
    ctx.setLineDash([2,2])
    ctx.beginPath(); ctx.moveTo(ox, oy-4); ctx.lineTo(ox+dw, oy-4); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(ox-4, oy); ctx.lineTo(ox-4, oy+dh); ctx.stroke()
    ctx.setLineDash([])

    const c = contour || {}
    const corners = c.corners || {}
    const tl = corners.tl || {}, tr = corners.tr || {}
    const br = corners.br || {}, bl = corners.bl || {}

    function offs(corner) {
      if (!corner?.type || corner.type === 'none') return { x: 0, y: 0 }
      if (corner.type === 'radius') return { x: toC(Math.abs(corner.r || 0)), y: toC(Math.abs(corner.r || 0)) }
      if (corner.type === 'chamfer') return { x: toC(corner.dx || 0), y: toC(corner.dy || 0) }
      if (corner.type === 'notch')   return { x: toC(corner.dx || 0), y: toC(corner.dy || 0) }
      return { x: 0, y: 0 }
    }

    const TL = offs(tl), TR = offs(tr), BR = offs(br), BL = offs(bl)

    ctx.beginPath()
    ctx.moveTo(ox + TL.x, oy)
    ctx.lineTo(ox + dw - TR.x, oy)

    // TR — верхний правый
    if (tr.type === 'radius' && TR.x > 0) {
      if ((tr.r||0) > 0) {
        ctx.arcTo(ox+dw, oy, ox+dw, oy+TR.y, TR.x)
      } else {
        ctx.lineTo(ox+dw, oy)
        ctx.arc(ox+dw-TR.x, oy+TR.y, TR.x, -Math.PI/2, 0, false)
      }
    } else if (tr.type === 'chamfer') { ctx.lineTo(ox+dw, oy+TR.y) }
    else if (tr.type === 'notch') { ctx.lineTo(ox+dw-TR.x, oy); ctx.lineTo(ox+dw-TR.x, oy+TR.y); ctx.lineTo(ox+dw, oy+TR.y) }
    else { ctx.lineTo(ox+dw, oy) }

    ctx.lineTo(ox+dw, oy+dh-BR.y)

    // BR — нижний правый
    if (br.type === 'radius' && BR.x > 0) {
      if ((br.r||0) > 0) {
        ctx.arcTo(ox+dw, oy+dh, ox+dw-BR.x, oy+dh, BR.y)
      } else {
        ctx.lineTo(ox+dw, oy+dh)
        ctx.arc(ox+dw-BR.x, oy+dh-BR.y, BR.x, 0, Math.PI/2, false)
      }
    } else if (br.type === 'chamfer') { ctx.lineTo(ox+dw-BR.x, oy+dh) }
    else if (br.type === 'notch') { ctx.lineTo(ox+dw, oy+dh-BR.y); ctx.lineTo(ox+dw-BR.x, oy+dh-BR.y); ctx.lineTo(ox+dw-BR.x, oy+dh) }
    else { ctx.lineTo(ox+dw, oy+dh) }

    ctx.lineTo(ox+BL.x, oy+dh)

    // BL — нижний левый
    if (bl.type === 'radius' && BL.x > 0) {
      if ((bl.r||0) > 0) {
        ctx.arcTo(ox, oy+dh, ox, oy+dh-BL.y, BL.x)
      } else {
        ctx.lineTo(ox, oy+dh)
        ctx.arc(ox+BL.x, oy+dh-BL.y, BL.x, Math.PI/2, Math.PI, false)
      }
    } else if (bl.type === 'chamfer') { ctx.lineTo(ox, oy+dh-BL.y) }
    else if (bl.type === 'notch') { ctx.lineTo(ox+BL.x, oy+dh); ctx.lineTo(ox+BL.x, oy+dh-BL.y); ctx.lineTo(ox, oy+dh-BL.y) }
    else { ctx.lineTo(ox, oy+dh) }

    ctx.lineTo(ox, oy+TL.y)

    // TL — верхний левый
    if (tl.type === 'radius' && TL.x > 0) {
      if ((tl.r||0) > 0) {
        ctx.arcTo(ox, oy, ox+TL.x, oy, TL.y)
      } else {
        ctx.lineTo(ox, oy)
        ctx.arc(ox+TL.x, oy+TL.y, TL.x, Math.PI, Math.PI*3/2, false)
      }
    } else if (tl.type === 'chamfer') { ctx.lineTo(ox+TL.x, oy) }
    else if (tl.type === 'notch') { ctx.lineTo(ox, oy+TL.y); ctx.lineTo(ox+TL.x, oy+TL.y); ctx.lineTo(ox+TL.x, oy) }
    else { ctx.lineTo(ox, oy) }

    ctx.closePath()
    ctx.fillStyle = '#E6F1FB'; ctx.fill()
    ctx.strokeStyle = '#185FA5'; ctx.lineWidth = 1.5; ctx.stroke()

    // Вырезы
    ;(c.cutouts || []).forEach(cut => {
      ctx.fillStyle = '#fff'; ctx.strokeStyle = '#E24B4A'; ctx.lineWidth = 1
      if (cut.type === 'circle') {
        const d = cut.d || 100
        const r = toC(d / 2)
        // Позиционируем от края круга (как прямоугольник d×d)
        const pos = resolvePos(cut.sides||[], cut.offsets||{}, w, h, d, d)
        // Центр = левый верхний угол прямоугольника + радиус
        const cx = ox + (pos.x + d/2) * sc
        const cy = oy + (pos.y + d/2) * sc
        ctx.beginPath()
        ctx.arc(cx, cy, r, 0, Math.PI*2)
        ctx.fill(); ctx.stroke()
      } else {
        const pos = resolvePos(cut.sides||[], cut.offsets||{}, w, h, cut.w||100, cut.h||100)
        ctx.fillRect(ox+pos.x*sc, oy+pos.y*sc, pos.w*sc, pos.h*sc)
        ctx.strokeRect(ox+pos.x*sc, oy+pos.y*sc, pos.w*sc, pos.h*sc)
      }
    })

    // Пазы
    ;(c.grooves || []).forEach(g => {
      ctx.fillStyle = 'rgba(250,199,117,0.8)'; ctx.strokeStyle = '#BA7517'; ctx.lineWidth = 1
      // Определяем размеры паза по направлению
      const isH = g.dir === 'horizontal'
      const gW = isH ? (g.length||100) : (g.width||8)
      const gH = isH ? (g.width||8) : (g.length||100)
      const pos = resolvePos(g.sides||[], g.offsets||{}, w, h, gW, gH)
      ctx.fillRect(ox+pos.x*sc, oy+pos.y*sc, pos.w*sc, pos.h*sc)
      ctx.strokeRect(ox+pos.x*sc, oy+pos.y*sc, pos.w*sc, pos.h*sc)
    })

  }, [w, h, contour])

  return <canvas ref={ref} width={260} height={180}
    style={{ width:'100%', maxWidth:240, borderRadius:8, display:'block', margin:'0 auto' }} />
}

// ─── Редактор угла ────────────────────────────────────────────────────────────
function CornerEditor({ label, value = {}, onChange }) {
  const type = value.type || 'none'

  // Кнопки: [тип, иконка, подсказка, что установить при выборе]
  const BTNS = [
    { id: 'none',    icon: '—',  hint: 'Нет' },
    { id: 'radius',  icon: '⌒',  hint: 'Выпуклый радиус' },
    { id: 'concave', icon: '⌣',  hint: 'Вогнутый радиус' },
    { id: 'chamfer', icon: '◣',  hint: 'Фаска' },
    { id: 'notch',   icon: '⌐',  hint: 'Вырез угла' },
  ]

  const handleType = (id) => {
    // вогнутый хранится как radius с r<0
    const storeType = id === 'concave' ? 'radius' : id
    const base = { ...value, type: storeType }
    if (id === 'radius')   onChange({ ...base, r:  Math.abs(value.r  || 50) })
    else if (id === 'concave') onChange({ ...base, r: -(Math.abs(value.r || 50)) })
    else if (id === 'chamfer') onChange({ ...base, dx: value.dx || 50, dy: value.dy || 50 })
    else if (id === 'notch')   onChange({ ...base, dx: value.dx || 50, dy: value.dy || 50 })
    else onChange({ ...base })
  }

  // Для отображения — вогнутый тоже хранится как radius с r<0, но тип кнопки разный
  const activeBtn = type === 'radius' && (value.r || 0) < 0 ? 'concave' : type

  return (
    <div style={{ background:'var(--bg2)', borderRadius:'var(--radius)', padding:8 }}>
      <div style={{ fontSize:11, color:'var(--text-hint)', marginBottom:6, textAlign:'center' }}>{label}</div>
      <div style={{ display:'flex', gap:3, justifyContent:'center', marginBottom:8 }}>
        {BTNS.map(({id, icon, hint}) => (
          <button key={id} type="button" title={hint} onClick={() => handleType(id)}
            style={{ width:30, height:30, border: activeBtn===id?'1.5px solid var(--blue)':'0.5px solid var(--border-md)',
              borderRadius:6, background: activeBtn===id?'var(--blue-light)':'transparent',
              fontSize:15, cursor:'pointer', padding:0 }}>
            {icon}
          </button>
        ))}
      </div>

      {/* Выпуклый радиус */}
      {type==='radius' && (value.r||0) >= 0 && (
        <NumField label="Радиус R" value={Math.abs(value.r??50)} onChange={v=>onChange({...value,r:Math.abs(v)})} />
      )}

      {/* Вогнутый радиус */}
      {type==='radius' && (value.r||0) < 0 && (
        <NumField label="Радиус R" value={Math.abs(value.r??50)} onChange={v=>onChange({...value,r:-Math.abs(v)})} />
      )}

      {/* Фаска */}
      {type==='chamfer' && (
        <div style={{ display:'flex', gap:6 }}>
          <NumField label="По X →" value={value.dx??50} onChange={v=>onChange({...value,dx:v})} />
          <NumField label="По Y ↓" value={value.dy??50} onChange={v=>onChange({...value,dy:v})} />
        </div>
      )}

      {/* Вырез угла */}
      {type==='notch' && (
        <div style={{ display:'flex', gap:6 }}>
          <NumField label="По X →" value={value.dx??50} onChange={v=>onChange({...value,dx:v})} />
          <NumField label="По Y ↓" value={value.dy??50} onChange={v=>onChange({...value,dy:v})} />
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
      <div style={{ display:'flex', alignItems:'center', padding:'8px 10px', cursor:'pointer' }}
        onClick={() => setOpen(v => !v)}>
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
  const contour = detail.contour || { corners:{}, cutouts:[], grooves:[] }
  const [tab, setTab] = useState('corners')
  const w = Number(detail.w) || 0
  const h = Number(detail.h) || 0

  const upd = (patch) => onUpdate({ ...detail, contour: { ...contour, ...patch } })
  const setCorner = (key, val) => upd({ corners: { ...contour.corners, [key]: val } })

  const addCutout = (type) => {
    const cut = type === 'circle'
      ? { type:'circle', d:100, sides:[], offsets:{} }
      : { type:'rect', w:200, h:100, sides:[], offsets:{} }
    upd({ cutouts: [...(contour.cutouts||[]), cut] })
  }
  const updCutout = (i, patch) => {
    const cuts = [...(contour.cutouts||[])]
    cuts[i] = { ...cuts[i], ...patch }
    upd({ cutouts: cuts })
  }

  const addGroove = () => {
    upd({ grooves: [...(contour.grooves||[]), { dir:'horizontal', length:100, width:8, depth:10, sides:[], offsets:{} }] })
  }
  const updGroove = (i, patch) => {
    const gs = [...(contour.grooves||[])]
    gs[i] = { ...gs[i], ...patch }
    upd({ grooves: gs })
  }

  const hasContour = Object.values(contour.corners||{}).some(c=>c?.type&&c.type!=='none') ||
    (contour.cutouts||[]).length>0 || (contour.grooves||[]).length>0

  return (
    <div style={{ marginTop:10, borderTop:'0.5px solid var(--border)', paddingTop:10 }}>
      {w>0 && h>0 && <div style={{ marginBottom:12 }}><ContourPreview w={w} h={h} contour={contour} /></div>}

      <div style={{ display:'flex', gap:4, marginBottom:12, background:'var(--bg2)', borderRadius:'var(--radius)', padding:3 }}>
        {[['corners','Углы'],['cutouts','Вырезы'],['grooves','Пазы']].map(([id,label])=>(
          <button key={id} type="button" onClick={()=>setTab(id)}
            style={{ flex:1, padding:'6px 4px', border:'none', borderRadius:6, fontSize:12,
              background: tab===id?'var(--bg)':'transparent',
              color: tab===id?'var(--blue)':'var(--text-hint)',
              fontWeight: tab===id?500:400, cursor:'pointer' }}>
            {label}
          </button>
        ))}
      </div>

      {/* УГЛЫ */}
      {tab==='corners' && (
        <div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom:10 }}>
            <CornerEditor label="↖ Верх-лево"  value={contour.corners?.tl} onChange={v=>setCorner('tl',v)} />
            <CornerEditor label="↗ Верх-право" value={contour.corners?.tr} onChange={v=>setCorner('tr',v)} />
            <CornerEditor label="↙ Низ-лево"   value={contour.corners?.bl} onChange={v=>setCorner('bl',v)} />
            <CornerEditor label="↘ Низ-право"  value={contour.corners?.br} onChange={v=>setCorner('br',v)} />
          </div>
          <div style={{ display:'flex', gap:6 }}>
            <button type="button"
              onClick={()=>upd({corners:{tl:{type:'radius',r:50},tr:{type:'radius',r:50},br:{type:'radius',r:50},bl:{type:'radius',r:50}}})}
              style={{ flex:1, padding:'8px', border:'0.5px solid var(--border-md)', borderRadius:'var(--radius)',
                background:'transparent', fontSize:12, color:'var(--text-muted)', cursor:'pointer' }}>
              ⌒ Скруглить все R50
            </button>
            <button type="button"
              onClick={()=>upd({corners:{tl:{type:'notch',dx:50,dy:50},tr:{type:'notch',dx:50,dy:50},br:{type:'notch',dx:50,dy:50},bl:{type:'notch',dx:50,dy:50}}})}
              style={{ flex:1, padding:'8px', border:'0.5px solid var(--border-md)', borderRadius:'var(--radius)',
                background:'transparent', fontSize:12, color:'var(--text-muted)', cursor:'pointer' }}>
              ⌐ Вырез все 50×50
            </button>
          </div>
        </div>
      )}

      {/* ВЫРЕЗЫ */}
      {tab==='cutouts' && (
        <div>
          <div style={{ display:'flex', gap:8, marginBottom:12 }}>
            <button type="button" onClick={()=>addCutout('rect')}
              style={{ flex:1, padding:'8px', border:'0.5px dashed var(--border-md)', borderRadius:'var(--radius)',
                background:'transparent', fontSize:12, color:'var(--text-muted)', cursor:'pointer' }}>
              + Прямоугольный
            </button>
            <button type="button" onClick={()=>addCutout('circle')}
              style={{ flex:1, padding:'8px', border:'0.5px dashed var(--border-md)', borderRadius:'var(--radius)',
                background:'transparent', fontSize:12, color:'var(--text-muted)', cursor:'pointer' }}>
              + Круглый
            </button>
          </div>
          {!(contour.cutouts||[]).length && <p style={{ fontSize:12, color:'var(--text-hint)', textAlign:'center' }}>Нет вырезов</p>}
          {(contour.cutouts||[]).map((cut,i)=>(
            <CollapsibleItem key={i}
              title={`${cut.type==='circle'?'○ Круглый':'□ Прямоугольный'} #${i+1}`}
              onRemove={()=>upd({cutouts:(contour.cutouts||[]).filter((_,j)=>j!==i)})}>
              <div style={{ display:'flex', gap:8, marginBottom:10 }}>
                {cut.type==='circle'
                  ? <NumField label="Диаметр D" value={cut.d??100} onChange={v=>updCutout(i,{d:v})} />
                  : <>
                      <NumField label="Длина выреза" value={cut.w??200} onChange={v=>updCutout(i,{w:v})} />
                      <NumField label="Ширина выреза" value={cut.h??100} onChange={v=>updCutout(i,{h:v})} />
                    </>
                }
              </div>
              <SideOffsetPicker
                activeSides={cut.sides||[]}
                offsets={cut.offsets||{}}
                onChange={({sides,offsets})=>updCutout(i,{sides,offsets})} />
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
          {!(contour.grooves||[]).length && <p style={{ fontSize:12, color:'var(--text-hint)', textAlign:'center' }}>Нет пазов</p>}
          {(contour.grooves||[]).map((g,i)=>(
            <CollapsibleItem key={i} title={`Паз #${i+1}`}
              onRemove={()=>upd({grooves:(contour.grooves||[]).filter((_,j)=>j!==i)})}>

              {/* Направление паза */}
              <label style={{ fontSize:11, color:'var(--text-hint)', display:'block', marginBottom:6 }}>Направление паза</label>
              <div style={{ display:'flex', gap:6, marginBottom:10 }}>
                {[['horizontal','↔ Горизонтальный'],['vertical','↕ Вертикальный']].map(([id,label])=>(
                  <button key={id} type="button" onClick={()=>updGroove(i,{dir:id})}
                    style={{ flex:1, padding:'6px 4px', borderRadius:'var(--radius)', border:'none', fontSize:11,
                      background: (g.dir||'horizontal')===id?'var(--blue)':'var(--bg3)',
                      color: (g.dir||'horizontal')===id?'white':'var(--text-muted)', cursor:'pointer' }}>
                    {label}
                  </button>
                ))}
              </div>

              {/* Размеры */}
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:6, marginBottom:10 }}>
                <NumField label="Длина" value={g.length??100} onChange={v=>updGroove(i,{length:v})} />
                <NumField label="Ширина" value={g.width??8} onChange={v=>updGroove(i,{width:v})} />
                <NumField label="Глубина" value={g.depth??10} onChange={v=>updGroove(i,{depth:v})} />
              </div>

              {/* Позиционирование */}
              <SideOffsetPicker
                activeSides={g.sides||[]}
                offsets={g.offsets||{}}
                onChange={({sides,offsets})=>updGroove(i,{sides,offsets})} />
            </CollapsibleItem>
          ))}
        </div>
      )}

      {hasContour && (
        <button type="button" onClick={()=>upd({corners:{},cutouts:[],grooves:[]})}
          style={{ width:'100%', marginTop:8, padding:'6px', border:'0.5px solid var(--danger)',
            borderRadius:'var(--radius)', background:'transparent', fontSize:11, color:'var(--danger)', cursor:'pointer' }}>
          Сбросить контур
        </button>
      )}
    </div>
  )
}
