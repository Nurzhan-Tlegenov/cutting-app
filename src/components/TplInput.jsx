import { useRef } from 'react'
import { insertPart } from '../lib/orderUtils'

// Поле шаблона имени (программы, папки, файла) с частями-кнопками. Часть вставляется туда, где стоял курсор в поле,
// а не в конец (поставили палец между {ZAKAZ} и {MAT} — {KLIENT} встанет между ними). Значение пишется по уходу из поля.
export default function TplInput({ value, def, parts, onChange, style, inputStyle, hint }) {
  const ref = useRef(null), caret = useRef(null)      // позиция курсора на момент ухода из поля (кнопка нажимается уже после)
  const remember = e => { caret.current = e.target.selectionStart }
  const commit = e => { remember(e); const v = e.target.value.trim() || def || ''; if (v !== (value || '')) onChange(v) }
  const add = code => {
    const el = ref.current
    const cur = el ? el.value : (value || def || '')
    const pos = document.activeElement === el ? el.selectionStart : caret.current
    const next = insertPart(cur, pos, code)
    if (el) el.value = next
    caret.current = (pos == null ? cur.length : pos) + code.length + (next.length - cur.length - code.length)
    onChange(next)
  }
  const chip = { padding: '4px 9px', borderRadius: 20, fontSize: 11, border: '0.5px solid var(--blue-mid)', background: 'transparent', color: 'var(--blue)', cursor: 'pointer' }
  return (
    <div style={style}>
      <input ref={ref} type="text" key={value || def} defaultValue={value || def} onBlur={commit} onSelect={remember} onKeyUp={remember} onClick={remember}
        style={{ fontFamily: 'monospace', fontSize: 13, ...inputStyle }} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 6 }}>
        {parts.map(([code, label]) => <button key={code} type="button" title={`Вставить: ${label}`} onClick={() => add(code)} style={chip}>+ {label}</button>)}
        {def && <button type="button" onClick={() => onChange(def)} style={{ ...chip, border: '0.5px solid var(--border-md)', color: 'var(--text-muted)' }}>↺ как было</button>}
      </div>
      {hint}
    </div>
  )
}
