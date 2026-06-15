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

// ─── Начальные вершины прямоугольника (0,0 = нижний левый, Y вверх) ──────────
function makeRect(w, h) {
  return [
    { x: 0, y: 0, r: 0 },   // нижний левый
    { x: w, y: 0, r: 0 },   // нижний правый
    { x: w, y: h, r: 0 },   // верхний правый
    { x: 0, y: h, r: 0 },   // верхний левый
  ]
}

// ─── Рисование пути по вершинам с радиусами ───────────────────────────────────
function buildPath(ctx, verts, sc, ox, oy, dh) {
  if (!verts || verts.length < 2) return
  const n = verts.length
  const cv = verts.map(v => ({
    x: ox + v.x * sc,
    y: oy + dh - v.y * sc,
    r: (v.r || 0) * sc,
    type: v.type || 'point',
  }))

  ctx.beginPath()
  for (let i = 0; i < n; i++) {
    const curr = cv[i]
    if (i === 0) ctx.moveTo(curr.x, curr.y)

    const next = cv[(i + 1) % n]

    // Если ТЕКУЩАЯ точка — контрольная точка дуги (type='arc')
    if (curr.type === 'arc') {
      // Собираем всю группу arc-точек
      const p0 = cv[(i - 1 + n) % n]
      const arcGroup = [p0]
      let j = i
      while (j < n && cv[j % n].type === 'arc') {
        arcGroup.push(cv[j % n])
        j++
      }
      arcGroup.push(cv[j % n])

      // Для каждой тройки соседних точек строим дугу окружности
      // Точки: arcGroup[0], arcGroup[1], ..., arcGroup[last]
      // Рисуем дуги: (0,1,2), (2,3,4), ... строго через точки
      const drawArcThrough3 = (a, b, c) => {
        const D = 2*(a.x*(b.y-c.y) + b.x*(c.y-a.y) + c.x*(a.y-b.y))
        if (Math.abs(D) < 0.001) {
          ctx.lineTo(c.x, c.y)
          return
        }
        const ux = ((a.x*a.x+a.y*a.y)*(b.y-c.y) + (b.x*b.x+b.y*b.y)*(c.y-a.y) + (c.x*c.x+c.y*c.y)*(a.y-b.y)) / D
        const uy = ((a.x*a.x+a.y*a.y)*(c.x-b.x) + (b.x*b.x+b.y*b.y)*(a.x-c.x) + (c.x*c.x+c.y*c.y)*(b.x-a.x)) / D
        const r2 = Math.hypot(a.x-ux, a.y-uy)
        const sa = Math.atan2(a.y-uy, a.x-ux)
        const ma = Math.atan2(b.y-uy, b.x-ux)
        const ea = Math.atan2(c.y-uy, c.x-ux)
        const norm = (a) => { let d = a - sa; while(d < 0) d += Math.PI*2; return d }
        const ccw = norm(ma) > norm(ea)
        ctx.arc(ux, uy, r2, sa, ea, ccw)
      }

      if (arcGroup.length === 3) {
        // Ровно 3 точки — одна дуга
        drawArcThrough3(arcGroup[0], arcGroup[1], arcGroup[2])
      } else {
        // 4+ точек — строим дуги через каждые 3 соседних
        // arcGroup[0]-[1]-[2], потом [2]-[3]-[4] и т.д.
        for (let k = 0; k+2 < arcGroup.length; k += 2) {
          const a = arcGroup[k], b = arcGroup[k+1], c = arcGroup[k+2]
          drawArcThrough3(a, b, c)
        }
        // Если нечётное число промежуточных — добиваем последний отрезок
        if (arcGroup.length % 2 === 1) {
          ctx.lineTo(arcGroup[arcGroup.length-1].x, arcGroup[arcGroup.length-1].y)
        }
      }

      i = j - 1
      continue
    }

    // Обычный отрезок с радиусом скругления
    const prev = cv[(i - 1 + n) % n]
    const r = curr.r

    // Вычисляем касательную к дуге в точке соединения с curr
    // Для этого находим центр описанной окружности дуги и берём перпендикуляр
    const arcTangentAt = (arcPtIdx, atPt) => {
      // Собираем группу arc-точек
      let start = arcPtIdx
      while (cv[(start - 1 + n) % n].type === 'arc') start = (start - 1 + n) % n
      let end = arcPtIdx
      while (cv[(end + 1) % n].type === 'arc') end = (end + 1) % n

      const p1 = cv[(start - 1 + n) % n]            // начало дуги
      const pm = cv[start]                            // первая arc-точка
      const p3 = cv[(end + 1) % n]                   // конец дуги

      // Центр окружности через p1, pm, p3
      const ax = p1.x, ay = p1.y
      const bx = pm.x, by = pm.y
      const cx2 = p3.x, cy2 = p3.y
      const D = 2*(ax*(by-cy2)+bx*(cy2-ay)+cx2*(ay-by))
      if (Math.abs(D) < 0.001) return null

      const ux = ((ax*ax+ay*ay)*(by-cy2)+(bx*bx+by*by)*(cy2-ay)+(cx2*cx2+cy2*cy2)*(ay-by))/D
      const uy = ((ax*ax+ay*ay)*(cx2-bx)+(bx*bx+by*by)*(ax-cx2)+(cx2*cx2+cy2*cy2)*(bx-ax))/D

      // Касательная в точке atPt = перпендикуляр к вектору (center→atPt)
      const rx = atPt.x - ux, ry = atPt.y - uy
      // Два перпендикуляра: (-ry, rx) и (ry, -rx)
      // Выбираем тот что смотрит от curr наружу (в сторону противоположной точки)
      return { t1: { x: atPt.x - ry, y: atPt.y + rx }, t2: { x: atPt.x + ry, y: atPt.y - rx } }
    }

    let prevDir = prev
    if (prev.type === 'arc') {
      const tg = arcTangentAt((i - 1 + n) % n, curr)
      if (tg) {
        // Берём точку на касательной в сторону "от дуги"
        const pp = cv[(i - 2 + n) % n]
        // Выбираем направление касательной совпадающее с направлением обхода
        const d1 = Math.hypot(tg.t1.x - pp.x, tg.t1.y - pp.y)
        const d2 = Math.hypot(tg.t2.x - pp.x, tg.t2.y - pp.y)
        prevDir = d1 < d2 ? tg.t1 : tg.t2
      }
    }

    let nextDir = next
    if (next.type === 'arc') {
      const tg = arcTangentAt((i + 1) % n, curr)
      if (tg) {
        const nn = cv[(i + 2) % n]
        const d1 = Math.hypot(tg.t1.x - nn.x, tg.t1.y - nn.y)
        const d2 = Math.hypot(tg.t2.x - nn.x, tg.t2.y - nn.y)
        nextDir = d1 < d2 ? tg.t1 : tg.t2
      }
    }

    const dx0 = prevDir.x - curr.x, dy0 = prevDir.y - curr.y
    const dx1 = nextDir.x - curr.x, dy1 = nextDir.y - curr.y
    const d0 = Math.hypot(dx0, dy0), d1 = Math.hypot(dx1, dy1)

    if (r <= 0) {
      if (i === 0) ctx.moveTo(curr.x, curr.y)
      else ctx.lineTo(curr.x, curr.y)
    } else if (d0 === 0 || d1 === 0) {
      ctx.lineTo(curr.x, curr.y)
    } else {
      const t = Math.min(r, d0, d1)
      const tx0 = curr.x + (dx0/d0)*t, ty0 = curr.y + (dy0/d0)*t
      const tx1 = curr.x + (dx1/d1)*t, ty1 = curr.y + (dy1/d1)*t
      if (i === 0) ctx.moveTo(tx0, ty0)
      else ctx.lineTo(tx0, ty0)
      ctx.arcTo(curr.x, curr.y, tx1, ty1, t)
    }
  }
  ctx.closePath()
}

