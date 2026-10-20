import { useState, useRef } from 'react'
import { groupsOf, groupDir, groupColor, groupRows, posOfInstance } from '../lib/partGroups'
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

// Раскладка группы: детали двигаются пальцем, как на карте раскроя. Отпустили — раскладка «схлопывается» в ряды
// без зазоров (↕ — ряды друг над другом, ряд 1 сверху, как на фасаде; ↔ — колонки слева направо), порядок пишется
// в part_group_pos = «ряд.место». Деталь с qty > 1 — одним прямоугольником «×N» (экземпляры идут подряд на её месте).
// Зазор на рез добавит сам раскрой — по инструменту выбранного станка.
function PartGroupLayout({ group, dir, color, details, setDetails, onClose }) {
  const vert = dir !== 'x'
  // элементы — экземпляры деталей (деталь ×2 — два отдельных фасада, каждый двигается сам)
  const mine = details.map((d, i) => ({ d, i })).filter(({ d }) => (d.part_group || '').trim() === group)
    .flatMap(({ d, i }) => Array.from({ length: Math.max(1, Number(d.qty) || 1) }, (_, q) => ({ key: `${d.uid}#${q}`, uid: d.uid, q, d, i, pos: posOfInstance(d.part_group_pos, q), ord: i })))
  const rows = groupRows(mine)
  const W = m => Number(m.d.w) || 0, L = m => Number(m.d.h) || 0
  // текстура — вдоль длины (Y): деталь стоит длиной по вертикали, как на карте раскроя
  const ext = m => ({ w: W(m), h: L(m) })
  // плотная раскладка рядов -> прямоугольники (мм, Y вниз — как на экране)
  const tidy = rs => {
    const out = new Map()
    let off = 0
    rs.forEach(r => {
      const size = vert ? Math.max(...r.map(m => ext(m).h)) : Math.max(...r.map(m => ext(m).w))
      let inner = 0
      r.forEach(m => { const e = ext(m); out.set(m.key, vert ? { x: inner, y: off, ...e } : { x: off, y: inner, ...e }); inner += vert ? e.w : e.h })
      off += size
    })
    return out
  }
  const base = tidy(rows)
  const [drag, setDrag] = useState(null)      // { key, dx, dy, x, y } — что тащим и где оно сейчас
  const svgRef = useRef(null)
  const rects = mine.map(m => ({ m, ...(drag?.key === m.key ? { ...base.get(m.key), x: drag.x, y: drag.y } : base.get(m.key)) }))
  const bw = Math.max(1, ...rects.map(r => r.x + r.w)), bl = Math.max(1, ...rects.map(r => r.y + r.h))
  const field = Math.max(bw, bl) * 1.5 + 100
  const toMm = e => { const b = svgRef.current.getBoundingClientRect(); return { x: (e.clientX - b.left) / b.width * field - 50, y: (e.clientY - b.top) / b.height * field - 50 } }
  const apply = newRows => {
    // позиция каждого экземпляра -> у детали строка «ряд.место» по экземплярам через «;»
    const pos = new Map()
    newRows.filter(r => r.length).forEach((r, ri) => r.forEach((m, ci) => pos.set(m.key, `${ri + 1}.${ci + 1}`)))
    setDetails(ds => ds.map(x => {
      const n = Math.max(1, Number(x.qty) || 1)
      if (!pos.has(`${x.uid}#0`)) return x
      return { ...x, part_group_pos: Array.from({ length: n }, (_, q) => pos.get(`${x.uid}#${q}`) || '').join(';') }
    }))
  }
  const start = (e, r) => { e.preventDefault(); e.currentTarget.setPointerCapture?.(e.pointerId); const p = toMm(e); setDrag({ key: r.m.key, dx: p.x - r.x, dy: p.y - r.y, x: r.x, y: r.y }) }
  const move = e => { if (!drag) return; const p = toMm(e); setDrag(d => ({ ...d, x: p.x - d.dx, y: p.y - d.dy })) }
  const end = () => {
    if (!drag) return
    // ряды — по положению центров: деталь попадает в ряд, с которым её центр перекрывается по высоте (↕) / ширине (↔);
    // внутри ряда — по центру слева направо (↕) / сверху вниз (↔)
    const items = rects.map(r => ({ ...r, cx: r.x + r.w / 2, cy: r.y + r.h / 2 }))
    const along = r => (vert ? r.cy : r.cx), lo = r => (vert ? r.y : r.x), hi = r => (vert ? r.y + r.h : r.x + r.w), across = r => (vert ? r.cx : r.cy)
    items.sort((a, b) => along(a) - along(b))
    const groups = []
    for (const it of items) {
      const g = groups.find(gr => along(it) >= gr.lo && along(it) <= gr.hi)
      if (g) { g.items.push(it); g.lo = Math.min(g.lo, lo(it)); g.hi = Math.max(g.hi, hi(it)) } else groups.push({ items: [it], lo: lo(it), hi: hi(it) })
    }
    const newRows = groups.sort((a, b) => a.lo - b.lo).map(gr => gr.items.sort((a, b) => across(a) - across(b)).map(it => ({ key: it.m.key })))
    setDrag(null)
    apply(newRows)
  }
  const btn = { padding: '2px 6px', border: '0.5px solid var(--border-md)', borderRadius: 6, background: 'transparent', color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer', lineHeight: 1.2 }
  const fs = field / 42                                   // размер шрифта в мм поля — как подписи на карте
  const lab = m => (m.d.name ? m.d.name.slice(0, 14) : `#${m.i + 1}`)
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 60, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--bg)', borderRadius: '14px 14px 0 0', width: '100%', maxWidth: 560, maxHeight: '92vh', overflowY: 'auto', padding: '12px 14px 18px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <b style={{ color, fontSize: 15, flex: 1 }}>⧉ {group} — раскладка</b>
          <button type="button" onClick={onClose} style={{ ...btn, fontSize: 16 }}>✕</button>
        </div>
        <p style={{ fontSize: 11.5, color: 'var(--text-hint)', margin: '0 0 8px' }}>
          Фасады стоят как на карте раскроя: текстура (длина) по вертикали, Y. Двигайте каждый пальцем; отпустили — они складываются {vert ? 'в ряды друг над другом (верхний ряд — верх фасада)' : 'в колонки слева направо'} без зазоров; зазор на рез добавит раскрой. Деталь «2 шт.» — два отдельных фасада.
        </p>
        <svg ref={svgRef} viewBox={`-50 -50 ${field} ${field}`} onPointerMove={move} onPointerUp={end} onPointerCancel={end}
          style={{ width: '100%', aspectRatio: '1 / 1', display: 'block', touchAction: 'none', background: '#f4f4f2', borderRadius: 10, border: '0.5px solid var(--border)', userSelect: 'none' }}>
          {rects.map(r => (
            <g key={r.m.key} onPointerDown={e => start(e, r)} style={{ cursor: 'grab' }}>
              <rect x={r.x} y={r.y} width={r.w} height={r.h} fill={drag?.key === r.m.key ? '#dfe9f5' : '#eceae4'} stroke="#333" strokeWidth={field / 400} />
              {/* размеры по сторонам, как на карте: по горизонтали — сверху, по вертикали — слева, повёрнуто */}
              <text x={r.x + r.w / 2} y={r.y + fs * 1.1} textAnchor="middle" fontSize={fs} fill="#222" style={{ pointerEvents: 'none' }}>{Math.round(r.w)}</text>
              <text x={r.x + fs * 1.1} y={r.y + r.h / 2} textAnchor="middle" fontSize={fs} fill="#222" transform={`rotate(-90 ${r.x + fs * 1.1} ${r.y + r.h / 2})`} style={{ pointerEvents: 'none' }}>{Math.round(r.h)}</text>
              <text x={r.x + r.w / 2} y={r.y + r.h / 2} textAnchor="middle" dominantBaseline="middle" fontSize={fs * 0.9} fill="#444" style={{ pointerEvents: 'none' }}>{lab(r.m)}{r.m.q || (Number(r.m.d.qty) || 1) > 1 ? ` (${r.m.q + 1})` : ''}</text>
            </g>
          ))}
        </svg>
        <p style={{ fontSize: 11, color: 'var(--text-hint)', margin: '8px 0 0' }}>
          {rows.map((r, ri) => `${vert ? 'ряд' : 'колонка'} ${ri + 1}: ${r.map(m => `${lab(m)}${(Number(m.d.qty) || 1) > 1 ? ` (${m.q + 1})` : ''} ${W(m)}×${L(m)}`).join(' · ')}`).join('  |  ')}. Порядок сохраняется с заказом и соблюдается в раскрое на любом станке.
        </p>
      </div>
    </div>
  )
}
