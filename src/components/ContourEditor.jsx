import { useState, useRef, useEffect } from 'react'

/**
 * Позиционирование выреза/паза — от выбранных сторон:
 * sides: массив активных сторон ['top','left'] и для каждой — offsets[side] = мм
 * Если сторона не выбрана — позиция свободная (задаётся вручную)
 */

function NumField({ label, value, onChange, unit = 'мм' }) {
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      {label && <label style={{ fontSize: 10, color: 'var(--text-hint)', display: 'block', marginBottom: 2 }}>{label}</label>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <input type="text" inputMode="numeric" value={value ?? 0}
          onChange={e => { const v = e.target.value.replace(/[^0-9]/g, ''); onChange(v === '' ? 0 : Number(v)) }}
          style={{ padding: '6px 6px', fontSize: 13, width: '100%' }} />
        <span style={{ fontSize: 10, color: 'var(--text-hint)', flexShrink: 0 }}>{unit}</span>
      </div>
    </div>
  )
}

const SIDE_BTNS = [
  { id: 'top',    label: '↑ Верх' },
  { id: 'bottom', label: '↓ Низ' },
  { id: 'left',   label: '← Лево' },
  { id: 'right',  label: '→ Право' },
]

// Выбор сторон + отступы
function SideOffsetPicker({ activeSides = [], offsets = {}, onChange }) {
  const toggle = (id) => {
    const next = activeSides.includes(id)
      ? activeSides.filter(s => s !== id)
      : [...activeSides, id]
    onChange({ sides: next, offsets })
  }
  const setOffset = (id, val) => {
    onChange({ sides: activeSides, offsets: { ...offsets, [id]: val } })
  }
  return (
    <div>
      <label style={{ fontSize: 11, color: 'var(--text-hint)', display: 'block', marginBottom: 6 }}>
        Отступ от сторон
      </label>
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
              label={`Отступ ${SIDE_BTNS.find(s=>s.id===id)?.label}`}
              value={offsets[id] ?? 0}
              onChange={v => setOffset(id, v)} />
          ))}
        </div>
      )}
      {activeSides.length === 0 && (
        <p style={{ fontSize: 11, color: 'var(--text-hint)', textAlign: 'center' }}>
          Выберите стороны для привязки
        </p>
      )}
    </div>
  )
}

// Вычисляем позицию выреза/паза по сторонам и отступам
function resolvePosition(sides, offsets, w, h, itemW, itemH) {
  let x = (w - itemW) / 2  // по умолчанию по центру
  let y = (h - itemH) / 2
  if (sides.includes('left'))   x = offsets.left ?? 0
  if (sides.includes('right'))  x = w - itemW - (offsets.right ?? 0)
  if (sides.includes('top'))    y = offsets.top ?? 0
  if (sides.includes('bottom')) y = h - itemH - (offsets.bottom ?? 0)
  // Если обе горизонтальные — берём размер между ними
  if (sides.includes('left') && sides.includes('right'))
    itemW = w - (offsets.left ?? 0) - (offsets.right ?? 0)
  if (sides.includes('top') && sides.includes('bottom'))
    itemH = h - (offsets.top ?? 0) - (offsets.bottom ?? 0)
  return { x, y, w: itemW, h: itemH }
}

