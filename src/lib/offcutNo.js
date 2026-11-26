// Номер остатка склада, на котором лежит лист-обрезок раскроя. Новые раскрои хранят его прямо на листе (stockId);
// у прежних — по номеру обрезка в списке «Обрезков со склада» заказа (offcutItem)
export function sheetStockNo(sh, order) {
  if (!sh || sh.stock !== 'offcut') return ''
  if (sh.stockId) return String(sh.stockId)
  let o = order?.offcuts
  if (typeof o === 'string') { try { o = JSON.parse(o) } catch { o = null } }
  const items = (Array.isArray(o?.items) ? o.items : []).filter(it => Number(it.length) > 0 && Number(it.width) > 0 && Math.floor(Number(it.qty) || 0) > 0)
  const it = sh.offcutItem != null ? items[sh.offcutItem] : null
  return it?.stock && !it.mat ? String(it.stock) : ''
}
/** «Обрезок 2 · склад №15» — подпись листа */
export const sheetTitle = (sh, i, order) => {
  const no = sheetStockNo(sh, order)
  return `${sh?.stock === 'offcut' ? 'Обрезок' : 'Лист'} ${i + 1}${no ? ` · склад №${no}` : ''}`
}
