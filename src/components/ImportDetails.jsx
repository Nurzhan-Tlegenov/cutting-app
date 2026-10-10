import { useState, useRef, useMemo, useEffect } from 'react'
// Чтение моделей лежит в основной части приложения, а не подгружается отдельно: после обновления приложения
// у открытой страницы адреса подгружаемых частей устаревают, и импорт падал с «Failed to fetch dynamically imported module».
import { readBasisFile, packScene } from '../lib/basisB3d'
import { readAstraFile } from '../lib/astraAdd'
import { readAstraXmlFile, looksLikeAstraXml } from '../lib/astraXml'
import { readPro100Obj } from '../lib/pro100Obj'
import { readSketchCutPdf } from '../lib/sketchcutPdf'
import { millsFromItems, mergeMills } from '../lib/facadeCarve'
import { readTableFile, analyzeTable, buildDetails, ROLES } from '../lib/importDetails'
import { useAuth } from '../context/AuthContext'
import { myLimits, limitText } from '../lib/limits'
import { getUserSettings, saveUserSettings } from '../lib/userSettings'

// Какую пласть считать лицевой при импорте модели (копия списка из basisB3d — он грузится по требованию)
const FACE_RULES = [
  ['holes', 'Где больше глухих отверстий, затем — где паз'],
  ['groove', 'Где паз, затем — где больше глухих отверстий'],
  ['sum', 'Где больше обработки всего (отверстия + пазы)'],
  ['model', 'Как в модели (не переворачивать)'],
]

// Импорт деталей в карточку заказа: Excel/CSV, Базис-Мебельщик, Астра, PRO100, SketchCut (PDF).
// Базис-Мебельщик (.b3d) и Астра Конструктор Мебели (.add) читаются напрямую
// из файла модели — с контуром, кромкой, пазами и присадкой.
// onImport({ items, mode: 'add' | 'replace', material, thickness, orderName })

const SOURCES = [
  { id: 'excel', icon: '📊', label: 'Excel / CSV',
    hint: 'Таблица .xlsx, .xls или .csv. Обязательны колонки Длина и Ширина, остальное — по желанию.' },
  { id: 'basis', icon: '📐', label: 'Базис-Мебельщик',
    hint: 'Выберите файл модели Базиса (.b3d) — возьмём детали с контуром, кромкой, пазами и присадкой. Подойдёт и таблица деталей из Базиса в Excel/CSV.' },
  { id: 'astra', icon: '🧩', label: 'Астра',
    hint: 'Выберите файл проекта «Астра Конструктор Мебели» (.add) — возьмём детали с контуром, кромкой, пазами, присадкой и 3D-моделью. Если проект не читается — подойдёт XML из Астры (Файл → Экспорт XML), но без 3D.' },
  { id: 'pro100', icon: '🪑', label: 'PRO100',
    hint: 'Выберите модель, сохранённую из PRO100 в формате OBJ (Файл → Экспорт) — возьмём панели с размерами и 3D-модель; названия, кромку и присадку нужно будет добавить в приложении. Подойдёт и отчёт со списком деталей в Excel или CSV.' },
  { id: 'sketchcut', icon: '📄', label: 'SketchCut',
    hint: 'Выберите PDF, сохранённый из SketchCut, — возьмём детали из таблицы «Детали» и кромку: чёрточки под размером показывают, на скольких сторонах она стоит (одна — на одной, две — на обеих).' },
]

const ACCEPT = '.xlsx,.xls,.csv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv,text/plain'
const ALL = '__all__'

