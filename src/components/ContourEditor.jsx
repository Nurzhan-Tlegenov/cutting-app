import { useState, useRef, useEffect, useCallback } from 'react'

// ─── База фурнитуры (конфирматы, шканты, полкодержатели, минификсы...) ───────
// Единая для присадки по плоскости и по торцу. Хранится на устройстве.
const HARDWARE_KEY = 'raskoypro_hardware_presets_v1'
function loadHardwarePresets() {
  try {
    const raw = localStorage.getItem(HARDWARE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}
function saveHardwarePresetsToStorage(list) {
  try { localStorage.setItem(HARDWARE_KEY, JSON.stringify(list)) } catch {}
}


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
    arcFlip: v.arcFlip || false,
    // fillet: центр и радиус скругления
    fcx: v.fcx != null ? ox + v.fcx * sc : null,
    fcy: v.fcy != null ? oy + dh - v.fcy * sc : null,
    fr:  v.fr  != null ? v.fr * sc : null,
    fa0: v.fa0,
    fa1: v.fa1,
    fccw: v.fccw || false,
  }))

  function cc3(a,b,c){
    const D=2*(a.x*(b.y-c.y)+b.x*(c.y-a.y)+c.x*(a.y-b.y))
    if(Math.abs(D)<0.001)return null
    const ux=((a.x*a.x+a.y*a.y)*(b.y-c.y)+(b.x*b.x+b.y*b.y)*(c.y-a.y)+(c.x*c.x+c.y*c.y)*(a.y-b.y))/D
    const uy=((a.x*a.x+a.y*a.y)*(c.x-b.x)+(b.x*b.x+b.y*b.y)*(a.x-c.x)+(c.x*c.x+c.y*c.y)*(b.x-a.x))/D
    return{x:ux,y:uy}
  }

  function getArcInfo(ni){
    let si=ni; while(cv[(si-1+n)%n].type==='arc') si=(si-1+n)%n
    let ei=ni; while(cv[(ei+1)%n].type==='arc') ei=(ei+1)%n
    return{p1:cv[(si-1+n)%n], pm:cv[si], p3:cv[(ei+1)%n], C:cc3(cv[(si-1+n)%n],cv[si],cv[(ei+1)%n])}
  }

  function drawArc3(a,b,c,startPt,endPt){
    const C=cc3(a,b,c); if(!C){ctx.lineTo((endPt||c).x,(endPt||c).y);return}
    const R=Math.hypot(a.x-C.x,a.y-C.y)
    const sp=startPt||a, ep=endPt||c
    const sa=Math.atan2(sp.y-C.y,sp.x-C.x)
    const ma=Math.atan2(b.y-C.y,b.x-C.x)
    const ea=Math.atan2(ep.y-C.y,ep.x-C.x)
    let dma=ma-sa; while(dma<0)dma+=Math.PI*2
    let dea=ea-sa; while(dea<0)dea+=Math.PI*2
    ctx.arc(C.x,C.y,R,sa,ea,dma>dea)
  }

  ctx.beginPath()
  let started = false

  for(let i=0;i<n;i++){
    const curr=cv[i], next=cv[(i+1)%n], prev=cv[(i-1+n)%n]

    // Fillet точка — явное скругление (новая архитектура)
    if(curr.type==='fillet'){
      const ccw = curr.arcFlip ? !curr.fccw : curr.fccw
      ctx.arc(curr.fcx, curr.fcy, curr.fr, curr.fa0, curr.fa1, ccw)
      started = true
      continue
    }

    // Дуга через 3+ точек
    if(curr.type==='arc'){
      const arcGroup=[]
      let j=i
      while(j<n && cv[j%n].type==='arc'){arcGroup.push(cv[j%n]);j++}

      // Определяем start/end точки — ta записана как позиция fillet точки
      const prevPt = cv[(i-1+n)%n]
      const nextPt = cv[j%n]
      const p1 = prevPt.type==='fillet' ? prevPt : prevPt  // ta = позиция fillet
      const p3 = nextPt.type==='fillet' ? nextPt : nextPt

      // p1 реальная начальная точка дуги — позиция ta (fillet.x, fillet.y = ta coords)
      const sp = p1
      const ep = p3

      if(!started){ ctx.moveTo(sp.x, sp.y); started=true }
      else ctx.lineTo(sp.x, sp.y)

      if(arcGroup.length===1){
        drawArc3(sp, arcGroup[0], ep, sp, ep)
      } else {
        for(let k=0;k+1<arcGroup.length;k++){
          const s=k===0?sp:arcGroup[k-1]
          const e=k===arcGroup.length-2?ep:arcGroup[k+2]
          drawArc3(k===0?sp:arcGroup[k-1], arcGroup[k], k===arcGroup.length-1?ep:arcGroup[k+1], k===0?sp:null, k===arcGroup.length-2?ep:null)
        }
        // Упрощённо для группы:
      }
      i=j-1; started=true; continue
    }

    const r=curr.r
    const dx0=prev.x-curr.x, dy0=prev.y-curr.y
    const dx1=next.x-curr.x, dy1=next.y-curr.y
    const d0=Math.hypot(dx0,dy0), d1=Math.hypot(dx1,dy1)

    if(r<=0){
      if(!started){ ctx.moveTo(curr.x,curr.y); started=true }
      else ctx.lineTo(curr.x,curr.y)
    } else if(d0===0||d1===0){
      if(!started){ ctx.moveTo(curr.x,curr.y); started=true }
      else ctx.lineTo(curr.x,curr.y)
    } else {
      const t=Math.min(r,d0,d1)
      if(!started){ ctx.moveTo(curr.x+dx0/d0*t,curr.y+dy0/d0*t); started=true }
      else ctx.lineTo(curr.x+dx0/d0*t,curr.y+dy0/d0*t)
      ctx.arcTo(curr.x,curr.y,curr.x+dx1/d1*t,curr.y+dy1/d1*t,r)
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

// ─── Найти линии разметки (полка/стойка/царга) по массиву id ─────────────────
function findLayoutGuides(layout, ids) {
  if (!ids || !ids.length) return []
  return (layout || []).filter(g => ids.includes(g.id))
}

// ─── Блоки полок/стоек ────────────────────────────────────────────────────────
// Полка, поставленная ОДНА — независимая, определяет границы проёмов сама.
// Несколько полок, поставленных ОДНИМ действием ("N штук в проём") — это БЛОК:
// у них общий blockId и ссылки на границы (либо край детали, либо конкретная
// независимая полка). Если независимая полка потом двигается — границы блока
// меняются, и весь блок пересчитывает равные проёмы заново, "утягивая" за собой
// привязанную к этим полкам присадку (она уже сама смотрит на текущий guide.pos).
function resolveBoundary(ref, byId) {
  if (!ref) return 0
  if (ref.guideId != null) {
    const g = byId[ref.guideId]
    if (g) return ref.edge === 'far' ? (g.pos || 0) + (g.thickness || 18) : (g.pos || 0)
  }
  return ref.value ?? 0
}
function resolveEffectiveLayout(layout, w, h) {
  if (!layout || !layout.length || !layout.some(g => g.blockId)) return layout || []
  const byId = {}
  layout.forEach(g => { byId[g.id] = g })
  const groups = {}
  layout.forEach(g => { if (g.blockId) (groups[g.blockId] = groups[g.blockId] || []).push(g) })
  const out = layout.map(g => ({ ...g }))
  Object.keys(groups).forEach(bid => {
    const members = groups[bid].slice().sort((a, b) => (a.blockIndex ?? 0) - (b.blockIndex ?? 0))
    const first = members[0]
    const isUpright = first.kind === 'upright'
    const total = isUpright ? w : h
    const start = resolveBoundary(first.blockStartRef, byId)
    const end = resolveBoundary(first.blockEndRef, byId) || total
    const n = members.length
    const thickness = first.thickness || 18
    const span = Math.max(0, end - start)
    const openSpan = Math.max(0, span - thickness * n)
    const step = openSpan / (n + 1)
    let cursor = start
    members.forEach(m => {
      const pos = cursor + step
      const idx = out.findIndex(x => x.id === m.id)
      if (idx >= 0) out[idx] = { ...out[idx], pos: Math.round(pos) }
      cursor = pos + thickness
    })
  })
  return out
}

// ─── Целевая координата вдоль оси привязки (центр толщины ± зазор) ───────────
function attachedTargetForGuide(dr, guide) {
  const gap = dr.gap ?? 0
  const dirMul = dr.gapDir === 'neg' ? -1 : 1
  const center = (guide.pos || 0) + (guide.thickness || 18) / 2 + dirMul * gap
  return { axis: guide.kind === 'upright' ? 'x' : 'y', value: center }
}

// ─── Кратность (система 32) ───────────────────────────────────────────────────
// Кратность — это расстояние МЕЖДУ отверстиями (базовым и зеркальным), а не снап
// каждой стороны по отдельности. Введённый отступ — это МИНИМУМ от края.
//
// baseFixed=false: обе стороны симметрично двигаются к ближайшему валидному значению.
// baseFixed=true: базовая сторона остаётся ровно такой, как введена (зафиксирована),
// а зеркальная подгоняется под неё (используя свой минимум, если задан).
function resolveKratnostValue(rawBase, span, mirrorEnabled, mirrorMinRaw, pitchStep, baseFixed) {
  const mod = (v, m) => ((v % m) + m) % m
  if (!pitchStep) return { base: rawBase, mirror: mirrorEnabled ? (mirrorMinRaw ?? rawBase) : null }
  if (!mirrorEnabled) return { base: Math.ceil(rawBase / pitchStep) * pitchStep, mirror: null }

  if (!baseFixed) {
    // Симметричный случай — обе стороны двигаются вместе к ближайшему валидному значению
    let x = rawBase
    for (let k = 0; k < pitchStep; k++) {
      const cand = rawBase + k
      if (mod(span - 2 * cand, pitchStep) === 0) { x = cand; break }
    }
    return { base: x, mirror: x }
  }
  // Базовая сторона зафиксирована как введено, зеркало подгоняем под неё
  const mn = mirrorMinRaw ?? rawBase
  let m = mn
  for (let k = 0; k < pitchStep; k++) {
    const cand = mn + k
    if (mod(span - rawBase - cand, pitchStep) === 0) { m = cand; break }
  }
  return { base: rawBase, mirror: m }
}

// ─── Центр присадки по плоскости от сторон (offsets — расстояние до ЦЕНТРА) ──
function faceDrillCenterFromSides(dr, panelW, panelH, pitchStep) {
  const sides = dr.sides || [], offsets = dr.offsets || {}
  let x = panelW / 2, y = panelH / 2, axisX = null, axisY = null
  if (sides.includes('left') && sides.includes('right')) {
    x = ((offsets.left ?? 0) + (panelW - (offsets.right ?? 0))) / 2
  } else if (sides.includes('left') || sides.includes('right')) {
    const baseSide = sides.includes('left') ? 'left' : 'right'
    const baseFixed = !!dr.baseFixedX || dr.mirrorMinX != null
    const r = resolveKratnostValue(offsets[baseSide] ?? 0, panelW, !!dr.mirrorX, dr.mirrorMinX, pitchStep, baseFixed)
    axisX = { baseSide, ...r }
    x = baseSide === 'left' ? axisX.base : panelW - axisX.base
  }
  if (sides.includes('top') && sides.includes('bottom')) {
    y = ((offsets.bottom ?? 0) + (panelH - (offsets.top ?? 0))) / 2
  } else if (sides.includes('bottom') || sides.includes('top')) {
    const baseSide = sides.includes('bottom') ? 'bottom' : 'top'
    const baseFixed = !!dr.baseFixedY || dr.mirrorMinY != null
    const r = resolveKratnostValue(offsets[baseSide] ?? 0, panelH, !!dr.mirrorY, dr.mirrorMinY, pitchStep, baseFixed)
    axisY = { baseSide, ...r }
    y = baseSide === 'bottom' ? axisY.base : panelH - axisY.base
  }
  return { x, y, axisX, axisY }
}

// ─── Точки присадки по плоскости (базовые, с рядом, для одной привязки/без неё) ─
// Свободная ось (не управляемая привязкой) считается от ГРАНИЦ САМОЙ ЛИНИИ
// разметки (с учётом её отступов слева/справа или снизу/сверху), а не от краёв детали.
// Возвращает { pts, axisX, axisY } — оси нужны дальше для зеркалирования с кратностью.
function faceDrillPointsForGuide(dr, panelW, panelH, guide) {
  let effW = panelW, effH = panelH, offX0 = 0, offY0 = 0
  if (guide) {
    if (guide.kind === 'upright') {
      offY0 = guide.insetBottom || 0
      effH = Math.max(1, panelH - (guide.insetBottom || 0) - (guide.insetTop || 0))
    } else {
      offX0 = guide.insetLeft || 0
      effW = Math.max(1, panelW - (guide.insetLeft || 0) - (guide.insetRight || 0))
    }
  }
  const pitchStep = dr.pitchEnabled ? (dr.pitchStep || 32) : 0
  const center = faceDrillCenterFromSides(dr, effW, effH, pitchStep)
  let baseX = center.x + offX0, baseY = center.y + offY0
  if (guide) {
    const att = attachedTargetForGuide(dr, guide)
    if (att.axis === 'y') baseY = Math.max(0, Math.min(panelH, att.value))
    else baseX = Math.max(0, Math.min(panelW, att.value))
  }
  const count = dr.row ? Math.max(1, Math.round(dr.rowCount || 1)) : 1
  const step = dr.rowStep || 32
  const offsetStart = -(count - 1) / 2 // симметрично относительно исходной точки
  const pts = []
  for (let k = 0; k < count; k++) {
    const off = (offsetStart + k) * step
    pts.push(dr.rowDir === 'y'
      ? { x: baseX, y: baseY + off }
      : { x: baseX + off, y: baseY })
  }
  return { pts, axisX: center.axisX, axisY: center.axisY }
}

// ─── Зеркалирование присадки по плоскости в пределах ширины САМОЙ линии разметки
// (а не всей детали) — чтобы «зеркалить» давало симметрию по границам линии.
// axisX/axisY — уже посчитанные (с учётом кратности) базовое и зеркальное значения
// для этой оси; если кратность выключена — обычное геометрическое отражение.
function mirrorFacePointsForGuide(pts, dr, panelW, panelH, guide, axisX, axisY) {
  let xLo = 0, xHi = panelW, yLo = 0, yHi = panelH
  if (guide) {
    if (guide.kind === 'upright') {
      yLo = guide.insetBottom || 0
      yHi = panelH - (guide.insetTop || 0)
    } else {
      xLo = guide.insetLeft || 0
      xHi = panelW - (guide.insetRight || 0)
    }
  }
  let result = pts.map(p => ({ ...p }))
  if (dr.mirrorX) {
    result = result.concat(pts.map(p => {
      if (axisX && axisX.mirror != null) {
        return { ...p, x: axisX.baseSide === 'left' ? (xHi - axisX.mirror) : (xLo + axisX.mirror) }
      }
      return { ...p, x: xLo + xHi - p.x }
    }))
  }
  if (dr.mirrorY) {
    const cur = result
    result = cur.concat(cur.map(p => {
      if (axisY && axisY.mirror != null) {
        return { ...p, y: axisY.baseSide === 'bottom' ? (yHi - axisY.mirror) : (yLo + axisY.mirror) }
      }
      return { ...p, y: yLo + yHi - p.y }
    }))
  }
  return result
}

// ─── Точки присадки по плоскости — по всем выбранным привязкам сразу ─────────
function baseFaceDrillPoints(dr, panelW, panelH, layout) {
  const guides = findLayoutGuides(layout, dr.attachTo)
  if (!guides.length) {
    const { pts, axisX, axisY } = faceDrillPointsForGuide(dr, panelW, panelH, null)
    return mirrorFacePointsForGuide(pts, dr, panelW, panelH, null, axisX, axisY)
  }
  let all = []
  for (const guide of guides) {
    const { pts, axisX, axisY } = faceDrillPointsForGuide(dr, panelW, panelH, guide)
    all = all.concat(mirrorFacePointsForGuide(pts, dr, panelW, panelH, guide, axisX, axisY))
  }
  return all
}

// ─── Точки присадки по торцу (базовые, с рядом) ──────────────────────────────
// offsetAlong — расстояние от угла до ЦЕНТРА отверстия.
// dx/dy — единичный вектор направления сверления ВНУТРЬ детали.
function baseEdgeDrillPoints(dr, panelW, panelH) {
  const edge = dr.edgeSide || 'left'
  const along = dr.offsetAlong ?? 50
  const count = dr.row ? Math.max(1, Math.round(dr.rowCount || 1)) : 1
  const step = dr.rowStep || 32
  const offsetStart = -(count - 1) / 2 // симметрично относительно исходной точки
  const fromEnd = dr.alongFrom === 'end'
  const dir = edge === 'left' ? { dx: 1, dy: 0 } : edge === 'right' ? { dx: -1, dy: 0 }
    : edge === 'top' ? { dx: 0, dy: -1 } : { dx: 0, dy: 1 } // bottom
  const total = (edge === 'left' || edge === 'right') ? panelH : panelW
  const alongIsX = (edge === 'top' || edge === 'bottom')

  // Кратность вдоль торца — считается для одиночной точки (не для ряда)
  const alongMirrorActive = alongIsX ? !!dr.mirrorX : !!dr.mirrorY
  const pitchStep = dr.pitchEnabled ? (dr.pitchStep || 32) : 0
  let axisAlong = null
  if (count === 1 && pitchStep) {
    const baseFixed = !!dr.baseFixed || dr.mirrorMinAlong != null
    axisAlong = resolveKratnostValue(along, total, alongMirrorActive, dr.mirrorMinAlong, pitchStep, baseFixed)
  }

  const pts = []
  for (let k = 0; k < count; k++) {
    const rawA = axisAlong ? axisAlong.base : (along + (offsetStart + k) * step) // расстояние до центра k-го отверстия
    const center = fromEnd ? (total - rawA) : rawA
    let x, y
    if (edge === 'bottom') { y = 0; x = center }
    else if (edge === 'top') { y = panelH; x = center }
    else if (edge === 'left') { x = 0; y = center }
    else { x = panelW; y = center } // right
    pts.push({ x, y, dx: dir.dx, dy: dir.dy })
  }
  return { pts, axisAlong, alongIsX, fromEnd }
}

// ─── Зеркалирование точек присадки по торцу — вдоль того же торца (с кратностью,
// если включена) и/или поперёк (переключение на противоположный торец) ─────────
function mirrorEdgePoints(pts, dr, panelW, panelH, axisAlong, alongIsX, fromEnd) {
  let result = pts.map(p => ({ ...p }))
  const mirrorAlongFlag = alongIsX ? dr.mirrorX : dr.mirrorY
  const mirrorCrossFlag = alongIsX ? dr.mirrorY : dr.mirrorX
  if (mirrorAlongFlag) {
    result = result.concat(pts.map(p => {
      if (axisAlong && axisAlong.mirror != null) {
        const total = alongIsX ? panelW : panelH
        const mirroredCenter = fromEnd ? axisAlong.mirror : (total - axisAlong.mirror)
        return alongIsX ? { ...p, x: mirroredCenter } : { ...p, y: mirroredCenter }
      }
      return alongIsX ? { ...p, x: panelW - p.x } : { ...p, y: panelH - p.y }
    }))
  }
  if (mirrorCrossFlag) {
    const cur = result
    result = cur.concat(cur.map(p => alongIsX
      ? { ...p, y: panelH - p.y, dy: -p.dy }
      : { ...p, x: panelW - p.x, dx: -p.dx }))
  }
  return result
}

// ─── Итоговые точки присадки (ряд + зеркало) — единая точка входа для рендера и экспорта
function getDrillPoints(dr, panelW, panelH, layout) {
  if (dr.kind === 'edge') {
    const { pts, axisAlong, alongIsX, fromEnd } = baseEdgeDrillPoints(dr, panelW, panelH)
    return mirrorEdgePoints(pts, dr, panelW, panelH, axisAlong, alongIsX, fromEnd)
  }
  // Присадка по плоскости зеркалится внутри baseFaceDrillPoints — по ширине
  // конкретной линии разметки (если есть привязка), а не всей детали
  return baseFaceDrillPoints(dr, panelW, panelH, layout)
}

// ─── Выноска размера для присадки по плоскости ───────────────────────────────
// Считаем расстояния ЖИВЬЁМ из текущей позиции точки — выноска всегда точна и всегда
// отображается, независимо от того, как отверстие было установлено (пальцем или цифрами).
// Расстояние — до ЦЕНТРА отверстия (как и хранится в offsets).
// xLo/xHi/yLo/yHi — границы САМОЙ ЛИНИИ разметки (или всей детали, если без привязки).
// mirrorX/mirrorY — эта точка является зеркальной копией по этой оси → меряем от
// ПРОТИВОПОЛОЖНОГО края линии, а не от того же, что и у базовой точки.
// Рисует только линии-выноски, подписи возвращает — чтобы их развести с остальными
// подписями/маркерами на канвасе в единой системе.
function drawFaceLeader(ctx, dr, px, py, sc, ox, oy, dh, dataX, dataY, xLo, xHi, yLo, yHi, mirrorX, mirrorY) {
  const sides = dr.sides || []
  let xSide = sides.includes('left') ? 'left' : sides.includes('right') ? 'right' : (dataX <= (xLo+xHi)/2 ? 'left' : 'right')
  let ySide = sides.includes('bottom') ? 'bottom' : sides.includes('top') ? 'top' : (dataY <= (yLo+yHi)/2 ? 'bottom' : 'top')
  if (mirrorX) xSide = xSide === 'left' ? 'right' : 'left'
  if (mirrorY) ySide = ySide === 'bottom' ? 'top' : 'bottom'
  const distX = xSide === 'left' ? (dataX - xLo) : (xHi - dataX)
  const distY = ySide === 'bottom' ? (dataY - yLo) : (yHi - dataY)

  ctx.save()
  ctx.strokeStyle = 'rgba(24,95,165,0.6)'; ctx.setLineDash([3,3]); ctx.lineWidth = 1

  const exX = ox + (xSide === 'left' ? xLo : xHi) * sc
  ctx.beginPath(); ctx.moveTo(exX, py); ctx.lineTo(px, py); ctx.stroke()

  const exY = oy + dh - (ySide === 'bottom' ? yLo : yHi) * sc
  ctx.beginPath(); ctx.moveTo(px, exY); ctx.lineTo(px, py); ctx.stroke()
  ctx.restore()

  return [
    { x: (exX + px) / 2, y: py - 6, text: String(Math.round(distX)), color: '#185FA5' },
    { x: px + 8, y: (exY + py) / 2, text: String(Math.round(distY)), color: '#185FA5' },
  ]
}

// ─── Выноска размера для присадки по торцу (вдоль торца + глубина) ───────────
// Также считается живьём от фактического положения точки — не зависит от способа установки.
function drawEdgeLeader(ctx, dr, px, py, w, h, sc, ox, oy, dh, dataX, dataY, dxDir, dyDir, halfD, depthPx) {
  ctx.save()
  ctx.strokeStyle = 'rgba(123,79,201,0.6)'; ctx.setLineDash([3,3]); ctx.lineWidth = 1
  const labels = []

  if (dxDir !== 0) {
    // Левый/правый торец — размер "вдоль торца" измеряется по Y, от ближнего угла, до ЦЕНТРА отверстия
    const distBottom = dataY, distTop = h - dataY
    const fromBottom = distBottom <= distTop
    const cornerY = fromBottom ? oy + dh : oy
    ctx.beginPath(); ctx.moveTo(px, cornerY); ctx.lineTo(px, py); ctx.stroke()
    labels.push({ x: px + (dxDir > 0 ? 9 : -9), y: (cornerY + py) / 2, text: String(Math.round(fromBottom ? distBottom : distTop)), color: '#7B4FC9' })
  } else {
    // Верхний/нижний торец — размер "вдоль торца" измеряется по X, от ближнего угла, до ЦЕНТРА отверстия
    const distLeft = dataX, distRight = w - dataX
    const fromLeft = distLeft <= distRight
    const cornerX = fromLeft ? ox : ox + w * sc
    ctx.beginPath(); ctx.moveTo(cornerX, py); ctx.lineTo(px, py); ctx.stroke()
    labels.push({ x: (cornerX + px) / 2, y: py + (dyDir < 0 ? 9 : -9), text: String(Math.round(fromLeft ? distLeft : distRight)), color: '#7B4FC9' })
  }

  // Выноска глубины — вдоль направления сверления, до внутреннего конца
  const ix = px + dxDir * depthPx, iy = py - dyDir * depthPx
  ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(ix, iy); ctx.stroke()
  ctx.restore()

  const depthLabel = String(Math.round((dr.depth || 15)))
  labels.push({
    x: (px + ix) / 2, y: (py + iy) / 2, text: depthLabel, color: '#7B4FC9',
    angle: dxDir === 0 ? Math.PI / 2 : 0,
  })
  return labels
}

// ─── Конвертировать прямоугольный вырез в вершины ────────────────────────────
function holeToVertices(hole, panelW, panelH) {
  if (hole.type === 'circle') return null // круг — не конвертируем
  const hw = hole.hw || 200, hh = hole.hh || 100
  const pos = resolvePos(hole.sides||[], hole.offsets||{}, panelW, panelH, hw, hh)
  // 4 вершины прямоугольника (Y вверх, CCW обход)
  return [
    { x: pos.x,        y: pos.y,        r: 0, type: 'point' }, // нижний левый
    { x: pos.x + pos.w, y: pos.y,       r: 0, type: 'point' }, // нижний правый
    { x: pos.x + pos.w, y: pos.y + pos.h, r: 0, type: 'point' }, // верхний правый
    { x: pos.x,        y: pos.y + pos.h, r: 0, type: 'point' }, // верхний левый
  ]
}
function getMarkers(verts, sc, ox, oy, dh) {
  return (verts || [])
    .map((v, i) => ({
      idx: i,
      x: ox + v.x * sc,
      y: oy + dh - v.y * sc,
      r: v.r || 0,
      vertex: v,
    }))
    .filter(m => m.vertex.type !== 'fillet') // fillet точки не редактируются напрямую
}

// ─── Canvas ───────────────────────────────────────────────────────────────────
function ContourCanvas({ detail, contour, activeIdx, previewVerts, onTap, showMarkers=true, showLengths=true, showAngles=true, showDrillDims=true, arcMode=false, arcPoints=[], activeHoleIdx=null, placeMode=false, onPlaceTap=null, zoom=1, onZoomChange=null, onLayoutTap=null, highlightLayoutIdx=null, rotation=0, materialThickness=16 }) {
  const ref = useRef(null)
  const wrapRef = useRef(null)
  // Ширина(X) детали — горизонталь канваса, Длина(Y) — вертикаль (мебельный стандарт)
  const w = Number(detail.h) || 0
  const h = Number(detail.w) || 0

  // Pinch-to-zoom двумя пальцами прямо в окне превью — зумируем в ту область, где щипок
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const onZoomChangeRef = useRef(onZoomChange)
  onZoomChangeRef.current = onZoomChange
  const zoomAnchorRef = useRef(null) // {fracX, fracY, midX, midY} — куда навести после ресайза канваса
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const state = { active: false, dist: 0, zoom: 1 }
    const getDist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)
    const onStart = (e) => {
      if (e.touches.length === 2) {
        state.active = true
        state.dist = getDist(e.touches)
        state.zoom = zoomRef.current
        // Запоминаем, куда именно щипаем — относительно текущего канваса и видимой области
        const wrap = wrapRef.current
        const canvas = ref.current
        if (wrap && canvas) {
          const wrapRect = wrap.getBoundingClientRect()
          const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2 - wrapRect.left
          const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2 - wrapRect.top
          const canvasX = wrap.scrollLeft + midX
          const canvasY = wrap.scrollTop + midY
          const cw = canvas.offsetWidth || 1, ch = canvas.offsetHeight || 1
          zoomAnchorRef.current = { fracX: canvasX / cw, fracY: canvasY / ch, midX, midY }
        }
      }
    }
    const onMove = (e) => {
      if (state.active && e.touches.length === 2) {
        e.preventDefault()
        const d = getDist(e.touches)
        if (state.dist > 0) {
          const ratio = d / state.dist
          const nz = Math.max(0.3, Math.min(2.5, state.zoom * ratio))
          onZoomChangeRef.current && onZoomChangeRef.current(nz)
        }
      }
    }
    const onEnd = (e) => {
      if (e.touches.length < 2) {
        state.active = false
        // Небольшая задержка — чтобы последнее движение зума успело отрисоваться
        // с этой же точкой привязки, а не сбросилось в центр раньше времени
        setTimeout(() => { zoomAnchorRef.current = null }, 60)
      }
    }
    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd, { passive: true })
    el.addEventListener('touchcancel', onEnd, { passive: true })
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onEnd)
    }
  }, [])

  // Для центрирования только при смене zoom/поворота (не при любой перерисовке —
  // иначе выбор точки/правка контура будет сбрасывать прокрутку пользователя)
  const prevRotationRef = useRef(rotation)
  const prevZoomForScrollRef = useRef(zoom)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas || !w || !h) return
    const ctx = canvas.getContext('2d')
    const DPR = window.devicePixelRatio || 1
    const rot90 = rotation === 90 || rotation === 270
    // При повороте на 90/270 деталь ложится "на бок" — под неё нужно отвести
    // столько же места, сколько было бы под её перевёрнутый силуэт
    const fitW = rot90 ? h : w, fitH = rot90 ? w : h

    // Высокое разрешение — базовая ширина берётся от контейнера (не масштабируется зумом),
    // сам масштаб детали внутри регулируется зумом отдельно
    const baseW = wrapRef.current?.clientWidth || canvas.offsetWidth || 280
    const CSS_W = Math.round(baseW * zoom)
    const PAD = 30
    // Отступы одинаковые со всех сторон (не только у ширины) — деталь всегда точно
    // по центру и растягивается на всё доступное место, при любом повороте
    const sc = (CSS_W - PAD*2) / fitW
    const CSS_H = Math.round(fitH * sc + PAD*2)
    canvas.width = CSS_W * DPR
    canvas.height = CSS_H * DPR
    canvas.style.width = CSS_W + 'px'
    canvas.style.height = CSS_H + 'px'
    ctx.scale(DPR, DPR)

    // Центрируем канвас через margin, если он МЕНЬШЕ видимой области (зум < 100%) —
    // без flexbox, чтобы не ломать ручную прокрутку/наведение при зуме > 100%
    if (wrapRef.current) {
      const wrap = wrapRef.current
      const extraW = Math.max(0, wrap.clientWidth - CSS_W)
      const extraH = Math.max(0, wrap.clientHeight - CSS_H)
      canvas.style.marginLeft = (extraW / 2) + 'px'
      canvas.style.marginTop = (extraH / 2) + 'px'
    }

    // Прокрутку трогаем ТОЛЬКО когда реально поменялся zoom или поворот — иначе любая
    // перерисовка (выбор точки, правка контура) будет сбрасывать позицию пользователя.
    if (wrapRef.current) {
      const wrap = wrapRef.current
      const rotationChanged = prevRotationRef.current !== rotation
      const zoomChanged = prevZoomForScrollRef.current !== zoom
      prevRotationRef.current = rotation
      prevZoomForScrollRef.current = zoom
      if (rotationChanged || zoomChanged || zoomAnchorRef.current) {
        const anchor = rotationChanged ? null : zoomAnchorRef.current
        if (anchor) {
          wrap.scrollLeft = Math.max(0, anchor.fracX * CSS_W - anchor.midX)
          wrap.scrollTop = Math.max(0, anchor.fracY * CSS_H - anchor.midY)
        } else {
          wrap.scrollLeft = Math.max(0, (CSS_W - wrap.clientWidth) / 2)
          wrap.scrollTop = Math.max(0, (CSS_H - wrap.clientHeight) / 2)
        }
      }
    }

    const dw = w * sc, dh = h * sc
    const ox = (CSS_W - dw) / 2, oy = (CSS_H - dh) / 2

    // Единая система размещения подписей: все текстовые размеры/названия собираются
    // сюда и в конце разводятся между собой И от маркеров/точек — чтобы ничего
    // не перекрывалось и не читалось поверх друг друга.
    const allLabels = []   // { x, y, text, color, bold?, angle? }
    const obstacles = []   // { x, y, r } — маркеры/точки, от которых подписи отталкиваются

    ctx.clearRect(0, 0, CSS_W, CSS_H)

    // Поворот превью на удобный пользователю угол (0/90/180/270) — визуальный,
    // сами данные детали не меняются. Всё дальше рисуется как обычно (в исходной
    // ориентации), а сама сцена целиком поворачивается вокруг центра канваса.
    ctx.save()
    if (rotation) {
      ctx.translate(CSS_W/2, CSS_H/2)
      ctx.rotate(rotation * Math.PI / 180)
      ctx.translate(-CSS_W/2, -CSS_H/2)
    }

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
    const verts = (activeHoleIdx === null ? previewVerts : null) || contour.vertices || makeRect(w, h)
    buildPath(ctx, verts, sc, ox, oy, dh)
    ctx.fillStyle = '#E6F1FB'; ctx.fill()
    ctx.strokeStyle = '#185FA5'; ctx.lineWidth = 1.5; ctx.stroke()

    // Кромка — показываем, на каких сторонах она назначена в карточке детали
    const edges = detail.edges || {}
    if (edges.top || edges.bottom || edges.left || edges.right) {
      ctx.save()
      ctx.strokeStyle = '#2FA84F'; ctx.lineWidth = 4; ctx.lineCap = 'round'
      const mk = (val) => val && val !== 'default' ? val : 'кромка'
      if (edges.bottom) {
        ctx.beginPath(); ctx.moveTo(ox+2, oy+dh); ctx.lineTo(ox+dw-2, oy+dh); ctx.stroke()
        allLabels.push({ x: ox+dw/2, y: oy+dh+10, text: mk(edges.bottom), color: '#1F7A38', bold: true })
      }
      if (edges.top) {
        ctx.beginPath(); ctx.moveTo(ox+2, oy); ctx.lineTo(ox+dw-2, oy); ctx.stroke()
        allLabels.push({ x: ox+dw/2, y: oy-10, text: mk(edges.top), color: '#1F7A38', bold: true })
      }
      if (edges.left) {
        ctx.beginPath(); ctx.moveTo(ox, oy+2); ctx.lineTo(ox, oy+dh-2); ctx.stroke()
        allLabels.push({ x: ox-10, y: oy+dh/2, text: mk(edges.left), color: '#1F7A38', bold: true, angle: -Math.PI/2 })
      }
      if (edges.right) {
        ctx.beginPath(); ctx.moveTo(ox+dw, oy+2); ctx.lineTo(ox+dw, oy+dh-2); ctx.stroke()
        allLabels.push({ x: ox+dw+10, y: oy+dh/2, text: mk(edges.right), color: '#1F7A38', bold: true, angle: -Math.PI/2 })
      }
      ctx.restore()
    }

    // Holes
    ;(contour.holes || []).forEach((hole, hi) => {
      const isCircle = hole.type === 'circle'
      ctx.fillStyle = 'white'
      ctx.strokeStyle = '#E24B4A'
      ctx.lineWidth = 1.5
      if (isCircle) {
        const d = hole.d || 100
        const pos = resolvePos(hole.sides||[], hole.offsets||{}, w, h, d, d)
        const cx2 = ox + (pos.x + d/2) * sc
        const cy2 = oy + dh - (pos.y + d/2) * sc
        ctx.beginPath(); ctx.arc(cx2, cy2, d/2*sc, 0, Math.PI*2)
        ctx.fill(); ctx.stroke()
      } else {
        // Используем previewVerts если это активный редактируемый вырез
        const holeVerts = (activeHoleIdx === hi && previewVerts)
          || hole.vertices
          || holeToVertices(hole, w, h)
        if (holeVerts) {
          buildPath(ctx, holeVerts, sc, ox, oy, dh)
          ctx.fill(); ctx.stroke()
        }
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

    // Разметка — полки/стойки/царги (вспомогательные линии для позиционирования присадки)
    ;(contour.layout || []).forEach((g, gi) => {
      const thick = g.thickness || 18
      const colors = g.kind === 'upright'
        ? { fill: 'rgba(42,94,139,0.16)', stroke: '#2A5E8B', label: 'Стойка' }
        : g.kind === 'rail'
        ? { fill: 'rgba(94,42,139,0.14)', stroke: '#5E2A8B', label: 'Царга' }
        : { fill: 'rgba(139,94,42,0.16)', stroke: '#8B5E2A', label: 'Полка' }
      const isHi = highlightLayoutIdx === gi
      ctx.fillStyle = isHi ? colors.fill.replace(/[\d.]+\)$/, '0.4)') : colors.fill
      ctx.strokeStyle = colors.stroke; ctx.lineWidth = isHi ? 2.2 : 1
      let bx, by, bw, bh
      if (g.kind === 'upright') {
        const insetB = g.insetBottom || 0, insetT = g.insetTop || 0
        bx = ox + (g.pos||0) * sc; bw = thick * sc
        by = oy + insetT * sc; bh = dh - (insetB + insetT) * sc
      } else {
        const insetL = g.insetLeft || 0, insetR = g.insetRight || 0
        bx = ox + insetL * sc; bw = dw - (insetL + insetR) * sc
        by = oy + dh - ((g.pos||0) + thick) * sc; bh = thick * sc
      }
      ctx.fillRect(bx, by, bw, bh); ctx.strokeRect(bx, by, bw, bh)
      ctx.setLineDash([3,3])
      if (g.kind === 'upright') {
        ctx.beginPath(); ctx.moveTo(ox, oy+dh); ctx.lineTo(bx, oy+dh); ctx.stroke()
      } else {
        ctx.beginPath(); ctx.moveTo(ox, oy+dh); ctx.lineTo(ox, by+bh); ctx.stroke()
      }
      ctx.setLineDash([])
      const text = `${colors.label} ${Math.round(g.pos||0)}/${Math.round(thick)}`
      if (g.kind === 'upright') allLabels.push({ x: bx+bw/2, y: oy+14, text, color: colors.stroke, bold: isHi })
      else allLabels.push({ x: bx+18, y: by+bh/2, text, color: colors.stroke, bold: isHi })
    })

    // Размерная цепочка между полками/царгами (по Y) и стойками (по X) — можно скрыть тем же переключателем размеров
    if (showLengths) {
      const shelves = (contour.layout||[]).filter(g => g.kind !== 'upright').sort((a,b)=>(a.pos||0)-(b.pos||0))
      if (shelves.length) {
        let prevEdge = 0
        const chainX = ox - 6
        ctx.strokeStyle = 'rgba(139,94,42,0.5)'; ctx.lineWidth = 1; ctx.setLineDash([2,2])
        for (const g of shelves) {
          const gap = (g.pos||0) - prevEdge
          const y1 = oy + dh - prevEdge*sc, y2 = oy + dh - (g.pos||0)*sc
          if (gap > 1) {
            ctx.beginPath(); ctx.moveTo(chainX, y1); ctx.lineTo(chainX, y2); ctx.stroke()
            allLabels.push({ x: chainX-8, y: (y1+y2)/2, text: String(Math.round(gap)), color: '#8B5E2A' })
          }
          prevEdge = (g.pos||0) + (g.thickness||18)
        }
        const lastGap = h - prevEdge
        if (lastGap > 1) {
          const y1 = oy + dh - prevEdge*sc, y2 = oy
          ctx.beginPath(); ctx.moveTo(chainX, y1); ctx.lineTo(chainX, y2); ctx.stroke()
          allLabels.push({ x: chainX-8, y: (y1+y2)/2, text: String(Math.round(lastGap)), color: '#8B5E2A' })
        }
        ctx.setLineDash([])
      }
      const uprights = (contour.layout||[]).filter(g => g.kind === 'upright').sort((a,b)=>(a.pos||0)-(b.pos||0))
      if (uprights.length) {
        let prevEdge = 0
        const chainY = oy + dh + 14
        ctx.strokeStyle = 'rgba(42,94,139,0.5)'; ctx.lineWidth = 1; ctx.setLineDash([2,2])
        for (const g of uprights) {
          const gap = (g.pos||0) - prevEdge
          const x1 = ox + prevEdge*sc, x2 = ox + (g.pos||0)*sc
          if (gap > 1) {
            ctx.beginPath(); ctx.moveTo(x1, chainY); ctx.lineTo(x2, chainY); ctx.stroke()
            allLabels.push({ x: (x1+x2)/2, y: chainY+9, text: String(Math.round(gap)), color: '#2A5E8B' })
          }
          prevEdge = (g.pos||0) + (g.thickness||18)
        }
        const lastGap = w - prevEdge
        if (lastGap > 1) {
          const x1 = ox + prevEdge*sc, x2 = ox + dw
          ctx.beginPath(); ctx.moveTo(x1, chainY); ctx.lineTo(x2, chainY); ctx.stroke()
          allLabels.push({ x: (x1+x2)/2, y: chainY+9, text: String(Math.round(lastGap)), color: '#2A5E8B' })
        }
        ctx.setLineDash([])
      }
    }

    // Присадка — реальная геометрия отверстий + выноски размеров
    ;(contour.drillings || []).forEach(dr => {
      const d = dr.d || 8
      const dPx = d * sc
      const pts = getDrillPoints(dr, w, h, contour.layout)
      // Если присадка привязана к ОДНОЙ линии разметки — размеры меряем от её границ,
      // а не от краёв всей детали
      const attachedSingleGuide = (dr.attachTo && dr.attachTo.length === 1)
        ? (contour.layout || []).find(g => g.id === dr.attachTo[0]) : null
      let gXLo = 0, gXHi = w, gYLo = 0, gYHi = h
      if (attachedSingleGuide) {
        if (attachedSingleGuide.kind === 'upright') {
          gYLo = attachedSingleGuide.insetBottom || 0
          gYHi = h - (attachedSingleGuide.insetTop || 0)
        } else {
          gXLo = attachedSingleGuide.insetLeft || 0
          gXHi = w - (attachedSingleGuide.insetRight || 0)
        }
      }

      if (dr.kind === 'edge') {
        const depthPx = (dr.depth || 15) * sc
        const halfD = d / 2
        pts.forEach((p, pi) => {
          const px = ox + p.x * sc, py = oy + dh - p.y * sc
          const ix = px + p.dx * depthPx   // внутренний конец по X (canvas)
          const iy = py - p.dy * depthPx   // внутренний конец по Y (canvas, инверсия)
          ctx.fillStyle = 'rgba(123,79,201,0.28)'
          ctx.strokeStyle = '#7B4FC9'; ctx.lineWidth = 1.2
          ctx.beginPath()
          if (p.dx !== 0) {
            const rx = Math.min(px, ix), rw = Math.abs(ix - px)
            ctx.rect(rx, py - dPx/2, rw, dPx)
          } else {
            const ry = Math.min(py, iy), rh = Math.abs(iy - py)
            ctx.rect(px - dPx/2, ry, dPx, rh)
          }
          ctx.fill(); ctx.stroke()
          // точка входа сверла на торце
          ctx.beginPath(); ctx.arc(px, py, Math.max(2, dPx*0.18), 0, Math.PI*2)
          ctx.fillStyle = '#7B4FC9'; ctx.fill()
          obstacles.push({ x: px, y: py, r: Math.max(dPx/2, 4) })
          // Выноску до края рисуем и для базовой, и для зеркальной точки (не только первой)
          if ((pi === 0 || pi === 1) && showDrillDims) {
            allLabels.push(...drawEdgeLeader(ctx, dr, px, py, w, h, sc, ox, oy, dh, p.x, p.y, p.dx, p.dy, halfD, depthPx))
          }
        })
        // Расстояние между базовым и зеркальным отверстием (если это простое зеркало, не ряд)
        if (showDrillDims && pts.length >= 2 && !dr.row && (dr.mirrorX || dr.mirrorY)) {
          const p0 = pts[0], p1 = pts[1]
          const px0 = ox + p0.x*sc, py0 = oy + dh - p0.y*sc
          const px1 = ox + p1.x*sc, py1 = oy + dh - p1.y*sc
          const distMm = Math.round(Math.hypot(p1.x - p0.x, p1.y - p0.y))
          ctx.save()
          ctx.strokeStyle = 'rgba(123,79,201,0.45)'; ctx.setLineDash([2,2]); ctx.lineWidth = 1
          ctx.beginPath(); ctx.moveTo(px0, py0); ctx.lineTo(px1, py1); ctx.stroke()
          ctx.restore()
          allLabels.push({ x: (px0+px1)/2, y: (py0+py1)/2, text: `↔${distMm}`, color: '#7B4FC9', bold: true })
        }
      } else {
        pts.forEach((p, pi) => {
          const px = ox + p.x * sc, py = oy + dh - p.y * sc
          const useD = (dr.pairEnabled && pi === 1) ? (dr.pairD ?? dr.d) : dr.d
          const useDepth = (dr.pairEnabled && pi === 1) ? (dr.pairDepth ?? dr.depth) : dr.depth
          const useFace = (dr.pairEnabled && pi === 1) ? (dr.pairFace ?? dr.face) : dr.face
          const r = Math.max(3, (useD || 8) * sc / 2)
          // Сквозное — определяется по глубине: если глубина присадки равна толщине
          // материала (с небольшим допуском), значит отверстие проходит насквозь.
          const pIsThrough = Math.abs((useDepth || 0) - materialThickness) < 0.6
          obstacles.push({ x: px, y: py, r })
          if (pIsThrough) {
            // Сквозное — розовый
            ctx.fillStyle = 'rgba(236,72,153,0.32)'; ctx.strokeStyle = '#EC4899'; ctx.lineWidth = 1.4
            ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI*2); ctx.fill(); ctx.stroke()
          } else if (useFace === 'back') {
            // Глухое с изнанки — синий
            ctx.fillStyle = 'rgba(37,99,235,0.32)'; ctx.strokeStyle = '#2563EB'; ctx.lineWidth = 1.4
            ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI*2); ctx.fill(); ctx.stroke()
            ctx.fillStyle = '#FFFFFF'; ctx.font = `bold ${Math.max(7, Math.round(r))}px sans-serif`
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
            ctx.fillText('И', px, py)
          } else {
            // Глухое с лица — белый
            ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.strokeStyle = '#94A3B8'; ctx.lineWidth = 1.4
            ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI*2); ctx.fill(); ctx.stroke()
            ctx.fillStyle = '#475569'; ctx.font = `bold ${Math.max(7, Math.round(r))}px sans-serif`
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
            ctx.fillText('Л', px, py)
          }
          // Выноску до края рисуем и для базовой, и для зеркальной точки (не только первой)
          if ((pi === 0 || pi === 1) && showDrillDims) {
            const isMirror = pi === 1
            const mX = isMirror && !!dr.mirrorX
            const mY = isMirror && !dr.mirrorX && !!dr.mirrorY
            allLabels.push(...drawFaceLeader(ctx, dr, px, py, sc, ox, oy, dh, p.x, p.y, gXLo, gXHi, gYLo, gYHi, mX, mY))
          }
        })
        // Расстояние между базовым и зеркальным отверстием (если это простое зеркало, не ряд)
        if (showDrillDims && pts.length >= 2 && !dr.row && (dr.mirrorX || dr.mirrorY)) {
          const p0 = pts[0], p1 = pts[1]
          const px0 = ox + p0.x*sc, py0 = oy + dh - p0.y*sc
          const px1 = ox + p1.x*sc, py1 = oy + dh - p1.y*sc
          const distMm = Math.round(Math.hypot(p1.x - p0.x, p1.y - p0.y))
          ctx.save()
          ctx.strokeStyle = 'rgba(24,95,165,0.45)'; ctx.setLineDash([2,2]); ctx.lineWidth = 1
          ctx.beginPath(); ctx.moveTo(px0, py0); ctx.lineTo(px1, py1); ctx.stroke()
          ctx.restore()
          allLabels.push({ x: (px0+px1)/2, y: (py0+py1)/2, text: `↔${distMm}`, color: '#185FA5', bold: true })
        }
      }
    })

    // Размеры отрезков + углы — умное позиционирование
    const n = verts.length
    const cv = verts.map(v => ({
      x: ox + v.x * sc,
      y: oy + dh - v.y * sc,
    }))

    // Центр детали на canvas
    const cxD = ox + dw/2, cyD = oy + dh/2

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
        let ang = Math.atan2(dy, dx)
        if (ang > Math.PI/2 || ang < -Math.PI/2) ang += Math.PI
        allLabels.push({ x: mx + nx*13, y: my + ny*13, text: `${len}`, color:'#185FA5', angle: ang })
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
        allLabels.push({ x: px + (toCx/toD)*dist, y: py + (toCy/toD)*dist,
          text: `${angleDeg}°`, color:'#E24B4A' })
      }
    }

    // Маркеры внешнего контура (всегда видны)
    if (showMarkers || arcMode) {
      const markers = getMarkers(verts, sc, ox, oy, dh)
      markers.forEach(m => {
        if (m.vertex.type === 'fillet') return
        const isActive = activeHoleIdx === null && m.idx === activeIdx
        const isArcSel = activeHoleIdx === null && arcPoints.includes(m.idx)
        const r = arcMode && activeHoleIdx === null ? 10 : (isActive ? 5 : 3.5)
        obstacles.push({ x: m.x, y: m.y, r })
        ctx.beginPath()
        ctx.arc(m.x, m.y, r, 0, Math.PI * 2)
        ctx.fillStyle = isArcSel ? '#F5A623' : isActive ? '#E24B4A' : '#185FA5'
        ctx.fill()
        ctx.strokeStyle = 'white'; ctx.lineWidth = 1.5; ctx.stroke()
        if (arcMode && activeHoleIdx === null) {
          ctx.fillStyle = 'white'; ctx.font = 'bold 9px sans-serif'
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
          ctx.fillText(m.idx + 1, m.x, m.y)
        }
      })
    }

    // Маркеры всех вырезов
    ;(contour.holes || []).forEach((hole, hi) => {
      if (!hole.vertices) return
      const hMarkers = getMarkers(hole.vertices, sc, ox, oy, dh)
      hMarkers.forEach(m => {
        if (m.vertex.type === 'fillet') return
        const isActiveHole = activeHoleIdx === hi
        const isActive = isActiveHole && m.idx === activeIdx
        const isArcSel = isActiveHole && arcPoints.includes(m.idx)
        const r = arcMode && isActiveHole ? 10 : (isActive ? 5 : 3.5)
        obstacles.push({ x: m.x, y: m.y, r })
        ctx.beginPath()
        ctx.arc(m.x, m.y, r, 0, Math.PI * 2)
        ctx.fillStyle = isArcSel ? '#F5A623' : isActive ? '#E24B4A' :
          isActiveHole ? '#E24B4A' : 'rgba(226,75,74,0.4)'
        ctx.fill()
        ctx.strokeStyle = 'white'; ctx.lineWidth = 1.5; ctx.stroke()
        if (arcMode && isActiveHole) {
          ctx.fillStyle = 'white'; ctx.font = 'bold 9px sans-serif'
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
          ctx.fillText(m.idx + 1, m.x, m.y)
        }
      })
    })

    // ── Единая развязка всех подписей: разводим их между собой и от маркеров/точек,
    // затем рисуем разом (без подложки — компактность и отсутствие пересечений важнее)
    ctx.font = '9px sans-serif'
    for (const lb of allLabels) {
      ctx.font = lb.bold ? 'bold 9px sans-serif' : '9px sans-serif'
      lb.hw = ctx.measureText(lb.text).width / 2 + 1.5
      lb.hh = 6
    }
    const LBL_ITER = 8
    for (let iter = 0; iter < LBL_ITER; iter++) {
      for (let i = 0; i < allLabels.length; i++) {
        for (let j = i + 1; j < allLabels.length; j++) {
          const A = allLabels[i], B = allLabels[j]
          const dx = B.x - A.x, dy = B.y - A.y
          const minDx = A.hw + B.hw, minDy = A.hh + B.hh
          if (Math.abs(dx) < minDx && Math.abs(dy) < minDy) {
            const overlapX = minDx - Math.abs(dx)
            const overlapY = minDy - Math.abs(dy)
            if (overlapX < overlapY) {
              const push = overlapX / 2 * (dx === 0 ? 1 : Math.sign(dx))
              A.x -= push; B.x += push
            } else {
              const push = overlapY / 2 * (dy === 0 ? 1 : Math.sign(dy))
              A.y -= push; B.y += push
            }
          }
        }
      }
      for (const lb of allLabels) {
        for (const ob of obstacles) {
          const dx = lb.x - ob.x, dy = lb.y - ob.y
          const dist = Math.hypot(dx, dy) || 0.01
          const minDist = ob.r + Math.max(lb.hw, lb.hh) + 2
          if (dist < minDist) {
            const push = minDist - dist
            lb.x += (dx / dist) * push
            lb.y += (dy / dist) * push
          }
        }
      }
    }
    for (const lb of allLabels) {
      ctx.save()
      ctx.translate(lb.x, lb.y)
      // Компенсируем общий поворот сцены — текст остаётся читаемым при любом повороте детали
      ctx.rotate((lb.angle || 0) - rotation * Math.PI / 180)
      ctx.font = lb.bold ? 'bold 9px sans-serif' : '9px sans-serif'
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillStyle = lb.color
      ctx.fillText(lb.text, 0, 0)
      ctx.restore()
    }

    ctx.restore() // закрываем поворот сцены

  }, [w, h, contour, activeIdx, previewVerts, showMarkers, showLengths, showAngles, showDrillDims, arcMode, arcPoints, activeHoleIdx, zoom, highlightLayoutIdx, detail.edges, rotation])

  const handleTap = (e) => {
    const canvas = ref.current
    if (!canvas || !w || !h) return
    const rect = canvas.getBoundingClientRect()
    const DPR = window.devicePixelRatio || 1
    const CSS_W = rect.width
    const CSS_H = rect.height
    let cx = (e.clientX - rect.left)
    let cy = (e.clientY - rect.top)

    // Превью может быть визуально повёрнуто (0/90/180/270) — переводим точку нажатия
    // обратно в исходную (неповёрнутую) систему координат, чтобы все точки/маркеры
    // остались кликабельными именно там, где они нарисованы на экране
    if (rotation) {
      const rad = -rotation * Math.PI / 180
      const cxCenter = CSS_W / 2, cyCenter = CSS_H / 2
      const dx = cx - cxCenter, dy = cy - cyCenter
      const cos = Math.cos(rad), sin = Math.sin(rad)
      cx = cxCenter + dx*cos - dy*sin
      cy = cyCenter + dx*sin + dy*cos
    }

    const rot90 = rotation === 90 || rotation === 270
    const fitW = rot90 ? h : w, fitH = rot90 ? w : h
    const PAD = 30
    const sc = (CSS_W - PAD*2) / fitW
    const dw = w * sc, dh = h * sc
    const ox = (CSS_W - dw) / 2, oy = (CSS_H - dh) / 2

    // Режим размещения присадки нажатием — координаты точки на детали
    if (placeMode && onPlaceTap) {
      const dataX = Math.max(0, Math.min(w, (cx - ox) / sc))
      const dataY = Math.max(0, Math.min(h, (dh - (cy - oy)) / sc))
      onPlaceTap(dataX, dataY)
      return
    }

    const verts = contour.vertices || makeRect(w, h)
    const TAP_R = arcMode ? 30 : 20

    // Сначала проверяем точки вырезов
    for (let hi = 0; hi < (contour.holes||[]).length; hi++) {
      const hole = contour.holes[hi]
      if (!hole.vertices) continue
      const hMarkers = getMarkers(hole.vertices, sc, ox, oy, dh)
      for (const m of hMarkers) {
        if (Math.hypot(cx - m.x, cy - m.y) <= TAP_R) {
          onTap(m.idx, hi) // передаём holeIdx
          return
        }
      }
    }

    // Потом точки внешнего контура
    const markers = getMarkers(verts, sc, ox, oy, dh)
    for (const m of markers) {
      if (Math.hypot(cx - m.x, cy - m.y) <= TAP_R) {
        onTap(m.idx)
        return
      }
    }

    // Полосы разметки (полки/стойки/царги) — тап переключает на их редактирование
    if (!arcMode && onLayoutTap && contour.layout && contour.layout.length) {
      const dataX = (cx - ox) / sc
      const dataY = (dh - (cy - oy)) / sc
      for (let li = contour.layout.length - 1; li >= 0; li--) {
        const g = contour.layout[li]
        const thick = g.thickness || 18
        if (g.kind === 'upright') {
          const bottom = g.insetBottom || 0, top = h - (g.insetTop || 0)
          if (dataX >= (g.pos||0) && dataX <= (g.pos||0)+thick && dataY >= bottom && dataY <= top) {
            onLayoutTap(li); return
          }
        } else {
          const left = g.insetLeft || 0, right = w - (g.insetRight || 0)
          if (dataY >= (g.pos||0) && dataY <= (g.pos||0)+thick && dataX >= left && dataX <= right) {
            onLayoutTap(li); return
          }
        }
      }
    }
    onTap(null)
  }

  return (
    <div ref={wrapRef} style={{ overflow:'auto', WebkitOverflowScrolling:'touch', maxHeight:460, borderRadius:8, background:'var(--bg2)', touchAction:'pan-x pan-y' }}>
      <canvas ref={ref}
        onClick={handleTap}
        style={{ display:'block', cursor:'pointer', touchAction:'manipulation',
          outline: placeMode ? '2px solid #0E8A6D' : 'none' }} />
    </div>
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
    // Для none — применяем сразу. Для radius — ждём подтверждения
    if (type === 'none') {
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
      {(selType === 'radius') && (
        <div style={{ marginBottom:10 }}>
          <NumField label="Радиус R" value={r} onChange={v => setR(v)} />
          <button type="button" onClick={() => onApplyType(idx, 'radius', { r, dx, dy })}
            style={{ marginTop:8, width:'100%', padding:'8px', background:'var(--blue)', color:'white', border:'none',
              borderRadius:'var(--radius)', fontSize:13, cursor:'pointer', fontWeight:500 }}>
            ✓ Применить радиус R{r}
          </button>
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
function SideOffsetPicker({ activeSides = [], offsets = {}, onChange, allowedSides = null }) {
  const toggle = (id) => {
    const next = activeSides.includes(id) ? activeSides.filter(s => s !== id) : [...activeSides, id]
    onChange({ sides: next, offsets })
  }
  const setOffset = (id, val) => onChange({ sides: activeSides, offsets: { ...offsets, [id]: val } })
  const btns = allowedSides ? SIDE_BTNS.filter(s => allowedSides.includes(s.id)) : SIDE_BTNS
  return (
    <div>
      <label style={{ fontSize: 11, color: 'var(--text-hint)', display: 'block', marginBottom: 6 }}>Привязка к сторонам</label>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
        {btns.map(s => (
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
          {activeSides.filter(id => !allowedSides || allowedSides.includes(id)).map(id => (
            <NumField key={id} label={`Отступ ${SIDE_BTNS.find(s => s.id === id)?.label}`}
              value={offsets[id] ?? 0} onChange={v => setOffset(id, v)} />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Свёртываемый блок ────────────────────────────────────────────────────────
function CollapsibleItem({ title, onRemove, children, innerRef, highlighted, open, onToggleOpen }) {
  return (
    <div ref={innerRef} style={{ background:'var(--bg2)', borderRadius:'var(--radius)', marginBottom:5, overflow:'hidden',
      border: highlighted ? '1.5px solid #8B5E2A' : '1.5px solid transparent', transition:'border-color 0.3s' }}>
      <div style={{ display:'flex', alignItems:'center', padding:'6px 8px', cursor:'pointer' }} onClick={onToggleOpen}>
        <span style={{ fontSize:12.5, fontWeight:500, flex:1 }}>{title}</span>
        <span style={{ fontSize:11, color:'var(--text-hint)', marginRight:6 }}>{open ? '▲' : '▼'}</span>
        <button type="button" onClick={e=>{e.stopPropagation();onRemove()}}
          style={{ background:'none', border:'none', color:'var(--text-hint)', cursor:'pointer', fontSize:15, padding:0 }}>✕</button>
      </div>
      {open && <div style={{ padding:'0 8px 8px' }}>{children}</div>}
    </div>
  )
}

// ─── Главный компонент ────────────────────────────────────────────────────────
export default function ContourEditor({ detail, onUpdate, materialThickness, onClose }) {
  // Ширина(X) детали — горизонталь канваса, Длина(Y) — вертикаль (мебельный стандарт)
  const w = Number(detail.h) || 0
  const h = Number(detail.w) || 0
  const defaultThickness = Number(materialThickness) || 16

  // Нормализуем контур в новый формат
  const rawContour = detail.contour || {}
  const contour = {
    vertices:  rawContour.vertices  || makeRect(w, h),
    holes:     rawContour.holes     || [],
    grooves:   rawContour.grooves   || [],
    drillings: rawContour.drillings || [],
    layout:    rawContour.layout    || [],
  }

  const [tab, setTab] = useState('contour')
  const [activeIdx, setActiveIdx] = useState(null)
  const [activeHoleIdx, setActiveHoleIdx] = useState(null) // индекс редактируемого выреза
  const [previewVerts, setPreviewVerts] = useState(null)
  const [menuSelType, setMenuSelType] = useState(null)
  const [menuDx, setMenuDx] = useState(50)
  const [menuDy, setMenuDy] = useState(50)
  const [menuR, setMenuR] = useState(50)
  const [moveStep, setMoveStep] = useState(10)
  const [showMarkers, setShowMarkers] = useState(true)
  const [showLengths, setShowLengths] = useState(true)
  const [showAngles, setShowAngles] = useState(true)
  const [showDrillDims, setShowDrillDims] = useState(true) // отдельный переключатель размеров присадки
  const [arcMode, setArcMode] = useState(false)
  const [arcPoints, setArcPoints] = useState([]) // индексы выбранных точек
  const [placeDrillIdx, setPlaceDrillIdx] = useState(null) // индекс присадки в режиме "указать нажатием"
  const [placeLayoutIdx, setPlaceLayoutIdx] = useState(null) // индекс линии разметки в режиме "указать нажатием"
  const [zoom, setZoom] = useState(1) // масштаб превью детали (кнопки/списки не масштабируются)
  const [rotation, setRotation] = useState(0) // визуальный поворот превью 0/90/180/270 — только для удобства редактирования
  const [highlightLayoutIdx, setHighlightLayoutIdx] = useState(null) // подсветка линии разметки при тапе по превью
  const [openDrillId, setOpenDrillId] = useState(null) // какая карточка присадки сейчас развёрнута
  const [openLayoutId, setOpenLayoutId] = useState(null) // какая карточка разметки сейчас развёрнута
  const [openHoleCardIdx, setOpenHoleCardIdx] = useState(null)
  const [openGrooveCardIdx, setOpenGrooveCardIdx] = useState(null)

  // База фурнитуры (общая для присадки по плоскости и по торцу).
  // Одна запись может содержать ОБА варианта — параметры для плоскости и для торца
  // (например у конфирмата это разные диаметр/глубина с каждой стороны соединения) —
  // программа сама подставляет нужный вариант в зависимости от того, в какой карточке
  // выбрана эта фурнитура.
  const [hardwarePresets, setHardwarePresets] = useState(() => loadHardwarePresets())
  const [savingHardwareFor, setSavingHardwareFor] = useState(null) // индекс присадки, для которой открыта форма сохранения
  const [newHardwareName, setNewHardwareName] = useState('')
  const saveHardwareSpec = (name, kind, spec) => {
    const trimmed = (name || '').trim()
    if (!trimmed) return
    const idx = hardwarePresets.findIndex(p => p.name.toLowerCase() === trimmed.toLowerCase())
    let next
    if (idx >= 0) {
      next = hardwarePresets.map((p, i) => i === idx ? { ...p, [kind]: spec } : p)
    } else {
      next = [...hardwarePresets, { id: 'hw'+Date.now().toString(36)+Math.random().toString(36).slice(2,5), name: trimmed, [kind]: spec }]
    }
    setHardwarePresets(next)
    saveHardwarePresetsToStorage(next)
  }
  const removeHardwarePreset = (id) => {
    const next = hardwarePresets.filter(p => p.id !== id)
    setHardwarePresets(next)
    saveHardwarePresetsToStorage(next)
  }
  // Обратная совместимость со старыми записями (плоский {d,depth} без разделения)
  const hwFaceSpec = (hp) => hp.face || (hp.d != null && !hp.edge ? { d: hp.d, depth: hp.depth, faceSide: 'front' } : null)
  const hwEdgeSpec = (hp) => hp.edge || (hp.d != null && !hp.face ? { d: hp.d, depth: hp.depth } : null)
  const applyHardwareToDrilling = (i, dr, hp, kind) => {
    if (kind === 'face') {
      const fs = hwFaceSpec(hp)
      if (!fs) return
      updDrilling(i, {
        d: fs.d, depth: fs.depth, face: fs.faceSide || dr.face,
        sides: fs.sides ?? dr.sides, offsets: fs.offsets ?? dr.offsets,
        row: fs.row ?? dr.row, rowDir: fs.rowDir ?? dr.rowDir,
        rowStep: fs.rowStep ?? dr.rowStep, rowCount: fs.rowCount ?? dr.rowCount,
        mirrorX: fs.mirrorX ?? dr.mirrorX, mirrorY: fs.mirrorY ?? dr.mirrorY,
        pitchEnabled: fs.pitchEnabled ?? dr.pitchEnabled, pitchStep: fs.pitchStep ?? dr.pitchStep,
        baseFixedX: fs.baseFixedX ?? dr.baseFixedX, baseFixedY: fs.baseFixedY ?? dr.baseFixedY,
        mirrorMinX: fs.mirrorMinX, mirrorMinY: fs.mirrorMinY,
        attachTo: fs.attachTo ?? dr.attachTo, gap: fs.gap ?? dr.gap, gapDir: fs.gapDir ?? dr.gapDir,
        hardwareId: hp.id,
      })
    } else {
      const es = hwEdgeSpec(hp)
      if (!es) return
      updDrilling(i, {
        d: es.d, depth: es.depth,
        edgeSide: es.edgeSide ?? dr.edgeSide, alongFrom: es.alongFrom ?? dr.alongFrom,
        offsetAlong: es.offsetAlong ?? dr.offsetAlong, offsetFace: es.offsetFace ?? dr.offsetFace,
        row: es.row ?? dr.row, rowStep: es.rowStep ?? dr.rowStep, rowCount: es.rowCount ?? dr.rowCount,
        mirrorX: es.mirrorX ?? dr.mirrorX, mirrorY: es.mirrorY ?? dr.mirrorY,
        pitchEnabled: es.pitchEnabled ?? dr.pitchEnabled, pitchStep: es.pitchStep ?? dr.pitchStep,
        baseFixed: es.baseFixed ?? dr.baseFixed, mirrorMinAlong: es.mirrorMinAlong,
        hardwareId: hp.id,
      })
    }
  }
  // Генератор добавления линий разметки (кол-во, проём, отступы — общий для полки/стойки/царги)
  const [genType, setGenType] = useState(null)
  const [genCount, setGenCount] = useState(1)
  const [genOpeningIdx, setGenOpeningIdx] = useState(0)
  const [genThickness, setGenThickness] = useState(16)
  const [genInsetA, setGenInsetA] = useState(0)
  const [genInsetB, setGenInsetB] = useState(0)
  const [genPosRef, setGenPosRef] = useState('bottom')
  const [genPos, setGenPos] = useState(0)
  const layoutItemRefs = useRef({})

  useEffect(() => {
    if (highlightLayoutIdx === null) return
    const el = layoutItemRefs.current[highlightLayoutIdx]
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    const t = setTimeout(() => setHighlightLayoutIdx(null), 2200)
    return () => clearTimeout(t)
  }, [highlightLayoutIdx])

  // Применить дугу: точки [i, cp, j] — cp становится контрольной точкой
  const applyArc = (pts) => {
    if (pts.length < 3) return
    const verts = [...getActiveVerts()]
    // Все средние точки (не первая и не последняя) помечаем как arc
    for (let k = 1; k < pts.length - 1; k++) {
      verts[pts[k]] = { ...verts[pts[k]], type: 'arc' }
    }
    setActiveVerts(verts)
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

  // Переместить точку по X/Y с ограничением внутри детали
  const moveVertex = (idx, dx, dy) => {
    const verts = [...getActiveVerts()]
    // Ширина(X) детали — горизонталь канваса, Длина(Y) — вертикаль (мебельный стандарт)
    const w = Number(detail.h) || 0
    const h = Number(detail.w) || 0
    const newX = Math.max(0, Math.min(w, verts[idx].x + dx))
    const newY = Math.max(0, Math.min(h, verts[idx].y + dy))
    verts[idx] = { ...verts[idx], x: newX, y: newY }
    setActiveVerts(verts)
  }

  // Переместить точку вдоль соседнего отрезка
  const moveAlongEdge = (idx, edge, step) => {
    const verts = getActiveVerts()
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
    const verts = [...getActiveVerts()]
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

  const [history, setHistory] = useState([])

  const upd = (patch) => {
    // Сохраняем текущее состояние в историю
    setHistory(h => [...h.slice(-19), contour])
    onUpdate({ ...detail, contour: { ...contour, ...patch } })
  }

  const undo = () => {
    if (history.length === 0) return
    const prev = history[history.length - 1]
    setHistory(h => h.slice(0, -1))
    onUpdate({ ...detail, contour: prev })
    setActiveIdx(null)
    setMenuSelType(null)
    setPreviewVerts(null)
  }

  const setVertices = (verts) => upd({ vertices: verts })

  // Установить вершины для выреза
  const setHoleVertices = (holeIdx, verts) => {
    const holes = [...contour.holes]
    holes[holeIdx] = { ...holes[holeIdx], vertices: verts, _verticesEdited: true }
    upd({ holes })
  }

  const handleTap = (idx, holeIdx = null) => {
    if (idx === null) {
      if (!arcMode) {
        setActiveIdx(null); setMenuSelType(null); setPreviewVerts(null)
        // Не сбрасываем activeHoleIdx — пользователь остаётся в режиме выреза
      }
      return
    }
    if (arcMode) {
      // Фиксируем контекст (контур или конкретный вырез) по первой выбранной точке —
      // нельзя мешать точки из разных наборов вершин в одну дугу
      if (arcPoints.length === 0) {
        setActiveHoleIdx(holeIdx)
      } else if (holeIdx !== activeHoleIdx) {
        return // точка из другого контекста — игнорируем
      }
      if (arcPoints.includes(idx)) return
      setArcPoints(pts => [...pts, idx])
      return
    }
    // Если тапнули по точке выреза — переключаемся на этот вырез
    if (holeIdx !== null) setActiveHoleIdx(holeIdx)
    else setActiveHoleIdx(null)
    setActiveIdx(idx)
    setMenuSelType(null)
    setPreviewVerts(null)
    setArcMode(false)
    setArcPoints([])
    if (holeIdx === null) setTab('contour')
  }

  // Получить/установить активные вершины (контур или вырез)
  const getActiveVerts = () => {
    if (activeHoleIdx !== null && contour.holes?.[activeHoleIdx]?.vertices) {
      return contour.holes[activeHoleIdx].vertices
    }
    return contour.vertices || []
  }
  const setActiveVerts = (verts) => activeHoleIdx !== null
    ? setHoleVertices(activeHoleIdx, verts)
    : setVertices(verts)

  // Вершина: изменить
  const updateVertex = (idx, newV) => {
    const verts = [...getActiveVerts()]
    verts[idx] = newV
    setActiveVerts(verts)
  }

  // Применить тип угла к точке
  const applyCornerType = (idx, type, params = {}) => {
    const verts = [...getActiveVerts()]
    const n = verts.length
    const curr = verts[idx]
    console.log('applyCornerType', idx, type, params, 'curr:', curr, 'n:', n)
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
      // Если это была fillet-группа — удаляем fillet точки
      const newVerts = verts.filter((v,vi) => {
        if (vi === idx) return false // удаляем саму точку если она fillet
        return true
      })
      // Просто сбрасываем r
      verts[idx] = { ...curr, r: 0, type: 'point' }
      setActiveVerts(verts); setActiveIdx(idx)
    } else if (type === 'radius') {
      const r = params.r || 50
      const isArcNext = next.type === 'arc'
      const isArcPrev = prev.type === 'arc'

      if (isArcNext || isArcPrev) {
        // Стык прямой и дуги — вычисляем fillet геометрически
        const arcIdx = isArcNext ? (idx+1)%n : (idx-1+n)%n

        // Находим arc-группу и её центр
        let si=arcIdx; while(verts[(si-1+n)%n]?.type==='arc') si=(si-1+n)%n
        let ei=arcIdx; while(verts[(ei+1)%n]?.type==='arc') ei=(ei+1)%n
        const p1=verts[(si-1+n)%n], pm=verts[si], p3=verts[(ei+1)%n]

        const D=2*(p1.x*(pm.y-p3.y)+pm.x*(p3.y-p1.y)+p3.x*(p1.y-pm.y))
        if(Math.abs(D)<0.001){ verts[idx]={...curr,r}; setActiveVerts(verts); return }

        const arcCx=((p1.x*p1.x+p1.y*p1.y)*(pm.y-p3.y)+(pm.x*pm.x+pm.y*pm.y)*(p3.y-p1.y)+(p3.x*p3.x+p3.y*p3.y)*(p1.y-pm.y))/D
        const arcCy=((p1.x*p1.x+p1.y*p1.y)*(p3.x-pm.x)+(pm.x*pm.x+pm.y*pm.y)*(p1.x-p3.x)+(p3.x*p3.x+p3.y*p3.y)*(pm.x-p1.x))/D
        const arcR=Math.hypot(curr.x-arcCx, curr.y-arcCy)

        const linePt = isArcNext ? prev : next
        const ld=Math.hypot(curr.x-linePt.x,curr.y-linePt.y)
        if(ld===0){ verts[idx]={...curr,r}; setActiveVerts(verts); return }
        const ldx=(curr.x-linePt.x)/ld, ldy=(curr.y-linePt.y)/ld
        const dirX = isArcNext ? ldx : -ldx
        const dirY = isArcNext ? ldy : -ldy

        let best=null, bestScore=Infinity
        for(const norm of [{x:-dirY,y:dirX},{x:dirY,y:-dirX}]){
          const ox2=curr.x+norm.x*r-arcCx, oy2=curr.y+norm.y*r-arcCy
          const B=2*(ox2*dirX+oy2*dirY)
          const C2=ox2*ox2+oy2*oy2-(arcR-r)*(arcR-r)
          const disc=B*B-4*C2
          if(disc<0)continue
          for(const sign of[1,-1]){
            const t=(-B+sign*Math.sqrt(disc))/2
            const fx=curr.x+norm.x*r+t*dirX, fy=curr.y+norm.y*r+t*dirY
            const tp_t=(fx-curr.x)*dirX+(fy-curr.y)*dirY
            const tpx=curr.x+tp_t*dirX, tpy=curr.y+tp_t*dirY
            const adx=fx-arcCx, ady=fy-arcCy, ad=Math.hypot(adx,ady)
            const tax=arcCx+adx/ad*arcR, tay=arcCy+ady/ad*arcR
            const score=Math.hypot(tax-curr.x,tay-curr.y)
            const tpCheck=(fx-curr.x)*dirX+(fy-curr.y)*dirY
            if(tpCheck<0 && score<bestScore){
              bestScore=score
              best={fx,fy,tpx,tpy,tax,tay}
            }
          }
        }

        if(!best){ verts[idx]={...curr,r}; setActiveVerts(verts); return }

        const a0=Math.atan2(best.tpy-best.fy,best.tpx-best.fx)
        const a1=Math.atan2(best.tay-best.fy,best.tax-best.fx)
        const midAngle0 = (a0+a1)/2
        const mx0 = best.fx + r*Math.cos(midAngle0), my0 = best.fy + r*Math.sin(midAngle0)
        const mx1 = best.fx + r*Math.cos(midAngle0+Math.PI), my1 = best.fy + r*Math.sin(midAngle0+Math.PI)
        const fccw = Math.hypot(mx0-curr.x,my0-curr.y) > Math.hypot(mx1-curr.x,my1-curr.y) ? false : true

        const tpPt = { x:best.tpx, y:best.tpy, r:0, type:'point' }
        const filletPt = {
          x:(best.tpx+best.tax)/2, y:(best.tpy+best.tay)/2,
          r:0, type:'fillet',
          fcx:best.fx, fcy:best.fy, fr:r,
          fa0:a0, fa1:a1, fccw
        }
        const taPt = { x:best.tax, y:best.tay, r:0, type:'point' }

        if(isArcNext){
          verts.splice(idx, 1, tpPt, filletPt, taPt)
        } else {
          verts.splice(idx, 1, taPt, filletPt, tpPt)
        }
        setActiveVerts(verts); setActiveIdx(null)

      } else {
        // Две прямые — просто ставим r на вершину (buildPath использует arcTo)
        verts[idx] = { ...curr, r }
        setActiveVerts(verts); setActiveIdx(idx)
      }
    } else if (type === 'concave') {
      verts[idx] = { ...curr, r: -(params.r || 50) }
      setActiveVerts(verts); setActiveIdx(idx)
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
      setActiveVerts(verts); setActiveIdx(null)
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
      setActiveVerts(verts); setActiveIdx(null)
    }
  }
  const insertVertex = (idx, after = false) => {
    const verts = getActiveVerts()
    const n = verts.length
    const i = after ? idx : (idx - 1 + n) % n
    const j = (i + 1) % n
    const a = verts[i], b = verts[j]
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, r: 0 }
    const newVerts = [...verts]
    newVerts.splice(after ? idx + 1 : idx, 0, mid)
    setActiveVerts(newVerts)
    setActiveIdx(after ? idx + 1 : idx)
  }

  // Удалить точку
  const deleteVertex = (idx) => {
    const verts = getActiveVerts().filter((_, i) => i !== idx)
    setActiveVerts(verts)
    setActiveIdx(null)
  }

  // Holes
  const addHole = (type) => {
    const base = { type, sides: [], offsets: {} }
    // Ширина(X) детали — горизонталь канваса, Длина(Y) — вертикаль (мебельный стандарт)
    const w = Number(detail.h) || 0
    const h = Number(detail.w) || 0
    if (type === 'circle') {
      upd({ holes: [...contour.holes, { ...base, d: 100 }] })
    } else {
      const hw = 200, hh = 100
      const newHole = { ...base, hw, hh }
      // Сразу создаём vertices
      newHole.vertices = holeToVertices(newHole, w, h)
      upd({ holes: [...contour.holes, newHole] })
    }
    setOpenHoleCardIdx(contour.holes.length) // новый вырез добавляется в конец — он и открыт
  }
  const updHole = (i, patch) => {
    const holes = [...contour.holes]
    const updated = { ...holes[i], ...patch }
    // Пересчитываем vertices для прямоугольного выреза
    if (updated.type !== 'circle') {
      // Ширина(X) детали — горизонталь канваса, Длина(Y) — вертикаль (мебельный стандарт)
      const w = Number(detail.h) || 0
      const h = Number(detail.w) || 0
      // Сохраняем пользовательские точки если они были отредактированы вручную
      if (!updated._verticesEdited) {
        updated.vertices = holeToVertices(updated, w, h)
      }
    }
    holes[i] = updated
    upd({ holes })
  }

  // Grooves
  const addGroove = () => {
    upd({ grooves: [...contour.grooves, { dir:'horizontal', length:100, width:8, depth:10, sides:[], offsets:{} }] })
    setOpenGrooveCardIdx(contour.grooves.length)
  }
  const updGroove = (i, patch) => {
    const gs = [...contour.grooves]
    gs[i] = { ...gs[i], ...patch }
    upd({ grooves: gs })
  }

  // Присадка (сверление)
  const makeDrillId = () => 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2,6)
  const addDrilling = (kind) => {
    const id = makeDrillId()
    if (kind === 'face') {
      upd({ drillings: [{
        id,
        kind: 'face', face: 'front', d: 8, depth: 13,
        sides: [], offsets: {}, attachTo: [],
        row: false, rowDir: 'x', rowStep: 32, rowCount: 2,
      }, ...contour.drillings] })
    } else {
      upd({ drillings: [{
        id,
        kind: 'edge', edgeSide: 'left', alongFrom: 'start',
        offsetAlong: 50, offsetFace: defaultThickness / 2, d: 5, depth: 35,
        row: false, rowStep: 32, rowCount: 2,
      }, ...contour.drillings] })
    }
    setOpenDrillId(id) // новая карточка открыта, остальные автоматически сворачиваются
  }
  const updDrilling = (i, patch) => {
    const ds = [...contour.drillings]
    ds[i] = { ...ds[i], ...patch }
    upd({ drillings: ds })
  }
  const duplicateDrilling = (i) => {
    const id = makeDrillId()
    upd({ drillings: [{ ...contour.drillings[i], id }, ...contour.drillings] })
    setOpenDrillId(id)
  }

  // Разместить присадку нажатием на детали (визуально, без ввода цифр)
  const handlePlaceDrillTap = (x, y) => {
    if (placeDrillIdx === null) return
    const dr = contour.drillings[placeDrillIdx]
    if (!dr) { setPlaceDrillIdx(null); return }
    if (dr.kind === 'edge') {
      const distLeft = x, distRight = w - x, distBottom = y, distTop = h - y
      const minD = Math.min(distLeft, distRight, distBottom, distTop)
      let edgeSide, alongCenter
      if (minD === distLeft) { edgeSide = 'left'; alongCenter = y }
      else if (minD === distRight) { edgeSide = 'right'; alongCenter = y }
      else if (minD === distBottom) { edgeSide = 'bottom'; alongCenter = x }
      else { edgeSide = 'top'; alongCenter = x }
      // offsetAlong хранится как расстояние до ЦЕНТРА отверстия (от начала)
      updDrilling(placeDrillIdx, { edgeSide, alongFrom: 'start', offsetAlong: Math.max(0, Math.round(alongCenter)) })
    } else {
      // offsets хранится как расстояние до ЦЕНТРА отверстия
      const sideX = x <= w / 2 ? 'left' : 'right'
      const sideY = y <= h / 2 ? 'bottom' : 'top'
      const offX = sideX === 'left' ? Math.max(0, x) : Math.max(0, w - x)
      const offY = sideY === 'bottom' ? Math.max(0, y) : Math.max(0, h - y)
      updDrilling(placeDrillIdx, { sides: [sideX, sideY], offsets: { [sideX]: Math.round(offX), [sideY]: Math.round(offY) } })
    }
    setPlaceDrillIdx(null)
  }

  // Разметка (полки/стойки/царги)

  // Обёртка над upd для массива разметки — сразу пересчитывает положения блоков
  // (несколько полок, поставленных одним действием) от их текущих границ
  const updateLayoutArray = (newArr) => upd({ layout: resolveEffectiveLayout(newArr, w, h) })

  // Найти свободные проёмы вдоль оси данного типа разметки.
  // Границы проёмов определяют только НЕЗАВИСИМЫЕ полки/стойки (не входящие в блок) —
  // блок сам занимает один проём целиком и не дробит его для других блоков.
  const computeOpenings = (kind) => {
    const isUpright = kind === 'upright'
    const total = isUpright ? w : h
    const same = contour.layout.filter(g => (g.kind==='upright') === isUpright && !g.blockId).sort((a,b)=>(a.pos||0)-(b.pos||0))
    const openings = []
    let prevEdge = 0
    let prevGuideId = null
    for (const g of same) {
      if ((g.pos||0) - prevEdge > 1) openings.push({ start: prevEdge, end: g.pos||0, startRef: prevGuideId ? { guideId: prevGuideId, edge: 'far' } : { value: 0 }, endRef: { guideId: g.id, edge: 'near' } })
      prevEdge = (g.pos||0) + (g.thickness||18)
      prevGuideId = g.id
    }
    if (total - prevEdge > 1) openings.push({ start: prevEdge, end: total, startRef: prevGuideId ? { guideId: prevGuideId, edge: 'far' } : { value: 0 }, endRef: { value: total } })
    return openings.length ? openings : [{ start: 0, end: total, startRef: { value: 0 }, endRef: { value: total } }]
  }

  // Открыть генератор для конкретного типа (полка/стойка/царга)
  const openLayoutGenerator = (kind) => {
    const openings = computeOpenings(kind)
    const opIdx = openings.length - 1
    const op = openings[opIdx]
    const th = defaultThickness
    setGenType(kind)
    setGenCount(1)
    setGenOpeningIdx(opIdx)
    setGenThickness(th)
    setGenInsetA(0); setGenInsetB(0)
    setGenPosRef(kind === 'upright' ? 'left' : 'bottom')
    setGenPos(Math.max(0, Math.round((op.end - op.start) / 2 - th / 2)))
  }

  // Подтвердить генератор — создать одну или несколько линий в выбранном проёме
  const commitLayoutGenerator = () => {
    const kind = genType
    if (!kind) return
    const isUpright = kind === 'upright'
    const total = isUpright ? w : h
    const openings = computeOpenings(kind)
    const op = openings[genOpeningIdx] || openings[0]
    const thickness = Number(genThickness) || defaultThickness
    const n = Math.max(1, Math.round(genCount) || 1)
    const newGuides = []
    const mkBase = (pos) => {
      const id = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2,5) + Math.round(Math.random()*999)
      const base = { id, kind, pos: Math.round(pos), thickness }
      return isUpright
        ? { ...base, insetBottom: Number(genInsetA)||0, insetTop: Number(genInsetB)||0 }
        : { ...base, insetLeft: Number(genInsetA)||0, insetRight: Number(genInsetB)||0 }
    }
    if (n === 1) {
      let pos = (genPosRef === 'top' || genPosRef === 'right')
        ? op.end - (Number(genPos)||0) - thickness
        : op.start + (Number(genPos)||0)
      pos = Math.max(op.start, Math.min(op.end - thickness, pos))
      newGuides.push(mkBase(pos))
    } else {
      // Несколько линий одним действием — это БЛОК: запоминаем ссылки на границы
      // занимаемого проёма (край детали или конкретная независимая полка), чтобы
      // при изменении этой границы блок пересчитал равные проёмы заново.
      const blockId = 'blk' + Date.now().toString(36) + Math.random().toString(36).slice(2,5)
      const span = op.end - op.start
      const openSpan = Math.max(0, span - thickness * n)
      const step = openSpan / (n + 1)
      let cursor = op.start
      for (let k = 1; k <= n; k++) {
        const pos = cursor + step
        const g = mkBase(pos)
        newGuides.push({ ...g, blockId, blockIndex: k - 1, blockStartRef: op.startRef, blockEndRef: op.endRef })
        cursor = pos + thickness
      }
    }
    updateLayoutArray([...newGuides, ...contour.layout])
    setOpenLayoutId(newGuides[0]?.id ?? null) // новая карточка(и) открыта, остальные сворачиваются
    setGenType(null)
  }
  const updLayout = (i, patch) => {
    const ls = [...contour.layout]
    const target = ls[i]
    const sharedKeys = ['thickness','insetLeft','insetRight','insetBottom','insetTop']
    const isShared = target?.blockId && Object.keys(patch).some(k => sharedKeys.includes(k))
    if (isShared) {
      for (let j = 0; j < ls.length; j++) {
        if (ls[j].blockId === target.blockId) ls[j] = { ...ls[j], ...patch }
      }
    } else {
      ls[i] = { ...ls[i], ...patch }
    }
    updateLayoutArray(ls)
  }
  const removeLayout = (i) => {
    updateLayoutArray(contour.layout.filter((_,j) => j !== i))
  }

  // Разместить линию разметки нажатием на детали
  const handlePlaceLayoutTap = (x, y) => {
    if (placeLayoutIdx === null) return
    const g = contour.layout[placeLayoutIdx]
    if (!g) { setPlaceLayoutIdx(null); return }
    const thickness = g.thickness || 18
    if (g.kind === 'upright') {
      updLayout(placeLayoutIdx, { pos: Math.max(0, Math.round(x - thickness/2)) })
    } else {
      updLayout(placeLayoutIdx, { pos: Math.max(0, Math.round(y - thickness/2)) })
    }
    setPlaceLayoutIdx(null)
  }

  // Нажатие на саму полосу разметки в превью — переходим к её редактированию
  const handleLayoutBandTap = (i) => {
    setTab('layout')
    setActiveIdx(null)
    setActiveHoleIdx(null)
    setHighlightLayoutIdx(i)
  }

  const hasContour = contour.vertices.length > 4 ||
    contour.vertices.some(v => v.r > 0) ||
    contour.holes.length > 0 || contour.grooves.length > 0 || contour.drillings.length > 0

  const activeVertex = activeIdx !== null ? getActiveVerts()[activeIdx] : null

  return (
    <div className={onClose ? 'page' : undefined} style={onClose ? { paddingBottom: 40 } : { marginTop:10, borderTop:'0.5px solid var(--border)', paddingTop:10 }}>

      {/* Шапка с кнопкой "Готово" — только когда редактор открыт на весь экран (из EditOrderPage) */}
      {onClose && (
        <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:16, paddingTop:8 }}>
          <button type="button" onClick={onClose}
            style={{ background:'none', border:'none', color:'var(--blue)', fontSize:22, padding:0, lineHeight:1, cursor:'pointer' }}>←</button>
          <h1 style={{ fontSize:16, fontWeight:500, flex:1 }}>Контур детали</h1>
          <button type="button" onClick={onClose}
            style={{ padding:'7px 16px', fontSize:13, border:'none', borderRadius:'var(--radius)',
              background:'var(--blue)', color:'white', cursor:'pointer', whiteSpace:'nowrap' }}>
            Готово
          </button>
        </div>
      )}

      {/* Кнопка отката */}
      {history.length > 0 && (
        <button type="button" onClick={undo}
          style={{ marginBottom:6, padding:'4px 10px', fontSize:11, border:'0.5px solid var(--border-md)',
            borderRadius:'var(--radius)', background:'transparent', color:'var(--text-muted)', cursor:'pointer' }}>
          ↩ Отменить
        </button>
      )}

      {/* Canvas + кнопки типа рядом */}
      {w > 0 && h > 0 && (
        <>
          {/* Подсказка pinch-zoom — масштабируется только сама деталь в превью, щипком двух пальцев */}
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:6, gap:6 }}>
            <span style={{ fontSize:10, color:'var(--text-hint)', flex:1 }}>🤏 Щипком двух пальцев — масштаб детали</span>
            <button type="button" onClick={() => setRotation(r => (r + 90) % 360)}
              title="Повернуть превью на 90°"
              style={{ fontSize:11, padding:'4px 9px', border: rotation ? '1px solid var(--blue)' : '0.5px solid var(--border-md)',
                borderRadius:6, background: rotation ? 'var(--blue-light)' : 'transparent',
                color: rotation ? 'var(--blue-dark)' : 'var(--text-muted)', cursor:'pointer', flexShrink:0 }}>
              ⟳ {rotation}°
            </button>
            {Math.abs(zoom-1) > 0.02 && (
              <button type="button" onClick={() => setZoom(1)}
                style={{ fontSize:10, padding:'3px 7px', border:'0.5px solid var(--border-md)', borderRadius:6,
                  background:'transparent', color:'var(--text-muted)', cursor:'pointer', flexShrink:0 }}>
                {Math.round(zoom*100)}% · сброс
              </button>
            )}
          </div>
        <div style={{ display:'flex', gap:4, marginBottom:8, alignItems:'flex-start' }}>

          {/* Список точек слева */}
          <div style={{ display:'flex', flexDirection:'column', gap:2, maxHeight:280, overflowY:'auto' }}>
            <span style={{ fontSize:8, color:'var(--text-hint)', textAlign:'center', marginBottom:1 }}>№</span>
            {(activeHoleIdx !== null && contour.holes[activeHoleIdx]?.vertices
              ? contour.holes[activeHoleIdx].vertices
              : getActiveVerts()
            ).map((v, i) => {
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
            {!arcMode && !activeVertex && placeDrillIdx === null && placeLayoutIdx === null && (
              <p style={{ fontSize:10, color:'var(--text-hint)', textAlign:'center', marginBottom:2 }}>
                Нажми на точку
              </p>
            )}
            {placeDrillIdx !== null && (
              <p style={{ fontSize:11, color:'#0E8A6D', fontWeight:500, textAlign:'center', marginBottom:2 }}>
                👆 Нажми на детали, куда поставить отверстие
              </p>
            )}
            {placeLayoutIdx !== null && (
              <p style={{ fontSize:11, color:'#8B5E2A', fontWeight:500, textAlign:'center', marginBottom:2 }}>
                👆 Нажми на детали, где будет линия
              </p>
            )}
            <ContourCanvas detail={detail} contour={contour} activeIdx={activeHoleIdx!==null ? activeIdx : activeIdx}
              arcMode={arcMode} arcPoints={arcPoints}
              previewVerts={previewVerts}
              activeHoleIdx={activeHoleIdx}
              onTap={handleTap}
              placeMode={placeDrillIdx !== null || placeLayoutIdx !== null}
              onPlaceTap={placeLayoutIdx !== null ? handlePlaceLayoutTap : handlePlaceDrillTap}
              showMarkers={showMarkers} showLengths={showLengths} showAngles={showAngles} showDrillDims={showDrillDims}
              materialThickness={defaultThickness}
              zoom={zoom} onZoomChange={setZoom} onLayoutTap={handleLayoutBandTap} highlightLayoutIdx={highlightLayoutIdx}
              rotation={rotation} />
          </div>

          {/* Правая колонка — всегда toggles + кнопки типа если точка выбрана */}
          <div style={{ display:'flex', flexDirection:'column', gap:2 }}>
            {/* Toggles — всегда */}
            {[
              { key:'markers', icon:'●', val:showMarkers, set:setShowMarkers },
              { key:'lengths', icon:'↔', val:showLengths, set:setShowLengths },
              { key:'angles',  icon:'∠', val:showAngles,  set:setShowAngles },
              { key:'drilldims', icon:'⌾', val:showDrillDims, set:setShowDrillDims },
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
                  { id:'radius',  icon:<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 2 L2 9 Q2 12 5 12 L12 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><path d="M5 9.5 L4.5 12 L7 11.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg> },
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
                      if (id === 'none') {
                        applyCornerType(activeIdx, id, { r: menuR, dx: menuDx, dy: menuDy })
                        setPreviewVerts(null)
                      } else if (id === 'radius') {
                        applyCornerType(activeIdx, 'radius', { r: menuR })
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
        </>
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
            <div>
              <NumField label="Радиус R" value={menuR} onChange={v => {
                setMenuR(v)
                applyCornerType(activeIdx, 'radius', { r: v })
                setPreviewVerts(null)
              }} />
              {/* Кнопка Flip если рядом есть fillet точка */}
              {(() => {
                if (!activeVertex) return null
                const n = contour.vertices.length
                const hasFilletNear = [1,-1,2,-2].some(di =>
                  contour.vertices[(activeIdx+di+n)%n]?.type==='fillet'
                )
                if (!hasFilletNear) return null
                return (
                  <button type="button" onClick={() => {
                    const verts=[...contour.vertices]
                    const n=verts.length
                    for(const di of [1,-1,2,-2]){
                      const fi=(activeIdx+di+n)%n
                      if(verts[fi]?.type==='fillet'){
                        verts[fi]={...verts[fi], fccw:!verts[fi].fccw}
                        setActiveVerts(verts)
                        break
                      }
                    }
                  }} style={{marginTop:8,width:'100%',padding:'7px',border:'0.5px solid var(--border-md)',
                    borderRadius:'var(--radius)',background:'transparent',fontSize:12,cursor:'pointer'}}>
                    ⇄ Выбрать другой отрезок
                  </button>
                )
              })()}
            </div>
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
        {[['contour','Контур'],['holes','Вырезы'],['grooves','Пазы'],['layout','Разметка'],['drilling','Присадка']].map(([id,label])=>(
          <button key={id} type="button" onClick={()=>{
            setTab(id)
            if(id!=='contour') { setActiveIdx(null) }
            if(id!=='holes') setActiveHoleIdx(null)
            if(id!=='drilling') setPlaceDrillIdx(null)
            if(id!=='layout') setPlaceLayoutIdx(null)
          }}
            style={{ flex:1, padding:'6px 2px', border:'none', borderRadius:6, fontSize:10.5,
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
              open={openHoleCardIdx === i}
              onToggleOpen={() => setOpenHoleCardIdx(openHoleCardIdx === i ? null : i)}
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
            <CollapsibleItem key={i}
              open={openGrooveCardIdx === i}
              onToggleOpen={() => setOpenGrooveCardIdx(openGrooveCardIdx === i ? null : i)}
              title={`Паз #${i+1}`}
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

      {/* РАЗМЕТКА — полки, стойки, царги как визуальные ориентиры */}
      {tab==='layout' && (
        <div>
          <p style={{ fontSize:10.5, color:'var(--text-hint)', margin:'0 0 6px' }}>
            Отметь, где будут полки, стойки и царги — потом присадку по плоскости можно привязать прямо к этим линиям.
          </p>
          <div style={{ display:'flex', gap:4, marginBottom:5, flexWrap:'wrap' }}>
            <button type="button" onClick={() => openLayoutGenerator('shelf')}
              style={{ flex:1, padding:'6px', border: genType==='shelf' ? '1px solid var(--blue)' : '0.5px dashed var(--border-md)',
                borderRadius:'var(--radius)', background: genType==='shelf' ? 'var(--blue-light)' : 'transparent',
                fontSize:12, color:'var(--text-muted)', cursor:'pointer' }}>
              + Полка
            </button>
            <button type="button" onClick={() => openLayoutGenerator('upright')}
              style={{ flex:1, padding:'6px', border: genType==='upright' ? '1px solid var(--blue)' : '0.5px dashed var(--border-md)',
                borderRadius:'var(--radius)', background: genType==='upright' ? 'var(--blue-light)' : 'transparent',
                fontSize:12, color:'var(--text-muted)', cursor:'pointer' }}>
              + Стойка
            </button>
            <button type="button" onClick={() => openLayoutGenerator('rail')}
              style={{ flex:1, padding:'6px', border: genType==='rail' ? '1px solid var(--blue)' : '0.5px dashed var(--border-md)',
                borderRadius:'var(--radius)', background: genType==='rail' ? 'var(--blue-light)' : 'transparent',
                fontSize:12, color:'var(--text-muted)', cursor:'pointer' }}>
              + Царга
            </button>
          </div>

          {/* Генератор — общий для полки/стойки/царги: количество, проём, отступы */}
          {genType && (() => {
            const isUpright = genType === 'upright'
            const openings = computeOpenings(genType)
            const op = openings[genOpeningIdx] || openings[0]
            const label = genType==='upright' ? 'стойки' : genType==='rail' ? 'царги' : 'полки'
            return (
              <div style={{ padding:7, marginBottom:6, background:'var(--bg2)', borderRadius:'var(--radius)',
                border:'1px solid var(--blue)' }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:5 }}>
                  <strong style={{ fontSize:12.5 }}>Добавить {label}</strong>
                  <button type="button" onClick={() => setGenType(null)}
                    style={{ background:'none', border:'none', color:'var(--text-hint)', fontSize:15, cursor:'pointer', padding:0 }}>✕</button>
                </div>

                <div style={{ display:'flex', gap:5, marginBottom:5 }}>
                  <NumField label="Количество" value={genCount} onChange={v=>setGenCount(Math.max(1,Math.round(v)))} />
                  <NumField label="Толщина материала" value={genThickness} onChange={setGenThickness} />
                </div>

                {openings.length > 1 && (
                  <>
                    <label style={{ fontSize:10, color:'var(--text-hint)', display:'block', marginBottom:3 }}>В каком проёме размещаем</label>
                    <div style={{ display:'flex', gap:3, flexWrap:'wrap', marginBottom:5 }}>
                      {openings.map((o, oi) => (
                        <button key={oi} type="button" onClick={() => setGenOpeningIdx(oi)}
                          style={{ padding:'4px 9px', borderRadius:20, fontSize:11, border:'none',
                            background: genOpeningIdx===oi ? 'var(--blue)' : 'var(--bg3)',
                            color: genOpeningIdx===oi ? 'white' : 'var(--text-muted)', cursor:'pointer' }}>
                          {Math.round(o.end - o.start)}мм
                        </button>
                      ))}
                    </div>
                  </>
                )}

                {genCount === 1 ? (
                  <>
                    <label style={{ fontSize:10, color:'var(--text-hint)', display:'block', marginBottom:3 }}>Отступ внутри проёма от</label>
                    <div style={{ display:'flex', gap:3, marginBottom:5 }}>
                      {(isUpright ? [['left','Левого края'],['right','Правого края']] : [['bottom','Низа'],['top','Верха']]).map(([id,lb])=>(
                        <button key={id} type="button" onClick={() => setGenPosRef(id)}
                          style={{ flex:1, padding:'5px 3px', borderRadius:'var(--radius)', border:'none', fontSize:11,
                            background: genPosRef===id?'var(--blue)':'var(--bg3)',
                            color: genPosRef===id?'white':'var(--text-muted)', cursor:'pointer' }}>
                            {lb}
                          </button>
                      ))}
                    </div>
                    <NumField label="Расстояние" value={genPos} onChange={setGenPos} />
                  </>
                ) : (
                  <p style={{ fontSize:11, color:'var(--text-hint)', margin:'0 0 5px' }}>
                    {genCount} шт. разместятся равномерно внутри выбранного проёма.
                  </p>
                )}

                <label style={{ fontSize:10, color:'var(--text-hint)', display:'block', margin:'5px 0 3px' }}>
                  Отступ от края контура (если не на всю {isUpright ? 'высоту' : 'ширину'})
                </label>
                <div style={{ display:'flex', gap:5, marginBottom:7 }}>
                  <NumField label={isUpright?'Снизу':'Слева'} value={genInsetA} onChange={setGenInsetA} />
                  <NumField label={isUpright?'Сверху':'Справа'} value={genInsetB} onChange={setGenInsetB} />
                </div>

                <button type="button" onClick={commitLayoutGenerator}
                  style={{ width:'100%', padding:'7px', border:'none', borderRadius:'var(--radius)',
                    background:'var(--blue)', color:'white', fontSize:12.5, fontWeight:500, cursor:'pointer' }}>
                  Добавить
                </button>
              </div>
            )
          })()}

          {!contour.layout.length && <p style={{ fontSize:12, color:'var(--text-hint)', textAlign:'center' }}>Нет линий разметки</p>}
          {contour.layout.map((g, i) => {
            const isUpright = g.kind === 'upright'
            const total = isUpright ? w : h
            const posFrom = g.posFrom || (isUpright ? 'left' : 'bottom')
            const isFar = posFrom === 'top' || posFrom === 'right'
            const displayPos = isFar ? Math.round(total - (g.pos||0) - (g.thickness||18)) : Math.round(g.pos||0)
            const setDisplayPos = (v) => {
              const newPos = isFar ? (total - v - (g.thickness||18)) : v
              updLayout(i, { pos: Math.max(0, Math.round(newPos)) })
            }
            // Номер по физическому порядку от начала детали (0,0 — левый нижний угол),
            // а не по порядку создания — иначе номера скачут при добавлении новых линий
            const sameKind = contour.layout.filter(x => x.kind === g.kind).sort((a,b)=>(a.pos||0)-(b.pos||0))
            const orderNum = sameKind.findIndex(x => x.id === g.id) + 1
            const blockSiblings = g.blockId ? contour.layout.filter(x => x.blockId === g.blockId) : []
            return (
            <CollapsibleItem key={g.id}
              innerRef={el => { layoutItemRefs.current[i] = el }}
              highlighted={highlightLayoutIdx === i}
              open={openLayoutId === g.id}
              onToggleOpen={() => setOpenLayoutId(openLayoutId === g.id ? null : g.id)}
              title={`${g.kind==='upright'?'▏ Стойка':g.kind==='rail'?'▬ Царга':'▭ Полка'} #${orderNum} · ${Math.round(g.pos||0)}мм${g.blockId?' 🔗':''}`}
              onRemove={() => removeLayout(i)}>

              {g.blockId && (
                <div style={{ padding:'6px 8px', marginBottom:6, background:'rgba(139,94,42,0.1)', borderRadius:'var(--radius)' }}>
                  <p style={{ fontSize:10.5, color:'#8B5E2A', margin:'0 0 4px' }}>
                    🔗 Часть блока из {blockSiblings.length} шт. Позиция пересчитывается автоматически при изменении границ проёма — вручную её задать нельзя.
                  </p>
                  <button type="button" onClick={() => {
                    const ls = contour.layout.map(x => x.id === g.id
                      ? { ...x, blockId: undefined, blockIndex: undefined, blockStartRef: undefined, blockEndRef: undefined }
                      : x)
                    updateLayoutArray(ls)
                  }} style={{ fontSize:10.5, padding:'3px 8px', border:'0.5px solid #8B5E2A', borderRadius:'var(--radius)',
                    background:'transparent', color:'#8B5E2A', cursor:'pointer' }}>
                    Отвязать от блока (сделать независимой)
                  </button>
                </div>
              )}

              <button type="button"
                onClick={() => setPlaceLayoutIdx(placeLayoutIdx === i ? null : i)}
                style={{ width:'100%', padding:'6px', marginBottom:6, borderRadius:'var(--radius)',
                  border: placeLayoutIdx === i ? '1px solid #8B5E2A' : '0.5px dashed var(--border-md)',
                  background: placeLayoutIdx === i ? 'rgba(139,94,42,0.1)' : 'transparent',
                  fontSize:11.5, color: placeLayoutIdx === i ? '#8B5E2A' : 'var(--text-muted)', cursor:'pointer',
                  opacity: g.blockId ? 0.4 : 1, pointerEvents: g.blockId ? 'none' : 'auto' }}
                disabled={!!g.blockId}>
                {placeLayoutIdx === i ? '👆 Жду нажатия на детали…' : '📍 Указать нажатием на детали'}
              </button>

              {!g.blockId && (
                <>
                  <label style={{ fontSize:10, color:'var(--text-hint)', display:'block', marginBottom:3 }}>Отсчитывать позицию от</label>
                  <div style={{ display:'flex', gap:3, marginBottom:5 }}>
                    {(isUpright ? [['left','Левого края'],['right','Правого края']] : [['bottom','Низа'],['top','Верха']]).map(([id,lb])=>(
                      <button key={id} type="button" onClick={() => updLayout(i,{posFrom:id})}
                        style={{ flex:1, padding:'5px 3px', borderRadius:'var(--radius)', border:'none', fontSize:11,
                          background: posFrom===id?'var(--blue)':'var(--bg3)',
                          color: posFrom===id?'white':'var(--text-muted)', cursor:'pointer' }}>
                          {lb}
                        </button>
                    ))}
                  </div>
                </>
              )}

              <div style={{ display:'flex', gap:5, marginBottom:6 }}>
                {!g.blockId && <NumField label="Позиция" value={displayPos} onChange={setDisplayPos} />}
                <NumField label="Толщина материала" value={g.thickness??defaultThickness} onChange={v=>updLayout(i,{thickness:v})} />
              </div>

              <label style={{ fontSize:10.5, color:'var(--text-hint)', display:'block', marginBottom:3 }}>
                Отступ от края контура (если не на всю {g.kind==='upright' ? 'высоту' : 'ширину'})
              </label>
              {g.kind === 'upright' ? (
                <div style={{ display:'flex', gap:5 }}>
                  <NumField label="Снизу" value={g.insetBottom??0} onChange={v=>updLayout(i,{insetBottom:v})} />
                  <NumField label="Сверху" value={g.insetTop??0} onChange={v=>updLayout(i,{insetTop:v})} />
                </div>
              ) : (
                <div style={{ display:'flex', gap:5 }}>
                  <NumField label="Слева" value={g.insetLeft??0} onChange={v=>updLayout(i,{insetLeft:v})} />
                  <NumField label="Справа" value={g.insetRight??0} onChange={v=>updLayout(i,{insetRight:v})} />
                </div>
              )}
            </CollapsibleItem>
            )
          })}
        </div>
      )}

      {/* ПРИСАДКА */}
      {tab==='drilling' && (
        <div>
          <div style={{ display:'flex', gap:4, marginBottom:4 }}>
            <button type="button" onClick={() => addDrilling('face')}
              style={{ flex:1, padding:'6px', border:'0.5px dashed var(--border-md)', borderRadius:'var(--radius)',
                background:'transparent', fontSize:12, color:'var(--text-muted)', cursor:'pointer' }}>
              + По плоскости
            </button>
            <button type="button" onClick={() => addDrilling('edge')}
              style={{ flex:1, padding:'6px', border:'0.5px dashed var(--border-md)', borderRadius:'var(--radius)',
                background:'transparent', fontSize:12, color:'var(--text-muted)', cursor:'pointer' }}>
              + По торцу
            </button>
          </div>
          {!contour.drillings.length && <p style={{ fontSize:12, color:'var(--text-hint)', textAlign:'center' }}>Нет присадки</p>}
          {contour.drillings.map((dr, i) => {
            const attachedIds = Array.isArray(dr.attachTo) ? dr.attachTo : (dr.attachTo ? [dr.attachTo] : [])
            const attachedGuides = attachedIds.map(id => contour.layout.find(g => g.id === id)).filter(Boolean)
            const primaryGuide = attachedGuides[0] || null
            const allowedSides = primaryGuide ? (primaryGuide.kind === 'upright' ? ['top','bottom'] : ['left','right']) : null
            return (
            <CollapsibleItem key={dr.id || i}
              open={openDrillId === (dr.id || i)}
              onToggleOpen={() => setOpenDrillId(openDrillId === (dr.id || i) ? null : (dr.id || i))}
              title={`${dr.kind==='edge' ? '⊢ По торцу' : '⊙ По плоскости'} #${i+1} · ⌀${dr.d??8}${dr.row ? ` ×${Math.max(1,Math.round(dr.rowCount||1))}` : ''}${dr.mirrorX||dr.mirrorY ? ' ⇄' : ''}${attachedGuides.length>1 ? ` ×${attachedGuides.length}линии` : ''}`}
              onRemove={() => upd({ drillings: contour.drillings.filter((_,j)=>j!==i) })}>

              {/* Копировать + Указать нажатием */}
              <div style={{ display:'flex', gap:4, marginBottom:5 }}>
                <button type="button" onClick={() => duplicateDrilling(i)}
                  style={{ flex:1, padding:'6px', borderRadius:'var(--radius)', border:'0.5px solid var(--border-md)',
                    background:'transparent', fontSize:12, color:'var(--text-muted)', cursor:'pointer' }}>
                  ⧉ Копировать
                </button>
                <button type="button"
                  onClick={() => setPlaceDrillIdx(placeDrillIdx === i ? null : i)}
                  style={{ flex:2, padding:'6px', borderRadius:'var(--radius)',
                    border: placeDrillIdx === i ? '1px solid #0E8A6D' : '0.5px dashed var(--border-md)',
                    background: placeDrillIdx === i ? 'rgba(14,138,109,0.1)' : 'transparent',
                    fontSize:12, color: placeDrillIdx === i ? '#0E8A6D' : 'var(--text-muted)', cursor:'pointer' }}>
                  {placeDrillIdx === i ? '👆 Жду нажатия…' : '📍 Указать нажатием'}
                </button>
              </div>

              {/* По плоскости */}
              {dr.kind === 'face' && (
                <>
                  <label style={{ fontSize:11, color:'var(--text-hint)', display:'block', marginBottom:4 }}>Сторона</label>
                  <div style={{ display:'flex', gap:4, marginBottom:5 }}>
                    {[['front','Лицо'],['back','Изнанка']].map(([id,label])=>(
                      <button key={id} type="button" onClick={() => updDrilling(i, { face: id })}
                        style={{ flex:1, padding:'5px 3px', borderRadius:'var(--radius)', border:'none', fontSize:11,
                          background: (dr.face||'front')===id?'var(--blue)':'var(--bg3)',
                          color: (dr.face||'front')===id?'white':'var(--text-muted)', cursor:'pointer' }}>
                        {label}
                      </button>
                    ))}
                  </div>
                  <p style={{ fontSize:10, color:'var(--text-hint)', margin:'-3px 0 6px' }}>
                    Сквозное определяется автоматически: если глубина равна толщине материала ({defaultThickness}мм) — отверстие насквозь.
                  </p>

                  {/* Фурнитура — общая база для присадки по плоскости и по торцу.
                      Выпадающий список, а не постоянный ряд бейджей — компактнее.
                      Показываются только записи, у которых ЕСТЬ параметры "для плоскости". */}
                  {hardwarePresets.some(hp => hwFaceSpec(hp)) && (
                    <div style={{ display:'flex', gap:4, marginBottom:5 }}>
                      <select value={dr.hardwareId || ''} onChange={e => {
                          const hp = hardwarePresets.find(x => x.id === e.target.value)
                          if (hp) applyHardwareToDrilling(i, dr, hp, 'face')
                        }}
                        style={{ flex:1, padding:'6px 7px', fontSize:11.5,
                          borderRadius:'var(--radius)', border:'0.5px solid var(--border-md)', background:'var(--bg2)', color:'var(--text-muted)' }}>
                        <option value="">— выбрать фурнитуру —</option>
                        {hardwarePresets.filter(hp => hwFaceSpec(hp)).map(hp => {
                          const fs = hwFaceSpec(hp)
                          return (
                            <option key={hp.id} value={hp.id}>
                              {hp.name} · Пл ⌀{fs.d}×{fs.depth}{hwEdgeSpec(hp) ? ' +Тц' : ''}
                            </option>
                          )
                        })}
                      </select>
                      {dr.hardwareId && (
                        <button type="button" onClick={() => { if (confirm('Удалить эту фурнитуру из базы совсем?')) { removeHardwarePreset(dr.hardwareId); updDrilling(i,{hardwareId:null}) } }}
                          style={{ padding:'6px 9px', fontSize:11, border:'0.5px solid var(--border-md)', borderRadius:'var(--radius)',
                            background:'transparent', color:'var(--danger)', cursor:'pointer' }}>🗑</button>
                      )}
                    </div>
                  )}
                  {savingHardwareFor === i ? (
                    <div style={{ marginBottom:5 }}>
                      <div style={{ display:'flex', gap:4, marginBottom:4 }}>
                        <input type="text" value={newHardwareName} onChange={e=>setNewHardwareName(e.target.value)}
                          placeholder="Название (Конфирмат 7х50)" autoFocus list={`hw-names-face-${i}`}
                          style={{ flex:1, fontSize:11.5, padding:'5px 7px', borderRadius:'var(--radius)', border:'0.5px solid var(--border-md)' }} />
                        <datalist id={`hw-names-face-${i}`}>
                          {hardwarePresets.map(hp => <option key={hp.id} value={hp.name} />)}
                        </datalist>
                        <button type="button" onClick={() => {
                          saveHardwareSpec(newHardwareName, 'face', {
                            d: dr.d??8, depth: dr.depth??13, faceSide: dr.face||'front',
                            sides: dr.sides||[], offsets: dr.offsets||{},
                            row: !!dr.row, rowDir: dr.rowDir||'x', rowStep: dr.rowStep??32, rowCount: dr.rowCount??2,
                            mirrorX: !!dr.mirrorX, mirrorY: !!dr.mirrorY,
                            pitchEnabled: !!dr.pitchEnabled, pitchStep: dr.pitchStep??32,
                            baseFixedX: !!dr.baseFixedX, baseFixedY: !!dr.baseFixedY,
                            mirrorMinX: dr.mirrorMinX, mirrorMinY: dr.mirrorMinY,
                            attachTo: dr.attachTo||[], gap: dr.gap??0, gapDir: dr.gapDir||'pos',
                          })
                          setSavingHardwareFor(null); setNewHardwareName('')
                        }} style={{ padding:'5px 10px', border:'none', borderRadius:'var(--radius)', background:'var(--teal)', color:'white', fontSize:11, cursor:'pointer' }}>✓</button>
                        <button type="button" onClick={() => { setSavingHardwareFor(null); setNewHardwareName('') }}
                          style={{ padding:'5px 8px', border:'0.5px solid var(--border-md)', borderRadius:'var(--radius)', background:'transparent', color:'var(--text-muted)', fontSize:11, cursor:'pointer' }}>✕</button>
                      </div>
                      <p style={{ fontSize:10, color:'var(--text-hint)', margin:0 }}>
                        Сохранится с текущей стороной («{dr.face==='front'?'Лицо':dr.face==='back'?'Изнанка':'С двух сторон'}»), диаметром и глубиной. Если фурнитура с таким названием уже есть — её часть «для плоскости» обновится, а часть «для торца» (если есть) не тронется.
                      </p>
                    </div>
                  ) : (
                    <button type="button" onClick={() => setSavingHardwareFor(i)}
                      style={{ fontSize:10.5, padding:'3px 8px', marginBottom:5, border:'0.5px dashed var(--border-md)', borderRadius:'var(--radius)',
                        background:'transparent', color:'var(--text-hint)', cursor:'pointer' }}>
                      + Сохранить как фурнитуру (для плоскости)
                    </button>
                  )}

                  <div style={{ display:'flex', gap:5, marginBottom:5 }}>
                    <NumField label="Диаметр D" value={dr.d??8} onChange={v=>updDrilling(i,{d:v, hardwareId:null})} />
                    <NumField label="Глубина" value={dr.depth??13} onChange={v=>updDrilling(i,{depth:v, hardwareId:null})} />
                  </div>

                  {contour.layout.length > 0 && (
                    <>
                      <label style={{ fontSize:11, color:'var(--text-hint)', display:'block', marginBottom:4 }}>
                        Привязать к линиям разметки (можно несколько)
                      </label>
                      <div style={{ display:'flex', gap:4, flexWrap:'wrap', marginBottom:5 }}>
                        <button type="button" onClick={() => updDrilling(i,{attachTo:[]})}
                          style={{ padding:'4px 9px', borderRadius:20, fontSize:11, border:'none',
                            background: !attachedIds.length ? 'var(--blue)' : 'var(--bg3)',
                            color: !attachedIds.length ? 'white' : 'var(--text-muted)', cursor:'pointer' }}>
                          Не привязывать
                        </button>
                        {contour.layout.map((g, gi) => {
                          const on = attachedIds.includes(g.id)
                          const sameKindG = contour.layout.filter(x => x.kind === g.kind).sort((a,b)=>(a.pos||0)-(b.pos||0))
                          const gOrderNum = sameKindG.findIndex(x => x.id === g.id) + 1
                          return (
                            <button key={g.id} type="button"
                              onClick={() => updDrilling(i,{attachTo: on ? attachedIds.filter(id=>id!==g.id) : [...attachedIds, g.id]})}
                              style={{ padding:'4px 9px', borderRadius:20, fontSize:11, border:'none',
                                background: on ? 'var(--blue)' : 'var(--bg3)',
                                color: on ? 'white' : 'var(--text-muted)', cursor:'pointer' }}>
                              {g.kind==='upright'?'▏ Стойка':g.kind==='rail'?'▬ Царга':'▭ Полка'} #{gOrderNum}
                            </button>
                          )
                        })}
                      </div>
                    </>
                  )}

                  <SideOffsetPicker activeSides={dr.sides||[]} offsets={dr.offsets||{}} allowedSides={allowedSides}
                    onChange={({sides,offsets})=>updDrilling(i,{sides,offsets})} />

                  <label style={{ fontSize:11, color:'var(--text-hint)', display:'block', margin:'6px 0 4px' }}>Размножить (зеркало)</label>
                  <div style={{ display:'flex', gap:4, marginBottom:5 }}>
                    <label style={{ flex:1, display:'flex', alignItems:'center', gap:4, fontSize:12, color:'var(--text-muted)', cursor:'pointer',
                      padding:'5px 6px', borderRadius:'var(--radius)', background: dr.mirrorX?'var(--blue-light)':'var(--bg3)' }}>
                      <input type="checkbox" checked={!!dr.mirrorX} onChange={e=>updDrilling(i,{mirrorX:e.target.checked})} />
                      ↔ По X
                    </label>
                    <label style={{ flex:1, display:'flex', alignItems:'center', gap:4, fontSize:12, color:'var(--text-muted)', cursor:'pointer',
                      padding:'5px 6px', borderRadius:'var(--radius)', background: dr.mirrorY?'var(--blue-light)':'var(--bg3)' }}>
                      <input type="checkbox" checked={!!dr.mirrorY} onChange={e=>updDrilling(i,{mirrorY:e.target.checked})} />
                      ↕ По Y
                    </label>
                  </div>

                  {(dr.mirrorX || dr.mirrorY) && !dr.row && (
                    <>
                      <label style={{ display:'flex', alignItems:'center', gap:5, fontSize:12, color:'var(--text-muted)', cursor:'pointer',
                        padding:'5px 6px', borderRadius:'var(--radius)', background: dr.pairEnabled?'var(--blue-light)':'var(--bg3)', marginBottom:5 }}>
                        <input type="checkbox" checked={!!dr.pairEnabled} onChange={e=>updDrilling(i,{pairEnabled:e.target.checked})} />
                        Парная фурнитура — на второй стороне другое отверстие (например конфирмат + шкант)
                      </label>
                      {dr.pairEnabled && (
                        <div style={{ padding:7, marginBottom:5, background:'var(--bg2)', borderRadius:'var(--radius)' }}>
                          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:5 }}>
                            <span style={{ fontSize:11, color:'var(--text-hint)' }}>Второе отверстие (на зеркальной стороне)</span>
                            <button type="button" onClick={() => updDrilling(i, {
                              d: dr.pairD ?? dr.d, depth: dr.pairDepth ?? dr.depth, face: dr.pairFace ?? dr.face,
                              pairD: dr.d, pairDepth: dr.depth, pairFace: dr.face,
                            })} style={{ fontSize:10.5, padding:'3px 8px', border:'0.5px solid var(--border-md)', borderRadius:'var(--radius)',
                              background:'transparent', color:'var(--text-muted)', cursor:'pointer' }}>
                              ⇄ Поменять местами
                            </button>
                          </div>
                          <div style={{ display:'flex', gap:4, marginBottom:5 }}>
                            {[['front','Лицо'],['back','Изнанка']].map(([id,label])=>(
                              <button key={id} type="button" onClick={() => updDrilling(i, { pairFace: id })}
                                style={{ flex:1, padding:'5px 3px', borderRadius:'var(--radius)', border:'none', fontSize:11,
                                  background: (dr.pairFace ?? dr.face)===id?'var(--blue)':'var(--bg3)',
                                  color: (dr.pairFace ?? dr.face)===id?'white':'var(--text-muted)', cursor:'pointer' }}>
                                {label}
                              </button>
                            ))}
                          </div>
                          <div style={{ display:'flex', gap:5 }}>
                            <NumField label="Диаметр D" value={dr.pairD ?? dr.d ?? 8} onChange={v=>updDrilling(i,{pairD:v})} />
                            <NumField label="Глубина" value={dr.pairDepth ?? dr.depth ?? 13} onChange={v=>updDrilling(i,{pairDepth:v})} />
                          </div>
                        </div>
                      )}
                    </>
                  )}

                  <label style={{ display:'flex', alignItems:'center', gap:5, fontSize:12, color:'var(--text-muted)', cursor:'pointer',
                    padding:'5px 6px', borderRadius:'var(--radius)', background: dr.pitchEnabled?'var(--blue-light)':'var(--bg3)', marginBottom:5 }}>
                    <input type="checkbox" checked={!!dr.pitchEnabled} onChange={e=>updDrilling(i,{pitchEnabled:e.target.checked, pitchStep: dr.pitchStep||32})} />
                    Кратность — введённый отступ считается минимумом, положение округляется до шага
                  </label>
                  {dr.pitchEnabled && (
                    <div style={{ display:'flex', gap:5, flexWrap:'wrap', marginBottom:5 }}>
                      <NumField label="Шаг кратности" value={dr.pitchStep??32} onChange={v=>updDrilling(i,{pitchStep:v})} />
                      {dr.mirrorX && (
                        <>
                          <label style={{ display:'flex', alignItems:'center', gap:4, fontSize:11, color:'var(--text-muted)', cursor:'pointer' }}>
                            <input type="checkbox" checked={!!dr.baseFixedX} onChange={e=>updDrilling(i,{baseFixedX:e.target.checked})} />
                            Слева/справа от базы
                          </label>
                          <NumField label="Мин. от края (зеркало X)"
                            value={dr.mirrorMinX ?? (dr.offsets?.left ?? dr.offsets?.right ?? 0)}
                            onChange={v=>updDrilling(i,{mirrorMinX:v})} />
                        </>
                      )}
                      {dr.mirrorY && (
                        <>
                          <label style={{ display:'flex', alignItems:'center', gap:4, fontSize:11, color:'var(--text-muted)', cursor:'pointer' }}>
                            <input type="checkbox" checked={!!dr.baseFixedY} onChange={e=>updDrilling(i,{baseFixedY:e.target.checked})} />
                            Верх/низ от базы
                          </label>
                          <NumField label="Мин. от края (зеркало Y)"
                            value={dr.mirrorMinY ?? (dr.offsets?.bottom ?? dr.offsets?.top ?? 0)}
                            onChange={v=>updDrilling(i,{mirrorMinY:v})} />
                        </>
                      )}
                    </div>
                  )}

                  {/* Реже используемые настройки — внизу */}
                  {attachedIds.length > 0 && (
                    <div style={{ display:'flex', gap:4, alignItems:'flex-end', marginBottom:5 }}>
                      <NumField label="Зазор от линии" value={dr.gap??0} onChange={v=>updDrilling(i,{gap:v})} />
                      <div style={{ display:'flex', gap:4 }}>
                        {(primaryGuide?.kind === 'upright'
                          ? [['pos','Вправо'],['neg','Влево']]
                          : [['pos','Вверх'],['neg','Вниз']]
                        ).map(([id,label])=>(
                          <button key={id} type="button" onClick={() => updDrilling(i,{gapDir:id})}
                            style={{ padding:'5px 6px', borderRadius:'var(--radius)', border:'none', fontSize:11,
                              background: (dr.gapDir||'pos')===id?'var(--blue)':'var(--bg3)',
                              color: (dr.gapDir||'pos')===id?'white':'var(--text-muted)', cursor:'pointer' }}>
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  <label style={{ display:'flex', alignItems:'center', gap:4, fontSize:12, color:'var(--text-muted)', margin:'2px 0 4px', cursor:'pointer' }}>
                    <input type="checkbox" checked={!!dr.row} onChange={e=>updDrilling(i,{row:e.target.checked})} />
                    Ряд отверстий
                  </label>
                  {dr.row && (
                    <div style={{ display:'flex', gap:4, marginBottom:5 }}>
                      <div style={{ flex:1 }}>
                        <label style={{ fontSize:10, color:'var(--text-hint)', display:'block', marginBottom:2 }}>Направление</label>
                        <div style={{ display:'flex', gap:4 }}>
                          {[['x','↔'],['y','↕']].map(([id,label])=>(
                            <button key={id} type="button" onClick={() => updDrilling(i,{rowDir:id})}
                              style={{ flex:1, padding:'5px 3px', borderRadius:'var(--radius)', border:'none', fontSize:12,
                                background: (dr.rowDir||'x')===id?'var(--blue)':'var(--bg3)',
                                color: (dr.rowDir||'x')===id?'white':'var(--text-muted)', cursor:'pointer' }}>
                              {label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <NumField label="Шаг" value={dr.rowStep??32} onChange={v=>updDrilling(i,{rowStep:v})} />
                      <NumField label="Кол-во" value={dr.rowCount??2} onChange={v=>updDrilling(i,{rowCount:Math.max(1,Math.round(v))})} />
                    </div>
                  )}
                </>
              )}

              {/* По торцу */}
              {dr.kind === 'edge' && (
                <>
                  <label style={{ fontSize:11, color:'var(--text-hint)', display:'block', marginBottom:4 }}>Торец</label>
                  <div style={{ display:'flex', gap:4, flexWrap:'wrap', marginBottom:5 }}>
                    {SIDE_BTNS.map(s => (
                      <button key={s.id} type="button" onClick={() => updDrilling(i,{edgeSide:s.id})}
                        style={{ padding:'4px 9px', borderRadius:20, fontSize:11, border:'none',
                          background: (dr.edgeSide||'left')===s.id?'var(--blue)':'var(--bg3)',
                          color: (dr.edgeSide||'left')===s.id?'white':'var(--text-muted)', cursor:'pointer' }}>
                        {s.label}
                      </button>
                    ))}
                  </div>
                  <div style={{ marginBottom:5 }}>
                    <label style={{ fontSize:10, color:'var(--text-hint)', display:'block', marginBottom:2 }}>Отступ вдоль торца от</label>
                    <div style={{ display:'flex', gap:4 }}>
                      {[['start','начала'],['end','конца']].map(([id,label])=>(
                        <button key={id} type="button" onClick={() => updDrilling(i,{alongFrom:id})}
                          style={{ flex:1, padding:'5px 3px', borderRadius:'var(--radius)', border:'none', fontSize:11,
                            background: (dr.alongFrom||'start')===id?'var(--blue)':'var(--bg3)',
                            color: (dr.alongFrom||'start')===id?'white':'var(--text-muted)', cursor:'pointer' }}>
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:4, marginBottom:5 }}>
                    <NumField label="Вдоль торца" value={dr.offsetAlong??50} onChange={v=>updDrilling(i,{offsetAlong:v})} />
                    <NumField label="От пласти" value={dr.offsetFace??(defaultThickness/2)} onChange={v=>updDrilling(i,{offsetFace:v})} />
                  </div>

                  {/* Фурнитура — показываем только записи с параметрами "для торца";
                      если у той же фурнитуры есть ещё и часть "для плоскости" — помечаем "+Пл" */}
                  {hardwarePresets.some(hp => hwEdgeSpec(hp)) && (
                    <div style={{ display:'flex', gap:4, marginBottom:5 }}>
                      <select value={dr.hardwareId || ''} onChange={e => {
                          const hp = hardwarePresets.find(x => x.id === e.target.value)
                          if (hp) applyHardwareToDrilling(i, dr, hp, 'edge')
                        }}
                        style={{ flex:1, padding:'6px 7px', fontSize:11.5,
                          borderRadius:'var(--radius)', border:'0.5px solid var(--border-md)', background:'var(--bg2)', color:'var(--text-muted)' }}>
                        <option value="">— выбрать фурнитуру —</option>
                        {hardwarePresets.filter(hp => hwEdgeSpec(hp)).map(hp => {
                          const es = hwEdgeSpec(hp)
                          return (
                            <option key={hp.id} value={hp.id}>
                              {hp.name} · Тц ⌀{es.d}×{es.depth}{hwFaceSpec(hp) ? ' +Пл' : ''}
                            </option>
                          )
                        })}
                      </select>
                      {dr.hardwareId && (
                        <button type="button" onClick={() => { if (confirm('Удалить эту фурнитуру из базы совсем?')) { removeHardwarePreset(dr.hardwareId); updDrilling(i,{hardwareId:null}) } }}
                          style={{ padding:'6px 9px', fontSize:11, border:'0.5px solid var(--border-md)', borderRadius:'var(--radius)',
                            background:'transparent', color:'var(--danger)', cursor:'pointer' }}>🗑</button>
                      )}
                    </div>
                  )}
                  {savingHardwareFor === i ? (
                    <div style={{ marginBottom:5 }}>
                      <div style={{ display:'flex', gap:4, marginBottom:4 }}>
                        <input type="text" value={newHardwareName} onChange={e=>setNewHardwareName(e.target.value)}
                          placeholder="Название (Конфирмат 7х50)" autoFocus list={`hw-names-edge-${i}`}
                          style={{ flex:1, fontSize:11.5, padding:'5px 7px', borderRadius:'var(--radius)', border:'0.5px solid var(--border-md)' }} />
                        <datalist id={`hw-names-edge-${i}`}>
                          {hardwarePresets.map(hp => <option key={hp.id} value={hp.name} />)}
                        </datalist>
                        <button type="button" onClick={() => {
                          saveHardwareSpec(newHardwareName, 'edge', {
                            d: dr.d??5, depth: dr.depth??35,
                            edgeSide: dr.edgeSide||'left', alongFrom: dr.alongFrom||'start',
                            offsetAlong: dr.offsetAlong??50, offsetFace: dr.offsetFace,
                            row: !!dr.row, rowStep: dr.rowStep??32, rowCount: dr.rowCount??2,
                            mirrorX: !!dr.mirrorX, mirrorY: !!dr.mirrorY,
                            pitchEnabled: !!dr.pitchEnabled, pitchStep: dr.pitchStep??32,
                            baseFixed: !!dr.baseFixed, mirrorMinAlong: dr.mirrorMinAlong,
                          })
                          setSavingHardwareFor(null); setNewHardwareName('')
                        }} style={{ padding:'5px 10px', border:'none', borderRadius:'var(--radius)', background:'var(--teal)', color:'white', fontSize:11, cursor:'pointer' }}>✓</button>
                        <button type="button" onClick={() => { setSavingHardwareFor(null); setNewHardwareName('') }}
                          style={{ padding:'5px 8px', border:'0.5px solid var(--border-md)', borderRadius:'var(--radius)', background:'transparent', color:'var(--text-muted)', fontSize:11, cursor:'pointer' }}>✕</button>
                      </div>
                      <p style={{ fontSize:10, color:'var(--text-hint)', margin:0 }}>
                        Если фурнитура с таким названием уже есть — её часть «для торца» обновится, часть «для плоскости» не тронется. Так у одного конфирмата могут храниться сразу обе части.
                      </p>
                    </div>
                  ) : (
                    <button type="button" onClick={() => setSavingHardwareFor(i)}
                      style={{ fontSize:10.5, padding:'3px 8px', marginBottom:5, border:'0.5px dashed var(--border-md)', borderRadius:'var(--radius)',
                        background:'transparent', color:'var(--text-hint)', cursor:'pointer' }}>
                      + Сохранить как фурнитуру (для торца)
                    </button>
                  )}

                  <div style={{ display:'flex', gap:5, marginBottom:5 }}>
                    <NumField label="Диаметр D" value={dr.d??5} onChange={v=>updDrilling(i,{d:v, hardwareId:null})} />
                    <NumField label="Глубина" value={dr.depth??35} onChange={v=>updDrilling(i,{depth:v, hardwareId:null})} />
                  </div>

                  <label style={{ fontSize:11, color:'var(--text-hint)', display:'block', margin:'0 0 4px' }}>Размножить (зеркало)</label>
                  <div style={{ display:'flex', gap:4, marginBottom:5 }}>
                    <label style={{ flex:1, display:'flex', alignItems:'center', gap:4, fontSize:12, color:'var(--text-muted)', cursor:'pointer',
                      padding:'5px 6px', borderRadius:'var(--radius)', background: dr.mirrorX?'var(--blue-light)':'var(--bg3)' }}>
                      <input type="checkbox" checked={!!dr.mirrorX} onChange={e=>updDrilling(i,{mirrorX:e.target.checked})} />
                      ↔ Лево/право
                    </label>
                    <label style={{ flex:1, display:'flex', alignItems:'center', gap:4, fontSize:12, color:'var(--text-muted)', cursor:'pointer',
                      padding:'5px 6px', borderRadius:'var(--radius)', background: dr.mirrorY?'var(--blue-light)':'var(--bg3)' }}>
                      <input type="checkbox" checked={!!dr.mirrorY} onChange={e=>updDrilling(i,{mirrorY:e.target.checked})} />
                      ↕ Верх/низ
                    </label>
                  </div>

                  {(() => {
                    const alongIsX = (dr.edgeSide === 'top' || dr.edgeSide === 'bottom')
                    const alongMirrorOn = alongIsX ? dr.mirrorX : dr.mirrorY
                    return (
                      <>
                        <label style={{ display:'flex', alignItems:'center', gap:5, fontSize:12, color:'var(--text-muted)', cursor:'pointer',
                          padding:'5px 6px', borderRadius:'var(--radius)', background: dr.pitchEnabled?'var(--blue-light)':'var(--bg3)', marginBottom:5 }}>
                          <input type="checkbox" checked={!!dr.pitchEnabled} onChange={e=>updDrilling(i,{pitchEnabled:e.target.checked, pitchStep: dr.pitchStep||32})} />
                          Кратность (вдоль торца) — отступ считается минимумом
                        </label>
                        {dr.pitchEnabled && (
                          <div style={{ display:'flex', gap:5, flexWrap:'wrap', marginBottom:5 }}>
                            <NumField label="Шаг кратности" value={dr.pitchStep??32} onChange={v=>updDrilling(i,{pitchStep:v})} />
                            {alongMirrorOn && (
                              <>
                                <label style={{ display:'flex', alignItems:'center', gap:4, fontSize:11, color:'var(--text-muted)', cursor:'pointer' }}>
                                  <input type="checkbox" checked={!!dr.baseFixed} onChange={e=>updDrilling(i,{baseFixed:e.target.checked})} />
                                  От базы
                                </label>
                                <NumField label="Мин. вдоль торца (зеркало)"
                                  value={dr.mirrorMinAlong ?? dr.offsetAlong ?? 50}
                                  onChange={v=>updDrilling(i,{mirrorMinAlong:v})} />
                              </>
                            )}
                          </div>
                        )}
                      </>
                    )
                  })()}

                  <label style={{ display:'flex', alignItems:'center', gap:4, fontSize:12, color:'var(--text-muted)', margin:'2px 0 4px', cursor:'pointer' }}>
                    <input type="checkbox" checked={!!dr.row} onChange={e=>updDrilling(i,{row:e.target.checked})} />
                    Ряд отверстий вдоль торца
                  </label>
                  {dr.row && (
                    <div style={{ display:'flex', gap:4, marginBottom:5 }}>
                      <NumField label="Шаг" value={dr.rowStep??32} onChange={v=>updDrilling(i,{rowStep:v})} />
                      <NumField label="Кол-во" value={dr.rowCount??2} onChange={v=>updDrilling(i,{rowCount:Math.max(1,Math.round(v))})} />
                    </div>
                  )}
                </>
              )}
            </CollapsibleItem>
          )})}
        </div>
      )}

      {/* Сброс */}
      {hasContour && (
        <button type="button"
          onClick={() => { upd({ vertices: makeRect(w, h), holes: [], grooves: [], drillings: [], layout: [] }); setActiveIdx(null) }}
          style={{ width:'100%', marginTop:8, padding:'6px', border:'0.5px solid var(--danger)',
            borderRadius:'var(--radius)', background:'transparent', fontSize:11, color:'var(--danger)', cursor:'pointer' }}>
          Сбросить контур
        </button>
      )}
    </div>
  )
}
