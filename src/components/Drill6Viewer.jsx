import { useMemo, useRef, useState } from 'react'
import { unzipSync } from 'fflate'
import { parseDrillXml, panelSummary, TYPE_NAMES, FACE_NAMES } from '../lib/drill6Parse'

// Просмотрщик XML-программ присадочного станка (Syntec / SWJ): деталь сверху — отверстия в пласти и торцы, пазы,
// фрезеровки и выемки, контур, кромка. Открывает созданные приложением файлы и любые XML с устройства (и архивы .zip).
// Поиск по коду детали — как на станке при сканировании бирки: код = ID детали = имя файла.
// files — [{ name, data }] (необязательно); onClose — закрыть.

const r3 = v => String(Math.round((Number(v) || 0) * 1000) / 1000)
const C = { top: '#2f6fd6', bottom: '#d64545', edge: '#1f9d6b', groove: '#e08a00', mill: '#8a4fd1', band: '#c23ac0', off: '#9a9a9a', sel: '#f5b400' }
const isTop = o => o.face === 5, isBottom = o => o.face === 6, isEdge = o => o.face >= 1 && o.face <= 4
const FILTERS = [['all', 'Все'], ['top', 'Сверху · 5'], ['bottom', 'Снизу · 6'], ['edge', 'Торцы']]
const pass = (o, f) => f === 'all' || (f === 'top' ? isTop(o) : f === 'bottom' ? isBottom(o) : isEdge(o))

async function readFiles(list) {
  const out = []
  for (const f of list) {
    const name = f.name || 'file.xml'
    if (/\.zip$/i.test(name)) {
      try {
        const z = unzipSync(new Uint8Array(await f.arrayBuffer()))
        for (const [n, bytes] of Object.entries(z)) if (/\.xml$/i.test(n)) out.push({ name: n.split('/').pop(), data: new TextDecoder('utf-8').decode(bytes) })
      } catch { out.push({ name, data: '', error: 'Не удалось открыть архив' }) }
    } else out.push({ name, data: await f.text() })
  }
  return out
}

/** Путь контура: start, segs [{ to, angle }] -> SVG d (экран: Y вниз) */
function pathD(start, segs, W, closed) {
  const sx = p => r3(p[0]), sy = p => r3(W - p[1])
  let d = `M${sx(start)} ${sy(start)}`, cur = start
  for (const g of segs) {
    const a = Math.abs(g.angle || 0)
    if (a > 0.001) {
      const ch = Math.hypot(g.to[0] - cur[0], g.to[1] - cur[1]), r = ch / (2 * Math.sin(Math.min(a, 359.999) * Math.PI / 360)) || ch / 2
      // угол > 0 — по часовой на станке (Y вверх); на экране Y вниз — против часовой, флаг дуги 0
      d += ` A${r3(r)} ${r3(r)} 0 ${a > 180 ? 1 : 0} ${g.angle > 0 ? 0 : 1} ${sx(g.to)} ${sy(g.to)}`
    } else d += ` L${sx(g.to)} ${sy(g.to)}`
    cur = g.to
  }
  return closed ? d + ' Z' : d
}
/** Контур детали из <Outline>: Radius — дуга до следующей точки (> 0 — против часовой) */
function outlineD(pts, W) {
  if (!pts?.length) return ''
  const segs = pts.map((p, i) => {
    const q = pts[(i + 1) % pts.length]
    if (!p.R) return { to: [q.X, q.Y], angle: 0 }
    const ch = Math.hypot(q.X - p.X, q.Y - p.Y), r = Math.abs(p.R), a = 2 * Math.asin(Math.min(1, ch / (2 * r))) * 180 / Math.PI
    return { to: [q.X, q.Y], angle: p.R > 0 ? -a : a }
  })
  return pathD([pts[0].X, pts[0].Y], segs, W, true)
}

