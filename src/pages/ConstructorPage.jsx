// Конструктор мебели (бета: мастер-аккаунт и бета-тестеры «Конструктор»).
// Проект — сцена из элементов: параметрические корпуса, свободные панели, стекло, погонные профили (металл).
// Корпус задаётся параметрами (крышка/дно вкладные или накладные, ножки/цоколь, задняя стенка в паз / накладная,
// полки, стойки, ящики, фасады) — детали пересчитываются сами. «Разобрать» превращает корпус в свободные панели.
// «В заказ» — детали выбранного материала уходят в бланк нового заказа вместе с 3D-моделью
// (дальше — обычный раскрой, бирки, ЧПУ); «Смета» — плита и стекло в м², профили в метрах и хлыстах, фурнитура.
import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import NavDrawer, { MenuButton } from '../components/NavDrawer'
import Hint from '../components/Hint'
import CadView from '../components/CadView'
import { CAD_LOOK, FINISHES } from '../lib/cadLook'
import { getTheme, setTheme } from '../lib/theme'
import Model3DButton from '../components/Model3DButton'
import CncLoader from '../components/CncLoader'
import { useDesktop } from '../hooks/useDesktop'
import { useBackClose } from '../lib/backStack'
import { hasBeta } from '../lib/beta'
import { packScene } from '../lib/basisB3d'
import { CAB_DEFAULTS, CAB_PRESETS, CAB_KINDS, CAB_GROUPS, treeOf, findNode, cabinetParts, opSplit, opSetSize, opPatch, opFront, opCount, opRemovePanel, opReplace, DRAWER_SYSTEMS, drawerSystem, drawerHeights, drawerSetHeight, HANDLE_TYPES, slideLength, FACADE_STYLES } from '../lib/cadCabinet'
import { FRAME_DEFAULTS, FRAME_PRESETS } from '../lib/cadFrame'
import { JOINTS, partJoints } from '../lib/cadDrill'
import { getUserSettings, saveUserSettings } from '../lib/userSettings'
import { newLinearJob, readJobs, writeJobs, LINEAR_FEATURE } from '../lib/linearJobs'
import { newProject, newItem, projectParts, projectSpec, sheetGroups, exportForOrder, exportAll, explodeCabinet, sceneBox, newId, projectDrill, partToDetail, overrideFromDraft, isFigured, PROJECT_DEFAULTS, mountOf } from '../lib/cadModel'
import { listProjects, loadProject, saveProject, deleteProject, isLocal, CAD_SQL_HINT } from '../lib/cadStore'

const ContourEditor = lazy(() => import('../components/ContourEditor'))
export const CAD_FEATURE = 'constructor'
const num = v => { const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : null }
const fmt = v => (Math.round(v * 100) / 100).toLocaleString('ru-RU')

// ── мелкие элементы формы ──
const lbl = { fontSize: 11.5, color: 'var(--text-muted)', display: 'block', marginBottom: 2 }
const inp = { width: '100%', padding: '7px 8px', fontSize: 14, border: '0.5px solid var(--border-md)', borderRadius: 8, background: 'var(--bg)', color: 'var(--text)', boxSizing: 'border-box' }
const chipS = on => ({ padding: '5px 10px', borderRadius: 16, fontSize: 12.5, cursor: 'pointer', whiteSpace: 'nowrap', border: `1px solid ${on ? 'var(--blue)' : 'var(--border-md)'}`, background: on ? 'var(--blue-light, #e8f0fe)' : 'var(--bg)', color: on ? 'var(--blue)' : 'var(--text)' })
const btnS = (main) => ({ padding: '8px 12px', borderRadius: 10, fontSize: 13.5, cursor: 'pointer', border: main ? 'none' : '0.5px solid var(--border-md)', background: main ? 'var(--blue)' : 'var(--bg)', color: main ? 'white' : 'var(--text)', whiteSpace: 'nowrap' })
const sect = { fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.3, margin: '12px 0 6px' }

function NumField({ label, value, onChange, step, unit = 'мм', min }) {
  const [txt, setTxt] = useState(String(value ?? ''))
  const [focus, setFocus] = useState(false)
  const shown = focus ? txt : String(value ?? '')
  return (
    <label style={{ display: 'block', minWidth: 0 }}>
      <span style={lbl}>{label}{unit ? `, ${unit}` : ''}</span>
      <input style={inp} inputMode="decimal" value={shown} step={step}
        onFocus={() => { setTxt(String(value ?? '')); setFocus(true) }}
        onBlur={() => setFocus(false)}
        onChange={e => { setTxt(e.target.value); const n = num(e.target.value); if (n != null && (min == null || n >= min)) onChange(n) }} />
    </label>
  )
}
function TextField({ label, value, onChange, list }) {
  return (
    <label style={{ display: 'block', minWidth: 0 }}>
      <span style={lbl}>{label}</span>
      <input style={inp} value={value ?? ''} list={list} onChange={e => onChange(e.target.value)} />
    </label>
  )
}
function Chips({ label, value, options, onChange, hint }) {
  return (
    <div style={{ marginBottom: 8 }}>
      {label && <span style={lbl}>{label}{hint && <Hint inline>{hint}</Hint>}</span>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
        {options.map(([v, t]) => <button key={String(v)} type="button" style={chipS(value === v)} onClick={() => onChange(v)}>{t}</button>)}
      </div>
    </div>
  )
}
const Grid = ({ children, cols = 3 }) => <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: 6, marginBottom: 8 }}>{children}</div>

// ── проёмы корпуса ──
function TreeEditor({ it, sel, setSel }) {
  const p = { ...CAB_DEFAULTS, ...it.p }
  const tree = treeOf(p)
  const info = useMemo(() => new Map((cabinetParts(p).openings || []).map(o => [o.id, o])), [it.p]) // eslint-disable-line react-hooks/exhaustive-deps
  const frontTxt = f => (!f ? '' : f.type === 'drawers' ? ` · ящиков ${f.n}` : f.n > 1 ? ` · ${f.n} двери` : ` · дверь (петли ${f.hinge === 'right' ? 'справа' : 'слева'})`)
  const rows = []
  const walk = (n, par, depth) => {
    const o = info.get(n.id)
    const name = !par ? 'Весь проём' : `${par.split === 'v' ? 'Секция' : 'Ярус'} ${par.children.indexOf(n) + 1}`
    rows.push(
      <button key={n.id} type="button" onClick={() => setSel(n.id === sel ? null : n.id)}
        style={{ display: 'block', width: `calc(100% - ${depth * 14}px)`, marginLeft: depth * 14, textAlign: 'left', padding: '5px 8px', marginBottom: 3, borderRadius: 8, cursor: 'pointer', fontSize: 12.5,
          border: `1px solid ${n.id === sel ? 'var(--blue)' : 'var(--border)'}`, background: n.id === sel ? 'var(--blue-light, #e8f0fe)' : 'var(--bg)', color: 'var(--text)' }}>
        {name} · {o ? `${o.w}×${o.h}` : ''}{n.size != null ? ' 📌' : ''}
        <span style={{ color: 'var(--text-muted)' }}>{n.split ? (n.split === 'v' ? ` · верт. панелей ${n.children.length - 1}` : ` · гориз. панелей ${n.children.length - 1}`) : ''}{n.fpanel ? ' · фронт. панель' : ''}{frontTxt(n.front)}</span>
      </button>)
    ;(n.children || []).forEach(c => walk(c, n, depth + 1))
  }
  walk(tree, null, 0)
  return <>{rows}</>
}

// ── проёмы прямо на картинке: панель инструментов слева от модели и окно выбранного проёма поверх неё ──
const toolBtn = (on, dis) => ({ width: 40, minHeight: 34, padding: '3px 1px', borderRadius: 8, fontSize: 8.5, lineHeight: 1.1, cursor: dis ? 'default' : 'pointer', textAlign: 'center',
  border: `1px solid ${on ? 'var(--blue)' : 'var(--border-md)'}`, background: on ? 'var(--blue)' : 'var(--bg)', color: on ? 'white' : dis ? '#aab' : 'var(--text)', opacity: dis ? 0.6 : 1 })
const smallInp = { width: 64, padding: '4px 5px', fontSize: 13, border: '0.5px solid var(--border-md)', borderRadius: 7, background: 'var(--bg)', color: 'var(--text)' }

function SmallNum({ value, onChange, width = 64, title }) {
  const [txt, setTxt] = useState(String(value ?? ''))
  const [focus, setFocus] = useState(false)
  return <input title={title} style={{ ...smallInp, width }} inputMode="decimal" value={focus ? txt : String(value ?? '')}
    onFocus={() => { setTxt(String(value ?? '')); setFocus(true) }} onBlur={() => setFocus(false)}
    onChange={e => { setTxt(e.target.value); const n = num(e.target.value); if (n != null) onChange(n) }} />
}

function OpeningTools({ it, set, sel, showSizes, setShowSizes }) {
  const p = { ...CAB_DEFAULTS, ...it.p }
  const tree = treeOf(p)
  const r = sel ? findNode(tree, sel) : null
  const node = r?.node
  const apply = t => { if (t) set({ ...it, p: { ...p, tree: t } }) }
  const leaf = node && !(node.split && node.children?.length)
  const [cnt, setCnt] = useState(1)
  const addPanel = kind => {
    if (!node) return
    const t = opSplit(tree, node.id, kind, cnt)
    if (!t) { window.alert('Этот проём уже разделён панелями другого направления — выберите один из его проёмов'); return }
    apply(t)
  }
  const front = f => node && apply(opFront(tree, node.id, f))
  const T = [
    ['v', '│', 'Верт.', () => addPanel('v'), !node],
    ['h', '─', 'Гориз.', () => addPanel('h'), !node],
    ['f', '▭', 'Фронт.', () => node && apply(opPatch(tree, node.id, n => { n.fpanel = n.fpanel ? null : { from: 'back', dist: 0, l: 0, r: 0, b: 0, t: 0 } })), !node, !!node?.fpanel],
    ['rod', '⊸', 'Штанга', () => node && apply(opPatch(tree, node.id, n => { n.rod = n.rod ? null : { top: 60, d: 25 } })), !node, !!node?.rod],
    ['d1', '▯', 'Дверь', () => front({ type: 'doors', n: 1, hinge: 'left' }), !node, node?.front?.type === 'doors' && node.front.n === 1],
    ['d2', '▯▯', '2 двери', () => front({ type: 'doors', n: 2, hinge: 'auto' }), !node, node?.front?.type === 'doors' && node.front.n > 1],
    ['dr', '☰', 'Ящики', () => front({ type: 'drawers', n: 3 }), !node || !leaf, node?.front?.type === 'drawers'],
    ['nf', '∅', 'Без фас.', () => front(null), !node || !node.front],
    ['x', '✕', 'Убрать', () => { if (node && window.confirm('Убрать панели этого проёма и всё внутри?')) apply(opPatch(tree, node.id, n => { n.split = null; n.children = [] })) }, !node || leaf],
  ]
  return (
    <div style={{ position: 'absolute', left: 6, top: 6, display: 'flex', flexDirection: 'column', gap: 3, zIndex: 3, pointerEvents: 'none' }}>
      <button type="button" style={{ ...toolBtn(showSizes), pointerEvents: 'auto' }} onClick={() => setShowSizes(v => !v)} title="Размеры проёмов на модели">📏<br />Разм.</button>
      {!node && <div style={{ fontSize: 8.5, width: 40, color: 'var(--text-muted)', background: 'var(--bg)', borderRadius: 6, padding: 2, textAlign: 'center' }}>нажмите проём</div>}
      {node && <div style={{ ...toolBtn(false), pointerEvents: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1, padding: '2px 1px' }} title="Сколько панелей ставить за одно нажатие">
        <button type="button" style={{ border: 'none', background: 'none', fontSize: 12, lineHeight: 1, padding: 0, cursor: 'pointer' }} onClick={() => setCnt(c => Math.min(20, c + 1))}>＋</button>
        <b style={{ fontSize: 12 }}>×{cnt}</b>
        <button type="button" style={{ border: 'none', background: 'none', fontSize: 12, lineHeight: 1, padding: 0, cursor: 'pointer' }} onClick={() => setCnt(c => Math.max(1, c - 1))}>－</button>
      </div>}
      {node && T.map(([k, ic, t, fn, dis, on]) => <button key={k} type="button" disabled={dis} title={t} style={{ ...toolBtn(on, dis), pointerEvents: 'auto' }} onClick={fn}>{ic}<br />{t}</button>)}
    </div>
  )
}

function OpeningPanel({ it, set, sel, setSel, pull, setPull, onBlock }) {
  const p = { ...CAB_DEFAULTS, ...it.p }
  const tree = treeOf(p)
  const ops = useMemo(() => cabinetParts(p).openings || [], [it.p]) // eslint-disable-line react-hooks/exhaustive-deps
  const r = sel ? findNode(tree, sel) : null
  const o = ops.find(x => x.id === sel)
  if (!r || !o) return null
  const { node, parent } = r
  const sizes = Object.fromEntries(ops.map(x => [x.id, x]))
  const apply = t => set({ ...it, p: { ...p, tree: t } })
  const patch = fn => apply(opPatch(tree, node.id, fn))
  const v = parent?.split === 'v'
  const row = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 5, marginTop: 5, fontSize: 12.5 }
  const fp = node.fpanel
  return (
    <div style={{ position: 'absolute', left: 58, right: 6, bottom: 6, maxHeight: '48%', overflowY: 'auto', zIndex: 3, background: 'var(--bg)', border: '1px solid var(--blue)', borderRadius: 10, padding: '6px 9px', boxShadow: '0 2px 10px rgba(0,0,0,0.12)' }}>
      <div style={{ ...row, marginTop: 0 }}>
        <b>Проём {o.w}×{o.h}</b>
        {parent && <>
          <span style={{ color: 'var(--text-muted)' }}>{v ? 'ширина' : 'высота'}</span>
          <SmallNum value={v ? o.w : o.h} onChange={x => x > 0 && apply(opSetSize(tree, node.id, x, pull, sizes))} />
          <span style={{ color: 'var(--text-muted)' }}>тянуть</span>
          {[['before', v ? '← левые' : '↓ нижние'], ['after', v ? 'правые →' : 'верхние ↑']].map(([k, t]) =>
            <button key={k} type="button" style={{ ...chipS(pull === k), padding: '3px 8px' }} onClick={() => setPull(k)}>{t}</button>)}
          <button type="button" style={{ ...chipS(node.size == null), padding: '3px 8px' }} onClick={() => patch(n => { n.size = null })}>авто</button>
        </>}
        <button type="button" style={{ marginLeft: 'auto', border: 'none', background: 'none', fontSize: 16, cursor: 'pointer', color: 'var(--text-muted)' }} onClick={() => setSel(null)}>✕</button>
      </div>
      {onBlock && blocksOf(node).length > 0 && <div style={row}>
        <span style={{ color: 'var(--text-muted)' }}>В проёме:</span>
        {blocksOf(node).map(b => <button key={b.t} type="button" style={{ ...chipS(false), padding: '3px 8px', borderColor: '#f59e0b' }} onClick={() => onBlock(b)}>{blockTitle(node, b.t)} ›</button>)}
      </div>}
      {node.split && node.children?.length > 0 && <div style={row}>
        <span>{node.split === 'v' ? 'Верт. панелей' : 'Гориз. панелей'}</span>
        <SmallNum width={44} value={node.children.length - 1} onChange={x => {
          const n = Math.max(1, Math.min(20, Math.round(x)))
          if (n === node.children.length - 1) return
          const drop = node.children.slice(n + 1)
          if (drop.some(c => c.split || c.front || c.fpanel) && !window.confirm('В убираемых проёмах есть наполнение — убрать?')) return
          patch(nd => { if (n + 1 > nd.children.length) for (let i = nd.children.length; i < n + 1; i++) nd.children.push({ id: 'o' + Math.random().toString(36).slice(2, 8), size: null, split: null, children: [], front: null, shelfType: 'fixed' }); else nd.children = nd.children.slice(0, n + 1); nd.children.forEach(c => { c.size = null }) })
        }} />
        <span>· отступ спереди</span>
        <SmallNum width={52} value={node.setFront ?? (node.split === 'h' ? (node.shelfType === 'loose' ? Math.max(num(p.shelfSetback) || 0, 2) : num(p.shelfSetback) || 0) : 0)} onChange={x => patch(n => { n.setFront = x })} />
        <span>сзади</span><SmallNum width={52} value={node.setBack ?? 0} onChange={x => patch(n => { n.setBack = x })} />
        {node.split === 'h' && [['fixed', 'неподвижные'], ['loose', 'съёмные']].map(([k, t]) => <button key={k} type="button" style={{ ...chipS((node.shelfType || 'fixed') === k), padding: '3px 8px' }} onClick={() => patch(n => { n.shelfType = k })}>{t}</button>)}
        {node.split === 'h' && <>
          {[['rect', 'прямые'], ['round', 'скруглённые']].map(([k, t]) => <button key={k} type="button" style={{ ...chipS((node.shelfShape || 'rect') === k), padding: '3px 8px' }} onClick={() => patch(n => { n.shelfShape = k; if (k === 'round' && !n.shelfR) n.shelfR = 150 })}>{t}</button>)}
          {node.shelfShape === 'round' && <><span>R</span><SmallNum width={52} value={node.shelfR || 150} onChange={x => x > 0 && patch(n => { n.shelfR = x })} /></>}
        </>}
      </div>}
      {fp && <div style={row}>
        <span>Фронт. панель:</span>
        {[['back', 'от зада'], ['front', 'от переда']].map(([k, t]) => <button key={k} type="button" style={{ ...chipS(fp.from === k), padding: '3px 8px' }} onClick={() => patch(n => { n.fpanel = { ...n.fpanel, from: k } })}>{t}</button>)}
        <SmallNum width={52} value={fp.dist} onChange={x => patch(n => { n.fpanel = { ...n.fpanel, dist: x } })} />
        <span>отступы Л</span><SmallNum width={44} value={fp.l} onChange={x => patch(n => { n.fpanel = { ...n.fpanel, l: x } })} />
        <span>П</span><SmallNum width={44} value={fp.r} onChange={x => patch(n => { n.fpanel = { ...n.fpanel, r: x } })} />
        <span>Н</span><SmallNum width={44} value={fp.b} onChange={x => patch(n => { n.fpanel = { ...n.fpanel, b: x } })} />
        <span>В</span><SmallNum width={44} value={fp.t} onChange={x => patch(n => { n.fpanel = { ...n.fpanel, t: x } })} />
      </div>}
      {node.front?.type === 'doors' && node.front.n === 1 && <div style={row}><span>Петли</span>
        {[['left', 'слева'], ['right', 'справа']].map(([k, t]) => <button key={k} type="button" style={{ ...chipS((node.front.hinge === 'right' ? 'right' : 'left') === k), padding: '3px 8px' }} onClick={() => apply(opFront(tree, node.id, { ...node.front, hinge: k }))}>{t}</button>)}
      </div>}
      {node.front?.type === 'drawers' && <div style={row}><span>Ящиков</span>
        <SmallNum width={44} value={node.front.n} onChange={x => x >= 1 && x <= 10 && apply(opFront(tree, node.id, { ...node.front, n: Math.round(x) }))} />
      </div>}
    </div>
  )
}

// ── параметрический блок: всё, что поставлено в проём (панели деления, фронтальная панель, двери, ящики) ──
// blk: { n: id проёма, t: 'split' | 'fpanel' | 'front', c?: id проёма перед выбранной панелью }
const blockTitle = (node, t) => t === 'rod' ? 'Штанга' : t === 'fpanel' ? 'Фронтальная панель'
  : t === 'front' ? (node?.front?.type === 'drawers' ? `Ящики · ${node.front.n}` : `Двери · ${node?.front?.n || 1}`)
    : node?.split === 'v' ? `Вертикальные панели · ${(node.children?.length || 1) - 1}` : `Горизонтальные панели · ${(node?.children?.length || 1) - 1}`
const blocksOf = node => [
  ...(node?.split && node.children?.length > 1 ? [{ n: node.id, t: 'split' }] : []),
  ...(node?.fpanel ? [{ n: node.id, t: 'fpanel' }] : []),
  ...(node?.front ? [{ n: node.id, t: 'front' }] : []),
  ...(node?.rod ? [{ n: node.id, t: 'rod' }] : []),
]

// ── ручка блока: вид, положение (привязка к углу / центру, отступы), межцентровое (шаг 32) ──
const CC = [64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 416, 480, 544, 640, 736, 832]
const ANCHORS = [['c', 'Центр'], ['tc', 'Сверху по центру'], ['bc', 'Снизу по центру'], ['tl', '↖ угол'], ['tr', '↗ угол'], ['bl', '↙ угол'], ['br', '↘ угол'], ['free-t', 'Против петель, сверху'], ['free-c', 'Против петель, середина'], ['free-b', 'Против петель, снизу']]
function HandleEditor({ h, onChange, door }) {
  const on = h.on !== false && h.type !== 'none'
  const set = patch => onChange({ ...h, ...patch })
  return (<>
    <label style={{ fontSize: 13.5, fontWeight: 600, display: 'flex', gap: 6, alignItems: 'center', margin: '4px 0 6px' }}><input type="checkbox" style={{ width: 'auto', margin: 0 }} checked={on} onChange={e => set({ on: e.target.checked, type: h.type === 'none' ? 'bar' : h.type })} />Ручки</label>
    {on && <Sub>
      <Chips label="Вид" value={HANDLE_TYPES.some(t => t[0] === h.type) ? h.type : 'rail'} onChange={v => set({ type: v })} options={HANDLE_TYPES} />
      {h.type === 'edge' || h.type === 'edgeflat' ? <>
        <Grid cols={2}><NumField label="Длина (пусто — по ширине фасада)" value={h.len ?? ''} onChange={v => set({ len: v || null })} min={0} />
          {h.type === 'edge' && <NumField label="Вылет козырька от лица" unit="мм" value={h.proj ?? 20} onChange={v => set({ proj: v })} min={2} />}</Grid>
        <p style={{ fontSize: 11.5, color: 'var(--text-hint)', margin: '-4px 0 8px' }}>Торцевая ручка крепится сзади фасада у верхнего торца (глухие отверстия в обратной пласти); тонкий профиль лежит в зазоре над фасадом, у «с язычком» — козырёк выступает вперёд от лица фасада и загнут вниз — под него заводят пальцы.</p>
      </> : <>
        {h.type !== 'knob' && h.type !== 'knobsq' && <Chips label="Расположение" value={h.orient || 'h'} onChange={v => set({ orient: v })} options={[['h', 'Горизонтально'], ['v', 'Вертикально']]} />}
        <Chips label="Привязка" value={h.anchor || 'c'} onChange={v => set({ anchor: v })} options={door ? ANCHORS : ANCHORS.slice(0, 7)} />
        <Grid cols={3}>
          {h.type !== 'knob' && h.type !== 'knobsq' && <label style={{ display: 'block', minWidth: 0 }}><span style={lbl}>Межцентровое, мм</span>
            <select style={inp} value={h.cc || 128} onChange={e => set({ cc: Number(e.target.value) })}>{(CC.includes(Number(h.cc)) ? CC : [...CC, Number(h.cc)].sort((a, b) => a - b)).map(v => <option key={v} value={v}>{v}</option>)}</select></label>}
          <NumField label="От края сбоку" value={h.dx ?? 40} onChange={v => set({ dx: v })} />
          <NumField label="От верха / низа" value={h.dy ?? 40} onChange={v => set({ dy: v })} />
        </Grid>
        <p style={{ fontSize: 11.5, color: 'var(--text-hint)', margin: '-4px 0 8px' }}>Отступы — от края фасада до первого отверстия (по центру — не нужны). Как сверлить (насквозь / глухие с изнанки / с лица) и диаметр — в «Крепёж» ниже.</p>
      </>}
    </Sub>}
  </>)
}

