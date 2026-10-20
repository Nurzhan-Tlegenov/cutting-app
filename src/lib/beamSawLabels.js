// Бирки для пильного центра: порядок — по готовности деталей, положение — как деталь выходит со станка.
//
// Порядок. Лист распускается на полосы; полоса режется поперёк: деталь ровно по полосе готова сразу — её бирка печатается;
// кусок, который ещё дорезается, откладывается; когда полоса пройдена, отложенные куски режутся (следующий уровень) —
// и так же: готовые — бирка, остальные — в сторону. Бирка выходит в тот момент, когда последний рез делает деталь готовой.
// Обход дерева резов листа (sheet.beamTree — слоты уже в порядке резки): готовые детали слота за слотом, потом отложенные.
//
// Положение. На станке линия реза одна; лист кладут так, чтобы резы 1-го уровня шли по ней, а каждый следующий уровень —
// заготовка повёрнута на 90°. Поэтому деталь выходит повёрнутой относительно карты: поворот = (полосы по карте вертикальны ? 90° : 0)
// + (уровень − 1) × 90°; в какую сторону крутят — настройка постпроцессора (labelTurn: 'cw' | 'ccw'), при желании ещё 180°
// (labelFlip). На бирке эскиз, кромки и размеры — как деталь лежит на выходе: оператору не надо вращать бирку.
import { labelSeq } from './labelMaker'

/** Номера деталей листа (индексы в placed) в порядке готовности на пильном центре */
export function beamLabelOrder(sheet) {
  const byId = new Map((sheet.placed || []).map((p, pi) => [p.id, pi]))
  const out = []
  const walk = node => {
    if (!node?.slots) return
    const later = []
    for (const sl of node.slots) {
      if (sl.part != null) { const pi = byId.get(sl.part); if (pi != null) out.push(pi) } else if (sl.child) later.push(sl.child)
    }
    later.forEach(walk)
  }
  walk(sheet.beamTree)
  // детали, которых нет в дереве (не должно быть) — в конец, по порядку
  ;(sheet.placed || []).forEach((p, pi) => { if (!out.includes(pi)) out.push(pi) })
  return out
}
/** Порядок бирок листа для пильного центра: детали по готовности, потом (если включено) обрезки */
export function beamLabelSeq(sheet, geo, tpl) {
  const offs = labelSeq(sheet, geo, 'manual', tpl).filter(q => q.oi != null)
  return [...beamLabelOrder(sheet).map(pi => ({ pi })), ...offs]
}

/** Деталь, повёрнутая на k четвертей оборота (как в liveNesting: контур (x, y) → (y, W − x)) */
export function turnPlaced(p, k) {
  let q = { ...p }
  for (let i = 0; i < ((k % 4) + 4) % 4; i++) {
    const W = Number(q.origX) || 0
    q = { ...q, origX: q.origY, origY: q.origX, w: q.h, h: q.w, rotation: ((Number(q.rotation) || 0) + 90) % 360,
      edgeTop: q.edgeLeft, edgeRight: q.edgeTop, edgeBottom: q.edgeRight, edgeLeft: q.edgeBottom,
      ...(Array.isArray(q.polygon) ? { polygon: q.polygon.map(v => ({ x: v.y, y: W - v.x })) } : {}) }
    q.rotated = q.rotation % 180 === 90
  }
  return q
}
/** Сколько четвертей оборота от карты до положения детали на выходе со станка */
export function beamExitTurns(p, sheet, post) {
  const base = sheet?.beamAxis === 'x' ? 1 : 0                 // полосы по карте вертикальны — лист на станке лежит поперёк
  const k = base + Math.max(0, (Number(p?.beamLevel) || 1) - 1)
  return (post?.labelTurn === 'ccw' ? -k : k) + (post?.labelFlip ? 2 : 0)
}
/** Деталь как она выходит со станка (для бирки) */
export const beamExitPart = (p, sheet, post) => turnPlaced(p, beamExitTurns(p, sheet, post))
