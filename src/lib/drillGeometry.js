/**
 * Геометрия точек присадки — вынесено из ContourEditor.jsx, чтобы карта
 * раскроя (NestingPage) могла показывать реальные точки сверления на
 * каждой детали. Логика скопирована как есть (без изменений в поведении),
 * чтобы не трогать проверенный код редактора контура.
 *
 * panelW/panelH — размеры детали В ЕЁ СОБСТВЕННОЙ (не повёрнутой на листе)
 * ориентации: panelW = ширина (X), panelH = длина (Y), 0,0 — левый нижний
 * угол, Y вверх (мебельный стандарт, как в ContourEditor).
 */

// ─── Поворот точки на N шагов по 90° (0/90/180/270) — используется картой
// раскроя и для присадки, и для полигона true-shape детали, чтобы оба
// оставались согласованы при любом повороте, а не только при 90° ──────────
export function rotatePointTimes(x, y, panelW, panelH, times) {
  let px = x, py = y, curW = panelW, curH = panelH
  const n = ((Math.round(times) % 4) + 4) % 4
  for (let i = 0; i < n; i++) {
    const nx = py, ny = curW - px
    px = nx; py = ny
    const nw = curH, nh = curW
    curW = nw; curH = nh
  }
  return { x: px, y: py }
}

// ─── Поворот набора сторон кромки на N шагов по 90° ───────────────────────
export function rotateEdgesTimes(edges, times) {
  const n = ((Math.round(times) % 4) + 4) % 4
  let { top, right, bottom, left } = edges
  for (let i = 0; i < n; i++) {
    const nTop = left, nRight = top, nBottom = right, nLeft = bottom
    top = nTop; right = nRight; bottom = nBottom; left = nLeft
  }
  return { top, right, bottom, left }
}

function findLayoutGuides(layout, ids) {
  if (!ids || !ids.length) return []
  return (layout || []).filter(g => ids.includes(g.id))
}

function attachedTargetForGuide(dr, guide) {
  const gap = dr.gap ?? 0
  const dirMul = dr.gapDir === 'neg' ? -1 : 1
  const center = (guide.pos || 0) + (guide.thickness || 18) / 2 + dirMul * gap
  return { axis: guide.kind === 'upright' ? 'x' : 'y', value: center }
}

function resolveKratnostValue(rawBase, span, mirrorEnabled, mirrorMinRaw, pitchStep, baseFixed) {
  const mod = (v, m) => ((v % m) + m) % m
  if (!pitchStep || !mirrorEnabled) return { base: rawBase, mirror: mirrorEnabled ? (mirrorMinRaw ?? rawBase) : null }

  if (!baseFixed) {
    let x = rawBase
    for (let k = 0; k < pitchStep; k++) {
      const cand = rawBase + k
      if (mod(span - 2 * cand, pitchStep) === 0) { x = cand; break }
    }
    return { base: x, mirror: x }
  }
  if (mirrorMinRaw == null) return { base: rawBase, mirror: rawBase }
  const mn = mirrorMinRaw
  let m = mn
  for (let k = 0; k < pitchStep; k++) {
    const cand = mn + k
    if (mod(span - rawBase - cand, pitchStep) === 0) { m = cand; break }
  }
  return { base: rawBase, mirror: m }
}

