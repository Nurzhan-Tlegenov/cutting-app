// «Фигурные контуры» сняты («Резать прямоугольниками»): все фигурные детали прямоугольником или выборочно.
// Выборочно — отмеченные детали режутся прямоугольником по габариту (вырез потом: после кромки, на шестистороннем),
// остальные — по своему контуру сразу на фрезере. Раскрой всё равно идёт по габаритам — деталь по контуру помещается
// в свой габарит, соседей не задевает. Хранится в «Обработке» раскроечного станка: ops.skip.contourPick и
// ops.skip.rectSel (id строки детали -> время отметки), поэтому одинаково в заказе (ЧПУ), на странице раскроя и в программе.
import { parsePolygonFromDetail } from '../lib/trueShapeNesting'
import Hint from './Hint'

const MAX_KEEP = 1500                                   // отметки старых заказов — не копим бесконечно
const rawOf = d => d?._raw || d
const r1 = v => Math.round((Number(v) || 0) * 10) / 10

/** Фигурные детали (внешний контур не прямоугольник): [{ id, name, w, l, qty, poly }] — по одной на строку заказа */
function shapedParts(details) {
  const out = [], seen = new Set()
  for (const d of details || []) {
    const r = rawOf(d)
    if (!r?.id || seen.has(r.id)) continue
    let pr
    try { pr = parsePolygonFromDetail({ ...r, contour: typeof r.contour === 'string' ? r.contour : r.contour ? JSON.stringify(r.contour) : null }) } catch { pr = null }
    if (!pr?.custom) continue
    seen.add(r.id)
    out.push({ id: r.id, name: String(r.name || 'Деталь'), w: Number(r.width) || 0, l: Number(r.length) || 0, qty: Number(r.qty) || 1,
      poly: pr.polygon.map(q => (Array.isArray(q) ? q : [q.x, q.y])) })
  }
  return out
}

function Thumb({ poly, w, l }) {
  const S = 40, k = Math.min((S - 4) / (w || 1), (S - 4) / (l || 1)), ox = (S - w * k) / 2, oy = (S - l * k) / 2
  const pts = poly.map(([x, y]) => `${(ox + x * k).toFixed(1)},${(S - oy - y * k).toFixed(1)}`).join(' ')
  return (
    <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} style={{ flex: '0 0 auto' }}>
      <polygon points={pts} fill="var(--bg2)" stroke="var(--text-muted)" strokeWidth="1" />
    </svg>
  )
}

/** skip — skipOf(ops); onSkip(patch) — записать в ops.skip (contourPick, rectSel); details — детали заказа (если есть) */
export default function RectPick({ skip, onSkip, details = null }) {
  if (!skip?.contour) return null
  const rect = skip.rect || {}
  const parts = details ? shapedParts(details) : []
  const setRect = (ids, on) => {
    const next = { ...rect }
    for (const id of ids) { if (on) next[id] = Date.now(); else delete next[id] }
    const keys = Object.keys(next)
    if (keys.length > MAX_KEEP) keys.sort((a, b) => (Number(next[a]) || 0) - (Number(next[b]) || 0)).slice(0, keys.length - MAX_KEEP).forEach(k => delete next[k])
    onSkip({ rectSel: next })
  }
  const chip = on => ({ flex: 1, padding: '7px 6px', borderRadius: 'var(--radius)', fontSize: 12, border: '0.5px solid ' + (on ? 'var(--blue)' : 'var(--border-md)'), background: on ? 'var(--blue-light)' : 'var(--bg)', color: on ? 'var(--blue-dark)' : 'var(--text-muted)' })
  const nOn = parts.filter(p => rect[p.id]).length
  return (
    <div style={{ marginTop: 8, paddingTop: 8, borderTop: '0.5px solid var(--border)' }}>
      <div style={{ fontSize: 12.5, fontWeight: 500, marginBottom: 4 }}>Прямоугольником резать</div>
      <div style={{ display: 'flex', gap: 4 }}>
        <button type="button" style={chip(!skip.pick)} onClick={() => onSkip({ contourPick: false })}>Все фигурные детали</button>
        <button type="button" style={chip(skip.pick)} onClick={() => onSkip({ contourPick: true })}>Выборочно</button>
      </div>
      {skip.pick && (details ? (
        parts.length ? (
          <div style={{ marginTop: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
              <span style={{ flex: 1 }}>Отмечено {nOn} из {parts.length}. Не отмеченные — по контуру, сразу на фрезере.</span>
              <button type="button" onClick={() => setRect(parts.map(p => p.id), true)} style={{ padding: '3px 9px', borderRadius: 14, fontSize: 11.5, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text-muted)' }}>все</button>
              <button type="button" onClick={() => setRect(parts.map(p => p.id), false)} style={{ padding: '3px 9px', borderRadius: 14, fontSize: 11.5, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text-muted)' }}>никакие</button>
            </div>
            {parts.map(p => (
              <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', borderTop: '0.5px solid var(--border)', cursor: 'pointer' }}>
                <input type="checkbox" checked={!!rect[p.id]} onChange={e => setRect([p.id], e.target.checked)} style={{ width: 18, height: 18, flex: '0 0 auto' }} />
                <Thumb poly={p.poly} w={p.w} l={p.l} />
                <span style={{ flex: 1, minWidth: 0, fontSize: 12.5 }}>
                  <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-hint)' }}>{r1(p.l)} × {r1(p.w)} · {p.qty} шт · {rect[p.id] ? 'прямоугольником' : 'по контуру'}</span>
                </span>
              </label>
            ))}
          </div>
        ) : <Hint>В этом заказе фигурных деталей нет — все режутся как есть.</Hint>
      ) : <Hint>Какие детали резать прямоугольником, отмечается в заказе: «ЧПУ» → «Обработка» или на странице раскроя (производство) — список фигурных деталей заказа.</Hint>)}
      <Hint>{skip.pick
        ? 'Отмеченные — прямоугольником по габариту: вырез потом (после кромки, на шестистороннем). Остальные — сразу по своему контуру. Раскрой всё равно по габаритам — деталь по контуру помещается в свой габарит. Внутренние вырезы — своей галочкой выше. На бирке (чертёж детали) — настоящий силуэт с вырезами, габарит раскроя — штрихом.'
        : 'Все фигурные детали режутся прямоугольником по габариту. «Выборочно» — сами отмечаете, какие прямоугольником, а какие сразу по контуру (например, внешнее скругление — сразу, а вырез, мешающий кромлению, — потом).'}</Hint>
    </div>
  )
}
