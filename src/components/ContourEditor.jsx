import { useState, useRef, useEffect } from 'react'

/**
 * contour = {
 *   corners: { tl, tr, br, bl }
 *     corner: { type: 'none'|'radius'|'chamfer', r: мм, dx: мм, dy: мм }
 *     radius: r — размер радиуса
 *     chamfer: dx — отступ по X, dy — отступ по Y
 *   cutouts: [ { type: 'rect'|'circle', side: 'top'|'right'|'bottom'|'left',
 *                sideOffset: мм, edgeOffset: мм, w: мм, h: мм, r: мм } ]
 *     sideOffset — отступ от выбранной стороны (глубина выреза)
 *     edgeOffset — отступ от левого/верхнего края стороны
 *   grooves: [ { side, fullLength: bool, offset: мм, length: мм, width: мм, depth: мм } ]
 * }
 */

const SIDES = [
  { id: 'top',    label: '↑ Верх' },
  { id: 'bottom', label: '↓ Низ' },
  { id: 'left',   label: '← Лево' },
  { id: 'right',  label: '→ Право' },
]

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
    const tl = corners.tl || {}
    const tr = corners.tr || {}
    const br = corners.br || {}
    const bl = corners.bl || {}

    const toC = v => (v || 0) * sc

    // Вычисляем отступы для каждого угла
    function cornerOffsets(corner) {
      if (!corner || !corner.type || corner.type === 'none') return { x: 0, y: 0 }
      if (corner.type === 'radius') return { x: toC(corner.r), y: toC(corner.r) }
      if (corner.type === 'chamfer') return { x: toC(corner.dx || corner.r || 0), y: toC(corner.dy || corner.r || 0) }
      return { x: 0, y: 0 }
    }

    const TL = cornerOffsets(tl)
    const TR = cornerOffsets(tr)
    const BR = cornerOffsets(br)
    const BL = cornerOffsets(bl)

    ctx.beginPath()

    // Начало — после TL по верхнему краю
    ctx.moveTo(ox + TL.x, oy)

    // Верхний край → TR
    ctx.lineTo(ox + dw - TR.x, oy)
    // Угол TR
    if (tr.type === 'radius' && TR.x > 0) {
      ctx.arcTo(ox + dw, oy, ox + dw, oy + TR.y, TR.x)
    } else if (tr.type === 'chamfer' && (TR.x > 0 || TR.y > 0)) {
      ctx.lineTo(ox + dw, oy + TR.y)
    } else {
      ctx.lineTo(ox + dw, oy)
    }

    // Правый край → BR
    ctx.lineTo(ox + dw, oy + dh - BR.y)
    // Угол BR
    if (br.type === 'radius' && BR.x > 0) {
      ctx.arcTo(ox + dw, oy + dh, ox + dw - BR.x, oy + dh, BR.y)
    } else if (br.type === 'chamfer' && (BR.x > 0 || BR.y > 0)) {
      ctx.lineTo(ox + dw - BR.x, oy + dh)
    } else {
      ctx.lineTo(ox + dw, oy + dh)
    }

    // Нижний край → BL
    ctx.lineTo(ox + BL.x, oy + dh)
    // Угол BL
    if (bl.type === 'radius' && BL.x > 0) {
      ctx.arcTo(ox, oy + dh, ox, oy + dh - BL.y, BL.x)
    } else if (bl.type === 'chamfer' && (BL.x > 0 || BL.y > 0)) {
      ctx.lineTo(ox, oy + dh - BL.y)
    } else {
      ctx.lineTo(ox, oy + dh)
    }

    // Левый край → TL
    ctx.lineTo(ox, oy + TL.y)
    // Угол TL
    if (tl.type === 'radius' && TL.x > 0) {
      ctx.arcTo(ox, oy, ox + TL.x, oy, TL.y)
    } else if (tl.type === 'chamfer' && (TL.x > 0 || TL.y > 0)) {
      ctx.lineTo(ox + TL.x, oy)
    } else {
      ctx.lineTo(ox, oy)
    }

    ctx.closePath()
    ctx.fillStyle = '#E6F1FB'
    ctx.fill()
    ctx.strokeStyle = '#185FA5'
    ctx.lineWidth = 1.5
    ctx.stroke()

    // Вырезы
    ;(c.cutouts || []).forEach(cut => {
      ctx.fillStyle = '#fff'
      ctx.strokeStyle = '#E24B4A'
      ctx.lineWidth = 1
      // Переводим позицию из "от стороны" в абсолютные координаты канваса
      let cx, cy, cw, ch
      const so = toC(cut.sideOffset || 0)
      const eo = toC(cut.edgeOffset || 0)
      const cW = toC(cut.w || 0)
      const cH = toC(cut.h || 0)

      if (cut.side === 'top')    { cx = ox + eo; cy = oy; cw = cW; ch = so }
      else if (cut.side === 'bottom') { cx = ox + eo; cy = oy + dh - so; cw = cW; ch = so }
      else if (cut.side === 'left')   { cx = ox; cy = oy + eo; cw = so; ch = cW }
      else                            { cx = ox + dw - so; cy = oy + eo; cw = so; ch = cW }

      if (cut.type === 'circle') {
        const r = toC(cut.r || 0)
        const ccx = ox + toC(cut.cx || w/2)
        const ccy = oy + toC(cut.cy || h/2)
        ctx.beginPath(); ctx.arc(ccx, ccy, r, 0, Math.PI * 2)
        ctx.fill(); ctx.stroke()
      } else {
        ctx.fillRect(cx, cy, cw, ch)
        ctx.strokeRect(cx, cy, cw, ch)
      }
    })

    // Пазы
    ;(c.grooves || []).forEach(g => {
      ctx.fillStyle = 'rgba(250,199,117,0.7)'
      ctx.strokeStyle = '#BA7517'
      ctx.lineWidth = 1
      const gDepth = toC(g.depth || 0)
      const gLen = g.fullLength ? (g.side === 'top' || g.side === 'bottom' ? dw : dh) : toC(g.length || 0)
      const gOff = g.fullLength ? 0 : toC(g.offset || 0)

      let gx, gy, gw, gh
      if (g.side === 'top')    { gx = ox + gOff; gy = oy; gw = gLen; gh = gDepth }
      else if (g.side === 'bottom') { gx = ox + gOff; gy = oy + dh - gDepth; gw = gLen; gh = gDepth }
      else if (g.side === 'left')   { gx = ox; gy = oy + gOff; gw = gDepth; gh = gLen }
      else                          { gx = ox + dw - gDepth; gy = oy + gOff; gw = gDepth; gh = gLen }

      ctx.fillRect(gx, gy, gw, gh)
      ctx.strokeRect(gx, gy, gw, gh)
    })

  }, [w, h, contour])

  return (
    <canvas ref={ref} width={240} height={160}
      style={{ width: '100%', maxWidth: 240, borderRadius: 8, display: 'block', margin: '0 auto' }} />
  )
}

