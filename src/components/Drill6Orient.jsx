// β-постпроцессор шестистороннего станка: положение каждой детали на станке — посмотреть, повернуть, перевернуть.
// Ручное положение хранится в настройках производства (d6Man: id строки детали -> { rot, flip }) и главнее правил.
import { useMemo } from 'react'
import { d6Preview, d6bOf } from '../lib/drill6Xml'
import { rawDetail, parseEdgeTypes } from '../lib/edgeCut'

const HOW = { manual: 'вручную', rules: 'по правилам', auto: 'авто' }

function Scheme({ geo, clamp, stop }) {
  const { fr } = geo
  const Wv = 150, pad = 10, sc = Math.min((Wv - pad * 2) / fr.L, 70 / fr.Wm)
  const w = fr.L * sc, h = fr.Wm * sc, Hv = h + pad * 2
  const X = x => pad + x * sc, Y = y => pad + h - y * sc           // станок: Y вверх
  const side = f => (f === 1 ? [X(0), Y(fr.Wm), X(fr.L), Y(fr.Wm)] : f === 2 ? [X(0), Y(0), X(fr.L), Y(0)] : f === 3 ? [X(fr.L), Y(0), X(fr.L), Y(fr.Wm)] : [X(0), Y(0), X(0), Y(fr.Wm)])
  const path = m => [m.start, ...m.segs.map(g => g.to)].map(q => `${X(q[0])},${Y(q[1])}`).join(' ')
  const cl = side(clamp), st = side(stop)
  return (
    <svg width={Wv} height={Hv} viewBox={`0 0 ${Wv} ${Hv}`} style={{ flex: '0 0 auto', display: 'block' }}>
      <rect x={X(0)} y={Y(fr.Wm)} width={w} height={h} fill="var(--bg2)" stroke="var(--text-muted)" strokeWidth="1" />
      <line x1={cl[0]} y1={cl[1]} x2={cl[2]} y2={cl[3]} stroke="var(--amber)" strokeWidth="4" />
      <line x1={st[0]} y1={st[1]} x2={st[2]} y2={st[3]} stroke="var(--blue)" strokeWidth="4" strokeDasharray="3 3" />
      {geo.grooves.map((g, i) => (g.line
        ? <line key={'g' + i} x1={X(g.line[0])} y1={Y(g.line[1])} x2={X(g.line[2])} y2={Y(g.line[3])} stroke={g.face === fr.top ? 'var(--teal)' : 'var(--text-hint)'} strokeWidth="2" strokeDasharray={g.face === fr.top ? '' : '3 2'} />
        : <polyline key={'g' + i} points={path(g.mill)} fill="none" stroke={g.face === fr.top ? 'var(--teal)' : 'var(--text-hint)'} strokeWidth="1.5" />))}
      {geo.mills.filter(m => !m.notch && m.cat !== 'decor').map((m, i) => <polyline key={'m' + i} points={path(m)} fill="none" stroke={m.cat === 'edge' ? 'var(--danger)' : 'var(--teal)'} strokeWidth="1.5" />)}
      {geo.top.map((p, i) => <circle key={'t' + i} cx={X(p.X)} cy={Y(p.Y)} r="1.8" fill="var(--text)" />)}
      {geo.bottom.map((p, i) => <circle key={'b' + i} cx={X(p.X)} cy={Y(p.Y)} r="1.8" fill="none" stroke="var(--text-muted)" strokeWidth="0.8" />)}
      {geo.edge.map((p, i) => <circle key={'e' + i} cx={X(p.X)} cy={Y(p.Y)} r="2.2" fill="var(--danger)" />)}
    </svg>
  )
}

export default function Drill6Orient({ mat, order, post, man = {}, onChange, onClose }) {
  const b = d6bOf(post) || {}
  const types = useMemo(() => parseEdgeTypes(order?.edge_types), [order])
  const T = Number(mat?.thickness) || 16
  const list = useMemo(() => {
    const seen = new Set(), out = []
    ;(mat?.sheets || []).forEach(sh => (sh.placed || []).forEach(p => {
      const d = mat.details?.[p.detailIndex], id = rawDetail(d)?.id
      if (!d || !id || seen.has(id)) return
      seen.add(id)
      const pv = d6Preview(d, { T, post: { ...post, d6Man: man }, types })
      if (pv) out.push({ id, d, pv })
    }))
    return out
  }, [mat, post, man, T, types])
  const set = (id, v) => { const next = { ...man }; if (v) next[id] = v; else delete next[id]; onChange(next) }
  const btn = { padding: '6px 10px', borderRadius: 20, fontSize: 12, border: '0.5px solid var(--border-md)', background: 'var(--bg)', color: 'var(--text)', cursor: 'pointer' }
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,.4)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--bg)', width: '100%', maxWidth: 720, maxHeight: '88vh', overflow: 'auto', borderRadius: '16px 16px 0 0', padding: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <div style={{ fontWeight: 500, fontSize: 15, flex: 1 }}>Положение деталей на станке · β</div>
          <button type="button" onClick={onClose} style={btn}>Готово</button>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 8 }}>
          Вид сверху. <span style={{ color: 'var(--amber)' }}>━ лапы</span> · <span style={{ color: 'var(--blue)' }}>┅ упор</span> · ● отверстие сверху · ○ снизу · <span style={{ color: 'var(--danger)' }}>● в торец, ─ вырез на краю</span> · <span style={{ color: 'var(--teal)' }}>─ паз</span>.
          {' '}Правила: {b.rules ? 'включены' : 'выключены'} (настройки постпроцессора → «β · Положение»). Повёрнутое и перевёрнутое вручную главнее правил и запоминается.
        </div>
        {list.map(({ id, d, pv }) => {
          const o = pv.orient, raw = rawDetail(d)
          const rotNow = ((o.turn - o.base) % 4 + 4) % 4
          return (
            <div key={id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 0', borderTop: '0.5px solid var(--border)' }}>
              <Scheme geo={pv.geo} clamp={Number(b.clamp) || 2} stop={Number(b.stop) || 4} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{raw.name || 'Деталь'}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{raw.length} × {raw.width} · {HOW[o.how]}{o.flip ? ' · перевёрнута' : ''}</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                  <button type="button" style={btn} onClick={() => set(id, { rot: (rotNow + 1) % 4, flip: o.flip })}>↻ 90°</button>
                  <button type="button" style={{ ...btn, ...(o.flip ? { background: 'var(--amber-light)' } : {}) }} onClick={() => set(id, { rot: 0, flip: !o.flip })}>⇅ Перевернуть</button>
                  {o.how === 'manual' && <button type="button" style={{ ...btn, color: 'var(--text-muted)' }} onClick={() => set(id, null)}>Сброс</button>}
                </div>
              </div>
            </div>
          )
        })}
        {!list.length && <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Нет деталей с обработкой.</div>}
      </div>
    </div>
  )
}