function PanelSvg({ p, filter, sel, onSel, zoom }) {
  const { L, W } = p
  const pad = Math.max(L, W) * 0.06 + 20
  const sw = Math.max(L, W) / 400                    // толщина линий в мм детали
  const font = Math.max(L, W) / 28
  const dim = o => (!o.gen ? 0.35 : sel != null && sel !== o.i ? 0.55 : 1)
  const hl = o => (sel === o.i ? { stroke: C.sel, strokeWidth: sw * 4 } : {})
  const els = []
  // кромка — по торцам 1..4
  const band = { 1: [0, 0, L, 0], 2: [0, W, L, W], 3: [L, 0, L, W], 4: [0, 0, 0, W] }
  for (const f of [1, 2, 3, 4]) if (p.edges[f] > 0) {
    const [x1, y1, x2, y2] = band[f], off = sw * 5, dx = f === 3 ? off : f === 4 ? -off : 0, dy = f === 1 ? -off : f === 2 ? off : 0
    els.push(<line key={'b' + f} x1={x1 + dx} y1={y1 + dy} x2={x2 + dx} y2={y2 + dy} stroke={C.band} strokeWidth={sw * 5} strokeLinecap="round" />)
  }
  for (const o of p.ops) {
    if (!pass(o, filter)) continue
    const k = 'o' + o.i, click = e => { e.stopPropagation(); onSel(o.i) }, op = dim(o)
    const col = !o.gen ? C.off : null
    if ((o.type === 2 || o.type === 1) && isEdge(o)) {
      // отверстие в торец: полоса от торца вглубь детали на глубину
      const d = o.d || 5, len = o.depth || 10
      let x = o.x, y = W - o.y, w = d, h = len
      if (o.face === 1) { x -= d / 2; h = len }                       // торец Y = ширина (верх экрана), вглубь — вниз
      else if (o.face === 2) { x -= d / 2; y -= len }
      else if (o.face === 3) { y -= d / 2; x -= len; w = len; h = d }
      else { y -= d / 2; w = len; h = d }
      els.push(<rect key={k} x={x} y={y} width={w} height={h} fill={col || C.edge} fillOpacity={0.35} stroke={col || C.edge} strokeWidth={sw} opacity={op} onClick={click} {...hl(o)} />)
    } else if (o.type === 2) {
      const r = Math.max(o.d / 2, sw * 2), bottom = isBottom(o)
      els.push(<circle key={k + 'h'} cx={o.x} cy={W - o.y} r={Math.max(r * 2, sw * 12)} fill="transparent" onClick={click} />)   // по мелкому отверстию легко попасть пальцем
      els.push(<circle key={k} cx={o.x} cy={W - o.y} r={r} fill={bottom ? 'none' : (col || C.top)} fillOpacity={0.85} stroke={col || (bottom ? C.bottom : C.top)} strokeWidth={bottom ? sw * 1.6 : sw} strokeDasharray={bottom ? `${sw * 3} ${sw * 2}` : undefined} opacity={op} onClick={click} {...hl(o)} />)
    } else if (o.type === 4) {
      const bottom = isBottom(o)
      if (isEdge(o)) els.push(<line key={k} x1={o.x} y1={W - o.y} x2={o.endX} y2={W - o.endY} stroke={col || C.edge} strokeWidth={sw * 6} opacity={op} onClick={click} {...hl(o)} />)
      else els.push(<line key={k} x1={o.x} y1={W - o.y} x2={o.endX} y2={W - o.endY} stroke={col || C.groove} strokeOpacity={bottom ? 0.45 : 0.75} strokeWidth={Math.max(o.width, sw * 2)} strokeDasharray={bottom ? `${sw * 8} ${sw * 4}` : undefined} opacity={op} onClick={click} {...(sel === o.i ? { stroke: C.sel } : {})} />)
    } else if (o.type === 3 && o.segs?.length) {
      const d = pathD([o.x, o.y], o.segs, W, o.closed), bottom = isBottom(o)
      els.push(<path key={k} d={d} fill={o.pocket ? (col || C.mill) : 'none'} fillOpacity={0.25} stroke={col || C.mill} strokeWidth={sw * 2} strokeDasharray={bottom ? `${sw * 6} ${sw * 3}` : undefined} opacity={op} onClick={click} {...hl(o)} />)
      // начало пути — точка
      els.push(<circle key={k + 's'} cx={o.x} cy={W - o.y} r={sw * 3} fill={col || C.mill} opacity={op} onClick={click} />)
    }
  }
  const outline = outlineD(p.outline, W)
  return (
    <svg viewBox={`${-pad} ${-pad} ${L + 2 * pad} ${W + 2 * pad}`} style={{ width: `${100 * zoom}%`, display: 'block', touchAction: 'pan-x pan-y' }} onClick={() => onSel(null)}>
      {outline
        ? <><rect x={0} y={0} width={L} height={W} fill="none" stroke="var(--border-md)" strokeWidth={sw} strokeDasharray={`${sw * 4} ${sw * 4}`} /><path d={outline} fill="var(--bg2)" stroke="var(--text)" strokeWidth={sw * 1.5} /></>
        : <rect x={0} y={0} width={L} height={W} fill="var(--bg2)" stroke="var(--text)" strokeWidth={sw * 1.5} />}
      {els}
      {/* номера торцов — как в файлах станка: 1 — верх, 2 — низ, 3 — справа, 4 — слева */}
      {[[1, L * 0.12, -pad * 0.45], [2, L * 0.12, W + pad * 0.45], [3, L + pad * 0.45, W * 0.2], [4, -pad * 0.34, W * 0.2]].map(([f, x, y]) => (
        <text key={'f' + f} x={x} y={y} fontSize={font * 0.8} textAnchor="middle" dominantBaseline="middle" fill="var(--text-hint)">{f}</text>
      ))}
      {/* ноль детали и размеры */}
      <circle cx={0} cy={W} r={sw * 4} fill="var(--text)" />
      <text x={-sw * 6} y={W + font * 0.9} fontSize={font * 0.7} fill="var(--text-hint)" textAnchor="end">0</text>
      <text x={L / 2} y={W + font * 1.4} fontSize={font} fill="var(--text-muted)" textAnchor="middle">X · {r3(p.L)}</text>
      <text x={-pad * 0.74} y={W / 2} fontSize={font} fill="var(--text-muted)" textAnchor="middle" dominantBaseline="middle" transform={`rotate(-90 ${-pad * 0.74} ${W / 2})`}>Y · {r3(p.W)}</text>
    </svg>
  )
}

