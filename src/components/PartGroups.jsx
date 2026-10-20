import { useState } from 'react'
import { groupsOf, groupDir, groupColor, groupRows } from '../lib/partGroups'
import { useBackClose } from '../lib/backStack'

// Группы деталей с общей текстурой (фасады одного шкафа): детали группы раскрой кладёт в одну полосу подряд, в порядке
// списка, без поворота — рисунок текстуры переходит с детали на деталь. У детали: part_group — имя группы,
// part_group_dir — 'y' (друг над другом, вдоль длины) | 'x' (рядом, вдоль ширины).
// Группа создаётся здесь; детали в неё попадают кнопкой «⧉» на карточке (когда группа выбрана) или списком в карточке.
export default function PartGroups({ details, setDetails, active, onActive, extra, setExtra }) {
  // extra — созданные, но ещё пустые группы (живут, пока страница открыта): [{ name, dir }]
  const [name, setName] = useState('')
  const [dir, setDir] = useState('y')
  const [layoutOf, setLayoutOf] = useState(null)   // группа, у которой открыта раскладка
  useBackClose(!!layoutOf, () => setLayoutOf(null))
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
    setDetails(ds => ds.map(x => ((x.part_group || '').trim() === g ? { ...x, part_group: null, part_group_dir: null, part_group_pos: null } : x)))
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
                <button type="button" onClick={() => setLayoutOf(g)} title="Раскладка: порядок и ряды деталей в группе"
                  style={{ padding: '4px 7px', border: 'none', borderLeft: `1px solid ${on ? 'rgba(255,255,255,0.5)' : c}`, background: 'transparent', color: on ? 'white' : c, fontSize: 12, cursor: 'pointer' }}>⊞</button>
                <button type="button" onClick={() => remove(g)} title="Распустить группу"
                  style={{ padding: '4px 7px', border: 'none', borderLeft: `1px solid ${on ? 'rgba(255,255,255,0.5)' : c}`, background: 'transparent', color: on ? 'white' : c, fontSize: 12, cursor: 'pointer' }}>✕</button>
              </div>
            )
          })}
        </div>
      )}
      {layoutOf && <PartGroupLayout group={layoutOf} dir={dirOf(layoutOf)} color={groupColor(groups, layoutOf)} details={details} setDetails={setDetails} onClose={() => setLayoutOf(null)} />}
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

