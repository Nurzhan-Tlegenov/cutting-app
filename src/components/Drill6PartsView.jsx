// β-постпроцессор шестистороннего станка: детали так, как они лягут на станок, — вся присадка, пазы, вырезы,
// лапы и упор. Меняются настройки постпроцессора — схема перестраивается сразу. Деталь можно повернуть и перевернуть
// (ручное положение — в настройках производства d6Man: id строки детали -> { rot, flip }, главнее правил).
import { useMemo, useState } from 'react'
import { d6Preview, d6bOf } from '../lib/drill6Xml'
import { rawDetail, parseEdgeTypes } from '../lib/edgeCut'

const HOW = { manual: 'вручную', rules: 'по правилам', auto: 'авто' }
const r1 = v => String(Math.round(Number(v) * 10) / 10).replace('.', ',')

export function D6Scheme({ geo, clamp, stop, width = 150, maxH = 80, big = false }) {
  const { fr } = geo
  const pad = big ? 26 : 10, sc = Math.min((width - pad * 2) / fr.L, (maxH - pad * 2) / fr.Wm)
  const w = fr.L * sc, h = fr.Wm * sc, Wv = w + pad * 2, Hv = h + pad * 2
  const X = x => pad + x * sc, Y = y => pad + h - y * sc           // станок: вид сверху, Y вверх
  const side = f => (f === 1 ? [X(0), Y(fr.Wm), X(fr.L), Y(fr.Wm)] : f === 2 ? [X(0), Y(0), X(fr.L), Y(0)] : f === 3 ? [X(fr.L), Y(0), X(fr.L), Y(fr.Wm)] : [X(0), Y(0), X(0), Y(fr.Wm)])
  const mid = f => { const s = side(f); return [(s[0] + s[2]) / 2, (s[1] + s[3]) / 2] }
  const out = f => (f === 1 ? [0, -1] : f === 2 ? [0, 1] : f === 3 ? [1, 0] : [-1, 0])      // наружу от торца (экран)
  const path = m => [m.start, ...m.segs.map(g => g.to)].map(q => `${X(q[0])},${Y(q[1])}`).join(' ')
  const cl = side(clamp), st = side(stop)
  const dot = big ? 3 : 1.8
  const fs = big ? 10 : 0
  return (
    <svg width={Wv} height={Hv} viewBox={`0 0 ${Wv} ${Hv}`} style={{ flex: '0 0 auto', display: 'block', maxWidth: '100%' }}>
      <rect x={X(0)} y={Y(fr.Wm)} width={w} height={h} fill="var(--bg2)" stroke="var(--text-muted)" strokeWidth="1" />
      <line x1={cl[0]} y1={cl[1]} x2={cl[2]} y2={cl[3]} stroke="var(--amber)" strokeWidth={big ? 6 : 4} />
      <line x1={st[0]} y1={st[1]} x2={st[2]} y2={st[3]} stroke="var(--blue)" strokeWidth={big ? 6 : 4} strokeDasharray="4 3" />
      {(geo.edgeGrooves || []).map((g, i) => {
        const s = side(g.face), o = out(g.face), k = 3
        return <line key={'eg' + i} x1={X(g.line[0]) + o[0] * k} y1={Y(g.line[1]) + o[1] * k} x2={X(g.line[2]) + o[0] * k} y2={Y(g.line[3]) + o[1] * k} stroke="var(--teal)" strokeWidth="2.5" data-s={s.join()} />
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
      {big && [1, 2, 3, 4].map(f => { const [mx, my] = mid(f), o = out(f); return <text key={'f' + f} x={mx + o[0] * 15} y={my + o[1] * 13 + 3} fontSize={fs} textAnchor="middle" fill="var(--text-hint)">F{f}</text> })}
      {big && <text x={X(0)} y={Hv - 4} fontSize={fs} fill="var(--text-muted)">X {r1(fr.L)} × Y {r1(fr.Wm)} мм · ноль слева снизу</text>}
    </svg>
  )
}

/** Список деталей материала: схема, как ляжет на станок, и поворот / переворот. mat — { details, sheets?, thickness } */
export default function Drill6PartsView({ mat, order, post, man = {}, onMan, maxWidth = 360 }) {
  const b = d6bOf(post) || {}
  const types = useMemo(() => parseEdgeTypes(order?.edge_types), [order])
  const T = Number(mat?.thickness) || 16
  const [open, setOpen] = useState(null)              // крупно — id детали
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
  const btn = { padding: '6px 10px', borderRadius: 20, fontSize: 12, border: '0.5px solid var(--border-md)', background: 'var(--bg)', color: 'var(--text)', cursor: 'pointer' }
  const clamp = Number(b.clamp) || 2, stop = Number(b.stop) || 4
  return (
    <>
      <div style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 6 }}>
        Вид сверху. <span style={{ color: 'var(--amber)' }}>━ лапы</span> · <span style={{ color: 'var(--blue)' }}>┅ упор</span> · ● отверстие сверху · ○ снизу · <span style={{ color: 'var(--danger)' }}>┃ в торец · ─ вырез (◯ — начало)</span> · <span style={{ color: 'var(--teal)' }}>─ паз, ┅ снизу</span>. Тап по детали — крупно.
      </div>
      {list.map(({ id, d, pv }) => {
        const o = pv.orient, raw = rawDetail(d), big = open === id
        const rotNow = ((o.turn - o.base) % 4 + 4) % 4
        const g = pv.geo
        return (
          <div key={id} style={{ padding: '8px 0', borderTop: '0.5px solid var(--border)' }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <div onClick={() => setOpen(big ? null : id)} style={{ cursor: 'pointer' }}>
                {!big && <D6Scheme geo={g} clamp={clamp} stop={stop} />}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div onClick={() => setOpen(big ? null : id)} style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' }}>{raw.name || 'Деталь'}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{raw.length} × {raw.width} · {HOW[o.how]}{o.flip ? ' · перевёрнута' : ''}</div>
                <div style={{ fontSize: 10.5, color: 'var(--text-hint)' }}>сверху {g.top.length} · снизу {g.bottom.length} · в торец {g.edge.length}{g.grooves.length ? ` · пазов ${g.grooves.length}` : ''}{g.edgeGrooves.length ? ` · в торце ${g.edgeGrooves.length}` : ''}</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                  <button type="button" style={btn} onClick={() => set(id, { rot: (rotNow + 1) % 4, flip: o.flip })}>↻ 90°</button>
                  <button type="button" style={{ ...btn, ...(o.flip ? { background: 'var(--amber-light)' } : {}) }} onClick={() => set(id, { rot: 0, flip: !o.flip })}>⇅ Перевернуть</button>
                  {o.how === 'manual' && <button type="button" style={{ ...btn, color: 'var(--text-muted)' }} onClick={() => set(id, null)}>Сброс</button>}
                </div>
              </div>
            </div>
            {big && <div onClick={() => setOpen(null)} style={{ marginTop: 6, cursor: 'pointer', display: 'flex', justifyContent: 'center' }}><D6Scheme geo={g} clamp={clamp} stop={stop} width={maxWidth} maxH={Math.round(maxWidth * 0.75)} big /></div>}
          </div>
        )
      })}
      {!list.length && <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Нет деталей с обработкой.</div>}
    </>
  )
}
