// Таблица с колонками, ширину которых тянут за правую границу заголовка (как бланк заказа на компьютере).
// Двойной щелчок по границе — ширина по умолчанию. Ширины запоминаются в этом браузере (storeKey).
// cols: [[ключ, заголовок, ширина по умолчанию, минимум]]; последняя колонка — остаток (1fr).
// rows: [{ key, cells: [..], style }]
import { useRef, useState } from 'react'

const load = k => { try { return JSON.parse(localStorage.getItem(k) || '{}') || {} } catch { return {} } }

export default function ColGrid({ storeKey, cols, rows }) {
  const [w, setW] = useState(() => load(storeKey))
  const drag = useRef(null)
  const widthOf = (k, def) => (Number(w[k]) > 0 ? Number(w[k]) : def)
  const save = next => { setW(next); try { localStorage.setItem(storeKey, JSON.stringify(next)) } catch { /* без памяти */ } }
  const tpl = cols.map(([k, , def], i) => (i === cols.length - 1 ? 'minmax(0, 1fr)' : `${widthOf(k, def)}px`)).join(' ')
  const start = (k, def, min, e) => {
    e.preventDefault()
    drag.current = { k, x: e.clientX, w0: widthOf(k, def) }
    const move = ev => { const d = drag.current; if (d) setW(cur => { const n = { ...cur, [d.k]: Math.max(min || 40, Math.round(d.w0 + ev.clientX - d.x)) }; try { localStorage.setItem(storeKey, JSON.stringify(n)) } catch { /* */ } return n }) }
    const up = () => { drag.current = null; window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }
  const cell = { minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, padding: '3px 6px' }
  return (
    <div style={{ overflowX: 'auto' }}>
      <div style={{ display: 'grid', gridTemplateColumns: tpl, fontSize: 11, color: 'var(--text-hint)', borderBottom: '0.5px solid var(--border)' }}>
        {cols.map(([k, title, def, min], i) => (
          <div key={k} style={{ ...cell, position: 'relative', whiteSpace: 'nowrap' }}>
            {title}
            {i < cols.length - 1 && (
              <span onPointerDown={e => start(k, def, min, e)} onDoubleClick={() => { const n = { ...w }; delete n[k]; save(n) }}
                title="Потяните, чтобы изменить ширину колонки (двойной щелчок — как было)"
                style={{ position: 'absolute', right: -5, top: 0, bottom: 0, width: 9, cursor: 'col-resize', zIndex: 1, display: 'flex', justifyContent: 'center', touchAction: 'none' }}>
                <span style={{ width: 1, background: 'var(--border-md)', margin: '3px 0' }} />
              </span>
            )}
          </div>
        ))}
      </div>
      {rows.map(r => (
        <div key={r.key} style={{ display: 'grid', gridTemplateColumns: tpl, fontSize: 12, borderBottom: '0.5px solid var(--border)', ...r.style }}>
          {r.cells.map((c, i) => <div key={i} style={cell}>{c}</div>)}
        </div>
      ))}
    </div>
  )
}
