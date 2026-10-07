// Импорт списка деталей из таблиц: Excel (.xlsx/.xls), CSV/TXT,
// выгрузки Базис-Мебельщик и PRO100.
// Модуль без React: чтение файла -> таблица строк -> распознавание колонок -> детали.
import { importRetry } from './lazyRetry.js'

// Роли колонок
export const ROLES = [
  { id: '', label: '— не брать —' },
  { id: 'name', label: 'Название' },
  { id: 'length', label: 'Длина' },
  { id: 'width', label: 'Ширина' },
  { id: 'size', label: 'Размер Д×Ш' },
  { id: 'qty', label: 'Кол-во' },
  { id: 'material', label: 'Материал' },
  { id: 'thickness', label: 'Толщина' },
  { id: 'prefix', label: 'Группа (префикс)' },
  { id: 'edgeL1', label: 'Кромка Дл' },
  { id: 'edgeL2', label: 'Кромка Дп' },
  { id: 'edgeW1', label: 'Кромка Шв' },
  { id: 'edgeW2', label: 'Кромка Шн' },
  { id: 'edgeLn', label: 'Кромок по длине (0–2)' },
  { id: 'edgeWn', label: 'Кромок по ширине (0–2)' },
]

// ---------- Чтение файла ----------

function decodeText(buf) {
  const u8 = new Uint8Array(buf)
  if (u8[0] === 0xFF && u8[1] === 0xFE) return new TextDecoder('utf-16le').decode(u8.subarray(2))
  if (u8[0] === 0xFE && u8[1] === 0xFF) return new TextDecoder('utf-16be').decode(u8.subarray(2))
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(u8).replace(/^\uFEFF/, '')
  } catch {
    // Программы под Windows (Базис, PRO100) сохраняют CSV в кодировке 1251
    return new TextDecoder('windows-1251').decode(u8)
  }
}

function detectDelimiter(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim()).slice(0, 30)
  let best = ';', bestScore = -1
  for (const d of [';', '\t', ',', '|']) {
    const counts = lines.map(l => l.split(d).length - 1)
    const withDelim = counts.filter(c => c > 0).length
    const total = counts.reduce((a, b) => a + b, 0)
    // запятая часто встречается как десятичный разделитель — даём ей меньший вес
    const score = withDelim * 1000 + total - (d === ',' ? 500 : 0)
    if (withDelim > 0 && score > bestScore) { best = d; bestScore = score }
  }
  return best
}

export function parseDelimited(text) {
  const delim = detectDelimiter(text)
  const rows = []
  let row = [], cell = '', inQ = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++ } else inQ = false
      } else cell += ch
    } else if (ch === '"' && cell === '') inQ = true
    else if (ch === delim) { row.push(cell); cell = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell); rows.push(row); row = []; cell = ''
    } else cell += ch
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row) }
  return rows
}

function cleanRows(rows) {
  const out = rows.map(r => (r || []).map(c => (c == null ? '' : typeof c === 'string' ? c.trim() : c)))
  while (out.length && out[out.length - 1].every(c => c === '')) out.pop()
  const width = out.reduce((m, r) => Math.max(m, r.length), 0)
  out.forEach(r => { while (r.length < width) r.push('') })
  return out
}

// -> { sheets: [{ name, rows: any[][] }] }
export async function readTableFile(file) {
  const buf = await file.arrayBuffer()
  const u8 = new Uint8Array(buf)
  const isZip = u8[0] === 0x50 && u8[1] === 0x4B            // .xlsx
  const isOle = u8[0] === 0xD0 && u8[1] === 0xCF            // .xls
  let sheets
  if (!isZip && !isOle) {
    const text = decodeText(buf)
    const head = text.slice(0, 300).trimStart().toLowerCase()
    if (head.startsWith('<')) {
      // «.xls», который на самом деле HTML- или XML-таблица
      const XLSX = await importRetry(() => import('@e965/xlsx'))
      const wb = XLSX.read(text, { type: 'string' })
      sheets = wb.SheetNames.map(n => ({ name: n, rows: XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: '', raw: true }) }))
    } else {
      sheets = [{ name: file.name, rows: parseDelimited(text) }]
    }
  } else {
    const XLSX = await importRetry(() => import('@e965/xlsx'))
    if (isOle) {
      const cptable = await importRetry(() => import('@e965/xlsx/dist/cpexcel.full.mjs'))
      XLSX.set_cptable(cptable)
    }
    const wb = XLSX.read(u8, isOle ? { type: 'array', codepage: 1251 } : { type: 'array' })
    sheets = wb.SheetNames.map(n => ({ name: n, rows: XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: '', raw: true }) }))
  }
  sheets = sheets.map(s => ({ name: s.name, rows: cleanRows(s.rows) })).filter(s => s.rows.length)
  if (!sheets.length) throw new Error('В файле нет данных')
  return { sheets }
}

