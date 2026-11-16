// Проверка строк бланка заказа перед сохранением: заполненная строка без размеров / без количества.
// Строка без размеров в заказ не попадёт, без количества — сохранится как 1 шт.; человек должен это увидеть.
// rows — строки бланка { w (длина), h (ширина), qty, name?, edges? }. -> ['Поз. 3 «Полка» — не указана ширина', …]
export function checkRows(rows) {
  const issues = []
  ;(rows || []).forEach((d, i) => {
    const w = Number(d.w) > 0, h = Number(d.h) > 0
    const q = Number(String(d.qty ?? '').replace(',', '.')) > 0
    const named = d.name && String(d.name).trim()
    const touched = w || h || q || named || Object.values(d.edges || {}).some(v => v && v !== 'default')
    if (!touched) return                                   // пустая строка — просто пропускается
    const label = `Поз. ${i + 1}${named ? ` «${String(d.name).trim()}»` : ''}`
    if (!w || !h) issues.push(`${label} — ${!w && !h ? 'не указаны размеры' : !w ? 'не указана длина' : 'не указана ширина'}`)
    else if (!q) issues.push(`${label} — не указано количество`)
  })
  return issues
}

/** Спросить перед сохранением; true — сохранять как есть */
export function confirmRows(rows) {
  const issues = checkRows(rows)
  if (!issues.length) return true
  const list = issues.slice(0, 12).join('\n') + (issues.length > 12 ? `\n… и ещё ${issues.length - 12}` : '')
  return window.confirm(`Проверьте позиции:\n${list}\n\nСтроки без размеров не попадут в заказ, без количества — сохранятся как 1 шт.\nOK — сохранить так, «Отмена» — вернуться и исправить.`)
}