export default function Drill6Viewer({ files: initial = [], onClose, title = 'Просмотр XML присадки' }) {
  const [files, setFiles] = useState(initial)
  const parsed = useMemo(() => files.map(f => ({ ...f, ...(f.error ? { panels: [] } : parseDrillXml(f.data, f.name)) })), [files])
  const panels = useMemo(() => parsed.flatMap(f => f.panels), [parsed])
  const errors = parsed.filter(f => f.error)
  const [idx, setIdx] = useState(0)
  const [filter, setFilter] = useState('all')
  const [sel, setSel] = useState(null)
  const [zoom, setZoom] = useState(1)
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const inp = useRef(null)
  const p = panels[Math.min(idx, panels.length - 1)] || null
  const go = i => { setIdx(Math.max(0, Math.min(panels.length - 1, i))); setSel(null) }
  const open = async list => {
    if (!list?.length) return
    setBusy(true)
    const got = await readFiles([...list])
    setBusy(false)
    setFiles(got); setIdx(0); setSel(null); setQ('')
  }
  // поиск по коду детали (как сканер станка: код = ID детали) или по названию
  const find = v => {
    setQ(v)
    const s = v.trim().toLowerCase()
    if (!s) return
    const i = panels.findIndex(x => x.id.toLowerCase() === s)
    const j = i >= 0 ? i : panels.findIndex(x => x.id.toLowerCase().includes(s) || x.name.toLowerCase().includes(s) || x.file.toLowerCase().includes(s))
    if (j >= 0) go(j)
  }
  const sum = p ? panelSummary(p) : null
  const selOp = p && sel != null ? p.ops.find(o => o.i === sel) : null
  const small = { padding: '6px 11px', borderRadius: 20, fontSize: 12, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text-muted)', whiteSpace: 'nowrap' }
  const chip = on => ({ flex: '0 0 auto', padding: '6px 10px', borderRadius: 20, border: 'none', fontSize: 12, background: on ? 'var(--blue)' : 'var(--bg2)', color: on ? 'white' : 'var(--text-muted)' })
  const opText = o => {
    const f = FACE_NAMES[o.face] || `Face ${o.face}`
    if (o.type === 2 || o.type === 1) return `Ø${r3(o.d)} × ${r3(o.depth)} · ${f} · X ${r3(o.x)} Y ${r3(o.y)}${o.z != null ? ' Z ' + r3(o.z) : ''}`
    if (o.type === 4) return `${r3(o.width)} × ${r3(o.depth)} · ${f} · (${r3(o.x)}; ${r3(o.y)}) → (${r3(o.endX)}; ${r3(o.endY)})`
    if (o.type === 3) return `${o.pocket ? 'выборка' : o.closed ? 'замкнутый' : 'открытый'} · глубина ${r3(o.depth)} · ${f} · фреза ${o.offset || '—'} · отрезков ${o.segs?.length || 0}${o.segs?.some(g => g.angle) ? ', есть дуги' : ''}`
    return f
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--bg)', zIndex: 220, display: 'flex', flexDirection: 'column', height: '100dvh' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px 6px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 500 }}>{title}</div>
          <div style={{ fontSize: 11, color: 'var(--text-hint)' }}>{panels.length ? `Деталей: ${panels.length} · файлов: ${files.length}` : 'Откройте XML-файлы станка или архив .zip'}</div>
        </div>
        <button type="button" style={{ ...small, color: 'var(--blue)', borderColor: 'var(--blue)' }} onClick={() => inp.current?.click()}>{busy ? 'Открываем…' : 'Открыть файлы'}</button>
        <input ref={inp} type="file" multiple accept=".xml,.XML,.zip,text/xml,application/xml,application/zip" style={{ display: 'none' }} onChange={e => { open(e.target.files); e.target.value = '' }} />
        <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 26, lineHeight: 1, color: 'var(--text-muted)', padding: '0 4px' }}>×</button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 12px 16px' }}>
        {errors.length > 0 && <div style={{ fontSize: 12, color: 'var(--danger)', marginBottom: 8 }}>{errors.map(f => <div key={f.name}>{f.name}: {f.error}</div>)}</div>}
        {!p ? (
          <div className="card" style={{ textAlign: 'center', padding: 24 }}>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 10 }}>Здесь можно посмотреть программы для присадочного станка: и созданные в приложении, и любые XML-файлы станка (формат Syntec / SWJ).</p>
            <button type="button" className="btn-primary" onClick={() => inp.current?.click()}>Открыть XML или .zip</button>
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
              <button type="button" style={small} disabled={idx <= 0} onClick={() => go(idx - 1)}>‹</button>
              <select value={idx} onChange={e => go(Number(e.target.value))} style={{ flex: 1, minWidth: 0, padding: '6px 8px', fontSize: 13 }}>
                {panels.map((x, i) => <option key={x.key} value={i}>{x.id || x.file} — {x.name}</option>)}
              </select>
              <button type="button" style={small} disabled={idx >= panels.length - 1} onClick={() => go(idx + 1)}>›</button>
            </div>
            <input type="search" value={q} onChange={e => find(e.target.value)} placeholder="Код детали (как при сканировании) или название" style={{ fontSize: 13, padding: '7px 10px', marginBottom: 8 }} />
            <div className="card" style={{ padding: '8px 10px', marginBottom: 8 }}>
              <div style={{ fontSize: 14, fontWeight: 500 }}>{p.name || 'Деталь'} <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text-hint)', fontFamily: 'monospace' }}>{p.id}</span></div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {r3(p.L)} × {r3(p.W)} × {r3(p.T)} мм{p.material ? ` · ${p.material}` : ''}{p.outline.length ? ' · фигурный контур' : ''}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 2 }}>
                {[sum.top && `сверху ${sum.top}`, sum.bottom && `снизу ${sum.bottom}`, sum.edge && `в торцы ${sum.edge}`, sum.grooves && `пазов ${sum.grooves}`, sum.mills && `фрезеровок ${sum.mills}`, sum.pockets && `выборок ${sum.pockets}`, sum.off && `отключено ${sum.off}`].filter(Boolean).join(' · ') || 'обработки нет'}
                {' · кромка: '}{[1, 2, 3, 4].filter(f => p.edges[f] > 0).map(f => `${f} (${r3(p.edges[f])})`).join(', ') || 'нет'}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6, overflowX: 'auto', marginBottom: 6 }}>
              {FILTERS.map(([k, l]) => <button key={k} type="button" onClick={() => { setFilter(k); setSel(null) }} style={chip(filter === k)}>{l}</button>)}
              <span style={{ flex: 1 }} />
              <button type="button" style={small} onClick={() => setZoom(z => Math.max(1, z / 1.5))}>−</button>
              <button type="button" style={small} onClick={() => setZoom(z => Math.min(8, z * 1.5))}>+</button>
            </div>
            <div style={{ overflow: 'auto', border: '0.5px solid var(--border)', borderRadius: 'var(--radius)', background: 'var(--bg)', marginBottom: 6 }}>
              <PanelSvg p={p} filter={filter} sel={sel} onSel={setSel} zoom={zoom} />
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 8, lineHeight: 1.6 }}>
              Вид сверху, ноль — левый нижний угол.{' '}
              <span style={{ color: C.top }}>●</span> сверху (5) · <span style={{ color: C.bottom }}>◌</span> снизу (6) · <span style={{ color: C.edge }}>▬</span> в торец · <span style={{ color: C.groove }}>▬</span> паз · <span style={{ color: C.mill }}>━</span> фрезеровка · <span style={{ color: C.band }}>━</span> кромка. Нажмите на элемент — покажу его данные.
            </div>
            {selOp && (
              <div className="card" style={{ padding: '8px 10px', marginBottom: 8, borderColor: C.sel }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{TYPE_NAMES[selOp.type] || `Type ${selOp.type}`}{!selOp.gen ? ' · отключено (IsGenCode 0)' : ''}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>{opText(selOp)}</div>
                <div style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--text-hint)', wordBreak: 'break-all' }}>{Object.entries(selOp.attrs).map(([k, v]) => `${k}="${v}"`).join(' ')}</div>
              </div>
            )}
            <details style={{ marginBottom: 6 }}>
              <summary style={{ fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}>Исходный XML · {p.file}</summary>
              <pre style={{ fontSize: 10.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: 'var(--bg2)', borderRadius: 'var(--radius)', padding: 8, maxHeight: '40vh', overflow: 'auto', marginTop: 6 }}>{files.find(f => f.name === p.file)?.data || ''}</pre>
            </details>
            <details>
              <summary style={{ fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}>Все операции детали ({p.ops.filter(o => pass(o, filter)).length})</summary>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 6 }}>
                {p.ops.filter(o => pass(o, filter)).map(o => (
                  <div key={o.i} onClick={() => setSel(o.i)} style={{ fontSize: 12, padding: '4px 6px', borderRadius: 6, cursor: 'pointer', background: sel === o.i ? 'var(--amber-light)' : 'transparent', color: o.gen ? 'var(--text)' : 'var(--text-hint)' }}>
                    <b style={{ fontWeight: 500 }}>{TYPE_NAMES[o.type] || `Type ${o.type}`}</b> · {opText(o)}
                  </div>
                ))}
              </div>
            </details>
          </>
        )}
      </div>
    </div>
  )
}
