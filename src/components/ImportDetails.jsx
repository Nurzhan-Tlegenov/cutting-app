import { useState, useRef, useMemo } from 'react'
import { readTableFile, analyzeTable, buildDetails, ROLES } from '../lib/importDetails'
import { useAuth } from '../context/AuthContext'
import { getUserSettings, saveUserSettings } from '../lib/userSettings'

// Какую пласть считать лицевой при импорте из Базиса (копия списка из basisB3d — он грузится по требованию)
const FACE_RULES = [
  ['holes', 'Где больше глухих отверстий, затем — где паз'],
  ['groove', 'Где паз, затем — где больше глухих отверстий'],
  ['sum', 'Где больше обработки всего (отверстия + пазы)'],
  ['model', 'Как в модели Базиса (не переворачивать)'],
]

// Импорт деталей в карточку заказа: Excel/CSV, Базис-Мебельщик, PRO100.
// Базис-Мебельщик читается и напрямую из файла модели .b3d — с контуром,
// кромкой, пазами и присадкой.
// onImport({ items, mode: 'add' | 'replace', material, thickness, orderName })

const SOURCES = [
  { id: 'excel', icon: '📊', label: 'Excel / CSV',
    hint: 'Таблица .xlsx, .xls или .csv. Обязательны колонки Длина и Ширина, остальное — по желанию.' },
  { id: 'basis', icon: '📐', label: 'Базис-Мебельщик',
    hint: 'Выберите файл модели Базиса (.b3d) — возьмём детали с контуром, кромкой, пазами и присадкой. Подойдёт и таблица деталей из Базиса в Excel/CSV.' },
  { id: 'pro100', icon: '🪑', label: 'PRO100',
    hint: 'В PRO100 откройте отчёт со списком деталей, сохраните его в Excel или CSV и выберите этот файл.' },
]

const ACCEPT = '.xlsx,.xls,.csv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv,text/plain'
const ALL = '__all__'

const cellText = v => (v == null ? '' : String(v))
const groupLabel = g => `${g.material || 'Без материала'}${g.thickness ? ` · ${g.thickness} мм` : ''}`