// параметры корпуса, которые запоминаются за аккаунтом: поменял в любом корпусе — так будет и в новых
const CAB_REMEMBER = ['material', 't', 'facadeMaterial', 'facadeT', 'backMaterial', 'backT', 'edgeFront', 'edgeFacade', 'edgeBody', 'grooveOffset', 'grooveDepth', 'grooveWidth',
  'backGapL', 'backGapR', 'backGapB', 'backGapT', 'gap', 'frontMode', 'frontOffset', 'soloOverlap', 'hingeCup', 'hingeEnd', 'plateFront', 'box', 'slideGap', 'slideLen',
  'boxTopGap', 'boxBottomT', 'boxBottomMaterial', 'metalReduce', 'handleDoor', 'handleDrawer', 'pinFront', 'pinBelow', 'plateType']
// ── крепёж фурнитуры: на саморезы (без присадки) или сверлить d × глубина; запоминается за аккаунтом ──
const MOUNT_ROWS = [['slide', 'Направляющие ящиков', true], ['dfront', 'Фасад к ящику', true], ['plate', 'Планки петель', true], ['cup', 'Чашка петли', false], ['cupFix', 'Крепёж чашки', true], ['pin', 'Полкодержатели', false], ['handle', 'Ручки', 'handle'], ['rod', 'Штангодержатели', true]]
function MountEditor({ mount, setMount, only }) {
  const M = mountOf(mount)
  const set = (k, patch) => setMount({ ...(mount || {}), [k]: { ...M[k], ...patch } })
  return (<>
    {MOUNT_ROWS.filter(([k]) => !only || only.includes(k)).map(([k, name, canNone]) => {
      const m = M[k]
      if (canNone === 'handle') return <div key={k} style={{ marginBottom: 6 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center', fontSize: 13 }}>
          <span style={{ minWidth: 130, fontWeight: 600 }}>{name}</span>
          {[['through', 'насквозь'], ['back', 'глухие с изнанки'], ['front', 'глухие с лица']].map(([v, tt]) =>
            <button key={v} type="button" style={{ ...chipS((m.mode || 'through') === v), padding: '3px 8px' }} onClick={() => set(k, { mode: v })}>{tt}</button>)}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center', fontSize: 12.5, marginTop: 3, paddingLeft: 6 }}>
          <span>Ø</span><SmallNum width={52} value={m.d} onChange={v => v > 0 && set(k, { d: v })} />
          {m.mode !== 'through' && m.mode && <><span>глубина</span><SmallNum width={52} value={m.depth} onChange={v => v > 0 && set(k, { depth: v })} /></>}
        </div>
        {m.mode === 'back' && <p style={{ fontSize: 11.5, color: 'var(--text-hint)', margin: '3px 0 0 6px' }}>Глухие с изнанки — лицо фасада целое: если ручка поменяется (например, 96 → 128), можно пересверлить.</p>}
      </div>
      const drill = !canNone || m.mode === 'drill'
      return <div key={k} style={{ marginBottom: 6 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center', fontSize: 13 }}>
          <span style={{ minWidth: 130, fontWeight: 600 }}>{name}</span>
          {canNone && <><button type="button" style={{ ...chipS(m.mode === 'none'), padding: '3px 8px' }} onClick={() => set(k, { mode: 'none' })}>саморезы, без присадки</button>
            <button type="button" style={{ ...chipS(m.mode === 'drill'), padding: '3px 8px' }} onClick={() => set(k, { mode: 'drill' })}>сверлить</button></>}
        </div>
        {drill && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center', fontSize: 12.5, marginTop: 3, paddingLeft: 6 }}>
          <span>Ø</span><SmallNum width={52} value={m.d} onChange={v => v > 0 && set(k, { d: v })} />
          <span>глубина</span><SmallNum width={52} value={m.depth} onChange={v => v > 0 && set(k, { depth: v })} />
          {canNone && <>{[[2.5, 3, 'наколка'], [5, 13, 'евровинт'], ...(k === 'cupFix' ? [[8, 11.5, 'впрессовка']] : [])].map(([d, dp, t]) =>
            <button key={t} type="button" style={{ ...chipS(m.d === d && m.depth === dp), padding: '2px 7px', fontSize: 11.5 }} onClick={() => set(k, { d, depth: dp })}>{t} {d}×{dp}</button>)}</>}
        </div>}
      </div>
    })}
    <p style={{ fontSize: 11.5, color: 'var(--text-hint)', margin: '2px 0 6px' }}>Запоминается за вашим аккаунтом — так считается присадка для раскроя и ЧПУ во всех проектах.</p>
  </>)
}

// ── цвет / текстура материала (за аккаунтом): фото декора с телефона или картинка из интернета ──
function shrinkImage(file, max = 512) {
  return new Promise((res, rej) => {
    const fr = new FileReader()
    fr.onerror = rej
    fr.onload = () => {
      const img = new Image()
      img.onerror = rej
      img.onload = () => {
        const k = Math.min(1, max / Math.max(img.width, img.height))
        const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k)
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height)
        res(c.toDataURL('image/jpeg', 0.82))
      }
      img.src = fr.result
    }
    fr.readAsDataURL(file)
  })
}
// крепёж стыков детали: своя схема (например, столешница на минификсах — без сквозных отверстий в лице)
const jointOptions = customs => [...JOINTS, ...Object.entries(customs || {}).map(([id, c]) => ['u:' + id, '★ ' + (c.name || 'Своя схема')])]
const jointName = (id, customs) => (jointOptions(customs).find(o => o[0] === id) || [0, id])[1]
function JointPick({ value, onChange, customs, label = 'Крепёж всех стыков этой детали', emptyText = 'Как в проекте' }) {
  return (
    <label style={{ display: 'block', marginTop: 8 }}><span style={lbl}>{label}</span>
      <select style={inp} value={value || ''} onChange={e => onChange(e.target.value || null)}>
        {emptyText && <option value="">{emptyText}</option>}
        {jointOptions(customs).map(([k, t]) => <option key={k} value={k}>{t}</option>)}
      </select></label>
  )
}
// стыки выбранной детали: с кем и какой длины; у каждого стыка — своя схема (например, у стойки сверху стяжки, снизу конфирматы)
function PartJoints({ parts, sp, project, setProject, customs }) {
  const st = { ...PROJECT_DEFAULTS, ...(project.settings || {}) }
  const js = partJoints(parts, sp.pid, st.joint)
  const setPair = (j, v) => setProject({ ...project, items: project.items.map(it => { if (it.id !== sp.item.id) return it; const jp = { ...(it.jointPair || {}) }; const [a, b] = j.key.split('|'); delete jp[`${b}|${a}`]; if (v) jp[j.key] = v; else delete jp[j.key]; return { ...it, jointPair: jp } }) })
  if (!js.length) return <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '8px 0 0' }}>Стыков с другими плитами у этой детали нет.</p>
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ ...lbl, marginBottom: 4 }}>Стыки этой детали ({js.length}) — схема у каждого стыка</div>
      {js.map(j => <div key={j.key} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4, fontSize: 12.5 }}>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>↔ {j.other.item !== sp.item ? j.other.item.name + ' · ' : ''}{j.other.name} · {j.len} мм</span>
        <select style={{ ...inp, width: 'auto', maxWidth: 190, padding: '4px 6px', fontSize: 12.5 }} value={j.own || ''} disabled={!j.sameItem} onChange={e => setPair(j, e.target.value || null)}>
          <option value="">как у детали ({jointName(j.scheme, customs)})</option>
          {jointOptions(customs).map(([k, t]) => <option key={k} value={k}>{t}</option>)}
        </select>
      </div>)}
    </div>
  )
}
// свои схемы крепежа (за аккаунтом): какой крепёж, шканты рядом, отступы от концов (можно несимметрично), шаг, шкант от крепежа
function JointSchemes({ customs, setCustoms }) {
  const list = Object.entries(customs || {})
  const upd = (id, patch) => setCustoms({ ...customs, [id]: { ...customs[id], ...patch } })
  return (<>
    {list.map(([id, c]) => <div key={id} style={{ border: '0.5px solid var(--border)', borderRadius: 8, padding: '6px 8px', marginBottom: 6 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
        <div style={{ flex: 1 }}><TextField label="Название" value={c.name} onChange={v => upd(id, { name: v })} /></div>
        <button type="button" style={{ ...btnS(), color: 'var(--danger)' }} onClick={() => { if (window.confirm(`Удалить схему «${c.name}»?`)) { const n = { ...customs }; delete n[id]; setCustoms(n) } }}>🗑</button>
      </div>
      <Chips label="Крепёж" value={c.fast || 'confirmat'} onChange={v => upd(id, { fast: v })} options={[['confirmat', 'Конфирмат'], ['minifix', 'Минификс'], ['dowel', 'Только шканты'], ['none', 'Без присадки (уголки, стяжки)']]} />
      {c.fast !== 'dowel' && c.fast !== 'none' && <label style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}><input type="checkbox" style={{ width: 'auto', margin: 0 }} checked={!!c.dowel} onChange={e => upd(id, { dowel: e.target.checked })} />Шканты рядом с крепежом</label>}
      {c.fast !== 'none' && <Grid cols={3}>
        <NumField label="От начала стыка" value={c.end ?? 50} onChange={v => upd(id, { end: v })} min={0} />
        <NumField label="От конца (пусто — так же)" value={c.endB ?? ''} onChange={v => upd(id, { endB: v })} min={0} />
        <NumField label="Шаг не больше" value={c.step ?? 600} onChange={v => upd(id, { step: v })} min={50} />
        {c.dowel && c.fast !== 'dowel' && <NumField label="Шкант от крепежа" value={c.shift ?? 32} onChange={v => upd(id, { shift: v })} min={0} />}
        {c.dowel && <NumField label="Шканты, если стык от" value={c.dowelMin ?? 200} onChange={v => upd(id, { dowelMin: v })} min={0} />}
      </Grid>}
      {c.endB != null && c.endB !== '' && <button type="button" style={{ ...chipS(false), padding: '2px 8px' }} onClick={() => upd(id, { endB: null })}>симметрично</button>}
    </div>)}
    <button type="button" style={btnS()} onClick={() => { const id = Math.random().toString(36).slice(2, 8); setCustoms({ ...(customs || {}), [id]: { name: 'Моя схема', fast: 'confirmat', dowel: true, end: 50, step: 600, shift: 32, dowelMin: 200 } }) }}>+ Своя схема крепежа</button>
    <p style={{ fontSize: 11.5, color: 'var(--text-hint)', margin: '6px 0 0' }}>Свои схемы запоминаются за аккаунтом и появляются в выборе крепежа (★). Отступы от начала и конца стыка разные — несимметрично.</p>
  </>)
}
// материал (декор) для выбранных деталей: другой материал — это и другой раскрой (детали уйдут в свою группу)
function MatPick({ materials, value, onApply, onReset }) {
  const [v, setV] = useState(value || '')
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end', flexWrap: 'wrap' }}>
      <div style={{ flex: 1, minWidth: 160 }}><TextField label="Материал (декор)" value={v} onChange={setV} list="cad-mats" /></div>
      <button type="button" style={btnS(true)} disabled={!v.trim()} onClick={() => onApply(v.trim())}>Применить</button>
      {onReset ? <button type="button" style={btnS()} onClick={onReset}>↺ как в корпусе</button> : <button type="button" style={btnS()} onClick={() => onApply(null)}>↺ как в корпусе</button>}
      {void materials}
    </div>
  )
}
// каталог декоров из интернета (Poly Haven, бесплатные текстуры CC0): картинка не скачивается на телефон —
// запоминается только ссылка, модель берёт её прямо с сайта
const DECOR_CATS = [['wood', 'Дерево'], ['stone', 'Камень'], ['marble', 'Мрамор'], ['concrete', 'Бетон'], ['fabric', 'Ткань'], ['metal', 'Металл'], ['plaster', 'Штукатурка']]
function DecorCatalog({ onPick, onClose }) {
  const [cat, setCat] = useState('wood')
  const [list, setList] = useState(null)
  const [q, setQ] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  useEffect(() => {
    let a = true
    fetch(`https://api.polyhaven.com/assets?type=textures&categories=${cat}`).then(r => r.json())
      .then(d => { if (a) { setErr(''); setList(Object.entries(d).map(([id, v]) => ({ id, name: v.name, dim: v.dimensions?.[0] || 1000 }))) } })
      .catch(() => { if (a) { setList([]); setErr('Каталог не открылся — проверьте интернет') } })
    return () => { a = false }
  }, [cat])
  const pick = async it => {
    setBusy(it.id)
    try {
      const f = await (await fetch(`https://api.polyhaven.com/files/${it.id}`)).json()
      const url = f?.Diffuse?.['1k']?.jpg?.url || `https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/${it.id}/${it.id}_diff_1k.jpg`
      onPick({ tex: url, scale: Math.round(it.dim) || 1000, src: 'Poly Haven · ' + it.name })
    } catch { setErr('Не удалось взять текстуру — попробуйте другую') }
    setBusy('')
  }
  const shown = (list || []).filter(x => !q || x.name.toLowerCase().includes(q.toLowerCase())).slice(0, 60)
  return (
    <div style={{ marginTop: 6, padding: 6, border: '0.5px solid var(--border-md)', borderRadius: 8 }}>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
        {DECOR_CATS.map(([k, t]) => <button key={k} type="button" style={{ ...chipS(cat === k), padding: '2px 8px' }} onClick={() => { setList(null); setCat(k) }}>{t}</button>)}
        <button type="button" style={{ marginLeft: 'auto', border: 'none', background: 'none', fontSize: 16, cursor: 'pointer', color: 'var(--text-muted)' }} onClick={onClose}>✕</button>
      </div>
      <input style={{ ...inp, padding: '5px 8px', marginBottom: 6 }} placeholder="Поиск (по-английски: oak, walnut, pine…)" value={q} onChange={e => setQ(e.target.value)} />
      {err && <p style={{ fontSize: 12, color: 'var(--danger)', margin: '0 0 6px' }}>{err}</p>}
      {list === null ? <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>Загружаем…</p> :
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(72px, 1fr))', gap: 5, maxHeight: 260, overflowY: 'auto' }}>
          {shown.map(it => <button key={it.id} type="button" title={it.name} onClick={() => pick(it)} disabled={!!busy}
            style={{ padding: 0, border: '0.5px solid var(--border)', borderRadius: 6, overflow: 'hidden', background: 'var(--bg2)', cursor: 'pointer', opacity: busy && busy !== it.id ? 0.5 : 1 }}>
            <img src={`https://cdn.polyhaven.com/asset_img/thumbs/${it.id}.png?width=144&height=144`} alt="" loading="lazy" style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', display: 'block' }} />
            <span style={{ display: 'block', fontSize: 10, padding: '2px 3px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--text)' }}>{busy === it.id ? '…' : it.name}</span>
          </button>)}
        </div>}
      <p style={{ fontSize: 10.5, color: 'var(--text-hint)', margin: '5px 0 0' }}>Текстуры Poly Haven (бесплатные, CC0). На телефон не скачиваются — запоминается ссылка.</p>
    </div>
  )
}
function MatLookEditor({ name, looks, setLooks }) {
  const [cat, setCat] = useState(false)
  const [url, setUrl] = useState('')
  if (!name) return null
  const own = looks?.[name] || {}
  const set = patch => { const n = { ...own, ...patch }; Object.keys(n).forEach(k => (n[k] == null || n[k] === '') && delete n[k]); const all = { ...(looks || {}) }; if (Object.keys(n).length) all[name] = n; else delete all[name]; setLooks(all) }
  return (
    <div style={{ marginTop: 8, padding: '6px 8px', border: '0.5px solid var(--border)', borderRadius: 8 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 5 }}>Как выглядит «{name}»</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', fontSize: 12.5 }}>
        <label style={{ display: 'flex', gap: 5, alignItems: 'center' }}>цвет<input type="color" value={own.color || '#d9cdb4'} onChange={e => set({ color: e.target.value })} style={{ width: 36, height: 24, padding: 0, border: 'none', background: 'none' }} /></label>
        <label style={{ ...btnS(), padding: '4px 9px', fontSize: 12.5 }}>📷 Фото декора
          <input type="file" accept="image/*" style={{ display: 'none' }} onChange={async e => { const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; try { set({ tex: await shrinkImage(f) }) } catch { window.alert('Не удалось открыть картинку') } }} /></label>
        <button type="button" style={{ ...btnS(true), padding: '4px 9px', fontSize: 12.5 }} onClick={() => setCat(v => !v)}>🌐 Декор из интернета</button>
        {own.tex && <><img src={own.tex} alt="" style={{ width: 34, height: 24, objectFit: 'cover', borderRadius: 4 }} />
          <span>размер картинки</span><SmallNum width={56} value={own.scale || 600} onChange={v => v > 50 && set({ scale: v })} /><span>мм</span>
          <span>декор на фото</span>{[['v', '↕ вертикально'], ['h', '↔ горизонтально']].map(([k, t]) => <button key={k} type="button" style={{ ...chipS((own.dir || 'v') === k), padding: '2px 8px' }} onClick={() => set({ dir: k === 'v' ? null : k })}>{t}</button>)}
          <button type="button" style={{ ...chipS(false), padding: '2px 8px' }} onClick={() => set({ tex: null })}>убрать фото</button></>}
        {(own.color || own.tex) && <button type="button" style={{ ...chipS(false), padding: '2px 8px' }} onClick={() => setLooks(Object.fromEntries(Object.entries(looks || {}).filter(([k]) => k !== name)))}>↺ по умолчанию</button>}
      </div>
      <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12.5, marginTop: 6 }}><span>Блеск: матовый</span>
        <input type="range" min="0" max="1" step="0.05" value={own.gloss ?? 0.15} onChange={e => set({ gloss: Number(e.target.value) })} style={{ flex: 1, minWidth: 0 }} /><span>глянец</span>
        {own.gloss != null && <button type="button" style={{ ...chipS(false), padding: '1px 7px' }} onClick={() => set({ gloss: null })}>авто</button>}</label>
      {cat && <DecorCatalog onClose={() => setCat(false)} onPick={v => { set(v); setCat(false) }} />}
      <div style={{ display: 'flex', gap: 5, marginTop: 6 }}>
        <input style={{ ...inp, padding: '5px 8px', fontSize: 12.5 }} placeholder="или ссылка на картинку декора (https://…)" value={url} onChange={e => setUrl(e.target.value)} />
        {navigator.clipboard?.readText && <button type="button" title="Вставить ссылку из буфера" style={{ ...btnS(), padding: '4px 9px' }} onClick={async () => { try { const t = (await navigator.clipboard.readText()).trim(); if (t) setUrl(t) } catch { window.alert('Нет доступа к буферу — вставьте ссылку вручную (долгое нажатие в поле → Вставить)') } }}>📋</button>}
        <button type="button" style={{ ...btnS(), padding: '4px 9px' }} disabled={!/^https?:\/\//.test(url.trim())} onClick={() => { set({ tex: url.trim(), src: 'ссылка' }); setUrl('') }}>Взять</button>
      </div>
      {/* поиск картинки декора по названию материала: открывается поиск картинок, долгое нажатие на картинку → «Копировать адрес» → 📋 → Взять */}
      <button type="button" style={{ ...btnS(true), padding: '4px 9px', fontSize: 12.5, marginTop: 6 }} onClick={() => window.open('https://www.google.com/search?tbm=isch&q=' + encodeURIComponent(name + ' декор текстура'), '_blank', 'noopener')}>🔍 Найти текстуру «{name}» в интернете</button>
      {own.src && <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '4px 0 0' }}>Декор: {own.src}</p>}
      <p style={{ fontSize: 11, color: 'var(--text-hint)', margin: '4px 0 0' }}>«Найти текстуру» открывает поиск картинок по названию материала: нажмите на картинку, затем долгое нажатие → «Копировать адрес изображения», вернитесь сюда — 📋 и «Взять». Картинку по ссылке видно, только если сайт её разрешает (не все сайты отдают картинки другим приложениям). Направление декора на фото укажите, как он идёт на картинке, — на детали он ляжет вдоль её длины (как волокно при раскрое); на отдельной детали можно повернуть. Сфотографируйте образец или сохраните картинку из интернета и загрузите её — так деталь и все детали этого материала будут выглядеть на модели. Запоминается за аккаунтом.</p>
    </div>
  )
}

