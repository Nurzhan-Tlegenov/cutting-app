import { useState } from 'react'
import { groupsOf, groupDir, groupColor } from '../lib/partGroups'

// Группы деталей с общей текстурой (фасады одного шкафа): детали группы раскрой кладёт в одну полосу подряд, в порядке
// списка, без поворота — рисунок текстуры переходит с детали на деталь. У детали: part_group — имя группы,
// part_group_dir — 'y' (друг над другом, вдоль длины) | 'x' (рядом, вдоль ширины).
// Группа создаётся здесь; детали в неё попадают кнопкой «⧉» на карточке (когда группа выбрана) или списком в карточке.
export default function PartGroups({ details, setDetails, active, onActive, extra, setExtra }) {
  // extra — созданные, но ещё пустые группы (живут, пока страница открыта): [{ name, dir }]
  const [name, setName] = useState('')
  const [dir, setDir] = useState('y')
  const used = groupsOf(details)
  const groups = [...used, ...(extra || []).map(g => g.name).filter(g => !used.includes(g))]
  const dirOf = g => (used.includes(g) ? groupDir(details, g) : (extra || []).find(x => x.name === g)?.dir || 'y')
  const add = () => {
    const g = name.trim()
    if (!g || groups.includes(g)) return
    setExtra(x => [...(x || []), { name: g, dir }])
    onActive(g); setName('')
  }
  const setDirOf = (g, d) => {
    setDetails(ds => ds.map(x => ((x.part_group || '').trim() === g ? { ...x, part_group_dir: d } : x)))
    setExtra(x => (x || []).map(e => (e.name === g ? { ...e, dir: d } : e)))
  }
  const remove = g => {
    if (used.includes(g) && !window.confirm(`Распустить группу «${g}»? Детали останутся, но без группы.`)) return
    setDetails(ds => ds.map(x => ((x.part_group || '').trim() === g ? { ...x, part_group: null, part_group_dir: null } : x)))
    setExtra(x => (x || []).filter(e => e.name !== g))
    if (active === g) onActive(null)
  }
  const count = g => details.filter(x => (x.part_group || '').trim() === g).length
  return (
    <div style={{ padding: '8px 12px', background: 'var(--bg)', border: '0.5px solid var(--border)', borderRadius: 'var(--radius)', marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <span style={{ fontSize: 13, color: 'var(--text-muted)', flex: 1 }}>⧉ Группы с общей текстурой</span>
        <span style={{ fontSize: 10.5, color: 'var(--text-hint)' }}>фасады одного шкафа — из одной полосы подряд</span>
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: groups.length ? 8 : 0 }}>
        <input type="text" placeholder="Название группы: Ф1, Ящики…" value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()} style={{ flex: 1, minWidth: 0, padding: '5px 8px', fontSize: 13 }} />
        <select value={dir} onChange={e => setDir(e.target.value)} style={{ width: 'auto', padding: '3px 4px', fontSize: 12 }} title="Как детали идут друг за другом">
          <option value="y">↕ друг над другом</option>
          <option value="x">↔ рядом</option>
        </select>
        <button type="button" onClick={add} style={{ padding: '0 12px', background: 'var(--blue)', color: 'white', border: 'none', borderRadius: 'var(--radius)', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>+</button>
      </div>
      {groups.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          {groups.map(g => {
            const on = active === g, c = groupColor(groups, g)
            return (
              <div key={g} style={{ display: 'flex', alignItems: 'center', border: `1px solid ${c}`, borderRadius: 16, overflow: 'hidden', background: on ? c : 'transparent' }}>
                <button type="button" onClick={() => onActive(on ? null : g)} title={on ? 'Закончить отбор деталей' : 'Отметить детали этой группы'}
                  style={{ padding: '4px 10px', border: 'none', background: 'transparent', color: on ? 'white' : c, fontSize: 12, fontWeight: 500, cursor: 'pointer' }}>
                  {on ? '✓ ' : ''}{g} · {count(g)}
                </button>
                <button type="button" onClick={() => setDirOf(g, dirOf(g) === 'x' ? 'y' : 'x')} title="Друг над другом / рядом"
                  style={{ padding: '4px 6px', border: 'none', borderLeft: `1px solid ${on ? 'rgba(255,255,255,0.5)' : c}`, background: 'transparent', color: on ? 'white' : c, fontSize: 12, cursor: 'pointer' }}>
                  {dirOf(g) === 'x' ? '↔' : '↕'}
                </button>
                <button type="button" onClick={() => remove(g)} title="Распустить группу"
                  style={{ padding: '4px 7px', border: 'none', borderLeft: `1px solid ${on ? 'rgba(255,255,255,0.5)' : c}`, background: 'transparent', color: on ? 'white' : c, fontSize: 12, cursor: 'pointer' }}>✕</button>
              </div>
            )
          })}
        </div>
      )}
      {active && <p style={{ fontSize: 11, color: 'var(--blue)', margin: '6px 0 0' }}>Отбор в группу «{active}»: нажимайте ⧉ на деталях. Детали группы не поворачиваются и режутся из одной полосы подряд, в порядке списка.</p>}
    </div>
  )
}

/** Кнопка группы на карточке детали: при отборе — в группу / из группы; иначе — список групп */
export function GroupChip({ detail, groups, active, onChange }) {
  const g = (detail.part_group || '').trim()
  if (!groups.length) return null
  const c = g ? groupColor(groups, g) : 'var(--text-hint)'
  if (active) {
    const on = g === active
    return (
      <button type="button" onClick={() => onChange(on ? null : active)} title={on ? `Убрать из группы «${active}»` : `В группу «${active}»`}
        style={{ padding: '4px 7px', border: `1.5px solid ${on ? groupColor(groups, active) : 'var(--border-md)'}`, borderRadius: 'var(--radius)',
          background: on ? groupColor(groups, active) : 'transparent', color: on ? 'white' : 'var(--text-hint)', fontSize: 11, cursor: 'pointer', flexShrink: 0, lineHeight: 1.2 }}>
        ⧉{on ? ' ✓' : g ? ` ${g}` : ''}
      </button>
    )
  }
  return (
    <select value={g} onChange={e => onChange(e.target.value || null)} title="Группа с общей текстурой"
      style={{ width: 'auto', maxWidth: 74, padding: '3px 2px', fontSize: 11, color: c, borderColor: g ? c : 'var(--border-md)', borderRadius: 'var(--radius)', flexShrink: 0 }}>
      <option value="">⧉ —</option>
      {groups.map(x => <option key={x} value={x}>{x}</option>)}
    </select>
  )
}