// Раскладка группы: ряды (↕ — друг над другом, ряд 1 сверху, как на фасаде; ↔ — колонки слева направо) и порядок в ряду.
// Деталь с qty > 1 — одним элементом (экземпляры идут подряд на её месте). Записывается в part_group_pos = «ряд.место».
function PartGroupLayout({ group, dir, color, details, setDetails, onClose }) {
  const mine = details.map((d, i) => ({ d, i })).filter(({ d }) => (d.part_group || '').trim() === group)
  const rows = groupRows(mine.map(({ d, i }) => ({ key: d.uid, d, pos: d.part_group_pos, ord: i })))
  const vert = dir !== 'x'
  const apply = newRows => {
    const pos = new Map()
    newRows.filter(r => r.length).forEach((r, ri) => r.forEach((m, ci) => pos.set(m.key, `${ri + 1}.${ci + 1}`)))
    setDetails(ds => ds.map(x => (pos.has(x.uid) ? { ...x, part_group_pos: pos.get(x.uid) } : x)))
  }
  const move = (ri, ci, dr, dc) => {
    const next = rows.map(r => r.slice())
    const [m] = next[ri].splice(ci, 1)
    if (dr) {                                   // в соседний ряд (за краем — новый ряд)
      const to = ri + dr
      if (to < 0) next.unshift([m]); else if (to >= next.length) next.push([m]); else next[to].push(m)
    } else next[ri].splice(Math.max(0, Math.min(next[ri].length, ci + dc)), 0, m)
    apply(next.filter(r => r.length))
  }
  // эскиз блока: размеры по деталям (экземпляры подряд), без пропила — просто пропорции
  const W = ({ d }) => Number(d.w) || 0, L = ({ d }) => Number(d.h) || 0, Q = ({ d }) => Math.max(1, Number(d.qty) || 1)
  const rowW = r => (vert ? r.reduce((a, m) => a + W(m) * Q(m), 0) : Math.max(...r.map(W)))
  const rowL = r => (vert ? Math.max(...r.map(L)) : r.reduce((a, m) => a + L(m) * Q(m), 0))
  const bw = vert ? Math.max(...rows.map(rowW), 1) : rows.reduce((a, r) => a + rowW(r), 0), bl = vert ? rows.reduce((a, r) => a + rowL(r), 0) : Math.max(...rows.map(rowL), 1)
  const sc = 220 / Math.max(bw, bl, 1)
  const rects = []
  let off = 0
  rows.forEach((r, ri) => {
    let inner = 0
    r.forEach((m, ci) => { for (let q = 0; q < Q(m); q++) {
      const x = vert ? inner : off, y = vert ? off : inner
      rects.push({ x, y, w: W(m), h: L(m), t: `${ri + 1}.${ci + 1}` })
      inner += vert ? W(m) : L(m)
    } })
    off += vert ? rowL(r) : rowW(r)
  })
  const btn = { padding: '2px 6px', border: '0.5px solid var(--border-md)', borderRadius: 6, background: 'transparent', color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer', lineHeight: 1.2 }
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 60, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--bg)', borderRadius: '14px 14px 0 0', width: '100%', maxWidth: 560, maxHeight: '88vh', overflowY: 'auto', padding: '12px 14px 18px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <b style={{ color, fontSize: 15, flex: 1 }}>⧉ {group} — раскладка</b>
          <button type="button" onClick={onClose} style={{ ...btn, fontSize: 16 }}>✕</button>
        </div>
        <p style={{ fontSize: 11.5, color: 'var(--text-hint)', margin: '0 0 8px' }}>
          {vert ? 'Ряды — друг над другом, ряд 1 сверху (как смотрите на фасад). В ряду детали рядом, слева направо.' : 'Ряды — это колонки слева направо. В колонке детали сверху вниз.'} Стрелки ▲▼ переносят деталь в соседний ряд (за краем — новый ряд), ◀▶ двигают в ряду.
        </p>
        <svg viewBox={`-4 -4 ${bw * sc + 8} ${bl * sc + 8}`} style={{ width: '100%', maxHeight: 230, display: 'block', margin: '0 auto 10px' }}>
          {rects.map((r, i) => (
            <g key={i}>
              <rect x={r.x * sc} y={r.y * sc} width={r.w * sc} height={r.h * sc} fill={color} fillOpacity="0.15" stroke={color} strokeWidth="1" />
              <text x={(r.x + r.w / 2) * sc} y={(r.y + r.h / 2) * sc} textAnchor="middle" dominantBaseline="middle" fontSize="9" fill="var(--text)">{r.t} · {r.w}×{r.h}</text>
            </g>
          ))}
        </svg>
        {rows.map((r, ri) => (
          <div key={ri} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 0', borderTop: '0.5px solid var(--border)' }}>
            <span style={{ fontSize: 11, color: 'var(--text-hint)', minWidth: 46 }}>{vert ? 'ряд' : 'колонка'} {ri + 1}</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, flex: 1 }}>
              {r.map((m, ci) => (
                <div key={m.key} style={{ display: 'flex', alignItems: 'center', gap: 3, border: `1px solid ${color}`, borderRadius: 8, padding: '3px 5px' }}>
                  <span style={{ fontSize: 12, color: 'var(--text)' }}>{m.d.name || `#${m.ord + 1}`} <span style={{ color: 'var(--text-hint)' }}>{m.d.w}×{m.d.h}{Q(m) > 1 ? ` ×${Q(m)}` : ''}</span></span>
                  <button type="button" style={btn} disabled={ci === 0} onClick={() => move(ri, ci, 0, -1)}>◀</button>
                  <button type="button" style={btn} disabled={ci === r.length - 1} onClick={() => move(ri, ci, 0, 1)}>▶</button>
                  <button type="button" style={btn} onClick={() => move(ri, ci, -1, 0)}>▲</button>
                  <button type="button" style={btn} onClick={() => move(ri, ci, 1, 0)}>▼</button>
                </div>
              ))}
            </div>
          </div>
        ))}
        <p style={{ fontSize: 11, color: 'var(--text-hint)', margin: '8px 0 0' }}>Порядок сохраняется с заказом (поле «ряд.место» у детали) и соблюдается в раскрое на любом станке.</p>
      </div>
    </div>
  )
}
