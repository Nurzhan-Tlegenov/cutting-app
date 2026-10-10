import { useMemo, useRef, useState } from 'react'

// Просмотрщик XML-программ шестистороннего присадочного станка (формат SWJ): чертёж детали — вид сверху, как на картинках
// станка: ноль слева внизу, X — длина (Length), Y — ширина (Width). Торцы: 1 — сверху, 2 — снизу, 3 — справа, 4 — слева.
// files — [{ name, data }] (созданные программы); можно открыть и свои файлы с телефона — например, программы самого станка.

const num = v => { const x = Number(String(v ?? '').replace(',', '.')); return isFinite(x) ? x : 0 }
const r1 = v => String(Math.round(num(v) * 10) / 10)
const TYPE = { 1: 'Отв. в торец', 2: 'Отв. в пласть', 3: 'Фрезеровка', 4: 'Паз' }
const FACE = { 1: 'торец 1 (верх)', 2: 'торец 2 (низ)', 3: 'торец 3 (право)', 4: 'торец 4 (лево)', 5: 'пласть 5 (сверху)', 6: 'пласть 6 (снизу)' }
const COL = { top: '#1f6feb', bottom: '#d1242f', edge: '#1a7f37', mill: '#8250df', groove: '#bf8700', band: '#c03fb5' }

/** XML -> [{ id, name, L, W, T, ops, edges: {1..4: толщина} }] или { error } */
function parseSwj(text) {
  let doc
  try { doc = new DOMParser().parseFromString(String(text || '').replace(/^\uFEFF/, ''), 'application/xml') } catch { return { error: 'Не удалось прочитать XML' } }
  if (doc.getElementsByTagName('parsererror').length) return { error: 'Файл — не XML или повреждён' }
  const panels = [...doc.getElementsByTagName('Panel')].map(p => {
    const a = k => p.getAttribute(k)
    const ops = [...p.getElementsByTagName('Machining')].map(m => {
      const g = k => m.getAttribute(k)
      const o = { id: g('ID'), type: num(g('Type')), face: num(g('Face')), x: num(g('X')), y: num(g('Y')), z: num(g('Z')), depth: num(g('Depth')), d: num(g('Diameter')),
        ex: num(g('EndX')), ey: num(g('EndY')), w: num(g('Width')), tool: g('Drill') || '', pocket: g('Pocket') === '1', offset: g('ToolOffset') || '' }
      if (o.type === 3) o.pts = [[o.x, o.y], ...[...m.getElementsByTagName('Line')].map(l => [num(l.getAttribute('EndX')), num(l.getAttribute('EndY'))])]
      return o
    })
    const edges = { 1: 0, 2: 0, 3: 0, 4: 0 }
    ;[...p.getElementsByTagName('Edge')].forEach(e => { edges[num(e.getAttribute('Face'))] = num(e.getAttribute('Thickness')) })
    return { id: a('ID') || '', name: a('Name') || '', L: num(a('Length')), W: num(a('Width')), T: num(a('Thickness')), ops, edges }
  })
  return panels.length ? { panels } : { error: 'В файле нет деталей (Panel)' }
}

