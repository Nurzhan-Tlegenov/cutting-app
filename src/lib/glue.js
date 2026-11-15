// Склейка: две плиты (обычно 2 × 16 мм) склеивают в одну деталь и кромят широкой кромкой.
// Как деталь узнаётся склеенной:
//  1) Базис-Мебельщик — облицовка пласти плитой (contour.meta.glue: { n, of }): основа n = 1, слои n = 2…;
//  2) позиции: «5» и «5а» (та же позиция с буквой) одного размера — как в отчётах Базиса, Excel и бланке;
//  3) пользовательское свойство детали «Склейка…» со значением (да / 1 / + / любое, кроме нет / 0).
// Склейка считается один раз на склеенную деталь (по основе), площадь — по одной стороне детали.
// Кромка склеенной детали — всегда широкая (толщина детали уже двойная).
// Модуль без React.
import { metaPos } from './partLabel.js'

const LETTERS = 'абвгдежзикabcdefgh'
const metaOf = d => {
  let c = d?.contour
  if (typeof c === 'string') { try { c = JSON.parse(c) } catch { c = null } }
  return c && typeof c === 'object' ? c.meta || null : null
}
const NO = /^(нет|no|0|false|-|—)?$/i
function userGlue(m) {
  const u = m?.user
  if (!u || typeof u !== 'object') return false
  return Object.entries(u).some(([k, v]) => /^склейк|^glue/i.test(k) && !NO.test(String(v ?? '').trim()))
}
const sizeKey = d => `${Math.round(Number(d?.length) || 0)}x${Math.round(Number(d?.width) || 0)}`

/**
 * Роли деталей списка в склейке: Map(index -> 'base' | 'layer').
 * base — склеенная деталь (по ней считается склейка и широкая кромка), layer — второй слой (в смете не считается).
 */
export function glueRoles(details) {
  const roles = new Map()
  const list = details || []
  const byPos = new Map()
  list.forEach((d, i) => {
    const m = metaOf(d)
    const g = m?.glue
    if (g && Number(g.of) > 1) { roles.set(i, Number(g.n) > 1 ? 'layer' : 'base'); return }
    if (userGlue(m)) { roles.set(i, 'base'); return }
    const p = metaPos(m)
    if (p) byPos.set(`${p.toLowerCase()}|${sizeKey(d)}`, i)
  })
  // «5» + «5а» одного размера: «5» — склеенная деталь, «5а» — слой
  list.forEach((d, i) => {
    if (roles.has(i)) return
    const p = metaPos(metaOf(d))
    if (!p || p.length < 2) return
    const last = p.slice(-1).toLowerCase()
    if (!LETTERS.includes(last) || !/[0-9]/.test(p.slice(-2, -1))) return
    const base = byPos.get(`${p.slice(0, -1).toLowerCase()}|${sizeKey(d)}`)
    if (base == null || base === i) return
    roles.set(i, 'layer')
    if (!roles.has(base)) roles.set(base, 'base')
  })
  return roles
}
