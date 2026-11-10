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
      {/* части шаблона — с ограничением числа символов, как в коде детали на бирке: пульт станка показывает короткое имя */}
      {(() => {
        const cur = value || def || ''
        const toks = [...cur.matchAll(/\{([A-Za-z]+)(?::(-?\d+))?\}/g)].map(m => ({ code: m[1], n: m[2] != null ? Number(m[2]) : 0, at: m.index, len: m[0].length }))
        if (!toks.length) return null
        const label = code => (parts.find(([c]) => c.toUpperCase() === `{${code.toUpperCase()}}`) || [])[1] || code
        const setLim = (t, raw) => {
          const n = parseInt(String(raw).replace(/[^\d-]/g, ''), 10)
          onChange(cur.slice(0, t.at) + (n ? `{${t.code}:${n}}` : `{${t.code}}`) + cur.slice(t.at + t.len))
        }
        return (
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {toks.map((t, i) => (
              <div key={i + t.code + t.at} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>{i + 1}. {label(t.code)}</span>
                <span style={{ fontSize: 11, color: 'var(--text-hint)' }}>символов</span>
                <input type="text" inputMode="numeric" key={'n' + t.at + t.n} defaultValue={t.n || ''} placeholder="все"
                  onBlur={e => { const v = parseInt(e.target.value, 10) || 0; if (v !== t.n) setLim(t, e.target.value) }}
                  title="Пусто — целиком; 6 — первые 6 символов; -4 — последние 4"
                  style={{ width: 58, padding: '4px 6px', fontSize: 12, textAlign: 'center' }} />
              </div>
            ))}
          </div>
        )
      })()}
      {hint}
    </div>
  )
}