function faceDrillCenterFromSides(dr, panelW, panelH, pitchStep) {
  const sides = dr.sides || [], offsets = dr.offsets || {}
  let x = panelW / 2, y = panelH / 2, axisX = null, axisY = null
  if (sides.includes('left') && sides.includes('right')) {
    x = ((offsets.left ?? 0) + (panelW - (offsets.right ?? 0))) / 2
  } else if (sides.includes('left') || sides.includes('right')) {
    const baseSide = sides.includes('left') ? 'left' : 'right'
    const baseFixed = dr.baseFixedX !== false
    const r = resolveKratnostValue(offsets[baseSide] ?? 0, panelW, !!dr.mirrorX, dr.mirrorMinX, pitchStep, baseFixed)
    axisX = { baseSide, ...r }
    x = baseSide === 'left' ? axisX.base : panelW - axisX.base
  }
  if (sides.includes('top') && sides.includes('bottom')) {
    y = ((offsets.bottom ?? 0) + (panelH - (offsets.top ?? 0))) / 2
  } else if (sides.includes('bottom') || sides.includes('top')) {
    const baseSide = sides.includes('bottom') ? 'bottom' : 'top'
    const baseFixed = dr.baseFixedY !== false
    const r = resolveKratnostValue(offsets[baseSide] ?? 0, panelH, !!dr.mirrorY, dr.mirrorMinY, pitchStep, baseFixed)
    axisY = { baseSide, ...r }
    y = baseSide === 'bottom' ? axisY.base : panelH - axisY.base
  }
  return { x, y, axisX, axisY }
}

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
  const offsetStart = -(count - 1) / 2
  const pts = []
  for (let k = 0; k < count; k++) {
    const off = (offsetStart + k) * step
    pts.push(dr.rowDir === 'y'
      ? { x: baseX, y: baseY + off, rowIdx: k }
      : { x: baseX + off, y: baseY, rowIdx: k })
  }
  return { pts, axisX: center.axisX, axisY: center.axisY }
}

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
  let result = pts.map(p => ({ ...p, mX: false, mY: false }))
  if (dr.mirrorX) {
    result = result.concat(pts.map(p => {
      const np = (axisX && axisX.mirror != null)
        ? { ...p, x: axisX.baseSide === 'left' ? (xHi - axisX.mirror) : (xLo + axisX.mirror) }
        : { ...p, x: xLo + xHi - p.x }
      return { ...np, mX: true, mY: false }
    }))
  }
  if (dr.mirrorY) {
    const cur = result
    result = cur.concat(cur.map(p => {
      const np = (axisY && axisY.mirror != null)
        ? { ...p, y: axisY.baseSide === 'bottom' ? (yHi - axisY.mirror) : (yLo + axisY.mirror) }
        : { ...p, y: yLo + yHi - p.y }
      return { ...np, mY: true }
    }))
  }
  return result
}

function baseFaceDrillPoints(dr, panelW, panelH, layout) {
  const rowCount = dr.row ? Math.max(1, Math.round(dr.rowCount || 1)) : 1
  const guides = findLayoutGuides(layout, dr.attachTo)
  if (!guides.length) {
    const { pts, axisX, axisY } = faceDrillPointsForGuide(dr, panelW, panelH, null)
    const mirrored = mirrorFacePointsForGuide(pts, dr, panelW, panelH, null, axisX, axisY)
    return stampPairs(mirrored, dr, false, rowCount)
  }
  let all = []
  for (const guide of guides) {
    const { pts, axisX, axisY } = faceDrillPointsForGuide(dr, panelW, panelH, guide)
    const mirrored = mirrorFacePointsForGuide(pts, dr, panelW, panelH, guide, axisX, axisY)
    all = all.concat(stampPairs(mirrored, dr, false, rowCount))
  }
  return all
}

function baseEdgeDrillPoints(dr, panelW, panelH) {
  const edge = dr.edgeSide || 'left'
  const along = dr.offsetAlong ?? 50
  const count = dr.row ? Math.max(1, Math.round(dr.rowCount || 1)) : 1
  const step = dr.rowStep || 32
  const offsetStart = -(count - 1) / 2
  const fromEnd = dr.alongFrom === 'end'
  const dir = edge === 'left' ? { dx: 1, dy: 0 } : edge === 'right' ? { dx: -1, dy: 0 }
    : edge === 'top' ? { dx: 0, dy: -1 } : { dx: 0, dy: 1 }
  const total = (edge === 'left' || edge === 'right') ? panelH : panelW
  const alongIsX = (edge === 'top' || edge === 'bottom')

  const alongMirrorActive = alongIsX ? !!dr.mirrorX : !!dr.mirrorY
  const pitchStep = dr.pitchEnabled ? (dr.pitchStep || 32) : 0
  let axisAlong = null
  if (count === 1 && pitchStep) {
    const baseFixed = dr.baseFixed !== false
    axisAlong = resolveKratnostValue(along, total, alongMirrorActive, dr.mirrorMinAlong, pitchStep, baseFixed)
  }

  const pts = []
  for (let k = 0; k < count; k++) {
    const rawA = axisAlong ? axisAlong.base : (along + (offsetStart + k) * step)
    const center = fromEnd ? (total - rawA) : rawA
    let x, y
    // edgeInset — торец не на краю детали, а в вырезе/ступеньке: на сколько он утоплен от стороны
    const inset = Number(dr.edgeInset) || 0
    if (edge === 'bottom') { y = inset; x = center }
    else if (edge === 'top') { y = panelH - inset; x = center }
    else if (edge === 'left') { x = inset; y = center }
    else { x = panelW - inset; y = center }
    pts.push({ x, y, dx: dir.dx, dy: dir.dy, rowIdx: k })
  }
  return { pts, axisAlong, alongIsX, fromEnd }
}

