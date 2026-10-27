import { useState, useRef } from 'react'
import { insertPart } from '../lib/orderUtils'

// Папки выгрузки программ — матрёшка: уровни через «/», в каждом — части имени ({ZAKAZ}, {MAT}, …) и свой текст.
// Своя у фрезера и у каждого шестистороннего станка. Настраивается в постпроцессоре («Основные») и в заказе (ЧПУ).
/** Папки фрезера по умолчанию: «папка заказа»/материал; с шестисторонним станком — с пометкой фрезера */
// eslint-disable-next-line react-refresh/only-export-components
export const routerDirDefault = (post, withDrills) => `${post?.folderTpl || '{ZAKAZ}'}${withDrills ? '_CNC_frezer' : ''}/{MAT}`
const DIR_PARTS = [['{ZAKAZ}', 'заказ'], ['{NOMER}', 'номер'], ['{MAT}', 'материал'], ['{T}', 'толщина'], ['{DATA}', 'дата'], ['{KLIENT}', 'клиент'], ['{LISTOV}', 'листов']]
// Конструктор папок выгрузки: уровни вложенности (матрёшка), у каждого уровня — части имени и свой текст
// latin — имена папок латиницей (по умолчанию да); выключено — на языке заказа. onLatin — галочка (без него не показывается)
export default function DirPathEditor({ value, def, preview, onChange, latin = true, onLatin }) {
  const levels = String(value || '').split('/')
  const [cur, setCur] = useState(Math.max(0, levels.length - 1))
  const k = Math.min(cur, levels.length - 1)
  const caret = useRef({ i: -1, pos: null })        // где стоял курсор в поле папки (кнопка части нажимается уже после ухода из поля)
  const inputs = useRef([])
  const setLevels = ls => onChange(ls.map(x => x.trim()).filter((x, i, a) => x || i === a.length - 1).join('/'))
  const chip = { padding: '2px 8px', borderRadius: 12, fontSize: 11, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }
  return (
    <div style={{ marginTop: 3 }}>
      <div>Папки: <b style={{ fontFamily: 'monospace', color: 'var(--text)' }}>{(Array.isArray(preview) ? preview.join(' / ') : String(preview || '')) || '— без папок —'}</b></div>
      {levels.map((lv, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 3, paddingLeft: i * 12 }}>
          <span style={{ color: 'var(--text-hint)' }}>{i ? '└' : '📁'}</span>
          <input type="text" key={value + i} defaultValue={lv} onFocus={() => setCur(i)} placeholder="имя папки" ref={el => { inputs.current[i] = el }}
            onSelect={e => { caret.current = { i, pos: e.target.selectionStart } }} onKeyUp={e => { caret.current = { i, pos: e.target.selectionStart } }}
            onBlur={e => { caret.current = { i, pos: e.target.selectionStart }; if (e.target.value !== lv) setLevels(levels.map((x, j) => (j === i ? e.target.value : x))) }}
            style={{ flex: 1, minWidth: 0, padding: '3px 7px', fontSize: 12, fontFamily: 'monospace', border: i === k ? '1px solid var(--blue)' : undefined }} />
          {levels.length > 1 && <button type="button" style={{ ...chip, color: 'var(--danger)' }} onClick={() => setLevels(levels.filter((_, j) => j !== i))}>✕</button>}
        </div>
      ))}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
        {DIR_PARTS.map(([code, l]) => (
          <button key={code} type="button" style={chip} onClick={() => {
            // часть — в выделенную папку, туда, где стоял курсор (между {ZAKAZ} и {MAT} — значит между ними), иначе в конец
            const el = inputs.current[k], x = el ? el.value : (levels[k] || '')
            const pos = caret.current.i === k ? caret.current.pos : null
            setLevels(levels.map((v, j) => (j === k ? insertPart(x, pos, code) : v)))
          }}>+ {l}</button>
        ))}
        <button type="button" style={{ ...chip, color: 'var(--blue)', borderColor: 'var(--blue)' }} onClick={() => { setLevels([...levels, '{MAT}']); setCur(levels.length) }}>+ вложенная папка</button>
        <button type="button" style={chip} onClick={() => onChange(def)}>↺ как было</button>
      </div>
      {onLatin && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)', marginTop: 5, cursor: 'pointer' }}>
          <input type="checkbox" checked={latin} onChange={e => onLatin(e.target.checked)} style={{ width: 16, height: 16 }} />
          Имена папок латиницей
        </label>
      )}
      <div style={{ fontSize: 10.5, color: 'var(--text-hint)', marginTop: 2 }}>Части вставляются в выделенную папку туда, где стоял курсор; свой текст — прямо в поле. {latin ? 'Имена — латиницей.' : 'Имена — на языке заказа, как он назван.'}</div>
    </div>
  )
}