function BlockCard({ it, set, blk, setBlk, onClose, mount, setMount }) {
  const [selDr, setSelDr] = useState([])      // какие ящики блока правим (пусто — все)
  const p = { ...CAB_DEFAULTS, ...it.p }
  const tree = treeOf(p)
  const ops = useMemo(() => cabinetParts(p).openings || [], [it.p]) // eslint-disable-line react-hooks/exhaustive-deps
  const r = findNode(tree, blk.n)
  const node = r?.node
  const o = ops.find(x => x.id === blk.n)
  const alive = node && (blk.t === 'split' ? node.split && node.children?.length > 1 : blk.t === 'fpanel' ? !!node.fpanel : blk.t === 'rod' ? !!node.rod : !!node.front)
  if (!alive) return <div className="card" style={{ padding: '10px 12px', marginBottom: 10, fontSize: 13 }}>Блок убран. <button type="button" style={btnS()} onClick={onClose}>← К корпусу</button></div>
  const apply = t => { if (t) set({ ...it, p: { ...p, tree: t } }) }
  const up = patchP => set({ ...it, p: { ...p, ...patchP } })
  const patch = fn => apply(opPatch(tree, node.id, fn))
  const tt = num(p.t) || 16, gp = num(p.gap) || 0, offs = num(p.frontOffset) || 0
  const outerExt = p.frontMode === 'half' ? tt / 2 - gp / 2 : tt - offs
  const soloExt = p.soloOverlap != null && p.soloOverlap !== '' ? num(p.soloOverlap) : outerExt
  const r1 = v => Math.round(v * 10) / 10
  const replace = (what, n) => {
    const busy = blk.t === 'split' && node.children.some(c => c.split || c.front || c.fpanel)
    if (busy && !['h', 'v'].includes(what) && !window.confirm('В проёмах между панелями есть наполнение — оно пропадёт. Заменить?')) return
    let t = opReplace(tree, node.id, what, n)
    // заменили панели на ящики / двери — убираем старое деление; двери вместо ящиков и наоборот — просто меняем фасад
    if (blk.t === 'split' && (what === 'doors')) t = opReplace(t, node.id, null)
    apply(t)
    setBlk(what === 'h' || what === 'v' ? { n: node.id, t: 'split' } : what === 'drawers' || what === 'doors' ? { n: node.id, t: 'front' } : null)
  }
  const isH = node.split === 'h'
  const ch = node.children || []
  const ci = blk.c ? ch.findIndex(c => c.id === blk.c) : -1
  const one = blk.t === 'split' && ci >= 0 && ci < ch.length - 1
  const pan = one ? (node.pan?.[blk.c] || {}) : {}
  const setPan = patchP => patch(n => { n.pan = { ...(n.pan || {}) }; const cur = { ...(n.pan[blk.c] || {}), ...patchP }; Object.keys(cur).forEach(k => cur[k] == null && delete cur[k]); if (Object.keys(cur).length) n.pan[blk.c] = cur; else delete n.pan[blk.c] })
  const endPanel = one && node.id === tree.id && node.split === 'v' && ((p.sideL === false && ci === 0) || (p.sideR === false && ci === ch.length - 2))
  const defF = node.setFront ?? (isH ? (node.shelfType === 'loose' ? Math.max(num(p.shelfSetback) || 0, 2) : num(p.shelfSetback) || 0) : 0)
  const fr = node.front
  const row = { display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center', marginBottom: 8 }
  return (
    <div className="card" style={{ padding: '8px 10px', marginBottom: 10, border: '1px solid #f59e0b' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <button type="button" style={{ ...btnS(), padding: '5px 9px' }} onClick={onClose} title="Свойства корпуса">← Корпус</button>
        <b style={{ fontSize: 14, flex: 1 }}>{blockTitle(node, blk.t)}</b>
        <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>проём {o ? `${o.w}×${o.h}` : ''}</span>
      </div>

      {blk.t === 'split' && <>
        <Grid cols={3}>
          <NumField label="Сколько" unit="шт" value={ch.length - 1} onChange={v => { if (v >= 1) { const drop = ch.slice(Math.round(v) + 1); if (drop.some(c => c.split || c.front || c.fpanel) && !window.confirm('В убираемых проёмах есть наполнение — убрать?')) return; apply(opCount(tree, node.id, v)) } }} min={1} />
          <NumField label="Отступ спереди" value={defF} onChange={v => patch(n => { n.setFront = v })} />
          <NumField label="сзади" value={node.setBack ?? 0} onChange={v => patch(n => { n.setBack = v })} />
          {isH ? <><NumField label="слева" value={node.setL ?? 0} onChange={v => patch(n => { n.setL = v })} /><NumField label="справа" value={node.setR ?? 0} onChange={v => patch(n => { n.setR = v })} /></>
            : <><NumField label="снизу" value={node.setBot ?? 0} onChange={v => patch(n => { n.setBot = v })} /><NumField label="сверху" value={node.setTop ?? 0} onChange={v => patch(n => { n.setTop = v })} /></>}
        </Grid>
        <p style={{ fontSize: 11.5, color: 'var(--text-hint)', margin: '-4px 0 8px' }}>Отступ с любой стороны — от края проёма (минус — выступает). Торец с отступом на виду — с кромкой.</p>
        {isH && <>
          <Chips label="Крепление (все панели блока)" value={node.shelfType || 'fixed'} onChange={v => patch(n => { n.shelfType = v })} options={[['fixed', 'Конфирмат (неподвижные)'], ['loose', 'Полкодержатели (съёмные)']]} />
          <Chips label="Форма" value={node.shelfShape || 'rect'} onChange={v => patch(n => { n.shelfShape = v; if (v === 'round' && !n.shelfR) n.shelfR = 150 })} options={[['rect', 'Прямые'], ['round', 'Скруглённые']]} />
          {node.shelfShape === 'round' && <Grid><NumField label="Радиус" value={node.shelfR || 150} onChange={v => v > 0 && patch(n => { n.shelfR = v })} min={1} /></Grid>}
        </>}
        {one && <Sub>
          <div style={{ ...sect, marginTop: 4 }}>Эта панель · {ci + 1} из {ch.length - 1}</div>
          {isH && <Chips label="Крепление" value={pan.type || ''} onChange={v => setPan({ type: v || null })} options={[['', 'Как у блока'], ['fixed', 'Конфирмат'], ['loose', 'Полкодержатели']]} />}
          <Grid cols={2}>
            <NumField label="Отступ спереди" value={pan.setF ?? defF} onChange={v => setPan({ setF: v })} />
            <NumField label={endPanel ? 'Отступ от зада корпуса' : 'Отступ сзади'} value={pan.setB ?? (endPanel ? (p.sideBack ?? 0) : node.setBack ?? 0)} onChange={v => setPan({ setB: v })} />
          </Grid>
          {endPanel && p.back === 'groove' && <p style={{ fontSize: 11.5, color: 'var(--text-hint)', margin: '-4px 0 8px' }}>
            Крайняя панель вместо боковины. Отступ от зада меньше {num(p.grooveOffset) + num(p.grooveWidth)} мм (паз + ширина паза) — задняя стенка в пазу панели; больше — стенка проходит за панелью и закрывает её торец внахлёст (паза нет).</p>}
          <div style={row}>
            {(pan.type || pan.setF != null || pan.setB != null) && <button type="button" style={btnS()} onClick={() => setPan({ type: null, setF: null, setB: null })}>↺ Как у блока</button>}
            <button type="button" style={{ ...btnS(), color: 'var(--danger)' }} onClick={() => {
              const keep = ch[ci + 1]
              if ((keep.split || keep.front || keep.fpanel) && !window.confirm('Проём над / справа от панели с наполнением — наполнение пропадёт. Убрать панель?')) return
              apply(opRemovePanel(tree, node.id, blk.c)); setBlk(ch.length > 2 ? { n: node.id, t: 'split' } : null)
            }}>🗑 Убрать эту панель</button>
          </div>
        </Sub>}
        {!one && <p style={{ fontSize: 11.5, color: 'var(--text-hint)', margin: '0 0 8px' }}>Двойной тап по панели на модели — её собственные настройки (крепление, отступы, убрать).</p>}
      </>}

      {blk.t === 'fpanel' && node.fpanel && <>
        <Chips label="Положение по глубине" value={node.fpanel.from} onChange={v => patch(n => { n.fpanel = { ...n.fpanel, from: v } })} options={[['back', 'От зада'], ['front', 'От переда']]} />
        <Grid cols={3}>
          <NumField label="Расстояние" value={node.fpanel.dist} onChange={v => patch(n => { n.fpanel = { ...n.fpanel, dist: v } })} />
          {[['l', 'Отступ слева'], ['r', 'справа'], ['b', 'снизу'], ['t', 'сверху']].map(([k, tt]) => <NumField key={k} label={tt} value={node.fpanel[k]} onChange={v => patch(n => { n.fpanel = { ...n.fpanel, [k]: v } })} />)}
        </Grid>
      </>}

      {blk.t === 'rod' && node.rod && <>
        <Grid cols={3}>
          <NumField label="Ось ниже верха проёма" value={node.rod.top ?? 60} onChange={v => patch(n => { n.rod = { ...n.rod, top: v } })} min={0} />
          <NumField label="Диаметр" value={node.rod.d ?? 25} onChange={v => v > 5 && patch(n => { n.rod = { ...n.rod, d: v } })} min={5} />
          <NumField label="От переда (пусто — по центру)" value={node.rod.front ?? ''} onChange={v => patch(n => { n.rod = { ...n.rod, front: v || null } })} min={0} />
        </Grid>
        <TextField label="Материал (погонный — в линейный раскрой)" value={node.rod.material || `Труба Ø${node.rod.d ?? 25} хром`} onChange={v => patch(n => { n.rod = { ...n.rod, material: v } })} list="cad-mats" />
        <div style={{ ...sect }}>Крепёж</div>
        <MountEditor mount={mount} setMount={setMount} only={['rod']} />
      </>}

      {blk.t === 'front' && fr?.type === 'doors' && <>
        <Grid cols={3}><NumField label="Сколько" unit="шт" value={fr.n} onChange={v => v >= 1 && apply(opFront(tree, node.id, { ...fr, n: Math.min(6, Math.round(v)) }))} min={1} /></Grid>
        <Chips label="Расположение" value={fr.layout || 'v'} onChange={v => apply(opFront(tree, node.id, { ...fr, layout: v }))} options={[['v', 'Рядом'], ['h', 'Друг над другом']]} />
        {(fr.n === 1 || fr.layout === 'h') && <Chips label="Открывание" value={fr.open || (fr.hinge === 'right' ? 'right' : 'left')} onChange={v => apply(opFront(tree, node.id, { ...fr, open: v, hinge: v }))} options={[['left', '← влево'], ['right', 'вправо →'], ['up', '↑ вверх'], ['down', '↓ вниз']]} />}
        <Chips label="Фрезеровка фасада (МДФ)" value={fr.style || p.facadeStyle || 'flat'} onChange={v => apply(opFront(tree, node.id, { ...fr, style: v }))} options={FACADE_STYLES} />
        <HandleEditor door h={{ ...p.handleDoor, ...(fr.handle || {}) }} onChange={h => apply(opFront(tree, node.id, { ...fr, handle: h }))} />
        <div style={row}>
          {fr.handle && <button type="button" style={btnS()} onClick={() => apply(opFront(tree, node.id, { ...fr, handle: undefined }))}>↺ Ручка как в корпусе</button>}
          <button type="button" style={btnS()} onClick={() => up({ handleDoor: { ...p.handleDoor, ...(fr.handle || {}) } })} title="Новые двери получат эту ручку; запоминается за аккаунтом">Сделать основной для дверей</button>
        </div>
        <div style={sect}>Зазоры и перехлёст (весь корпус)</div>
        <FrontOverlap p={p} up={up} outerExt={outerExt} soloExt={soloExt} r1={r1} />
        <div style={sect}>Петли (весь корпус)</div>
        <Grid><NumField label="Чашка от края двери" value={p.hingeCup} onChange={v => up({ hingeCup: v })} min={5} /><NumField label="Крайние от торца" value={p.hingeEnd} onChange={v => up({ hingeEnd: v })} min={20} /><NumField label="Планка от переда" value={p.plateFront} onChange={v => up({ plateFront: v })} min={5} /></Grid>
        <Chips label="Ответная планка" value={p.plateType || 'cross'} onChange={v => up({ plateType: v })} options={[['cross', 'Крестообразная (2 отв. по вертикали)'], ['straight', 'Прямая (2 отв. по глубине, шаг 32)']]} />
        <div style={sect}>Крепёж</div>
        <MountEditor mount={mount} setMount={setMount} only={['cup', 'cupFix', 'plate', 'handle']} />
      </>}
      {blk.t === 'front' && fr?.type === 'drawers' && (() => {
        // правим все ящики блока или выбранные (свои настройки ящика — fr.per[i], снизу вверх)
        const sel = selDr.filter(i => i < fr.n)
        const curOf = f => (sel.length ? (fr.per?.[sel[0]]?.[f] ?? fr[f]) : fr[f])
        const setF = (f, v) => {
          if (!sel.length) { const per = (fr.per || []).map(o => { if (!o) return o; const c = { ...o }; delete c[f]; return Object.keys(c).length ? c : null }); apply(opFront(tree, node.id, { ...fr, [f]: v, per })); return }
          const per = Array.from({ length: fr.n }, (_, k) => fr.per?.[k] || null)
          for (const i of sel) per[i] = { ...(per[i] || {}), [f]: v }
          apply(opFront(tree, node.id, { ...fr, per }))
        }
        const sysId = curOf('box') || p.box, sys = { ...drawerSystem(sysId)[2], ...(curOf('sys') || {}) }
        const g = num(fr.gap ?? p.gap) ?? 3
        const fParts = cabinetParts(p).parts.filter(x => x.blk?.n === node.id && x.name === 'Фасад ящика').sort((a, b) => a.box[1] - b.box[1])
        const total = fParts.length ? fParts[fParts.length - 1].box[4] - fParts[0].box[1] : 0
        const hs = drawerHeights(total, fr.n, g, fr.hs)
        const setH = (i, v) => apply(opFront(tree, node.id, { ...fr, hs: drawerSetHeight(hs, fr.hs, i, v, fr.pull || 'all') }))
        const setSys = patchS => setF('sys', { ...(curOf('sys') || {}), ...patchS })
        return <>
          <Grid cols={2}>
            <NumField label="Сколько" unit="шт" value={fr.n} onChange={v => v >= 1 && apply(opFront(tree, node.id, { ...fr, n: Math.min(10, Math.round(v)), hs: (fr.hs || []).slice(0, Math.round(v)) }))} min={1} />
            <NumField label="Зазор между фасадами" value={g} onChange={v => apply(opFront(tree, node.id, { ...fr, gap: v }))} min={0} />
          </Grid>
          <div style={{ ...lbl, marginBottom: 4 }}>Высоты фасадов (сверху вниз) — заданные 📌, остальные делят остаток поровну; можно менять и на модели</div>
          <Chips label="Поменял высоту ящика — подстраиваются" value={fr.pull || 'all'} onChange={v => apply(opFront(tree, node.id, { ...fr, pull: v }))} options={[['all', 'все незаданные'], ['up', 'только верхние ↑'], ['down', 'только нижние ↓']]} />
          {hs.map((h, i) => i).reverse().map(i => <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4, fontSize: 13 }}>
            <span style={{ width: 92 }}>{i === fr.n - 1 ? 'Верхний' : i === 0 ? 'Нижний' : `${i + 1}-й снизу`}</span>
            <SmallNum width={70} value={Math.round(hs[i] * 10) / 10} onChange={v => v >= 40 && setH(i, v)} />
            {fr.hs?.[i] != null ? <button type="button" style={{ ...chipS(true), padding: '2px 8px' }} onClick={() => setH(i, null)} title="Снова авто">📌 авто</button> : <span style={{ color: 'var(--text-hint)', fontSize: 11.5 }}>авто</span>}
          </div>)}
          <div style={sect}>Как ставятся фасады</div>
          <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: '0 0 6px' }}>Между фасадами ящиков — зазор {g} мм. К краю корпуса (боковина, дно, крышка) — перехлёст {r1(outerExt)} мм; к панели, за которой другой фасад, — до середины ({r1((num(p.t) || 16) / 2 - (num(p.gap) || 0) / 2)} мм); к панели без соседа — {r1(soloExt)} мм; под накладной крышкой — ниже крышки на зазор/2.</p>
          <FrontOverlap p={p} up={up} outerExt={outerExt} soloExt={soloExt} r1={r1} />
          <div style={sect}>Короб и направляющие</div>
          <div style={{ ...lbl, marginBottom: 4 }}>Какие ящики правим (можно несколько; ничего — все ящики блока)</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 8 }}>
            <button type="button" style={{ ...chipS(!sel.length), padding: '3px 9px' }} onClick={() => setSelDr([])}>Все</button>
            {Array.from({ length: fr.n }, (_, i) => i).reverse().map(i => <button key={i} type="button" style={{ ...chipS(sel.includes(i)), padding: '3px 9px' }}
              onClick={() => setSelDr(l => (l.includes(i) ? l.filter(x => x !== i) : [...l, i]))}>{i === fr.n - 1 ? 'Верхний' : i === 0 ? 'Нижний' : `${i + 1}-й`}{fr.per?.[i] ? ' •' : ''}</button>)}
            {sel.length > 0 && sel.some(i => fr.per?.[i]) && <button type="button" style={{ ...chipS(false), padding: '3px 9px' }} onClick={() => { const per = Array.from({ length: fr.n }, (_, k) => (sel.includes(k) ? null : fr.per?.[k] || null)); apply(opFront(tree, node.id, { ...fr, per })) }}>↺ как у всех</button>}
          </div>
          {sel.length > 0 && <p style={{ fontSize: 11.5, color: 'var(--text-hint)', margin: '-4px 0 8px' }}>Меняется только у выбранных ящиков (•). «Все» — для всего блока, свои настройки ящиков по этому пункту сбрасываются.</p>}
          <label style={{ display: 'block', marginBottom: 8 }}><span style={lbl}>Система</span>
            <select style={inp} value={sysId} onChange={e => { if (!sel.length) apply(opFront(tree, node.id, { ...fr, box: e.target.value, sys: undefined, per: (fr.per || []).map(o => { if (!o) return o; const r = { ...o }; delete r.box; delete r.sys; return Object.keys(r).length ? r : null }) })); else setF('box', e.target.value) }}>{DRAWER_SYSTEMS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></label>
          <Grid cols={2}>
            <label style={{ display: 'block', minWidth: 0 }}><span style={lbl}>Направляющие (ряд системы), мм</span>
              <select style={inp} value={curOf('slideLen') === 'auto' ? 'auto' : String(slideLength(sys.lens, curOf('slideLen') ?? p.slideLen, num(p.D) - 25).len)} onChange={e => setF('slideLen', e.target.value === 'auto' ? 'auto' : Number(e.target.value))}>
                <option value="auto">авто — самые длинные по глубине</option>
                {(sys.lens || []).map(l => <option key={l} value={l} disabled={l > num(p.D) - 25}>{l}{l > num(p.D) - 25 ? ' (не помещается)' : ''}</option>)}
              </select></label>
            {sys.type === 'ball' && <NumField label="Зазор на направляющую" value={curOf('slideGap') ?? p.slideGap} onChange={v => setF('slideGap', v)} min={0} />}
            {sys.type === 'under' && <NumField label="Короб уже проёма с каждой стороны" value={sys.side} onChange={v => setSys({ side: v })} min={0} />}
            {sys.type === 'under' && <NumField label="Дно выше низа боковин" value={sys.bottomUp} onChange={v => setSys({ bottomUp: v })} min={0} />}
            {sysId === 'metal' && <NumField label="Дно и задняя уже проёма на" value={curOf('sys')?.reduce ?? p.metalReduce} onChange={v => setSys({ reduce: v })} min={0} />}
            {sys.type === 'msys' && <><NumField label="Дно уже проёма на" value={sys.bottomRed} onChange={v => setSys({ bottomRed: v })} min={0} />
              <NumField label="Задняя уже проёма на" value={sys.backRed} onChange={v => setSys({ backRed: v })} min={0} />
              <NumField label="Высота боковины" value={sys.sideH} onChange={v => setSys({ sideH: v })} min={30} />
              <NumField label="Дно короче направляющей на" value={sys.lenRed} onChange={v => setSys({ lenRed: v })} min={0} /></>}
            <NumField label="Короб от низа фасада" value={curOf('boxBottom') ?? 15} onChange={v => setF('boxBottom', v)} min={0} />
            <NumField label="Короб от верха фасада" value={curOf('boxTop') ?? Math.max(0, (num(p.boxTopGap) ?? 40) - 15)} onChange={v => setF('boxTop', v)} min={0} />
          </Grid>
          {(sys.type === 'msys' || sysId === 'metal') && <Chips label="Цвет боковин" value={fr.sideColor || 'white'} onChange={v => apply(opFront(tree, node.id, { ...fr, sideColor: v }))} options={[['white', 'Белый'], ['grey', 'Серый'], ['anthracite', 'Антрацит'], ['steel', 'Нержавейка']]} />}
          {(sys.type === 'ball' || sys.type === 'under') && <label style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}><input type="checkbox" style={{ width: 'auto', margin: 0 }} checked={fr.falseFront !== false} onChange={e => apply(opFront(tree, node.id, { ...fr, falseFront: e.target.checked }))} />Фальшпанель (передняя стенка короба)</label>}
          {fr.falseFront === false && <p style={{ fontSize: 11.5, color: 'var(--text-hint)', margin: '-2px 0 8px' }}>Без фальшпанели боковины короба идут до фасада, фасад — передняя стенка; паз под дно делается и в фасаде (с изнанки).</p>}
          {sys.type === 'ball' && <>
            <Chips label="Направляющая по высоте короба" value={curOf('slidePos') === 'center' ? 'center' : 'bottom'} onChange={v => setF('slidePos', v)} options={[['bottom', 'Снизу с отступом'], ['center', 'По центру']]} />
            {curOf('slidePos') !== 'center' && <Grid cols={2}><NumField label="От низа короба" value={curOf('slideOff') ?? 3} onChange={v => setF('slideOff', v)} min={0} /></Grid>}
          </>}
          {sys.type !== 'ball' && <p style={{ fontSize: 11.5, color: 'var(--text-hint)', margin: '-4px 0 8px' }}>Размеры системы — типовые; сверьте с каталогом производителя (Blum, Hettich, DTC, GTV) и поправьте здесь.</p>}
          <Chips label="Фрезеровка фасадов (МДФ)" value={fr.style || p.facadeStyle || 'flat'} onChange={v => apply(opFront(tree, node.id, { ...fr, style: v }))} options={FACADE_STYLES} />
          <HandleEditor h={{ ...p.handleDrawer, ...(fr.handle || {}) }} onChange={h => apply(opFront(tree, node.id, { ...fr, handle: h }))} />
          <div style={row}>
            {fr.handle && <button type="button" style={btnS()} onClick={() => apply(opFront(tree, node.id, { ...fr, handle: undefined }))}>↺ Ручка как в корпусе</button>}
            <button type="button" style={btnS()} onClick={() => up({ handleDrawer: { ...p.handleDrawer, ...(fr.handle || {}) } })} title="Новые ящики получат эту ручку; запоминается за аккаунтом">Сделать основной для ящиков</button>
          </div>
          <div style={sect}>Крепёж</div>
          <MountEditor mount={mount} setMount={setMount} only={['slide', 'dfront', 'handle']} />
        </>
      })()}

      <div style={{ ...sect, marginTop: 4 }}>Заменить на</div>
      <div style={row}>
        {blk.t === 'split' && <button type="button" style={chipS(false)} onClick={() => replace(isH ? 'v' : 'h')}>{isH ? '│ Вертикальные' : '─ Горизонтальные'}</button>}
        {!(blk.t === 'front' && fr?.type === 'drawers') && blk.t !== 'rod' && <button type="button" style={chipS(false)} onClick={() => replace('drawers', blk.t === 'split' ? ch.length - 1 : 3)}>☰ Ящики</button>}
        {!(blk.t === 'front' && fr?.type === 'doors') && blk.t !== 'fpanel' && blk.t !== 'rod' && <button type="button" style={chipS(false)} onClick={() => replace('doors', 1)}>▯ Дверь</button>}
        {!(blk.t === 'front' && fr?.type === 'doors') && blk.t !== 'fpanel' && blk.t !== 'rod' && <button type="button" style={chipS(false)} onClick={() => replace('doors', 2)}>▯▯ 2 двери</button>}
        {blk.t === 'front' && <button type="button" style={chipS(false)} onClick={() => { apply(opReplace(opFront(tree, node.id, null), node.id, 'h', fr?.type === 'drawers' ? Math.max(1, fr.n - 1) : 2)); setBlk({ n: node.id, t: 'split' }) }}>─ Полки</button>}
        <button type="button" style={{ ...chipS(false), color: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={() => {
          if (!window.confirm('Убрать этот блок?')) return
          if (blk.t === 'split') { if (ch.some(c => c.split || c.front || c.fpanel) && !window.confirm('Внутри есть наполнение — оно тоже пропадёт. Убрать?')) return; apply(opReplace(tree, node.id, null)) }
          else if (blk.t === 'rod') patch(n => { n.rod = null })
          else apply(opReplace(tree, node.id, blk.t === 'fpanel' ? 'fpanel-off' : 'front-off'))
          setBlk(null)
        }}>🗑 Убрать блок</button>
      </div>
    </div>
  )
}

