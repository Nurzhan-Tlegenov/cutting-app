// Материал детали. В заказ можно импортировать модель целиком — тогда в нём
// детали из разных листовых материалов; материал и толщина каждой лежат в
// contour.meta (из Базиса или Астры). У деталей без них — материал заказа.
import { detailMeta } from './partLabel.js'

export function detailMatKey(d, order) {
  const m = detailMeta(d)
  if (m?.material) return `${m.material}|${m.thickness ?? ''}`
  return `${order?.material_name || ''}|${order?.material_thickness ?? ''}`
}

/** Материалы заказа: [{ key, label, count (строк), pieces (штук) }], в порядке появления */
export function materialsOf(details, order) {
  const map = new Map()
  for (const d of details || []) {
    const key = detailMatKey(d, order)
    let g = map.get(key)
    if (!g) {
      const [name, thick] = key.split('|')
      g = { key, label: `${name || 'Без материала'}${thick ? ` · ${thick} мм` : ''}`, count: 0, pieces: 0 }
      map.set(key, g)
    }
    g.count++; g.pieces += Number(d.qty) || 1
  }
  return [...map.values()]
}
