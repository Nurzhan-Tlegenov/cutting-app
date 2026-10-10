import { QR_PARTS } from '../lib/labelMaker'

// Конструктор кода детали — из каких частей собирается строка: один и тот же для QR-кода бирки и для имени файла
// программы присадочного станка. value — { parts, sep, text, latin }, onChange(value), exclude — части, которые не предлагать.
export default function QrPartsEditor({ value, onChange, exclude = [], preview }) {
  const q = { parts: [], sep: ';', text: '', latin: false, ...value }
  const chip = on => ({ padding: '5px 10px', borderRadius: 20, fontSize: 12, cursor: 'pointer', border: '0.5px solid ' + (on ? 'var(--blue)' : 'var(--border-md)'), background: on ? 'var(--blue-light)' : 'transparent', color: on ? 'var(--blue-dark)' : 'var(--text-muted)' })
  return (
    <>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {QR_PARTS.filter(([k]) => !exclude.includes(k)).map(([k, label]) => {
          const on = q.parts.includes(k)
          return <button key={k} type="button" style={chip(on)} onClick={() => onChange({ ...q, parts: on ? q.parts.filter(x => x !== k) : [...q.parts, k] })}>{on ? '✓ ' : ''}{label}</button>
        })}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        {q.parts.includes('text') && (
          <label style={{ flex: 1, fontSize: 12, color: 'var(--text-muted)' }}>Свой текст
            <input type="text" key={'t' + q.text} defaultValue={q.text} onBlur={e => { if (e.target.value !== q.text) onChange({ ...q, text: e.target.value }) }} style={{ marginTop: 3, padding: '7px 9px' }} /></label>
        )}
        <label style={{ flex: '0 0 96px', fontSize: 12, color: 'var(--text-muted)' }}>Разделитель
          <input type="text" key={'s' + q.sep} defaultValue={q.sep} maxLength={3} onBlur={e => { if (e.target.value !== q.sep) onChange({ ...q, sep: e.target.value }) }} style={{ marginTop: 3, padding: '7px 9px', textAlign: 'center' }} /></label>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, cursor: 'pointer', marginTop: 8 }}>
        <input type="checkbox" checked={!!q.latin} onChange={e => onChange({ ...q, latin: e.target.checked })} style={{ width: 17, height: 17 }} />
        Перевести в латиницу
      </label>
      <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 4 }}>Части идут в порядке списка. Пробелы в коде всегда заменяются прочерком «_».</div>
      {preview != null && (
        <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 6, wordBreak: 'break-all' }}>
          Сейчас в коде: <span style={{ fontFamily: 'monospace', color: 'var(--text)' }}>{preview || '— пусто —'}</span>
        </div>
      )}
    </>
  )
}
