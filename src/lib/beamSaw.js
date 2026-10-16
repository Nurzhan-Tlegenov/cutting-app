// β Пильный центр: настройки производства (productions.beam_saw_settings, migration_beam_saw.sql).
// Все значения задаёт производство — в большую или меньшую сторону, без потолков: станки и системы управления разные.
// Значения по умолчанию — как в картах Asai / KDT, которые прислал Нуржан.

export const BEAM_DEFAULTS = {
  kerf: 4.4,                 // пропил пилы, мм
  trimLeft: 18, trimRight: 18, trimTop: 18, trimBottom: 18,   // обрезка кромки листа, мм
  levels: 4,                 // уровней резов не больше (каждый следующий — поворот заготовки на 90°)
  rotations: null,           // поворотов заготовки не больше; пусто — сколько позволяют уровни
  levelTrims: [18, 18],      // торцовка в начале заготовки на уровнях 3, 4, …, мм (1-й и 2-й уровни — обрезка листа); пусто — как на предыдущем
  grip: 18,                  // мин. остаток для захвата, мм: деталь уже полосы — остаток не меньше этого
  gripWithKerf: true,        // остаток считается вместе с пропилом (полоса 600 → деталь до 582)
  narrowMin: 50,             // деталь с шириной до этого (включительно) — узкая; 0 — правило выключено
  narrowCut: 120,            // узкая деталь пилится шириной не меньше этой, потом подрезается до своего размера
  direction: 'auto',         // полосы: 'y' — вдоль длинной стороны, 'x' — вдоль короткой, 'auto' — как выгоднее (без текстуры)
  stripOrder: 'desc',        // порядок полос: 'desc' — от большой к малой, 'wnw' — большая → малая к середине → большая у края
  offcutMinL: 300, offcutMinW: 300,   // деловой обрезок — не меньше, мм
  mergeSame: true,           // одинаковые карты — одной картой «× N листов»
}

const num = (v, d) => { const n = Number(String(v ?? '').replace(',', '.')); return v === '' || v == null || !isFinite(n) || n < 0 ? d : n }
const int = (v, d) => { const n = Math.floor(num(v, d)); return n >= 1 ? n : d }

/** Настройки производства -> полный набор с подставленными значениями по умолчанию */
export function beamSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {}
  const D = BEAM_DEFAULTS
  const levels = int(s.levels, D.levels)
  const lt = Array.isArray(s.levelTrims) ? s.levelTrims.map(v => num(v, null)) : []
  // пустой уровень — как предыдущий заполненный; до первого заполненного — по умолчанию
  const levelTrims = []
  for (let i = 0; i < levels - 2; i++) levelTrims.push(lt[i] ?? (i ? levelTrims[i - 1] : D.levelTrims[0]))
  return {
    kerf: num(s.kerf, D.kerf),
    trimLeft: num(s.trimLeft, D.trimLeft), trimRight: num(s.trimRight, D.trimRight), trimTop: num(s.trimTop, D.trimTop), trimBottom: num(s.trimBottom, D.trimBottom),
    levels,
    rotations: s.rotations === '' || s.rotations == null ? null : int(s.rotations, null),
    levelTrims,
    grip: num(s.grip, D.grip),
    gripWithKerf: s.gripWithKerf == null ? D.gripWithKerf : !!s.gripWithKerf,
    narrowMin: num(s.narrowMin, D.narrowMin),
    narrowCut: num(s.narrowCut, D.narrowCut),
    direction: ['y', 'x', 'auto'].includes(s.direction) ? s.direction : D.direction,
    stripOrder: ['desc', 'wnw'].includes(s.stripOrder) ? s.stripOrder : D.stripOrder,
    offcutMinL: num(s.offcutMinL, D.offcutMinL), offcutMinW: num(s.offcutMinW, D.offcutMinW),
    mergeSame: s.mergeSame == null ? D.mergeSame : !!s.mergeSame,
  }
}

/** Сколько уровней резов реально можно: уровни и повороты (каждый следующий уровень — поворот на 90°) */
export const maxLevels = s => Math.max(1, s.rotations == null ? s.levels : Math.min(s.levels, s.rotations + 1))
/** Торцовка в начале заготовки на уровне lvl. 1-й и 2-й уровни режут от краёв листа — там это обрезка листа (отступы), здесь 0.
 *  С 3-го уровня заготовка начинается от реза, и торцовка — отдельная (как у Asai / KDT: 18, у GibLab 9). */
export const trimAt = (s, lvl) => (lvl <= 2 || !s.levelTrims.length ? 0 : s.levelTrims[Math.min(lvl - 3, s.levelTrims.length - 1)] ?? 0)

/** Наибольшая деталь, которая ещё ложится в полосу шириной w (правило захвата). Ровно по ширине — всегда можно. */
export function maxPartIn(w, s) {
  return w - s.grip - (s.gripWithKerf ? 0 : s.kerf)
}

/** Одинаковые карты: детали тех же размеров на тех же местах. -> [{ first, count }] по каждому листу:
 *  first — номер первого такого листа (0…), count — сколько всего таких листов (у первого) */
export function sameMaps(sheets) {
  const sig = sh => (sh?.placed || []).map(p => `${(+p.x).toFixed(1)},${(+p.y).toFixed(1)},${(+p.w).toFixed(1)},${(+p.h).toFixed(1)}`).sort().join(';')
    + '|' + (sh?.stock || '') + '|' + (sh?.sheetL || '') + 'x' + (sh?.sheetW || '')
  const firstBy = new Map(), out = []
  ;(sheets || []).forEach((sh, i) => {
    const k = sig(sh)
    if (!sh?.placed?.length || !firstBy.has(k)) { firstBy.set(k, i); out.push({ first: i, count: 1 }); return }
    const f = firstBy.get(k)
    out.push({ first: f, count: 1 }); out[f].count++
  })
  return out
}
/** Подпись листа с учётом одинаковых карт: «×3» у первого, «= 1» у повторов */
export const sameMapTag = (same, i) => (!same?.[i] ? '' : same[i].first !== i ? ` = ${same[i].first + 1}` : same[i].count > 1 ? ` ×${same[i].count}` : '')
