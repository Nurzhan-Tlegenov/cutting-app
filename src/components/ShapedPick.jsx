// «Фигурные детали — по габаритам» → «Выборочно» (страница раскроя): у каждой фигурной детали — её элементы
// (скругления, косые срезы, вырезы на краю, внутренние вырезы, см. shapeFeatures.js). Галочка у элемента — резать сразу;
// снята — убрать в габарит: вырезать потом (после кромки, на шестистороннем). Галочка у детали — весь контур по
// габариту (прямоугольником). value / onChange — { ключ детали (boxKey): [убранные элементы] }
import { useState } from 'react'
import { boxKey } from '../lib/liveNesting'
import { detailHoles } from '../lib/partHoles'
import { detailMeta, metaDes, metaPos } from '../lib/partLabel'
import { shapeFeatures, cutSilhouette } from '../lib/shapeFeatures'

const r1 = v => Math.round((Number(v) || 0) * 10) / 10

function Thumb({ sil, cut, holes = [], off = [], w, l }) {
  const S = 48, k = Math.min((S - 4) / (w || 1), (S - 4) / (l || 1)), ox = (S - w * k) / 2, oy = (S - l * k) / 2
  const pts = list => list.map(([x, y]) => `${(ox + x * k).toFixed(1)},${(S - oy - y * k).toFixed(1)}`).join(' ')
  return (
    <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} style={{ flex: '0 0 auto' }}>
      {cut && <polygon points={pts(cut)} fill="var(--amber-light)" stroke="var(--amber)" strokeWidth="0.8" strokeDasharray="2 2" />}
      <polygon points={pts(sil)} fill="var(--bg2)" fillOpacity={cut ? 0.85 : 1} stroke="var(--text-muted)" strokeWidth="1" />
      {holes.map(h => <polygon key={h.i} points={pts(h.pts)} fill={off.includes(h.i) ? 'var(--amber-light)' : 'var(--bg)'} stroke={off.includes(h.i) ? 'var(--amber)' : 'var(--danger)'} strokeWidth="0.8" strokeDasharray={off.includes(h.i) ? '2 2' : undefined} />)}
    </svg>
  )
}

// подпись — как на карте раскроя (labelMode): обозначение, позиция, наименование
function titleOf(d, mode) {
  const r = d?._raw || d
  const name = String(r?.name || d?.name || 'Деталь')
  const m = detailMeta(d) || detailMeta(r), des = metaDes(m), pos = metaPos(m)
  if (mode === 'des') return des || name
  if (mode === 'des_name') return des ? `${des} ${name}` : name
  if (mode === 'pos') return pos || name
  if (mode === 'pos_name') return pos ? `${pos} ${name}` : name
  return name
}

export default function ShapedPick({ details, value, onChange, labelMode = 'name' }) {
  const [open, setOpen] = useState({})
  const map = value || {}
  const parts = []
  ;(details || []).forEach((d, i) => {
    const f = shapeFeatures(d)
    if (!f || !f.feats.length) return
    const key = boxKey(d, i)
    const off = (map[key] || []).filter(id => f.feats.some(x => x.id === id))
    let holes
    try {
      const c = typeof d.contour === 'string' ? JSON.parse(d.contour) : d.contour
      holes = (c?.holes || []).map((h, hi) => (h?.type === 'pocket' ? null : { i: hi, pts: (detailHoles({ width: d.width, length: d.length, contour: JSON.stringify({ holes: [h] }) })[0] || []).map(q => [q.x, q.y]) })).filter(h => h && h.pts.length)
    } catch { holes = [] }
    const offHoleIdx = f.feats.filter(x => x.kind === 'hole' && off.includes(x.id)).map(x => x.hole)
    parts.push({ key, f, off, holes, offHoleIdx, name: titleOf(d, labelMode), w: Number(d.width) || 0, l: Number(d.length) || 0, qty: Number(d.qty) || 1,
      cut: off.some(id => id[0] === 'o') ? cutSilhouette(d, off) : null })
  })
  if (!parts.length) return null
  const set = (key, off) => onChange({ ...map, [key]: off })
  const outl = p => p.f.feats.filter(x => x.kind !== 'hole').map(x => x.id)
  const allBox = p => outl(p).length > 0 && outl(p).every(id => p.off.includes(id))
  const setAll = on => onChange(Object.fromEntries(parts.map(p => [p.key, on ? [...new Set([...p.off, ...outl(p)])] : p.off.filter(id => id[0] === 'h')])))
  const small = { padding: '3px 9px', borderRadius: 14, fontSize: 11.5, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text-muted)' }
  const nOn = parts.filter(p => p.off.length).length
  return (
    <div style={{ marginTop: 6, marginLeft: 23 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 2 }}>
        <span style={{ flex: 1 }}>Что-то убрано в габарит: {nOn} из {parts.length}</span>
        <button type="button" style={small} onClick={() => setAll(true)}>все по габариту</button>
        <button type="button" style={small} onClick={() => setAll(false)}>все по контуру</button>
      </div>
      <div style={{ maxHeight: 360, overflowY: 'auto' }}>
        {parts.map(p => {
          const box = allBox(p), some = p.off.length > 0, isOpen = !!open[p.key]
          return (
            <div key={p.key} style={{ borderTop: '0.5px solid var(--border)', padding: '3px 0' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {outl(p).length > 0
                  ? <input type="checkbox" title="Весь контур — по габариту (прямоугольником)" checked={box} ref={el => { if (el) el.indeterminate = !box && p.off.some(id => id[0] === 'o') }}
                      onChange={e => set(p.key, e.target.checked ? [...new Set([...p.off, ...outl(p)])] : p.off.filter(id => id[0] === 'h'))} style={{ width: 17, height: 17, flex: '0 0 auto' }} />
                  : <span style={{ width: 17, flex: '0 0 auto' }} />}
                <Thumb sil={p.f.sil} cut={p.cut} holes={p.holes} off={p.offHoleIdx} w={p.w} l={p.l} />
                <span onClick={() => setOpen(o => ({ ...o, [p.key]: !o[p.key] }))} style={{ flex: 1, minWidth: 0, fontSize: 12.5, cursor: 'pointer' }}>
                  <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                  <span style={{ fontSize: 11, color: some ? 'var(--amber)' : 'var(--text-hint)' }}>{r1(p.l)} × {r1(p.w)} · {p.qty} шт · {box && !p.offHoleIdx.length ? 'по габариту' : some ? `убрано: ${p.off.length} из ${p.f.feats.length}` : 'по контуру'} {isOpen ? '▾' : '▸'}</span>
                </span>
              </div>
              {isOpen && (
                <div style={{ margin: '2px 0 4px 25px' }}>
                  {p.f.feats.map(x => (
                    <label key={x.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '2px 0', cursor: 'pointer' }}>
                      <input type="checkbox" checked={!p.off.includes(x.id)} onChange={e => set(p.key, e.target.checked ? p.off.filter(id => id !== x.id) : [...p.off, x.id])} style={{ width: 16, height: 16, flex: '0 0 auto' }} />
                      <span style={{ flex: 1, minWidth: 0, color: p.off.includes(x.id) ? 'var(--amber)' : 'var(--text)' }}>{x.title}</span>
                      <span style={{ fontSize: 10.5, color: 'var(--text-hint)', whiteSpace: 'nowrap' }}>{p.off.includes(x.id) ? 'потом' : 'сразу'}</span>
                    </label>
                  ))}
                  <div style={{ fontSize: 10.5, color: 'var(--text-hint)' }}>Галочка — резать сразу на фрезере; снята — убрать в габарит, сделать потом.</div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
