// Зеркалирование контура/присадки/разметки/кромок детали по горизонтали (лево↔право).
// panelWidthX — горизонтальный размер детали (Ширина/X), а не Длина!

function mirrorVertices(verts, panelWidthX) {
  return (verts || []).map(v => {
    const nv = { ...v, x: panelWidthX - v.x }
    if (v.type === 'fillet' && v.fcx != null) {
      nv.fcx = panelWidthX - v.fcx
      nv.fccw = !v.fccw
      if (v.fa0 != null) nv.fa0 = Math.PI - v.fa0
      if (v.fa1 != null) nv.fa1 = Math.PI - v.fa1
    }
    return nv
  })
}

function swapLeftRightSides(sides) {
  return (sides || []).map(s => (s === 'left' ? 'right' : s === 'right' ? 'left' : s))
}

function swapLeftRightOffsets(offsets) {
  if (!offsets) return offsets
  const next = { ...offsets }
  if (offsets.left != null) next.right = offsets.left
  if (offsets.right != null) next.left = offsets.right
  if (offsets.left == null) delete next.right
  if (offsets.right == null) delete next.left
  return next
}

function mirrorHoleLike(item, panelWidthX) {
  const next = { ...item }
  if (item.vertices) next.vertices = mirrorVertices(item.vertices, panelWidthX)
  if (item.sides) {
    next.sides = swapLeftRightSides(item.sides)
    next.offsets = swapLeftRightOffsets(item.offsets)
  }
  return next
}

function mirrorDrilling(dr, panelWidthX) {
  const next = { ...dr }
  if (dr.sides) {
    next.sides = swapLeftRightSides(dr.sides)
    next.offsets = swapLeftRightOffsets(dr.offsets)
  }
  if (dr.kind === 'edge') {
    if (dr.edgeSide === 'left') next.edgeSide = 'right'
    else if (dr.edgeSide === 'right') next.edgeSide = 'left'
  }
  return next
}

function mirrorLayoutGuide(g, panelWidthX) {
  if (g.kind === 'upright') {
    const thickness = g.thickness || 18
    return { ...g, pos: panelWidthX - (g.pos || 0) - thickness }
  }
  // Полка/царга — горизонтальная линия, меняются местами только боковые отступы
  return { ...g, insetLeft: g.insetRight ?? 0, insetRight: g.insetLeft ?? 0 }
}

export function mirrorContour(contour, panelWidthX) {
  if (!contour) return contour
  return {
    ...contour,
    vertices: mirrorVertices(contour.vertices, panelWidthX),
    holes: (contour.holes || []).map(h => mirrorHoleLike(h, panelWidthX)),
    grooves: (contour.grooves || []).map(g => mirrorHoleLike(g, panelWidthX)),
    drillings: (contour.drillings || []).map(dr => mirrorDrilling(dr, panelWidthX)),
    layout: (contour.layout || []).map(g => mirrorLayoutGuide(g, panelWidthX)),
  }
}

// Кромка (Дв/Дн/Шл/Шп): при зеркалировании лево/право меняются местами, верх/низ — нет
export function mirrorEdges(edges) {
  if (!edges) return edges
  return { ...edges, left: edges.right ?? null, right: edges.left ?? null }
}

// Перевернуть деталь другой пластью вверх: контур, вырезы, пазы, присадка и
// кромки зеркалятся лево↔право, а лицо и изнанка меняются местами.
// detail — { w (длина), h (ширина), contour, edges }, thickness — толщина материала.
const swapFace = f => (f === 'front' ? 'back' : f === 'back' ? 'front' : f)
export function flipDetail(detail, thickness) {
  const T = Number(thickness) || 16
  const W = Number(detail.h) || 0
  const c = mirrorContour(detail.contour || {}, W) || {}
  const drillings = (c.drillings || []).map(dr => {
    const d = { ...dr }
    if (d.kind === 'edge') {
      d.offsetFace = Math.round((T - (d.offsetFace ?? T / 2)) * 10) / 10
      if (d.pairFace) d.pairFace = swapFace(d.pairFace)
    } else {
      const through = (d.depth ?? 0) >= T - 0.05           // сквозное — видно с обеих сторон
      if (!through) d.face = swapFace(d.face || 'front')
      if (d.pairFace) d.pairFace = swapFace(d.pairFace)
    }
    if (Array.isArray(d.extraHoles)) d.extraHoles = d.extraHoles.map(eh => (eh.kind === 'face' ? { ...eh, face: swapFace(eh.face || 'front') } : eh))
    return d
  })
  const grooves = (c.grooves || []).map(g => ({ ...g, face: swapFace(g.face || 'front') }))
  const holes = (c.holes || []).map(hh => (hh.type === 'pocket' ? { ...hh, face: swapFace(hh.face || 'front') } : hh))
  const contour = { ...c, drillings, grooves, holes }
  if (c.meta) contour.meta = { ...c.meta, flipped: !c.meta.flipped }
  return { ...detail, contour, edges: mirrorEdges(detail.edges) }
}