// ── редактор корпуса ──
// ── сворачиваемые разделы карточки: что свернуто / развёрнуто — запоминается за аккаунтом (настройка cadFold) ──
const FoldCtx = createContext({ isOpen: (id, def) => def, toggle: () => {} })
function Fold({ id, title, def = false, on, onToggle, right, children }) {
  const { isOpen, toggle } = useContext(FoldCtx)
  const open = isOpen(id, def)
  const enabled = on === undefined || on
  return (
    <div style={{ borderTop: '0.5px solid var(--border)', padding: '7px 0 4px', marginTop: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        {on !== undefined && <input type="checkbox" style={{ width: 'auto', margin: 0 }} checked={!!on} onChange={e => { onToggle?.(e.target.checked); if (e.target.checked && !open) toggle(id, true) }} />}
        <button type="button" onClick={() => toggle(id, !open)} style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6, border: 'none', background: 'none', padding: 0, cursor: 'pointer', color: 'var(--text)', textAlign: 'left', minWidth: 0 }}>
          <span style={{ fontSize: 13.5, fontWeight: 600, color: enabled ? 'var(--text)' : 'var(--text-hint)' }}>{title}</span>
          {right && <span style={{ fontSize: 11.5, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>· {right}</span>}
          <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: 12 }}>{open ? '▾' : '▸'}</span>
        </button>
      </div>
      {open && enabled && <div style={{ paddingTop: 6 }}>{children}</div>}
    </div>
  )
}

// ── карточка корпуса: по порядку постройки — тип, габарит, каркас, задняя стенка, затем галочки: вертикальные панели,
// полки, фасады, ящики (включил — сразу вопросы по делу), кромка, «применить к корпусам этого типа» ──
const Check = ({ on, onChange, children }) => (
  <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 14, fontWeight: 600, margin: '14px 0 6px', cursor: 'pointer' }}>
    <input type="checkbox" style={{ width: 'auto', margin: 0 }} checked={on} onChange={e => onChange(e.target.checked)} />{children}
  </label>
)
const Sub = ({ children }) => <div style={{ borderLeft: '2px solid var(--blue-light, #dbe7fb)', paddingLeft: 9, marginLeft: 6 }}>{children}</div>

function CabinetEditor({ it, set, selOpening, setSelOpening, sameKind, onApplyKind, mount, setMount }) {
  const p = { ...CAB_DEFAULTS, ...it.p }
  const up = patch => set({ ...it, p: { ...p, ...patch } })
  const tree = treeOf(p)
  const setTree = t => set({ ...it, p: { ...p, tree: t } })
  const ops = useMemo(() => cabinetParts(p).openings || [], [it.p]) // eslint-disable-line react-hooks/exhaustive-deps
  const opOf = id => ops.find(o => o.id === id)
  const sections = tree.split === 'v' ? tree.children : [tree]
  const hasV = tree.split === 'v' && tree.children?.length > 1
  const hasH = sections.some(s => s.split === 'h' && s.children?.length > 1)
  const shelfK = hasH ? Math.max(...sections.map(s => (s.split === 'h' ? s.children.length - 1 : 0))) : 2
  const shelfNode = sections.find(s => s.split === 'h') || {}
  const allNodes = []; (function w(n) { allNodes.push(n); (n.children || []).forEach(w) })(tree)
  const doorNodes = allNodes.filter(n => n.front?.type === 'doors')
  const drawerNode = allNodes.find(n => n.front?.type === 'drawers')
  const rootDoors = tree.front?.type === 'doors' ? tree.front : null
  const leafs = allNodes.filter(n => !(n.split && n.children?.length))
  const [groups, setGroups] = useState({ body: true, back: true, fronts: true, boxes: true })
  const t = num(p.t) || 16, gap = num(p.gap) || 0, off = num(p.frontOffset) || 0
  const outerExt = p.frontMode === 'half' ? t / 2 - gap / 2 : t - off
  const soloExt = p.soloOverlap != null && p.soloOverlap !== '' ? num(p.soloOverlap) : outerExt
  const r1 = v => Math.round(v * 10) / 10

  // вертикальные панели: N на весь корпус (содержимое первых секций сохраняется)
  const setV = n => {
    const T = JSON.parse(JSON.stringify(tree))
    if (n <= 0) {
      if (T.split !== 'v') return
      const first = T.children[0] || {}
      setTree({ ...first, id: 'root', size: null, front: T.front || first.front || null })
      return
    }
    const old = T.split === 'v' ? T.children : [{ ...T, id: undefined, front: null, size: null }]
    T.split = 'v'
    T.children = Array.from({ length: n + 1 }, (_, i) => ({ ...(old[i] || {}), id: old[i]?.id || 'n' + Math.random().toString(36).slice(2, 8), size: null, split: old[i]?.split || null, children: old[i]?.children || [], front: old[i]?.front || null }))
    setTree(T)
  }
  // полки: K в каждой секции, отступы спереди/сзади, неподвижные или съёмные
  const setH = (k, patch = {}) => {
    const T = JSON.parse(JSON.stringify(tree))
    const secs = T.split === 'v' ? T.children : [T]
    for (const s of secs) {
      if (k <= 0) { if (s.split === 'h') { s.split = null; s.children = [] } continue }
      if (s.split !== 'h' || s.children.length !== k + 1) {
        s.split = 'h'; s.children = Array.from({ length: k + 1 }, (_, i) => ({ id: s.id + '_' + i + Math.random().toString(36).slice(2, 5), size: null, split: null, children: [], front: null, shelfType: 'fixed' }))
        if (s.front?.type === 'drawers') s.front = null
      }
      Object.assign(s, patch)
    }
    setTree(T)
  }
  // ящики в проём, который закрыт дверями внешнего проёма (двери на весь корпус), — эти двери убираем (ставятся потом на нужные проёмы)
  const putDrawers = (T, id, front) => {
    const path = []; (function w(n, acc) { if (n.id === id) { path.push(...acc); return true } return (n.children || []).some(c => w(c, [...acc, n])) })(T, [])
    const cover = path.filter(n => n.front)
    if (cover.length) {
      if (!window.confirm('Этот проём закрыт дверями на весь корпус. Убрать эти двери? Двери потом поставите на нужные проёмы на модели.')) return
      let T2 = T
      for (const c of cover) T2 = opFront(T2, c.id, null)
      T = T2
    }
    setTree(opFront(T, id, front))
  }
  const clearFronts = type => { const T = JSON.parse(JSON.stringify(tree)); (function w(n) { if (n.front?.type === type) n.front = null; (n.children || []).forEach(w) })(T); return T }

  return (<>
    <Fold id="kind" title="Тип корпуса" def>
      <Chips value={p.kind || 'other'} onChange={v => up({ kind: v })} options={CAB_KINDS}
        hint="Тип нужен, чтобы менять сразу все корпуса одного типа: например, все верхние модули кухни — задняя стенка в паз." />
    </Fold>
    <Fold id="tpl" title="Шаблоны">
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 6 }}>
        {CAB_PRESETS.map(([k, tt, v]) => <button key={k} type="button" style={chipS(false)}
          onClick={() => { if (window.confirm(`Заменить параметры корпуса шаблоном «${tt}»?`)) set({ ...it, name: tt, p: { ...CAB_DEFAULTS, ...Object.fromEntries(CAB_REMEMBER.map(k => [k, p[k]])), ...v } }) }}>{tt}</button>)}
      </div>
    </Fold>
    <Fold id="size" title="Габарит" def right={`${p.W}×${p.H}×${p.D}`}>
      <Grid><NumField label="Ширина" value={p.W} onChange={v => up({ W: v })} min={50} /><NumField label="Высота" value={p.H} onChange={v => up({ H: v })} min={50} /><NumField label="Глубина" value={p.D} onChange={v => up({ D: v })} min={50} /></Grid>
    </Fold>

    <Fold id="mats" title="Материалы" def right={`${p.material} / ${p.facadeMaterial}`}>
      <Grid cols={2}><TextField label="Корпус (весь)" value={p.material} onChange={v => up({ material: v })} list="cad-mats" /><TextField label="Фасады (все)" value={p.facadeMaterial} onChange={v => up({ facadeMaterial: v })} list="cad-mats" /></Grid>
      {/* кромка разом: весь каркас (передние торцы и прочее) или все фасады */}
      <Chips label="Кромка каркаса (вся)" value={String(p.edgeFront || '') === String(p.edgeBody || '') ? String(p.edgeFront || '') : '~'} onChange={v => up({ edgeFront: v, edgeBody: v })} options={[['0,4', '0,4'], ['1', '1'], ['2', '2'], ['', 'без кромки']]} />
      <Chips label="Кромка фасадов (вся)" value={String(p.edgeFacade || '')} onChange={v => up({ edgeFacade: v })} options={[['0,4', '0,4'], ['1', '1'], ['2', '2'], ['', 'без кромки']]} />
      <Chips label="Фрезеровка фасадов (по умолчанию для всех)" value={p.facadeStyle || 'flat'} onChange={v => up({ facadeStyle: v })} options={FACADE_STYLES} />
      {Object.keys(it.mat || {}).length > 0 && <button type="button" style={{ ...btnS(), marginBottom: 6 }} onClick={() => set({ ...it, p, mat: {} })}>↺ Убрать свои материалы у отдельных деталей ({Object.keys(it.mat).length})</button>}
    </Fold>
    <Fold id="body" title="Каркас" def right={p.material}>
      <Grid cols={2}><TextField label="Материал" value={p.material} onChange={v => up({ material: v })} list="cad-mats" /><NumField label="Толщина" value={p.t} onChange={v => up({ t: v })} min={1} /></Grid>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', margin: '4px 0 6px' }}>
        <label style={{ fontSize: 13.5, display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" style={{ width: 'auto', margin: 0 }} checked={p.sideL !== false} onChange={e => up({ sideL: e.target.checked })} />Боковина левая</label>
        <label style={{ fontSize: 13.5, display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" style={{ width: 'auto', margin: 0 }} checked={p.sideR !== false} onChange={e => up({ sideR: e.target.checked })} />Боковина правая</label>
      </div>
      {(p.sideL !== false || p.sideR !== false) && <Sub><Grid cols={2}><NumField label="Боковины: отступ спереди" value={p.sideFront} onChange={v => up({ sideFront: v })} /><NumField label="отступ сзади" value={p.sideBack} onChange={v => up({ sideBack: v })} /></Grid></Sub>}
    </Fold>

    <Fold id="top" title="Крышка" def on={p.top !== 'none'} onToggle={on => up(on ? { top: p.topLast && p.topLast !== 'none' ? p.topLast : 'inset' } : { top: 'none', topLast: p.top })}
      right={{ inset: 'вкладная', overlay: 'накладная', rails: 'царги' }[p.top] || ''}>
      <Chips value={p.top} onChange={v => up({ top: v })} options={[['inset', 'Вкладная'], ['overlay', 'Накладная'], ['rails', 'Царги (планки)']]}
        hint="Вкладная — между боковинами, её можно опустить и отступить спереди/сзади (минус — выступает). Накладная — сверху на боковинах, со свесом. Царги — 1 (передняя) или 2 планки с отступом от верха: например, сверху ляжет стекло." />
      {p.top === 'overlay' && <Sub>
        <Grid><NumField label="Свес вперёд" value={p.overhangFront} onChange={v => up({ overhangFront: v })} min={0} /><NumField label="Свес слева" value={p.overhangL ?? p.overhangSide} onChange={v => up({ overhangL: v })} min={0} /><NumField label="Свес справа" value={p.overhangR ?? p.overhangSide} onChange={v => up({ overhangR: v })} min={0} /></Grid>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 6, fontSize: 13 }}>
          <label style={{ display: 'flex', gap: 5, alignItems: 'center' }}><input type="checkbox" style={{ width: 'auto', margin: 0 }} checked={num(p.topRL) > 0} onChange={e => up({ topRL: e.target.checked ? 50 : 0 })} />Скруглить левый угол</label>
          {num(p.topRL) > 0 && <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>R<SmallNum width={56} value={p.topRL} onChange={v => v > 0 && up({ topRL: v })} /></span>}
          <label style={{ display: 'flex', gap: 5, alignItems: 'center' }}><input type="checkbox" style={{ width: 'auto', margin: 0 }} checked={num(p.topRR) > 0} onChange={e => up({ topRR: e.target.checked ? 50 : 0 })} />правый угол</label>
          {num(p.topRR) > 0 && <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>R<SmallNum width={56} value={p.topRR} onChange={v => v > 0 && up({ topRR: v })} /></span>}
        </div>
        <label style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}><input type="checkbox" style={{ width: 'auto', margin: 0 }} checked={p.underTop !== false} onChange={e => up({ underTop: e.target.checked })} />Фасады под крышкой (свес — от фасадов)</label>
      </Sub>}
      {p.top === 'inset' && <Sub><Grid><NumField label="Отступ от верха" value={p.topDown} onChange={v => up({ topDown: v })} /><NumField label="от переда" value={p.topFront} onChange={v => up({ topFront: v })} /><NumField label="от зада" value={p.topBack} onChange={v => up({ topBack: v })} /></Grid></Sub>}
      {p.top === 'rails' && <Sub>
        <Chips label="Царг" value={num(p.topRails) >= 2 ? 2 : 1} onChange={v => up({ topRails: v })} options={[[1, '1 — передняя'], [2, '2 — передняя и задняя']]} />
        <Grid cols={2}><NumField label="Отступ от верха" value={p.topRailOffset} onChange={v => up({ topRailOffset: v })} min={0} /><NumField label="Ширина планки" value={p.railDepth} onChange={v => up({ railDepth: v })} min={20} /></Grid>
      </Sub>}
    </Fold>

    <Fold id="bottom" title="Дно" def on={p.bottom !== 'none'} onToggle={on => up(on ? { bottom: p.bottomLast && p.bottomLast !== 'none' ? p.bottomLast : 'inset' } : { bottom: 'none', bottomLast: p.bottom })}
      right={{ inset: 'вкладное', overlay: 'накладное', rails: 'царги' }[p.bottom] || ''}>
      <Chips value={p.bottom} onChange={v => up({ bottom: v })} options={[['inset', 'Вкладное'], ['overlay', 'Накладное'], ['rails', 'Царги (планки)']]} />
      {p.bottom === 'inset' && <Sub><Grid><NumField label="Отступ от низа" value={p.bottomUp} onChange={v => up({ bottomUp: v })} /><NumField label="от переда" value={p.bottomFront} onChange={v => up({ bottomFront: v })} /><NumField label="от зада" value={p.bottomBack} onChange={v => up({ bottomBack: v })} /></Grid></Sub>}
      {p.bottom === 'rails' && <Sub>
        <Chips label="Царг" value={num(p.bottomRails) >= 2 ? 2 : 1} onChange={v => up({ bottomRails: v })} options={[[1, '1 — передняя'], [2, '2 — передняя и задняя']]} />
        <Grid cols={2}><NumField label="Отступ от низа" value={p.bottomRailOffset} onChange={v => up({ bottomRailOffset: v })} min={0} /><NumField label="Ширина планки" value={p.bottomRailDepth ?? p.railDepth} onChange={v => up({ bottomRailDepth: v })} min={20} /></Grid>
      </Sub>}
    </Fold>

    <Fold id="base" title="Опора" right={{ none: 'нет', legs: `ножки ${p.legH}`, plinth: `цоколь ${p.plinthH}` }[p.base] || ''}>
      <Chips value={p.base} onChange={v => up({ base: v })} options={[['none', 'Без опоры'], ['legs', 'Ножки'], ['plinth', 'Цоколь (царги)']]}
        hint="Цоколь: при вкладном дне боковины идут до пола, под дном — передняя царга с отступом от фасада; задняя царга — по галочке, с отступом от зада." />
      {p.base === 'legs' && <Sub><Grid><NumField label="Высота ножек" value={p.legH} onChange={v => up({ legH: v })} min={0} /></Grid></Sub>}
      {p.base === 'plinth' && <Sub>
        <Grid cols={2}><NumField label="Высота цоколя" value={p.plinthH} onChange={v => up({ plinthH: v })} min={0} /><NumField label="Передняя царга: отступ от переда" value={p.plinthInset} onChange={v => up({ plinthInset: v })} min={0} /></Grid>
        <label style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}><input type="checkbox" style={{ width: 'auto', margin: 0 }} checked={!!(p.plinthBack ?? p.bottom === 'overlay')} onChange={e => up({ plinthBack: e.target.checked })} />Задняя царга</label>
        {!!(p.plinthBack ?? p.bottom === 'overlay') && <Grid><NumField label="Отступ от зада" value={p.plinthBackOffset} onChange={v => up({ plinthBackOffset: v })} min={0} /></Grid>}
      </Sub>}
    </Fold>

    <Fold id="back2" title="Задняя стенка" def on={p.back !== 'none'} onToggle={on => up(on ? { back: p.backLast && p.backLast !== 'none' ? p.backLast : 'groove' } : { back: 'none', backLast: p.back })}
      right={{ groove: 'в паз', overlay: 'накладная', inset: 'вкладная' }[p.back] || ''}>
      <Chips label="Как ставится" value={p.back} onChange={v => up({ back: v })} options={[['groove', 'В паз'], ['overlay', 'Накладная'], ['inset', 'Вкладная ЛДСП']]}
        hint="Нет боковины, но есть крайняя вертикальная панель — задняя стенка идёт до неё (панель становится на всю глубину и получает паз)." />
      {(p.back === 'groove' || p.back === 'overlay') && <Sub>
        <Grid cols={2}><TextField label="Материал" value={p.backMaterial} onChange={v => up({ backMaterial: v })} list="cad-mats" /><NumField label="Толщина" value={p.backT} onChange={v => up({ backT: v })} min={1} /></Grid>
        {p.back === 'groove' && <Grid><NumField label="Паз от зад. торца" value={p.grooveOffset} onChange={v => up({ grooveOffset: v })} min={0} /><NumField label="Глубина паза" value={p.grooveDepth} onChange={v => up({ grooveDepth: v })} min={1} /><NumField label="Ширина паза" value={p.grooveWidth} onChange={v => up({ grooveWidth: v })} min={1} /></Grid>}
        <div style={{ ...lbl, marginTop: 2 }}>{p.back === 'groove' ? 'Зазор в пазу (стенка меньше — входит свободно)' : 'Отступ от краёв корпуса'}</div>
        <Grid cols={4}>{[['backGapL', 'слева'], ['backGapR', 'справа'], ['backGapB', 'снизу'], ['backGapT', 'сверху']].map(([k, tt]) => <NumField key={k} label={tt} value={p[k] ?? 1} onChange={v => up({ [k]: v })} />)}</Grid>
      </Sub>}
    </Fold>

    <Check on={hasV} onChange={on => { if (!on && !window.confirm('Убрать вертикальные панели? Останется содержимое первой секции.')) return; setV(on ? 1 : 0) }}>Вертикальные панели</Check>
    {hasV && <Sub>
      <Grid><NumField label="Сколько" unit="шт" value={tree.children.length - 1} onChange={v => setV(Math.max(1, Math.min(20, Math.round(v))))} min={1} /></Grid>
      <p style={{ fontSize: 11.5, color: 'var(--text-hint)', margin: '0 0 6px' }}>Делят корпус поровну; ширину секции меняйте на модели — нажмите её размер ↔.</p>
    </Sub>}

    <Check on={hasH} onChange={on => setH(on ? 2 : 0)}>Полки (горизонтальные панели)</Check>
    {hasH && <Sub>
      <Grid><NumField label={hasV ? 'В каждой секции' : 'Сколько'} unit="шт" value={shelfK} onChange={v => setH(Math.max(1, Math.min(20, Math.round(v))))} min={1} />
        <NumField label="Отступ от переда" value={shelfNode.setFront ?? p.shelfSetback} onChange={v => setH(shelfK, { setFront: v })} min={0} />
        <NumField label="Отступ от зада" value={shelfNode.setBack ?? 0} onChange={v => setH(shelfK, { setBack: v })} min={0} /></Grid>
      <Chips value={shelfNode.shelfType || 'fixed'} onChange={v => setH(shelfK, { shelfType: v })} options={[['fixed', 'Неподвижные (конфирмат)'], ['loose', 'Съёмные (полкодержатели)']]} />
      <Chips label="Форма" value={shelfNode.shelfShape || 'rect'} onChange={v => setH(shelfK, { shelfShape: v, shelfR: shelfNode.shelfR || 150 })} options={[['rect', 'Прямые'], ['round', 'Скруглённые']]}
        hint="Скруглённые — передний угол со свободной стороны (где нет боковины) — радиусом R; свободной стороны нет — оба передних угла. Например, торцевой шкаф: правой боковины нет, вертикальная панель в 300 мм от края, в проёме фронтальная панель у зада и скруглённые открытые полки." />
      {shelfNode.shelfShape === 'round' && <Grid><NumField label="Радиус" value={shelfNode.shelfR || 150} onChange={v => setH(shelfK, { shelfR: v })} min={1} /></Grid>}
    </Sub>}

    <Check on={doorNodes.length > 0} onChange={on => {
      if (on) setTree(opFront(tree, 'root', { type: 'doors', n: num(p.W) > 600 ? 2 : 1, layout: 'v', open: 'left' }))
      else if (window.confirm('Убрать все двери?')) setTree(clearFronts('doors'))
    }}>Фасады (двери)</Check>
    {doorNodes.length > 0 && <Sub>
      {rootDoors ? <>
        <Grid><NumField label="Сколько" unit="шт" value={rootDoors.n} onChange={v => setTree(opFront(tree, 'root', { ...rootDoors, n: Math.max(1, Math.min(6, Math.round(v))) }))} min={1} /></Grid>
        <Chips label="Расположение" value={rootDoors.layout || 'v'} onChange={v => setTree(opFront(tree, 'root', { ...rootDoors, layout: v }))} options={[['v', 'Рядом (вертикально)'], ['h', 'Друг над другом']]} />
        {(rootDoors.n === 1 || rootDoors.layout === 'h') && <Chips label="Открывание" value={rootDoors.open || 'left'} onChange={v => setTree(opFront(tree, 'root', { ...rootDoors, open: v, hinge: v }))} options={[['left', '← влево'], ['right', 'вправо →'], ['up', '↑ вверх'], ['down', '↓ вниз']]} />}
        {rootDoors.n > 1 && rootDoors.layout !== 'h' && <p style={{ fontSize: 11.5, color: 'var(--text-hint)', margin: '0 0 6px' }}>Левые двери открываются влево, правые — вправо.</p>}
      </> : <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 6px' }}>Двери стоят на проёмах ({doorNodes.length}) — сторону и количество меняйте на модели: нажмите проём.</p>}
      <Grid cols={2}><TextField label="Материал фасадов" value={p.facadeMaterial} onChange={v => up({ facadeMaterial: v })} list="cad-mats" /><NumField label="Толщина" value={p.facadeT} onChange={v => up({ facadeT: v })} min={1} /></Grid>
      <FrontOverlap p={p} up={up} outerExt={outerExt} soloExt={soloExt} r1={r1} />
      <div style={{ ...sect, marginTop: 6 }}>Петли<Hint inline>Чашка Ø35 в обратной пласти двери, планка — 2 отверстия Ø5 на стенке проёма. Всё пересчитывается сразу — видно на модели (⊙) и в присадке деталей.</Hint></div>
      <Grid><NumField label="Чашка от края двери" value={p.hingeCup} onChange={v => up({ hingeCup: v })} min={5} /><NumField label="Крайние от торца" value={p.hingeEnd} onChange={v => up({ hingeEnd: v })} min={20} /><NumField label="Планка от переда" value={p.plateFront} onChange={v => up({ plateFront: v })} min={5} /></Grid>
        <Chips label="Ответная планка" value={p.plateType || 'cross'} onChange={v => up({ plateType: v })} options={[['cross', 'Крестообразная (2 отв. по вертикали)'], ['straight', 'Прямая (2 отв. по глубине, шаг 32)']]} />
      <Grid><NumField label="Петель на дверь" unit={num(p.hingeCount) ? 'шт' : 'авто'} value={p.hingeCount || 0} onChange={v => up({ hingeCount: Math.max(0, Math.round(v)) })} min={0} /></Grid>
    </Sub>}

    <Check on={!!drawerNode} onChange={on => {
      if (on) { const target = leafs.find(n => !n.front) || leafs[0]; putDrawers(tree, target.id, { type: 'drawers', n: 3 }) }
      else setTree(clearFronts('drawers'))
    }}>Ящики</Check>
    {drawerNode && <Sub>
      <label style={{ display: 'block', marginBottom: 8 }}><span style={lbl}>В какой проём</span>
        <select style={inp} value={drawerNode.id} onChange={e => putDrawers(clearFronts('drawers'), e.target.value, { ...drawerNode.front })}>
          {leafs.map(n => { const o = opOf(n.id); return <option key={n.id} value={n.id}>{n.id === 'root' ? 'Весь корпус' : 'Проём'} {o ? `${o.w}×${o.h}` : ''}{n.front && n.id !== drawerNode.id ? ' (занят фасадом)' : ''}</option> })}
        </select></label>
      <Grid><NumField label="Сколько" unit="шт" value={drawerNode.front.n} onChange={v => setTree(opFront(tree, drawerNode.id, { ...drawerNode.front, n: Math.max(1, Math.min(10, Math.round(v))) }))} min={1} />
        <NumField label="Длина направл." value={p.slideLen} onChange={v => up({ slideLen: v })} min={150} /><NumField label="Зазор на направл." value={p.slideGap} onChange={v => up({ slideGap: v })} min={0} /></Grid>
      <Chips label="Короб" value={p.box} onChange={v => up({ box: v })} options={[['ldsp_overlay', 'ЛДСП, дно накладное'], ['ldsp_groove', 'ЛДСП, дно в паз'], ['metal', 'Металлобокс']]} />
      {p.box === 'metal'
        ? <Grid><NumField label="Дно уже проёма на" value={p.metalReduce} onChange={v => up({ metalReduce: v })} min={0} /></Grid>
        : <Grid><NumField label="Короб ниже фасада на" value={p.boxTopGap} onChange={v => up({ boxTopGap: v })} min={0} /><NumField label="Толщина дна" value={p.boxBottomT} onChange={v => up({ boxBottomT: v })} min={1} /><TextField label="Материал дна" value={p.boxBottomMaterial} onChange={v => up({ boxBottomMaterial: v })} list="cad-mats" /></Grid>}
      {!doorNodes.length && <><Grid cols={2}><TextField label="Материал фасадов" value={p.facadeMaterial} onChange={v => up({ facadeMaterial: v })} list="cad-mats" /><NumField label="Толщина" value={p.facadeT} onChange={v => up({ facadeT: v })} min={1} /></Grid>
        <FrontOverlap p={p} up={up} outerExt={outerExt} soloExt={soloExt} r1={r1} /></>}
    </Sub>}

    <details style={{ marginTop: 12 }}><summary style={{ ...sect, cursor: 'pointer', margin: 0 }}>Проёмы (список)</summary>
      <TreeEditor it={it} sel={selOpening} setSel={setSelOpening} /></details>

    <Fold id="mount" title="Крепёж фурнитуры" right="за аккаунтом">
      <MountEditor mount={mount} setMount={setMount} />
    </Fold>

    <div style={sect}>Кромка<Hint inline>Название вида кромки — как в бланке заказа (толщину и подрезку задаёте там). Каркас — передние торцы, фасады — по периметру.</Hint></div>
    <Grid><TextField label="Каркас спереди" value={p.edgeFront} onChange={v => up({ edgeFront: v })} /><TextField label="Фасады" value={p.edgeFacade} onChange={v => up({ edgeFacade: v })} /><TextField label="Прочее" value={p.edgeBody} onChange={v => up({ edgeBody: v })} /></Grid>

    {sameKind > 0 && <div className="card" style={{ padding: '8px 10px', marginTop: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Применить к другим корпусам «{(CAB_KINDS.find(k => k[0] === p.kind) || [0, 'Другое'])[1]}» ({sameKind})</div>
      {[['body', 'Каркас: материал, крышка, дно, опора, свесы'], ['back', 'Задняя стенка'], ['fronts', 'Фасады: материал, зазоры, перехлёст, петли'], ['boxes', 'Короба ящиков']].map(([k, tt]) =>
        <label key={k} style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center', marginBottom: 3 }}><input type="checkbox" style={{ width: 'auto', margin: 0 }} checked={!!groups[k]} onChange={e => setGroups(g => ({ ...g, [k]: e.target.checked }))} />{tt}</label>)}
      <button type="button" style={{ ...btnS(true), marginTop: 6 }} onClick={() => onApplyKind(Object.keys(groups).filter(k => groups[k]))}>Применить</button>
      <p style={{ fontSize: 11.5, color: 'var(--text-hint)', margin: '6px 0 0' }}>Размеры, проёмы и наполнение у каждого корпуса остаются свои.</p>
    </div>}
  </>)
}

function FrontOverlap({ p, up, outerExt, soloExt, r1 }) {
  return (<>
    <Chips label="Перехлёст на боковину, дно, крышку" value={p.frontMode} onChange={v => up({ frontMode: v })} options={[['full', 'Полностью, с отступом'], ['half', 'До середины торца']]} />
    <Grid>{p.frontMode !== 'half' && <NumField label="Отступ от края" value={p.frontOffset} onChange={v => up({ frontOffset: v })} min={0} />}<NumField label="Зазор между фасадами" value={p.gap} onChange={v => up({ gap: v })} min={0} />
      <NumField label="На панель без соседа" value={p.soloOverlap ?? ''} onChange={v => up({ soloOverlap: v })} min={0} /></Grid>
    <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: '0 0 6px' }}>Перехлёст сейчас: на боковину/дно/крышку — {r1(outerExt)} мм; на панель, за которой другой фасад, — до середины ({r1((num(p.t) || 16) / 2 - (num(p.gap) || 0) / 2)} мм, зазор {num(p.gap) || 0}); на панель без соседнего фасада — {r1(soloExt)} мм.</p>
  </>)
}

const ORIENTS = [[2, 'Фронтальная'], [0, 'Боковая'], [1, 'Горизонтальная']]
const AXN = ['X (ширина)', 'Y (высота)', 'Z (глубина)']
function PanelEditor({ it, set }) {
  const p = it.p
  const dims = [p.dx, p.dy, p.dz]
  const up = patch => set({ ...it, p: { ...p, ...patch } })
  const setOrient = ax => {
    if (ax === p.tAxis) return
    const d = [...dims]
    const t = d[p.tAxis]; d[p.tAxis] = d[ax]; d[ax] = t   // толщина переходит на новую ось
    const others = [0, 1, 2].filter(i => i !== ax)
    up({ dx: d[0], dy: d[1], dz: d[2], tAxis: ax, lAxis: others.includes(p.lAxis) ? p.lAxis : others[0] })
  }
  const setDim = (i, v) => { const d = [...dims]; d[i] = v; up({ dx: d[0], dy: d[1], dz: d[2] }) }
  return (<>
    <Chips label="Положение" value={p.tAxis} onChange={setOrient} options={ORIENTS} />
    <Grid>{[0, 1, 2].map(i => <NumField key={i} label={i === p.tAxis ? `Толщина (${'XYZ'[i]})` : AXN[i]} value={dims[i]} onChange={v => setDim(i, v)} min={0.1} />)}</Grid>
    <Grid cols={2}><TextField label="Материал" value={p.material} onChange={v => up({ material: v })} list="cad-mats" />
      {it.type === 'panel' && <TextField label="Кромка по периметру" value={p.edgeAll} onChange={v => up({ edgeAll: v })} />}</Grid>
    {it.type === 'panel' && <Chips label="Длина детали (текстура) вдоль" value={p.lAxis} onChange={v => up({ lAxis: v })}
      options={[0, 1, 2].filter(i => i !== p.tAxis).map(i => [i, 'XYZ'[i]])} />}
    {it.type === 'panel' && !p.edgeAll && Object.keys(p.edges || {}).length > 0 && <p style={{ fontSize: 11.5, color: 'var(--text-hint)', margin: '0 0 6px' }}>Кромка из корпуса: {Object.entries(p.edges).map(([k, v]) => `${k} — ${v}`).join(', ')}</p>}
    {it.type === 'panel' && (p.grooves || []).length > 0 && <p style={{ fontSize: 11.5, color: 'var(--text-hint)', margin: '0 0 6px' }}>Пазов: {p.grooves.length} (из корпуса)</p>}
  </>)
}
function ProfileEditor({ it, set }) {
  const p = it.p
  const up = patch => set({ ...it, p: { ...p, ...patch } })
  return (<>
    <Chips label="Направление" value={p.axis} onChange={v => up({ axis: v })} options={[[0, '← → по X'], [1, '↑ по Y'], [2, '↗ по Z']]} />
    <Grid><NumField label="Длина" value={p.len} onChange={v => up({ len: v })} min={1} /><NumField label="Сечение A" value={p.a} onChange={v => up({ a: v })} min={1} /><NumField label="Сечение B" value={p.b} onChange={v => up({ b: v })} min={1} /></Grid>
    <TextField label="Материал (профиль, труба, карниз)" value={p.material} onChange={v => up({ material: v })} list="cad-mats" />
  </>)
}

function FrameEditor({ it, set }) {
  const p = { ...FRAME_DEFAULTS, ...it.p }
  const up = patch => set({ ...it, p: { ...p, ...patch } })
  return (<>
    <div style={sect}>Шаблон</div>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 6 }}>
      {FRAME_PRESETS.map(([k, t, v]) => <button key={k} type="button" style={chipS(false)}
        onClick={() => { if (window.confirm(`Заменить параметры каркаса шаблоном «${t}»?`)) set({ ...it, name: t, p: { ...FRAME_DEFAULTS, ...v } }) }}>{t}</button>)}
    </div>
    <div style={sect}>Габарит</div>
    <Grid><NumField label="Ширина" value={p.W} onChange={v => up({ W: v })} min={100} /><NumField label="Высота" value={p.H} onChange={v => up({ H: v })} min={100} /><NumField label="Глубина" value={p.D} onChange={v => up({ D: v })} min={100} /></Grid>
    <div style={sect}>Профиль<Hint inline>Сечение A — по ширине и глубине каркаса, B — высота перемычки. Профиль раскраивается на хлысты во вкладке «Смета».</Hint></div>
    <Grid><NumField label="Сечение A" value={p.a} onChange={v => up({ a: v })} min={5} /><NumField label="Сечение B" value={p.b} onChange={v => up({ b: v })} min={5} /><TextField label="Материал" value={p.material} onChange={v => up({ material: v })} list="cad-mats" /></Grid>
    <Grid><NumField label="Уровней обвязки" unit="" value={p.levels} onChange={v => up({ levels: Math.max(2, Math.round(v)) })} min={2} /><NumField label="Нижняя от пола" value={p.foot} onChange={v => up({ foot: v })} min={0} /></Grid>
    <div style={sect}>Полки</div>
    <Chips value={p.shelf} onChange={v => up({ shelf: v, shelfT: v === 'glass' ? 6 : 16, shelfMaterial: v === 'glass' ? 'Стекло прозрачное 6 мм' : 'ЛДСП Белый 16' })} options={[['glass', 'Стекло'], ['sheet', 'ЛДСП'], ['none', 'Нет']]} />
    {p.shelf !== 'none' && <Grid><NumField label="Толщина" value={p.shelfT} onChange={v => up({ shelfT: v })} min={1} /><TextField label="Материал полок" value={p.shelfMaterial} onChange={v => up({ shelfMaterial: v })} list="cad-mats" />
      <label style={{ fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 5, alignSelf: 'end', paddingBottom: 8 }}><input type="checkbox" style={{ width: 'auto', margin: 0 }} checked={!!p.topShelf} onChange={e => up({ topShelf: e.target.checked })} />верхняя</label></Grid>}
    <div style={sect}>Стенки из стекла<Hint inline>Стекло ставится внутрь каркаса и крепится стеклодержателями (число — на одну стенку). Держатели идут в фурнитуру сметы.</Hint></div>
    <Chips value={p.walls} onChange={v => up({ walls: v })} options={[['none', 'Нет'], ['sides', 'Бока'], ['back', 'Задняя'], ['sides_back', 'Бока и задняя']]} />
    {p.walls !== 'none' && <Grid><NumField label="Толщина стекла" value={p.glassT} onChange={v => up({ glassT: v })} min={2} /><TextField label="Стекло" value={p.glassMaterial} onChange={v => up({ glassMaterial: v })} list="cad-mats" /><NumField label="Держателей на стенку" unit="" value={p.holders} onChange={v => up({ holders: Math.max(0, Math.round(v)) })} min={0} /></Grid>}
  </>)
}