// ---------- Распознавание колонок ----------

const norm = s => String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim()

export function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN
  let s = String(v ?? '').replace(/[\s\u00A0]/g, '').replace(',', '.').replace(/(мм|mm|шт\.?|pcs)$/i, '')
  return /^-?\d+(\.\d+)?$/.test(s) ? parseFloat(s) : NaN
}

// Роль колонки по тексту заголовка ('' — не распознано)
function roleByHeader(raw) {
  const h = norm(raw)
  if (!h) return ''
  if (/кром|edge|облицов|обклад/.test(h)) {
    if (/длина кром|метр|итог|всего|погон/.test(h)) return ''
    const rest = h.split(' ')
      .filter(t => !/^(кром|edge|облицов|обклад|сторон)/.test(t) && t !== 'по' && t !== 'на')
      .join(' ')
    if (/лев/.test(rest)) return 'edgeL1'
    if (/прав/.test(rest)) return 'edgeL2'
    if (/верх|top/.test(rest)) return 'edgeW1'
    if (/низ|bottom/.test(rest)) return 'edgeW2'
    const two = /2/.test(rest)
    if (/^(дл|д\s?\d|д$|l\s?\d|l$|len|long)/.test(rest)) return two ? 'edgeL2' : (/1/.test(rest) ? 'edgeL1' : 'edgeL?')
    if (/^(шир|ш\s?\d|ш$|w\s?\d|w$|wid|short|b\s?\d)/.test(rest)) return two ? 'edgeW2' : (/1/.test(rest) ? 'edgeW1' : 'edgeW?')
    return 'edge?'
  }
  if (/толщин|^толщ|^thick|^t$|^s$/.test(h)) return 'thickness'
  if (/длин|^дл$|^length|^len$|^l$|^д$|^a$/.test(h)) return 'length'
  if (/ширин|^шир$|^width|^w$|^ш$|^b$/.test(h)) return 'width'
  if (/размер|габарит|dimension|^size/.test(h)) return 'size'
  if (/кол|^шт$|qty|quant|count|^n$|^к$/.test(h)) return 'qty'
  if (/материал|material|декор|^цвет|плита/.test(h)) return 'material'
  if (/издел|^блок|групп|модул|сборк|product|group|секци/.test(h)) return 'prefix'
  if (/наимен|назван|^name|^имя/.test(h)) return 'name'
  if (/детал|обознач|описан|part|descr/.test(h)) return 'name?'
  return ''
}

// Разложить «сырые» роли строки заголовков в итоговые (каждая роль — один раз)
function resolveRoles(rawRoles) {
  const roles = rawRoles.map(() => '')
  const used = new Set()
  const take = (i, r) => { if (!used.has(r)) { roles[i] = r; used.add(r) } }
  // 1) однозначные
  rawRoles.forEach((r, i) => { if (r && !r.endsWith('?')) take(i, r) })
  // 2) кромка по стороне без номера: первая — 1, вторая — 2
  rawRoles.forEach((r, i) => {
    if (r === 'edgeL?') take(i, used.has('edgeL1') ? 'edgeL2' : 'edgeL1')
    if (r === 'edgeW?') take(i, used.has('edgeW1') ? 'edgeW2' : 'edgeW1')
  })
  // 3) кромка без указания стороны — по порядку Дл, Дп, Шв, Шн
  rawRoles.forEach((r, i) => {
    if (r !== 'edge?') return
    const free = ['edgeL1', 'edgeL2', 'edgeW1', 'edgeW2'].find(x => !used.has(x))
    if (free) take(i, free)
  })
  // 4) слабое название
  rawRoles.forEach((r, i) => { if (r === 'name?') take(i, 'name') })
  return roles
}

