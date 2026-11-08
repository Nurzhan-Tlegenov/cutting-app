// Конструктор мебели (бета: мастер-аккаунт и бета-тестеры «Конструктор»).
// Проект — сцена из элементов: параметрические корпуса, свободные панели, стекло, погонные профили (металл).
// Корпус задаётся параметрами (крышка/дно вкладные или накладные, ножки/цоколь, задняя стенка в паз / накладная,
// полки, стойки, ящики, фасады) — детали пересчитываются сами. «Разобрать» превращает корпус в свободные панели.
// «В заказ» — детали выбранного материала уходят в бланк нового заказа вместе с 3D-моделью
// (дальше — обычный раскрой, бирки, ЧПУ); «Смета» — плита и стекло в м², профили в метрах и хлыстах, фурнитура.
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { MenuButton } from '../components/NavDrawer'
import BottomNav from '../components/BottomNav'
import Hint from '../components/Hint'
import CadView from '../components/CadView'
import Model3DButton from '../components/Model3DButton'
import CncLoader from '../components/CncLoader'
import { useDesktop } from '../hooks/useDesktop'
import { useBackClose } from '../lib/backStack'
import { hasBeta } from '../lib/beta'
import { packScene } from '../lib/basisB3d'
import { CAB_DEFAULTS, CAB_PRESETS } from '../lib/cadCabinet'
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

