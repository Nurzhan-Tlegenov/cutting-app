// «Фигурные детали — по габаритам» → «Выборочно» (страница раскроя): какие фигурные детали укладывать и резать
// прямоугольником габарита (вырез — потом: после кромки, на шестистороннем), а какие — сразу по контуру.
// value — ключи отмеченных деталей (boxKey из liveNesting.js: id строки заказа)
import { parsePolygonFromDetail } from '../lib/trueShapeNesting'
import { boxKey } from '../lib/liveNesting'

const r1 = v => Math.round((Number(v) || 0) * 10) / 10

function Thumb({ poly, w, l }) {
  const S = 40, k = Math.min((S - 4) / (w || 1), (S - 4) / (l || 1)), ox = (S - w * k) / 2, oy = (S - l * k) / 2
  const pts = poly.map(([x, y]) => `${(ox + x * k).toFixed(1)},${(S - oy - y * k).toFixed(1)}`).join(' ')
  return (
    <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} style={{ flex: '0 0 auto' }}>
      <polygon points={pts} fill="var(--bg2)" stroke="var(--text-muted)" strokeWidth="1" />
    </svg>
  )
}

export default function ShapedPick({ details, value, onChange }) {
  const sel = new Set((value || []).map(String))
  const parts = []
  ;(details || []).forEach((d, i) => {
    const r = d?._raw || d
    let pr
    try { pr = parsePolygonFromDetail({ ...d, contour: typeof d.contour === 'string' ? d.contour : d.contour ? JSON.stringify(d.contour) : null }) } catch { pr = null }
    if (!pr?.custom) return
    parts.push({ key: boxKey(d, i), name: String(r.name || d.name || 'Деталь'), w: Number(d.width) || 0, l: Number(d.length) || 0, qty: Number(d.qty) || 1, poly: pr.polygon.map(q => (Array.isArray(q) ? q : [q.x, q.y])) })
  })
  if (!parts.length) return null
  const put = (keys, on) => { const n = new Set(sel); keys.forEach(k => (on ? n.add(k) : n.delete(k))); onChange([...n].filter(k => parts.some(p => p.key === k))) }
  const nOn = parts.filter(p => sel.has(p.key)).length
  const small = { padding: '3px 9px', borderRadius: 14, fontSize: 11.5, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text-muted)' }
  return (
    <div style={{ marginTop: 6, marginLeft: 23 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 2 }}>
        <span style={{ flex: 1 }}>По габаритам: {nOn} из {parts.length}. Не отмеченные — по контуру.</span>
        <button type="button" style={small} onClick={() => put(parts.map(p => p.key), true)}>все</button>
        <button type="button" style={small} onClick={() => put(parts.map(p => p.key), false)}>никакие</button>
      </div>
      <div style={{ maxHeight: 260, overflowY: 'auto' }}>
        {parts.map(p => (
          <label key={p.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', borderTop: '0.5px solid var(--border)', cursor: 'pointer' }}>
            <input type="checkbox" checked={sel.has(p.key)} onChange={e => put([p.key], e.target.checked)} style={{ width: 17, height: 17, flex: '0 0 auto' }} />
            <Thumb poly={p.poly} w={p.w} l={p.l} />
            <span style={{ flex: 1, minWidth: 0, fontSize: 12.5 }}>
              <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
              <span style={{ fontSize: 11, color: 'var(--text-hint)' }}>{r1(p.l)} × {r1(p.w)} · {p.qty} шт · {sel.has(p.key) ? 'по габариту (прямоугольник)' : 'по контуру'}</span>
            </span>
          </label>
        ))}
      </div>
    </div>
  )
}
