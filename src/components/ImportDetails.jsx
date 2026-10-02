import { useState, useRef, useMemo } from 'react'
import { readTableFile, analyzeTable, buildDetails, ROLES } from '../lib/importDetails'

// Импорт деталей в карточку заказа: Excel/CSV, Базис-Мебельщик, PRO100.
// onImport({ items, mode: 'add' | 'replace', material, thickness })

const SOURCES = [
  { id: 'excel', icon: '📊', label: 'Excel / CSV',
    hint: 'Таблица .xlsx, .xls или .csv. Обязательны колонки Длина и Ширина, остальное — по желанию.' },
  { id: 'basis', icon: '📐', label: 'Базис-Мебельщик',
    hint: 'В Базисе выгрузите список деталей (спецификацию) в Excel или CSV и выберите этот файл.' },
  { id: 'pro100', icon: '🪑', label: 'PRO100',
    hint: 'В PRO100 откройте отчёт со списком деталей, сохраните его в Excel или CSV и выберите этот файл.' },
]

const ACCEPT = '.xlsx,.xls,.csv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv,text/plain'
const ALL = '__all__'

const cellText = v => (v == null ? '' : String(v))
const groupLabel = g => `${g.material || 'Без материала'}${g.thickness ? ` · ${g.thickness} мм` : ''}`