function headerRolesAt(rows, r) {
  const row = rows[r] || []
  const above = r > 0 ? rows[r - 1] : null
  let carry = ''
  return row.map((c, i) => {
    const a = above ? above[i] : ''
    if (typeof a === 'string' && a) carry = a
    else if (a !== '' && a != null) carry = ''
    if (typeof c === 'number') return ''
    const edgeAbove = /кром|edge|облицов/i.test(carry)
    // двухэтажная шапка: «Кромка» сверху, «Д1 Д2 Ш1 Ш2» снизу
    if (c && edgeAbove) return roleByHeader(carry + ' ' + c)
    // ячейка шапки объединена по вертикали — название стоит строкой выше
    if (!c) return typeof a === 'string' && a ? roleByHeader(a) : ''
    return roleByHeader(c)
  })
}

// Без шапки: угадываем по числам
function guessWithoutHeader(rows) {
  const width = rows[0]?.length || 0
  const stats = []
  for (let c = 0; c < width; c++) {
    const vals = rows.map(r => r[c]).filter(v => v !== '' && v != null)
    const nums = vals.map(toNumber).filter(n => !Number.isNaN(n))
    const sorted = [...nums].sort((a, b) => a - b)
    stats.push({
      c, filled: vals.length,
      numeric: vals.length ? nums.length / vals.length : 0,
      median: sorted.length ? sorted[sorted.length >> 1] : 0,
      integer: nums.every(n => Number.isInteger(n)),
    })
  }
  const roles = Array(width).fill('')
  const numCols = stats.filter(s => s.filled >= 1 && s.numeric >= 0.6)
  const dims = numCols.filter(s => s.median >= 30).slice(0, 2)
  if (dims.length < 2) return null
  roles[dims[0].c] = 'length'
  roles[dims[1].c] = 'width'
  const qty = numCols.find(s => s.c > dims[1].c && s.integer && s.median >= 1 && s.median < 30)
  if (qty) roles[qty.c] = 'qty'
  const text = stats.find(s => s.filled >= 1 && s.numeric < 0.3 && !roles[s.c])
  if (text) roles[text.c] = 'name'
  return roles
}

// Колонка «кромка по длине/ширине» одна и в ней числа 0/1/2 — это количество сторон
function fixEdgeCounts(rows, headerRow, roles) {
  const out = [...roles]
  for (const [one, two, cnt] of [['edgeL1', 'edgeL2', 'edgeLn'], ['edgeW1', 'edgeW2', 'edgeWn']]) {
    const i = out.indexOf(one)
    if (i < 0 || out.includes(two)) continue
    const vals = rows.slice(headerRow + 1).map(r => r[i]).filter(v => v !== '' && v != null)
    const nums = vals.map(toNumber)
    if (vals.length && nums.every(n => n === 0 || n === 1 || n === 2) && nums.includes(2)) out[i] = cnt
  }
  return out
}

// -> { headerRow (-1 если шапки нет), roles: string[] }
export function analyzeTable(rows, forcedHeaderRow) {
  const width = rows[0]?.length || 0
  const scoreOf = roles => {
    const s = new Set(roles.filter(Boolean))
    const ok = (s.has('length') && s.has('width')) || s.has('size')
    return ok ? s.size : 0
  }
  if (forcedHeaderRow != null) {
    if (forcedHeaderRow < 0) return { headerRow: -1, roles: guessWithoutHeader(rows) || Array(width).fill('') }
    const roles = resolveRoles(headerRolesAt(rows, forcedHeaderRow))
    return { headerRow: forcedHeaderRow, roles: fixEdgeCounts(rows, forcedHeaderRow, roles) }
  }
  let best = { headerRow: -1, roles: null, score: 0 }
  for (let r = 0; r < Math.min(rows.length, 40); r++) {
    const roles = resolveRoles(headerRolesAt(rows, r))
    const score = scoreOf(roles)
    if (score > best.score) best = { headerRow: r, roles, score }
  }
  if (best.roles) return { headerRow: best.headerRow, roles: fixEdgeCounts(rows, best.headerRow, best.roles) }
  return { headerRow: -1, roles: guessWithoutHeader(rows) || Array(width).fill('') }
}

