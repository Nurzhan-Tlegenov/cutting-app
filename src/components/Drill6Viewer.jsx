import { useEffect, useMemo, useRef, useState } from 'react'
import { unzipSync } from 'fflate'
import { parseDrillXml, panelSummary, TYPE_NAMES, FACE_NAMES } from '../lib/drill6Parse'

// Просмотрщик XML-программ присадочного станка (Syntec / SWJ): деталь сверху — отверстия в пласти и торцы, пазы,
// фрезеровки и выемки, контур, кромка. Открывает созданные приложением файлы и любые XML с устройства (и архивы .zip).
// Поиск по коду детали — как на станке при сканировании бирки: код = ID детали = имя файла.
// files — [{ name, data }] (необязательно); onClose — закрыть.
// Превью: щипок / колёсико / кнопки — увеличение, палец — сдвиг; ползунок делит экран между превью и списком операций
// (как в симуляторе G-кода). Операция, выбранная в списке, выделяется на превью; нажатие на превью — строка в списке.
// Номера торцов 1–4 — по краям окна превью, у закромленной стороны снаружи — толщина кромки.

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

// Отверстие в торец: прямоугольник от торца вглубь детали (экранные координаты, Y вниз)
function edgeRect(o, W) {
  const d = o.d || 5, len = o.depth || 10
  let x = o.x, y = W - o.y, w = d, h = len
  if (o.face === 1) x -= d / 2
  else if (o.face === 2) { x -= d / 2; y -= len }
  else if (o.face === 3) { y -= d / 2; x -= len; w = len; h = d }
  else { y -= d / 2; w = len; h = d }
  return { x, y, w, h }
}
// Габарит операции в экранных координатах — для выделения и показа
function opBox(o, W) {
  if ((o.type === 2 || o.type === 1) && isEdge(o)) { const r = edgeRect(o, W); return [r.x, r.y, r.x + r.w, r.y + r.h] }
  if (o.type === 2) { const r = (o.d || 5) / 2; return [o.x - r, W - o.y - r, o.x + r, W - o.y + r] }
  if (o.type === 4) { const h = (o.width || 4) / 2; return [Math.min(o.x, o.endX) - h, W - Math.max(o.y, o.endY) - h, Math.max(o.x, o.endX) + h, W - Math.min(o.y, o.endY) + h] }
  const pts = [[o.x, o.y], ...(o.segs || []).map(g => g.to)]
  return [Math.min(...pts.map(q => q[0])), W - Math.max(...pts.map(q => q[1])), Math.max(...pts.map(q => q[0])), W - Math.min(...pts.map(q => q[1]))]
}