// ── редактор корпуса ──
function CabinetEditor({ it, set }) {
  const p = { ...CAB_DEFAULTS, ...it.p }
  const up = patch => set({ ...it, p: { ...p, ...patch } })
  return (<>
    <div style={sect}>Шаблон</div>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 6 }}>
      {CAB_PRESETS.map(([k, t, v]) => <button key={k} type="button" style={chipS(false)}
        onClick={() => { if (window.confirm(`Заменить параметры корпуса шаблоном «${t}»?`)) set({ ...it, name: t, p: { ...CAB_DEFAULTS, ...v, material: p.material, t: p.t, facadeMaterial: p.facadeMaterial, backMaterial: p.backMaterial } }) }}>{t}</button>)}
    </div>
    <div style={sect}>Габарит</div>
    <Grid><NumField label="Ширина" value={p.W} onChange={v => up({ W: v })} min={50} /><NumField label="Высота" value={p.H} onChange={v => up({ H: v })} min={50} /><NumField label="Глубина" value={p.D} onChange={v => up({ D: v })} min={50} /></Grid>
    <div style={sect}>Каркас</div>
    <Grid cols={2}><TextField label="Материал" value={p.material} onChange={v => up({ material: v })} list="cad-mats" /><NumField label="Толщина" value={p.t} onChange={v => up({ t: v })} min={1} /></Grid>
    <Chips label="Крышка" value={p.top} onChange={v => up({ top: v })} options={[['inset', 'Вкладная'], ['overlay', 'Накладная'], ['rails', 'Царги'], ['none', 'Нет']]}
      hint="Вкладная — между боковинами, накладная — сверху на боковинах. Царги — две планки спереди и сзади (нижние модули кухни под столешницу)." />
    <Chips label="Дно" value={p.bottom} onChange={v => up({ bottom: v })} options={[['inset', 'Вкладное'], ['overlay', 'Накладное']]} />
    <Chips label="Опора" value={p.base} onChange={v => up({ base: v })} options={[['none', 'Без опоры'], ['legs', 'Ножки'], ['plinth', 'Цоколь']]}
      hint="Ножки — корпус поднят на высоту ножек. Цоколь при вкладном дне — боковины до пола, цоколь между ними с отступом от фасада; при накладном — корпус стоит на цокольной раме." />
    {p.base === 'legs' && <Grid><NumField label="Высота ножек" value={p.legH} onChange={v => up({ legH: v })} min={0} /></Grid>}
    {p.base === 'plinth' && <Grid cols={2}><NumField label="Высота цоколя" value={p.plinthH} onChange={v => up({ plinthH: v })} min={0} /><NumField label="Отступ цоколя" value={p.plinthInset} onChange={v => up({ plinthInset: v })} min={0} /></Grid>}
    {p.top === 'rails' && <Grid><NumField label="Ширина царги" value={p.railDepth} onChange={v => up({ railDepth: v })} min={20} /></Grid>}

    <div style={sect}>Задняя стенка</div>
    <Chips value={p.back} onChange={v => up({ back: v })} options={[['groove', 'В паз'], ['overlay', 'Накладная'], ['inset', 'Вкладная ЛДСП'], ['none', 'Нет']]}
      hint="В паз — ХДФ в пазу боковин, дна и крышки (паз попадает в детали заказа). Накладная — ХДФ на задние торцы, меньше габарита на 1 мм с каждой стороны. Вкладная — из материала каркаса между боковинами." />
    {(p.back === 'groove' || p.back === 'overlay') && <Grid cols={2}><TextField label="Материал задней" value={p.backMaterial} onChange={v => up({ backMaterial: v })} list="cad-mats" /><NumField label="Толщина" value={p.backT} onChange={v => up({ backT: v })} min={1} /></Grid>}
    {p.back === 'groove' && <Grid><NumField label="Паз от зад. торца" value={p.grooveOffset} onChange={v => up({ grooveOffset: v })} min={0} /><NumField label="Глубина паза" value={p.grooveDepth} onChange={v => up({ grooveDepth: v })} min={1} /><NumField label="Ширина паза" value={p.grooveWidth} onChange={v => up({ grooveWidth: v })} min={1} /></Grid>}

    <div style={sect}>Наполнение</div>
    <Chips value={p.fill} onChange={v => up({ fill: v })} options={[['shelves', 'Полки и стойки'], ['drawers', 'Ящики']]} />
    {p.fill !== 'drawers' ? <>
      <Grid><NumField label="Стоек" unit="" value={p.partitions} onChange={v => up({ partitions: Math.max(0, Math.round(v)) })} min={0} /><NumField label="Полок в секции" unit="" value={p.shelves} onChange={v => up({ shelves: Math.max(0, Math.round(v)) })} min={0} /><NumField label="Отступ полки от переда" value={p.shelfSetback} onChange={v => up({ shelfSetback: v })} min={0} /></Grid>
      <Chips label="Полки" value={p.shelfType} onChange={v => up({ shelfType: v })} options={[['fixed', 'Неподвижные'], ['loose', 'Съёмные']]}
        hint="Съёмная полка на полкодержателях — меньше проёма на 1 мм с каждой стороны." />
    </> : <>
      <Grid><NumField label="Ящиков" unit="" value={p.drawers} onChange={v => up({ drawers: Math.max(1, Math.round(v)) })} min={1} /><NumField label="Длина направл." value={p.slideLen} onChange={v => up({ slideLen: v })} min={150} /><NumField label="Зазор на направл." value={p.slideGap} onChange={v => up({ slideGap: v })} min={0} /></Grid>
      <Chips label="Короб ящика" value={p.box} onChange={v => up({ box: v })} options={[['ldsp_overlay', 'ЛДСП, дно накладное'], ['ldsp_groove', 'ЛДСП, дно в паз'], ['metal', 'Металлобокс']]}
        hint="Металлобокс — металлические боковины (в фурнитуру), из плиты только дно и задняя стенка; ширину дна уменьшаем на величину из каталога производителя." />
      {p.box === 'metal'
        ? <Grid><NumField label="Дно уже проёма на" value={p.metalReduce} onChange={v => up({ metalReduce: v })} min={0} /></Grid>
        : <Grid><NumField label="Короб ниже фасада на" value={p.boxTopGap} onChange={v => up({ boxTopGap: v })} min={0} /><NumField label="Толщина дна" value={p.boxBottomT} onChange={v => up({ boxBottomT: v })} min={1} /><TextField label="Материал дна" value={p.boxBottomMaterial} onChange={v => up({ boxBottomMaterial: v })} list="cad-mats" /></Grid>}
    </>}

    <div style={sect}>Фасады</div>
    {p.fill !== 'drawers' && <Chips label="Дверей" value={p.doors} onChange={v => up({ doors: v })} options={[[0, 'Нет'], [1, '1'], [2, '2'], [3, '3'], [4, '4']]} />}
    <Grid><NumField label="Зазор" value={p.gap} onChange={v => up({ gap: v })} min={0} /><NumField label="Толщина фасада" value={p.facadeT} onChange={v => up({ facadeT: v })} min={1} /><TextField label="Материал фасада" value={p.facadeMaterial} onChange={v => up({ facadeMaterial: v })} list="cad-mats" /></Grid>

    <div style={sect}>Кромка<Hint inline>Название вида кромки — как в бланке заказа (толщину и подрезку задаёте там). Каркас — передние торцы, фасады — по периметру.</Hint></div>
    <Grid><TextField label="Каркас спереди" value={p.edgeFront} onChange={v => up({ edgeFront: v })} /><TextField label="Фасады" value={p.edgeFacade} onChange={v => up({ edgeFacade: v })} /><TextField label="Прочее" value={p.edgeBody} onChange={v => up({ edgeBody: v })} /></Grid>
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
      <label style={{ fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 5, alignSelf: 'end', paddingBottom: 8 }}><input type="checkbox" checked={!!p.topShelf} onChange={e => up({ topShelf: e.target.checked })} />верхняя</label></Grid>}
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