// ─── Превью ───────────────────────────────────────────────────────────────────
function ContourPreview({ w, h, contour }) {
  const ref = useRef(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas || !w || !h) return
    const ctx = canvas.getContext('2d')
    const PW = canvas.width - 20, PH = canvas.height - 20
    const sc = Math.min(PW / w, PH / h)
    const dw = w * sc, dh = h * sc
    const ox = (canvas.width - dw) / 2, oy = (canvas.height - dh) / 2

    ctx.clearRect(0, 0, canvas.width, canvas.height)

    const c = contour || {}
    const corners = c.corners || {}
    const tl = corners.tl || {}, tr = corners.tr || {}
    const br = corners.br || {}, bl = corners.bl || {}

    const toC = v => (v || 0) * sc

    function offs(corner) {
      if (!corner?.type || corner.type === 'none') return { x: 0, y: 0 }
      if (corner.type === 'radius') return { x: toC(corner.r), y: toC(corner.r) }
      if (corner.type === 'chamfer') return { x: toC(corner.dx || 0), y: toC(corner.dy || 0) }
      return { x: 0, y: 0 }
    }

    const TL = offs(tl), TR = offs(tr), BR = offs(br), BL = offs(bl)

    ctx.beginPath()
    ctx.moveTo(ox + TL.x, oy)
    ctx.lineTo(ox + dw - TR.x, oy)
    if (tr.type === 'radius' && TR.x > 0) ctx.arcTo(ox+dw, oy, ox+dw, oy+TR.y, TR.x)
    else if (tr.type === 'chamfer') ctx.lineTo(ox+dw, oy+TR.y)
    else ctx.lineTo(ox+dw, oy)
    ctx.lineTo(ox+dw, oy+dh-BR.y)
    if (br.type === 'radius' && BR.x > 0) ctx.arcTo(ox+dw, oy+dh, ox+dw-BR.x, oy+dh, BR.y)
    else if (br.type === 'chamfer') ctx.lineTo(ox+dw-BR.x, oy+dh)
    else ctx.lineTo(ox+dw, oy+dh)
    ctx.lineTo(ox+BL.x, oy+dh)
    if (bl.type === 'radius' && BL.x > 0) ctx.arcTo(ox, oy+dh, ox, oy+dh-BL.y, BL.x)
    else if (bl.type === 'chamfer') ctx.lineTo(ox, oy+dh-BL.y)
    else ctx.lineTo(ox, oy+dh)
    ctx.lineTo(ox, oy+TL.y)
    if (tl.type === 'radius' && TL.x > 0) ctx.arcTo(ox, oy, ox+TL.x, oy, TL.y)
    else if (tl.type === 'chamfer') ctx.lineTo(ox+TL.x, oy)
    else ctx.lineTo(ox, oy)
    ctx.closePath()
    ctx.fillStyle = '#E6F1FB'; ctx.fill()
    ctx.strokeStyle = '#185FA5'; ctx.lineWidth = 1.5; ctx.stroke()

    // Вырезы
    ;(c.cutouts || []).forEach(cut => {
      ctx.fillStyle = '#fff'; ctx.strokeStyle = '#E24B4A'; ctx.lineWidth = 1
      if (cut.type === 'circle') {
        const pos = resolvePosition(cut.sides||[], cut.offsets||{}, w, h, 0, 0)
        const cx = ox + pos.x * sc
        const cy = oy + pos.y * sc
        const r = toC(cut.r || 0)
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI*2); ctx.fill(); ctx.stroke()
      } else {
        const pos = resolvePosition(cut.sides||[], cut.offsets||{}, w, h, cut.w||100, cut.h||100)
        ctx.fillRect(ox+pos.x*sc, oy+pos.y*sc, pos.w*sc, pos.h*sc)
        ctx.strokeRect(ox+pos.x*sc, oy+pos.y*sc, pos.w*sc, pos.h*sc)
      }
    })

    // Пазы
    ;(c.grooves || []).forEach(g => {
      ctx.fillStyle = 'rgba(250,199,117,0.8)'; ctx.strokeStyle = '#BA7517'; ctx.lineWidth = 1
      const pos = resolvePosition(g.sides||[], g.offsets||{}, w, h, g.length||100, g.width||8)
      ctx.fillRect(ox+pos.x*sc, oy+pos.y*sc, pos.w*sc, pos.h*sc)
      ctx.strokeRect(ox+pos.x*sc, oy+pos.y*sc, pos.w*sc, pos.h*sc)
    })

  }, [w, h, contour])

  return <canvas ref={ref} width={240} height={160}
    style={{ width:'100%', maxWidth:240, borderRadius:8, display:'block', margin:'0 auto' }} />
}