export default function ImportDetails({ hasDetails, onImport }) {
  const fileRef = useRef(null)
  const auth = useAuth()
  const user = auth?.user || null
  const basisFileRef = useRef(null)              // выбранный .b3d — чтобы пересчитать при смене правила
  const [faceRule, setFaceRule] = useState(() => getUserSettings(user).basisFaceRule || 'holes')
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
  const [basis, setBasis] = useState(null)       // разобранная модель .b3d (вместо таблицы)

  const rows = useMemo(() => (sheets ? sheets[sheetIdx].rows : []), [sheets, sheetIdx])

  const applySheet = (allSheets, idx, forcedHeader) => {
    const a = analyzeTable(allSheets[idx].rows, forcedHeader)
    setSheetIdx(idx); setHeaderRow(a.headerRow); setRoles(a.roles)
    const res = buildDetails(allSheets[idx].rows, a.headerRow, a.roles)
    setGroupKey(res.groups.length > 1 ? res.groups[0].key : ALL)
  }

  const pick = (src) => {
    setSource(src); setError('')
    if (!fileRef.current) return
    // у .b3d нет своего типа — с фильтром телефон может не дать выбрать файл
    fileRef.current.accept = src.id === 'basis' ? '' : ACCEPT
    fileRef.current.click()
  }

  const onFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setBusy(true); setError('')
    try {
      const head = new Uint8Array(await file.slice(0, 4).arrayBuffer())
      const lower = file.name.toLowerCase()
      if ((head[0] === 0x42 && head[1] === 0x5A) || lower.endsWith('.b3d')) {
        const { readBasisFile } = await import('../lib/basisB3d')
        const rule = getUserSettings(user).basisFaceRule || faceRule
        setFaceRule(rule)
        basisFileRef.current = file
        const res = await readBasisFile(file, { faceRule: rule })
        if (!res.items.length) throw new Error('в модели нет панелей')
        setFileName(file.name); setSource(SOURCES[1]); setMode('add')
        setGroupKey(res.groups.length > 1 ? res.groups[0].key : ALL)
        setSheets(null); setBasis(res)
        return
      }
      if (lower.endsWith('.sto')) {
        throw new Error('файл проекта PRO100 (.sto) закрытого формата. Сохраните в PRO100 отчёт со списком деталей в Excel или CSV и выберите его.')
      }
      const { sheets: sh } = await readTableFile(file)
      // берём лист, на котором распознано больше всего деталей
      let bestIdx = 0, bestCount = -1
      sh.forEach((s, i) => {
        const a = analyzeTable(s.rows)
        const n = buildDetails(s.rows, a.headerRow, a.roles).items.length
        if (n > bestCount) { bestCount = n; bestIdx = i }
      })
      setFileName(file.name); setBasis(null); setSheets(sh); setMode('add')
      applySheet(sh, bestIdx)
    } catch (err) {
      setError('Не удалось прочитать файл: ' + (err?.message || err))
    } finally {
      setBusy(false)
    }
  }

  const result = useMemo(
    () => (basis ? { items: basis.items, skipped: 0, groups: basis.groups }
      : sheets ? buildDetails(rows, headerRow, roles) : { items: [], skipped: 0, groups: [] }),
    [basis, sheets, rows, headerRow, roles]
  )
  const activeKey = groupKey === ALL || result.groups.some(g => g.key === groupKey) ? groupKey : ALL
  const chosen = activeKey === ALL ? result.items : result.items.filter(it => it.groupKey === activeKey)
  const pieces = chosen.reduce((s, it) => s + it.qty, 0)
  const hasDims = !!basis || (roles.includes('length') && roles.includes('width')) || roles.includes('size')
  const sumInfo = k => chosen.reduce((s, it) => s + (it.info?.[k] || 0) * (k === 'shaped' ? 1 : it.qty), 0)
  const sumWarn = k => chosen.reduce((s, it) => s + (it.warn?.[k] || 0), 0)

  // Другое правило лицевой стороны — пересчитываем детали и запоминаем выбор за аккаунтом
  const changeFaceRule = async (rule) => {
    setFaceRule(rule)
    saveUserSettings({ basisFaceRule: rule }, user)
    if (!basisFileRef.current) return
    setBusy(true)
    try {
      const { readBasisFile } = await import('../lib/basisB3d')
      setBasis(await readBasisFile(basisFileRef.current, { faceRule: rule }))
    } catch (err) {
      setError('Не удалось прочитать файл: ' + (err?.message || err))
    } finally { setBusy(false) }
  }

  const setRole = (ci, role) => setRoles(prev => prev.map((r, i) => (i === ci ? role : (role && r === role ? '' : r))))

  const close = () => { setSheets(null); setBasis(null) }

  const doImport = async () => {
    let model3d = null
    if (basis?.scene) {
      try { const { packScene } = await import('../lib/basisB3d'); model3d = packScene(basis.scene) } catch { model3d = null }
    }
    const g = activeKey === ALL
      ? (result.groups.length === 1 ? result.groups[0] : null)
      : result.groups.find(x => x.key === activeKey)
    onImport({
      items: chosen.map(it => ({
        name: it.name, w: it.w, h: it.h, qty: it.qty, edges: it.edges, prefix: it.prefix,
        contour: it.contour || null, rotatable: !!it.rotatable,
      })),
      mode: hasDetails ? mode : 'replace',
      material: g?.material || '',
      thickness: g?.thickness || null,
      orderName: basis?.orderName || '',
      model3d,                                   // вся модель Базиса для 3D-просмотра (упакована)
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

      {(sheets || basis) && (
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

            {sheets && sheets.length > 1 && (
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
            {sheets && <>
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
            </>}

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

            {/* Лицевая сторона */}
            {basis && (
              <div style={{ marginBottom: 12 }}>
                <label className="label">Лицевая сторона детали (смотрит вверх на станке)</label>
                <select value={faceRule} disabled={busy} onChange={e => changeFaceRule(e.target.value)} style={{ padding: '7px 8px', fontSize: 13 }}>
                  {FACE_RULES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
                <p style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 4 }}>
                  Обработка с изнанки не теряется: она остаётся в детали и видна в редакторе контура, там же деталь можно перевернуть.
                  {chosen.length > 0 && ` Деталей с обработкой с двух сторон: ${chosen.filter(it => it.info?.back > 0).length}.`}
                </p>
              </div>
            )}

            {/* Что получится */}
            {basis && chosen.length > 0 && (
              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
                Присадка: {sumInfo('holes')} отв. · пазов: {sumInfo('grooves')} · фигурных деталей: {sumInfo('shaped')} · вырезов: {sumInfo('cutouts')}
              </p>
            )}
            {basis && (sumWarn('open') + sumWarn('edges') + sumWarn('edgeHoles') + sumWarn('cuts') > 0) && (
              <div style={{ background: 'var(--amber-light)', border: '0.5px solid var(--amber)', borderRadius: 'var(--radius)', padding: '8px 10px', marginBottom: 10, fontSize: 12, color: 'var(--amber)' }}>
                Не всё удалось перенести — проверьте эти детали в редакторе контура:
                {sumWarn('open') > 0 && <div>· незамкнутый контур: {sumWarn('open')}</div>}
                {sumWarn('edges') > 0 && <div>· кромка на фигурном крае: {sumWarn('edges')}</div>}
                {sumWarn('edgeHoles') > 0 && <div>· торцевые отверстия не на прямой стороне: {sumWarn('edgeHoles')}</div>}
                {sumWarn('cuts') > 0 && <div>· пазы/профили сложной формы: {sumWarn('cuts')}</div>}
              </div>
            )}
            {chosen.length > 0 && (
              <div style={{ background: 'var(--bg)', border: '0.5px solid var(--border)', borderRadius: 'var(--radius)', padding: '8px 10px', fontSize: 12 }}>
                {chosen.slice(0, basis ? 300 : 5).map((it, i) => {
                  const e = it.edges
                  const edgeTxt = [['left', 'Дл'], ['right', 'Дп'], ['top', 'Шв'], ['bottom', 'Шн']]
                    .filter(([k]) => e[k]).map(([k, s]) => (basis || e[k] === 'default' ? s : `${s}:${e[k]}`)).join(' ')
                  const inf = it.info
                  const extra = inf ? [
                    inf.shaped && 'контур', inf.cutouts > 0 && `вырезов ${inf.cutouts}`,
                    inf.holes > 0 && `отв. ${inf.holes}`, inf.grooves > 0 && `паз ${inf.grooves}`,
                    inf.back > 0 && 'с двух сторон',
                  ].filter(Boolean).join(' · ') : ''
                  return (
                    <div key={i} style={{ padding: '4px 0', borderTop: i ? '0.5px solid var(--border)' : 'none' }}>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>
                          {it.prefix ? `${it.prefix} · ` : ''}{it.name || `Деталь ${i + 1}`}
                        </span>
                        <span style={{ whiteSpace: 'nowrap' }}>{it.w}×{it.h} — {it.qty} шт.</span>
                      </div>
                      {(edgeTxt || extra) && (
                        <div style={{ display: 'flex', gap: 8, fontSize: 11 }}>
                          {edgeTxt && <span style={{ color: 'var(--blue)', whiteSpace: 'nowrap' }}>{edgeTxt}</span>}
                          {extra && <span style={{ color: 'var(--teal)' }}>{extra}</span>}
                        </div>
                      )}
                    </div>
                  )
                })}
                {chosen.length > (basis ? 300 : 5) && <div style={{ color: 'var(--text-hint)', paddingTop: 4 }}>…и ещё {chosen.length - (basis ? 300 : 5)}</div>}
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