function Drawing({ p, show, sel, onPick }) {
  const pad = Math.max(p.L, p.W) * 0.07 + 20
  const vb = `${-pad} ${-pad} ${p.L + 2 * pad} ${p.W + 2 * pad}`
  const Y = y => p.W - y                    // в файле Y вверх, в SVG — вниз
  const k = Math.max(p.L, p.W) / 400        // толщина линий и шрифт — в долях размера детали
  const visible = o => (o.face === 5 ? show.top : o.face === 6 ? show.bottom : show.edge)
  const hit = (o, el) => <g key={o.id} onClick={e => { e.stopPropagation(); onPick(o) }} style={{ cursor: 'pointer' }} opacity={sel && sel !== o ? 0.55 : 1}>{el}</g>
  const sw = o => (sel === o ? 2.4 : 1.2) * k
  return (
    <svg viewBox={vb} style={{ width: '100%', maxHeight: '55vh', background: 'var(--bg2)', borderRadius: 'var(--radius)', touchAction: 'pan-y' }} onClick={() => onPick(null)}>
      <rect x={0} y={0} width={p.L} height={p.W} fill="var(--bg)" stroke="var(--text-muted)" strokeWidth={1.2 * k} />
      {/* кромка — как на картинках станка */}
      {p.edges[1] > 0 && <line x1={0} y1={0} x2={p.L} y2={0} stroke={COL.band} strokeWidth={4 * k} />}
      {p.edges[2] > 0 && <line x1={0} y1={p.W} x2={p.L} y2={p.W} stroke={COL.band} strokeWidth={4 * k} />}
      {p.edges[3] > 0 && <line x1={p.L} y1={0} x2={p.L} y2={p.W} stroke={COL.band} strokeWidth={4 * k} />}
      {p.edges[4] > 0 && <line x1={0} y1={0} x2={0} y2={p.W} stroke={COL.band} strokeWidth={4 * k} />}
      {/* номера торцов */}
      {[[1, p.L / 2, -pad / 2.4], [2, p.L / 2, p.W + pad / 1.6], [3, p.L + pad / 2, p.W / 2], [4, -pad / 2, p.W / 2]].map(([f, x, y]) => (
        <text key={f} x={x} y={y} fontSize={11 * k} textAnchor="middle" dominantBaseline="middle" fill="var(--text-hint)">{f}</text>
      ))}
      <text x={-pad / 2} y={p.W + pad / 1.6} fontSize={9 * k} textAnchor="middle" fill="var(--text-hint)">0</text>
      {/* сначала нижняя пласть (под деталью), затем торцы, пазы, фрезеровки и верхняя */}
      {[6, 0, 5].flatMap(layer => p.ops.filter(o => (layer === 0 ? o.face >= 1 && o.face <= 4 : o.face === layer) && visible(o)).map(o => {
        const under = o.face === 6, dash = under ? `${3 * k} ${2 * k}` : undefined
        if (o.type === 2) {
          const c = under ? COL.bottom : COL.top
          // невидимый круг побольше — чтобы по мелкому отверстию было легко попасть пальцем
          return hit(o, <><circle cx={o.x} cy={Y(o.y)} r={Math.max(o.d / 2, 7 * k)} fill="transparent" />
            <circle cx={o.x} cy={Y(o.y)} r={Math.max(o.d / 2, 1.5 * k)} fill={under ? 'none' : c} fillOpacity={0.85} stroke={c} strokeWidth={sw(o)} strokeDasharray={dash} /></>)
        }
        if (o.type === 1) {
          // отверстие в торец: полоса от торца вглубь детали на глубину
          const d = Math.max(o.d, 2 * k), len = o.depth
          const r = o.face === 1 ? [o.x - d / 2, Y(o.y), d, len] : o.face === 2 ? [o.x - d / 2, Y(o.y) - len, d, len]
            : o.face === 3 ? [o.x - len, Y(o.y) - d / 2, len, d] : [o.x, Y(o.y) - d / 2, len, d]
          return hit(o, <rect x={r[0]} y={r[1]} width={r[2]} height={r[3]} fill={COL.edge} fillOpacity={0.35} stroke={COL.edge} strokeWidth={sw(o)} />)
        }
        if (o.type === 4) {
          const c = under ? COL.bottom : COL.groove
          return hit(o, <line x1={o.x} y1={Y(o.y)} x2={o.ex} y2={Y(o.ey)} stroke={c} strokeOpacity={0.45} strokeWidth={Math.max(o.w, 2 * k)} strokeDasharray={dash} />)
        }
        if (o.type === 3 && o.pts?.length > 1) {
          const pts = o.pts.map(([x, y]) => `${x},${Y(y)}`).join(' ')
          const c = under ? COL.bottom : COL.mill
          return hit(o, o.pocket ? <polygon points={pts} fill={c} fillOpacity={0.25} stroke={c} strokeWidth={sw(o)} strokeDasharray={dash} />
            : <polyline points={pts} fill="none" stroke={c} strokeWidth={sw(o) * 1.6} strokeDasharray={dash} />)
        }
        return null
      }))}
    </svg>
  )
}

