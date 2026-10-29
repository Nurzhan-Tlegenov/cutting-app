// Склад остатков ↔ Excel: импорт готовой таблицы остатков производства и выгрузка склада в .xlsx (резервная копия).
// Колонки узнаются по названиям в шапке: длина, ширина, кол-во, материал, толщина, ячейка, примечание.
// Если шапки нет — числа в строке по порядку: длина, ширина, кол-во.
import { readTableFile, toNumber } from './importDetails'
import { importRetry } from './lazyRetry'
import { mm } from './mmFmt'
import { kindText, eventText, dateText } from './stock'

const COLS = [
  ['length', /^(длин|length|высот|l\b|д\b)/],
  ['width', /^(шир|width|w\b|ш\b)/],
  ['qty', /^(кол|qty|шт|count|amount)/],
  ['material', /(матер|декор|material|плит)/],
  ['thickness', /(толщ|thick)/],
  ['cell', /(ячей|cell|стелла|место|склад|полк|хранен)/],
  ['note', /(прим|коммент|note|описан)/],
]
const norm = v => String(v ?? '').toLowerCase().replace(/ё/g, 'е').trim()

function roleOf(cell) {
  const t = norm(cell)
  if (!t) return null
  const hit = COLS.find(([, re]) => re.test(t))
  return hit ? hit[0] : null
}

/** -> { items: [{ length, width, qty, material, thickness, cell, note }], skipped, sheet, hasMaterial, hasCell } */
export async function readStockFile(file) {
  const { sheets } = await readTableFile(file)
  let best = null
  for (const s of sheets) {
    const rows = s.rows || []
    // шапка — первая строка (из первых 15), где есть и длина, и ширина
    let head = -1, map = {}
    for (let i = 0; i < Math.min(rows.length, 15); i++) {
      const m = {}
      rows[i].forEach((c, j) => { const r = roleOf(c); if (r && m[r] == null) m[r] = j })
      if (m.length != null && m.width != null) { head = i; map = m; break }
    }
    const items = []
    let skipped = 0
    const start = head >= 0 ? head + 1 : 0
    for (let i = start; i < rows.length; i++) {
      const row = rows[i] || []
      if (!row.some(c => c !== '' && c != null)) continue
      let L, W, Q, it = {}
      if (head >= 0) {
        L = toNumber(row[map.length]); W = toNumber(row[map.width]); Q = map.qty != null ? toNumber(row[map.qty]) : 1
        if (map.material != null) it.material = String(row[map.material] ?? '').trim()
        if (map.thickness != null) { const t = toNumber(row[map.thickness]); if (t > 0) it.thickness = t }
        if (map.cell != null) it.cell = String(row[map.cell] ?? '').trim()
        if (map.note != null) it.note = String(row[map.note] ?? '').trim()
      } else {
        const nums = row.map(toNumber).filter(n => !Number.isNaN(n) && n > 0)
        ;[L, W, Q] = nums
        const text = row.filter(c => typeof c === 'string' && c.trim() && Number.isNaN(toNumber(c)))
        if (text.length) it.material = text[0].trim()
      }
      if (!(L >= 10) || !(W >= 10)) { skipped++; continue }
      const qty = Q > 0 && Q < 10000 ? Math.round(Q) : 1
      items.push({ length: Math.round(L * 100) / 100, width: Math.round(W * 100) / 100, qty, ...it })
    }
    if (!best || items.length > best.items.length) best = { items, skipped, sheet: s.name, hasMaterial: head < 0 ? items.some(x => x.material) : map.material != null, hasCell: map.cell != null }
  }
  return best || { items: [], skipped: 0, sheet: '', hasMaterial: false, hasCell: false }
}

const STATUS = { free: 'на складе', reserved: 'в резерве', used: 'списан' }
const d = iso => (iso ? new Date(iso).toLocaleDateString('ru-RU') : '')

/** Выгрузить склад в .xlsx: лист «Остатки» и лист «Журнал» (если передан) */
export async function exportStockXlsx(rows, events, prodName) {
  const XLSX = await importRetry(() => import('@e965/xlsx'))
  const head = ['№', 'Длина', 'Ширина', 'Кол-во', 'Материал', 'Толщина', 'Ячейка', 'Примечание', 'Статус', 'Списан', 'Бирка выпущена', 'Внесён']
  const data = rows.map(r => [r.id, Number(mm(r.length)), Number(mm(r.width)), r.qty, r.material || '', r.thickness ?? '', r.cell || '', r.note || '',
    STATUS[r.status] || r.status, r.status === 'used' ? `${kindText(r.used_kind)} ${d(r.used_at)}` : '', d(r.label_at), d(r.created_at)])
  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.aoa_to_sheet([head, ...data])
  ws['!cols'] = [6, 8, 8, 7, 26, 8, 12, 24, 11, 18, 14, 11].map(w => ({ wch: w }))
  XLSX.utils.book_append_sheet(wb, ws, 'Остатки')
  if (events?.length) {
    const ev = XLSX.utils.aoa_to_sheet([['Когда', 'Остаток №', 'Кто', 'Что сделано', 'Причина'], ...events.map(e => [dateText(e.at), e.remnant_id, e.user_name || '', eventText(e), e.reason || ''])])
    ev['!cols'] = [17, 10, 18, 60, 30].map(w => ({ wch: w }))
    XLSX.utils.book_append_sheet(wb, ev, 'Журнал')
  }
  const name = `Остатки ${String(prodName || '').replace(/[\\/:*?"<>|]+/g, ' ').trim()} ${new Date().toISOString().slice(0, 10)}.xlsx`.replace(/\s+/g, ' ')
  const blob = new Blob([XLSX.write(wb, { type: 'array', bookType: 'xlsx' })], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url; a.download = name
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}