// ─── Редактор угла ────────────────────────────────────────────────────────────
function CornerEditor({ label, value = {}, onChange }) {
  const type = value.type || 'none'
  return (
    <div style={{ background:'var(--bg2)', borderRadius:'var(--radius)', padding:8 }}>
      <div style={{ fontSize:11, color:'var(--text-hint)', marginBottom:6, textAlign:'center' }}>{label}</div>
      <div style={{ display:'flex', gap:4, justifyContent:'center', marginBottom:8 }}>
        {[['none','—'],['radius','⌒'],['chamfer','◣']].map(([id,icon])=>(
          <button key={id} type="button" onClick={()=>onChange({...value,type:id})}
            style={{ width:32, height:32, border: type===id?'1.5px solid var(--blue)':'0.5px solid var(--border-md)',
              borderRadius:6, background: type===id?'var(--blue-light)':'transparent', fontSize:16, cursor:'pointer' }}>
            {icon}
          </button>
        ))}
      </div>
      {type==='radius' && <NumField label="Радиус R" value={value.r??50} onChange={v=>onChange({...value,r:v})} />}
      {type==='chamfer' && (
        <div style={{ display:'flex', gap:6 }}>
          <NumField label="По X →" value={value.dx??50} onChange={v=>onChange({...value,dx:v})} />
          <NumField label="По Y ↓" value={value.dy??50} onChange={v=>onChange({...value,dy:v})} />
        </div>
      )}
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
      ? { type:'circle', r:50, sides:[], offsets:{} }
      : { type:'rect', w:200, h:100, sides:[], offsets:{} }
    upd({ cutouts: [...(contour.cutouts||[]), cut] })
  }

  const updCutout = (i, patch) => {
    const cuts = [...(contour.cutouts||[])]
    cuts[i] = { ...cuts[i], ...patch }
    upd({ cutouts: cuts })
  }

  const addGroove = () => {
    upd({ grooves: [...(contour.grooves||[]), { length:100, width:8, depth:10, sides:[], offsets:{} }] })
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
          <button type="button" onClick={()=>upd({corners:{tl:{type:'radius',r:50},tr:{type:'radius',r:50},br:{type:'radius',r:50},bl:{type:'radius',r:50}}})}
            style={{ width:'100%', padding:'8px', border:'0.5px solid var(--border-md)', borderRadius:'var(--radius)',
              background:'transparent', fontSize:12, color:'var(--text-muted)', cursor:'pointer' }}>
            ⌒ Скруглить все углы R50
          </button>
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
            <div key={i} style={{ background:'var(--bg2)', borderRadius:'var(--radius)', padding:10, marginBottom:8 }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:10 }}>
                <span style={{ fontSize:13, fontWeight:500 }}>{cut.type==='circle'?'○ Круглый':'□ Прямоугольный'} #{i+1}</span>
                <button type="button" onClick={()=>upd({cutouts:(contour.cutouts||[]).filter((_,j)=>j!==i)})}
                  style={{ background:'none', border:'none', color:'var(--text-hint)', cursor:'pointer', fontSize:16 }}>✕</button>
              </div>

              {/* Размеры */}
              <div style={{ display:'flex', gap:8, marginBottom:12 }}>
                {cut.type==='circle' ? (
                  <NumField label="Радиус R" value={cut.r??50} onChange={v=>updCutout(i,{r:v})} />
                ) : (
                  <>
                    <NumField label="Длина выреза" value={cut.w??200} onChange={v=>updCutout(i,{w:v})} />
                    <NumField label="Ширина выреза" value={cut.h??100} onChange={v=>updCutout(i,{h:v})} />
                  </>
                )}
              </div>

              {/* Позиционирование */}
              <SideOffsetPicker
                activeSides={cut.sides||[]}
                offsets={cut.offsets||{}}
                onChange={({sides,offsets})=>updCutout(i,{sides,offsets})} />
            </div>
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
            <div key={i} style={{ background:'var(--bg2)', borderRadius:'var(--radius)', padding:10, marginBottom:8 }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:10 }}>
                <span style={{ fontSize:13, fontWeight:500 }}>Паз #{i+1}</span>
                <button type="button" onClick={()=>upd({grooves:(contour.grooves||[]).filter((_,j)=>j!==i)})}
                  style={{ background:'none', border:'none', color:'var(--text-hint)', cursor:'pointer', fontSize:16 }}>✕</button>
              </div>

              {/* Размеры */}
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:6, marginBottom:12 }}>
                <NumField label="Длина" value={g.length??100} onChange={v=>updGroove(i,{length:v})} />
                <NumField label="Ширина" value={g.width??8} onChange={v=>updGroove(i,{width:v})} />
                <NumField label="Глубина" value={g.depth??10} onChange={v=>updGroove(i,{depth:v})} />
              </div>

              {/* Позиционирование */}
              <SideOffsetPicker
                activeSides={g.sides||[]}
                offsets={g.offsets||{}}
                onChange={({sides,offsets})=>updGroove(i,{sides,offsets})} />
            </div>
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