// ─── Редактор угла ────────────────────────────────────────────────────────────
function CornerEditor({ label, value = {}, onChange }) {
  const type = value.type || 'none'

  return (
    <div style={{ background: 'var(--bg2)', borderRadius: 'var(--radius)', padding: 8 }}>
      <div style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 6, textAlign: 'center' }}>{label}</div>
      <div style={{ display: 'flex', gap: 4, justifyContent: 'center', marginBottom: 8 }}>
        {[['none','—'],['radius','⌒'],['chamfer','◣']].map(([id, icon]) => (
          <button key={id} type="button" onClick={() => onChange({ ...value, type: id })}
            style={{ width: 32, height: 32, border: type === id ? '1.5px solid var(--blue)' : '0.5px solid var(--border-md)',
              borderRadius: 6, background: type === id ? 'var(--blue-light)' : 'transparent',
              fontSize: 16, cursor: 'pointer' }}>
            {icon}
          </button>
        ))}
      </div>
      {type === 'radius' && (
        <NumField label="Радиус R" value={value.r ?? 50} onChange={v => onChange({ ...value, r: v })} />
      )}
      {type === 'chamfer' && (
        <div style={{ display: 'flex', gap: 6 }}>
          <NumField label="По X →" value={value.dx ?? 50} onChange={v => onChange({ ...value, dx: v })} />
          <NumField label="По Y ↓" value={value.dy ?? 50} onChange={v => onChange({ ...value, dy: v })} />
        </div>
      )}
    </div>
  )
}