function mirrorEdgePoints(pts, dr, panelW, panelH, axisAlong, alongIsX, fromEnd) {
  let result = pts.map(p => ({ ...p, mAlong: false, mCross: false }))
  const mirrorAlongFlag = alongIsX ? dr.mirrorX : dr.mirrorY
  const mirrorCrossFlag = alongIsX ? dr.mirrorY : dr.mirrorX
  if (mirrorAlongFlag) {
    result = result.concat(pts.map(p => {
      let np
      if (axisAlong && axisAlong.mirror != null) {
        const total = alongIsX ? panelW : panelH
        const mirroredCenter = fromEnd ? axisAlong.mirror : (total - axisAlong.mirror)
        np = alongIsX ? { ...p, x: mirroredCenter } : { ...p, y: mirroredCenter }
      } else {
        np = alongIsX ? { ...p, x: panelW - p.x } : { ...p, y: panelH - p.y }
      }
      return { ...np, mAlong: true, mCross: false }
    }))
  }
  if (mirrorCrossFlag) {
    const cur = result
    result = cur.concat(cur.map(p => {
      const np = alongIsX
        ? { ...p, y: panelH - p.y, dy: -p.dy }
        : { ...p, x: panelW - p.x, dx: -p.dx }
      return { ...np, mCross: true }
    }))
  }
  return result
}

function stampPairs(pts, dr, isEdgeKind, rowCount) {
  if (!dr.pairEnabled) return pts
  const gap = dr.pairGap ?? 32
  const axis = dr.pairAxis || 'x'
  const asFaceOfEdge = isEdgeKind && dr.pairKind === 'face'
  const swap = asFaceOfEdge ? false : (dr.pairMirrorSwap !== false)
  const out = []
  pts.forEach((p) => {
    const isMirrorCopy = isEdgeKind ? !!p.mAlong : (axis === 'y' ? !!p.mY : !!p.mX)
    const signedGap = isMirrorCopy ? -gap : gap
    let pairPt
    if (asFaceOfEdge) {
      const offIn = dr.pairFaceOffsetIn ?? 34
      pairPt = { ...p, x: p.x + (p.dx || 0) * offIn, y: p.y + (p.dy || 0) * offIn, isFaceType: true }
    } else {
      pairPt = isEdgeKind
        ? (p.dx !== 0 ? { ...p, y: p.y + signedGap } : { ...p, x: p.x + signedGap })
        : (axis === 'y' ? { ...p, y: p.y + signedGap } : { ...p, x: p.x + signedGap })
    }
    if (swap && isMirrorCopy) {
      out.push({ ...p, isPair: true })
      out.push({ ...pairPt, isPair: false })
    } else {
      out.push(p)
      out.push({ ...pairPt, isPair: true })
    }
  })
  return out
}

function stampExtraHoles(pts, dr, isEdgeKind) {
  const extras = dr.extraHoles || []
  if (!extras.length) return pts
  const out = [...pts]
  pts.forEach(p => {
    if (p.isPair || p.isFaceType || p.ehId) return
    extras.forEach(eh => {
      const d = eh.d ?? 8, depth = eh.depth ?? 13
      if (eh.kind === 'edge' && isEdgeKind) {
        const gap = eh.edgeGap ?? 32
        const pt = p.dx !== 0 ? { ...p, y: p.y + gap } : { ...p, x: p.x + gap }
        out.push({ ...pt, ehId: eh.id, ehD: d, ehDepth: depth, bx: p.x, by: p.y })
      } else if (eh.kind === 'face') {
        let pt
        if (isEdgeKind) {
          const offIn = eh.offsetIn ?? 34
          pt = { ...p, x: p.x + (p.dx||0)*offIn, y: p.y + (p.dy||0)*offIn }
        } else {
          const gap = eh.gap ?? 32
          pt = (eh.axis === 'y') ? { ...p, y: p.y + gap } : { ...p, x: p.x + gap }
        }
        out.push({ ...pt, isFaceType: true, ehId: eh.id, ehD: d, ehDepth: depth, ehFace: eh.face || 'front', bx: p.x, by: p.y })
      }
    })
  })
  return out
}

// ─── Итоговые точки присадки (ряд + зеркало) — единая точка входа ────────────
export function getDrillPoints(dr, panelW, panelH, layout) {
  if (dr.kind === 'edge') {
    const { pts, axisAlong, alongIsX, fromEnd } = baseEdgeDrillPoints(dr, panelW, panelH)
    const mirrored = mirrorEdgePoints(pts, dr, panelW, panelH, axisAlong, alongIsX, fromEnd)
    const rowCount = dr.row ? Math.max(1, Math.round(dr.rowCount || 1)) : 1
    const withPair = stampPairs(mirrored, dr, true, rowCount)
    return stampExtraHoles(withPair, dr, true)
  }
  return stampExtraHoles(baseFaceDrillPoints(dr, panelW, panelH, layout), dr, false)
}

