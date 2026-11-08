// Доприсадка на том же фрезере (у кого нет шестистороннего): детали с обработкой с двух сторон после раскроя
// переворачивают и кладут в угол укладки станка — длинной стороной вдоль Y — и делают обработку обратной стороны
// отдельной программой (на каждую деталь-строку заказа одна программа, запускается столько раз, сколько таких деталей).
//
// Как кладут (настройка постпроцессора post.corner — угол укладки, туда же ноль программы):
//   деталь длиной вдоль ширины W ≤ длины H — переворот через длинную сторону (лево ↔ право);
//   W > H — переворот через короткую сторону и поворот на 90° против часовой (по карте: отражение x ↔ y).
// Какой угол детали прижать к упору, показывает тёмный уголок на бирке (backMarkCorner): бирка на лицевой стороне,
// после переворота этот угол бирки — у упора.
import { mirrorContour } from './mirrorDetail'
import { flatOf } from './pathBand'
import { placedTurns } from './partHoles'
import { rotatePointTimes } from './drillGeometry'
import { roughShapePolygons } from './trueShapeNesting'
import { backSide } from './partInfo'
import { cornerOf } from './sheetCorner'
import { rawDetail } from './edgeCut'

// edge: true — программа по готовой детали с кромкой (доприсадка после кромления), false — по заготовке без кромки (сразу после раскроя)
// name — имя файла программы: шаблон тем же конструктором, что QR-код бирки ({OBOZ}, {POZ}, {NAIM}, {KOL}…)
export const BACK_NAME_DEFAULT = () => ({ tpl: '{POZ}_{NAIM}_x{KOL}', sep: '_', latin: true })
export const BACK_DEFAULT = () => ({ on: false, edge: false, contour: false, holes: true, grooves: true, pockets: true, name: BACK_NAME_DEFAULT() })
export const backOf = post => ({ ...BACK_DEFAULT(), ...(post?.back || {}) })

const n0 = v => Number(v) || 0
const parse = c => { try { return typeof c === 'string' ? JSON.parse(c) : c || null } catch { return null } }
const swap = f => (f === 'front' ? 'back' : f === 'back' ? 'front' : f)

// деталь «как её видно с обратной стороны» (без зеркала): обработка изнанки становится лицевой, лицевая — изнанкой;
// сквозное, в торец и вырезы — уже сделаны первой программой, не выводятся
function backContour(c, T, o) {
  const through = dr => !(n0(dr.depth) > 0) || n0(dr.depth) >= T - 0.05
  const drillings = o.holes ? (c.drillings || []).filter(dr => dr.kind !== 'edge' && dr.installed !== false).map(dr => {
    const d = { ...dr, face: through(dr) ? 'back' : swap(dr.face || 'front') }      // сквозное — на «изнанку»: не выводится
    if (d.pairFace) d.pairFace = swap(d.pairFace)
    if (Array.isArray(d.extraHoles)) d.extraHoles = d.extraHoles.filter(eh => eh.kind === 'face').map(eh => ({ ...eh, face: swap(eh.face || 'front') }))
    return d
  }) : []
  const grooves = o.grooves ? (c.grooves || []).map(g => ({ ...g, face: swap(g.face || 'front') })) : []
  const holes = (c.holes || []).filter(h => (h.type === 'pocket' ? o.pockets : o.contour)).map(h => (h.type === 'pocket' ? { ...h, face: swap(h.face || 'front') } : h))
  // паз по траектории с плоским дном (Базис; и по замкнутой — рамка) — как обычный паз; прочая фрезеровка «для вида» не выводится
  const decor = o.grooves ? (c.decor || []).filter(dc => flatOf(dc)).map(dc => ({ ...dc, face: swap(dc.face || 'front') })) : []
  return { ...c, drillings, grooves, holes, edgeGrooves: [], decor }
}
// mirrorContour траекторию паза не отражает: x -> W − x и путь в обратную сторону (левый край полосы остаётся левым)
const mirrorDecor = (c, W) => ({ ...c, decor: (c.decor || []).map(dc => ({ ...dc, path: [...dc.path].reverse().map(([x, y]) => [W - x, y]) })) })

