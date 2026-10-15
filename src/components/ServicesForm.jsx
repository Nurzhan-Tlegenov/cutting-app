import { SERVICE_QUESTIONS, EXTRA_SERVICES } from '../lib/productionServices'

// Вопросы об услугах производства — «да / нет» в одно касание. Уточняющий вопрос появляется только после «да».
export default function ServicesForm({ value, onChange }) {
  const set = (k, v) => onChange({ ...value, [k]: v })
  const groups = [...new Set(SERVICE_QUESTIONS.map(q => q.group))]
  const yn = (on, yes) => ({
    padding: '5px 12px', fontSize: 13, cursor: 'pointer', border: 'none', borderRadius: 14, minWidth: 46,
    background: on ? (yes ? 'var(--blue)' : 'var(--text-muted)') : 'transparent', color: on ? 'white' : 'var(--text-muted)',
  })
  return (
    <div>
      {groups.map(g => (
        <div key={g} style={{ marginBottom: 6 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-hint)', textTransform: 'uppercase', letterSpacing: 0.4, margin: '6px 0 2px' }}>{g}</div>
          {SERVICE_QUESTIONS.filter(q => q.group === g && (!q.parent || value[q.parent] === true)).map(q => (
            <div key={q.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', paddingLeft: q.parent ? 14 : 0, borderTop: '0.5px solid var(--border)' }}>
              <div style={{ flex: 1, minWidth: 0, fontSize: 13, color: q.parent ? 'var(--text-muted)' : 'var(--text)' }}>{q.parent ? '↳ ' : ''}{q.q}</div>
              <div style={{ display: 'flex', gap: 2, background: 'var(--bg2)', borderRadius: 16, padding: 2, flexShrink: 0 }}>
                <button type="button" style={yn(value[q.key] === true, true)} onClick={() => set(q.key, true)}>Да</button>
                <button type="button" style={yn(value[q.key] === false, false)} onClick={() => set(q.key, false)}>Нет</button>
              </div>
            </div>
          ))}
        </div>
      ))}
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-hint)', textTransform: 'uppercase', letterSpacing: 0.4, margin: '8px 0 4px' }}>Ещё (необязательно)</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {EXTRA_SERVICES.map(([k, l]) => (
          <button key={k} type="button" onClick={() => set(k, !value[k])}
            style={{ padding: '5px 12px', borderRadius: 14, fontSize: 13, cursor: 'pointer', border: value[k] ? '1px solid var(--blue)' : '0.5px solid var(--border-md)',
              background: value[k] ? 'var(--blue-light, var(--bg2))' : 'transparent', color: value[k] ? 'var(--blue)' : 'var(--text-muted)' }}>{value[k] ? '✓ ' : ''}{l}</button>
        ))}
      </div>
    </div>
  )
}
