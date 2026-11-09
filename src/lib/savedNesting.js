// Сохранённый (принятый) раскрой заказа — для карточки заказа, ЧПУ и бирок.
// orders.nesting_result: один материал — сам результат; несколько — { multi: true, byMat: { ключ: результат } }.
// Индексы деталей в раскрое (p.detailIndex) — по списку деталей ЭТОГО материала.
import { materialsOf, detailMatKey } from './detailMaterial'

const num = (...v) => { for (const x of v) if (x != null && x !== '' && !isNaN(Number(x))) return Number(x); return 0 }

/** Геометрия листа: у листа-обрезка — своя, у обычного — из результата, иначе из заказа */
export function sheetGeo(order, result, sh) {
  const r = result || {}
  const sheetL = num(sh?.sheetL, r.sheetL, order?.sheet_length)
  const sheetW = num(sh?.sheetW, r.sheetW, order?.sheet_width)
  const marginL = num(sh?.marginL, r.marginL, order?.margin_left)
  const marginR = num(sh?.marginR, r.marginR, order?.margin_right)
  const marginT = num(sh?.marginT, r.marginT, order?.margin_top)
  const marginB = num(sh?.marginB, r.marginB, order?.margin_bottom)
  return {
    sheetL, sheetW, marginL, marginR, marginT, marginB, kerf: num(r.kerf, order?.kerf_width),
    usableX: num(sh?.usableX, r.usableX, sheetW - marginL - marginR),
    usableY: num(sh?.usableY, r.usableY, sheetL - marginT - marginB),
    corner: r.corner || 'bl',          // угол укладки, от которого уложен раскрой (см. sheetCorner.js)
  }
}

/**
 * Раскрои заказа по материалам: [{ key, label, name, thickness, result, sheets, details }]
 * (только материалы, у которых раскрой сохранён).
 */
export function savedNestings(order, allDetails) {
  if (!order?.nesting_result) return []
  let store
  try { store = typeof order.nesting_result === 'string' ? JSON.parse(order.nesting_result) : order.nesting_result } catch { return [] }
  if (!store) return []
  const mats = materialsOf(allDetails || [], order)
  const out = []
  const push = (m, result, details) => {
    const sheets = (result?.sheets || []).filter(sh => sh?.placed?.length)
    if (!sheets.length) return
    const [name, thick] = String(m?.key || '|').split('|')
    out.push({
      key: m?.key || '', label: m?.label || order.material_name || 'Материал',
      name: name || order.material_name || '', thickness: Number(thick) || Number(order.material_thickness) || 16,
      result, sheets, details,
      all: allDetails || [],        // все детали заказа — чтобы найти деталь в общей 3D-модели
    })
  }
  if (store.multi) {
    for (const m of mats) if (store.byMat?.[m.key]) push(m, store.byMat[m.key], (allDetails || []).filter(d => detailMatKey(d, order) === m.key))
  } else push(mats[0], store, allDetails || [])
  return out
}

/**
 * Карты раскроя без удалённых деталей (производство удалило детали из заказа, см. migration_production_detail_edit.sql):
 * укладки этих деталей убираются, номера остальных (detailIndex, id «номер_штука») пересчитываются по новому списку
 * деталей материала. У пильного центра дерево резов строится по текущей карте — место детали просто станет отходом.
 * -> { value (строка для orders.nesting_result или null), reset: [названия материалов со сброшенным раскроем] }
 */
export function dropDetailsFromNesting(order, allDetails, ids) {
  const gone = new Set(ids)
  let store
  try { store = typeof order?.nesting_result === 'string' ? JSON.parse(order.nesting_result) : order?.nesting_result } catch { store = null }
  if (!store) return { value: order?.nesting_result ?? null, reset: [] }
  const reset = []
  const fix = (result, details) => {
    if (!result) return result
    const map = new Map()                      // старый номер детали -> новый (null — удалена)
    let k = 0
    details.forEach((d, i) => map.set(i, gone.has(d.id) ? null : k++))
    if (![...map.values()].includes(null)) return result
    const walk = v => {
      if (Array.isArray(v)) return v.filter(x => !(x && typeof x === 'object' && typeof x.detailIndex === 'number' && map.get(x.detailIndex) === null)).map(walk)
      if (!v || typeof v !== 'object') return v
      const out = {}
      for (const [key, val] of Object.entries(v)) out[key] = walk(val)
      if (typeof v.detailIndex === 'number' && map.has(v.detailIndex)) {
        const ni = map.get(v.detailIndex)
        out.detailIndex = ni
        if (typeof v.id === 'string' && /^\d+_/.test(v.id)) out.id = v.id.replace(/^\d+_/, `${ni}_`)
      }
      return out
    }
    return walk(result)
  }
  const mats = materialsOf(allDetails || [], order)
  if (store.multi) {
    const byMat = { ...(store.byMat || {}) }
    for (const m of mats) {
      if (!byMat[m.key]) continue
      const r = fix(byMat[m.key], (allDetails || []).filter(d => detailMatKey(d, order) === m.key))
      if (r) byMat[m.key] = r; else delete byMat[m.key]
    }
    return { value: JSON.stringify({ ...store, byMat }), reset }
  }
  const r = fix(store, allDetails || [])
  return { value: r ? JSON.stringify(r) : null, reset }
}