function ItemEditor({ it, set, onDelete, onDuplicate, onExplode, onToLibrary, info }) {
  return (
    <div>
      <Grid cols={1}><TextField label="Название" value={it.name} onChange={v => set({ ...it, name: v })} /></Grid>
      <div style={sect}>Положение в сцене<Hint inline>X, Y, Z — левый нижний задний угол элемента. Поворот — вокруг вертикали.</Hint></div>
      <Grid>{['x', 'y', 'z'].map(k => <NumField key={k} label={k.toUpperCase()} value={it.pos?.[k] ?? 0} onChange={v => set({ ...it, pos: { ...it.pos, [k]: v } })} />)}</Grid>
      <Nudge it={it} set={set} />
      <Chips label="Поворот" value={it.rotY || 0} onChange={v => set({ ...it, rotY: v })} options={[[0, '0°'], [90, '90°'], [180, '180°'], [270, '270°']]} />
      {info && <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 6px' }}>{info}</p>}
      {it.type === 'cabinet' && <CabinetEditor it={it} set={set} />}
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
    <label style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}><input type="checkbox" checked={st.hardwareHoles !== false} onChange={e => setSt({ hardwareHoles: e.target.checked })} />Отверстия фурнитуры: петли (чашка Ø35 и планка), полкодержатели, направляющие</label>
    <label style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center', marginBottom: 10 }}><input type="checkbox" checked={st.rotatable !== false} onChange={e => setSt({ rotatable: e.target.checked })} />Детали можно вращать при раскрое (без текстуры)</label>
    <label style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}><input type="checkbox" checked={!!room.on} onChange={e => setSt({ room: { ...room, on: e.target.checked } })} />Комната: стены слева, сзади и справа</label>
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
  const [selPid, setSelPid] = useState(null)        // выбранная деталь внутри элемента (нажатие в 3D)
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
  const select = (id, pid = null) => { setSelected(id); setSelPid(id ? pid : null); if (id) setTab('props') }

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
      <p style={{ fontSize: 14, color: 'var(--text-muted)' }}>Конструктор мебели сейчас в бета-тесте. Доступ выдаёт мастер-аккаунт.</p><BottomNav /></div>
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
      <BottomNav />
    </div>
  )

  if (!project) return <div className="page">{error ? <p className="error-text">{error}</p> : <CncLoader label="Открываем проект…" />}<BottomNav /></div>

  const info = selItem ? (() => {
    const own = parts.filter(p => p.item.id === selItem.id)
    if (!own.length) return ''
    const b = sceneBox(own)
    return `Габарит: ${Math.round(b[3] - b[0])} × ${Math.round(b[4] - b[1])} × ${Math.round(b[5] - b[2])} мм · деталей ${own.filter(p => p.kind === 'sheet').length}`
  })() : ''

  const view = (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <CadView parts={parts} selected={selected} selectedPid={selPid} onSelect={select} onDrag={onDrag} xray={xray} fitKey={fitKey} holes={holes} room={room} />
      <div style={{ position: 'absolute', right: 8, top: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <button type="button" title="Показать всё" style={{ ...btnS(), padding: '6px 9px' }} onClick={() => setFitKey(k => k + 1)}>⤢</button>
        <button type="button" title="Полупрозрачный вид" style={{ ...btnS(), padding: '6px 9px', ...(xray ? { color: 'var(--blue)', borderColor: 'var(--blue)' } : {}) }} onClick={() => setXray(v => !v)}>◫</button>
        <button type="button" title="Показать присадку" style={{ ...btnS(), padding: '6px 9px', ...(showHoles ? { color: 'var(--blue)', borderColor: 'var(--blue)' } : {}) }} onClick={() => setShowHoles(v => !v)}>⊙</button>
      </div>
      {project.items.length > 0 && (() => { const b = sceneBox(parts); return <div style={{ position: 'absolute', left: 8, bottom: 6, fontSize: 11, color: 'var(--text-muted)', background: 'rgba(255,255,255,0.75)', borderRadius: 6, padding: '1px 6px' }}>{Math.round(b[3] - b[0])} × {Math.round(b[4] - b[1])} × {Math.round(b[5] - b[2])}</div> })()}
    </div>
  )
  const panel = (<>
    <datalist id="cad-mats">{materials.map(m => <option key={m} value={m} />)}</datalist>
    <div style={{ display: 'flex', gap: 5, marginBottom: 10, flexWrap: 'wrap' }}>
      {[['scene', 'Сцена'], ['props', 'Свойства'], ['spec', 'Смета']].map(([k, t]) => <button key={k} type="button" style={chipS(tab === k)} onClick={() => setTab(k)}>{t}</button>)}
    </div>
    {tab === 'scene' && <SceneList project={project} setProject={setProject} parts={parts} selected={selected} onSelect={select} onAdd={addItem}
      library={library} onLibraryDelete={id => { if (window.confirm('Убрать из библиотеки?')) saveLibrary(library.filter(l => l.id !== id)) }}
      onFromLibrary={l => { const b = parts.length ? sceneBox(parts) : [0, 0, 0, 0, 0, 0]; const it = { ...JSON.parse(JSON.stringify(l.item)), id: newId(), pos: { x: parts.length ? Math.round(b[3]) : 0, y: 0, z: 0 } }; setProject({ ...project, items: [...project.items, it] }); setSelected(it.id); setTab('props') }} />}
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
    {tab === 'props' && (selItem
      ? <ItemEditor key={selItem.id} it={selItem} set={setItem} info={info}
          onToLibrary={() => { const name = window.prompt('Название в библиотеке:', selItem.name); if (!name) return; const item = { ...JSON.parse(JSON.stringify(selItem)), name: name.trim() }; saveLibrary([{ id: newId(), name: name.trim(), type: selItem.type, item }, ...library]); window.alert('Сохранено в «Моя библиотека» (вкладка «Сцена»)') }}
          onDelete={() => { if (!window.confirm(`Удалить «${selItem.name}»?`)) return; setProject({ ...project, items: project.items.filter(i => i.id !== selItem.id) }); setSelected(null); setTab('scene') }}
          onDuplicate={() => { const c = { ...JSON.parse(JSON.stringify(selItem)), id: newId(), name: selItem.name + ' (копия)' }; const own = parts.filter(p => p.item.id === selItem.id); const b = sceneBox(own); c.pos = { ...c.pos, x: Math.round((c.pos?.x || 0) + (b[3] - b[0])) }; setProject({ ...project, items: [...project.items, c] }); setSelected(c.id) }}
          onExplode={() => { if (!window.confirm('Разобрать корпус на отдельные панели? Параметры корпуса (пересчёт по габариту) пропадут — каждую панель можно будет менять отдельно.')) return; const ps = explodeCabinet(selItem); const idx = project.items.findIndex(i => i.id === selItem.id); const items = [...project.items]; items.splice(idx, 1, ...ps); setProject({ ...project, items }); setSelected(null); setTab('scene') }} />
      : <p style={{ fontSize: 13, color: 'var(--text-hint)' }}>Нажмите на деталь в 3D или выберите элемент во вкладке «Сцена». Выбранный элемент (синий) можно тащить пальцем по полу — он прилипает к стенам и к соседям.</p>)}
    {tab === 'spec' && <SpecPanel project={project} setProject={setProject} onLinear={linearOk ? toLinear : null} />}
  </>)

  const head = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: desk || land ? '6px 10px' : '4px 0 8px', flexWrap: 'wrap' }}>
      <MenuButton />
      <button type="button" onClick={() => { flush(); navigate('/constructor') }} style={{ border: 'none', background: 'none', color: 'var(--blue)', fontSize: 13, cursor: 'pointer', padding: 0 }}>‹ Проекты</button>
      <input value={project.name} onChange={e => setProject({ ...project, name: e.target.value })} style={{ ...inp, flex: 1, minWidth: 120, fontWeight: 500, border: '0.5px solid transparent', background: 'transparent' }} />
      <span style={{ fontSize: 11, color: 'var(--text-hint)' }}>{status}</span>
      {all3d && all3d.details.length > 0 && <Model3DButton details={all3d.details} title={project.name} getScene={async () => all3d.scene} label="3D-просмотр" style={{ ...btnS(), width: 'auto' }} />}
      <button type="button" style={btnS(true)} onClick={() => setToOrder(true)}>В заказ →</button>
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
  // телефон боком: нижнее меню не показываем — вся высота под сцену и свойства (меню — кнопкой ☰)
  const navH = desk ? 64 : 8
  if (desk || land) return (
    <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {head}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: 8, padding: '0 10px', paddingBottom: navH }}>
        <div style={{ flex: desk ? '1 1 62%' : '1 1 55%', minWidth: 0 }}>{view}</div>
        <div style={{ flex: desk ? '0 0 420px' : '0 0 45%', minWidth: 0, overflowY: 'auto', paddingRight: 2 }}>{panel}</div>
      </div>
      {dialog}
      {desk && <BottomNav />}
    </div>
  )
  return (
    <div className="page" style={{ paddingBottom: 100 }}>
      {head}
      <div style={{ height: '44vh', minHeight: 240, marginBottom: 10 }}>{view}</div>
      {panel}
      {dialog}
      <BottomNav />
    </div>
  )
}