// ---------- Сборка деталей ----------

const EMPTY_EDGE = /^(0|-|—|–|нет|no|none|без)$/i
const MARK_EDGE = /^(\+|да|yes|есть|v|x|х|✓|✔|\*)$/i

function edgeValue(v, marksOnly) {
  if (v === '' || v == null) return null
  const s = String(v).trim()
  if (!s || EMPTY_EDGE.test(s)) return null
  if (MARK_EDGE.test(s)) return 'default'
  const n = toNumber(v)
  if (!Number.isNaN(n)) {
    if (n === 0) return null
    if (marksOnly) return 'default'
    return `${String(n).replace('.', ',')} мм`
  }
  return s.slice(0, 30)
}

// -> { items, skipped, groups: [{ key, material, thickness, count }] }
export function buildDetails(rows, headerRow, roles) {
  const col = r => roles.indexOf(r)
  const iName = col('name'), iLen = col('length'), iWid = col('width'), iSize = col('size')
  const iQty = col('qty'), iMat = col('material'), iThk = col('thickness'), iPfx = col('prefix')
  const edgeCols = { left: col('edgeL1'), right: col('edgeL2'), top: col('edgeW1'), bottom: col('edgeW2') }
  const iLn = col('edgeLn'), iWn = col('edgeWn')
  const data = rows.slice(headerRow + 1)

  // В колонке кромки только 0/1 — это отметки «есть/нет», а не толщина
  const marksOnly = {}
  for (const [side, i] of Object.entries(edgeCols)) {
    if (i < 0) continue
    const nums = data.map(r => r[i]).filter(v => v !== '' && v != null).map(toNumber)
    marksOnly[side] = nums.length > 0 && nums.every(n => n === 0 || n === 1)
  }

  const items = []
  let skipped = 0
  for (const r of data) {
    if (!r || r.every(c => c === '' || c == null)) continue
    let w = NaN, h = NaN, thk = iThk >= 0 ? toNumber(r[iThk]) : NaN
    if (iLen >= 0 && iWid >= 0) { w = toNumber(r[iLen]); h = toNumber(r[iWid]) }
    if ((Number.isNaN(w) || Number.isNaN(h)) && iSize >= 0) {
      const nums = (String(r[iSize]).match(/\d+(?:[.,]\d+)?/g) || []).map(x => parseFloat(x.replace(',', '.')))
      if (nums.length >= 2) { w = nums[0]; h = nums[1]; if (Number.isNaN(thk) && nums.length >= 3) thk = nums[2] }
    }
    w = Math.round(w); h = Math.round(h)
    if (!(w > 0) || !(h > 0)) { skipped++; continue }
    let qty = iQty >= 0 ? Math.round(toNumber(r[iQty])) : 1
    if (!(qty > 0)) qty = 1

    const edges = { top: null, right: null, bottom: null, left: null }
    for (const [side, i] of Object.entries(edgeCols)) if (i >= 0) edges[side] = edgeValue(r[i], marksOnly[side])
    if (iLn >= 0) { const n = toNumber(r[iLn]); if (n >= 1) edges.left = 'default'; if (n >= 2) edges.right = 'default' }
    if (iWn >= 0) { const n = toNumber(r[iWn]); if (n >= 1) edges.top = 'default'; if (n >= 2) edges.bottom = 'default' }

    const material = iMat >= 0 ? String(r[iMat] ?? '').trim() : ''
    const thickness = thk > 0 ? thk : null
    items.push({
      name: iName >= 0 ? String(r[iName] ?? '').trim().slice(0, 80) : '',
      w, h, qty, edges, material, thickness,
      prefix: iPfx >= 0 ? String(r[iPfx] ?? '').trim().slice(0, 40) : '',
      groupKey: `${material}|${thickness ?? ''}`,
    })
  }

  const map = new Map()
  for (const it of items) {
    const g = map.get(it.groupKey) || { key: it.groupKey, material: it.material, thickness: it.thickness, count: 0, pieces: 0 }
    g.count++; g.pieces += it.qty
    map.set(it.groupKey, g)
  }
  const groups = [...map.values()].sort((a, b) => b.pieces - a.pieces)
  return { items, skipped, groups }
}