// ─── Главный компонент ────────────────────────────────────────────────────────
export default function ContourEditor({ detail, onUpdate }) {
  const contour = detail.contour || { corners: {}, cutouts: [], grooves: [] }
  const [tab, setTab] = useState('corners')
  const w = Number(detail.w) || 0
  const h = Number(detail.h) || 0

  const upd = (patch) => onUpdate({ ...detail, contour: { ...contour, ...patch } })
  const setCorner = (key, val) => upd({ corners: { ...contour.corners, [key]: val } })

  const addCutout = (type) => {
    const cut = type === 'circle'
      ? { type: 'circle', cx: Math.round(w/2), cy: Math.round(h/2), r: 50 }
      : { type: 'rect', side: 'top', sideOffset: 100, edgeOffset: 50, w: 200, h: 100 }
    upd({ cutouts: [...(contour.cutouts||[]), cut] })
  }

  const updCutout = (i, patch) => {
    const cuts = [...(contour.cutouts||[])]
    cuts[i] = { ...cuts[i], ...patch }
    upd({ cutouts: cuts })
  }

  const addGroove = () => {
    upd({ grooves: [...(contour.grooves||[]), { side: 'top', fullLength: false, offset: 0, length: 100, width: 8, depth: 10 }] })
  }

  const updGroove = (i, patch) => {
    const gs = [...(contour.grooves||[])]
    gs[i] = { ...gs[i], ...patch }
    upd({ grooves: gs })
  }

  const hasContour = Object.values(contour.corners||{}).some(c=>c?.type&&c.type!=='none') ||
    (contour.cutouts||[]).length>0 || (contour.grooves||[]).length>0

  return (
    <div style={{ marginTop: 10, borderTop: '0.5px solid var(--border)', paddingTop: 10 }}>
      {w > 0 && h > 0 && (
        <div style={{ marginBottom: 12 }}>
          <ContourPreview w={w} h={h} contour={contour} />
        </div>
      )}

      {/* Табы */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 12, background: 'var(--bg2)', borderRadius: 'var(--radius)', padding: 3 }}>
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

      {/* ── УГЛЫ ── */}
      {tab === 'corners' && (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
            <CornerEditor label="↖ Верх-лево"  value={contour.corners?.tl} onChange={v=>setCorner('tl',v)} />
            <CornerEditor label="↗ Верх-право" value={contour.corners?.tr} onChange={v=>setCorner('tr',v)} />
            <CornerEditor label="↙ Низ-лево"   value={contour.corners?.bl} onChange={v=>setCorner('bl',v)} />
            <CornerEditor label="↘ Низ-право"  value={contour.corners?.br} onChange={v=>setCorner('br',v)} />
          </div>
          <button type="button" onClick={()=>upd({corners:{tl:{type:'radius',r:50},tr:{type:'radius',r:50},br:{type:'radius',r:50},bl:{type:'radius',r:50}}})}
            style={{ width:'100%', padding:'8px', border:'0.5px solid var(--border-md)', borderRadius:'var(--radius)',
              background:'transparent', fontSize:12, color:'var(--text-muted)', cursor:'pointer', marginBottom:6 }}>
            ⌒ Скруглить все углы R50
          </button>
        </div>
      )}

      {/* ── ВЫРЕЗЫ ── */}
      {tab === 'cutouts' && (
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

          {(contour.cutouts||[]).length===0 && (
            <p style={{ fontSize:12, color:'var(--text-hint)', textAlign:'center' }}>Нет вырезов</p>
          )}

          {(contour.cutouts||[]).map((cut,i)=>(
            <div key={i} style={{ background:'var(--bg2)', borderRadius:'var(--radius)', padding:10, marginBottom:8 }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
                <span style={{ fontSize:13, fontWeight:500 }}>
                  {cut.type==='circle'?'○ Круглый':'□ Прямоугольный'} #{i+1}
                </span>
                <button type="button" onClick={()=>upd({cutouts:(contour.cutouts||[]).filter((_,j)=>j!==i)})}
                  style={{ background:'none', border:'none', color:'var(--text-hint)', cursor:'pointer', fontSize:16 }}>✕</button>
              </div>

              {cut.type === 'circle' ? (
                <div style={{ display:'flex', gap:8 }}>
                  <NumField label="Центр X от левого" value={cut.cx??Math.round(w/2)} onChange={v=>updCutout(i,{cx:v})} />
                  <NumField label="Центр Y от верха" value={cut.cy??Math.round(h/2)} onChange={v=>updCutout(i,{cy:v})} />
                  <NumField label="Радиус" value={cut.r??50} onChange={v=>updCutout(i,{r:v})} />
                </div>
              ) : (
                <div>
                  {/* Сторона */}
                  <label style={{ fontSize:11, color:'var(--text-hint)', display:'block', marginBottom:4 }}>Сторона выреза</label>
                  <div style={{ display:'flex', gap:4, marginBottom:10, flexWrap:'wrap' }}>
                    {SIDES.map(s=>(
                      <button key={s.id} type="button" onClick={()=>updCutout(i,{side:s.id})}
                        style={{ padding:'5px 10px', borderRadius:20, fontSize:11, border:'none',
                          background: cut.side===s.id?'var(--blue)':'var(--bg3)',
                          color: cut.side===s.id?'white':'var(--text-muted)', cursor:'pointer' }}>
                        {s.label}
                      </button>
                    ))}
                  </div>
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
                    <NumField
                      label={cut.side==='top'||cut.side==='bottom'?'Глубина от края':'Глубина от края'}
                      value={cut.sideOffset??100} onChange={v=>updCutout(i,{sideOffset:v})} />
                    <NumField
                      label={cut.side==='left'||cut.side==='right'?'Отступ сверху':'Отступ слева'}
                      value={cut.edgeOffset??50} onChange={v=>updCutout(i,{edgeOffset:v})} />
                    <NumField
                      label={cut.side==='left'||cut.side==='right'?'Высота выреза':'Ширина выреза'}
                      value={cut.w??200} onChange={v=>updCutout(i,{w:v})} />
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── ПАЗЫ ── */}
      {tab === 'grooves' && (
        <div>
          <button type="button" onClick={addGroove}
            style={{ width:'100%', padding:'8px', border:'0.5px dashed var(--border-md)', borderRadius:'var(--radius)',
              background:'transparent', fontSize:12, color:'var(--text-muted)', cursor:'pointer', marginBottom:12 }}>
            + Добавить паз
          </button>

          {(contour.grooves||[]).length===0 && (
            <p style={{ fontSize:12, color:'var(--text-hint)', textAlign:'center' }}>Нет пазов</p>
          )}

          {(contour.grooves||[]).map((g,i)=>(
            <div key={i} style={{ background:'var(--bg2)', borderRadius:'var(--radius)', padding:10, marginBottom:8 }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
                <span style={{ fontSize:13, fontWeight:500 }}>Паз #{i+1}</span>
                <button type="button" onClick={()=>upd({grooves:(contour.grooves||[]).filter((_,j)=>j!==i)})}
                  style={{ background:'none', border:'none', color:'var(--text-hint)', cursor:'pointer', fontSize:16 }}>✕</button>
              </div>

              {/* Сторона */}
              <label style={{ fontSize:11, color:'var(--text-hint)', display:'block', marginBottom:4 }}>Сторона</label>
              <div style={{ display:'flex', gap:4, marginBottom:10, flexWrap:'wrap' }}>
                {SIDES.map(s=>(
                  <button key={s.id} type="button" onClick={()=>updGroove(i,{side:s.id})}
                    style={{ padding:'5px 10px', borderRadius:20, fontSize:11, border:'none',
                      background: g.side===s.id?'var(--blue)':'var(--bg3)',
                      color: g.side===s.id?'white':'var(--text-muted)', cursor:'pointer' }}>
                    {s.label}
                  </button>
                ))}
              </div>

              {/* На всю длину */}
              <div onClick={()=>updGroove(i,{fullLength:!g.fullLength})}
                style={{ display:'flex', alignItems:'center', gap:8, padding:'6px 8px',
                  background:'var(--bg)', borderRadius:'var(--radius)', cursor:'pointer', marginBottom:10, userSelect:'none' }}>
                <span style={{ fontSize:12, color:'var(--text-muted)', flex:1 }}>На всю длину стороны</span>
                <div style={{ width:32, height:18, borderRadius:9, background: g.fullLength?'var(--blue)':'var(--border-md)', position:'relative', flexShrink:0 }}>
                  <div style={{ width:14, height:14, borderRadius:'50%', background:'white', position:'absolute', top:2, left: g.fullLength?16:2, transition:'left 0.2s' }} />
                </div>
              </div>

              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
                {!g.fullLength && (
                  <>
                    <NumField label="Отступ от угла" value={g.offset??0} onChange={v=>updGroove(i,{offset:v})} />
                    <NumField label="Длина паза" value={g.length??100} onChange={v=>updGroove(i,{length:v})} />
                  </>
                )}
                <NumField label="Ширина паза" value={g.width??8} onChange={v=>updGroove(i,{width:v})} />
                <NumField label="Глубина фрезки" value={g.depth??10} onChange={v=>updGroove(i,{depth:v})} />
              </div>
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