// ─── Все точки присадки детали разом, в её "родной" ориентации (X=ширина,
// Y=длина, 0,0 внизу-слева) — то, что нужно карте раскроя ─────────────────
// frontOnly — без отверстий с изнанки (на карте раскроя они не нужны: станок их не сверлит)
export function getAllDrillPoints(contour, panelW, panelH, frontOnly = false) {
  if (!contour?.drillings?.length) return []
  const pts = []
  // contour.cut — деталь идёт в раскрой заготовкой (подрезка на кромку / прифуговка, см. edgeCut.js):
  // panelW/panelH — размер заготовки, а присадка записана по готовой детали. Считаем по готовой и сдвигаем.
  const k = contour.cut || null
  const fw = k ? panelW + k.l + k.r : panelW, fh = k ? panelH + k.b + k.t : panelH
  const onSide = (v, full) => Math.abs(v) < 0.05 || Math.abs(v - full) < 0.05
  contour.drillings.forEach(dr => {
    if (dr.installed === false) return // не сверлить — предпросмотр, на карту не выводим
    if (frontOnly && dr.kind !== 'edge' && dr.face === 'back') return
    const d = dr.d || 8
    getDrillPoints(dr, fw, fh, contour.layout).forEach(p => {
      let x = p.x, y = p.y, less = 0     // less — на сколько торцевое отверстие короче в заготовке (кромки ещё нет)
      if (k) {
        x = p.x - k.l; y = p.y - k.b
        if (dr.kind === 'edge' && !p.isFaceType) {
          if (p.dx && onSide(p.x, fw)) { less = p.x < fw / 2 ? k.l : k.r; x = p.x < fw / 2 ? 0 : panelW }
          if (p.dy && onSide(p.y, fh)) { less = p.y < fh / 2 ? k.b : k.t; y = p.y < fh / 2 ? 0 : panelH }
        }
      }
      // отверстие в торец: направление вглубь детали и глубина — карта рисует его на всю длину
      if (dr.kind === 'edge' && !p.isFaceType && (p.dx || p.dy)) {
        const depth = p.ehDepth ?? (p.isPair ? (dr.pairDepth ?? dr.depth ?? 0) : (dr.depth ?? 0))
        pts.push({ x, y, d: p.ehD ?? (p.isPair ? (dr.pairD ?? d) : d), back: false, edge: true, dx: p.dx, dy: p.dy,
          depth: less ? Math.max(0, Math.round((depth - less) * 100) / 100) : depth })
        return
      }
      // диаметр и глубина именно этого отверстия (у парного и дополнительного — свои)
      pts.push({ x, y, d: p.ehD ?? (p.isPair ? (dr.pairD ?? d) : d), back: dr.kind !== 'edge' && dr.face === 'back',
        depth: p.ehDepth ?? (p.isPair ? (dr.pairDepth ?? 13) : (dr.depth ?? 13)) })
    })
  })
  return pts
}

// Пазы детали — прямоугольники (4 угла) в «родной» ориентации; frontOnly — только с лицевой стороны
export function getGrooveRects(contour, panelW, panelH, frontOnly = false) {
  const out = []
  ;(contour?.grooves || []).forEach(g => {
    if (frontOnly && g.face === 'back') return
    const hor = g.dir === 'horizontal'
    const gw = hor ? (g.length || 100) : (g.width || 8), gh = hor ? (g.width || 8) : (g.length || 100)
    const sides = g.sides || [], o = g.offsets || {}
    let x = (panelW - gw) / 2, y = (panelH - gh) / 2, w = gw, h = gh
    if (sides.includes('left') && sides.includes('right')) { x = o.left ?? 0; w = panelW - (o.left ?? 0) - (o.right ?? 0) }
    else if (sides.includes('left')) x = o.left ?? 0
    else if (sides.includes('right')) x = panelW - gw - (o.right ?? 0)
    if (sides.includes('top') && sides.includes('bottom')) { y = o.bottom ?? 0; h = panelH - (o.bottom ?? 0) - (o.top ?? 0) }
    else if (sides.includes('bottom')) y = o.bottom ?? 0
    else if (sides.includes('top')) y = panelH - gh - (o.top ?? 0)
    out.push({ pts: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], back: g.face === 'back', width: g.width || 8, depth: g.depth || 0 })
  })
  return out
}
