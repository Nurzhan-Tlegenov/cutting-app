// Тип материала заказа: обычная плита (ЛДСП, МДФ — фрезер ЧПУ или пила) либо ХДФ / ДВП (тонкий материал задних стенок —
// только пила). От типа зависят рез и отступы, которые задаёт производство, и доступный способ раскроя.
// В базе: orders.material_kind = 'hdf' или пусто (см. migration_material_kind.sql).
export const KIND_SQL_HINT = 'Тип материала «ХДФ» не сохранился: выполните migration_material_kind.sql в Supabase (SQL Editor) — один раз.'
const KINDS = [['', 'Плита: ЛДСП, МДФ', 'фрезер ЧПУ или пила'], ['hdf', 'ХДФ, ДВП', 'задняя стенка — только пила']]

export default function MaterialKind({ value, onChange, style }) {
  const cur = value === 'hdf' ? 'hdf' : ''
  return (
    <div style={{ display: 'flex', gap: 6, ...style }}>
      {KINDS.map(([id, title, hint]) => (
        <button key={id} type="button" onClick={() => onChange(id)}
          style={{ flex: 1, minWidth: 0, padding: '5px 6px', borderRadius: 'var(--radius)', textAlign: 'center', cursor: 'pointer', lineHeight: 1.25,
            border: cur === id ? '1.5px solid var(--blue)' : '0.5px solid var(--border-md)', background: cur === id ? 'var(--blue-light)' : 'transparent' }}>
          <div style={{ fontSize: 12, fontWeight: cur === id ? 500 : 400, color: cur === id ? 'var(--blue-dark)' : 'var(--text-muted)' }}>{title}</div>
          <div style={{ fontSize: 10, color: 'var(--text-hint)' }}>{hint}</div>
        </button>
      ))}
    </div>
  )
}
