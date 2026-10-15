import { useState } from 'react'
import { blankType, OVER_KEY, overOf } from '../lib/edgeCut'

// Виды кромки заказа. У каждого вида: толщина (обязательна), «подрезка» — деталь идёт в раскрой меньше
// на толщину кромки с каждой закромленной стороны, «прифуговка» — припуск в мм, который снимает станок
// (деталь в раскрое на столько больше). Нажатие на название — сделать кромку активной: она ставится
// нажатием на сторону детали. «Без названия» — кромка, которая ставится, когда активной нет.
export default function EdgeTypes({ edgeNames, edgeTypes, activeEdge, onNames, onTypes, onSetActive, canSelect = true }) {
  const [name, setName] = useState('')
  const [thick, setThick] = useState('')
  const numOf = v => Number(String(v).replace(',', '.')) || 0
  const add = () => {
    const val = name.trim()
    if (!val || !(numOf(thick) > 0)) return
    if (!edgeNames.includes(val)) onNames([...edgeNames, val])
    onTypes({ ...edgeTypes, [val]: { ...(edgeTypes[val] || blankType()), t: numOf(thick) } })
    onSetActive?.(val); setName(''); setThick('')
  }
  const patch = (key, p) => onTypes({ ...edgeTypes, [key]: { ...(edgeTypes[key] || blankType()), ...p } })
  const small = { width: 54, padding: '4px 6px', fontSize: 12, textAlign: 'center' }
  const row = (key, label) => {
    const v = edgeTypes[key] || blankType()
    const active = key !== 'default' && activeEdge === key
    const noThick = !(numOf(v.t) > 0)
    return (
      <div key={key} style={{ padding: '7px 0', borderTop: '0.5px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button type="button" disabled={key === 'default' || !canSelect} onClick={() => onSetActive?.(active ? null : key)}
            style={{ flex: 1, minWidth: 0, textAlign: 'left', padding: '5px 10px', borderRadius: 20, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              border: '0.5px solid var(--border-md)', background: active ? 'var(--blue)' : 'transparent', color: active ? 'white' : key === 'default' ? 'var(--text-hint)' : 'var(--text-muted)' }}>{label}</button>
          <span style={{ fontSize: 11, color: noThick ? 'var(--danger)' : 'var(--text-hint)', flexShrink: 0 }}>толщина</span>
          <input type="text" inputMode="decimal" value={v.t ?? ''} placeholder="мм" onChange={e => patch(key, { t: e.target.value })}
            style={{ ...small, borderColor: noThick ? 'var(--danger)' : undefined }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 5, fontSize: 12, color: 'var(--text-muted)', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 5, margin: 0 }}>
            <input type="checkbox" checked={!!v.trim} onChange={e => patch(key, { trim: e.target.checked })} style={{ width: 'auto' }} />
            Подрезка на толщину
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 5, margin: 0 }}>
            <input type="checkbox" checked={numOf(v.joint) > 0 || v.joint === ''} onChange={e => patch(key, { joint: e.target.checked ? 0.5 : 0 })} style={{ width: 'auto' }} />
            Прифуговка
          </label>
          {(numOf(v.joint) > 0 || v.joint === '') && (
            <>
              <input type="text" inputMode="decimal" value={v.joint} onChange={e => patch(key, { joint: e.target.value })} style={small} />
              <span style={{ fontSize: 11, color: 'var(--text-hint)' }}>мм</span>
            </>
          )}
        </div>
      </div>
    )
  }
  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <input type="text" placeholder="Название: ПВХ 2мм / ABS…" value={name} onChange={e => setName(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
        <input type="text" inputMode="decimal" placeholder="толщ., мм" value={thick} onChange={e => setThick(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()} style={{ width: 86 }} />
        <button type="button" onClick={add} disabled={!name.trim() || !(numOf(thick) > 0)}
          style={{ padding: '0 14px', background: 'var(--blue)', color: 'white', border: 'none', borderRadius: 'var(--radius)', fontSize: 20, lineHeight: 1, opacity: name.trim() && numOf(thick) > 0 ? 1 : 0.45 }}>+</button>
      </div>
      {edgeNames.map(n => row(n, n))}
      {row('default', 'Без названия')}
      {/* свесы: запас к длине кромки на каждую закромленную сторону */}
      {(() => {
        const ov = overOf(edgeTypes), raw = edgeTypes[OVER_KEY]
        const setOv = p => onTypes({ ...edgeTypes, [OVER_KEY]: { on: ov.on, mm: raw?.mm ?? ov.mm, ...p } })
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderTop: '0.5px solid var(--border)', fontSize: 12, color: 'var(--text-muted)', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, margin: 0 }}>
              <input type="checkbox" checked={ov.on} onChange={e => setOv({ on: e.target.checked })} style={{ width: 'auto' }} />
              Свесы: добавлять к длине кромки
            </label>
            <input type="text" inputMode="decimal" disabled={!ov.on} value={raw?.mm ?? ov.mm} onChange={e => setOv({ mm: e.target.value })} style={small} />
            <span style={{ fontSize: 11, color: 'var(--text-hint)' }}>мм на каждую закромленную сторону</span>
          </div>
        )
      })()}
      <p style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 6 }}>
        Подрезка: деталь идёт в раскрой меньше на толщину кромки с каждой закромленной стороны. Прифуговка: припуск, который снимает станок, — на столько деталь в раскрое больше.
        Ничего не отмечено — деталь идёт в раскрой как записана.
        {activeEdge && canSelect ? ` Активная: «${activeEdge}» — нажмите на сторону детали.` : ''}
      </p>
    </div>
  )
}
