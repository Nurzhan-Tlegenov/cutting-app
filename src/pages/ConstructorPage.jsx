// Конструктор мебели (бета: мастер-аккаунт и бета-тестеры «Конструктор»).
// Проект — сцена из элементов: параметрические корпуса, свободные панели, стекло, погонные профили (металл).
// Корпус задаётся параметрами (крышка/дно вкладные или накладные, ножки/цоколь, задняя стенка в паз / накладная,
// полки, стойки, ящики, фасады) — детали пересчитываются сами. «Разобрать» превращает корпус в свободные панели.
// «В заказ» — детали выбранного материала уходят в бланк нового заказа вместе с 3D-моделью
// (дальше — обычный раскрой, бирки, ЧПУ); «Смета» — плита и стекло в м², профили в метрах и хлыстах, фурнитура.
import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { MenuButton } from '../components/NavDrawer'
import Hint from '../components/Hint'
import CadView from '../components/CadView'
import Model3DButton from '../components/Model3DButton'
import CncLoader from '../components/CncLoader'
import { useDesktop } from '../hooks/useDesktop'
import { useBackClose } from '../lib/backStack'
import { hasBeta } from '../lib/beta'
import { packScene } from '../lib/basisB3d'
import { CAB_DEFAULTS, CAB_PRESETS, CAB_KINDS, CAB_GROUPS, treeOf, findNode, cabinetParts, opSplit, opSetSize, opPatch, opFront, opCount, opRemovePanel, opReplace } from '../lib/cadCabinet'
import { FRAME_DEFAULTS, FRAME_PRESETS } from '../lib/cadFrame'
import { JOINTS } from '../lib/cadDrill'
import { getUserSettings, saveUserSettings } from '../lib/userSettings'
import { newLinearJob, readJobs, writeJobs, LINEAR_FEATURE } from '../lib/linearJobs'
import { newProject, newItem, projectParts, projectSpec, sheetGroups, exportForOrder, exportAll, explodeCabinet, sceneBox, newId, projectDrill, partToDetail, overrideFromDraft, isFigured, PROJECT_DEFAULTS } from '../lib/cadModel'
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
  border: `1px solid ${on ? 'var(--blue)' : 'var(--border-md)'}`, background: on ? 'var(--blue)' : 'rgba(255,255,255,0.94)', color: on ? 'white' : dis ? '#aab' : 'var(--text)', opacity: dis ? 0.6 : 1 })
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
    ['d1', '▯', 'Дверь', () => front({ type: 'doors', n: 1, hinge: 'left' }), !node, node?.front?.type === 'doors' && node.front.n === 1],
    ['d2', '▯▯', '2 двери', () => front({ type: 'doors', n: 2, hinge: 'auto' }), !node, node?.front?.type === 'doors' && node.front.n > 1],
    ['dr', '☰', 'Ящики', () => front({ type: 'drawers', n: 3 }), !node || !leaf, node?.front?.type === 'drawers'],
    ['nf', '∅', 'Без фас.', () => front(null), !node || !node.front],
    ['x', '✕', 'Убрать', () => { if (node && window.confirm('Убрать панели этого проёма и всё внутри?')) apply(opPatch(tree, node.id, n => { n.split = null; n.children = [] })) }, !node || leaf],
  ]
  return (
    <div style={{ position: 'absolute', left: 6, top: 6, display: 'flex', flexDirection: 'column', gap: 3, zIndex: 3, pointerEvents: 'none' }}>
      <button type="button" style={{ ...toolBtn(showSizes), pointerEvents: 'auto' }} onClick={() => setShowSizes(v => !v)} title="Размеры проёмов на модели">📏<br />Разм.</button>
      {!node && <div style={{ fontSize: 8.5, width: 40, color: 'var(--text-muted)', background: 'rgba(255,255,255,0.8)', borderRadius: 6, padding: 2, textAlign: 'center' }}>нажмите проём</div>}
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
    <div style={{ position: 'absolute', left: 58, right: 6, bottom: 6, maxHeight: '48%', overflowY: 'auto', zIndex: 3, background: 'rgba(255,255,255,0.96)', border: '1px solid var(--blue)', borderRadius: 10, padding: '6px 9px', boxShadow: '0 2px 10px rgba(0,0,0,0.12)' }}>
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
const blockTitle = (node, t) => t === 'fpanel' ? 'Фронтальная панель'
  : t === 'front' ? (node?.front?.type === 'drawers' ? `Ящики · ${node.front.n}` : `Двери · ${node?.front?.n || 1}`)
    : node?.split === 'v' ? `Вертикальные панели · ${(node.children?.length || 1) - 1}` : `Горизонтальные панели · ${(node?.children?.length || 1) - 1}`
const blocksOf = node => [
  ...(node?.split && node.children?.length > 1 ? [{ n: node.id, t: 'split' }] : []),
  ...(node?.fpanel ? [{ n: node.id, t: 'fpanel' }] : []),
  ...(node?.front ? [{ n: node.id, t: 'front' }] : []),
]

function BlockCard({ it, set, blk, setBlk, onClose }) {
  const p = { ...CAB_DEFAULTS, ...it.p }
  const tree = treeOf(p)
  const ops = useMemo(() => cabinetParts(p).openings || [], [it.p]) // eslint-disable-line react-hooks/exhaustive-deps
  const r = findNode(tree, blk.n)
  const node = r?.node
  const o = ops.find(x => x.id === blk.n)
  const alive = node && (blk.t === 'split' ? node.split && node.children?.length > 1 : blk.t === 'fpanel' ? !!node.fpanel : !!node.front)
  if (!alive) return <div className="card" style={{ padding: '10px 12px', marginBottom: 10, fontSize: 13 }}>Блок убран. <button type="button" style={btnS()} onClick={onClose}>← К корпусу</button></div>
  const apply = t => { if (t) set({ ...it, p: { ...p, tree: t } }) }
  const patch = fn => apply(opPatch(tree, node.id, fn))
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

      {blk.t === 'front' && fr?.type === 'doors' && <>
        <Grid cols={3}><NumField label="Сколько" unit="шт" value={fr.n} onChange={v => v >= 1 && apply(opFront(tree, node.id, { ...fr, n: Math.min(6, Math.round(v)) }))} min={1} /></Grid>
        <Chips label="Расположение" value={fr.layout || 'v'} onChange={v => apply(opFront(tree, node.id, { ...fr, layout: v }))} options={[['v', 'Рядом'], ['h', 'Друг над другом']]} />
        {(fr.n === 1 || fr.layout === 'h') && <Chips label="Открывание" value={fr.open || (fr.hinge === 'right' ? 'right' : 'left')} onChange={v => apply(opFront(tree, node.id, { ...fr, open: v, hinge: v }))} options={[['left', '← влево'], ['right', 'вправо →'], ['up', '↑ вверх'], ['down', '↓ вниз']]} />}
      </>}
      {blk.t === 'front' && fr?.type === 'drawers' && <>
        <Grid cols={2}>
          <NumField label="Сколько" unit="шт" value={fr.n} onChange={v => v >= 1 && apply(opFront(tree, node.id, { ...fr, n: Math.min(10, Math.round(v)) }))} min={1} />
          <NumField label="Длина направляющих" value={fr.slideLen ?? p.slideLen} onChange={v => v >= 150 && apply(opFront(tree, node.id, { ...fr, slideLen: v }))} min={0} />
          <NumField label="Короб от низа фасада" value={fr.boxBottom ?? 15} onChange={v => apply(opFront(tree, node.id, { ...fr, boxBottom: v }))} min={0} />
          <NumField label="Короб от верха фасада" value={fr.boxTop ?? Math.max(0, (num(p.boxTopGap) ?? 40) - 15)} onChange={v => apply(opFront(tree, node.id, { ...fr, boxTop: v }))} min={0} />
        </Grid>
      </>}

      <div style={{ ...sect, marginTop: 4 }}>Заменить на</div>
      <div style={row}>
        {blk.t === 'split' && <button type="button" style={chipS(false)} onClick={() => replace(isH ? 'v' : 'h')}>{isH ? '│ Вертикальные' : '─ Горизонтальные'}</button>}
        {!(blk.t === 'front' && fr?.type === 'drawers') && <button type="button" style={chipS(false)} onClick={() => replace('drawers', blk.t === 'split' ? ch.length - 1 : 3)}>☰ Ящики</button>}
        {!(blk.t === 'front' && fr?.type === 'doors') && blk.t !== 'fpanel' && <button type="button" style={chipS(false)} onClick={() => replace('doors', 1)}>▯ Дверь</button>}
        {!(blk.t === 'front' && fr?.type === 'doors') && blk.t !== 'fpanel' && <button type="button" style={chipS(false)} onClick={() => replace('doors', 2)}>▯▯ 2 двери</button>}
        {blk.t === 'front' && <button type="button" style={chipS(false)} onClick={() => { apply(opReplace(opFront(tree, node.id, null), node.id, 'h', fr?.type === 'drawers' ? Math.max(1, fr.n - 1) : 2)); setBlk({ n: node.id, t: 'split' }) }}>─ Полки</button>}
        <button type="button" style={{ ...chipS(false), color: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={() => {
          if (!window.confirm('Убрать этот блок?')) return
          if (blk.t === 'split') { if (ch.some(c => c.split || c.front || c.fpanel) && !window.confirm('Внутри есть наполнение — оно тоже пропадёт. Убрать?')) return; apply(opReplace(tree, node.id, null)) }
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

function CabinetEditor({ it, set, selOpening, setSelOpening, sameKind, onApplyKind }) {
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
          onClick={() => { if (window.confirm(`Заменить параметры корпуса шаблоном «${tt}»?`)) set({ ...it, name: tt, p: { ...CAB_DEFAULTS, ...v, material: p.material, t: p.t, facadeMaterial: p.facadeMaterial, backMaterial: p.backMaterial } }) }}>{tt}</button>)}
      </div>
    </Fold>
    <Fold id="size" title="Габарит" def right={`${p.W}×${p.H}×${p.D}`}>
      <Grid><NumField label="Ширина" value={p.W} onChange={v => up({ W: v })} min={50} /><NumField label="Высота" value={p.H} onChange={v => up({ H: v })} min={50} /><NumField label="Глубина" value={p.D} onChange={v => up({ D: v })} min={50} /></Grid>
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

function ItemEditor({ it, set, onDelete, onDuplicate, onExplode, onToLibrary, info, selOpening, setSelOpening, sameKind, onApplyKind }) {
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
      {it.type === 'cabinet' && <CabinetEditor it={it} set={set} selOpening={selOpening} setSelOpening={setSelOpening} sameKind={sameKind} onApplyKind={onApplyKind} />}
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
  const [showSizes, setShowSizes] = useState(true)   // размеры проёмов на модели
  // свернутые / развёрнутые разделы карточки и высота картинки на телефоне — запоминаются за аккаунтом
  const [fold, setFold] = useState(() => { try { return getUserSettings(user)?.cadFold || {} } catch { return {} } })
  const foldApi = useMemo(() => ({
    isOpen: (id, def) => (fold[id] == null ? def : !!fold[id]),
    toggle: (id, v) => { const next = { ...fold, [id]: v }; setFold(next); saveUserSettings({ cadFold: next }, user) },
  }), [fold, user])
  const [splitPx, setSplitPx] = useState(() => { try { return getUserSettings(user)?.cadSplit || 0 } catch { return 0 } })
  // подсветка кромки в 3D: цвет, прозрачность, «яркая» (светится сквозь детали) — за аккаунтом
  const [edgeLook, setEdgeLookS] = useState(() => { try { return { on: true, color: '#f97316', opacity: 1, glow: false, ...(getUserSettings(user)?.cadEdgeLook || {}) } } catch { return { on: true, color: '#f97316', opacity: 1, glow: false } } })
  const setEdgeLook = patch => setEdgeLookS(l => { const n = { ...l, ...patch }; saveUserSettings({ cadEdgeLook: n }, user); return n })
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
    loadProject(user.id, pid).then(p => { if (!a) return; if (!p) { setError('Проект не найден'); return } projRef.current = p; setProjectState(p); setSelected(null); setFitKey(k => k + 1) }).catch(e => { if (a) setError(e.message) })
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
  const setItem = next => setProject({ ...project, items: project.items.map(i => (i.id === next.id ? next : i)) })

  const addItem = type => {
    const b = parts.length ? sceneBox(parts) : [0, 0, 0, 0, 0, 0]
    const it = newItem(type)
    it.pos = { x: parts.length ? Math.round(b[3] + (type === 'cabinet' ? 0 : 50)) : 0, y: 0, z: 0 }
    if (type === 'cabinet') it.name = `Корпус ${project.items.filter(i => i.type === 'cabinet').length + 1}`
    setProject({ ...project, items: [...project.items, it] })
    setSelected(it.id); setTab('props')
  }
  const select = (id, pid = null, opening = null, extra = null) => {
    setSelected(id); setSelPid(id ? pid : null); setSelOpening(id ? opening : null)
    setSelBlock(id && extra?.blk ? { item: id, ...extra.blk } : null)
    if (id) setTab('props')
  }

  const createNew = async () => {
    const name = window.prompt('Название проекта:', 'Новый проект')
    if (name == null) return
    const p = newProject(name.trim() || 'Новый проект')
    p.items.push({ ...newItem('cabinet'), name: 'Шкаф' })
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
      <p style={{ fontSize: 14, color: 'var(--text-muted)' }}>Конструктор мебели сейчас в бета-тесте. Доступ выдаёт мастер-аккаунт.</p></div>
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
        labels={sizeLabels} onLabel={id => { setSelOpening(id); setTab('props') }} moveMode={moveMode} edgeLook={edgeLook} hiPids={hiPids}>
        {selCab && <OpeningTools it={selCab} set={setItem} sel={selOpening} setSel={setSelOpening} showSizes={showSizes} setShowSizes={setShowSizes} />}
        {selCab && selOpening && !blk && <OpeningPanel it={selCab} set={setItem} sel={selOpening} setSel={setSelOpening} pull={pull} setPull={setPull} onBlock={b => { setSelBlock({ item: selCab.id, ...b }); setSelPid(null); setTab('props') }} />}
        {blk && <div style={{ position: 'absolute', left: 58, bottom: 6, zIndex: 3, display: 'flex', gap: 4, alignItems: 'center', background: 'rgba(255,255,255,0.95)', border: '1px solid #f59e0b', borderRadius: 14, padding: '3px 4px 3px 10px', fontSize: 12.5 }}>
          <b>{blockTitle(findNode(treeOf({ ...CAB_DEFAULTS, ...selCab.p }), blk.n)?.node, blk.t)}</b>
          <button type="button" style={{ border: 'none', background: 'none', fontSize: 15, cursor: 'pointer', color: 'var(--text-muted)' }} onClick={() => setSelBlock(null)}>✕</button>
        </div>}
      </CadView>
      <div style={{ position: 'absolute', right: 8, top: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <button type="button" title="Показать всё" style={{ ...btnS(), padding: '6px 9px' }} onClick={() => setFitKey(k => k + 1)}>⤢</button>
        <button type="button" title="Полупрозрачный вид" style={{ ...btnS(), padding: '6px 9px', ...(xray ? { color: 'var(--blue)', borderColor: 'var(--blue)' } : {}) }} onClick={() => setXray(v => !v)}>◫</button>
        <button type="button" title="Подсветка кромки" style={{ ...btnS(), padding: '6px 9px', ...(edgeLook.on ? { color: edgeLook.color, borderColor: edgeLook.color } : {}) }} onClick={() => setEdgeLook({ on: !edgeLook.on })}>▭</button>
        <button type="button" title="Двигать выбранный элемент пальцем по полу" style={{ ...btnS(), padding: '6px 9px', ...(moveMode ? { color: 'white', background: 'var(--blue)', borderColor: 'var(--blue)' } : {}) }} onClick={() => setMoveMode(v => !v)}>✥</button>
        <button type="button" title="Показать присадку" style={{ ...btnS(), padding: '6px 9px', ...(showHoles ? { color: 'var(--blue)', borderColor: 'var(--blue)' } : {}) }} onClick={() => setShowHoles(v => !v)}>⊙</button>
      </div>
      {project.items.length > 0 && (() => { const b = sceneBox(parts); return <div style={{ position: 'absolute', right: 8, bottom: 4, fontSize: 11, color: 'var(--text-muted)', background: 'rgba(255,255,255,0.75)', borderRadius: 6, padding: '1px 6px' }}>{Math.round(b[3] - b[0])} × {Math.round(b[4] - b[1])} × {Math.round(b[5] - b[2])}</div> })()}
    </div>
  )
  const panel = (<FoldCtx.Provider value={foldApi}>
    <datalist id="cad-mats">{materials.map(m => <option key={m} value={m} />)}</datalist>
    <div style={{ display: 'flex', gap: 5, marginBottom: 10, flexWrap: 'wrap' }}>
      {[['scene', 'Сцена'], ['props', 'Свойства'], ['spec', 'Смета']].map(([k, t]) => <button key={k} type="button" style={chipS(tab === k)} onClick={() => setTab(k)}>{t}</button>)}
    </div>
    {tab === 'scene' && <div className="card" style={{ padding: '8px 10px', marginBottom: 10 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', fontSize: 13 }}>
        <label style={{ display: 'flex', gap: 5, alignItems: 'center' }}><input type="checkbox" style={{ width: 'auto', margin: 0 }} checked={edgeLook.on} onChange={e => setEdgeLook({ on: e.target.checked })} /><b>Подсветка кромки</b></label>
        <label style={{ display: 'flex', gap: 5, alignItems: 'center' }}>цвет<input type="color" value={edgeLook.color} onChange={e => setEdgeLook({ color: e.target.value })} style={{ width: 34, height: 24, padding: 0, border: 'none', background: 'none' }} /></label>
        <label style={{ display: 'flex', gap: 5, alignItems: 'center' }}>прозрачность<input type="range" min="0.1" max="1" step="0.05" value={edgeLook.opacity} onChange={e => setEdgeLook({ opacity: Number(e.target.value) })} style={{ width: 90 }} /></label>
        <label style={{ display: 'flex', gap: 5, alignItems: 'center' }}><input type="checkbox" style={{ width: 'auto', margin: 0 }} checked={!!edgeLook.glow} onChange={e => setEdgeLook({ glow: e.target.checked })} />яркая (видна сквозь детали)</label>
      </div>
    </div>}
    {tab === 'scene' && <SceneList project={project} setProject={setProject} parts={parts} selected={selected} onSelect={select} onAdd={addItem}
      library={library} onLibraryDelete={id => { if (window.confirm('Убрать из библиотеки?')) saveLibrary(library.filter(l => l.id !== id)) }}
      onFromLibrary={l => { const b = parts.length ? sceneBox(parts) : [0, 0, 0, 0, 0, 0]; const it = { ...JSON.parse(JSON.stringify(l.item)), id: newId(), pos: { x: parts.length ? Math.round(b[3]) : 0, y: 0, z: 0 } }; setProject({ ...project, items: [...project.items, it] }); setSelected(it.id); setTab('props') }} />}
    {tab === 'props' && blk && <BlockCard key={blk.n + blk.t} it={selCab} set={setItem} blk={blk} setBlk={b => setSelBlock(b ? { item: selCab.id, ...b } : null)} onClose={() => { setSelBlock(null); setSelPid(null) }} />}
    {tab === 'props' && selItem && (() => {
      const own = parts.filter(p => p.item.id === selItem.id && (p.kind === 'sheet'))
      const sp = own.find(p => p.pid === selPid)
      if (!own.length) return null
      return (
        <div className="card" style={{ padding: '8px 10px', marginBottom: 10 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Деталь:</span>
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
            <p style={{ fontSize: 11.5, color: 'var(--text-hint)', margin: '6px 0 0' }}>Присадка по стыкам и под фурнитуру пересчитывается сама; в редакторе добавляйте фигурный контур, вырезы, свою присадку и пазы. Поменяется размер детали — контур сбросится до прямоугольника.</p>
          </>}
        </div>
      )
    })()}
    {tab === 'props' && !blk && (selItem
      ? <ItemEditor key={selItem.id} it={selItem} set={setItem} info={info} selOpening={selOpening} setSelOpening={setSelOpening}
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
  if (desk || land) return (
    <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {head}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: 8, padding: '0 10px', paddingBottom: navH }}>
        <div style={{ flex: desk ? '1 1 62%' : '1 1 55%', minWidth: 0 }}>{view}</div>
        <div style={{ flex: desk ? '0 0 420px' : '0 0 45%', minWidth: 0, overflowY: 'auto', paddingRight: 2 }}>{panel}</div>
      </div>
      {dialog}
    </div>
  )
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
    </div>
  )
}