// Файл модели: Базис (.b3d, 'BZ…'), Астра (.add, составной файл OLE2), PRO100 (.obj). Иначе — null (это таблица).
async function readModelFile(file, faceRule) {
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer())
  const lower = file.name.toLowerCase()
  // PDF из SketchCut ('%PDF')
  if ((head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) || lower.endsWith('.pdf')) {
    return { src: 'sketchcut', res: await readSketchCutPdf(file) }
  }
  if ((head[0] === 0x42 && head[1] === 0x5A) || lower.endsWith('.b3d')) {
    return { src: 'basis', res: await readBasisFile(file, { faceRule }) }
  }
  const ole = head[0] === 0xD0 && head[1] === 0xCF && head[2] === 0x11 && head[3] === 0xE0
  if (lower.endsWith('.add') || (ole && !/\.xls$/.test(lower))) {
    return { src: 'astra', res: await readAstraFile(file, { faceRule }) }
  }
  // XML-экспорт Астры
  const h = new TextDecoder('latin1').decode(head)
  if (lower.endsWith('.xml') || h.trimStart().startsWith('<')) {
    const probe = new TextDecoder('latin1').decode(new Uint8Array(await file.slice(0, 4000).arrayBuffer()))
    if (!looksLikeAstraXml(probe) && !/<data_order|<list_materials/.test(probe)) throw new Error('это не XML-экспорт Астры (нужен файл из «Файл → Экспорт XML»)')
    return { src: 'astra', res: await readAstraXmlFile(file, { faceRule }) }
  }
  // модель PRO100, сохранённая в OBJ
  if (lower.endsWith('.obj')) {
    return { src: 'pro100', res: await readPro100Obj(file, { faceRule }) }
  }
  return null
}

const cellText = v => (v == null ? '' : String(v))
const groupLabel = g => `${g.material || 'Без материала'}${g.thickness ? ` · ${g.thickness} мм` : ''}`