// ─── Размеры как на чертеже ─────────────────────────────────────────────────
// Координаты отверстий от нуля детали (как в программе станка), по шкалам у сторон детали:
//   снизу — X отверстий в пласть (5 и 6) и в торец 2; сверху — X отверстий в торец 1;
//   слева — Y отверстий в пласть и в торец 4; справа — Y отверстий в торец 3.
// Только видимые сейчас отверстия (фильтр пластей). Подписи, которым тесно, прячутся — видны при увеличении.
const isHole = o => o.type === 1 || o.type === 2
const r1 = v => String(Math.round((Number(v) || 0) * 10) / 10)
/** -> { bottom, top, left, right }: [{ v, color }] — значения по шкалам */
function dimSets(p, filter) {
  const out = { bottom: new Map(), top: new Map(), left: new Map(), right: new Map() }
  const add = (side, v, color) => { const k = Math.round(v * 10) / 10; if (!out[side].has(k)) out[side].set(k, color) }
  for (const o of p.ops) {
    if (!isHole(o) || !pass(o, filter)) continue
    const col = isEdge(o) ? C.edge : isBottom(o) ? C.bottom : C.top
    if (o.face === 5 || o.face === 6) { add('bottom', o.x, col); add('left', o.y, col) }
    else if (o.face === 1) add('top', o.x, col)
    else if (o.face === 2) add('bottom', o.x, col)
    else if (o.face === 3) add('right', o.y, col)
    else if (o.face === 4) add('left', o.y, col)
  }
  const res = {}
  for (const [side, m] of Object.entries(out)) res[side] = [...m.entries()].map(([v, color]) => ({ v, color })).sort((a, b) => a.v - b.v)
  return res
}
const AX = 30          // шкала размеров — на столько пикселей снаружи от края детали
/** Шкала размеров у одной стороны. side: bottom | top | left | right */
function DimAxis({ side, items, p, px }) {
  if (!items.length) return null
  const { L, W } = p
  const horiz = side === 'bottom' || side === 'top'
  const max = horiz ? L : W
  const sgn = side === 'bottom' || side === 'right' ? 1 : -1
  const a = px(AX) * sgn                              // положение шкалы от края
  const base = side === 'bottom' ? W : side === 'top' ? 0 : side === 'left' ? 0 : L
  const at = v => (horiz ? [v, base + a] : [base + a, W - v])          // точка на шкале для значения v
  const edge = v => (horiz ? [v, base] : [base, W - v])
  // значения: 0, отверстия, полный размер; подписи — без наложений (минимум 12 px между ними)
  const vals = [{ v: 0, color: 'var(--text-muted)', end: true }, ...items.filter(i => i.v > 0.05 && i.v < max - 0.05), { v: max, color: 'var(--text-muted)', end: true }]
  // сначала подписи отверстий (без наложений), потом 0 и полный размер — если для них есть место
  const gap = px(12)
  const shown = []
  for (const it of vals) if (!it.end && (!shown.length || it.v - shown[shown.length - 1].v >= gap)) shown.push(it)
  for (const it of [vals[0], vals[vals.length - 1]]) if (shown.every(q => Math.abs(q.v - it.v) >= gap)) shown.push(it)
  const fs = px(10.5), tOff = px(5) * sgn
  const els = []
  const [ax1, ay1] = at(0), [ax2, ay2] = at(max)
  els.push(<line key="ax" x1={ax1} y1={ay1} x2={ax2} y2={ay2} stroke="var(--text-hint)" strokeWidth={1} vectorEffect="non-scaling-stroke" />)
  vals.forEach((it, i) => {
    const [x0, y0] = edge(it.v), [x1, y1] = at(it.v)
    els.push(<line key={'e' + i} x1={x0} y1={y0} x2={x1} y2={y1} stroke={it.color} strokeOpacity={it.end ? 0.5 : 0.45} strokeWidth={0.8} vectorEffect="non-scaling-stroke" strokeDasharray={it.end ? undefined : '2 2'} />)
    const t = px(4)
    els.push(<line key={'t' + i} x1={horiz ? x1 : x1 - t} y1={horiz ? y1 - t : y1} x2={horiz ? x1 : x1 + t} y2={horiz ? y1 + t : y1} stroke={it.color} strokeWidth={1.4} vectorEffect="non-scaling-stroke" />)
  })
  shown.forEach((it, i) => {
    const [x1, y1] = at(it.v), tx = horiz ? x1 : x1 + tOff, ty = horiz ? y1 + tOff : y1
    const rot = horiz ? `rotate(-90 ${tx} ${ty})` : undefined
    // снизу и справа текст уходит наружу, сверху и слева — тоже наружу (якорь с другой стороны)
    const anchor = horiz ? (sgn > 0 ? 'end' : 'start') : (sgn > 0 ? 'start' : 'end')
    els.push(<text key={'v' + i} x={tx} y={ty} transform={rot} fontSize={fs} fill={it.end ? 'var(--text)' : it.color} fontWeight={it.end ? 600 : 400} textAnchor={anchor} dominantBaseline="middle">{r1(it.v)}</text>)
  })
  return <g pointerEvents="none">{els}</g>
}
/** Размерные линии выбранного отверстия: от нуля по X и по Y, со стрелками и значением */
function SelDims({ o, p, px }) {
  if (!o || !isHole(o)) return null
  const { W } = p
  const hx = o.x, hy = W - o.y, col = C.sel, fs = px(11.5), ar = px(6)
  const arrow = (x, y, dx, dy) => `M${x} ${y} l${-dx * ar - dy * ar * 0.4} ${-dy * ar + dx * ar * 0.4} M${x} ${y} l${-dx * ar + dy * ar * 0.4} ${-dy * ar - dx * ar * 0.4}`
  const els = []
  if (o.x > 0.05) {          // по X: от левого края до отверстия, на высоте отверстия
    els.push(<line key="lx" x1={0} y1={hy} x2={hx} y2={hy} stroke={col} strokeWidth={1.4} vectorEffect="non-scaling-stroke" />)
    els.push(<path key="ax" d={arrow(hx, hy, 1, 0) + ' ' + arrow(0, hy, -1, 0)} stroke={col} strokeWidth={1.4} vectorEffect="non-scaling-stroke" fill="none" />)
    els.push(<text key="tx" x={hx / 2} y={hy - px(7)} fontSize={fs} fontWeight="600" fill={col} stroke="var(--bg)" strokeWidth={px(3)} paintOrder="stroke" textAnchor="middle">{r1(o.x)}</text>)
  }
  if (o.y > 0.05) {          // по Y: от нижнего края до отверстия
    els.push(<line key="ly" x1={hx} y1={W} x2={hx} y2={hy} stroke={col} strokeWidth={1.4} vectorEffect="non-scaling-stroke" />)
    els.push(<path key="ay" d={arrow(hx, hy, 0, -1) + ' ' + arrow(hx, W, 0, 1)} stroke={col} strokeWidth={1.4} vectorEffect="non-scaling-stroke" fill="none" />)
    const ty = (hy + W) / 2
    els.push(<text key="ty" x={hx + px(7)} y={ty} fontSize={fs} fontWeight="600" fill={col} stroke="var(--bg)" strokeWidth={px(3)} paintOrder="stroke" textAnchor="middle" transform={`rotate(-90 ${hx + px(7)} ${ty})`}>{r1(o.y)}</text>)
  }
  if (o.z != null && isEdge(o)) els.push(<text key="tz" x={hx + px(10)} y={hy - px(10)} fontSize={fs} fill={col} stroke="var(--bg)" strokeWidth={px(3)} paintOrder="stroke">Z {r1(o.z)}</text>)
  return <g pointerEvents="none">{els}</g>
}

