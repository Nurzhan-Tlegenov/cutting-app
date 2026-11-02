// β-постпроцессор шестистороннего станка: детали так, как они лягут на станок, — вся присадка, пазы, вырезы,
// лапы и упор. Меняются настройки постпроцессора — схема перестраивается сразу. Деталь можно повернуть и перевернуть
// (ручное положение — в настройках производства d6Man: id строки детали -> { rot, flip }, главнее правил).
import { useEffect, useMemo, useRef, useState } from 'react'
import { useDesktop } from '../hooks/useDesktop'
import { d6Preview, d6bOf, panelXml } from '../lib/drill6Xml'
import { parseDrillXml } from '../lib/drill6Parse'
import { LABEL_MODES, partLabel } from '../lib/partLabel'
import { Preview } from './Drill6Viewer'
import { rawDetail, parseEdgeTypes } from '../lib/edgeCut'

const HOW = { manual: 'вручную', rules: 'по правилам', auto: 'авто' }
const r1 = v => String(Math.round(Number(v) * 10) / 10).replace('.', ',')

export function D6Scheme({ geo, clamp, stop, width = 150, maxH = 80, big = false }) {
  const { fr } = geo
  // поля вокруг детали: снаружи — лапы, упор и подписи; на самой детали — только обработка и кромка
  const pad = big ? 34 : 16, sc = Math.min((width - pad * 2) / fr.L, (maxH - pad * 2) / fr.Wm)
  const w = fr.L * sc, h = fr.Wm * sc, Wv = w + pad * 2, Hv = h + pad * 2
  const X = x => pad + x * sc, Y = y => pad + h - y * sc           // станок: вид сверху, Y вверх
  const side = f => (f === 1 ? [X(0), Y(fr.Wm), X(fr.L), Y(fr.Wm)] : f === 2 ? [X(0), Y(0), X(fr.L), Y(0)] : f === 3 ? [X(fr.L), Y(0), X(fr.L), Y(fr.Wm)] : [X(0), Y(0), X(0), Y(fr.Wm)])
  const mid = f => { const s = side(f); return [(s[0] + s[2]) / 2, (s[1] + s[3]) / 2] }
  const out = f => (f === 1 ? [0, -1] : f === 2 ? [0, 1] : f === 3 ? [1, 0] : [-1, 0])      // наружу от торца (экран)
  const path = m => [m.start, ...m.segs.map(g => g.to)].map(q => `${X(q[0])},${Y(q[1])}`).join(' ')
  const dot = big ? 3 : 1.8
  const fs = big ? 10 : 7
  // снаружи у торца f, на расстоянии d от края детали: точка вдоль торца в доле t
  const at = (f, t, d) => { const s = side(f), o = out(f); return [s[0] + (s[2] - s[0]) * t + o[0] * d, s[1] + (s[3] - s[1]) * t + o[1] * d] }
  const claws = [0.25, 0.75].map(t => at(clamp, t, big ? 9 : 6))
  const cw = big ? 12 : 7, ch = big ? 7 : 4
  const horiz = clamp === 1 || clamp === 2
  const stp = at(stop, 0.5, big ? 10 : 7), so = out(stop), ss = big ? 7 : 4.5
  const tri = `${stp[0] - so[0] * ss},${stp[1] - so[1] * ss} ${stp[0] + so[0] * ss + so[1] * ss},${stp[1] + so[1] * ss + so[0] * ss} ${stp[0] + so[0] * ss - so[1] * ss},${stp[1] + so[1] * ss - so[0] * ss}`
  const edges = geo.edges || {}
  return (
    <svg width={Wv} height={Hv} viewBox={`0 0 ${Wv} ${Hv}`} style={{ flex: '0 0 auto', display: 'block', maxWidth: '100%' }}>
      <rect x={X(0)} y={Y(fr.Wm)} width={w} height={h} fill="var(--bg2)" stroke="var(--text-muted)" strokeWidth="1" />
      {/* кромка — толстая линия по торцу и её толщина снаружи */}
      {[1, 2, 3, 4].filter(f => Number(edges[f]) > 0).map(f => {
        const s = side(f), o = out(f), k = big ? 2 : 1.5, [mx, my] = mid(f)
        return (
          <g key={'ed' + f}>
            <line x1={s[0] + o[0] * k} y1={s[1] + o[1] * k} x2={s[2] + o[0] * k} y2={s[3] + o[1] * k} stroke="var(--amber)" strokeWidth={big ? 4 : 3} />
            <text x={mx + o[0] * (big ? 14 : 9)} y={my + o[1] * (big ? 12 : 8) + (f === 3 || f === 4 ? 3 : (f === 2 ? 4 : 2))} fontSize={fs} textAnchor="middle" fill="var(--amber)" fontWeight="600">{r1(edges[f])}</text>
          </g>
        )
      })}
      {/* лапы и упор — в стороне от детали */}
      {claws.map(([cx, cy], i) => <rect key={'cl' + i} x={cx - (horiz ? cw : ch) / 2} y={cy - (horiz ? ch : cw) / 2} width={horiz ? cw : ch} height={horiz ? ch : cw} rx="1.5" fill="none" stroke="var(--text-muted)" strokeWidth="1.2" />)}
      <polygon points={tri} fill="var(--blue)" opacity="0.8" />
      {(geo.edgeGrooves || []).map((g, i) => {
        const o = out(g.face), k = big ? 5 : 3
        return <line key={'eg' + i} x1={X(g.line[0]) - o[0] * k} y1={Y(g.line[1]) - o[1] * k} x2={X(g.line[2]) - o[0] * k} y2={Y(g.line[3]) - o[1] * k} stroke="var(--teal)" strokeWidth="2.5" />
      })}
      {geo.grooves.map((g, i) => (g.line
        ? <line key={'g' + i} x1={X(g.line[0])} y1={Y(g.line[1])} x2={X(g.line[2])} y2={Y(g.line[3])} stroke={g.face === fr.top ? 'var(--teal)' : 'var(--text-hint)'} strokeWidth={Math.max(1.5, g.width * sc)} strokeDasharray={g.face === fr.top ? '' : '3 2'} opacity="0.85" />
        : <polyline key={'g' + i} points={path(g.mill)} fill="none" stroke={g.face === fr.top ? 'var(--teal)' : 'var(--text-hint)'} strokeWidth="1.5" strokeDasharray={g.face === fr.top ? '' : '3 2'} />))}
      {geo.mills.filter(m => !m.notch && m.cat !== 'decor').map((m, i) => (
        <polyline key={'m' + i} points={path(m)} fill={m.cat === 'pocket' ? 'rgba(15,110,86,.15)' : 'none'} stroke={m.cat === 'edge' || m.cat === 'cutout' ? 'var(--danger)' : 'var(--teal)'} strokeWidth="1.5" strokeDasharray={m.face === fr.top ? '' : '3 2'} />
      ))}
      {geo.mills.filter(m => big && (m.cat === 'edge' || m.cat === 'cutout') && !m.notch).map((m, i) => (
        <circle key={'ms' + i} cx={X(m.start[0])} cy={Y(m.start[1])} r="3.5" fill="none" stroke="var(--danger)" strokeWidth="1.5" />
      ))}
      {geo.top.map((p, i) => <circle key={'t' + i} cx={X(p.X)} cy={Y(p.Y)} r={big ? Math.max(dot, p.dia * sc / 2) : dot} fill="var(--text)" />)}
      {geo.bottom.map((p, i) => <circle key={'b' + i} cx={X(p.X)} cy={Y(p.Y)} r={big ? Math.max(dot, p.dia * sc / 2) : dot} fill="none" stroke="var(--text-muted)" strokeWidth="1" />)}
      {geo.edge.map((p, i) => { const o = out(p.face), L = big ? Math.max(6, Math.min(30, p.depth * sc)) : 4; return <line key={'e' + i} x1={X(p.X)} y1={Y(p.Y)} x2={X(p.X) - o[0] * L} y2={Y(p.Y) - o[1] * L} stroke="var(--danger)" strokeWidth={big ? 3 : 2.2} /> })}
      {big && <text x={X(0)} y={Hv - 4} fontSize={fs} fill="var(--text-muted)">X {r1(fr.L)} × Y {r1(fr.Wm)} мм · ноль слева снизу</text>}
    </svg>
  )
}

