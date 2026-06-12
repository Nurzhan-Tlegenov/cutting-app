import { useState, useRef, useEffect } from 'react'

/**
 * Редактор контура детали
 * Операции: радиус угла, срез угла (фаска), внутренний вырез, паз по краю
 *
 * contour = {
 *   corners: { tl, tr, br, bl } — каждый угол: { type: 'none'|'radius'|'chamfer', value: мм }
 *   cutouts: [ { type: 'rect'|'circle', side: 'top'|'right'|'bottom'|'left', x, y, w, h, r } ]
 *   grooves:  [ { side: 'top'|'right'|'bottom'|'left', offset, width, depth } ]
 * }
 */

const CORNER_TYPES = [
  { id: 'none',    label: '—',   icon: '⬜' },
  { id: 'radius',  label: 'R',   icon: '⌒' },
  { id: 'chamfer', label: '∠',   icon: '◣' },
]

function NumField({ label, value, onChange, unit = 'мм', min = 0 }) {
  return (
    <div style={{ flex: 1 }}>
      {label && <label style={{ fontSize: 10, color: 'var(--text-hint)', display: 'block', marginBottom: 2 }}>{label}</label>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <input type="text" inputMode="numeric" value={value}
          onChange={e => { const v = e.target.value.replace(/[^0-9]/g, ''); onChange(v === '' ? 0 : Number(v)) }}
          style={{ padding: '6px 8px', fontSize: 13, width: '100%' }} />
        <span style={{ fontSize: 11, color: 'var(--text-hint)', whiteSpace: 'nowrap' }}>{unit}</span>
      </div>
    </div>
  )
}

// Превью детали с контуром на Canvas
function ContourPreview({ w, h, contour }) {
  const ref = useRef(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas || !w || !h) return
    const ctx = canvas.getContext('2d')
    const PW = canvas.width - 16, PH = canvas.height - 16
    const sc = Math.min(PW / w, PH / h)
    const dw = w * sc, dh = h * sc
    const ox = (canvas.width - dw) / 2, oy = (canvas.height - dh) / 2

    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#E6F1FB'
    ctx.strokeStyle = '#185FA5'
    ctx.lineWidth = 1.5

    const c = contour || {}
    const corners = c.corners || {}
    const { tl = {}, tr = {}, br = {}, bl = {} } = corners

    const R = (corner) => corner.type === 'radius' ? Math.min((corner.value || 0) * sc, dw / 2, dh / 2) : 0
    const CH = (corner) => corner.type === 'chamfer' ? Math.min((corner.value || 0) * sc, dw / 2, dh / 2) : 0

    ctx.beginPath()
    // TL
    if (tl.type === 'radius' && R(tl) > 0) {
      ctx.moveTo(ox + R(tl), oy)
      ctx.arcTo(ox, oy, ox, oy + R(tl), R(tl))
    } else if (tl.type === 'chamfer' && CH(tl) > 0) {
      ctx.moveTo(ox + CH(tl), oy)
      ctx.lineTo(ox, oy + CH(tl))
    } else {
      ctx.moveTo(ox, oy)
    }
    // TR
    if (tr.type === 'radius' && R(tr) > 0) {
      ctx.lineTo(ox + dw - R(tr), oy)
      ctx.arcTo(ox + dw, oy, ox + dw, oy + R(tr), R(tr))
    } else if (tr.type === 'chamfer' && CH(tr) > 0) {
      ctx.lineTo(ox + dw - CH(tr), oy)
      ctx.lineTo(ox + dw, oy + CH(tr))
    } else {
      ctx.lineTo(ox + dw, oy)
    }
    // BR
    if (br.type === 'radius' && R(br) > 0) {
      ctx.lineTo(ox + dw, oy + dh - R(br))
      ctx.arcTo(ox + dw, oy + dh, ox + dw - R(br), oy + dh, R(br))
    } else if (br.type === 'chamfer' && CH(br) > 0) {
      ctx.lineTo(ox + dw, oy + dh - CH(br))
      ctx.lineTo(ox + dw - CH(br), oy + dh)
    } else {
      ctx.lineTo(ox + dw, oy + dh)
    }
    // BL
    if (bl.type === 'radius' && R(bl) > 0) {
      ctx.lineTo(ox + R(bl), oy + dh)
      ctx.arcTo(ox, oy + dh, ox, oy + dh - R(bl), R(bl))
    } else if (bl.type === 'chamfer' && CH(bl) > 0) {
      ctx.lineTo(ox + CH(bl), oy + dh)
      ctx.lineTo(ox, oy + dh - CH(bl))
    } else {
      ctx.lineTo(ox, oy + dh)
    }
    // Закрываем
    if (tl.type === 'radius' && R(tl) > 0) ctx.lineTo(ox, oy + R(tl))
    else if (tl.type === 'chamfer' && CH(tl) > 0) ctx.lineTo(ox + CH(tl), oy)
    else ctx.lineTo(ox, oy)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()

    // Вырезы
    ;(c.cutouts || []).forEach(cut => {
      ctx.fillStyle = '#fff'
      ctx.strokeStyle = '#E24B4A'
      ctx.lineWidth = 1
      const cx = ox + (cut.x || 0) * sc
      const cy = oy + (cut.y || 0) * sc
      const cw = (cut.w || 0) * sc
      const ch = (cut.h || 0) * sc
      if (cut.type === 'circle') {
        ctx.beginPath()
        ctx.arc(cx, cy, (cut.r || 0) * sc, 0, Math.PI * 2)
        ctx.fill(); ctx.stroke()
      } else {
        ctx.fillRect(cx, cy, cw, ch)
        ctx.strokeRect(cx, cy, cw, ch)
      }
    })

    // Пазы
    ctx.fillStyle = '#FAC775'
    ctx.strokeStyle = '#BA7517'
    ;(c.grooves || []).forEach(g => {
      const gd = (g.depth || 0) * sc
      const gw = (g.width || 0) * sc
      const go = (g.offset || 0) * sc
      ctx.beginPath()
      if (g.side === 'top') ctx.rect(ox + go, oy, gw, gd)
      else if (g.side === 'bottom') ctx.rect(ox + go, oy + dh - gd, gw, gd)
      else if (g.side === 'left') ctx.rect(ox, oy + go, gd, gw)
      else if (g.side === 'right') ctx.rect(ox + dw - gd, oy + go, gd, gw)
      ctx.fill(); ctx.stroke()
    })

  }, [w, h, contour])

  return <canvas ref={ref} width={200} height={140}
    style={{ width: '100%', maxWidth: 200, borderRadius: 6, display: 'block', margin: '0 auto' }} />
}