/** Положение детали на станке для доприсадки: отражение detail -> станок и размеры по X, Y */
function machineOf(d, orient = d) {
  const W = n0(d.width), H = n0(d.length)
  return n0(orient.length) >= n0(orient.width) ? { long: 'y', mw: W, mh: H, C: (x, y) => [W - x, y], turns: 0 } : { long: 'x', mw: H, mh: W, C: (x, y) => [y, x], turns: 1 }
}

/** Угол бирки (по карте раскроя: 'bl' | 'br' | 'tl' | 'tr'), который после переворота окажется у упора станка */
export function backMarkCorner(p, d, stop, edge = false) {
  if (!p || !d) return null
  const t = ((placedTurns(p, d) % 4) + 4) % 4, ox = n0(p.origX), oy = n0(p.origY)
  const m = machineOf(d, edge ? rawDetail(d) : d), c = cornerOf(stop)      // положение (вдоль Y) — как у программы
  const want = [c === 'br' || c === 'tr' ? m.mw : 0, c === 'tl' || c === 'tr' ? m.mh : 0]
  for (const [k, sx, sy] of [['bl', 0, 0], ['br', ox, 0], ['tl', 0, oy], ['tr', ox, oy]]) {
    const q = rotatePointTimes(sx, sy, ox, oy, (4 - t) % 4)          // карта -> деталь
    const [mx, my] = m.C(q.x, q.y)
    if (Math.abs(mx - want[0]) < 0.5 && Math.abs(my - want[1]) < 0.5) return k
  }
  return null
}

/** Детали с обработкой снизу (с двух сторон или только снизу) на выбранных листах: [{ di, detail, qty }] */
export function backParts(mat, sel) {
  const T = n0(mat.thickness) || 16, cnt = new Map(), at = new Map()
  for (const si of sel) (mat.sheets[si]?.placed || []).forEach((p, pi) => { cnt.set(p.detailIndex, (cnt.get(p.detailIndex) || 0) + 1); if (!at.has(p.detailIndex)) at.set(p.detailIndex, [si, pi]) })
  return [...cnt].filter(([di]) => mat.details[di] && backSide(mat.details[di], T)).map(([di, qty]) => ({ di, detail: mat.details[di], qty, at: at.get(di) }))
}

/** Одна деталь для доприсадки -> { sheet, geo, details } для buildSheetGcode (деталь в углу укладки, длиной вдоль Y) */
export function backJob(d0, T, post) {
  const o = backOf(post), d = o.edge ? rawDetail(d0) : d0, c = parse(d.contour) || {}   // с кромкой — готовая деталь
  const m = machineOf(d)
  // обратная сторона, вид сверху после переворота: зеркало по ширине детали + поворот (у W > H — на четверть)
  const bc = backContour(c, T, o)
  const dB = { ...d, contour: JSON.stringify(mirrorDecor(mirrorContour(bc, n0(d.width)), n0(d.width))) }
  const rotation = m.turns * 90
  let polygon
  try { polygon = roughShapePolygons(dB)[rotation].map(([x, y]) => ({ x, y })) } catch { polygon = undefined }
  const part = { detailIndex: 0, x: 0, y: 0, origX: m.mw, origY: m.mh, w: m.mw, h: m.mh, rotation, rotated: m.turns === 1, label: d.name, ...(polygon ? { polygon } : {}) }
  const geo = { sheetW: m.mw, sheetL: m.mh, marginL: 0, marginR: 0, marginT: 0, marginB: 0, kerf: 0, usableX: m.mw, usableY: m.mh, corner: cornerOf(post?.corner) }
  return { sheet: { placed: [part] }, geo, details: [dB], outer: !!o.contour }
}