// Деталь крупно — тем же просмотрщиком, что XML присадки: размеры цепью / от нуля, фильтр пластей, увеличение.
// Показывается сама программа детали (то, что уйдёт на станок), плюс лапы, упор и кромка.
const lsGet = (k, d) => { try { return localStorage.getItem(k) ?? d } catch { return d } }
const lsSet = (k, v) => { try { localStorage.setItem(k, v) } catch { /* без памяти */ } }
function PartXml({ d, T, post, man, types, clamp, stop, height }) {
  const [dims, setDims] = useState(() => { const v = lsGet('d6pvDims', 'chain'); return v === 'off' ? false : v })
  const [band, setBand] = useState(() => lsGet('d6pvBand', 'line'))
  const [filter, setFilter] = useState('all')
  const [sel, setSel] = useState(null)
  const p = useMemo(() => {
    let r
    try { r = panelXml(d, { T, id: 'x', post: { ...post, d6Man: man, d6All: true }, types }) } catch { r = null }
    return r ? parseDrillXml(r.xml).panels[0] || null : null
  }, [d, T, post, man, types])
  if (!p) return null
  const chip = on => ({ padding: '4px 9px', borderRadius: 14, fontSize: 11.5, border: '0.5px solid ' + (on ? 'var(--blue)' : 'var(--border-md)'), background: on ? 'var(--blue-light)' : 'transparent', color: 'var(--text)', cursor: 'pointer' })
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: height || 320, minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center', margin: '4px 0' }}>
        {[['chain', 'Цепь'], ['ord', 'От нуля'], [false, 'Без размеров']].map(([k, l]) => <button key={String(k)} type="button" style={chip(dims === k)} onClick={() => { setDims(k); lsSet('d6pvDims', k || 'off') }}>📏 {l}</button>)}
        <span style={{ width: 6 }} />
        {[['line', 'Кромка линией'], ['num', 'Кромка цифрой']].map(([k, l]) => <button key={k} type="button" style={chip(band === k)} onClick={() => { setBand(k); lsSet('d6pvBand', k) }}>{l}</button>)}
        <span style={{ width: 6 }} />
        {[['all', 'Все'], ['top', 'Сверху'], ['bottom', 'Снизу'], ['edge', 'Торцы']].map(([k, l]) => <button key={k} type="button" style={chip(filter === k)} onClick={() => setFilter(k)}>{l}</button>)}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Preview p={p} filter={filter} sel={sel} onSel={setSel} focus={null} dims={dims} marks={{ clamp, stop, band }} />
      </div>
    </div>
  )
}