// Редактор одного угла
function CornerEditor({ label, value = {}, onChange }) {
  const type = value.type || 'none'
  const val = value.value || 0
  return (
    <div style={{ flex: 1, textAlign: 'center' }}>
      <div style={{ fontSize: 10, color: 'var(--text-hint)', marginBottom: 4 }}>{label}</div>
      <div style={{ display: 'flex', gap: 2, marginBottom: 4, justifyContent: 'center' }}>
        {CORNER_TYPES.map(ct => (
          <button key={ct.id} type="button" onClick={() => onChange({ ...value, type: ct.id })}
            style={{ width: 28, height: 28, border: type === ct.id ? '1.5px solid var(--blue)' : '0.5px solid var(--border-md)',
              borderRadius: 4, background: type === ct.id ? 'var(--blue-light)' : 'transparent',
              fontSize: 14, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {ct.icon}
          </button>
        ))}
      </div>
      {type !== 'none' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <input type="text" inputMode="numeric" value={val}
            onChange={e => { const v = e.target.value.replace(/[^0-9]/g, ''); onChange({ ...value, value: v === '' ? 0 : Number(v) }) }}
            style={{ padding: '4px 6px', fontSize: 12, width: '100%', textAlign: 'center' }} />
          <span style={{ fontSize: 10, color: 'var(--text-hint)' }}>мм</span>
        </div>
      )}
    </div>
  )
}

export default function ContourEditor({ detail, onUpdate }) {
  const contour = detail.contour || { corners: {}, cutouts: [], grooves: [] }
  const [tab, setTab] = useState('corners') // corners | cutouts | grooves
  const w = Number(detail.w) || 0
  const h = Number(detail.h) || 0

  const updateContour = (patch) => {
    onUpdate({ ...detail, contour: { ...contour, ...patch } })
  }

  const setCorner = (key, val) => {
    updateContour({ corners: { ...contour.corners, [key]: val } })
  }

  const addCutout = (type) => {
    const newCut = type === 'circle'
      ? { type: 'circle', x: Math.round(w / 2), y: Math.round(h / 2), r: 50 }
      : { type: 'rect', x: 100, y: 100, w: 200, h: 150 }
    updateContour({ cutouts: [...(contour.cutouts || []), newCut] })
  }

  const updateCutout = (i, patch) => {
    const cuts = [...(contour.cutouts || [])]
    cuts[i] = { ...cuts[i], ...patch }
    updateContour({ cutouts: cuts })
  }

  const removeCutout = (i) => {
    updateContour({ cutouts: (contour.cutouts || []).filter((_, j) => j !== i) })
  }

  const addGroove = (side) => {
    updateContour({ grooves: [...(contour.grooves || []), { side, offset: 100, width: 100, depth: 10 }] })
  }

  const updateGroove = (i, patch) => {
    const gs = [...(contour.grooves || [])]
    gs[i] = { ...gs[i], ...patch }
    updateContour({ grooves: gs })
  }

  const removeGroove = (i) => {
    updateContour({ grooves: (contour.grooves || []).filter((_, j) => j !== i) })
  }

  const hasContour = Object.values(contour.corners || {}).some(c => c?.type && c.type !== 'none') ||
    (contour.cutouts || []).length > 0 || (contour.grooves || []).length > 0

  return (
    <div style={{ marginTop: 10, borderTop: '0.5px solid var(--border)', paddingTop: 10 }}>
      {/* Превью */}
      {w > 0 && h > 0 && (
        <div style={{ marginBottom: 12 }}>
          <ContourPreview w={w} h={h} contour={contour} />
        </div>
      )}

      {/* Табы */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 12, background: 'var(--bg2)', borderRadius: 'var(--radius)', padding: 3 }}>
        {[['corners','Углы'],['cutouts','Вырезы'],['grooves','Пазы']].map(([id, label]) => (
          <button key={id} type="button" onClick={() => setTab(id)}
            style={{ flex: 1, padding: '6px 4px', border: 'none', borderRadius: 6, fontSize: 12,
              background: tab === id ? 'var(--bg)' : 'transparent',
              color: tab === id ? 'var(--blue)' : 'var(--text-hint)',
              fontWeight: tab === id ? 500 : 400, cursor: 'pointer' }}>
            {label}
          </button>
        ))}
      </div>

      {/* Углы */}
      {tab === 'corners' && (
        <div>
          <p style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 8, textAlign: 'center' }}>
            ⌒ = Радиус · ◣ = Фаска · — = Без изменений
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <CornerEditor label="↖ Верх-лево" value={contour.corners?.tl} onChange={v => setCorner('tl', v)} />
            <CornerEditor label="↗ Верх-право" value={contour.corners?.tr} onChange={v => setCorner('tr', v)} />
            <CornerEditor label="↙ Низ-лево" value={contour.corners?.bl} onChange={v => setCorner('bl', v)} />
            <CornerEditor label="↘ Низ-право" value={contour.corners?.br} onChange={v => setCorner('br', v)} />
          </div>
          <button type="button" onClick={() => {
            const allR = { type: 'radius', value: 50 }
            updateContour({ corners: { tl: allR, tr: allR, br: allR, bl: allR } })
          }} style={{ width: '100%', marginTop: 10, padding: '8px', border: '0.5px solid var(--border-md)',
            borderRadius: 'var(--radius)', background: 'transparent', fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}>
            ⌒ Скруглить все углы R50
          </button>
        </div>
      )}

      {/* Вырезы */}
      {tab === 'cutouts' && (
        <div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <button type="button" onClick={() => addCutout('rect')}
              style={{ flex: 1, padding: '8px', border: '0.5px dashed var(--border-md)', borderRadius: 'var(--radius)',
                background: 'transparent', fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}>
              + Прямоугольный
            </button>
            <button type="button" onClick={() => addCutout('circle')}
              style={{ flex: 1, padding: '8px', border: '0.5px dashed var(--border-md)', borderRadius: 'var(--radius)',
                background: 'transparent', fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}>
              + Круглый
            </button>
          </div>
          {(contour.cutouts || []).length === 0 && (
            <p style={{ fontSize: 12, color: 'var(--text-hint)', textAlign: 'center' }}>Нет вырезов</p>
          )}
          {(contour.cutouts || []).map((cut, i) => (
            <div key={i} style={{ background: 'var(--bg2)', borderRadius: 'var(--radius)', padding: '10px', marginBottom: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 500 }}>{cut.type === 'circle' ? '○ Круглый' : '□ Прямоугольный'} #{i+1}</span>
                <button type="button" onClick={() => removeCutout(i)}
                  style={{ background: 'none', border: 'none', color: 'var(--text-hint)', cursor: 'pointer', fontSize: 16 }}>✕</button>
              </div>
              {cut.type === 'circle' ? (
                <div style={{ display: 'flex', gap: 8 }}>
                  <NumField label="X от левого края" value={cut.x || 0} onChange={v => updateCutout(i, { x: v })} />
                  <NumField label="Y от верхнего края" value={cut.y || 0} onChange={v => updateCutout(i, { y: v })} />
                  <NumField label="Радиус" value={cut.r || 0} onChange={v => updateCutout(i, { r: v })} />
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <NumField label="X от левого края" value={cut.x || 0} onChange={v => updateCutout(i, { x: v })} />
                  <NumField label="Y от верхнего края" value={cut.y || 0} onChange={v => updateCutout(i, { y: v })} />
                  <NumField label="Ширина" value={cut.w || 0} onChange={v => updateCutout(i, { w: v })} />
                  <NumField label="Высота" value={cut.h || 0} onChange={v => updateCutout(i, { h: v })} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Пазы */}
      {tab === 'grooves' && (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 12 }}>
            {['top','right','bottom','left'].map(side => {
              const labels = { top: '↑ Верх', right: '→ Право', bottom: '↓ Низ', left: '← Лево' }
              return (
                <button key={side} type="button" onClick={() => addGroove(side)}
                  style={{ padding: '8px', border: '0.5px dashed var(--border-md)', borderRadius: 'var(--radius)',
                    background: 'transparent', fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}>
                  + {labels[side]}
                </button>
              )
            })}
          </div>
          {(contour.grooves || []).length === 0 && (
            <p style={{ fontSize: 12, color: 'var(--text-hint)', textAlign: 'center' }}>Нет пазов</p>
          )}
          {(contour.grooves || []).map((g, i) => {
            const labels = { top: '↑ Верх', right: '→ Право', bottom: '↓ Низ', left: '← Лево' }
            return (
              <div key={i} style={{ background: 'var(--bg2)', borderRadius: 'var(--radius)', padding: '10px', marginBottom: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>Паз {labels[g.side]} #{i+1}</span>
                  <button type="button" onClick={() => removeGroove(i)}
                    style={{ background: 'none', border: 'none', color: 'var(--text-hint)', cursor: 'pointer', fontSize: 16 }}>✕</button>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <NumField label="Отступ" value={g.offset || 0} onChange={v => updateGroove(i, { offset: v })} />
                  <NumField label="Ширина" value={g.width || 0} onChange={v => updateGroove(i, { width: v })} />
                  <NumField label="Глубина" value={g.depth || 0} onChange={v => updateGroove(i, { depth: v })} />
                </div>
              </div>
            )
          })}
        </div>
      )}

      {hasContour && (
        <button type="button" onClick={() => updateContour({ corners: {}, cutouts: [], grooves: [] })}
          style={{ width: '100%', marginTop: 8, padding: '6px', border: '0.5px solid var(--danger)', borderRadius: 'var(--radius)',
            background: 'transparent', fontSize: 11, color: 'var(--danger)', cursor: 'pointer' }}>
          Сбросить контур
        </button>
      )}
    </div>
  )
}
