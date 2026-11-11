import { metaPos } from '../lib/partLabel'

// Своя позиция и наименование детали в бланке заказа. Позиция — любой текст или число («12», «Б-3», «бок лев.»);
// хранится в contour.meta.pos — там же, где позиция из Базиса / Астры / таблицы, поэтому сразу идёт на карту раскроя
// («Подпись на деталях: Позиция…»), в PDF и на бирку. Пустая — как раньше: номер строки (#1, #2…).
// eslint-disable-next-line react-refresh/only-export-components
export function setDetailPos(detail, value) {
  const v = String(value ?? '')
  const c0 = detail.contour && typeof detail.contour === 'object' ? detail.contour : null
  const meta = { ...(c0?.meta || {}) }
  if (v.trim()) meta.pos = v
  else delete meta.pos
  if (!c0) return { ...detail, contour: Object.keys(meta).length ? { meta } : null }
  const contour = { ...c0, meta }
  if (!Object.keys(meta).length) delete contour.meta
  // контур был только ради свойств — без них он не нужен
  return { ...detail, contour: Object.keys(contour).length ? contour : null }
}

export default function DetailNamePos({ detail, onUpdate, children }) {
  const meta = detail.contour && typeof detail.contour === 'object' ? detail.contour.meta : null
  // своя позиция (meta.pos) правится; позиция из свойств модели без meta.pos — подсказкой в поле
  const own = meta?.pos != null ? String(meta.pos) : ''
  const fromModel = own ? '' : metaPos(meta)
  const inp = { fontSize: 12, padding: '3px 6px', minWidth: 0 }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4, paddingLeft: 36 }}>
      <input type="text" value={own} placeholder={fromModel ? `поз. ${fromModel}` : 'Поз.'} title="Своя позиция детали — число или текст"
        onChange={e => onUpdate(setDetailPos(detail, e.target.value))}
        style={{ ...inp, width: 64, flex: '0 0 auto', fontWeight: own ? 600 : 400, color: 'var(--blue-dark)' }} />
      {meta?.des && <span style={{ fontSize: 11, color: 'var(--text-muted)', flex: '0 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 120 }} title="Обозначение из модели">{meta.des}</span>}
      <input type="text" value={detail.name || ''} placeholder="Наименование" title="Наименование детали"
        onChange={e => onUpdate({ ...detail, name: e.target.value || null })}
        style={{ ...inp, flex: 1 }} />
      {children}
    </div>
  )
}