// ─── resolvePos для вырезов (Y вверх — 0,0 нижний левый) ────────────────────
function resolvePos(sides, offsets, panelW, panelH, itemW, itemH) {
  let x = (panelW - itemW) / 2, y = (panelH - itemH) / 2
  let w = itemW, h = itemH
  if (sides.includes('left') && sides.includes('right')) {
    x = offsets.left ?? 0
    w = panelW - (offsets.left ?? 0) - (offsets.right ?? 0)
  } else if (sides.includes('left'))  x = offsets.left ?? 0
  else if (sides.includes('right'))   x = panelW - itemW - (offsets.right ?? 0)
  // Y вверх: 'bottom' = отступ от низа = малый Y, 'top' = отступ от верха = большой Y
  if (sides.includes('top') && sides.includes('bottom')) {
    y = offsets.bottom ?? 0
    h = panelH - (offsets.bottom ?? 0) - (offsets.top ?? 0)
  } else if (sides.includes('bottom')) y = offsets.bottom ?? 0
  else if (sides.includes('top'))      y = panelH - itemH - (offsets.top ?? 0)
  return { x, y, w, h }
}

// ─── Получить позиции маркеров по вершинам ────────────────────────────────────
function getMarkers(verts, sc, ox, oy, dh) {
  return (verts || []).map((v, i) => ({
    idx: i,
    x: ox + v.x * sc,
    y: oy + dh - v.y * sc,  // инверсия Y
    r: v.r || 0,
    vertex: v,
  }))
}