export default function ImportDetails({ hasDetails, onImport }) {
  const fileRef = useRef(null)
  const [source, setSource] = useState(SOURCES[0])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const [fileName, setFileName] = useState('')
  const [sheets, setSheets] = useState(null)     // null — окно закрыто
  const [sheetIdx, setSheetIdx] = useState(0)
  const [headerRow, setHeaderRow] = useState(-1)
  const [roles, setRoles] = useState([])
  const [groupKey, setGroupKey] = useState(ALL)
  const [mode, setMode] = useState('add')

  const rows = useMemo(() => (sheets ? sheets[sheetIdx].rows : []), [sheets, sheetIdx])

  const applySheet = (allSheets, idx, forcedHeader) => {
    const a = analyzeTable(allSheets[idx].rows, forcedHeader)
    setSheetIdx(idx); setHeaderRow(a.headerRow); setRoles(a.roles)
    const res = buildDetails(allSheets[idx].rows, a.headerRow, a.roles)
    setGroupKey(res.groups.length > 1 ? res.groups[0].key : ALL)
  }

  const pick = (src) => { setSource(src); setError(''); fileRef.current?.click() }

  const onFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setBusy(true); setError('')
    try {
      const { sheets: sh } = await readTableFile(file)
      // берём лист, на котором распознано больше всего деталей
      let bestIdx = 0, bestCount = -1
      sh.forEach((s, i) => {
        const a = analyzeTable(s.rows)
        const n = buildDetails(s.rows, a.headerRow, a.roles).items.length
        if (n > bestCount) { bestCount = n; bestIdx = i }
      })
      setFileName(file.name); setSheets(sh); setMode('add')
      applySheet(sh, bestIdx)
    } catch (err) {
      setError('Не удалось прочитать файл: ' + (err?.message || err))
    } finally {
      setBusy(false)
    }
  }

  const result = useMemo(
    () => (sheets ? buildDetails(rows, headerRow, roles) : { items: [], skipped: 0, groups: [] }),
    [sheets, rows, headerRow, roles]
  )
  const activeKey = groupKey === ALL || result.groups.some(g => g.key === groupKey) ? groupKey : ALL
  const chosen = activeKey === ALL ? result.items : result.items.filter(it => it.groupKey === activeKey)
  const pieces = chosen.reduce((s, it) => s + it.qty, 0)
  const hasDims = (roles.includes('length') && roles.includes('width')) || roles.includes('size')

  const setRole = (ci, role) => setRoles(prev => prev.map((r, i) => (i === ci ? role : (role && r === role ? '' : r))))

  const close = () => setSheets(null)

  const doImport = () => {
    const g = activeKey === ALL
      ? (result.groups.length === 1 ? result.groups[0] : null)
      : result.groups.find(x => x.key === activeKey)
    onImport({
      items: chosen.map(it => ({ name: it.name, w: it.w, h: it.h, qty: it.qty, edges: it.edges, prefix: it.prefix })),
      mode: hasDetails ? mode : 'replace',
      material: g?.material || '',
      thickness: g?.thickness || null,
    })
    close()
  }

  const previewRows = rows.slice(headerRow + 1, headerRow + 7)
  const colCount = rows[0]?.length || 0
  const chip = (active) => ({
    padding: '6px 12px', borderRadius: 20, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap',
    border: '0.5px solid var(--border-md)',
    background: active ? 'var(--blue)' : 'transparent', color: active ? 'white' : 'var(--text-muted)',
  })

  return (
    <div style={{ marginBottom: 14 }}>
      <p className="section-title">Импорт деталей</p>
      <div className="card" style={{ background: 'var(--bg2)' }}>
        <div style={{ display: 'flex', gap: 6 }}>
          {SOURCES.map(s => (
            <button key={s.id} type="button" disabled={busy} onClick={() => pick(s)}
              style={{ flex: 1, padding: '10px 4px', border: '0.5px solid var(--border-md)', borderRadius: 'var(--radius)',
                background: 'var(--bg)', color: 'var(--text)', fontSize: 12, cursor: 'pointer', textAlign: 'center', lineHeight: 1.3 }}>
              <div style={{ fontSize: 18 }}>{s.icon}</div>
              {s.label}
            </button>
          ))}
        </div>
        <input ref={fileRef} type="file" accept={ACCEPT} onChange={onFile} style={{ display: 'none' }} />
        {busy && <p style={{ fontSize: 12, color: 'var(--text-hint)', marginTop: 8, textAlign: 'center' }}>Читаю файл…</p>}
        {error && <p className="error-text" style={{ marginTop: 8 }}>{error}</p>}
      </div>

      {sheets && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 900, background: 'var(--bg2)', display: 'flex', flexDirection: 'column' }}>
          {/* Шапка */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', background: 'var(--bg)', borderBottom: '0.5px solid var(--border)' }}>
            <button type="button" onClick={close}
              style={{ background: 'none', border: 'none', color: 'var(--blue)', fontSize: 22, padding: 0, lineHeight: 1 }}>←</button>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 16, fontWeight: 500 }}>Импорт · {source.label}</div>
              <div style={{ fontSize: 11, color: 'var(--text-hint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fileName}</div>
            </div>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: 14 }}>
            <p style={{ fontSize: 12, color: 'var(--text-hint)', marginBottom: 12 }}>{source.hint}</p>

            {sheets.length > 1 && (
              <div style={{ marginBottom: 12 }}>
                <label className="label">Лист</label>
                <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 2 }}>
                  {sheets.map((s, i) => (
                    <button key={i} type="button" style={chip(i === sheetIdx)} onClick={() => applySheet(sheets, i)}>{s.name}</button>
                  ))}
                </div>
              </div>
            )}

            {/* Колонки */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
              <label className="label" style={{ marginBottom: 0 }}>Колонки — проверьте, что распознано верно</label>
              <select value={headerRow} onChange={e => applySheet(sheets, sheetIdx, Number(e.target.value))}
                style={{ width: 'auto', padding: '4px 6px', fontSize: 12 }}>
                <option value={-1}>без шапки</option>
                {rows.slice(0, 40).map((_, i) => <option key={i} value={i}>шапка: строка {i + 1}</option>)}
              </select>
            </div>
            <div style={{ overflowX: 'auto', background: 'var(--bg)', border: '0.5px solid var(--border)', borderRadius: 'var(--radius)', marginBottom: 12 }}>
              <table style={{ borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr>
                    {Array.from({ length: colCount }, (_, ci) => (
                      <th key={ci} style={{ padding: 4, minWidth: 96, verticalAlign: 'top', fontWeight: 400 }}>
                        <select value={roles[ci] || ''} onChange={e => setRole(ci, e.target.value)}
                          style={{ padding: '5px 4px', fontSize: 12,
                            borderColor: roles[ci] ? 'var(--blue)' : 'var(--border-md)',
                            background: roles[ci] ? 'var(--blue-light)' : 'var(--bg)',
                            color: roles[ci] ? 'var(--blue-dark)' : 'var(--text-hint)' }}>
                          {ROLES.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
                        </select>
                        {headerRow >= 0 && (
                          <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 500, padding: '4px 2px 0', textAlign: 'left',
                            maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {cellText(rows[headerRow]?.[ci]) || cellText(rows[headerRow - 1]?.[ci]) || '\u00A0'}
                          </div>
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((r, ri) => (
                    <tr key={ri} style={{ borderTop: '0.5px solid var(--border)' }}>
                      {Array.from({ length: colCount }, (_, ci) => (
                        <td key={ci} style={{ padding: '5px 6px', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          color: roles[ci] ? 'var(--text)' : 'var(--text-hint)' }}>
                          {cellText(r[ci])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {!hasDims && (
              <p className="error-text" style={{ marginBottom: 12 }}>
                Укажите над таблицей, в каких колонках Длина и Ширина (или одна колонка «Размер Д×Ш»).
              </p>
            )}

            {/* Материалы */}
            {result.groups.length > 1 && (
              <div style={{ marginBottom: 12 }}>
                <label className="label">В файле несколько материалов — какой берём в этот заказ</label>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {result.groups.map(g => (
                    <button key={g.key} type="button" style={{ ...chip(activeKey === g.key), whiteSpace: 'normal', textAlign: 'left' }}
                      onClick={() => setGroupKey(g.key)}>
                      {groupLabel(g)} · {g.pieces} шт.
                    </button>
                  ))}
                  <button type="button" style={chip(activeKey === ALL)} onClick={() => setGroupKey(ALL)}>Все вместе</button>
                </div>
              </div>
            )}

            {/* Добавить / заменить */}
            {hasDetails && (
              <div style={{ marginBottom: 12 }}>
                <label className="label">В заказе уже есть детали</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button type="button" style={chip(mode === 'add')} onClick={() => setMode('add')}>Добавить к ним</button>
                  <button type="button" style={chip(mode === 'replace')} onClick={() => setMode('replace')}>Заменить</button>
                </div>
              </div>
            )}

            {/* Что получится */}
            {chosen.length > 0 && (
              <div style={{ background: 'var(--bg)', border: '0.5px solid var(--border)', borderRadius: 'var(--radius)', padding: '8px 10px', fontSize: 12 }}>
                {chosen.slice(0, 5).map((it, i) => {
                  const e = it.edges
                  const edgeTxt = [['left', 'Дл'], ['right', 'Дп'], ['top', 'Шв'], ['bottom', 'Шн']]
                    .filter(([k]) => e[k]).map(([k, s]) => (e[k] === 'default' ? s : `${s}:${e[k]}`)).join(' ')
                  return (
                    <div key={i} style={{ display: 'flex', gap: 8, padding: '3px 0', borderTop: i ? '0.5px solid var(--border)' : 'none' }}>
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>
                        {it.prefix ? `${it.prefix} · ` : ''}{it.name || `Деталь ${i + 1}`}
                      </span>
                      <span style={{ whiteSpace: 'nowrap' }}>{it.w}×{it.h} — {it.qty} шт.</span>
                      {edgeTxt && <span style={{ color: 'var(--blue)', whiteSpace: 'nowrap' }}>{edgeTxt}</span>}
                    </div>
                  )
                })}
                {chosen.length > 5 && <div style={{ color: 'var(--text-hint)', paddingTop: 4 }}>…и ещё {chosen.length - 5}</div>}
              </div>
            )}
          </div>

          {/* Низ */}
          <div style={{ padding: '10px 14px calc(10px + env(safe-area-inset-bottom))', background: 'var(--bg)', borderTop: '0.5px solid var(--border)' }}>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8, textAlign: 'center' }}>
              Найдено: {chosen.length} поз. · {pieces} шт.
              {result.skipped > 0 && <span style={{ color: 'var(--text-hint)' }}> · строк без размеров пропущено: {result.skipped}</span>}
            </p>
            <button type="button" className="btn-primary" disabled={!chosen.length} onClick={doImport}>
              {chosen.length ? `Импортировать ${chosen.length} поз.` : 'Нет деталей для импорта'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