// сдвиг кнопками: шаг 1 / 10 / 100 мм, по каждой оси ± (удобно пальцем на телефоне)
function Nudge({ it, set }) {
  const [step, setStep] = useState(10)
  const mv = (k, d) => set({ ...it, pos: { ...it.pos, [k]: Math.round(((it.pos?.[k] || 0) + d * step) * 10) / 10 } })
  const b = { ...btnS(), padding: '5px 0', width: 34, textAlign: 'center' }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 8 }}>
      {['x', 'y', 'z'].map(k => <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
        <button type="button" style={b} onClick={() => mv(k, -1)}>−</button><span style={{ fontSize: 12, width: 12, textAlign: 'center' }}>{k.toUpperCase()}</span><button type="button" style={b} onClick={() => mv(k, 1)}>+</button>
      </span>)}
      {[1, 10, 100].map(v => <button key={v} type="button" style={{ ...chipS(step === v), padding: '3px 8px' }} onClick={() => setStep(v)}>{v}</button>)}
    </div>
  )
}

function ItemEditor({ it, set, onDelete, onDuplicate, onExplode, onToLibrary, info, selOpening, setSelOpening, sameKind, onApplyKind, mount, setMount }) {
  return (
    <div>
      <Grid cols={1}><TextField label="Название" value={it.name} onChange={v => set({ ...it, name: v })} /></Grid>
      <Fold id="pos" title="Положение в сцене" right={`${it.pos?.x ?? 0}; ${it.pos?.y ?? 0}; ${it.pos?.z ?? 0}${it.rotY ? ` · ${it.rotY}°` : ''}`}>
        <p style={{ fontSize: 11.5, color: 'var(--text-hint)', margin: '0 0 6px' }}>X, Y, Z — левый нижний задний угол элемента. Поворот — вокруг вертикали.</p>
        <Grid>{['x', 'y', 'z'].map(k => <NumField key={k} label={k.toUpperCase()} value={it.pos?.[k] ?? 0} onChange={v => set({ ...it, pos: { ...it.pos, [k]: v } })} />)}</Grid>
        <Nudge it={it} set={set} />
        <Chips label="Поворот" value={it.rotY || 0} onChange={v => set({ ...it, rotY: v })} options={[[0, '0°'], [90, '90°'], [180, '180°'], [270, '270°']]} />
      </Fold>
      {info && <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '6px 0' }}>{info}</p>}
      {it.type === 'cabinet' && <CabinetEditor it={it} set={set} selOpening={selOpening} setSelOpening={setSelOpening} sameKind={sameKind} onApplyKind={onApplyKind} mount={mount} setMount={setMount} />}
      {it.type === 'frame' && <FrameEditor it={it} set={set} />}
      {(it.type === 'panel' || it.type === 'glass') && <PanelEditor it={it} set={set} />}
      {it.type === 'glass' && <>
        <Chips label="Крепление стекла" value={it.p.mount || 'none'} onChange={v => set({ ...it, p: { ...it.p, mount: v, mountQty: it.p.mountQty || (v === 'hinges' ? 2 : 4) } })}
          options={[['none', 'Нет'], ['holders', 'Стеклодержатели'], ['hinges', 'Петли (дверь)']]} />
        {it.p.mount && it.p.mount !== 'none' && <Grid><NumField label="Штук" unit="" value={it.p.mountQty} onChange={v => set({ ...it, p: { ...it.p, mountQty: Math.max(0, Math.round(v)) } })} min={0} /></Grid>}
      </>}
      {it.type === 'profile' && <ProfileEditor it={it} set={set} />}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 14 }}>
        <button type="button" style={btnS()} onClick={onDuplicate}>⧉ Копия</button>
        {onToLibrary && <button type="button" style={btnS()} onClick={onToLibrary} title="Сохранить элемент со всеми параметрами в свою библиотеку — потом ставить в любой проект">★ В библиотеку</button>}
        {it.type === 'cabinet' && <button type="button" style={btnS()} onClick={onExplode} title="Корпус станет набором свободных панелей — каждую можно двигать и менять отдельно">⇲ Разобрать на панели</button>}
        <button type="button" style={{ ...btnS(), color: 'var(--danger)' }} onClick={onDelete}>🗑 Удалить</button>
      </div>
    </div>
  )
}