// ─── Canvas ───────────────────────────────────────────────────────────────────
function ContourCanvas({ detail, contour, activeIdx, previewVerts, onTap, showMarkers=true, showLengths=true, showAngles=true, arcMode=false, arcPoints=[] }) {
  const ref = useRef(null)
  const w = Number(detail.w) || 0
  const h = Number(detail.h) || 0

  useEffect(() => {
    const canvas = ref.current
    if (!canvas || !w || !h) return
    const ctx = canvas.getContext('2d')
    const DPR = window.devicePixelRatio || 1

    // Высокое разрешение
    const CSS_W = canvas.offsetWidth || 280
    const CSS_H = Math.round(CSS_W * (h / w) * 0.75 + 60)
    canvas.width = CSS_W * DPR
    canvas.height = CSS_H * DPR
    canvas.style.height = CSS_H + 'px'
    ctx.scale(DPR, DPR)

    const PAD = 16
    const sc = Math.min((CSS_W - PAD*2) / w, (CSS_H - PAD*2) / h)
    const dw = w * sc, dh = h * sc
    const ox = (CSS_W - dw) / 2, oy = (CSS_H - dh) / 2

    ctx.clearRect(0, 0, CSS_W, CSS_H)

    // Сетка фона
    ctx.strokeStyle = '#f0f0f0'; ctx.lineWidth = 0.5
    const gridStep = sc * (w > 500 ? 100 : 50)
    for (let x = ox; x <= ox+dw; x += gridStep) {
      ctx.beginPath(); ctx.moveTo(x, oy); ctx.lineTo(x, oy+dh); ctx.stroke()
    }
    for (let y = oy; y <= oy+dh; y += gridStep) {
      ctx.beginPath(); ctx.moveTo(ox, y); ctx.lineTo(ox+dw, y); ctx.stroke()
    }

    // Внешний контур
    const verts = previewVerts || contour.vertices || makeRect(w, h)
    buildPath(ctx, verts, sc, ox, oy, dh)
    ctx.fillStyle = '#E6F1FB'; ctx.fill()
    ctx.strokeStyle = '#185FA5'; ctx.lineWidth = 1.5; ctx.stroke()

    // Holes
    ;(contour.holes || []).forEach(hole => {
      const isCircle = hole.type === 'circle'
      const isPocket = hole.type === 'pocket'
      ctx.fillStyle = isPocket ? 'rgba(250,199,117,0.4)' : 'white'
      ctx.strokeStyle = isPocket ? '#BA7517' : '#E24B4A'
      ctx.lineWidth = 1
      if (isCircle) {
        const d = hole.d || 100
        const pos = resolvePos(hole.sides||[], hole.offsets||{}, w, h, d, d)
        const cx2 = ox + (pos.x + d/2) * sc
        const cy2 = oy + dh - (pos.y + d/2) * sc
        ctx.beginPath(); ctx.arc(cx2, cy2, d/2*sc, 0, Math.PI*2)
        ctx.fill(); ctx.stroke()
      } else {
        const hw = hole.hw || 200, hh = hole.hh || 100
        const pos = resolvePos(hole.sides||[], hole.offsets||{}, w, h, hw, hh)
        const cx2 = ox + pos.x * sc
        const cy2 = oy + dh - (pos.y + pos.h) * sc
        ctx.fillRect(cx2, cy2, pos.w*sc, pos.h*sc)
        ctx.strokeRect(cx2, cy2, pos.w*sc, pos.h*sc)
      }
    })

    // Пазы
    ;(contour.grooves || []).forEach(g => {
      ctx.fillStyle = 'rgba(250,199,117,0.8)'; ctx.strokeStyle = '#BA7517'; ctx.lineWidth = 1
      const isH = g.dir === 'horizontal'
      const gW = isH ? (g.length||100) : (g.width||8)
      const gH = isH ? (g.width||8) : (g.length||100)
      const pos = resolvePos(g.sides||[], g.offsets||{}, w, h, gW, gH)
      const cx2 = ox + pos.x * sc
      const cy2 = oy + dh - (pos.y + pos.h) * sc
      ctx.fillRect(cx2, cy2, pos.w*sc, pos.h*sc)
      ctx.strokeRect(cx2, cy2, pos.w*sc, pos.h*sc)
    })

    // Размеры отрезков + углы — умное позиционирование
    const n = verts.length
    const cv = verts.map(v => ({
      x: ox + v.x * sc,
      y: oy + dh - v.y * sc,
    }))

    // Центр детали на canvas
    const cxD = ox + dw/2, cyD = oy + dh/2

    // Собираем все подписи с их позициями
    const labels = []

    // Длины отрезков
    if (showLengths) {
      for (let i = 0; i < n; i++) {
        const a = cv[i], b = cv[(i+1) % n]
        const len = Math.round(Math.hypot(verts[(i+1)%n].x - verts[i].x, verts[(i+1)%n].y - verts[i].y))
        if (len < 5) continue
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
        const dx = b.x - a.x, dy = b.y - a.y
        const d = Math.hypot(dx, dy)
        // Нормаль наружу (от центра детали)
        let nx = -dy/d, ny = dx/d
        // Проверяем направление нормали — она должна смотреть от центра
        const toCx = mx - cxD, toCy = my - cyD
        if (nx*toCx + ny*toCy < 0) { nx = -nx; ny = -ny }
        labels.push({ x: mx + nx*13, y: my + ny*13, text: `${len}`, color:'#185FA5',
          angle: Math.atan2(dy, dx), rotate: true })
      }
    }

    // Углы в вершинах
    if (showAngles) {
      for (let i = 0; i < n; i++) {
        const prev = verts[(i-1+n)%n], curr = verts[i], next = verts[(i+1)%n]
        const ax = prev.x-curr.x, ay = prev.y-curr.y
        const bx = next.x-curr.x, by = next.y-curr.y
        const da = Math.hypot(ax,ay), db = Math.hypot(bx,by)
        if (da < 1 || db < 1) continue
        const dot = (ax*bx+ay*by)/(da*db)
        const angleDeg = Math.round(Math.acos(Math.max(-1,Math.min(1,dot)))*180/Math.PI)
        if (angleDeg === 180) continue

        const px = ox + curr.x*sc, py = oy + dh - curr.y*sc
        // Биссектриса угла — направление к центру детали
        const toCx = cxD - px, toCy = cyD - py
        const toD = Math.hypot(toCx, toCy) || 1
        // Смещаем дальше для больших углов (больше текста)
        const dist = angleDeg === 90 ? 16 : 20
        labels.push({ x: px + (toCx/toD)*dist, y: py + (toCy/toD)*dist,
          text: `${angleDeg}°`, color:'#E24B4A', rotate: false })
      }
    }

    // Разрешаем пересечения — сдвигаем метки друг от друга
    const FONT_H = 9, FONT_W = 6
    for (let iter = 0; iter < 3; iter++) {
      for (let i = 0; i < labels.length; i++) {
        for (let j = i+1; j < labels.length; j++) {
          const a = labels[i], b = labels[j]
          const dx = b.x - a.x, dy = b.y - a.y
          const dist = Math.hypot(dx, dy)
          if (dist < FONT_H * 1.5 && dist > 0) {
            const push = (FONT_H * 1.5 - dist) / 2
            labels[i].x -= (dx/dist)*push
            labels[i].y -= (dy/dist)*push
            labels[j].x += (dx/dist)*push
            labels[j].y += (dy/dist)*push
          }
        }
      }
    }

    // Рисуем подписи
    for (const lb of labels) {
      ctx.save()
      ctx.translate(lb.x, lb.y)
      if (lb.rotate) {
        let a = lb.angle
        if (a > Math.PI/2 || a < -Math.PI/2) a += Math.PI
        ctx.rotate(a)
      }
      ctx.font = '9px sans-serif'
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 3
      ctx.strokeText(lb.text, 0, 0)
      ctx.fillStyle = lb.color
      ctx.fillText(lb.text, 0, 0)
      ctx.restore()
    }

    // Маркеры
    if (showMarkers || arcMode) {
      const markers = getMarkers(verts, sc, ox, oy, dh)
      markers.forEach(m => {
        const isActive = m.idx === activeIdx
        const isArcSel = arcPoints.includes(m.idx)
        const r = arcMode ? 10 : (isActive ? 5 : 3.5)
        ctx.beginPath()
        ctx.arc(m.x, m.y, r, 0, Math.PI * 2)
        ctx.fillStyle = isArcSel ? '#F5A623' : isActive ? '#E24B4A' : arcMode ? '#185FA5' : '#185FA5'
        ctx.fill()
        ctx.strokeStyle = 'white'; ctx.lineWidth = 1.5; ctx.stroke()
        // Номер точки в режиме дуги
        if (arcMode) {
          ctx.fillStyle = 'white'
          ctx.font = 'bold 9px sans-serif'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(m.idx + 1, m.x, m.y)
        }
      })
    }

  }, [w, h, contour, activeIdx, previewVerts, showMarkers, showLengths, showAngles, arcMode, arcPoints])

  const handleTap = (e) => {
    const canvas = ref.current
    if (!canvas || !w || !h) return
    const rect = canvas.getBoundingClientRect()
    const DPR = window.devicePixelRatio || 1
    const CSS_W = rect.width
    const CSS_H = rect.height
    const cx = (e.clientX - rect.left)
    const cy = (e.clientY - rect.top)

    const PAD = 16
    const sc = Math.min((CSS_W - PAD*2) / w, (CSS_H - PAD*2) / h)
    const dw = w * sc, dh = h * sc
    const ox = (CSS_W - dw) / 2, oy = (CSS_H - dh) / 2

    const verts = contour.vertices || makeRect(w, h)
    const markers = getMarkers(verts, sc, ox, oy, dh)
    const TAP_R = arcMode ? 30 : 20
    for (const m of markers) {
      if (Math.hypot(cx - m.x, cy - m.y) <= TAP_R) {
        onTap(m.idx)
        return
      }
    }
    onTap(null)
  }

  return (
    <canvas ref={ref}
      onClick={handleTap}
      style={{ width:'100%', borderRadius:8, display:'block', cursor:'pointer', touchAction:'manipulation' }} />
  )
}

