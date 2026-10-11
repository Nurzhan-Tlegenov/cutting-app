// Признаки детали по её контуру (contour — объект или JSON-строка).

const cache = new WeakMap()
function parsed(detail) {
  const c = detail?.contour
  if (!c) return null
  if (typeof c !== 'string') return c
  const hit = cache.get(detail)
  if (hit && hit.src === c) return hit.val
  let val
  try { val = JSON.parse(c) } catch { val = null }
  cache.set(detail, { src: c, val })
  return val
}

// С каких пластей у детали глухая обработка (отверстия, пазы, фрезеровки): { front, back }
function faceSides(detail, thickness) {
  const c = parsed(detail)
  if (!c) return { front: false, back: false }
  const T = Number(thickness) || Number(c.meta?.thickness) || 16
  let front = false, back = false
  for (const dr of c.drillings || []) {
    if (dr.installed === false || dr.kind === 'edge') continue
    if ((dr.depth ?? 0) >= T - 0.05) continue          // сквозное — с любой стороны
    if (dr.face === 'both') { front = true; back = true } else if (dr.face === 'back') back = true; else front = true
  }
  for (const g of c.grooves || []) { if (g.face === 'back') back = true; else front = true }
  for (const d of c.decor || []) { if (d.face === 'back') back = true; else if (d.face === 'front') front = true }
  return { front, back }
}

/** Обработка с двух сторон: есть глухие отверстия/пазы и с лица, и с изнанки — деталь придётся переворачивать на станке */
export function isTwoSided(detail, thickness) {
  const s = faceSides(detail, thickness)
  return s.front && s.back
}

/** Есть обработка снизу (с нелицевой пласти): 'both' — с двух сторон, 'back' — только снизу (например, фасад:
 *  лицевая назначена без присадки, петли — с изнанки), null — снизу ничего. Такие детали подсвечиваются на карте. */
export function backSide(detail, thickness) {
  const s = faceSides(detail, thickness)
  return s.back ? (s.front ? 'both' : 'back') : null
}