export default function ImportDetails({ hasDetails, onImport }) {
  const fileRef = useRef(null)
  const auth = useAuth()
  const user = auth?.user || null
  const basisFileRef = useRef(null)              // выбранный файл модели — чтобы пересчитать при смене правила
  const [faceRule, setFaceRule] = useState(() => getUserSettings(user).basisFaceRule || 'holes')
  const [source, setSource] = useState(SOURCES[0])
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)        // блок свёрнут, пока не нажали «Импорт деталей»
  const [error, setError] = useState('')

  const [fileName, setFileName] = useState('')
  const [sheets, setSheets] = useState(null)     // null — окно закрыто
  const [sheetIdx, setSheetIdx] = useState(0)
  const [headerRow, setHeaderRow] = useState(-1)
  const [roles, setRoles] = useState([])
  const [groupKey, setGroupKey] = useState(ALL)
  // лимит бесплатного использования: сколько материалов можно взять за один импорт (null — сколько угодно)
  const [matCap, setMatCap] = useState(null)
  useEffect(() => { let alive = true; myLimits().then(l => { if (alive) setMatCap(l?.limits?.import_mats?.limit ?? null) }); return () => { alive = false } }, [])
  const [mode, setMode] = useState('add')
  const [basis, setBasis] = useState(null)       // разобранная модель Базиса или Астры (вместо таблицы)

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
    // у .b3d и .add нет своего типа — с фильтром телефон может не дать выбрать файл
    fileRef.current.accept = src.id === 'excel' ? ACCEPT : src.id === 'sketchcut' ? '.pdf,application/pdf' : ''
    fileRef.current.click()
  }

  const onFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setBusy(true); setError('')
    try {
      const lower = file.name.toLowerCase()
      const rule = getUserSettings(user).basisFaceRule || faceRule
      const model = await readModelFile(file, rule)
      if (model) {
        const { res } = model
        setFaceRule(rule)
        basisFileRef.current = file
        if (!res.items.length) throw new Error(res.pdf ? 'в файле нет деталей' : 'в модели нет панелей')
        setFileName(file.name); setSource(SOURCES.find(x => x.id === model.src)); setMode('add')
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
  // «Все вместе» — только если материалов не больше лимита; иначе по умолчанию первый материал
  const allowAll = matCap == null || result.groups.length <= matCap
  const activeKey = result.groups.some(g => g.key === groupKey) ? groupKey : (allowAll || !result.groups.length ? ALL : result.groups[0].key)
  const chosen = activeKey === ALL ? result.items : result.items.filter(it => it.groupKey === activeKey)
  const pieces = chosen.reduce((s, it) => s + it.qty, 0)
  const hasDims = !!basis || (roles.includes('length') && roles.includes('width')) || roles.includes('size')
  const sumInfo = k => chosen.reduce((s, it) => s + (it.info?.[k] || 0) * (k === 'shaped' ? 1 : it.qty), 0)
  const sumWarn = k => chosen.reduce((s, it) => s + (it.warn?.[k] || 0), 0)
  // детали, которые в модели входят друг в друга (хотя бы одна из пары — в выбранном материале)
  const clashes = (basis?.clashes || []).filter(c => activeKey === ALL || c.a.groupKey === activeKey || c.b.groupKey === activeKey)
  const clashName = sd => [sd.des, sd.name].filter(Boolean).join(' ') || 'деталь'

  // Другое правило лицевой стороны — пересчитываем детали и запоминаем выбор за аккаунтом
  const changeFaceRule = async (rule) => {
    setFaceRule(rule)
    saveUserSettings({ basisFaceRule: rule }, user)
    if (!basisFileRef.current) return
    setBusy(true)
    try {
      const model = await readModelFile(basisFileRef.current, rule)
      if (model) setBasis(model.res)
    } catch (err) {
      setError('Не удалось прочитать файл: ' + (err?.message || err))
    } finally { setBusy(false) }
  }

  const setRole = (ci, role) => setRoles(prev => prev.map((r, i) => (i === ci ? role : (role && r === role ? '' : r))))

  const close = () => { setSheets(null); setBasis(null) }

  const doImport = async () => {
    let model3d = null
    if (basis?.scene) {
      try { model3d = packScene(basis.scene) } catch { model3d = null }
    }
    if (basis) {
      // типы фасадных фрез из модели — в каталог пользователя (Профиль → Фасадные фрезы)
      try {
        const found = millsFromItems(basis.items)
        if (found.length) saveUserSettings({ facadeMills: mergeMills(getUserSettings(user).facadeMills, found) }, user)
      } catch { /* каталог — не главное */ }
    }
    const g = activeKey === ALL
      ? (result.groups.length === 1 ? result.groups[0] : null)
      : result.groups.find(x => x.key === activeKey)
    setOpen(false)
    onImport({
      items: chosen.map(it => ({
        name: it.name, w: it.w, h: it.h, qty: it.qty, edges: it.edges, prefix: it.prefix,
        contour: it.contour || null, rotatable: !!it.rotatable,
      })),
      mode: hasDetails ? mode : 'replace',
      material: g?.material || '',
      thickness: g?.thickness || null,
      orderName: basis?.orderName || '',
      model3d,                                   // вся модель для 3D-просмотра (упакована)
      edgeTypes: basis?.edgeTypes || null,       // толщина видов кромки, если она есть в файле (SketchCut)
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
      <button type="button" onClick={() => setOpen(v => !v)} aria-expanded={open}
        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', border: '0.5px solid var(--border-md)', borderRadius: 'var(--radius)',
          background: 'var(--bg2)', color: 'var(--text)', fontSize: 14, cursor: 'pointer', textAlign: 'left' }}>
        <span style={{ fontSize: 16 }}>📥</span>
        <span style={{ flex: '0 0 auto', fontWeight: 500 }}>Импорт деталей</span>
        <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: 'var(--text-hint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{busy ? 'читаю файл…' : open ? '' : 'Excel, Базис, Астра, PRO100, SketchCut'}</span>
        <span style={{ color: 'var(--text-hint)', fontSize: 12, transform: open ? 'rotate(180deg)' : 'none' }}>▾</span>
      </button>
      {!open && error && <p className="error-text" style={{ marginTop: 6 }}>{error}</p>}
      <div className="card" style={{ background: 'var(--bg2)', marginTop: 6, display: open ? 'block' : 'none' }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {SOURCES.map(s => (
            <button key={s.id} type="button" disabled={busy} onClick={() => pick(s)}
              style={{ flex: '1 1 30%', minWidth: 0, padding: '10px 4px', border: '0.5px solid var(--border-md)', borderRadius: 'var(--radius)',
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
                  {allowAll
                    ? <button type="button" style={chip(activeKey === ALL)} onClick={() => setGroupKey(ALL)}>Все вместе</button>
                    : <button type="button" style={{ ...chip(false), opacity: 0.5 }} onClick={() => window.alert(limitText('import_mats', matCap))}>Все вместе 🔒</button>}
                </div>
                {!allowAll && <div style={{ fontSize: 11, color: 'var(--amber)', marginTop: 4 }}>Бесплатно — не больше {matCap} материал{matCap === 1 ? 'а' : 'ов'} за один импорт. Остальные можно загрузить в другие заказы.</div>}
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
            {basis?.bare && (
              <div style={{ background: 'var(--bg2)', borderRadius: 'var(--radius)', padding: '8px 10px', marginBottom: 10, fontSize: 12, color: 'var(--text-muted)' }}>
                В OBJ есть только размеры и положение панелей. Названия подставлены по положению в модели (полка / стойка / планка), длиной считается большая сторона.
                Материал, кромку и присадку добавьте в заказе.{basis.other > 0 && ` Прочие объекты (не панели): ${basis.other} — только в 3D.`}
              </div>
            )}
            {(clashes.length > 0 || sumWarn('foreign') > 0) && (
              <div style={{ background: 'var(--danger-light)', border: '0.5px solid var(--danger)', borderRadius: 'var(--radius)', padding: '8px 10px', marginBottom: 10, fontSize: 12, color: 'var(--danger)' }}>
                <b>Ошибка в модели: детали входят друг в друга{clashes.length > 0 && ` (${clashes.length})`}</b>
                {clashes.slice(0, 30).map((c, i) => (
                  <div key={i}>· {clashName(c.a)} ↔ {clashName(c.b)} — на {c.depth} мм{c.a.material !== c.b.material && ` (${c.b.material})`}</div>
                ))}
                {clashes.length > 30 && <div>…и ещё {clashes.length - 30}</div>}
                {sumWarn('foreign') > 0 && (
                  <div style={{ marginTop: 4 }}>
                    Чужие отверстия на эти детали не перенесены: {sumWarn('foreign')} отв. — у каждой детали осталась только её собственная присадка.
                  </div>
                )}
                <div style={{ marginTop: 4 }}>Размеры деталей взяты как в модели. Исправьте модель у конструктора или проверьте эти детали перед раскроем.</div>
              </div>
            )}
            {basis && !basis.bare && !basis.pdf && (
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

            {/* PDF из SketchCut: сверка с итогами самого файла */}
            {basis?.pdf && (() => {
              const p = basis.pdf
              const m = v => String(v).replace('.', ',')
              const piecesBad = p.filePieces != null && p.filePieces !== p.pieces
              const edgeBad = p.edgeChecked && !p.edgeOk
              const bad = piecesBad || edgeBad
              return (
                <div style={{ background: bad ? 'var(--amber-light)' : 'var(--bg)', border: `0.5px solid ${bad ? 'var(--amber)' : 'var(--border)'}`,
                  borderRadius: 'var(--radius)', padding: '8px 10px', marginBottom: 10, fontSize: 12, color: bad ? 'var(--amber)' : 'var(--text-muted)' }}>
                  <div>
                    Деталей: {p.pieces} шт.
                    {p.filePieces != null && (piecesBad ? ` — а в файле указано ${p.filePieces}. Проверьте список.` : ' — сходится с файлом ✓')}
                  </div>
                  <div>
                    Кромка: {m(p.edgeMeters)} м
                    {p.fileEdgeMeters != null && (edgeBad ? ` — а в файле указано ${m(p.fileEdgeMeters)} м. Проверьте кромку на деталях.` : p.edgeChecked ? ' — сходится с файлом ✓' : '')}
                  </div>
                  {basis.groups[0] && !basis.groups[0].material && <div style={{ color: 'var(--text-hint)', marginTop: 2 }}>Материал в файле не указан — выберите его в заказе.</div>}
                </div>
              )
            })()}

            {/* Что получится */}
            {basis && !basis.bare && !basis.pdf && chosen.length > 0 && (
              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
                Присадка: {sumInfo('holes')} отв. · пазов: {sumInfo('grooves')} · фигурных деталей: {sumInfo('shaped')} · вырезов: {sumInfo('cutouts')}
                {sumInfo('shapedEdges') > 0 && ` · кромка на фигурных участках: ${sumInfo('shapedEdges')}`}
              </p>
            )}
            {basis && sumInfo('decor') > 0 && (
              <div style={{ background: 'var(--amber-light)', border: '0.5px solid var(--amber)', borderRadius: 'var(--radius)', padding: '8px 10px', marginBottom: 10, fontSize: 12, color: 'var(--amber)' }}>
                Фрезеровка фасадов (скругление кромки, V-паз, выемка): {sumInfo('decor')} — показывается объёмно в 3D, на раскрой и присадку не влияет. Типы фрез добавятся в Профиль → Фасадные фрезы.
              </div>
            )}
            {basis && !basis.scene && !basis.pdf && (
              <div style={{ background: 'var(--bg2)', borderRadius: 'var(--radius)', padding: '8px 10px', marginBottom: 10, fontSize: 12, color: 'var(--text-muted)' }}>
                В XML нет положения деталей в изделии — 3D-модели по этому файлу не будет. Для 3D импортируйте файл проекта (.add).
              </div>
            )}
            {basis && sumWarn('ends') > 0 && (
              <div style={{ background: 'var(--amber-light)', border: '0.5px solid var(--amber)', borderRadius: 'var(--radius)', padding: '8px 10px', marginBottom: 10, fontSize: 12, color: 'var(--amber)' }}>
                Торцевые отверстия на длинных сторонах: у {chosen.filter(it => it.warn?.ends > 0).length} дет. в XML не видно, от какого конца стороны они отсчитаны ({sumWarn('ends')} отв.).
                Проверьте эти детали в редакторе контура или импортируйте файл проекта (.add) — там это однозначно.
              </div>
            )}
            {basis && (sumWarn('open') + sumWarn('edges') + sumWarn('edgeHoles') + sumWarn('cuts') > 0) && (
              <div style={{ background: 'var(--amber-light)', border: '0.5px solid var(--amber)', borderRadius: 'var(--radius)', padding: '8px 10px', marginBottom: 10, fontSize: 12, color: 'var(--amber)' }}>
                Не всё удалось перенести — проверьте эти детали в редакторе контура:
                {sumWarn('open') > 0 && <div>· незамкнутый контур: {sumWarn('open')}</div>}
                {sumWarn('edges') > 0 && <div>· кромка, для которой не нашёлся участок контура: {sumWarn('edges')}</div>}
                {sumWarn('edgeHoles') > 0 && <div>· торцевые отверстия не на прямой стороне: {sumWarn('edgeHoles')}</div>}
                {sumWarn('cuts') > 0 && <div>· обработка, которую не удалось прочитать: {sumWarn('cuts')}</div>}
              </div>
            )}
            {chosen.length > 0 && (
              <div style={{ background: 'var(--bg)', border: '0.5px solid var(--border)', borderRadius: 'var(--radius)', padding: '8px 10px', fontSize: 12 }}>
                {chosen.slice(0, basis ? 300 : 5).map((it, i) => {
                  const e = it.edges
                  const edgeTxt = [['left', 'Дл'], ['right', 'Дп'], ['top', 'Шв'], ['bottom', 'Шн']]
                    .filter(([k]) => e[k]).map(([k, s]) => ((basis && !basis.pdf) || e[k] === 'default' ? s : `${s}:${e[k]}`)).join(' ')
                  const inf = it.info
                  const extra = inf ? [
                    inf.shaped && 'контур', inf.cutouts > 0 && `вырезов ${inf.cutouts}`,
                    inf.holes > 0 && `отв. ${inf.holes}`, inf.grooves > 0 && `паз ${inf.grooves}`,
                    inf.back > 0 && 'с двух сторон',
                  ].filter(Boolean).join(' · ') : ''
                  const clash = it.warn?.clash > 0 || it.warn?.foreign > 0
                  return (
                    <div key={i} style={{ padding: '4px 0', borderTop: i ? '0.5px solid var(--border)' : 'none' }}>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>
                          {it.prefix ? `${it.prefix} · ` : ''}{it.name || `Деталь ${i + 1}`}
                        </span>
                        {clash && <span style={{ color: 'var(--danger)', whiteSpace: 'nowrap' }}>пересечение</span>}
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
              {clashes.length > 0 && <span style={{ color: 'var(--danger)' }}> · пересечений деталей: {clashes.length}</span>}
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