const TYPE_ICON = { cabinet: '▦', panel: '▭', glass: '◇', profile: '┃', frame: '⌗' }
function SceneList({ project, setProject, parts, selected, onSelect, onAdd, library, onFromLibrary, onLibraryDelete }) {
  const counts = useMemo(() => { const m = new Map(); for (const p of parts) m.set(p.item.id, (m.get(p.item.id) || 0) + 1); return m }, [parts])
  return (<>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
      <button type="button" style={btnS(true)} onClick={() => onAdd('cabinet')}>+ Корпус</button>
      <button type="button" style={btnS()} onClick={() => onAdd('panel')}>+ Панель</button>
      <button type="button" style={btnS()} onClick={() => onAdd('glass')}>+ Стекло</button>
      <button type="button" style={btnS()} onClick={() => onAdd('frame')}>+ Каркас (металл)</button>
      <button type="button" style={btnS()} onClick={() => onAdd('profile')}>+ Профиль</button>
    </div>
    {library.length > 0 && <details style={{ marginBottom: 10 }}>
      <summary style={{ fontSize: 13, cursor: 'pointer', color: 'var(--blue)' }}>★ Моя библиотека ({library.length})</summary>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
        {library.map(l => <div key={l.id} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button type="button" style={{ ...btnS(), flex: 1, textAlign: 'left' }} onClick={() => onFromLibrary(l)}>+ {l.name}</button>
          <button type="button" style={{ ...btnS(), color: 'var(--danger)' }} onClick={() => onLibraryDelete(l.id)}>🗑</button>
        </div>)}
      </div>
    </details>}
    {!project.items.length && <p style={{ fontSize: 13, color: 'var(--text-hint)' }}>Сцена пустая. Добавьте корпус — шкаф, тумбу, комод — и задайте размеры, или поставьте свободную панель.</p>}
    {project.items.map(it => (
      <button key={it.id} type="button" onClick={() => onSelect(it.id)}
        style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '8px 10px', marginBottom: 4, borderRadius: 10, cursor: 'pointer',
          border: `1px solid ${selected === it.id ? 'var(--blue)' : 'var(--border)'}`, background: selected === it.id ? 'var(--blue-light, #e8f0fe)' : 'var(--bg)', color: 'var(--text)' }}>
        <span style={{ width: 20, textAlign: 'center', color: 'var(--text-muted)' }}>{TYPE_ICON[it.type] || '•'}</span>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 14 }}>{it.name}</span>
        <span style={{ fontSize: 11.5, color: 'var(--text-hint)' }}>{it.type === 'cabinet' || it.type === 'frame' ? `${it.p.W}×${it.p.H}×${it.p.D} · ${counts.get(it.id) || 0} дет.` : it.type === 'profile' ? `${it.p.len} мм` : `${[it.p.dx, it.p.dy, it.p.dz].join('×')}`}</span>
      </button>
    ))}
    <ProjectSettings project={project} setProject={setProject} />
  </>)
}

function ProjectSettings({ project, setProject }) {
  const st = { ...PROJECT_DEFAULTS, ...project.settings }
  const room = { ...PROJECT_DEFAULTS.room, ...(st.room || {}) }
  const setSt = patch => setProject({ ...project, settings: { ...st, ...patch } })
  return (<details style={{ marginTop: 14 }} open={false}>
    <summary style={{ ...sect, cursor: 'pointer', margin: '0 0 6px' }}>Настройки проекта и комната</summary>
    <Chips label="Крепёж на стыках плит" value={st.joint} onChange={v => setSt({ joint: v })} options={JOINTS}
      hint="Стыки находятся сами: торец детали упирается в пласть другой. Конфирмат — сквозное Ø7 в пласть и Ø5 в торец; шкант — Ø8×12 в пласть и Ø8×20 в торец. 50 мм от концов стыка, длинный стык — ещё посередине. Присадка уходит в детали заказа." />
    <label style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}><input type="checkbox" style={{ width: 'auto', margin: 0 }} checked={st.hardwareHoles !== false} onChange={e => setSt({ hardwareHoles: e.target.checked })} />Отверстия фурнитуры: петли (чашка Ø35 и планка), полкодержатели, направляющие</label>
    <label style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center', marginBottom: 10 }}><input type="checkbox" style={{ width: 'auto', margin: 0 }} checked={st.rotatable !== false} onChange={e => setSt({ rotatable: e.target.checked })} />Детали можно вращать при раскрое (без текстуры)</label>
    <label style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}><input type="checkbox" style={{ width: 'auto', margin: 0 }} checked={!!room.on} onChange={e => setSt({ room: { ...room, on: e.target.checked } })} />Комната: стены слева, сзади и справа</label>
    {room.on && <Grid><NumField label="Ширина комнаты" value={room.W} onChange={v => setSt({ room: { ...room, W: v } })} min={500} /><NumField label="Глубина" value={room.D} onChange={v => setSt({ room: { ...room, D: v } })} min={500} /><NumField label="Высота" value={room.H} onChange={v => setSt({ room: { ...room, H: v } })} min={500} /></Grid>}
  </details>)
}

const KIND_T = { sheet: 'Плита', glass: 'Стекло', profile: 'Погонные (профиль, металл)', edge: 'Кромка', hw: 'Фурнитура' }
function BarRow({ b, count = 1, maxLen }) {
  return (
    <div style={{ marginBottom: 5 }}>
      <div style={{ display: 'flex', height: 16, width: `${(b.stock / maxLen) * 100}%`, borderRadius: 3, overflow: 'hidden', background: 'var(--bg2)', border: '0.5px solid var(--border-md)' }}>
        {b.cuts.map((c, j) => { const len = typeof c === 'number' ? c : c.len; return <div key={j} title={`${len} мм`} style={{ width: `${(len / b.stock) * 100}%`, background: j % 2 ? '#9fb3c8' : '#b8c8d8', borderRight: '1px solid white', fontSize: 9.5, color: '#123', overflow: 'hidden', textAlign: 'center', lineHeight: '16px' }}>{len}</div> })}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Хлыст {b.stock}{count > 1 ? ` × ${count}` : ''}: {b.cuts.map(c => (typeof c === 'number' ? c : c.len)).join(' + ')} · остаток {b.rest} мм</div>
    </div>
  )
}

function SpecPanel({ project, setProject, onLinear }) {
  const spec = useMemo(() => projectSpec(project), [project])
  const st = { ...PROJECT_DEFAULTS, ...project.settings }
  const setSt = patch => setProject({ ...project, settings: { ...st, ...patch } })
  const setPrice = (name, v) => setSt({ prices: { ...(st.prices || {}), [name]: v } })
  const [openRow, setOpenRow] = useState('')
  const rows = spec.rows.map((r, i) => ({ ...r, head: i === 0 || spec.rows[i - 1].kind !== r.kind }))
  return (<>
    <Grid><NumField label="Хлыст по умолч." value={st.stockLen} onChange={v => setSt({ stockLen: v })} min={100} /><NumField label="Пропил" value={st.linearKerf} onChange={v => setSt({ linearKerf: v })} min={0} />
      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', alignSelf: 'end', paddingBottom: 6 }}>Деталей плиты: {spec.partsCount}<Hint inline>Погонные материалы (профиль, труба, карниз) раскраиваются на хлысты. У каждого материала можно указать свои длины хлыстов через запятую — например 2000, 3000, 6000: приложение само подберёт, какие хлысты брать, чтобы отходов было меньше. Цена профиля — за метр хлыста, плиты и стекла — за м², кромки — за метр, фурнитуры — за штуку.</Hint></div></Grid>
    {rows.map(r => {
      const head = r.head ? <div style={sect}>{KIND_T[r.kind]}</div> : null
      const key = r.kind + r.name
      return (<div key={key}>
        {head}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto 84px', gap: 6, alignItems: 'center', padding: '5px 0', borderBottom: '0.5px solid var(--border)' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
              {r.kind === 'sheet' || r.kind === 'glass' ? `${fmt(r.qty)} м² · ${r.count} дет.` : r.kind === 'profile' ? `${fmt(r.qty)} м · ${r.count} отр. · хлысты: ${r.nest.byStock.map(b => `${b.len}×${b.count}`).join(', ') || '—'} · отход ${r.nest.waste}%` : `${fmt(r.qty)} ${r.unit}`}
              {r.sum ? ` · ${fmt(r.sum)}` : ''}
              {r.kind === 'profile' && <button type="button" onClick={() => setOpenRow(openRow === key ? '' : key)} style={{ marginLeft: 6, border: 'none', background: 'none', color: 'var(--blue)', fontSize: 11.5, cursor: 'pointer', padding: 0 }}>{openRow === key ? 'скрыть' : 'раскрой хлыстов'}</button>}
            </div>
          </div>
          <span style={{ fontSize: 11, color: 'var(--text-hint)' }}>цена{r.kind === 'profile' ? '/м хлыста' : r.unit === 'шт' ? '/шт' : '/' + r.unit}</span>
          <input style={{ ...inp, padding: '5px 6px' }} inputMode="decimal" value={st.prices?.[r.name] ?? ''} placeholder="0"
            onChange={e => { const n = num(e.target.value); setPrice(r.name, e.target.value === '' ? undefined : n ?? st.prices?.[r.name]) }} />
        </div>
        {openRow === key && r.nest && <div style={{ padding: '6px 0 8px' }}>
          <Grid cols={2}><TextField label="Хлысты этого материала, мм (через запятую)" value={st.stocks?.[r.name] ?? ''} onChange={v => setSt({ stocks: { ...(st.stocks || {}), [r.name]: v } })} />
            {onLinear && <button type="button" style={{ ...btnS(), alignSelf: 'end' }} onClick={() => onLinear(r)}>Линейный раскрой →</button>}</Grid>
          {r.nest.bars.map((b, i) => <BarRow key={i} b={b} maxLen={Math.max(...r.nest.bars.map(x => x.stock))} />)}
          {r.nest.unplaced.length > 0 && <p className="error-text" style={{ fontSize: 12 }}>Длиннее хлыста: {r.nest.unplaced.map(u => `${u.len}×${u.qty}`).join(', ')} мм</p>}
        </div>}
      </div>)
    })}
    {!spec.rows.length && <p style={{ fontSize: 13, color: 'var(--text-hint)' }}>Пока нечего считать — добавьте элементы в сцену.</p>}
    {spec.total > 0 && <p style={{ fontSize: 15, fontWeight: 600, marginTop: 10 }}>Итого: {fmt(spec.total)}</p>}
    {spec.warn.map((w, i) => <p key={i} className="error-text" style={{ fontSize: 12 }}>⚠ {w}</p>)}
  </>)
}

function ToOrderDialog({ project, onClose, onGo }) {
  const groups = useMemo(() => sheetGroups(project), [project])
  useBackClose(true, onClose)
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={e => e.stopPropagation()} className="card" style={{ width: '100%', maxWidth: 420 }}>
        <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>Детали в заказ</h3>
        <p style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 10 }}>Заказ — на один материал. Выберите материал: его детали уйдут в бланк нового заказа (с кромкой, присадкой, пазами и 3D-моделью), остальное будет видно в 3D для понимания. Профиль и другие погонные материалы прикрепятся к заказу блоком «Погонные материалы» (линейный раскрой).</p>
        {groups.map(g => (
          <button key={g.key} type="button" onClick={() => onGo(g.key)} style={{ ...btnS(), width: '100%', textAlign: 'left', marginBottom: 6, display: 'flex', justifyContent: 'space-between' }}>
            <span>{g.material || 'Без названия'} · {g.thickness} мм</span><span style={{ color: 'var(--text-muted)' }}>{g.parts.length} дет.</span>
          </button>
        ))}
        {!groups.length && <p style={{ fontSize: 13 }}>В проекте нет деталей из плиты.</p>}
        <button type="button" className="btn-secondary" style={{ marginTop: 6 }} onClick={onClose}>Отмена</button>
      </div>
    </div>
  )
}