export default function Drill6Viewer({ files: initial = [], onClose, title = 'Просмотр XML' }) {
  const [files, setFiles] = useState(initial)
  const [i, setI] = useState(0)
  const [sel, setSel] = useState(null)
  const [raw, setRaw] = useState(false)
  const [show, setShow] = useState({ top: true, bottom: true, edge: true })
  const input = useRef(null)
  const f = files[Math.min(i, files.length - 1)]
  const parsed = useMemo(() => (f ? parseSwj(f.data) : null), [f])
  const p = parsed?.panels?.[0]
  const go = n => { setI(Math.max(0, Math.min(files.length - 1, n))); setSel(null) }
  const open = async e => {
    const list = [...(e.target.files || [])]
    if (!list.length) return
    const read = await Promise.all(list.map(async x => ({ name: x.name, data: await x.text() })))
    setFiles(read.sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true }))); setI(0); setSel(null)
    e.target.value = ''
  }
  const count = p ? {
    top: p.ops.filter(o => o.face === 5).length, bottom: p.ops.filter(o => o.face === 6).length, edge: p.ops.filter(o => o.face >= 1 && o.face <= 4).length,
  } : {}
  const chip = (k, label, c) => (
    <button key={k} type="button" onClick={() => setShow(s => ({ ...s, [k]: !s[k] }))}
      style={{ flex: 1, padding: '6px 4px', borderRadius: 20, fontSize: 12, border: `1px solid ${c}`, background: show[k] ? c : 'transparent', color: show[k] ? 'white' : c }}>{label} · {count[k] || 0}</button>
  )
  const small = { padding: '6px 11px', borderRadius: 20, fontSize: 12, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text-muted)', whiteSpace: 'nowrap' }
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 250, background: 'var(--bg)', overflowY: 'auto', padding: '10px 12px calc(16px + env(safe-area-inset-bottom))', boxSizing: 'border-box' }}>
      <div style={{ maxWidth: 900, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--blue)', fontSize: 22, padding: 0 }}>←</button>
          <div style={{ flex: 1, minWidth: 0, fontWeight: 500 }}>{title}</div>
          <button type="button" style={small} onClick={() => input.current?.click()}>📂 Открыть XML</button>
          <input ref={input} type="file" accept=".xml,.XML,text/xml,application/xml" multiple onChange={open} style={{ display: 'none' }} />
        </div>
        {!files.length && <p style={{ fontSize: 13, color: 'var(--text-hint)', textAlign: 'center', padding: '30px 0' }}>Откройте XML-файлы шестистороннего станка (можно сразу несколько) — здесь будет чертёж каждой детали.</p>}
        {f && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
              <button type="button" style={small} disabled={i <= 0} onClick={() => go(i - 1)}>‹</button>
              <select value={i} onChange={e => go(Number(e.target.value))} style={{ flex: 1, minWidth: 0, padding: '6px 8px', fontSize: 13 }}>
                {files.map((x, k) => <option key={x.name + k} value={k}>{k + 1}. {x.name}</option>)}
              </select>
              <button type="button" style={small} disabled={i >= files.length - 1} onClick={() => go(i + 1)}>›</button>
            </div>
            {parsed?.error ? <p className="error-text">{f.name}: {parsed.error}</p> : p && (
              <>
                <div style={{ fontSize: 14, fontWeight: 500 }}>{p.name || p.id}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
                  {r1(p.L)} × {r1(p.W)} × {r1(p.T)} мм · обработок {p.ops.length}
                  {[1, 2, 3, 4].some(k => p.edges[k] > 0) && <> · кромка: {[1, 2, 3, 4].filter(k => p.edges[k] > 0).map(k => `${k} (${r1(p.edges[k])})`).join(', ')}</>}
                  {parsed.panels.length > 1 && <> · деталей в файле {parsed.panels.length}, показана первая</>}
                </div>
                <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                  {chip('top', 'Пласть 5', COL.top)}{chip('bottom', 'Пласть 6', COL.bottom)}{chip('edge', 'Торцы', COL.edge)}
                </div>
                <Drawing p={p} show={show} sel={sel} onPick={setSel} />
                <div style={{ minHeight: 40, fontSize: 12, color: 'var(--text-muted)', padding: '6px 2px' }}>
                  {sel ? <>
                    <b style={{ color: 'var(--text)' }}>{TYPE[sel.type] || 'Тип ' + sel.type}</b> · {FACE[sel.face] || 'Face ' + sel.face} · X {r1(sel.x)} Y {r1(sel.y)}
                    {sel.type === 1 && <> Z {r1(sel.z)}</>}
                    {sel.d > 0 && <> · Ø{r1(sel.d)}</>}{sel.type === 4 && <> → X {r1(sel.ex)} Y {r1(sel.ey)} · ширина {r1(sel.w)}</>}
                    {' '}· глубина {r1(sel.depth)}{sel.type === 3 && <> · {sel.pocket ? 'выборка' : 'по линии'} · фреза {sel.offset === '右' ? 'справа' : sel.offset === '左' ? 'слева' : 'по центру'} · отрезков {sel.pts.length - 1}</>}
                    {sel.tool && <> · {sel.tool}</>}
                  </> : 'Нажмите на отверстие, паз или фрезеровку — покажутся координаты. Пласть 5 — сплошные, пласть 6 (снизу) — пунктир.'}
                </div>
                <details style={{ marginBottom: 8 }}>
                  <summary style={{ fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}>Список обработок ({p.ops.length})</summary>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ fontSize: 11, borderCollapse: 'collapse', width: '100%', marginTop: 4 }}>
                      <thead><tr style={{ color: 'var(--text-hint)', textAlign: 'left' }}>{['Тип', 'Face', 'X', 'Y', 'Ø / шир.', 'Глуб.'].map(h => <th key={h} style={{ padding: '2px 4px' }}>{h}</th>)}</tr></thead>
                      <tbody>{p.ops.map(o => (
                        <tr key={o.id} onClick={() => setSel(o)} style={{ cursor: 'pointer', background: sel === o ? 'var(--blue-light)' : undefined, borderTop: '0.5px solid var(--border)' }}>
                          <td style={{ padding: '2px 4px' }}>{TYPE[o.type] || o.type}</td><td style={{ padding: '2px 4px' }}>{o.face}</td>
                          <td style={{ padding: '2px 4px' }}>{r1(o.x)}</td><td style={{ padding: '2px 4px' }}>{r1(o.y)}</td>
                          <td style={{ padding: '2px 4px' }}>{o.d ? r1(o.d) : o.w ? r1(o.w) : ''}</td><td style={{ padding: '2px 4px' }}>{r1(o.depth)}</td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                </details>
              </>
            )}
            <button type="button" style={small} onClick={() => setRaw(v => !v)}>{raw ? 'Скрыть XML' : '</> Показать XML'}</button>
            {raw && <pre style={{ fontSize: 10.5, background: 'var(--bg2)', borderRadius: 'var(--radius)', padding: 8, marginTop: 6, overflowX: 'auto', whiteSpace: 'pre' }}>{f.data}</pre>}
          </>
        )}
      </div>
    </div>
  )
}
