// Управляющие программы по отдельным деталям (кабинет производства → карточка заказа → список деталей).
// Зачем: деталь после раскроя испортили, а форматника и шестистороннего станка нет — её вырезают на том же фрезере
// из заготовки чуть больше (деловой остаток): одна деталь, со всей обработкой (присадка, пазы, вырезы, контур).
// Программа — тем же генератором и по тем же настройкам постпроцессора и «Обработки» (в т.ч. «Выводить в УП»), что и
// программы листов. Деталь стоит как в раскрое (тот же поворот), «лист» — заготовка «деталь + отступ с каждой стороны»:
// обработка начинается с отступа X / Y от нуля станка. Отступы — настройка аккаунта (запоминаются).
import { useEffect, useMemo, useState, Suspense } from 'react'
import { createPortal } from 'react-dom'
import { useAuth } from '../context/AuthContext'
import { useCnc } from '../hooks/useCnc'
import { routerPost, postView } from '../lib/cncSettings'
import { buildSheetGcode, partFeatures, skipOf } from '../lib/gcode'
import { roughShapePolygons } from '../lib/trueShapeNesting'
import { mirrorContour } from '../lib/mirrorDetail'
import { cornerOf } from '../lib/sheetCorner'
import { PO_RULES, poOf, poBest } from '../lib/partOrient'
import { parseGcode, fmtTime } from '../lib/gcodeSim'
import { cornerShift } from '../lib/sheetCorner'
import { lazyRetry } from '../lib/lazyRetry'
import { useBackClose } from '../lib/backStack'
import CncLoader from './CncLoader'
import { savedNestings, sheetGeo, dropDetailsFromNesting } from '../lib/savedNesting'
import { productionDeleteDetails, productionStripDrilling } from '../lib/productionApi'
import { cutDetails, parseEdgeTypes } from '../lib/edgeCut'
import { getUserSettings, saveUserSettings } from '../lib/userSettings'
import { toLatin } from '../lib/orderUtils'
import { detailMeta } from '../lib/partLabel'
import { isTwoSided } from '../lib/partInfo'
import SaveFilesDialog from './SaveFilesDialog'
import QrPartsEditor from './QrPartsEditor'
import { labelInfo, labelQr } from '../lib/labelMaker'
import Hint from './Hint'

