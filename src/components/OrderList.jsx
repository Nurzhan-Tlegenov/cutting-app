// Список с очерёдностью: ↑ — раньше, ↓ — позже (как приоритет лицевой стороны при импорте).
// items: [{ key, title, sub }] — уже в текущем порядке; onChange(keys) — новый порядок ключей.
export default function OrderList({ items, onChange, disabled = false }) {
  const arrow = { width: 30, height: 28, padding: 0, borderRadius: 8, border: '0.5px solid var(--border-md)', background: 'var(--bg)', color: 'var(--text-muted)', fontSize: 14, flex: '0 0 auto' }
  const move = (i, d) => {
    const k = items.map(x => x.key)
    ;[k[i], k[i + d]] = [k[i + d], k[i]]
    onChange(k)
  }
  return items.map((it, i) => (
    <div key={it.key} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0', borderTop: i ? '0.5px solid var(--border)' : 'none' }}>
      <span style={{ width: 18, fontSize: 12, color: 'var(--text-hint)', textAlign: 'right', flex: '0 0 auto' }}>{i + 1}.</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.title}</div>
        {it.sub && <div style={{ fontSize: 11, color: 'var(--text-hint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.sub}</div>}
      </div>
      <button type="button" style={arrow} disabled={disabled || i === 0} onClick={() => move(i, -1)} title="Раньше">↑</button>
      <button type="button" style={arrow} disabled={disabled || i === items.length - 1} onClick={() => move(i, 1)} title="Позже">↓</button>
    </div>
  ))
}

/** Новый порядок ключей: показанные — как сейчас, потом ранее сохранённые, которых в этом заказе нет (не теряются) */
export const mergeOrder = (shown, saved = []) => [...shown, ...saved.filter(k => !shown.includes(k))]