// ─── Меню вершины ─────────────────────────────────────────────────────────────
function VertexMenu({ idx, vertex, total, onChange, onApplyType, onPreview, onInsertBefore, onInsertAfter, onDelete, onClose }) {
  const canDelete = total > 3
  const [dx, setDx] = useState(50)
  const [dy, setDy] = useState(50)
  const [r, setR] = useState(Math.abs(vertex.r) || 50)
  const [selType, setSelType] = useState(null)

  const BTNS = [
    { id: 'none',    icon: '—',  label: 'Нет' },
    { id: 'radius',  icon: '⌒',  label: 'Выпуклый' },
    { id: 'concave', icon: '⌣',  label: 'Вогнутый' },
    { id: 'chamfer', icon: '◣',  label: 'Фаска' },
    { id: 'notch',   icon: '⌐',  label: 'Вырез' },
  ]

  const handleSelectType = (type) => {
    setSelType(type)
    // Для none/radius/concave — применяем сразу
    if (type === 'none' || type === 'radius' || type === 'concave') {
      onApplyType(idx, type, { r, dx, dy })
    }
  }

  const handleApply = () => {
    onApplyType(idx, selType, { r, dx, dy })
  }

  return (
    <div style={{ background:'var(--bg2)', borderRadius:'var(--radius)', padding:12, marginTop:8,
      border:'1.5px solid var(--blue)' }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10 }}>
        <span style={{ fontSize:13, fontWeight:500, color:'var(--blue)' }}>Точка #{idx + 1}</span>
        <button type="button" onClick={() => onClose(selType, dx, dy, r)}
          style={{ background:'none', border:'none', fontSize:18, color:'var(--text-hint)', cursor:'pointer', padding:0, lineHeight:1 }}>✕</button>
      </div>

      {/* Кнопки типа */}
      <div style={{ display:'flex', gap:5, marginBottom:10 }}>
        {BTNS.map(({id, icon, label}) => (
          <button key={id} type="button" onClick={() => handleSelectType(id)}
            style={{ flex:1, padding:'7px 2px', border: selType===id ? '1.5px solid var(--blue)' : '0.5px solid var(--border-md)',
              borderRadius:'var(--radius)', background: selType===id ? 'var(--blue-light)' : 'transparent',
              fontSize:14, cursor:'pointer', display:'flex', flexDirection:'column', alignItems:'center', gap:1 }}>
            <span>{icon}</span>
            <span style={{ fontSize:8, color: selType===id ? 'var(--blue)' : 'var(--text-hint)' }}>{label}</span>
          </button>
        ))}
      </div>

      {/* Параметры радиуса */}
      {(selType === 'radius' || selType === 'concave') && (
        <div style={{ marginBottom:10 }}>
          <NumField label="Радиус R" value={r} onChange={v => { setR(v); onApplyType(idx, selType, { r: v, dx, dy }) }} />
        </div>
      )}

      {/* Фаска — превью сразу, применить по кнопке */}
      {selType === 'chamfer' && (
        <div style={{ marginBottom:10 }}>
          <div style={{ display:'flex', gap:8, marginBottom:8 }}>
            <NumField label="По X →" value={dx} onChange={v => { setDx(v); onPreview(idx, 'chamfer', { dx: v, dy }) }} />
            <NumField label="По Y ↓" value={dy} onChange={v => { setDy(v); onPreview(idx, 'chamfer', { dx, dy: v }) }} />
          </div>
          <button type="button" onClick={() => onApplyType(idx, 'chamfer', { r, dx, dy })}
            style={{ width:'100%', padding:'8px', background:'var(--blue)', color:'white', border:'none',
              borderRadius:'var(--radius)', fontSize:13, cursor:'pointer', fontWeight:500 }}>
            ✓ Применить фаску
          </button>
        </div>
      )}

      {/* Вырез — превью сразу, применить по кнопке */}
      {selType === 'notch' && (
        <div style={{ marginBottom:10 }}>
          <div style={{ display:'flex', gap:8, marginBottom:8 }}>
            <NumField label="По X →" value={dx} onChange={v => { setDx(v); onPreview(idx, 'notch', { dx: v, dy }) }} />
            <NumField label="По Y ↓" value={dy} onChange={v => { setDy(v); onPreview(idx, 'notch', { dx, dy: v }) }} />
          </div>
          <button type="button" onClick={() => onApplyType(idx, 'notch', { r, dx, dy })}
            style={{ width:'100%', padding:'8px', background:'var(--blue)', color:'white', border:'none',
              borderRadius:'var(--radius)', fontSize:13, cursor:'pointer', fontWeight:500 }}>
            ✓ Применить вырез
          </button>
        </div>
      )}

      {/* Радиус текущей точки (если тип не выбран) */}
      {!selType && (
        <div style={{ marginBottom:10 }}>
          <NumField label="Радиус скругления R"
            value={vertex.r || 0}
            onChange={v => onChange({ ...vertex, r: v })} />
          <p style={{ fontSize:10, color:'var(--text-hint)', marginTop:3 }}>0 = острый угол</p>
        </div>
      )}

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
  const [previewVerts, setPreviewVerts] = useState(null)
  const [menuSelType, setMenuSelType] = useState(null)
  const [menuDx, setMenuDx] = useState(50)
  const [menuDy, setMenuDy] = useState(50)
  const [menuR, setMenuR] = useState(50)
  const [moveStep, setMoveStep] = useState(10)
  const [showMarkers, setShowMarkers] = useState(true)
  const [showLengths, setShowLengths] = useState(true)
  const [showAngles, setShowAngles] = useState(true)
  const [arcMode, setArcMode] = useState(false)
  const [arcPoints, setArcPoints] = useState([]) // индексы выбранных точек

  // Применить дугу: точки [i, cp, j] — cp становится контрольной точкой
  const applyArc = (pts) => {
    if (pts.length < 3) return
    const verts = [...contour.vertices]
    // Все средние точки (не первая и не последняя) помечаем как arc
    for (let k = 1; k < pts.length - 1; k++) {
      verts[pts[k]] = { ...verts[pts[k]], type: 'arc' }
    }
    setVertices(verts)
    setArcMode(false)
    setArcPoints([])
    setMenuSelType(null)
    setActiveIdx(null)
  }

  const handleArcTap = (idx) => {
    const pts = [...arcPoints, idx]
    setArcPoints(pts)
    if (pts.length === 3) {
      applyArc(pts)
    }
  }

  // Стиль кнопки-стрелки
  const arrowBtn = {
    width: 32, height: 32, border: '0.5px solid var(--border-md)',
    borderRadius: 'var(--radius)', background: 'var(--bg3)',
    fontSize: 14, cursor: 'pointer', display: 'flex',
    alignItems: 'center', justifyContent: 'center', padding: 0,
  }

  // Переместить точку по X/Y
  const moveVertex = (idx, dx, dy) => {
    const verts = [...contour.vertices]
    verts[idx] = { ...verts[idx], x: verts[idx].x + dx, y: verts[idx].y + dy }
    setVertices(verts)
  }

  // Переместить точку вдоль соседнего отрезка
  const moveAlongEdge = (idx, edge, step) => {
    const verts = contour.vertices
    const n = verts.length
    const curr = verts[idx]
    const neighbor = edge === 'prev' ? verts[(idx - 1 + n) % n] : verts[(idx + 1) % n]
    const dx = neighbor.x - curr.x, dy = neighbor.y - curr.y
    const d = Math.hypot(dx, dy)
    if (d === 0) return
    const nx = dx / d, ny = dy / d
    moveVertex(idx, nx * step, ny * step)
  }

  // Рассчитать превью без сохранения в контур
  const calcPreview = (idx, type, params) => {
    const verts = [...contour.vertices]
    const n = verts.length
    const curr = verts[idx]
    const prev = verts[(idx - 1 + n) % n]
    const next = verts[(idx + 1) % n]
    const { dx = 50, dy = 50 } = params

    const dx0 = prev.x - curr.x, dy0 = prev.y - curr.y
    const dx1 = next.x - curr.x, dy1 = next.y - curr.y
    const d0 = Math.hypot(dx0, dy0), d1 = Math.hypot(dx1, dy1)
    const nx0 = d0 > 0 ? dx0/d0 : 0, ny0 = d0 > 0 ? dy0/d0 : 0
    const nx1 = d1 > 0 ? dx1/d1 : 0, ny1 = d1 > 0 ? dy1/d1 : 0

    let hx, hy, vx, vy
    if (Math.abs(nx0) >= Math.abs(ny0)) {
      hx = nx0; hy = ny0; vx = nx1; vy = ny1
    } else {
      hx = nx1; hy = ny1; vx = nx0; vy = ny0
    }

    if (type === 'chamfer') {
      const p1 = { x: curr.x + hx*dx, y: curr.y + hy*dx, r: 0 }
      const p2 = { x: curr.x + vx*dy, y: curr.y + vy*dy, r: 0 }
      const newV = [...verts]
      if (Math.abs(nx0) >= Math.abs(ny0)) newV.splice(idx, 1, p1, p2)
      else newV.splice(idx, 1, p2, p1)
      setPreviewVerts(newV)
    } else if (type === 'notch') {
      const p1 = { x: curr.x + hx*dx, y: curr.y + hy*dx, r: 0 }
      const p2 = { x: curr.x + hx*dx + vx*dy, y: curr.y + hy*dx + vy*dy, r: 0 }
      const p3 = { x: curr.x + vx*dy, y: curr.y + vy*dy, r: 0 }
      const newV = [...verts]
      if (Math.abs(nx0) >= Math.abs(ny0)) newV.splice(idx, 1, p1, p2, p3)
      else newV.splice(idx, 1, p3, p2, p1)
      setPreviewVerts(newV)
    }
  }

  const upd = (patch) => onUpdate({ ...detail, contour: { ...contour, ...patch } })

  const setVertices = (verts) => upd({ vertices: verts })

  const handleTap = (idx) => {
    if (idx === null) {
      if (!arcMode) { setActiveIdx(null); setMenuSelType(null); setPreviewVerts(null) }
      return
    }
    setActiveIdx(idx)
    setMenuSelType(null)
    setPreviewVerts(null)
    setArcMode(false)
    setArcPoints([])
    setTab('contour')
  }

  // Вершина: изменить
  const updateVertex = (idx, newV) => {
    const verts = [...contour.vertices]
    verts[idx] = newV
    setVertices(verts)
  }

  // Применить тип угла к точке
  const applyCornerType = (idx, type, params = {}) => {
    const verts = [...contour.vertices]
    const n = verts.length
    const curr = verts[idx]
    const prev = verts[(idx - 1 + n) % n]
    const next = verts[(idx + 1) % n]

    const dx = params.dx || 50, dy = params.dy || 50

    // Направления от curr к prev и next
    const dx0 = prev.x - curr.x, dy0 = prev.y - curr.y
    const dx1 = next.x - curr.x, dy1 = next.y - curr.y
    const d0 = Math.hypot(dx0, dy0), d1 = Math.hypot(dx1, dy1)
    const nx0 = d0 > 0 ? dx0/d0 : 0, ny0 = d0 > 0 ? dy0/d0 : 0
    const nx1 = d1 > 0 ? dx1/d1 : 0, ny1 = d1 > 0 ? dy1/d1 : 0

    // Определяем какой из двух направлений горизонтальный, какой вертикальный
    // Горизонтальный — тот у которого |nx| > |ny|
    let hx, hy, vx, vy
    if (Math.abs(nx0) >= Math.abs(ny0)) {
      // prev — горизонталь, next — вертикаль
      hx = nx0; hy = ny0; vx = nx1; vy = ny1
    } else {
      // prev — вертикаль, next — горизонталь
      hx = nx1; hy = ny1; vx = nx0; vy = ny0
    }

    if (type === 'none') {
      verts[idx] = { ...curr, r: 0 }
      setVertices(verts); setActiveIdx(idx)
    } else if (type === 'radius') {
      verts[idx] = { ...curr, r: params.r || 50 }
      setVertices(verts); setActiveIdx(idx)
    } else if (type === 'concave') {
      verts[idx] = { ...curr, r: -(params.r || 50) }
      setVertices(verts); setActiveIdx(idx)
    } else if (type === 'chamfer') {
      // 2 точки: одна по горизонтали, одна по вертикали
      const p1 = { x: curr.x + hx*dx, y: curr.y + hy*dx, r: 0 }
      const p2 = { x: curr.x + vx*dy, y: curr.y + vy*dy, r: 0 }
      // Порядок: сначала та что по горизонтали от prev
      if (Math.abs(nx0) >= Math.abs(ny0)) {
        verts.splice(idx, 1, p1, p2)
      } else {
        verts.splice(idx, 1, p2, p1)
      }
      setVertices(verts); setActiveIdx(null)
    } else if (type === 'notch') {
      // 3 точки: p1 по горизонтали, p2 внутренний угол, p3 по вертикали
      const p1 = { x: curr.x + hx*dx, y: curr.y + hy*dx, r: 0 }
      const p2 = { x: curr.x + hx*dx + vx*dy, y: curr.y + hy*dx + vy*dy, r: 0 }
      const p3 = { x: curr.x + vx*dy, y: curr.y + vy*dy, r: 0 }
      if (Math.abs(nx0) >= Math.abs(ny0)) {
        verts.splice(idx, 1, p1, p2, p3)
      } else {
        verts.splice(idx, 1, p3, p2, p1)
      }
      setVertices(verts); setActiveIdx(null)
    }
  }
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
    const base = { type, sides: [], offsets: {} }
    if (type === 'circle') upd({ holes: [...contour.holes, { ...base, d: 100 }] })
    else if (type === 'pocket') upd({ holes: [...contour.holes, { ...base, hw: 200, hh: 100, depth: 10 }] })
    else upd({ holes: [...contour.holes, { ...base, hw: 200, hh: 100 }] })
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

      {/* Canvas + кнопки типа рядом */}
      {w > 0 && h > 0 && (
        <div style={{ display:'flex', gap:4, marginBottom:8, alignItems:'flex-start' }}>

          {/* Список точек слева */}
          <div style={{ display:'flex', flexDirection:'column', gap:2, maxHeight:280, overflowY:'auto' }}>
            <span style={{ fontSize:8, color:'var(--text-hint)', textAlign:'center', marginBottom:1 }}>№</span>
            {contour.vertices.map((v, i) => {
              const isActive = i === activeIdx
              const isArcSel = arcPoints.includes(i)
              return (
                <button key={i} type="button"
                  onClick={() => {
                    if (arcMode) {
                      if (arcPoints.includes(i)) return
                      const pts = [...arcPoints, i]
                      setArcPoints(pts)
                    } else {
                      setActiveIdx(i)
                      setMenuSelType(null)
                      setPreviewVerts(null)
                      setTab('contour')
                    }
                  }}
                  style={{ width:22, height:22, border: isActive ? '1.5px solid var(--blue)' : isArcSel ? '1.5px solid #F5A623' : '0.5px solid var(--border-md)',
                    borderRadius:4,
                    background: isActive ? 'var(--blue)' : isArcSel ? '#F5A623' : 'var(--bg3)',
                    color: isActive || isArcSel ? 'white' : 'var(--text-muted)',
                    fontSize:9, fontWeight:600, cursor:'pointer',
                    display:'flex', alignItems:'center', justifyContent:'center', padding:0 }}>
                  {i+1}
                </button>
              )
            })}
          </div>

          {/* Canvas */}
          <div style={{ flex:1, minWidth:0 }}>
            {!arcMode && !activeVertex && (
              <p style={{ fontSize:10, color:'var(--text-hint)', textAlign:'center', marginBottom:2 }}>
                Нажми на точку
              </p>
            )}
            <ContourCanvas detail={detail} contour={contour} activeIdx={activeIdx}
              arcMode={arcMode} arcPoints={arcPoints}
              previewVerts={previewVerts} onTap={handleTap}
              showMarkers={showMarkers} showLengths={showLengths} showAngles={showAngles} />
          </div>

          {/* Правая колонка — всегда toggles + кнопки типа если точка выбрана */}
          <div style={{ display:'flex', flexDirection:'column', gap:2 }}>
            {/* Toggles — всегда */}
            {[
              { key:'markers', icon:'●', val:showMarkers, set:setShowMarkers },
              { key:'lengths', icon:'↔', val:showLengths, set:setShowLengths },
              { key:'angles',  icon:'∠', val:showAngles,  set:setShowAngles },
            ].map(({key, icon, val, set}) => (
              <button key={key} type="button" onClick={() => set(v => !v)}
                style={{ width:26, height:26, border: val ? '1.5px solid var(--blue)' : '0.5px solid var(--border-md)',
                  borderRadius:4, background: val ? 'var(--blue-light)' : 'transparent',
                  fontSize:12, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center' }}>
                {icon}
              </button>
            ))}

            {/* Разделитель */}
            {activeVertex && tab === 'contour' && !arcMode && (
              <div style={{ height:1, background:'var(--border)', margin:'2px 0' }} />
            )}

            {/* Кнопки типа — только когда точка выбрана */}
            {activeVertex && tab === 'contour' && !arcMode && (
              <>
                {[
                  { id:'none',    icon:'—' },
                  { id:'radius',  icon:'⌒' },
                  { id:'chamfer', icon:'◣' },
                  { id:'notch',   icon:'⌐' },
                  { id:'arc',     icon:'〜' },
                ].map(({id, icon}) => (
                  <button key={id} type="button"
                    onClick={() => {
                      if (id === 'arc') {
                        setArcMode(true)
                        setArcPoints([activeIdx])
                        setMenuSelType('arc')
                        return
                      }
                      setMenuSelType(id)
                      if (id === 'none' || id === 'radius') {
                        applyCornerType(activeIdx, id, { r: menuR, dx: menuDx, dy: menuDy })
                        setPreviewVerts(null)
                      } else {
                        calcPreview(activeIdx, id, { dx: menuDx, dy: menuDy })
                      }
                    }}
                    style={{ width:26, height:26, border: menuSelType===id ? '1.5px solid var(--blue)' : '0.5px solid var(--border-md)',
                      borderRadius:4, background: menuSelType===id ? 'var(--blue-light)' : 'transparent',
                      fontSize:13, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center' }}>
                    {icon}
                  </button>
                ))}
              </>
            )}
          </div>
        </div>
      )}

      {/* Подсказка в режиме дуги */}
      {arcMode && (
        <div style={{ background:'#FFF3CD', borderRadius:'var(--radius)', padding:'6px 8px',
          marginBottom:8, fontSize:11, color:'#856404' }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom: arcPoints.length >= 3 ? 6 : 0 }}>
            <span>
              {arcPoints.length === 1 ? '〜 Выбери промежуточные точки' :
               arcPoints.length === 2 ? '〜 Выбери ещё точки или нажми Применить' :
               `〜 Выбрано ${arcPoints.length} точек`}
            </span>
            <button type="button" onClick={() => { setArcMode(false); setArcPoints([]); setMenuSelType(null) }}
              style={{ background:'none', border:'none', color:'#856404', cursor:'pointer', fontSize:14, marginLeft:8 }}>✕</button>
          </div>
          {arcPoints.length >= 3 && (
            <button type="button" onClick={() => applyArc(arcPoints)}
              style={{ width:'100%', padding:'6px', background:'#856404', color:'white', border:'none',
                borderRadius:'var(--radius)', fontSize:12, cursor:'pointer', fontWeight:500 }}>
              ✓ Применить дугу ({arcPoints.length} точек)
            </button>
          )}
        </div>
      )}

      {/* Параметры под превью */}
      {activeVertex && tab === 'contour' && (
        <div style={{ background:'var(--bg2)', borderRadius:'var(--radius)', padding:10, marginBottom:8 }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
            <span style={{ fontSize:12, color:'var(--text-hint)' }}>Точка #{activeIdx + 1}</span>
            <button type="button"
              onClick={() => { setActiveIdx(null); setMenuSelType(null); setPreviewVerts(null) }}
              style={{ background:'none', border:'none', fontSize:16, color:'var(--text-hint)', cursor:'pointer', padding:0 }}>✕</button>
          </div>

          {/* Радиус */}
          {menuSelType === 'radius' && (
            <NumField label="Радиус R" value={menuR}
              onChange={v => { setMenuR(v); applyCornerType(activeIdx, 'radius', { r: v, dx: menuDx, dy: menuDy }); setPreviewVerts(null) }} />
          )}

          {/* Фаска */}
          {menuSelType === 'chamfer' && (
            <div>
              <div style={{ display:'flex', gap:8, marginBottom:8 }}>
                <NumField label="По X →" value={menuDx} onChange={v => { setMenuDx(v); calcPreview(activeIdx, 'chamfer', { dx: v, dy: menuDy }) }} />
                <NumField label="По Y ↑" value={menuDy} onChange={v => { setMenuDy(v); calcPreview(activeIdx, 'chamfer', { dx: menuDx, dy: v }) }} />
              </div>
              <button type="button" onClick={() => { applyCornerType(activeIdx, 'chamfer', { r: menuR, dx: menuDx, dy: menuDy }); setPreviewVerts(null); setActiveIdx(null); setMenuSelType(null) }}
                style={{ width:'100%', padding:'7px', background:'var(--blue)', color:'white', border:'none', borderRadius:'var(--radius)', fontSize:12, cursor:'pointer' }}>
                ✓ Применить фаску
              </button>
            </div>
          )}

          {/* Вырез */}
          {menuSelType === 'notch' && (
            <div>
              <div style={{ display:'flex', gap:8, marginBottom:8 }}>
                <NumField label="По X →" value={menuDx} onChange={v => { setMenuDx(v); calcPreview(activeIdx, 'notch', { dx: v, dy: menuDy }) }} />
                <NumField label="По Y ↑" value={menuDy} onChange={v => { setMenuDy(v); calcPreview(activeIdx, 'notch', { dx: menuDx, dy: v }) }} />
              </div>
              <button type="button" onClick={() => { applyCornerType(activeIdx, 'notch', { r: menuR, dx: menuDx, dy: menuDy }); setPreviewVerts(null); setActiveIdx(null); setMenuSelType(null) }}
                style={{ width:'100%', padding:'7px', background:'var(--blue)', color:'white', border:'none', borderRadius:'var(--radius)', fontSize:12, cursor:'pointer' }}>
                ✓ Применить вырез
              </button>
            </div>
          )}

          {/* Перемещение точки — если тип не выбран */}
          {!menuSelType && (
            <div>
              <NumField label="Радиус скругления R" value={activeVertex.r || 0}
                onChange={v => updateVertex(activeIdx, { ...activeVertex, r: v })} />

              {/* Шаг перемещения */}
              <div style={{ marginTop:10, marginBottom:6, display:'flex', alignItems:'center', gap:8 }}>
                <label style={{ fontSize:10, color:'var(--text-hint)', flexShrink:0 }}>Шаг мм</label>
                <input type="text" inputMode="decimal"
                  defaultValue={moveStep}
                  onChange={e => {
                    let v = e.target.value.replace(/[^0-9.,]/g, '').replace(',', '.')
                    const num = parseFloat(v)
                    if (!isNaN(num)) setMoveStep(num)
                  }}
                  style={{ width:70, padding:'4px 6px', fontSize:13, borderRadius:'var(--radius)',
                    border:'0.5px solid var(--border-md)' }} />
                <span style={{ fontSize:10, color:'var(--text-hint)' }}>мм</span>
              </div>

              {/* Стрелки XY */}
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6, marginBottom:6 }}>
                <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:3 }}>
                  <label style={{ fontSize:10, color:'var(--text-hint)' }}>X / Y</label>
                  <button type="button" onClick={() => moveVertex(activeIdx, 0, moveStep)}
                    style={arrowBtn}>↑</button>
                  <div style={{ display:'flex', gap:3 }}>
                    <button type="button" onClick={() => moveVertex(activeIdx, -moveStep, 0)} style={arrowBtn}>←</button>
                    <button type="button" onClick={() => moveVertex(activeIdx, moveStep, 0)}  style={arrowBtn}>→</button>
                  </div>
                  <button type="button" onClick={() => moveVertex(activeIdx, 0, -moveStep)}
                    style={arrowBtn}>↓</button>
                </div>

                {/* Движение по линии отрезка */}
                <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:3 }}>
                  <label style={{ fontSize:10, color:'var(--text-hint)' }}>По отрезку</label>
                  <button type="button" onClick={() => moveAlongEdge(activeIdx, 'prev', moveStep)}
                    style={arrowBtn}>◀</button>
                  <div style={{ display:'flex', gap:3 }}>
                    <span style={{ fontSize:9, color:'var(--text-hint)', alignSelf:'center' }}>пред</span>
                    <span style={{ fontSize:9, color:'var(--text-hint)', alignSelf:'center' }}>след</span>
                  </div>
                  <button type="button" onClick={() => moveAlongEdge(activeIdx, 'next', moveStep)}
                    style={arrowBtn}>▶</button>
                </div>
              </div>
            </div>
          )}

          {/* Действия с точкой */}
          <div style={{ display:'flex', gap:6, marginTop:8 }}>
            <button type="button" onClick={() => insertVertex(activeIdx, false)}
              style={{ flex:1, padding:'6px', border:'0.5px solid var(--border-md)', borderRadius:'var(--radius)',
                background:'transparent', fontSize:11, color:'var(--text-muted)', cursor:'pointer' }}>+ До</button>
            <button type="button" onClick={() => insertVertex(activeIdx, true)}
              style={{ flex:1, padding:'6px', border:'0.5px solid var(--border-md)', borderRadius:'var(--radius)',
                background:'transparent', fontSize:11, color:'var(--text-muted)', cursor:'pointer' }}>+ После</button>
            {contour.vertices.length > 3 && (
              <button type="button" onClick={() => deleteVertex(activeIdx)}
                style={{ flex:1, padding:'6px', border:'0.5px solid var(--danger)', borderRadius:'var(--radius)',
                  background:'transparent', fontSize:11, color:'var(--danger)', cursor:'pointer' }}>Удалить</button>
            )}
          </div>
        </div>
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
          <div style={{ display:'flex', gap:6, marginBottom:12, flexWrap:'wrap' }}>
            <button type="button" onClick={() => addHole('rect')}
              style={{ flex:1, padding:'8px', border:'0.5px dashed var(--border-md)', borderRadius:'var(--radius)',
                background:'transparent', fontSize:12, color:'var(--text-muted)', cursor:'pointer' }}>
              + Прямоугольный
            </button>
            <button type="button" onClick={() => addHole('circle')}
              style={{ flex:1, padding:'8px', border:'0.5px dashed var(--border-md)', borderRadius:'var(--radius)',
                background:'transparent', fontSize:12, color:'var(--text-muted)', cursor:'pointer' }}>
              + Круглый
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
              title={`${hole.type==='pocket'?'▣ Выборка':hole.type==='circle'?'○ Круглый':'□ Прямоугольный'} #${i+1}`}
              onRemove={() => upd({ holes: contour.holes.filter((_,j)=>j!==i) })}>

              {/* Круглый */}
              {hole.type === 'circle' && (
                <div style={{ marginBottom:10 }}>
                  <NumField label="Диаметр D" value={hole.d??100} onChange={v=>updHole(i,{d:v})} />
                </div>
              )}

              {/* Прямоугольный / Выборка */}
              {(hole.type === 'rect' || hole.type === 'pocket') && (
                <div style={{ display:'flex', gap:8, marginBottom:10 }}>
                  <NumField label="Длина" value={hole.hw??200} onChange={v=>updHole(i,{hw:v})} />
                  <NumField label="Ширина" value={hole.hh??100} onChange={v=>updHole(i,{hh:v})} />
                </div>
              )}

              {/* Глубина для выборки */}
              {hole.type === 'pocket' && (
                <div style={{ marginBottom:10 }}>
                  <NumField label="Глубина" value={hole.depth??10} onChange={v=>updHole(i,{depth:v})} />
                </div>
              )}

              {/* Позиция */}
              <SideOffsetPicker activeSides={hole.sides||[]} offsets={hole.offsets||{}}
                onChange={({sides,offsets})=>updHole(i,{sides,offsets})} />
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