/** Список деталей материала: схема, как ляжет на станок, и поворот / переворот. mat — { details, sheets?, thickness } */
export default function Drill6PartsView({ mat, order, post, man = {}, onMan, maxWidth = 360, split = 0 }) {
  const b = d6bOf(post) || {}
  const types = useMemo(() => parseEdgeTypes(order?.edge_types), [order])
  const T = Number(mat?.thickness) || 16
  const desk = useDesktop()                           // на компьютере — сразу крупно
  const [open, setOpen] = useState(null)              // крупно — id детали (на телефоне)
  const list = useMemo(() => {
    const seen = new Set(), out = []
    const idx = mat?.sheets?.length ? mat.sheets.flatMap(sh => (sh.placed || []).map(p => p.detailIndex)) : (mat?.details || []).map((_, i) => i)
    for (const di of idx) {
      const d = mat.details?.[di], id = rawDetail(d)?.id || 'i' + di
      if (!d || seen.has(id)) continue
      seen.add(id)
      const pv = d6Preview(d, { T, post: { ...post, d6Man: man }, types })
      if (pv) out.push({ id, d, pv })
    }
    return out
  }, [mat, post, man, T, types])
  const set = (id, v) => { const next = { ...man }; if (v) next[id] = v; else delete next[id]; onMan(next) }
  // как подписывать детали в списке: наименование, обозначение, позиция… (как на карте раскроя), запоминается
  const [lm, setLm] = useState(() => lsGet('d6pvLabel', 'name'))
  const nameOf = d => { const raw = rawDetail(d); return partLabel({ label: raw.display_name || raw.name || '', prefix: raw.prefix, detailIndex: 0 }, [d], lm) || raw.name || 'Деталь' }
  const modeSel = (
    <select value={lm} onChange={e => { setLm(e.target.value); lsSet('d6pvLabel', e.target.value) }} style={{ width: '100%', padding: '4px 6px', fontSize: 12, marginBottom: 6 }}>
      {LABEL_MODES.filter(([k]) => k !== 'none').map(([k, l]) => <option key={k} value={k}>{l}</option>)}
    </select>
  )
  const btn = { padding: '6px 10px', borderRadius: 20, fontSize: 12, border: '0.5px solid var(--border-md)', background: 'var(--bg)', color: 'var(--text)', cursor: 'pointer' }
  const clamp = Number(b.clamp) || 2, stop = Number(b.stop) || 4
  // компьютер: слева — выбранная деталь крупно, справа — список деталей (листается сам по себе)
  const [selId, setSelId] = useState(null)
  const viewRef = useRef(null)
  const [vw, setVw] = useState({ w: 500, h: 300 })
  useEffect(() => {
    if (!split || !viewRef.current || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => setVw({ w: Math.round(e.contentRect.width), h: Math.round(e.contentRect.height) }))
    ro.observe(viewRef.current)
    return () => ro.disconnect()
  }, [split])
  if (split) {
    const cur = list.find(x => x.id === selId) || list[0] || null
    const ci = cur ? list.indexOf(cur) : -1
    const go = k => { const n = list[ci + k]; if (n) setSelId(n.id) }
    const legend = <div style={{ fontSize: 11, color: 'var(--text-hint)' }}>Вид сверху. <span style={{ color: 'var(--amber)' }}>━ кромка (толщина)</span> · ▭ лапы · <span style={{ color: 'var(--blue)' }}>▲ упор</span> · ● сверху · ○ снизу · <span style={{ color: 'var(--danger)' }}>┃ в торец · ─ вырез (◯ начало)</span> · <span style={{ color: 'var(--teal)' }}>─ паз, ┅ снизу</span> · стрелки ↑↓ — следующая деталь</div>
    return (
      <div tabIndex={0} onKeyDown={e => { if (e.key === 'ArrowDown') { e.preventDefault(); go(1) } else if (e.key === 'ArrowUp') { e.preventDefault(); go(-1) } }}
        style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 260px', gap: 10, height: '100%', outline: 'none' }}>
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
          {cur ? (() => {
            const o = cur.pv.orient, raw = rawDetail(cur.d), g = cur.pv.geo, rotNow = ((o.turn - o.base) % 4 + 4) % 4
            return (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{nameOf(cur.d)}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{raw.length} × {raw.width} · {HOW[o.how]}{o.flip ? ' · перевёрнута' : ''} · сверху {g.top.length} · снизу {g.bottom.length} · в торец {g.edge.length}{g.grooves.length ? ` · пазов ${g.grooves.length}` : ''}{g.edgeGrooves.length ? ` · в торце ${g.edgeGrooves.length}` : ''}</div>
                  <div style={{ flex: 1 }} />
                  <button type="button" style={btn} onClick={() => set(cur.id, { rot: (rotNow + 1) % 4, flip: o.flip })}>↻ 90°</button>
                  <button type="button" style={{ ...btn, ...(o.flip ? { background: 'var(--amber-light)' } : {}) }} onClick={() => set(cur.id, { rot: 0, flip: !o.flip })}>⇅ Перевернуть</button>
                  {o.how === 'manual' && <button type="button" style={{ ...btn, color: 'var(--text-muted)' }} onClick={() => set(cur.id, null)}>Сброс</button>}
                </div>
                <div ref={viewRef} style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
                  <PartXml d={cur.d} T={T} post={post} man={man} types={types} clamp={clamp} stop={stop} height={Math.max(160, vw.h)} />
                </div>
                {legend}
              </>
            )
          })() : <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Нет деталей с обработкой.</div>}
        </div>
        <div style={{ overflowY: 'auto', minHeight: 0, borderLeft: '0.5px solid var(--border)', paddingLeft: 8 }}>
          {modeSel}
          <div style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 4 }}>Деталей: {list.length}</div>
          {list.map(({ id, d, pv }) => {
            const raw = rawDetail(d), on = cur?.id === id, o = pv.orient
            return (
              <div key={id} onClick={() => setSelId(id)} style={{ padding: '6px 8px', borderRadius: 8, cursor: 'pointer', marginBottom: 2, background: on ? 'var(--blue-light)' : 'transparent', border: on ? '1px solid var(--blue)' : '1px solid transparent' }}>
                <div style={{ fontSize: 13, fontWeight: on ? 600 : 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nameOf(d)}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{raw.length} × {raw.width}{o.how === 'manual' ? ' · вручную' : ''}{o.flip ? ' · ⇅' : ''}</div>
              </div>
            )
          })}
        </div>
      </div>
    )
  }
  return (
    <>
      <div style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 6 }}>
        Вид сверху. <span style={{ color: 'var(--amber)' }}>━ кромка (толщина)</span> · ▭ лапы · <span style={{ color: 'var(--blue)' }}>▲ упор</span> · ● отверстие сверху · ○ снизу · <span style={{ color: 'var(--danger)' }}>┃ в торец · ─ вырез (◯ — начало)</span> · <span style={{ color: 'var(--teal)' }}>─ паз, ┅ снизу</span>. {desk ? '' : 'Тап по детали — крупно.'}
      </div>
      <div style={{ maxWidth: 260 }}>{modeSel}</div>
      {list.map(({ id, d, pv }) => {
        const o = pv.orient, raw = rawDetail(d), big = desk || open === id
        const rotNow = ((o.turn - o.base) % 4 + 4) % 4
        const g = pv.geo
        return (
          <div key={id} style={{ padding: '8px 0', borderTop: '0.5px solid var(--border)' }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <div onClick={() => setOpen(big ? null : id)} style={{ cursor: 'pointer' }}>
                {!big && <D6Scheme geo={g} clamp={clamp} stop={stop} />}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div onClick={() => setOpen(big ? null : id)} style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' }}>{nameOf(d)}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{raw.length} × {raw.width} · {HOW[o.how]}{o.flip ? ' · перевёрнута' : ''}</div>
                <div style={{ fontSize: 10.5, color: 'var(--text-hint)' }}>сверху {g.top.length} · снизу {g.bottom.length} · в торец {g.edge.length}{g.grooves.length ? ` · пазов ${g.grooves.length}` : ''}{g.edgeGrooves.length ? ` · в торце ${g.edgeGrooves.length}` : ''}</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                  <button type="button" style={btn} onClick={() => set(id, { rot: (rotNow + 1) % 4, flip: o.flip })}>↻ 90°</button>
                  <button type="button" style={{ ...btn, ...(o.flip ? { background: 'var(--amber-light)' } : {}) }} onClick={() => set(id, { rot: 0, flip: !o.flip })}>⇅ Перевернуть</button>
                  {o.how === 'manual' && <button type="button" style={{ ...btn, color: 'var(--text-muted)' }} onClick={() => set(id, null)}>Сброс</button>}
                </div>
              </div>
            </div>
            {big && <div style={{ marginTop: 6 }}><PartXml d={d} T={T} post={post} man={man} types={types} clamp={clamp} stop={stop} height={Math.max(300, Math.round(maxWidth * 0.8))} /><button type="button" onClick={() => setOpen(null)} style={{ ...btn, marginTop: 6 }}>Свернуть</button></div>}
          </div>
        )
      })}
      {!list.length && <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Нет деталей с обработкой.</div>}
    </>
  )
}