const n0 = v => Number(String(v ?? '').replace(',', '.')) || 0
// Имя программы детали — тем же конструктором, что QR бирки и имя файла шестистороннего (запоминается за аккаунтом).
// В конце имени всегда обозначение (или позиция) детали — иначе у разных деталей имена совпадут.
const PART_NAME_DEFAULT = { tpl: '{ZAKAZ}_{MAT}_{NAIM}_{OBOZ}', sep: '_', latin: true }
const BAD = /[\\/:*?"<>|\s]+/g
const GcodeSimulator = lazyRetry(() => import('./GcodeSimulator'))   // тот же симулятор, что у программ листов
function download(name, data) {
  const url = URL.createObjectURL(new Blob([data], { type: 'text/plain' }))
  const a = document.createElement('a')
  a.href = url; a.download = name
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

// Что выводить в программы деталей (поверх «Обработки»: отключённое там и так не выводится) и как резать внешний контур
// stops — Г-образный упор для деталей «к упору»: свой угол, не угол укладки листов постпроцессора (тот — для раскроя листов)
const STOPS = [['bl', 'Нижний и левый'], ['tl', 'Верхний и левый'], ['tr', 'Верхний и правый'], ['br', 'Нижний и правый']]
const PP_DEFAULT = { place: 'nest', outer: 'full', stops: 'bl', what: { through: true, blind: true, grooves: true, pockets: true, cutouts: true } }
const WHAT = [['blind', 'Глухие отверстия в пласть'], ['through', 'Сквозные отверстия'], ['grooves', 'Пазы'], ['pockets', 'Выемки'], ['cutouts', 'Внутренние вырезы']]
const OUTER = [['full', 'Резать целиком'], ['shaped', 'Резать только фигурные участки'], ['none', 'Не резать']]
const swapF = f => (f === 'front' ? 'back' : f === 'back' ? 'front' : f)
/** Деталь, перевёрнутая изнанкой вверх (через длинную сторону: лево ↔ право): лицо и изнанка меняются местами */
function flipRow(d, T) {
  let c = d.contour
  if (typeof c === 'string') { try { c = JSON.parse(c) } catch { c = null } }
  if (!c) return d
  const W = n0(d.width), m = mirrorContour(c, W) || {}
  const thr = dr => !(n0(dr.depth) > 0) || n0(dr.depth) >= T - 0.05            // сквозное видно с обеих сторон
  const drillings = (m.drillings || []).map(dr => {
    const x = { ...dr }
    if (x.kind === 'edge') x.offsetFace = Math.round((T - (x.offsetFace ?? T / 2)) * 10) / 10
    else if (!thr(x)) x.face = swapF(x.face || 'front')
    if (x.pairFace) x.pairFace = swapF(x.pairFace)
    if (Array.isArray(x.extraHoles)) x.extraHoles = x.extraHoles.map(eh => (eh.kind === 'face' ? { ...eh, face: swapF(eh.face || 'front') } : eh))
    return x
  })
  const grooves = (m.grooves || []).map(g => ({ ...g, face: swapF(g.face || 'front') }))
  const holes = (m.holes || []).map(h => (h.type === 'pocket' ? { ...h, face: swapF(h.face || 'front') } : h))
  const decor = (m.decor || []).map(dc => ({ ...dc, face: swapF(dc.face || 'front'), ...(Array.isArray(dc.path) ? { path: [...dc.path].reverse().map(([x, y]) => [W - x, y]) } : {}) }))
  return { ...d, contour: JSON.stringify({ ...m, drillings, grooves, holes, decor }) }
}
/** Деталь на станке «к упору»: свой поворот (0…3 четверти) и переворот -> { p, det } (p — в нуле детали) */
function ownPlace(det, T, o) {
  const rot = (((o?.rot || 0) % 4) + 4) % 4, d = o?.flip ? flipRow(det, T) : det
  const W = n0(d.width), H = n0(d.length), odd = rot % 2 === 1, pw = odd ? H : W, ph = odd ? W : H
  let polygon
  try { polygon = roughShapePolygons(d)[rot * 90].map(([x, y]) => ({ x, y })) } catch { polygon = undefined }
  return { det: d, p: { detailIndex: 0, x: 0, y: 0, origX: pw, origY: ph, w: pw, h: ph, rotation: rot * 90, rotated: odd, label: d.name, ...(polygon ? { polygon } : {}) } }
}
/** Миниатюра: деталь как ляжет на станок, отверстия и вырезы, угол нуля (упор) */
function PartMini({ p, det, T, corner, w = 150, h: hMax = 90, fit = false }) {
  let f
  try { f = partFeatures(p, det, T) } catch { return null }
  const pw = n0(p.origX), ph = n0(p.origY), pad = 8, k = Math.min((w - 2 * pad) / (pw || 1), (hMax - 2 * pad) / (ph || 1))
  const X = x => pad + x * k, Y = y => pad + (ph - y) * k, H = ph * k + 2 * pad
  const c = cornerOf(corner), cx = c === 'br' || c === 'tr' ? X(pw) : X(0), cy = c === 'tl' || c === 'tr' ? Y(ph) : Y(0)
  return (
    <svg width={fit ? '100%' : pw * k + 2 * pad} height={fit ? '100%' : H} viewBox={`0 0 ${pw * k + 2 * pad} ${H}`} preserveAspectRatio="xMidYMid meet"
      style={{ display: 'block', flex: '0 0 auto', ...(fit ? { maxWidth: '100%', maxHeight: '100%' } : {}) }}>
      <polygon points={f.outline.map(([x, y]) => `${X(x)},${Y(y)}`).join(' ')} fill="var(--bg2)" stroke="var(--text-muted)" strokeWidth="1" />
      {f.cutouts.map((cu, i) => (cu.circle ? <circle key={'c' + i} cx={X(cu.circle.cx)} cy={Y(cu.circle.cy)} r={cu.circle.r * k} fill="var(--bg)" stroke="var(--text-muted)" />
        : <polygon key={'c' + i} points={cu.pts.map(([x, y]) => `${X(x)},${Y(y)}`).join(' ')} fill="var(--bg)" stroke="var(--text-muted)" />))}
      {f.pockets.map((q, i) => <rect key={'k' + i} x={X(q.x0)} y={Y(q.y1)} width={(q.x1 - q.x0) * k} height={(q.y1 - q.y0) * k} fill="var(--amber-light)" stroke="var(--amber)" strokeWidth="0.6" />)}
      {f.grooves.map((g, i) => (g.x0 != null ? <rect key={'g' + i} x={X(g.x0)} y={Y(g.y1)} width={Math.max(1, (g.x1 - g.x0) * k)} height={Math.max(1, (g.y1 - g.y0) * k)} fill="var(--blue)" opacity="0.5" /> : null))}
      {f.holes.map((h, i) => <circle key={'h' + i} cx={X(h.x)} cy={Y(h.y)} r={Math.max(1.2, h.d / 2 * k)} fill="var(--danger)" />)}
      <circle cx={cx} cy={cy} r="4" fill="var(--blue)" />
    </svg>
  )
}

export default function PartPrograms({ order, details, selected, onClear, onChanged, canProg = true , fullSig = 0}) {
  const { user } = useAuth()
  const { cnc, ready } = useCnc(null, order?.production_id || null)
  const [off, setOff] = useState(() => ({ x: 10, y: 10, ...(getUserSettings(user).partProg || {}) }))
  const [res, setRes] = useState(null)           // { files, notes }
  const [save, setSave] = useState(false)
  const [sim, setSim] = useState(null)           // программа в симуляторе
  useBackClose(!!sim, () => setSim(null))        // «назад» на телефоне закрывает симулятор, а не страницу
  const setO = patch => { const v = { ...off, ...patch }; setOff(v); setRes(null); saveUserSettings({ partProg: { ...v, name: nameQ, pp } }, user) }
  const mats = useMemo(() => savedNestings(order, cutDetails(details, parseEdgeTypes(order?.edge_types))), [order, details])
  const [nameQ, setNameQ] = useState(() => ({ ...PART_NAME_DEFAULT, ...(getUserSettings(user).partProg?.name || {}) }))
  const [nameEdit, setNameEdit] = useState(false)
  const [busy, setBusy] = useState('')
  const [done, setDone] = useState('')
  // что выводить и где деталь: как в раскрое или «к упору» со своим поворотом / переворотом (запоминается за аккаунтом)
  const [pp, setPp0] = useState(() => { const v = getUserSettings(user).partProg?.pp || {}; return { ...PP_DEFAULT, ...v, what: { ...PP_DEFAULT.what, ...(v.what || {}) } } })
  const setPp = patch => { const v = { ...pp, ...patch }; setPp0(v); setRes(null); saveUserSettings({ partProg: { ...off, name: nameQ, pp: v } }, user) }
  // положение деталей «к упору»: по правилам (как у шестистороннего, только вместо лап — Г-образный упор у нуля станка);
  // поворот / переворот руками — ручное положение детали, важнее правил («Сброс» — снова по правилам)
  const [orient, setOrient] = useState({})       // id -> { rot, flip } — ручное положение
  const po = poOf(pp.po)
  const autoOf = id => {
    const h = findHit(id)
    if (!h) return { rot: 0, flip: false }
    const T = n0(h.mat.thickness) || 16, det = h.mat.details[h.p.detailIndex]
    return poBest(o => ownPlace(det, T, o), T, pp.stops, po)
  }
  const effOf = id => orient[id] || autoOf(id)
  const setOr = (id, patch) => { setOrient(o => ({ ...o, [id]: { ...effOf(id), ...(o[id] || {}), ...patch } })); setRes(null) }
  const setPo = patch => setPp({ po: { ...po, ...patch } })
  const [ppOpen, setPpOpen] = useState(false)
  const [open, setOpen] = useState({ a: true, b: true })     // разделы настроек
  // во весь экран: большой просмотр детали + список деталей и настройки справа («Выбрать детали с обработкой» открывает сразу)
  const [full, setFull] = useState(false)
  const [act, setAct] = useState(null)
  useEffect(() => { if (fullSig > 0) Promise.resolve().then(() => { setFull(true); setPpOpen(true) }) }, [fullSig])
  useEffect(() => {
    if (!full) return
    const k = e => { if (e.key === 'Escape') setFull(false) }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [full])
  // у скольких выбранных деталей есть присадка (отверстия в пласть и в торец)
  const drilled = selected.filter(id => {
    const d = details.find(x => x.id === id)
    let c = d?.contour
    if (typeof c === 'string') { try { c = JSON.parse(c) } catch { c = null } }
    return (c?.drillings || []).length > 0
  })
  const nm = id => { const d = details.find(x => x.id === id); return [detailMeta(d)?.des, d?.name].filter(Boolean).join(' ') || 'Деталь' }
  const list = ids => ids.slice(0, 8).map(nm).join(', ') + (ids.length > 8 ? ` и ещё ${ids.length - 8}` : '')
  // удалить детали из заказа: из карт раскроя они убираются, остальные остаются на своих местах (перекроить — по желанию)
  const delParts = async () => {
    if (!window.confirm(`Удалить из заказа ${selected.length === 1 ? 'деталь' : `детали (${selected.length})`}: ${list(selected)}?\nИз карт раскроя ${selected.length === 1 ? 'она уберётся' : 'они уберутся'}, остальные детали останутся на местах. Отменить нельзя.`)) return
    setBusy('del'); setDone('')
    const nx = dropDetailsFromNesting(order, details, selected)
    const r = await productionDeleteDetails(order.id, selected, nx.value)
    setBusy('')
    if (r.error) { window.alert('Не удалось удалить: ' + r.error); return }
    setRes(null); onClear?.(); onChanged?.()
    if (nx.reset.length) window.alert(`Раскрой под пильный центр (${nx.reset.join(', ')}) сброшен — перекроите этот материал.`)
  }
  // удалить всю присадку у деталей: отверстия в пласть и в торец; пазы, выемки, вырезы и контур остаются
  const stripDrill = async () => {
    if (!drilled.length) return
    if (!window.confirm(`Удалить всю присадку (отверстия в пласть и в торец) у ${drilled.length === 1 ? 'детали' : `деталей (${drilled.length})`}: ${list(drilled)}?\nПазы, выемки, вырезы и контур останутся. Отменить нельзя.`)) return
    setBusy('drill'); setDone('')
    const r = await productionStripDrilling(order.id, drilled)
    setBusy('')
    if (r.error) { window.alert('Не удалось удалить присадку: ' + r.error); return }
    setRes(null); onChanged?.()
    setDone(`Присадка удалена у ${r.data ?? drilled.length} дет. Программы и бирки этого заказа создайте заново.`)
  }
  const setName = v => { setNameQ(v); setRes(null); saveUserSettings({ partProg: { ...off, name: v, pp } }, user) }
  // где деталь стоит в раскрое на фрезере -> { mat, sh, p, si, pi } или null
  const findHit = id => {
    for (const mat of mats) {
      if (mat.result?.beamSaw) continue
      const di = mat.details.findIndex(d => d.id === id)
      if (di < 0) continue
      for (let si = 0; si < (mat.sheets || []).length; si++) {
        const sh = mat.sheets[si], pi = (sh.placed || []).findIndex(q => q.detailIndex === di)
        if (pi >= 0) return { mat, sh, p: sh.placed[pi], si, pi }
      }
    }
    return null
  }
  // имя файла без расширения: по шаблону; в конце — обозначение / позиция детали (если шаблон их не дал в конце)
  const partName = (hit, latin) => {
    let info
    try { info = labelInfo(order, hit.mat, hit.si, hit.pi) } catch { info = {} }
    const lat = t => (latin ? toLatin(t) : String(t))
    const clean = t => lat(String(t || '')).replace(BAD, '_').replace(/_{2,}/g, '_').replace(/^[_.-]+|[_.-]+$/g, '')
    let name = clean(labelQr({ qr: { ...nameQ, parts: [], latin } }, info))
    // уже кончается обозначением или позицией — так и оставляем; иначе дописываем обозначение (нет его — позицию)
    const ends = [info.des, info.pos].map(clean).filter(Boolean)
    const tail = clean(info.des || info.pos || (info.num ? `N${info.num}` : ''))
    if (tail && !ends.some(e => name.endsWith(e))) name = name ? `${name}${nameQ.sep ?? '_'}${tail}` : tail
    return name || 'part'
  }

  const build = () => {
    const post = routerPost(cnc)
    if (!post) { setRes({ files: [], notes: ['Нет раскроечного станка (фрезера) в настройках ЧПУ.'] }); return }
    const ox = Math.max(0, n0(off.x)), oy = Math.max(0, n0(off.y))
    const files = [], notes = [], used = new Set()
    for (const id of selected) {
      const row = details.find(d => d.id === id)
      const label = [detailMeta(row)?.des, row?.name].filter(Boolean).join(' ') || 'Деталь'
      const hit = findHit(id)
      if (!hit) { notes.push(`«${label}» — нет в раскрое на фрезере, программа не создана.`); continue }
      const { mat, sh } = hit
      // «к упору»: деталь в нуле станка со своим поворотом / переворотом; иначе — как в раскрое
      const own = pp.place === 'own' ? ownPlace(mat.details[hit.p.detailIndex], n0(mat.thickness) || 16, effOf(id)) : null
      const p = own ? own.p : hit.p, dets = own ? [own.det] : mat.details
      const pw = n0(p.origX), ph = n0(p.origY)
      const g0 = sheetGeo(order, mat.result, sh)
      // «к упору»: ноль программы — в углу упоров (своя настройка), а не в углу укладки листов; смещения нуля постпроцессора
      // не берутся — отступ от упоров задаётся здесь же (X / Y)
      const pst = own ? { ...post, corner: cornerOf(pp.stops), originX: 0, originY: 0 } : post
      const cncP = own ? { ...cnc, posts: cnc.posts.map(q => (q.id === post.id ? pst : q)) } : cnc
      const geo = { ...g0, sheetW: pw + 2 * ox, sheetL: ph + 2 * oy, marginL: 0, marginR: 0, marginT: 0, marginB: 0, usableX: pw + 2 * ox, usableY: ph + 2 * oy, ...(own ? { corner: pst.corner } : {}) }
      const sheet = { placed: [{ ...p, x: ox, y: oy }], manualOffcuts: [] }
      const skipOver = Object.fromEntries(WHAT.filter(([k]) => !pp.what[k]).map(([k]) => [k, true]))
      const r = buildSheetGcode({ sheet, geo, details: dets, thickness: mat.thickness, cnc: { ...cncP, post: post.id }, score: false, outerMode: pp.outer, skipOver: { contour: false, ...skipOver } })
      // для симулятора: заготовка и контур детали в координатах программы (как у листов на странице ЧПУ)
      const view = postView({ ...cncP, post: post.id })
      const z = cornerShift(pst.corner, geo.sheetW, geo.sheetL)
      const sx = n0(pst.originX) + z.dx, sy = n0(pst.originY) + z.dy
      const outline = partFeatures(sheet.placed[0], dets[p.detailIndex], mat.thickness, skipOf(view.ops)).outline.map(([x, y]) => [sx + ox + x, sy + oy + y])
      const simData = { text: r.text, kinds: r.kinds, opIds: r.opIds, zShift: r.zShift, thickness: mat.thickness, rapid: n0(post.rapid) || 20000,
        sheet: { x: sx, y: sy, w: geo.sheetW, l: geo.sheetL }, outlines: [outline],
        tools: view.tools || [], head: post.drillHead ? (view.tools || []).filter(t => t.type === 'drill' && t.inHead).map(t => Math.round(n0(t.t))) : [] }
      let time
      try { time = parseGcode(r.text, { rapid: simData.rapid, zShift: r.zShift }).time } catch { time = 0 }
      const base = partName(hit, post.progLatin !== false)
      let name = base
      for (let k = 2; used.has(name); k++) name = `${base}_${k}`
      used.add(name)
      files.push({ name: `${name}.${post.ext || 'nc'}`, data: r.text, sim: simData, time, empty: !!r.empty, label, size: `${Math.round(pw)} × ${Math.round(ph)}`, blank: `${Math.round(pw + 2 * ox)} × ${Math.round(ph + 2 * oy)}`, warnings: r.warnings || [] })
      if (isTwoSided(row, mat.thickness)) notes.push(`«${label}» — обработка с двух сторон: в программе только ${own && effOf(id).flip ? 'изнанка (деталь перевёрнута)' : 'лицевая сторона'}, другую сторону — отдельной программой (переверните деталь).`)
    }
    setRes({ files, notes })
  }


  const chipS = on => ({ padding: '5px 10px', borderRadius: 14, fontSize: 12, cursor: 'pointer', border: `0.5px solid ${on ? 'var(--blue)' : 'var(--border-md)'}`, background: on ? 'var(--blue)' : 'transparent', color: on ? 'white' : 'var(--text)' })
  // положение детали для просмотра: «к упору» — своё, иначе как в раскрое
  const viewOf = id => {
    const h = findHit(id)
    if (!h) return null
    const T = n0(h.mat.thickness) || 16
    if (pp.place === 'own') { const o = effOf(id), pl = ownPlace(h.mat.details[h.p.detailIndex], T, o); return { ...pl, T, o, hand: !!orient[id] } }
    return { p: h.p, det: h.mat.details[h.p.detailIndex], T, o: null, hand: false }
  }
  const partBtns = (id, o, hand, chip = chipS) => (
    <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
      <button type="button" style={chip(false)} onClick={() => setOr(id, { rot: ((o.rot || 0) + 1) % 4 })}>⟳ 90°</button>
      <button type="button" style={chip(!!o.flip)} onClick={() => setOr(id, { flip: !o.flip })}>⇅ Перевернуть</button>
      {hand && <button type="button" style={chip(false)} onClick={() => { setOrient(x => { const n = { ...x }; delete n[id]; return n }); setRes(null) }}>Сброс</button>}
    </div>
  )
  function partRows(chip) {
    return selected.map(id => {
      const h = findHit(id)
      if (!h) return null
      const T = n0(h.mat.thickness) || 16, o = effOf(id), hand = !!orient[id], pl = ownPlace(h.mat.details[h.p.detailIndex], T, o)
      return (
        <div key={id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '6px 0', borderTop: '0.5px solid var(--border)' }}>
          <PartMini p={pl.p} det={pl.det} T={T} corner={pp.stops} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12.5, fontWeight: 500 }}>{nm(id)}</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-hint)' }}>{Math.round(n0(pl.p.origX))} × {Math.round(n0(pl.p.origY))} · {o.flip ? 'изнанкой вверх' : 'лицом вверх'} · {hand ? <span style={{ color: 'var(--amber)' }}>вручную</span> : 'по правилам'}</div>
            {partBtns(id, o, hand, chip)}
          </div>
        </div>
      )
    })
  }
  function settingsEl(withList) {
    // разделы сворачиваются (во весь экран — чтобы список деталей был виден целиком)
    const sec = (k, title, sum) => (
      <div role="button" tabIndex={0} onClick={() => setOpen(o => ({ ...o, [k]: !o[k] }))} onKeyDown={e => { if (e.key === 'Enter') setOpen(o => ({ ...o, [k]: !o[k] })) }}
        style={{ display: 'flex', gap: 6, alignItems: 'baseline', cursor: 'pointer', padding: '6px 0 2px', borderTop: k === 'a' ? 'none' : '0.5px solid var(--border)', marginTop: k === 'a' ? 0 : 6 }}>
        <span style={{ color: 'var(--text-hint)', width: 12 }}>{open[k] ? '▼' : '▶'}</span>
        <b style={{ fontSize: 13 }}>{title}</b>
        {!open[k] && <span style={{ fontSize: 11.5, color: 'var(--text-hint)', flex: 1, minWidth: 0 }}>{sum}</span>}
      </div>
    )
          const chip = on => ({ padding: '5px 10px', borderRadius: 14, fontSize: 12, cursor: 'pointer', border: `0.5px solid ${on ? 'var(--blue)' : 'var(--border-md)'}`, background: on ? 'var(--blue)' : 'transparent', color: on ? 'white' : 'var(--text)' })
    return (
      <div style={{ marginTop: 8, fontSize: 13 }}>
        {sec('a', 'Что делаем с деталью', `контур: ${(OUTER.find(o => o[0] === pp.outer)?.[1] || '').toLowerCase()}${WHAT.some(([k]) => !pp.what[k]) ? ' · есть отключённое' : ''} · ${pp.place === 'own' ? 'к упору' : 'как в раскрое'}`)}
        {open.a && <>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0' }}>Внешний контур детали — резать?</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{OUTER.map(([k, l]) => <button key={k} type="button" style={chip(pp.outer === k)} onClick={() => setPp({ outer: k })}>{l}</button>)}</div>
        <Hint>«Не резать» — фрезер как присадочный станок: деталь уже раскроена (на форматнике), делается только обработка. «Только фигурные участки» — радиусы, улыбки, вырезы по краю, с заходом и выходом вдоль прямой стороны.</Hint>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', margin: '8px 0 2px' }}>Обработка</div>
        {WHAT.map(([k, l]) => (
          <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', cursor: 'pointer' }}>
            <input type="checkbox" checked={!!pp.what[k]} onChange={e => setPp({ what: { ...pp.what, [k]: e.target.checked } })} style={{ width: 17, height: 17 }} />{l}
          </label>
        ))}
        <Hint>Отключённое в «Обработке» постпроцессора и так не выводится. Отверстия в торец фрезер не делает.</Hint>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', margin: '8px 0 4px' }}>Как лежит деталь</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button type="button" style={chip(pp.place === 'nest')} onClick={() => setPp({ place: 'nest' })}>Как в раскрое</button>
          <button type="button" style={chip(pp.place === 'own')} onClick={() => setPp({ place: 'own' })}>К упору — свой поворот</button>
        </div>
        </>}
        {pp.place === 'own' && sec('b', 'Упоры и правила положения', `упоры: ${(STOPS.find(x => x[0] === cornerOf(pp.stops))?.[1] || '').toLowerCase()} · ${po.order.filter(k => po.on[k]).length} правил`)}
        {pp.place === 'own' && open.b && (
          <>
            <Hint>Деталь прижата к Г-образному упору (синяя точка — его угол) с отступом X / Y. Положение выбирается по правилам — сверху важнее; поворот или переворот руками — своё положение детали.</Hint>
            <div style={{ border: '0.5px solid var(--border)', borderRadius: 'var(--radius)', padding: '4px 8px', margin: '4px 0 6px' }}>
              <div style={{ fontSize: 12, fontWeight: 500, margin: '2px 0' }}>Упоры (Г-образный) — где они у станка</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 4 }}>{STOPS.map(([k, l]) => <button key={k} type="button" style={{ ...chip(cornerOf(pp.stops) === k), padding: '3px 9px', fontSize: 11.5 }} onClick={() => setPp({ stops: k })}>{l}</button>)}</div>
              <div style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 4 }}>Ноль программы — в углу упоров. Своя настройка: угол укладки листов в постпроцессоре не меняется.</div>
              <div style={{ fontSize: 12, fontWeight: 500, margin: '6px 0 2px' }}>Правила положения</div>
              {po.order.map((k, i, arr) => {
                const dirs = k === 'cutouts' || k === 'holes' ? [['away', 'от упоров'], ['to', 'к упорам']] : k === 'grooves' || k === 'long' ? [['x', 'X'], ['y', 'Y']] : null
                return (
                  <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', padding: '4px 0', borderTop: i ? '0.5px solid var(--border)' : 'none', opacity: k === 'faceUp' && !po.allowFlip ? 0.55 : 1 }}>
                    <input type="checkbox" checked={!!po.on[k]} onChange={e => setPo({ on: { ...po.on, [k]: e.target.checked } })} style={{ width: 16, height: 16 }} />
                    <span style={{ flex: 1, minWidth: 140, fontSize: 12.5 }}>{i + 1}. {PO_RULES[k]}{k === 'faceUp' && !po.allowFlip ? ' — нужен переворот' : ''}</span>
                    {dirs && po.on[k] && dirs.map(([v, l]) => <button key={v} type="button" style={{ ...chip(po.dir[k] === v), padding: '3px 8px', fontSize: 11.5 }} onClick={() => setPo({ dir: { ...po.dir, [k]: v } })}>{l}</button>)}
                    <button type="button" disabled={i === 0} title="Выше (важнее)" onClick={() => { const o = [...arr]; [o[i - 1], o[i]] = [o[i], o[i - 1]]; setPo({ order: o }) }} style={{ padding: '2px 8px', borderRadius: 8, border: '0.5px solid var(--border-md)', background: 'var(--bg)', color: i === 0 ? 'var(--text-hint)' : 'var(--text)' }}>↑</button>
                    <button type="button" disabled={i === arr.length - 1} title="Ниже" onClick={() => { const o = [...arr]; [o[i + 1], o[i]] = [o[i], o[i + 1]]; setPo({ order: o }) }} style={{ padding: '2px 8px', borderRadius: 8, border: '0.5px solid var(--border-md)', background: 'var(--bg)', color: i === arr.length - 1 ? 'var(--text-hint)' : 'var(--text)' }}>↓</button>
                  </div>
                )
              })}
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, padding: '4px 0', borderTop: '0.5px solid var(--border)', cursor: 'pointer' }}>
                <input type="checkbox" checked={!!po.allowFlip} onChange={e => setPo({ allowFlip: e.target.checked })} style={{ width: 16, height: 16 }} />
                Разрешить переворот изнанкой вверх
              </label>
            </div>
            {Object.keys(orient).some(id => selected.includes(id)) && <button type="button" style={{ ...chip(false), marginBottom: 4 }} onClick={() => { setOrient({}); setRes(null) }}>Сбросить ручное положение у всех</button>}
            {withList && partRows(chip)}
          </>
        )}
      </div>
    )
  }
  function resultsEl() {
    return res && (
        <div style={{ marginTop: 8 }}>
          {res.files.map(f => (
            <div key={f.name} style={{ fontSize: 12.5, padding: '5px 0', borderTop: '0.5px solid var(--border)' }}>
              <b>{f.label}</b> · деталь {f.size} · заготовка не меньше {f.blank}{f.time ? ` · ≈ ${fmtTime(f.time)}` : ''} <span style={{ color: 'var(--text-hint)' }}>· {f.name}</span>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                {!f.empty && <button type="button" onClick={() => setSim(f)} style={{ padding: '4px 10px', fontSize: 12, borderRadius: 14, border: '0.5px solid var(--blue)', background: 'var(--blue-light)', color: 'var(--blue-dark)', cursor: 'pointer' }}>▶ Симулятор</button>}
                <button type="button" onClick={() => download(f.name, f.data)} style={{ padding: '4px 10px', fontSize: 12, borderRadius: 14, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text)', cursor: 'pointer' }}>⬇ Скачать</button>
              </div>
              {f.warnings.map((w, i) => <div key={i} style={{ fontSize: 11.5, color: 'var(--amber)' }}>⚠ {w}</div>)}
            </div>
          ))}
          {res.notes.map((n, i) => <div key={i} style={{ fontSize: 12, color: 'var(--amber)', marginTop: 4 }}>⚠ {n}</div>)}
          {res.files.length > 0 && <button type="button" className="btn-primary" onClick={() => setSave(true)} style={{ marginTop: 8, background: 'var(--teal)', borderColor: 'var(--teal)' }}>⬇ Сохранить {res.files.length === 1 ? 'программу' : `программы (${res.files.length})`}</button>}
        </div>
      )
  }
  const inp = { width: 70, padding: '6px 8px', textAlign: 'center' }
  return (
    <div style={{ position: 'sticky', bottom: 72, zIndex: 30, marginTop: 8, padding: '10px 12px', borderRadius: 'var(--radius-lg)', background: 'var(--bg)', border: '1px solid var(--blue)', boxShadow: '0 4px 14px rgba(0,0,0,.12)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <b style={{ fontSize: 14 }}>Выбрано деталей: {selected.length}</b>
        <span style={{ flex: 1 }} />
        {canProg && <button type="button" onClick={() => { setFull(true); setPpOpen(true) }} style={{ padding: '4px 10px', fontSize: 12, borderRadius: 14, border: '0.5px solid var(--blue)', background: 'transparent', color: 'var(--blue)', cursor: 'pointer' }}>⛶ Во весь экран</button>}
        <button type="button" onClick={onClear} style={{ padding: '4px 10px', fontSize: 12, borderRadius: 14, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}>Снять выбор</button>
      </div>
      {/* программы на отдельные детали — только для раскроя на фрезере (у пильного центра — только удалить) */}
      {canProg && (<>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 8, fontSize: 13 }}>
        <span style={{ color: 'var(--text-muted)' }}>{pp.place === 'own' ? 'Отступ от упоров:' : 'Отступ от нуля станка:'}</span>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>X <input type="text" inputMode="decimal" key={`x${off.x}`} defaultValue={off.x} onBlur={e => setO({ x: Math.max(0, n0(e.target.value)) })} style={inp} /> мм</label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>Y <input type="text" inputMode="decimal" key={`y${off.y}`} defaultValue={off.y} onBlur={e => setO({ y: Math.max(0, n0(e.target.value)) })} style={inp} /> мм</label>
      </div>
      {(() => {
        const post = routerPost(cnc), h = selected.length ? findHit(selected[0]) : null
        const ex = h ? `${partName(h, post?.progLatin !== false)}.${post?.ext || 'nc'}` : ''
        return (
          <div style={{ marginTop: 8, fontSize: 12.5 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0, color: 'var(--text-muted)' }}>Имя программы: <b style={{ fontFamily: 'monospace', color: 'var(--text)', wordBreak: 'break-all' }}>{ex || '—'}</b></div>
              <button type="button" onClick={() => setNameEdit(x => !x)} style={{ padding: '4px 10px', fontSize: 12, borderRadius: 14, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text)', cursor: 'pointer', flex: '0 0 auto' }}>{nameEdit ? 'Готово' : 'Изменить'}</button>
            </div>
            {nameEdit && (
              <div style={{ marginTop: 6 }}>
                <QrPartsEditor value={nameQ} exclude={['link']} onChange={setName} preview={ex} />
                <Hint>Имя собирается из частей, как код QR бирки: заказ, материал, наименование, обозначение, позиция, размер… В конце имени всегда обозначение детали (нет обозначения — позиция): так у каждой детали своё имя. Запоминается.</Hint>
              </div>
            )}
          </div>
        )
      })()}
      {/* что выводить и как лежит деталь — свёрнуто; кому не нужно, работает как раньше */}
      <div style={{ marginTop: 8, border: '0.5px solid var(--border)', borderRadius: 'var(--radius)', padding: '6px 10px' }}>
        <div role="button" tabIndex={0} onClick={() => setPpOpen(v => !v)} onKeyDown={e => { if (e.key === 'Enter') setPpOpen(v => !v) }} style={{ cursor: 'pointer', fontSize: 13, display: 'flex', gap: 6 }}>
          <span style={{ color: 'var(--text-hint)', width: 12 }}>{ppOpen ? '▼' : '▶'}</span>
          <span style={{ flex: 1 }}>Что выводить и как лежит деталь</span>
          <span style={{ fontSize: 11.5, color: 'var(--text-hint)' }}>{pp.place === 'own' ? 'к упору' : 'как в раскрое'} · контур: {OUTER.find(o => o[0] === pp.outer)?.[1].toLowerCase()}{WHAT.some(([k]) => !pp.what[k]) ? ' · есть отключённое' : ''}</span>
        </div>
        {ppOpen && settingsEl(true)}
      </div>
      <button type="button" className="btn-primary" disabled={!ready || !selected.length} onClick={build} style={{ marginTop: 8 }}>
        {ready ? `Создать УП только на ${selected.length === 1 ? 'эту деталь' : 'эти детали'}` : 'Загружаем настройки ЧПУ…'}
      </button>
      <Hint>Отдельная программа на каждую выбранную деталь — чтобы вырезать испорченную деталь из заготовки чуть больше (делового остатка) на том же фрезере. Обработка — как в программах листов: настройки постпроцессора и «Обработка» → «Выводить в УП» (присадка, пазы, вырезы, контур). Деталь стоит как в раскрое; обработка начинается с отступа X / Y от нуля станка — заготовку берите больше детали хотя бы на два отступа. Отступы запоминаются.</Hint>
      </>)}
      {/* другие действия с отмеченными деталями: удалить из заказа или удалить у них всю присадку */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
        <button type="button" disabled={!!busy || !selected.length} onClick={delParts}
          style={{ flex: 1, minWidth: 140, padding: '8px 10px', fontSize: 13, borderRadius: 'var(--radius)', border: '0.5px solid var(--danger)', background: 'transparent', color: 'var(--danger)', cursor: 'pointer' }}>
          {busy === 'del' ? 'Удаляем…' : `🗑 Удалить ${selected.length === 1 ? 'деталь' : 'детали'}`}</button>
        <button type="button" disabled={!!busy || !drilled.length} onClick={stripDrill}
          style={{ flex: 1, minWidth: 140, padding: '8px 10px', fontSize: 13, borderRadius: 'var(--radius)', border: '0.5px solid var(--amber)', background: 'transparent', color: drilled.length ? 'var(--amber)' : 'var(--text-hint)', cursor: drilled.length ? 'pointer' : 'default' }}>
          {busy === 'drill' ? 'Удаляем…' : drilled.length ? `⊘ Удалить присадку (${drilled.length})` : '⊘ Присадки нет'}</button>
      </div>
      <Hint>«Удалить детали» — убрать из заказа (и из карт раскроя; остальные детали остаются на местах, перекроить можно потом). «Удалить присадку» — убрать у отмеченных деталей все отверстия: в пласть и в торец. Пазы, выемки, вырезы и контур остаются.</Hint>
      {done && <div style={{ fontSize: 12, color: 'var(--teal)', marginTop: 6 }}>✓ {done}</div>}
      {!full && resultsEl()}
      {full && canProg && createPortal((() => {
        const wide = window.innerWidth >= 900
        const cur = selected.includes(act) ? act : selected[0]
        const ci = selected.indexOf(cur), v = cur ? viewOf(cur) : null
        const go = d => setAct(selected[(ci + d + selected.length) % selected.length])
        const bigW = wide ? Math.max(320, window.innerWidth - 440 - 60) : window.innerWidth - 40
        const bigH = wide ? window.innerHeight - 220 : Math.round(window.innerHeight * 0.38)
        return (
          <div style={{ position: 'fixed', inset: 0, zIndex: 950, background: 'var(--bg)', display: 'flex', flexDirection: 'column', height: '100dvh', overscrollBehavior: 'contain' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '8px 12px', borderBottom: '0.5px solid var(--border)' }}>
              <b style={{ fontSize: 15 }}>Программы на детали · {selected.length}</b>
              <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{pp.place === 'own' ? 'Отступ от упоров' : 'Отступ от нуля'}:</span>
              <label style={{ fontSize: 12.5 }}>X <input type="text" inputMode="decimal" key={`fx${off.x}`} defaultValue={off.x} onBlur={e => setO({ x: Math.max(0, n0(e.target.value)) })} style={{ ...inp, width: 56 }} /></label>
              <label style={{ fontSize: 12.5 }}>Y <input type="text" inputMode="decimal" key={`fy${off.y}`} defaultValue={off.y} onBlur={e => setO({ y: Math.max(0, n0(e.target.value)) })} style={{ ...inp, width: 56 }} /></label>
              <span style={{ flex: 1 }} />
              <button type="button" className="btn-primary" disabled={!ready || !selected.length} onClick={build} style={{ width: 'auto', padding: '8px 16px', margin: 0 }}>{ready ? 'Создать УП' : 'Загрузка…'}</button>
              <button type="button" onClick={() => setFull(false)} style={{ padding: '7px 14px', borderRadius: 18, border: '0.5px solid var(--border-md)', background: 'var(--bg2)', color: 'var(--text)', cursor: 'pointer', fontSize: 13 }}>✕ Закрыть</button>
            </div>
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: wide ? 'row' : 'column', overflow: wide ? 'hidden' : 'auto' }}>
              <div style={{ flex: wide ? 1 : '0 0 auto', minWidth: 0, padding: 12, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                {v ? (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%' }}>
                      <button type="button" onClick={() => go(-1)} disabled={selected.length < 2} style={{ ...chipS(false), fontSize: 16, padding: '4px 12px' }}>‹</button>
                      <div style={{ flex: 1, textAlign: 'center' }}>
                        <div style={{ fontSize: 14, fontWeight: 600 }}>{nm(cur)}</div>
                        <div style={{ fontSize: 12, color: 'var(--text-hint)' }}>{ci + 1} из {selected.length} · {Math.round(n0(v.p.origX))} × {Math.round(n0(v.p.origY))}{v.o ? ` · ${v.o.flip ? 'изнанкой вверх' : 'лицом вверх'} · ${v.hand ? 'вручную' : 'по правилам'}` : ' · как в раскрое'}</div>
                      </div>
                      <button type="button" onClick={() => go(1)} disabled={selected.length < 2} style={{ ...chipS(false), fontSize: 16, padding: '4px 12px' }}>›</button>
                    </div>
                    {/* деталь вписывается в свою половину экрана (горизонтальная не уезжает под меню и под список) */}
                    <div style={{ flex: wide ? 1 : '0 0 auto', minHeight: 0, height: wide ? 'auto' : bigH, display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', overflow: 'hidden' }}>
                      <PartMini p={v.p} det={v.det} T={v.T} corner={pp.place === 'own' ? pp.stops : 'bl'} w={bigW} h={bigH} fit />
                    </div>
                    {v.o ? partBtns(cur, v.o, v.hand) : <div style={{ fontSize: 12, color: 'var(--text-hint)' }}>Поворот и переворот — в режиме «К упору — свой поворот» (справа)</div>}
                    <div style={{ fontSize: 11.5, color: 'var(--text-hint)' }}>● отверстия · ▭ выемки · пазы — синим · синяя точка — {pp.place === 'own' ? 'угол упоров' : 'ноль'}</div>
                  </>
                ) : <div style={{ color: 'var(--text-hint)' }}>Нет деталей</div>}
              </div>
              <div style={{ width: wide ? 440 : 'auto', flex: wide ? '0 0 440px' : '0 0 auto', borderLeft: wide ? '0.5px solid var(--border)' : 'none', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                {/* настройки закреплены сверху (своя прокрутка), прокручивается только список деталей */}
                <div style={{ flex: '0 0 auto', maxHeight: wide ? '58%' : 'none', overflowY: wide ? 'auto' : 'visible', padding: '4px 12px 6px', borderBottom: '1px solid var(--border-md)', boxShadow: wide ? '0 2px 6px rgba(0,0,0,.06)' : 'none' }}>
                  {settingsEl(false)}
                </div>
                <div style={{ flex: 1, minHeight: 0, overflowY: wide ? 'auto' : 'visible', padding: '4px 12px 8px' }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', margin: '6px 0 2px' }}>Детали — нажмите, чтобы посмотреть</div>
                {selected.map(id => {
                  const w = viewOf(id)
                  if (!w) return null
                  return (
                    <div key={id} role="button" tabIndex={0} onClick={() => setAct(id)} onKeyDown={e => { if (e.key === 'Enter') setAct(id) }}
                      style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '5px 6px', cursor: 'pointer', borderRadius: 8, background: id === cur ? 'var(--blue-light)' : 'transparent', borderTop: '0.5px solid var(--border)' }}>
                      <PartMini p={w.p} det={w.det} T={w.T} corner={pp.place === 'own' ? pp.stops : 'bl'} w={110} h={60} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 500 }}>{nm(id)}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-hint)' }}>{Math.round(n0(w.p.origX))} × {Math.round(n0(w.p.origY))}{w.o ? ` · ${w.hand ? 'вручную' : 'по правилам'}` : ''}</div>
                      </div>
                    </div>
                  )
                })}
                {resultsEl()}
                </div>
              </div>
            </div>
          </div>
        )
      })(), document.body)}
      {/* симулятор — поверх всего экрана, как на странице ЧПУ */}
      {sim && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'var(--bg)', zIndex: 1100, padding: 10, boxSizing: 'border-box', height: '100dvh', overscrollBehavior: 'contain' }}>
          <div style={{ maxWidth: window.innerWidth >= 1100 ? 'none' : 1100, margin: '0 auto', height: '100%' }}>
            <Suspense fallback={<CncLoader label="Запускаем симулятор…" />}>
              <GcodeSimulator key={sim.name} text={sim.sim.text} kinds={sim.sim.kinds} opIds={sim.sim.opIds} title={`${sim.label} · ${sim.name}`} thickness={sim.sim.thickness}
                rapid={sim.sim.rapid} zShift={sim.sim.zShift} toolDia={t => n0((sim.sim.tools.find(x => n0(x.t) === t) || {}).d)} headTools={sim.sim.head}
                onClose={() => setSim(null)} onDownload={() => download(sim.name, sim.data)} sheet={sim.sim.sheet} outlines={sim.sim.outlines} />
            </Suspense>
          </div>
        </div>, document.body
      )}
      {save && res?.files?.length > 0 && createPortal(
        <div style={{ position: 'relative', zIndex: 1000 }}>
          <SaveFilesDialog files={res.files.map(f => ({ name: f.name, data: f.data }))} zipName={`${toLatin(order?.order_number || 'order')}_detali`}
            onClose={() => setSave(false)} onDone={() => setSave(false)} />
        </div>, document.body
      )}
    </div>
  )
}