// ── главная страница ──
export default function ConstructorPage() {
  const { user, isMaster, setCabinet } = useAuth()
  const navigate = useNavigate()
  const { search } = useLocation()
  const pid = new URLSearchParams(search).get('p')
  const desk = useDesktop()
  const [allowed, setAllowed] = useState(isMaster ? true : null)
  const [list, setList] = useState(null)
  const [project, setProjectState] = useState(null)
  const [selected, setSelected] = useState(null)
  const [selPid, setSelPid] = useState(null)
  const [selOpening, setSelOpening] = useState(null) // выбранный проём корпуса
  const [selBlock, setSelBlock] = useState(null)     // выбранный параметрический блок (двойной тап по детали): { item, n, t, c }
  // свернутые / развёрнутые разделы карточки и высота картинки на телефоне — запоминаются за аккаунтом
  const [fold, setFold] = useState(() => { try { return getUserSettings(user)?.cadFold || {} } catch { return {} } })
  const foldApi = useMemo(() => ({
    isOpen: (id, def) => (fold[id] == null ? def : !!fold[id]),
    toggle: (id, v) => { const next = { ...fold, [id]: v }; setFold(next); saveUserSettings({ cadFold: next }, user) },
  }), [fold, user])
  const [splitPx, setSplitPx] = useState(() => { try { return getUserSettings(user)?.cadSplit || 0 } catch { return 0 } })
  // боком / на компьютере: ширина карточки и её сторона — за аккаунтом
  const [sideW, setSideW] = useState(() => { try { return getUserSettings(user)?.cadSideW || 0 } catch { return 0 } })
  const [cardSide, setCardSideS] = useState(() => { try { return getUserSettings(user)?.cadSide || 'right' } catch { return 'right' } })
  const setCardSide = v => { setCardSideS(v); saveUserSettings({ cadSide: v }, user) }
  // подсветка кромки в 3D: цвет, прозрачность, «яркая» (светится сквозь детали) — за аккаунтом
  const [edgeLook, setEdgeLookS] = useState(() => { try { return { on: true, color: '#f97316', opacity: 1, glow: false, ...(getUserSettings(user)?.cadEdgeLook || {}) } } catch { return { on: true, color: '#f97316', opacity: 1, glow: false } } })
  const setEdgeLook = patch => setEdgeLookS(l => { const n = { ...l, ...patch }; saveUserSettings({ cadEdgeLook: n }, user); return n })
  // вид сцены (подписи размеров, линии, фон) — за аккаунтом; тема — светлая / тёмная
  const [look, setLookS] = useState(() => { try { return { ...CAD_LOOK, ...(getUserSettings(user)?.cadLook || {}) } } catch { return { ...CAD_LOOK } } })
  const setLook = patch => setLookS(l => { const n = { ...l, ...patch }; saveUserSettings({ cadLook: n }, user); return n })
  const [theme, setThemeS] = useState(() => getTheme())
  useEffect(() => { const on = e => setThemeS(e.detail === 'dark' ? 'dark' : 'light'); window.addEventListener('themechange', on); return () => window.removeEventListener('themechange', on) }, [])
  const viewLook = useMemo(() => ({ ...look, dark: theme === 'dark' }), [look, theme])
  // размеры проёмов на модели (кнопка 📏) — тоже за аккаунтом
  const showSizes = look.openSizes !== false
  const setShowSizes = f => setLook({ openSizes: typeof f === 'function' ? f(showSizes) : !!f })
  // цвета / текстуры материалов — за аккаунтом
  const [matLooks, setMatLooksS] = useState(() => { try { return getUserSettings(user)?.cadMatLooks || {} } catch { return {} } })
  const setMatLooks = v => { setMatLooksS(v); saveUserSettings({ cadMatLooks: v }, user) }
  // выбор нескольких деталей (сменить материал / цвет сразу у всех)
  const [multi, setMulti] = useState(false)
  const [multiSel, setMultiSel] = useState([])
  const [moveMode, setMoveMode] = useState(false)    // «✥ Двигать»: только тогда пальцем двигаем элемент по полу
  const [pull, setPull] = useState('after')          // при смене размера проёма тянутся соседи: after — выше/правее, before — ниже/левее        // выбранная деталь внутри элемента (нажатие в 3D)
  const [editPart, setEditPart] = useState(null)    // редактор контура детали: { pid, draft }
  const [tab, setTab] = useState('scene')
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [xray, setXray] = useState(false)
  const [fitKey, setFitKey] = useState(0)
  const [toOrder, setToOrder] = useState(false)
  const [showHoles, setShowHoles] = useState(true)
  const [library, setLibrary] = useState(() => { try { return getUserSettings(user)?.cadLibrary || [] } catch { return [] } })
  const [land, setLand] = useState(() => typeof window !== 'undefined' && window.innerWidth > window.innerHeight && window.innerHeight < 600)
  const dirty = useRef(false)
  const projRef = useRef(null)
  const timer = useRef(0)

  useEffect(() => { if (isMaster) return; let a = true; hasBeta(CAD_FEATURE).then(v => { if (a) setAllowed(v) }); return () => { a = false } }, [isMaster])
  useEffect(() => { const on = () => setLand(window.innerWidth > window.innerHeight && window.innerHeight < 600); window.addEventListener('resize', on); return () => window.removeEventListener('resize', on) }, [])

  // список проектов / открыть проект
  useEffect(() => {
    if (!allowed || !user) return
    let a = true
    if (!pid) { listProjects(user.id).then(l => { if (a) setList(l) }).catch(e => { if (a) setError(e.message) }); return () => { a = false } }
    if (projRef.current?.id === pid) return
    loadProject(user.id, pid).then(p => {
      if (!a) return; if (!p) { setError('Проект не найден'); return }
      // крепёж фурнитуры — за аккаунтом: в проекте его ещё нет — берём из настроек аккаунта
      if (!p.settings?.mount) { try { const am = getUserSettings(user)?.cadMount; if (am) p = { ...p, settings: { ...(p.settings || {}), mount: am } } } catch { /* нет */ } }
      // свои схемы крепежа — за аккаунтом: добавляем к схемам проекта, чтобы ★ в проекте работали
      try { const aj = getUserSettings(user)?.cadJointSchemes; if (aj) p = { ...p, settings: { ...(p.settings || {}), jointSchemes: { ...aj, ...(p.settings?.jointSchemes || {}) } } } } catch { /* нет */ }
      projRef.current = p; setProjectState(p); setSelected(null); setFitKey(k => k + 1) }).catch(e => { if (a) setError(e.message) })
    return () => { a = false }
  }, [pid, allowed, user])

  const flush = useCallback(async () => {
    clearTimeout(timer.current)
    const p = projRef.current
    if (!dirty.current || !p || !user) return
    dirty.current = false
    setStatus('Сохраняю…')
    try {
      const id = await saveProject(user.id, p)
      if (id !== p.id) { projRef.current = { ...projRef.current, id }; setProjectState(projRef.current); navigate(`/constructor?p=${id}`, { replace: true }) }
      setStatus(isLocal() ? 'Сохранено на устройстве' : 'Сохранено')
    } catch (e) { dirty.current = true; setStatus('Не сохранилось: ' + e.message) }
  }, [user, navigate])
  useEffect(() => () => { flush() }, [flush])   // уходим со страницы — дописать
  const setProject = useCallback(next => {
    projRef.current = next
    setProjectState(next)
    dirty.current = true
    setStatus('…')
    clearTimeout(timer.current)
    timer.current = setTimeout(flush, 1200)
  }, [flush])

  const pp = useMemo(() => (project ? projectParts(project) : { parts: [], holes: [] }), [project])
  const { parts } = pp
  const holes = useMemo(() => (project && showHoles ? projectDrill(project, pp).holes : []), [project, pp, showHoles])
  // проёмы выбранного корпуса — видны и нажимаются в 3D, фасады этого корпуса при этом полупрозрачные
  const selCab = project?.items.find(i => i.id === selected && i.type === 'cabinet') || null
  const cabOpenings = useMemo(() => (selCab ? (pp.openings || []).filter(o => o.item === selCab.id) : []), [pp, selCab])
  // подписи размеров проёмов на модели: у проёма в делении — его ширина (верт. панели) или высота (гориз.); нажать — выбрать и править
  const sizeLabels = useMemo(() => {
    if (!selCab || !showSizes) return []
    const tree = treeOf({ ...CAB_DEFAULTS, ...selCab.p })
    const par = new Map()
    const walk = n => (n.children || []).forEach(c => { par.set(c.id, n.split); walk(c) })
    walk(tree)
    return cabOpenings.filter(o => par.has(o.id)).map(o => {
      const b = o.aabb, v = par.get(o.id) === 'v'
      return { id: o.id, on: o.id === selOpening, text: v ? `↔ ${o.w}` : `↕ ${o.h}`,
        p: [(b[0] + b[3]) / 2, v ? b[4] - Math.min(90, (b[4] - b[1]) / 4) : (b[1] + b[4]) / 2, b[5]] }
    })
  }, [selCab, cabOpenings, showSizes, selOpening])
  const blk = selBlock && selCab && selBlock.item === selCab.id ? selBlock : null
  const hiPids = useMemo(() => (blk ? new Set(parts.filter(sp => sp.item.id === blk.item && sp.blk && sp.blk.n === blk.n && sp.blk.t === blk.t).map(sp => sp.pid)) : null), [blk, parts])
  const multiSet = useMemo(() => new Set(multiSel), [multiSel])
  // свой материал выбранным деталям (item.mat[ключ]); null — как в корпусе
  const applyMultiJoint = v => {
    const by = new Map()
    for (const sp of parts) if (multiSet.has(sp.pid) && sp.kind === 'sheet') { if (!by.has(sp.item.id)) by.set(sp.item.id, []); by.get(sp.item.id).push(sp.key) }
    setProject({ ...project, items: project.items.map(it => { const ks = by.get(it.id); if (!ks) return it; const j = { ...(it.joint || {}) }; for (const k of ks) { if (v) j[k] = v; else delete j[k] } return { ...it, joint: j } }) })
  }
  const applyMultiMat = v => {
    const by = new Map()
    for (const sp of parts) if (multiSet.has(sp.pid)) { if (!by.has(sp.item.id)) by.set(sp.item.id, []); by.get(sp.item.id).push(sp.key) }
    setProject({ ...project, items: project.items.map(it => { const ks = by.get(it.id); if (!ks) return it; const m = { ...(it.mat || {}) }; for (const k of ks) { if (v) m[k] = v; else delete m[k] } return { ...it, mat: m } }) })
  }
  const hiPidsRef = useRef(null)
  useEffect(() => { hiPidsRef.current = hiPids }, [hiPids])
  // высоты ящиков выбранного блока — подписи на модели; нажать — ввести высоту (остальные ящики перестроятся)
  const drLabels = useMemo(() => {
    if (!blk || blk.t !== 'front') return null
    const fs = parts.filter(sp => hiPids?.has(sp.pid) && sp.name === 'Фасад ящика').sort((a, b) => a.place.aabb[1] - b.place.aabb[1])
    if (!fs.length) return null
    return fs.map((sp, i) => { const b = sp.place.aabb; return { id: 'drh:' + i, on: false, text: `↕ ${Math.round((b[4] - b[1]) * 10) / 10}`, p: [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, b[5]] } })
  }, [blk, parts, hiPids])
  const onLabel = id => {
    if (!id.startsWith('drh:') || !blk) { setSelOpening(id); setSelBlock(null); setTab('props'); return }
    const i = Number(id.slice(4))
    const p0 = { ...CAB_DEFAULTS, ...selCab.p }, tree = treeOf(p0), r = findNode(tree, blk.n)
    const fr = r?.node?.front
    if (!fr) return
    const cur = drLabels?.[i]?.text?.replace('↕ ', '')
    const v = window.prompt(`Высота фасада ящика (${i === 0 ? 'нижний' : i === fr.n - 1 ? 'верхний' : `${i + 1}-й снизу`}), мм. Пусто — авто:`, cur)
    if (v == null) return
    const n2 = v.trim() === '' ? null : Number(v.replace(',', '.'))
    if (n2 != null && !(n2 >= 40)) return
    const curH = (drLabels || []).map(l => Number(String(l.text).replace('↕ ', '')))
    const arr = curH.length === fr.n ? drawerSetHeight(curH, fr.hs, i, n2, fr.pull || 'all') : (() => { const a = Array.from({ length: fr.n }, (_, k) => fr.hs?.[k] ?? null); a[i] = n2; return a })()
    setItem({ ...selCab, p: { ...p0, tree: opFront(tree, blk.n, { ...fr, hs: arr }) } })
  }
  const room = project?.settings?.room?.on ? { ...PROJECT_DEFAULTS.room, ...project.settings.room } : null
  // линейный раскрой — только если он открыт этому аккаунту (мастер или бета «Линейный раскрой»)
  const [linearOk, setLinearOk] = useState(!!isMaster)
  useEffect(() => { if (isMaster) return; let a = true; hasBeta(LINEAR_FEATURE).then(v => { if (a) setLinearOk(v) }); return () => { a = false } }, [isMaster])
  const toLinear = row => {
    const st = { ...PROJECT_DEFAULTS, ...project.settings }
    const map = new Map()
    for (const sp of parts) {
      if (sp.kind !== 'profile' || sp.material !== row.name) continue
      const name = [sp.item.name, sp.name].filter(Boolean).join(' · ')
      const k = `${sp.place.L}|${name}`
      map.set(k, (map.get(k) || 0) + 1)
    }
    const pieces = [...map.entries()].map(([k, qty]) => { const [len, name] = k.split('|'); return { id: newId(), len: Number(len), qty, name } })
    const stocks = String(st.stocks?.[row.name] || st.stockLen).split(/[\s,;]+/).filter(Boolean).map(len => ({ len: Number(len), qty: '' }))
    const job = newLinearJob({ name: `${project.name} · ${row.name}`, material: row.name, kerf: st.linearKerf, stocks, pieces })
    writeJobs([job, ...readJobs(user)], user)
    flush()
    navigate(`/linear?job=${job.id}`)
  }
  // перетаскивание выбранного элемента в 3D по полу с привязкой к стенам комнаты и к граням соседей (40 мм)
  const dragSt = useRef(null)
  const onDrag = (id, phase, dx, dz) => {
    const cur = projRef.current
    const it = cur?.items.find(i => i.id === id)
    if (!it) return
    if (phase === 'start') {
      const own = parts.filter(p => p.item.id === id)
      const others = [...new Set(parts.filter(p => p.item.id !== id).map(p => p.item.id))].map(oid => sceneBox(parts.filter(p => p.item.id === oid)))
      dragSt.current = { pos: { ...it.pos }, box: sceneBox(own), others }
      return
    }
    const d = dragSt.current
    if (!d) return
    if (phase === 'cancel') { dragSt.current = null; return }
    if (phase === 'end') { dragSt.current = null; return }
    const S = 40
    const snap = (lo, hi, edges) => {
      let best = 0, bd = S
      for (const e of edges) for (const v of [lo, hi]) { const c = e - v; if (Math.abs(c) < bd) { bd = Math.abs(c); best = c } }
      return best
    }
    const ex = [], ez = []
    if (room) { ex.push(0, room.W); ez.push(0, room.D) }
    for (const o of d.others) { ex.push(o[0], o[3]); ez.push(o[2], o[5]) }
    let mx = dx, mz = dz
    mx += snap(d.box[0] + mx, d.box[3] + mx, ex)
    mz += snap(d.box[2] + mz, d.box[5] + mz, ez)
    // внутри комнаты — не дальше стен
    if (room) {
      mx = Math.min(Math.max(mx, -d.box[0]), room.W - d.box[3])
      mz = Math.min(Math.max(mz, -d.box[2]), room.D - d.box[5])
    }
    // на соседа не наезжаем: двигаем от прошлого положения отдельно по X и по Z и упираемся в ближайшего соседа
    // (вплотную можно — зазор 0, как в 3D-просмотре); сквозь соседей элемент не проходит
    const ov = (a0, a1, b0, b1) => Math.min(a1, b1) - Math.max(a0, b0) > 0.5
    const sweep = (axis, from, to, other) => {
      const lo = d.box[axis], hi = d.box[axis + 3]
      const oa = axis === 0 ? 2 : 0
      let v = to
      for (const o of d.others) {
        if (!ov(d.box[1], d.box[4], o[1], o[4]) || !ov(d.box[oa] + other, d.box[oa + 3] + other, o[oa], o[oa + 3])) continue
        if (to > from && hi + from <= o[axis] + 0.5) v = Math.min(v, o[axis] - hi)
        if (to < from && lo + from >= o[axis + 3] - 0.5) v = Math.max(v, o[axis + 3] - lo)
      }
      return v
    }
    const lx = d.last?.x ?? 0, lz = d.last?.z ?? 0
    mx = sweep(0, lx, mx, lz)
    mz = sweep(2, lz, mz, mx)
    d.last = { x: mx, z: mz }
    const pos = { ...d.pos, x: Math.round(num(d.pos.x) + mx), z: Math.round(num(d.pos.z) + mz) }
    setProject({ ...cur, items: cur.items.map(i => (i.id === id ? { ...i, pos } : i)) })
  }
  const saveLibrary = next => { setLibrary(next); saveUserSettings({ cadLibrary: next }, user) }
  const materials = useMemo(() => {
    const s = new Set(['ЛДСП Белый 16', 'ХДФ Белый 3', 'МДФ 16', 'Стекло прозрачное 4 мм', 'Зеркало 4 мм', 'Профиль 20×20 сталь', 'Профиль 40×20 сталь', 'Труба Ø25 хром'])
    for (const p of parts) if (p.material) s.add(p.material)
    return [...s]
  }, [parts])
  const selItem = project?.items.find(i => i.id === selected) || null
  const accDef = () => { try { return getUserSettings(user)?.cadCabDefaults || {} } catch { return {} } }
  const setItem = next => {
    const prev = project.items.find(i => i.id === next.id)
    if (next.type === 'cabinet' && prev) {
      const ch = {}
      for (const k of CAB_REMEMBER) if (next.p?.[k] !== undefined && JSON.stringify(prev.p?.[k]) !== JSON.stringify(next.p[k])) ch[k] = next.p[k]
      if (Object.keys(ch).length) saveUserSettings({ cadCabDefaults: { ...accDef(), ...ch } }, user)
    }
    setProject({ ...project, items: project.items.map(i => (i.id === next.id ? next : i)) })
  }
  const jointSchemes = project?.settings?.jointSchemes || {}
  const setJointSchemes = v => { setProject({ ...project, settings: { ...project.settings, jointSchemes: v } }); saveUserSettings({ cadJointSchemes: v }, user) }
  const mount = project?.settings?.mount
  const setMount = m => { setProject({ ...project, settings: { ...project.settings, mount: m } }); saveUserSettings({ cadMount: m }, user) }

  const addItem = type => {
    const b = parts.length ? sceneBox(parts) : [0, 0, 0, 0, 0, 0]
    const it = type === 'cabinet' ? newItem(type, { p: accDef() }) : newItem(type)
    it.pos = { x: parts.length ? Math.round(b[3] + (type === 'cabinet' ? 0 : 50)) : 0, y: 0, z: 0 }
    if (type === 'cabinet') it.name = `Корпус ${project.items.filter(i => i.type === 'cabinet').length + 1}`
    setProject({ ...project, items: [...project.items, it] })
    setSelected(it.id); setTab('props')
  }
  const select = (id, pid = null, opening = null, extra = null) => {
    if (multi) { if (pid) setMultiSel(l => (l.includes(pid) ? l.filter(x => x !== pid) : [...l, pid])); return }
    setSelected(id); setSelPid(id ? pid : null); setSelOpening(id ? opening : null)
    // тап по детали уже выбранного блока (например, первый тап двойного — открыть ящик) — блок остаётся выбранным
    if (id && extra?.blk) setSelBlock({ item: id, ...extra.blk })
    else if (!(id && pid && hiPidsRef.current?.has(pid))) setSelBlock(null)
    if (id) setTab('props')
  }

  const createNew = async () => {
    const name = window.prompt('Название проекта:', 'Новый проект')
    if (name == null) return
    const p = newProject(name.trim() || 'Новый проект')
    let ad = {}, am
    try { ad = getUserSettings(user)?.cadCabDefaults || {}; am = getUserSettings(user)?.cadMount } catch { /* нет настроек */ }
    p.items.push({ ...newItem('cabinet', { p: ad }), name: 'Шкаф' })
    if (am) p.settings.mount = am
    try {
      const id = await saveProject(user.id, p)
      projRef.current = { ...p, id }; setProjectState(projRef.current)
      navigate(`/constructor?p=${id}`)
    } catch (e) { setError(e.message) }
  }
  const goOrder = key => {
    const ex = exportForOrder(project, key)
    if (!ex) return
    let model3d
    try { model3d = packScene(ex.scene) } catch { model3d = null }
    setToOrder(false)
    flush()
    setCabinet?.('client')
    navigate('/orders/new', { state: { cad: { items: ex.items, material: ex.material, thickness: ex.thickness, orderName: ex.orderName, model3d, linear: ex.linear } } })
  }
  const all3d = useMemo(() => (project ? exportAll(project) : null), [project])

  if (allowed === null) return <div className="page"><CncLoader label="Открываем конструктор…" /></div>
  if (!allowed) return (
    <div className="page"><div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 10 }}><MenuButton /><h1 style={{ fontSize: 18, fontWeight: 500 }}>Конструктор</h1></div>
      <p style={{ fontSize: 14, color: 'var(--text-muted)' }}>Конструктор мебели сейчас в бета-тесте. Доступ выдаёт мастер-аккаунт.</p><NavDrawer /></div>
  )

  // ── список проектов ──
  if (!pid) return (
    <div className="page" style={{ paddingBottom: 100 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 10, paddingTop: 4 }}>
        <MenuButton /><h1 style={{ fontSize: 18, fontWeight: 500, flex: 1 }}>Конструктор <span style={{ fontSize: 11, color: 'var(--amber)', fontWeight: 600 }}>β</span></h1>
      </div>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 10 }}>Проектирование мебели: параметрические корпуса, свободные панели, стекло и металл. Готовые детали — сразу в заказ на раскрой.</p>
      <button type="button" className="btn-primary" style={{ marginBottom: 12 }} onClick={createNew}>+ Новый проект</button>
      {error && <p className="error-text">{error}</p>}
      {list === null ? <CncLoader label="Загружаем проекты…" /> : <>
        {isLocal() && <p style={{ fontSize: 12, color: 'var(--amber)', background: 'var(--amber-light)', borderRadius: 8, padding: '6px 10px', marginBottom: 8 }}>{CAD_SQL_HINT}</p>}
        {list.map(x => (
          <div key={x.id} className="card" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', marginBottom: 6, cursor: 'pointer' }} onClick={() => navigate(`/constructor?p=${x.id}`)}>
            <span style={{ flex: 1, minWidth: 0, fontSize: 14.5 }}>{x.name}</span>
            <span style={{ fontSize: 11.5, color: 'var(--text-hint)' }}>{x.updated_at ? new Date(x.updated_at).toLocaleDateString('ru-RU') : ''}</span>
            <button type="button" title="Удалить проект" style={{ border: 'none', background: 'none', color: 'var(--danger)', fontSize: 16, cursor: 'pointer' }}
              onClick={async e => { e.stopPropagation(); if (!window.confirm(`Удалить проект «${x.name}»?`)) return; await deleteProject(user.id, x.id); setList(l => l.filter(y => y.id !== x.id)) }}>🗑</button>
          </div>
        ))}
        {!list.length && <p style={{ fontSize: 13, color: 'var(--text-hint)' }}>Проектов пока нет.</p>}
      </>}
      <NavDrawer />
    </div>
  )

  if (!project) return <div className="page">{error ? <p className="error-text">{error}</p> : <CncLoader label="Открываем проект…" />}</div>

  const info = selItem ? (() => {
    const own = parts.filter(p => p.item.id === selItem.id)
    if (!own.length) return ''
    const b = sceneBox(own)
    return `Габарит: ${Math.round(b[3] - b[0])} × ${Math.round(b[4] - b[1])} × ${Math.round(b[5] - b[2])} мм · деталей ${own.filter(p => p.kind === 'sheet').length}`
  })() : ''

  const view = (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <CadView parts={parts} selected={selected} selectedPid={selPid} openings={cabOpenings} selectedOpening={selOpening} onSelect={select} onDrag={onDrag} xray={xray} fitKey={fitKey} holes={holes} room={room}
        labels={drLabels || sizeLabels} onLabel={onLabel} moveMode={moveMode} edgeLook={edgeLook} hiPids={multi ? multiSet : hiPids} look={viewLook} matLooks={matLooks}>
        {selCab && <OpeningTools it={selCab} set={setItem} sel={selOpening} setSel={setSelOpening} showSizes={showSizes} setShowSizes={setShowSizes} />}
        {selCab && selOpening && !blk && <OpeningPanel it={selCab} set={setItem} sel={selOpening} setSel={setSelOpening} pull={pull} setPull={setPull} onBlock={b => { setSelBlock({ item: selCab.id, ...b }); setSelPid(null); setTab('props') }} />}
        {multi && <div style={{ position: 'absolute', left: 58, bottom: 6, zIndex: 4, display: 'flex', gap: 6, alignItems: 'center', background: 'var(--bg)', border: '1px solid #f59e0b', borderRadius: 14, padding: '4px 6px 4px 10px', fontSize: 12.5 }}>
          <b>Выбрано: {multiSel.length}</b><span style={{ color: 'var(--text-muted)' }}>нажимайте детали</span>
          <button type="button" style={{ ...chipS(true), padding: '2px 9px' }} onClick={() => { setMulti(false); setMultiSel([]) }}>Готово</button>
        </div>}
        {blk && !multi && <div style={{ position: 'absolute', left: 58, bottom: 6, zIndex: 3, display: 'flex', gap: 4, alignItems: 'center', background: 'var(--bg)', border: '1px solid #f59e0b', borderRadius: 14, padding: '3px 4px 3px 10px', fontSize: 12.5 }}>
          <b>{blockTitle(findNode(treeOf({ ...CAB_DEFAULTS, ...selCab.p }), blk.n)?.node, blk.t)}</b>
          <button type="button" style={{ border: 'none', background: 'none', fontSize: 15, cursor: 'pointer', color: 'var(--text-muted)' }} onClick={() => setSelBlock(null)}>✕</button>
        </div>}
      </CadView>
      <div style={{ position: 'absolute', right: 8, top: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <button type="button" title="Показать всё" style={{ ...btnS(), padding: '6px 9px' }} onClick={() => setFitKey(k => k + 1)}>⤢</button>
        <button type="button" title="Полупрозрачный вид" style={{ ...btnS(), padding: '6px 9px', ...(xray ? { color: 'var(--blue)', borderColor: 'var(--blue)' } : {}) }} onClick={() => setXray(v => !v)}>◫</button>
 <button type="button" title="Отображение: подписи, линии, фон, кромка, тема" style={{ ...btnS(), padding: '6px 9px' }} onClick={() => { setTab('scene'); foldApi.toggle('look', true) }}>⚙</button>
        <button type="button" title="Подсветка кромки" style={{ ...btnS(), padding: '6px 9px', ...(edgeLook.on ? { color: edgeLook.color, borderColor: edgeLook.color } : {}) }} onClick={() => setEdgeLook({ on: !edgeLook.on })}>▭</button>
        <button type="button" title="Двигать выбранный элемент пальцем по полу" style={{ ...btnS(), padding: '6px 9px', ...(moveMode ? { color: 'white', background: 'var(--blue)', borderColor: 'var(--blue)' } : {}) }} onClick={() => setMoveMode(v => !v)}>✥</button>
        <button type="button" title="Показать присадку" style={{ ...btnS(), padding: '6px 9px', ...(showHoles ? { color: 'var(--blue)', borderColor: 'var(--blue)' } : {}) }} onClick={() => setShowHoles(v => !v)}>⊙</button>
      </div>
      {project.items.length > 0 && (() => { const b = sceneBox(parts); return <div style={{ position: 'absolute', right: 8, bottom: 4, fontSize: 11, color: 'var(--text-muted)', background: 'var(--bg)', borderRadius: 6, padding: '1px 6px' }}>{Math.round(b[3] - b[0])} × {Math.round(b[4] - b[1])} × {Math.round(b[5] - b[2])}</div> })()}
    </div>
  )
  const panel = (<FoldCtx.Provider value={foldApi}>
    <datalist id="cad-mats">{materials.map(m => <option key={m} value={m} />)}</datalist>
    <div style={{ display: 'flex', gap: 5, marginBottom: 10, flexWrap: 'wrap' }}>
      {[['scene', 'Сцена'], ['props', 'Свойства'], ['spec', 'Смета']].map(([k, t]) => <button key={k} type="button" style={chipS(tab === k)} onClick={() => setTab(k)}>{t}</button>)}
    </div>
    {tab === 'scene' && <div className="card" style={{ padding: '4px 10px 8px', marginBottom: 10 }}>
      <Fold id="look" title="Отображение" right="за аккаунтом">
        <div style={{ ...sect, marginTop: 0 }}>Подписи размеров</div>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, marginBottom: 6 }}><span style={{ width: 150 }}>Фон подписи (прозрачность)</span><input type="range" min="0" max="1" step="0.05" value={look.labelOpacity} onChange={e => { const v = Number(e.target.value); setLook({ labelOpacity: v }) }} style={{ flex: 1, minWidth: 0 }} /><span style={{ width: 40, textAlign: 'right', color: 'var(--text-muted)' }}>{Math.round(look.labelOpacity * 100)}%</span></label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, marginBottom: 6 }}><span style={{ width: 150 }}>Размер подписей проёмов</span><input type="range" min="0.6" max="1.8" step="0.05" value={look.labelSize} onChange={e => { const v = Number(e.target.value); setLook({ labelSize: v }) }} style={{ flex: 1, minWidth: 0 }} /><span style={{ width: 40, textAlign: 'right', color: 'var(--text-muted)' }}>{Math.round(look.labelSize * 100)}%</span></label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, marginBottom: 6 }}><span style={{ width: 150 }}>Размер габаритных размеров</span><input type="range" min="0.4" max="2" step="0.05" value={look.dimSize} onChange={e => { const v = Number(e.target.value); setLook({ dimSize: v }) }} style={{ flex: 1, minWidth: 0 }} /><span style={{ width: 40, textAlign: 'right', color: 'var(--text-muted)' }}>{Math.round(look.dimSize * 100)}%</span></label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, marginBottom: 6 }}><input type="checkbox" style={{ width: 'auto', margin: 0 }} checked={look.dims !== false} onChange={e => setLook({ dims: e.target.checked })} />Габаритные размеры корпусов (ничего не выбрано — у всех корпусов)</label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, marginBottom: 6 }}><input type="checkbox" style={{ width: 'auto', margin: 0 }} checked={look.openSizes !== false} onChange={e => setLook({ openSizes: e.target.checked })} />Размеры проёмов (кнопка 📏)</label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, marginBottom: 6 }}><input type="checkbox" style={{ width: 'auto', margin: 0 }} checked={look.labelBgOn !== false} onChange={e => setLook({ labelBgOn: e.target.checked })} />Фон под цифрами (без фона — только цифры)</label>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, marginBottom: 6, flexWrap: 'wrap' }}><span style={{ width: 150 }}>Цвет подписей</span>
          {[['#1d4ed8', 'синий'], ['#ffffff', 'белый'], ['#9aa0a6', 'серый'], ['#111827', 'чёрный'], ['#f97316', 'оранжевый']].map(([c, t]) =>
            <button key={c} type="button" title={t} onClick={() => setLook({ labelColor: c })} style={{ width: 26, height: 26, borderRadius: 13, background: c, cursor: 'pointer', border: look.labelColor === c ? '3px solid var(--blue)' : '1px solid var(--border-md)' }} />)}
          <input type="color" value={look.labelColor} onChange={e => setLook({ labelColor: e.target.value })} style={{ width: 40, height: 26, padding: 0, border: 'none', background: 'none' }} /></div>
        <div style={sect}>Вид деталей</div>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, marginBottom: 6 }}><input type="checkbox" style={{ width: 'auto', margin: 0 }} checked={look.lines !== false} onChange={e => setLook({ lines: e.target.checked })} />Линии контуров деталей (без них — сплошной вид, только материал и текстура)</label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, marginBottom: 6 }}><span style={{ width: 150 }}>Прозрачный вид ◫: насколько видно детали</span><input type="range" min="0.03" max="0.8" step="0.01" value={look.xrayOpacity ?? 0.3} onChange={e => { const v = Number(e.target.value); setLook({ xrayOpacity: v }) }} style={{ flex: 1, minWidth: 0 }} /><span style={{ width: 40, textAlign: 'right', color: 'var(--text-muted)' }}>{Math.round((look.xrayOpacity ?? 0.3) * 100)}%</span></label>
        <div style={sect}>Линии деталей</div>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, marginBottom: 6 }}><span style={{ width: 150 }}>Цвет линий каркаса</span><input type="color" value={look.lineColor} onChange={e => setLook({ lineColor: e.target.value })} style={{ width: 40, height: 26, padding: 0, border: 'none', background: 'none' }} /></label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, marginBottom: 6 }}><span style={{ width: 150 }}>Яркость линий</span><input type="range" min="0.05" max="1" step="0.05" value={look.lineOpacity} onChange={e => { const v = Number(e.target.value); setLook({ lineOpacity: v }) }} style={{ flex: 1, minWidth: 0 }} /><span style={{ width: 40, textAlign: 'right', color: 'var(--text-muted)' }}>{Math.round(look.lineOpacity * 100)}%</span></label>
        <div style={sect}>Подсветка кромки</div>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, marginBottom: 6 }}><input type="checkbox" style={{ width: 'auto', margin: 0 }} checked={edgeLook.on} onChange={e => setEdgeLook({ on: e.target.checked })} />Показывать кромку
          <input type="color" value={edgeLook.color} onChange={e => setEdgeLook({ color: e.target.value })} style={{ width: 40, height: 26, padding: 0, border: 'none', background: 'none', marginLeft: 8 }} /></label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, marginBottom: 6 }}><span style={{ width: 150 }}>Яркость кромки</span><input type="range" min="0.1" max="1" step="0.05" value={edgeLook.opacity} onChange={e => { const v = Number(e.target.value); setEdgeLook({ opacity: v }) }} style={{ flex: 1, minWidth: 0 }} /><span style={{ width: 40, textAlign: 'right', color: 'var(--text-muted)' }}>{Math.round(edgeLook.opacity * 100)}%</span></label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, marginBottom: 6 }}><input type="checkbox" style={{ width: 'auto', margin: 0 }} checked={!!edgeLook.glow} onChange={e => setEdgeLook({ glow: e.target.checked })} />Светящаяся (видна сквозь детали)</label>
        <div style={sect}>Качество картинки</div>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, marginBottom: 6 }}><span style={{ width: 150 }}>Яркость</span><input type="range" min="0.5" max="1.6" step="0.02" value={look.exposure ?? 1} onChange={e => { const v = Number(e.target.value); setLook({ exposure: v }) }} style={{ flex: 1, minWidth: 0 }} /><span style={{ width: 40, textAlign: 'right', color: 'var(--text-muted)' }}>{Math.round((look.exposure ?? 1) * 100)}%</span></label>
        <Chips value={look.quality} onChange={v => setLook({ quality: v })} options={[['high', 'Максимальное (тени, затенение в углах)'], ['std', 'Обычное (быстрее)']]}
          hint="Максимальное — как в программах визуализации: мягкие тени и затенение в стыках и углах. На слабом телефоне может подтормаживать — тогда «Обычное»." />
        <div style={sect}>Свет</div>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, marginBottom: 6 }}><span style={{ width: 150 }}>Основной свет</span><input type="range" min="0.2" max="2" step="0.05" value={look.lightKey ?? 1} onChange={e => { const v = Number(e.target.value); setLook({ lightKey: v }) }} style={{ flex: 1, minWidth: 0 }} /><span style={{ width: 40, textAlign: 'right', color: 'var(--text-muted)' }}>{Math.round((look.lightKey ?? 1) * 100) + '%'}</span></label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, marginBottom: 6 }}><span style={{ width: 150 }}>Рассеянный свет</span><input type="range" min="0.2" max="2" step="0.05" value={look.lightAmb ?? 1} onChange={e => { const v = Number(e.target.value); setLook({ lightAmb: v }) }} style={{ flex: 1, minWidth: 0 }} /><span style={{ width: 40, textAlign: 'right', color: 'var(--text-muted)' }}>{Math.round((look.lightAmb ?? 1) * 100) + '%'}</span></label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, marginBottom: 6 }}><span style={{ width: 150 }}>Отражения</span><input type="range" min="0.1" max="2" step="0.05" value={look.envInt ?? 1} onChange={e => { const v = Number(e.target.value); setLook({ envInt: v }) }} style={{ flex: 1, minWidth: 0 }} /><span style={{ width: 40, textAlign: 'right', color: 'var(--text-muted)' }}>{Math.round((look.envInt ?? 1) * 100) + '%'}</span></label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, marginBottom: 6 }}><span style={{ width: 150 }}>Откуда свет (по кругу)</span><input type="range" min="0" max="360" step="5" value={look.lightAz ?? 35} onChange={e => { const v = Number(e.target.value); setLook({ lightAz: v }) }} style={{ flex: 1, minWidth: 0 }} /><span style={{ width: 40, textAlign: 'right', color: 'var(--text-muted)' }}>{Math.round(look.lightAz ?? 35) + '°'}</span></label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, marginBottom: 6 }}><span style={{ width: 150 }}>Высота света</span><input type="range" min="10" max="85" step="1" value={look.lightEl ?? 55} onChange={e => { const v = Number(e.target.value); setLook({ lightEl: v }) }} style={{ flex: 1, minWidth: 0 }} /><span style={{ width: 40, textAlign: 'right', color: 'var(--text-muted)' }}>{Math.round(look.lightEl ?? 55) + '°'}</span></label>
        <p style={{ fontSize: 11.5, color: 'var(--text-hint)', margin: '0 0 6px' }}>Белые фасады слепят — уменьшите основной свет или яркость; блеск каждого материала — в «Как выглядит материал».</p>
        <div style={sect}>Скругление кромки</div>
        <Chips value={String(look.edgeR ?? 0.5)} onChange={v => setLook({ edgeR: Number(v) })} options={[['0', 'Острые'], ['0.5', 'R 0,5'], ['1', 'R 1'], ['2', 'R 2']]} />
        <p style={{ fontSize: 11.5, color: 'var(--text-hint)', margin: '0 0 6px' }}>Только на кромленых торцах и не больше толщины кромки (кромка 0,4 — радиус 0,4); торцы без кромки остаются острыми. Влияет только на картинку.</p>
        <div style={sect}>Присадка (кнопка ⊙)</div>
        <Chips value={look.holeStyle || 'recess'} onChange={v => setLook({ holeStyle: v })} options={[['recess', 'Выемки (как настоящие отверстия)'], ['marker', 'Цветные метки на всю глубину']]} />
        <div style={sect}>Металл фурнитуры</div>
        <Chips label="Ручки" value={look.handleFinish} onChange={v => setLook({ handleFinish: v })} options={FINISHES.map(f => [f[0], f[1]])} />
        <Chips label="Петли и направляющие" value={look.hwFinish} onChange={v => setLook({ hwFinish: v })} options={FINISHES.map(f => [f[0], f[1]])} />
        <div style={sect}>Экран боком и компьютер</div>
        <Chips label="Карточка параметров" value={cardSide} onChange={setCardSide} options={[['left', '◧ Слева (под левую руку)'], ['right', 'Справа ◨']]} />
        <div style={sect}>Фон и тема</div>
        <Chips value={look.bg} onChange={v => setLook({ bg: v })} options={[['auto', 'По теме'], ['light', 'Светлый'], ['dark', 'Тёмный'], ['custom', 'Свой цвет']]} />
        {look.bg === 'custom' && <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, marginBottom: 6 }}><span style={{ width: 150 }}>Цвет фона</span><input type="color" value={look.bgColor} onChange={e => setLook({ bgColor: e.target.value })} style={{ width: 40, height: 26, padding: 0, border: 'none', background: 'none' }} /></label>}
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, marginBottom: 6 }}><input type="checkbox" style={{ width: 'auto', margin: 0 }} checked={theme === 'dark'} onChange={e => setThemeS(setTheme(e.target.checked ? 'dark' : 'light'))} />🌙 Тёмная тема всего приложения</label>
        <button type="button" style={{ ...btnS(), marginTop: 4 }} onClick={() => { setLookS({ ...CAD_LOOK }); saveUserSettings({ cadLook: { ...CAD_LOOK } }, user) }}>↺ Как было</button>
      </Fold>
    </div>}
    {tab === 'scene' && <SceneList project={project} setProject={setProject} parts={parts} selected={selected} onSelect={select} onAdd={addItem}
      library={library} onLibraryDelete={id => { if (window.confirm('Убрать из библиотеки?')) saveLibrary(library.filter(l => l.id !== id)) }}
      onFromLibrary={l => { const b = parts.length ? sceneBox(parts) : [0, 0, 0, 0, 0, 0]; const it = { ...JSON.parse(JSON.stringify(l.item)), id: newId(), pos: { x: parts.length ? Math.round(b[3]) : 0, y: 0, z: 0 } }; setProject({ ...project, items: [...project.items, it] }); setSelected(it.id); setTab('props') }} />}
    {tab === 'props' && multi && (() => {
      const sel = parts.filter(sp => multiSet.has(sp.pid))
      const mats = [...new Set(sel.map(sp => sp.material))]
      return <div className="card" style={{ padding: '8px 10px', marginBottom: 10, border: '1px solid #f59e0b' }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 6 }}>Выбрано деталей: {sel.length}{mats.length ? ` · ${mats.join(', ')}` : ''}</div>
        {sel.length > 0 ? <>
          <MatPick materials={materials} value={mats.length === 1 ? mats[0] : ''} onApply={applyMultiMat} />
          {mats.length === 1 && <MatLookEditor name={mats[0]} looks={matLooks} setLooks={setMatLooks} />}
          <JointPick customs={jointSchemes} value="" onChange={applyMultiJoint} label="Крепёж стыков выбранных деталей" />
        </> : <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: 0 }}>Нажимайте детали на модели — они добавятся в выбор (ещё раз — убрать).</p>}
      </div>
    })()}
    {tab === 'props' && blk && <BlockCard key={blk.n + blk.t} it={selCab} set={setItem} blk={blk} mount={mount} setMount={setMount} setBlk={b => setSelBlock(b ? { item: selCab.id, ...b } : null)} onClose={() => { setSelBlock(null); setSelPid(null) }} />}
    {tab === 'props' && selItem && (() => {
      const own = parts.filter(p => p.item.id === selItem.id && (p.kind === 'sheet'))
      const sp = own.find(p => p.pid === selPid)
      if (!own.length) return null
      return (
        <div className="card" style={{ padding: '8px 10px', marginBottom: 10 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Деталь:</span>
            <button type="button" style={{ ...btnS(), padding: '5px 9px' }} title="Выбрать несколько деталей и сменить им материал / цвет" onClick={() => { setMulti(true); setMultiSel(sp ? [sp.pid] : []); setSelBlock(null) }}>☑ Несколько</button>
            <select style={{ ...inp, width: 'auto', flex: 1, minWidth: 160, padding: '5px 6px' }} value={sp?.pid || ''} onChange={e => setSelPid(e.target.value || null)}>
              <option value="">— выберите (или нажмите в 3D) —</option>
              {own.map(p => <option key={p.pid} value={p.pid}>{p.name} · {p.place.L}×{p.place.W}{p.ov ? ' ✎' : ''}</option>)}
            </select>
          </div>
          {sp && <>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '6px 0' }}>{sp.place.L} × {sp.place.W} × {sp.place.T} мм · {sp.material}{sp.ov ? ' · изменена в редакторе' + (isFigured(sp) ? ' (фигурная / вырезы)' : '') : ''}</p>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button type="button" style={btnS(true)} onClick={() => {
                const map = projectDrill(project, pp).map
                const own2 = parts.filter(p => p.item.id === selItem.id)
                const d = partToDetail(sp, own2.indexOf(sp) + 1, map.get(sp.pid) || [])
                setEditPart({ pid: sp.pid, itemId: selItem.id, key: sp.key, draft: d })
              }}>✎ Контур, вырезы, присадка</button>
              {(sp.ov || sp.ovStale) && <button type="button" style={btnS()} onClick={() => {
                if (!window.confirm('Убрать правку детали (контур, вырезы, свою присадку и кромку)?')) return
                const ov = { ...(selItem.ov || {}) }; delete ov[sp.key]
                setItem({ ...selItem, ov })
              }}>↺ Сбросить правку</button>}
            </div>
            <div style={{ marginTop: 8 }}>
              <MatPick key={sp.pid} materials={materials} value={sp.material} onApply={v => { const m = { ...(selItem.mat || {}) }; if (v) m[sp.key] = v; else delete m[sp.key]; setItem({ ...selItem, mat: m }) }} />
              <MatLookEditor name={sp.material} looks={matLooks} setLooks={setMatLooks} />
              {matLooks?.[sp.material]?.tex && <label style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}><input type="checkbox" style={{ width: 'auto', margin: 0 }} checked={!!selItem.grain?.[sp.key]} onChange={e => { const g = { ...(selItem.grain || {}) }; if (e.target.checked) g[sp.key] = true; else delete g[sp.key]; setItem({ ...selItem, grain: g }) }} />Повернуть декор на этой детали</label>}
              {sp.kind === 'sheet' && <>
                <JointPick customs={jointSchemes} value={selItem.joint?.[sp.key]} onChange={v => { const j = { ...(selItem.joint || {}) }; if (v) j[sp.key] = v; else delete j[sp.key]; setItem({ ...selItem, joint: j }) }} />
                <PartJoints parts={parts} sp={sp} project={project} setProject={setProject} customs={jointSchemes} />
                <JointPick customs={jointSchemes} label="Крепёж во всём проекте (все стыки без своей схемы)" emptyText="" value={project.settings?.joint || PROJECT_DEFAULTS.joint} onChange={v => setProject({ ...project, settings: { ...project.settings, joint: v } })} />
                <Fold id="jschemes" title="Свои схемы крепежа" right="за аккаунтом"><JointSchemes customs={jointSchemes} setCustoms={setJointSchemes} /></Fold>
              </>}
            </div>
            <p style={{ fontSize: 11.5, color: 'var(--text-hint)', margin: '6px 0 0' }}>Присадка по стыкам и под фурнитуру пересчитывается сама; в редакторе добавляйте фигурный контур, вырезы, свою присадку и пазы. Поменяется размер детали — контур сбросится до прямоугольника.</p>
          </>}
        </div>
      )
    })()}
    {tab === 'props' && !blk && (selItem
      ? <ItemEditor key={selItem.id} it={selItem} set={setItem} info={info} selOpening={selOpening} setSelOpening={setSelOpening} mount={mount} setMount={setMount}
          sameKind={selItem.type === 'cabinet' ? project.items.filter(i => i.type === 'cabinet' && i.id !== selItem.id && (i.p?.kind || 'wardrobe') === (selItem.p?.kind || 'wardrobe')).length : 0}
          onApplyKind={gs => {
            const kind = selItem.p?.kind || 'wardrobe'
            const keys = gs.flatMap(g => CAB_GROUPS[g] || [])
            const src = { ...CAB_DEFAULTS, ...selItem.p }
            const patch = Object.fromEntries(keys.map(k => [k, src[k]]))
            const n = project.items.filter(i => i.type === 'cabinet' && i.id !== selItem.id && (i.p?.kind || 'wardrobe') === kind).length
            if (!window.confirm(`Применить к ${n} корпус(ам) этого типа?`)) return
            setProject({ ...project, items: project.items.map(i => (i.type === 'cabinet' && i.id !== selItem.id && (i.p?.kind || 'wardrobe') === kind ? { ...i, p: { ...i.p, ...patch } } : i)) })
          }}
          onToLibrary={() => { const name = window.prompt('Название в библиотеке:', selItem.name); if (!name) return; const item = { ...JSON.parse(JSON.stringify(selItem)), name: name.trim() }; saveLibrary([{ id: newId(), name: name.trim(), type: selItem.type, item }, ...library]); window.alert('Сохранено в «Моя библиотека» (вкладка «Сцена»)') }}
          onDelete={() => { if (!window.confirm(`Удалить «${selItem.name}»?`)) return; setProject({ ...project, items: project.items.filter(i => i.id !== selItem.id) }); setSelected(null); setTab('scene') }}
          onDuplicate={() => { const c = { ...JSON.parse(JSON.stringify(selItem)), id: newId(), name: selItem.name + ' (копия)' }; const own = parts.filter(p => p.item.id === selItem.id); const b = sceneBox(own); c.pos = { ...c.pos, x: Math.round((c.pos?.x || 0) + (b[3] - b[0])) }; setProject({ ...project, items: [...project.items, c] }); setSelected(c.id) }}
          onExplode={() => { if (!window.confirm('Разобрать корпус на отдельные панели? Параметры корпуса (пересчёт по габариту) пропадут — каждую панель можно будет менять отдельно.')) return; const ps = explodeCabinet(selItem); const idx = project.items.findIndex(i => i.id === selItem.id); const items = [...project.items]; items.splice(idx, 1, ...ps); setProject({ ...project, items }); setSelected(null); setTab('scene') }} />
      : <p style={{ fontSize: 13, color: 'var(--text-hint)' }}>Нажмите на деталь в 3D или выберите элемент во вкладке «Сцена». Чтобы передвинуть элемент, включите ✥ (справа на модели) и тащите его пальцем по полу — он прилипает к стенам и к соседям.</p>)}
    {tab === 'spec' && <SpecPanel project={project} setProject={setProject} onLinear={linearOk ? toLinear : null} />}
  </FoldCtx.Provider>)

  const head = (
    <div style={{ display: 'flex', alignItems: 'center', gap: desk ? 6 : 4, padding: desk || land ? '6px 10px' : '4px 0 6px', flexWrap: desk ? 'wrap' : 'nowrap', flex: '0 0 auto' }}>
      <MenuButton />
      <button type="button" title="Все проекты" onClick={() => { flush(); navigate('/constructor') }} style={{ border: 'none', background: 'none', color: 'var(--blue)', fontSize: 13, cursor: 'pointer', padding: 0, whiteSpace: 'nowrap' }}>{desk ? '‹ Проекты' : '‹'}</button>
      <input value={project.name} onChange={e => setProject({ ...project, name: e.target.value })} style={{ ...inp, flex: 1, minWidth: desk ? 120 : 60, fontWeight: 500, border: '0.5px solid transparent', background: 'transparent', padding: '6px 4px' }} />
      {desk && <span style={{ fontSize: 11, color: 'var(--text-hint)' }}>{status}</span>}
      {all3d && all3d.details.length > 0 && <Model3DButton details={all3d.details} title={project.name} getScene={async () => all3d.scene} label={desk ? '3D-просмотр' : '3D'} style={{ ...btnS(), width: 'auto', padding: desk ? '8px 12px' : '7px 9px' }} />}
      <button type="button" style={{ ...btnS(true), padding: desk ? '8px 12px' : '7px 10px' }} onClick={() => setToOrder(true)}>{desk ? 'В заказ →' : 'В заказ'}</button>
    </div>
  )

  const closePartEditor = () => {
    const ep = editPart
    setEditPart(null)
    if (!ep) return
    const cur = projRef.current
    const it = cur.items.find(i => i.id === ep.itemId)
    const sp = parts.find(p => p.pid === ep.pid)
    if (!it || !sp) return
    setProject({ ...cur, items: cur.items.map(i => (i.id === it.id ? { ...i, ov: { ...(i.ov || {}), [ep.key]: overrideFromDraft(sp, ep.draft) } } : i)) })
  }
  const dialog = (<>
    {toOrder && <ToOrderDialog project={project} onClose={() => setToOrder(false)} onGo={goOrder} />}
    {editPart && (
      <div style={{ position: 'fixed', inset: 0, zIndex: 950, background: 'var(--bg2)', overflowY: 'auto' }}>
        <Suspense fallback={<CncLoader label="Открываем редактор…" />}>
          <ContourEditor detail={editPart.draft} materialThickness={editPart.draft.thickness}
            onUpdate={u => setEditPart(ep => (ep ? { ...ep, draft: { ...ep.draft, contour: u.contour, edges: u.edges || ep.draft.edges } } : ep))}
            onClose={closePartEditor} />
        </Suspense>
      </div>
    )}
  </>)
  // нижнее меню в конструкторе не показываем — оно дублирует боковое (☰); вся высота — под картинку и карточку
  const navH = 8
  // телефон боком и компьютер: картинка и карточка рядом, между ними — ползунок; ширина карточки и сторона (слева / справа) — за аккаунтом
  if (desk || land) {
    const W = typeof window !== 'undefined' ? window.innerWidth : 1000
    const cardW = Math.max(260, Math.min(W - 260, sideW > 0 ? sideW : desk ? 420 : Math.round(W * 0.45)))
    const left = cardSide === 'left'
    const startSide = e => {
      e.preventDefault()
      const x0 = e.clientX, w0 = cardW
      let last = w0
      const mv = ev => { last = Math.max(260, Math.min(W - 260, w0 + (left ? ev.clientX - x0 : x0 - ev.clientX))); setSideW(last) }
      const upFn = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', upFn); saveUserSettings({ cadSideW: last }, user) }
      window.addEventListener('pointermove', mv); window.addEventListener('pointerup', upFn)
    }
    // ползунок между картинкой и карточкой (тянуть — шире / уже) и кнопка ⇄ — карточку на другую сторону
    const grip = <div style={{ flex: '0 0 22px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
      <button type="button" title="Карточку — на другую сторону" onClick={() => setCardSide(left ? 'right' : 'left')}
        style={{ width: 22, height: 22, borderRadius: 11, border: '0.5px solid var(--border-md)', background: 'var(--bg)', color: 'var(--text-muted)', fontSize: 12, padding: 0, cursor: 'pointer' }}>⇄</button>
      <div onPointerDown={startSide} style={{ width: 22, height: 90, display: 'flex', alignItems: 'center', justifyContent: 'center', touchAction: 'none', cursor: 'col-resize' }}>
        <div style={{ width: 6, height: 80, borderRadius: 3, background: 'var(--text-hint)' }} />
      </div>
    </div>
    const card = <div style={{ flex: `0 0 ${cardW}px`, minWidth: 0, overflowY: 'auto', paddingRight: 2 }}>{panel}</div>
    return (
      <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {head}
        <div style={{ flex: 1, minHeight: 0, display: 'flex', padding: '0 10px', paddingBottom: navH }}>
          {left && card}{left && grip}
          <div style={{ flex: '1 1 auto', minWidth: 0 }}>{view}</div>
          {!left && grip}{!left && card}
        </div>
        {dialog}
        <NavDrawer />
      </div>
    )
  }
  // телефон вертикально: экран делится на картинку и карточку параметров, между ними — ползунок (как у симуляции и карт раскроя);
  // карточка прокручивается сама, картинка стоит на месте; высота картинки запоминается за аккаунтом
  const viewH = splitPx > 0 ? splitPx : Math.round(window.innerHeight * (selCab ? 0.5 : 0.45))
  const startSplit = e => {
    e.preventDefault()
    const y0 = e.clientY, h0 = viewH
    let last = h0
    const mv = ev => { last = Math.max(160, Math.min(window.innerHeight - 160, h0 + ev.clientY - y0)); setSplitPx(last) }
    const upFn = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', upFn); saveUserSettings({ cadSplit: last }, user) }
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', upFn)
  }
  return (
    <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: '0 12px', paddingBottom: 'env(safe-area-inset-bottom)', boxSizing: 'border-box' }}>
      {head}
      <div style={{ height: viewH, flex: '0 0 auto' }}>{view}</div>
      <div onPointerDown={startSplit} style={{ flex: '0 0 auto', height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', touchAction: 'none', cursor: 'row-resize' }}>
        <div style={{ width: 54, height: 5, borderRadius: 3, background: 'var(--border-md)' }} />
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingBottom: 12 }}>{panel}</div>
      {dialog}
      <NavDrawer />
    </div>
  )
}