/** Чертёж детали. view — { x, y, w, h } (viewBox), upp — мм на пиксель экрана (подписи и линии постоянного размера) */
function PanelSvg({ p, filter, sel, onSel, view, upp, dims }) {
  const { L, W } = p
  const px = v => v * upp                              // пиксели экрана -> мм детали
  const dim = o => (!o.gen ? 0.35 : sel != null && sel !== o.i ? 0.45 : 1)
  const isSel = o => sel === o.i
  const els = [], bandText = []
  // кромка — цветная полоса снаружи торца и толщина рядом с ней (подпись — поверх шкал размеров)
  const band = { 1: [0, 0, L, 0], 2: [0, W, L, W], 3: [L, 0, L, W], 4: [0, 0, 0, W] }
  const out = { 1: [0, -1], 2: [0, 1], 3: [1, 0], 4: [-1, 0] }
  for (const f of [1, 2, 3, 4]) if (p.edges[f] > 0) {
    const [x1, y1, x2, y2] = band[f], [ox, oy] = out[f], o = px(4)
    els.push(<line key={'b' + f} x1={x1 + ox * o} y1={y1 + oy * o} x2={x2 + ox * o} y2={y2 + oy * o} stroke={C.band} strokeWidth={5} vectorEffect="non-scaling-stroke" strokeLinecap="round" />)
    const t = px(15), cx = (x1 + x2) / 2 + ox * t, cy = (y1 + y2) / 2 + oy * t
    bandText.push(<text key={'bt' + f} x={cx} y={cy} fontSize={px(12)} fill={C.band} fontWeight="600" textAnchor="middle" dominantBaseline="middle" stroke="var(--bg)" strokeWidth={px(4)} paintOrder="stroke"
      transform={f >= 3 ? `rotate(${f === 3 ? 90 : -90} ${cx} ${cy})` : undefined}>кромка {r3(p.edges[f])}</text>)
  }
  for (const o of p.ops) {
    if (!pass(o, filter)) continue
    const k = 'o' + o.i, click = e => { e.stopPropagation(); onSel(o.i) }, op = dim(o)
    const col = isSel(o) ? C.sel : !o.gen ? C.off : null
    const sw = isSel(o) ? 3 : 1.2
    if ((o.type === 2 || o.type === 1) && isEdge(o)) {
      const r = edgeRect(o, W)
      els.push(<rect key={k} x={r.x} y={r.y} width={r.w} height={r.h} fill={col || C.edge} fillOpacity={0.4} stroke={col || C.edge} strokeWidth={sw} vectorEffect="non-scaling-stroke" opacity={op} onClick={click} />)
    } else if (o.type === 2) {
      const r = Math.max(o.d / 2, px(2.5)), bottom = isBottom(o)
      els.push(<circle key={k + 'h'} cx={o.x} cy={W - o.y} r={Math.max(r, px(12))} fill="transparent" onClick={click} />)   // по мелкому отверстию легко попасть пальцем
      els.push(<circle key={k} cx={o.x} cy={W - o.y} r={r} fill={bottom && !isSel(o) ? 'none' : (col || C.top)} fillOpacity={0.85} stroke={col || (bottom ? C.bottom : C.top)} strokeWidth={bottom ? sw + 0.6 : sw} vectorEffect="non-scaling-stroke" strokeDasharray={bottom ? '3 2' : undefined} opacity={op} onClick={click} />)
    } else if (o.type === 4) {
      const bottom = isBottom(o)
      if (isEdge(o)) els.push(<line key={k} x1={o.x} y1={W - o.y} x2={o.endX} y2={W - o.endY} stroke={col || C.edge} strokeWidth={6} vectorEffect="non-scaling-stroke" opacity={op} onClick={click} />)
      else els.push(<line key={k} x1={o.x} y1={W - o.y} x2={o.endX} y2={W - o.endY} stroke={col || C.groove} strokeOpacity={bottom ? 0.45 : 0.75} strokeWidth={Math.max(o.width, px(3))} strokeDasharray={bottom ? `${px(8)} ${px(4)}` : undefined} opacity={op} onClick={click} />)
    } else if (o.type === 3 && o.segs?.length) {
      const d = pathD([o.x, o.y], o.segs, W, o.closed), bottom = isBottom(o)
      els.push(<path key={k + 'h'} d={d} fill="none" stroke="transparent" strokeWidth={16} vectorEffect="non-scaling-stroke" onClick={click} />)
      els.push(<path key={k} d={d} fill={o.pocket ? (col || C.mill) : 'none'} fillOpacity={0.25} stroke={col || C.mill} strokeWidth={sw + 0.8} vectorEffect="non-scaling-stroke" strokeDasharray={bottom ? '6 3' : undefined} opacity={op} onClick={click} />)
      els.push(<circle key={k + 's'} cx={o.x} cy={W - o.y} r={px(3)} fill={col || C.mill} opacity={op} onClick={click} />)   // начало пути
    }
  }
  // выделенная операция — рамка и пульсирующее кольцо, видно даже мелкое отверстие
  const so = sel != null ? p.ops.find(o => o.i === sel) : null
  let halo = null
  if (so && pass(so, filter)) {
    const [x0, y0, x1, y1] = opBox(so, W), m = px(6)
    halo = (
      <g pointerEvents="none">
        <rect x={x0 - m} y={y0 - m} width={x1 - x0 + 2 * m} height={y1 - y0 + 2 * m} fill="none" stroke={C.sel} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeDasharray="5 3" rx={px(4)} />
        <circle cx={(x0 + x1) / 2} cy={(y0 + y1) / 2} r={Math.max((x1 - x0) / 2, (y1 - y0) / 2, 0) + px(14)} fill="none" stroke={C.sel} strokeWidth={3} vectorEffect="non-scaling-stroke" className="d6-pulse" />
      </g>
    )
  }
  const outline = outlineD(p.outline, W)
  const dimSet = dims ? dimSets(p, filter) : null
  return (
    <svg viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`} preserveAspectRatio="none" style={{ width: '100%', height: '100%', display: 'block' }}>
      <style>{'@keyframes d6p{0%{stroke-opacity:1}50%{stroke-opacity:.25}100%{stroke-opacity:1}}.d6-pulse{animation:d6p 1s ease-in-out infinite}'}</style>
      {outline
        ? <><rect x={0} y={0} width={L} height={W} fill="none" stroke="var(--border-md)" strokeWidth={1} vectorEffect="non-scaling-stroke" strokeDasharray="4 4" /><path d={outline} fill="var(--bg2)" stroke="var(--text)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" /></>
        : <rect x={0} y={0} width={L} height={W} fill="var(--bg2)" stroke="var(--text)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />}
      {els}
      {dims && ['bottom', 'top', 'left', 'right'].map(sd => <DimAxis key={sd} side={sd} items={dimSet[sd]} p={p} px={px} />)}
      {bandText}
      {dims && so && pass(so, filter) && <SelDims o={so} p={p} px={px} />}
      {halo}
      {/* ноль детали; общие размеры — когда шкалы размеров скрыты (иначе полный размер — на шкале) */}
      <circle cx={0} cy={W} r={px(4)} fill="var(--text)" />
      {!dims && <>
        <text x={0} y={W + px(16)} fontSize={px(11)} fill="var(--text-hint)" textAnchor="middle">0</text>
        <text x={L / 2} y={W + px(36)} fontSize={px(12)} fill="var(--text-muted)" textAnchor="middle" dominantBaseline="middle">X · {r3(p.L)}</text>
        <text x={-px(38)} y={W / 2} fontSize={px(12)} fill="var(--text-muted)" textAnchor="middle" dominantBaseline="middle" transform={`rotate(-90 ${-px(38)} ${W / 2})`}>Y · {r3(p.W)}</text>
      </>}
      {dims && !dimSet.bottom.length && <text x={L / 2} y={W + px(36)} fontSize={px(12)} fill="var(--text-muted)" textAnchor="middle" dominantBaseline="middle">X · {r3(p.L)}</text>}
      {dims && !dimSet.left.length && <text x={-px(38)} y={W / 2} fontSize={px(12)} fill="var(--text-muted)" textAnchor="middle" dominantBaseline="middle" transform={`rotate(-90 ${-px(38)} ${W / 2})`}>Y · {r3(p.W)}</text>}
    </svg>
  )
}

// Превью с увеличением: щипок двумя пальцами, колёсико мыши, кнопки; сдвиг — одним пальцем. Нажатие (без сдвига) — выбор.
function Preview({ p, filter, sel, onSel, focus, dims }) {
  const wrap = useRef(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [view, setView] = useState(null)
  const ptrs = useRef(new Map()), gesture = useRef(null), moved = useRef(false)
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // поля в пикселях вокруг детали; со шкалами размеров шире: шкала (AX) + подписи значений
  const ds = dims ? dimSets(p, filter) : null
  const marg = [ds?.left.length ? 112 : 78, ds?.right.length ? 96 : 52, ds?.top.length ? 96 : 50, ds?.bottom.length ? 106 : 70]
  // вписать деталь в окно (с полями под подписи кромки и размеры)
  const fit = () => {
    if (!size.w || !size.h) return null
    // поля в пикселях экрана: слева — номер торца, кромка и размер Y; снизу — кромка и размер X
    const [ML, MR, MT, MB] = marg
    const k = Math.max(p.L / Math.max(40, size.w - ML - MR), p.W / Math.max(40, size.h - MT - MB)), w = size.w * k, h = size.h * k
    const cx = p.L / 2 + (MR - ML) / 2 * k, cy = p.W / 2 + (MB - MT) / 2 * k
    return { x: cx - w / 2, y: cy - h / 2, w, h }
  }
  // вид привязан к детали и размеру окна: сменилась деталь или окно — деталь вписывается заново
  const fitKey = `${p.key}|${Math.round(size.w)}|${Math.round(size.h)}|${marg.join(',')}`
  const v = (view && view.key === fitKey ? view : null) || fit()
  const put = nv => setView(nv ? { ...nv, key: fitKey } : null)
  const upp = v && size.w ? v.w / size.w : 1
  // выбранная в списке операция не видна — сдвигаем превью к ней
  const [seenFocus, setSeenFocus] = useState(focus)
  if (focus !== seenFocus) {
    setSeenFocus(focus)
    const o = focus && v ? p.ops.find(q => q.i === focus.i) : null
    if (o) {
      const [x0, y0, x1, y1] = opBox(o, p.W), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, pad = 30 * upp
      if (cx < v.x + pad || cx > v.x + v.w - pad || cy < v.y + pad || cy > v.y + v.h - pad) put({ ...v, x: cx - v.w / 2, y: cy - v.h / 2 })
    }
  }
  const zoomAt = (k, sx, sy, base = v) => {
    const f = fit(), minW = (f?.w || base.w) / 60, maxW = (f?.w || base.w) * 1.5
    const w = Math.max(minW, Math.min(maxW, base.w * k)), kk = w / base.w, h = base.h * kk
    const ux = base.x + sx / size.w * base.w, uy = base.y + sy / size.h * base.h
    put({ x: ux - (ux - base.x) * kk, y: uy - (uy - base.y) * kk, w, h })
  }
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const onWheel = e => { e.preventDefault(); const r = el.getBoundingClientRect(); zoomAt(Math.exp(e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top) }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  })
  const local = e => { const r = wrap.current.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top] }
  const down = e => {
    ptrs.current.set(e.pointerId, local(e))
    moved.current = false
    const pts = [...ptrs.current.values()]
    gesture.current = { view: v, pts: pts.map(q => [...q]) }
  }
  const move = e => {
    if (!ptrs.current.has(e.pointerId) || !gesture.current) return
    ptrs.current.set(e.pointerId, local(e))
    const g = gesture.current, pts = [...ptrs.current.values()]
    if (pts.length >= 2 && g.pts.length >= 2) {
      const d0 = Math.hypot(g.pts[0][0] - g.pts[1][0], g.pts[0][1] - g.pts[1][1]), d1 = Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1])
      const mx = (pts[0][0] + pts[1][0]) / 2, my = (pts[0][1] + pts[1][1]) / 2
      const m0x = (g.pts[0][0] + g.pts[1][0]) / 2, m0y = (g.pts[0][1] + g.pts[1][1]) / 2
      if (d0 > 10 && d1 > 10) {
        // сдвиг середины пальцев + масштаб вокруг неё
        const b = g.view, kpx = b.w / size.w
        const shifted = { ...b, x: b.x - (mx - m0x) * kpx, y: b.y - (my - m0y) * kpx }
        zoomAt(d0 / d1, mx, my, shifted)
        moved.current = true
      }
    } else if (pts.length === 1) {
      const [x0, y0] = g.pts[0], [x1, y1] = pts[0]
      if (Math.hypot(x1 - x0, y1 - y0) > 6) moved.current = true
      if (moved.current) { const kpx = g.view.w / size.w; put({ ...g.view, x: g.view.x - (x1 - x0) * kpx, y: g.view.y - (y1 - y0) * kpx }) }
    }
  }
  const up = e => {
    ptrs.current.delete(e.pointerId)
    const pts = [...ptrs.current.values()]
    gesture.current = pts.length ? { view: v, pts: pts.map(q => [...q]) } : null
  }
  const btn = { width: 34, height: 34, borderRadius: 17, border: '0.5px solid var(--border-md)', background: 'var(--bg)', color: 'var(--text)', fontSize: 17, lineHeight: '30px', padding: 0, boxShadow: '0 1px 3px rgba(0,0,0,.12)' }
  const tag = (f, st) => (
    <span style={{ position: 'absolute', ...st, minWidth: 20, height: 20, padding: '0 5px', borderRadius: 10, fontSize: 11, lineHeight: '20px', textAlign: 'center', pointerEvents: 'none',
      background: p.edges[f] > 0 ? C.band : 'var(--bg)', color: p.edges[f] > 0 ? 'white' : 'var(--text-hint)', border: '0.5px solid ' + (p.edges[f] > 0 ? C.band : 'var(--border-md)') }}>{f}</span>
  )
  return (
    <div ref={wrap} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerLeave={up}
      onClickCapture={e => { if (moved.current) { e.stopPropagation(); moved.current = false } }} onClick={() => onSel(null)}
      style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', touchAction: 'none', userSelect: 'none', background: 'var(--bg)', borderRadius: 'var(--radius)', border: '0.5px solid var(--border)' }}>
      {v && <PanelSvg p={p} filter={filter} sel={sel} onSel={onSel} view={v} upp={upp} dims={dims} />}
      {/* номера торцов — по краям окна превью (как на станке: 1 — верх, 2 — низ, 3 — справа, 4 — слева) */}
      {tag(1, { top: 4, left: '50%', transform: 'translateX(-50%)' })}
      {tag(2, { bottom: 4, left: '50%', transform: 'translateX(-50%)' })}
      {tag(3, { right: 4, top: '50%', transform: 'translateY(-50%)' })}
      {tag(4, { left: 4, top: '50%', transform: 'translateY(-50%)' })}
      <div style={{ position: 'absolute', right: 8, bottom: 30, display: 'flex', flexDirection: 'column', gap: 6 }} onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
        <button type="button" style={btn} onClick={() => zoomAt(1 / 1.6, size.w / 2, size.h / 2)}>+</button>
        <button type="button" style={btn} onClick={() => zoomAt(1.6, size.w / 2, size.h / 2)}>−</button>
        <button type="button" style={{ ...btn, fontSize: 14 }} title="Вписать деталь" onClick={() => put(fit())}>⤢</button>
      </div>
    </div>
  )
}

export default function Drill6Viewer({ files: initial = [], onClose, title = 'Просмотр XML присадки' }) {
  const [files, setFiles] = useState(initial)
  const parsed = useMemo(() => files.map(f => ({ ...f, ...(f.error ? { panels: [] } : parseDrillXml(f.data, f.name)) })), [files])
  const panels = useMemo(() => parsed.flatMap(f => f.panels), [parsed])
  const errors = parsed.filter(f => f.error)
  const [idx, setIdx] = useState(0)
  const [filter, setFilter] = useState('all')
  const [dims, setDims] = useState(true)              // размеры отверстий на превью: показать / скрыть
  const [sel, setSel] = useState(null)
  const [focus, setFocus] = useState(null)            // операция, выбранная в списке, — превью сдвигается к ней
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  // высота превью — двигается ползунком (как в симуляторе G-кода)
  const [viewH, setViewH] = useState(() => Math.round(Math.max(220, Math.min(window.innerHeight * 0.5, 700))))
  const drag = useRef(null)
  const inp = useRef(null), rows = useRef(new Map())
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
  const pickFromList = i => { setSel(i); setFocus(f => ({ i, n: (f?.n || 0) + 1 })) }
  const pickFromPreview = i => { setSel(i); if (i != null) Promise.resolve().then(() => rows.current.get(i)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })) }
  const sum = p ? panelSummary(p) : null
  const selOp = p && sel != null ? p.ops.find(o => o.i === sel) : null
  const small = { padding: '6px 11px', borderRadius: 20, fontSize: 12, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text-muted)', whiteSpace: 'nowrap' }
  const chip = on => ({ flex: '0 0 auto', padding: '5px 10px', borderRadius: 20, border: 'none', fontSize: 12, background: on ? 'var(--blue)' : 'var(--bg2)', color: on ? 'white' : 'var(--text-muted)' })
  const opText = o => {
    const f = FACE_NAMES[o.face] || `Face ${o.face}`
    if (o.type === 2 || o.type === 1) return `Ø${r3(o.d)} × ${r3(o.depth)} · ${f} · X ${r3(o.x)} Y ${r3(o.y)}${o.z != null ? ' Z ' + r3(o.z) : ''}`
    if (o.type === 4) return `${r3(o.width)} × ${r3(o.depth)} · ${f} · (${r3(o.x)}; ${r3(o.y)}) → (${r3(o.endX)}; ${r3(o.endY)})`
    if (o.type === 3) return `${o.pocket ? 'выборка' : o.closed ? 'замкнутый' : 'открытый'} · глубина ${r3(o.depth)} · ${f} · фреза ${o.offset || '—'} · отрезков ${o.segs?.length || 0}${o.segs?.some(g => g.angle) ? ', есть дуги' : ''}`
    return f
  }
  const dot = o => (o.type === 3 ? C.mill : o.type === 4 && !isEdge(o) ? C.groove : isEdge(o) ? C.edge : isBottom(o) ? C.bottom : C.top)
  const list = p ? p.ops.filter(o => pass(o, filter)) : []
  const dragStart = e => { e.currentTarget.setPointerCapture?.(e.pointerId); drag.current = { y: e.clientY, h: viewH } }
  const dragMove = e => { const d = drag.current; if (d) setViewH(Math.round(Math.max(140, Math.min(window.innerHeight - 160, d.h + e.clientY - d.y)))) }
  const dragEnd = () => { drag.current = null }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--bg)', zIndex: 220, display: 'flex', flexDirection: 'column', height: '100dvh' }}>
      <div style={{ flex: '0 0 auto', padding: '8px 12px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 500, fontSize: 15 }}>{title}</div>
            <div style={{ fontSize: 11, color: 'var(--text-hint)' }}>{panels.length ? `Деталей: ${panels.length} · файлов: ${files.length}` : 'Откройте XML-файлы станка или архив .zip'}</div>
          </div>
          <button type="button" style={{ ...small, color: 'var(--blue)', borderColor: 'var(--blue)' }} onClick={() => inp.current?.click()}>{busy ? 'Открываем…' : 'Открыть файлы'}</button>
          <input ref={inp} type="file" multiple accept=".xml,.XML,.zip,text/xml,application/xml,application/zip" style={{ display: 'none' }} onChange={e => { open(e.target.files); e.target.value = '' }} />
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 26, lineHeight: 1, color: 'var(--text-muted)', padding: '0 4px' }}>×</button>
        </div>
        {errors.length > 0 && <div style={{ fontSize: 12, color: 'var(--danger)', marginBottom: 6 }}>{errors.map(f => <div key={f.name}>{f.name}: {f.error}</div>)}</div>}
        {p && (
          <>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
              <button type="button" style={small} disabled={idx <= 0} onClick={() => go(idx - 1)}>‹</button>
              <select value={idx} onChange={e => go(Number(e.target.value))} style={{ flex: 1, minWidth: 0, padding: '6px 8px', fontSize: 13 }}>
                {panels.map((x, i) => <option key={x.key} value={i}>{x.id || x.file} — {x.name}</option>)}
              </select>
              <button type="button" style={small} disabled={idx >= panels.length - 1} onClick={() => go(idx + 1)}>›</button>
            </div>
            <input type="search" value={q} onChange={e => find(e.target.value)} placeholder="Код детали (как при сканировании) или название" style={{ fontSize: 13, padding: '6px 10px', marginBottom: 6 }} />
            <div style={{ fontSize: 12, marginBottom: 6, lineHeight: 1.45 }}>
              <b style={{ fontWeight: 500 }}>{p.name || 'Деталь'}</b> <span style={{ color: 'var(--text-hint)', fontFamily: 'monospace', fontSize: 11 }}>{p.id}</span>
              <span style={{ color: 'var(--text-muted)' }}> · {r3(p.L)} × {r3(p.W)} × {r3(p.T)} мм{p.outline.length ? ' · фигурный контур' : ''}</span>
              <div style={{ fontSize: 11, color: 'var(--text-hint)' }}>
                {[sum.top && `сверху ${sum.top}`, sum.bottom && `снизу ${sum.bottom}`, sum.edge && `в торцы ${sum.edge}`, sum.grooves && `пазов ${sum.grooves}`, sum.mills && `фрезеровок ${sum.mills}`, sum.pockets && `выборок ${sum.pockets}`, sum.off && `отключено ${sum.off}`].filter(Boolean).join(' · ') || 'обработки нет'}
                {' · кромка: '}{[1, 2, 3, 4].filter(f => p.edges[f] > 0).map(f => `${f} — ${r3(p.edges[f])}`).join(', ') || 'нет'}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6, overflowX: 'auto', marginBottom: 6 }}>
              {FILTERS.map(([k, l]) => <button key={k} type="button" onClick={() => { setFilter(k); setSel(null) }} style={chip(filter === k)}>{l}</button>)}
              <span style={{ flex: 1 }} />
              <button type="button" onClick={() => setDims(d => !d)} title="Размеры до отверстий — показать или скрыть"
                style={{ ...chip(dims), background: dims ? 'var(--teal, #1f9d6b)' : 'var(--bg2)' }}>📏 Размеры</button>
            </div>
          </>
        )}
      </div>
      {!p ? (
        <div style={{ padding: '0 12px' }}>
          <div className="card" style={{ textAlign: 'center', padding: 24 }}>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 10 }}>Здесь можно посмотреть программы для присадочного станка: и созданные в приложении, и любые XML-файлы станка (формат Syntec / SWJ).</p>
            <button type="button" className="btn-primary" onClick={() => inp.current?.click()}>Открыть XML или .zip</button>
          </div>
        </div>
      ) : (
        <>
          <div style={{ flex: '0 0 auto', height: viewH, padding: '0 12px' }}>
            <Preview p={p} filter={filter} sel={sel} onSel={pickFromPreview} focus={focus} dims={dims} />
          </div>
          {/* ползунок: больше превью или больше списка операций */}
          <div onPointerDown={dragStart} onPointerMove={dragMove} onPointerUp={dragEnd} onPointerCancel={dragEnd} title="Потяните вверх или вниз"
            style={{ flex: '0 0 auto', height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, cursor: 'row-resize', touchAction: 'none', userSelect: 'none', color: 'var(--text-hint)', fontSize: 10 }}>
            <span>▲</span><i style={{ width: 54, height: 5, borderRadius: 3, background: 'var(--gray-mid, #bbb)' }} /><span>▼</span>
          </div>
          <div style={{ flex: '1 1 0', minHeight: 60, overflowY: 'auto', padding: '0 12px 16px', WebkitOverflowScrolling: 'touch' }}>
            {selOp && (
              <div className="card" style={{ padding: '7px 10px', marginBottom: 6, borderColor: C.sel }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div style={{ flex: 1, fontSize: 13, fontWeight: 500 }}>{TYPE_NAMES[selOp.type] || `Type ${selOp.type}`}{!selOp.gen ? ' · отключено (IsGenCode 0)' : ''}</div>
                  <button type="button" onClick={() => setSel(null)} style={{ background: 'none', border: 'none', color: 'var(--text-hint)', fontSize: 18, padding: 0 }}>×</button>
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 3 }}>{opText(selOp)}</div>
                <div style={{ fontSize: 10.5, fontFamily: 'monospace', color: 'var(--text-hint)', wordBreak: 'break-all' }}>{Object.entries(selOp.attrs).map(([k, v]) => `${k}="${v}"`).join(' ')}</div>
              </div>
            )}
            <div style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 4 }}>Операции ({list.length}) — нажмите, чтобы выделить на превью</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1, marginBottom: 8 }}>
              {list.map(o => (
                <div key={o.i} ref={el => { if (el) rows.current.set(o.i, el); else rows.current.delete(o.i) }} onClick={() => pickFromList(o.i)}
                  style={{ display: 'flex', gap: 7, alignItems: 'baseline', fontSize: 12, padding: '6px 6px', borderRadius: 6, cursor: 'pointer', background: sel === o.i ? 'var(--amber-light)' : 'transparent', borderLeft: `3px solid ${sel === o.i ? C.sel : 'transparent'}`, color: o.gen ? 'var(--text)' : 'var(--text-hint)' }}>
                  <span style={{ flex: '0 0 auto', width: 8, height: 8, borderRadius: 4, background: o.gen ? dot(o) : C.off, transform: 'translateY(-1px)' }} />
                  <span><b style={{ fontWeight: 500 }}>{TYPE_NAMES[o.type] || `Type ${o.type}`}</b> · {opText(o)}</span>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 8, lineHeight: 1.6 }}>
              Вид сверху, ноль — левый нижний угол.{' '}
              <span style={{ color: C.top }}>●</span> сверху (5) · <span style={{ color: C.bottom }}>◌</span> снизу (6) · <span style={{ color: C.edge }}>▬</span> в торец · <span style={{ color: C.groove }}>▬</span> паз · <span style={{ color: C.mill }}>━</span> фрезеровка · <span style={{ color: C.band }}>━</span> кромка (толщина подписана снаружи).
            </div>
            <details>
              <summary style={{ fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}>Исходный XML · {p.file}</summary>
              <pre style={{ fontSize: 10.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: 'var(--bg2)', borderRadius: 'var(--radius)', padding: 8, marginTop: 6 }}>{files.find(f => f.name === p.file)?.data || ''}</pre>
            </details>
          </div>
        </>
      )}
    </div>
  )
}
