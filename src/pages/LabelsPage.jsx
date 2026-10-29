import { createPortal } from 'react-dom'
import DeskSplit from '../components/DeskSplit'
import { useDesktop } from '../hooks/useDesktop'
import { cutDetails, parseEdgeTypes } from '../lib/edgeCut'
import ShareBadge from '../components/ShareBadge'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, Suspense } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { lazyRetry } from '../lib/lazyRetry'
import { hasModel } from '../lib/model3d'
import { loadOrderModel } from '../lib/orderModel'
import { getShare, cachedShare, onShareChange } from '../lib/modelShare'

const Model3D = lazyRetry(() => import('../components/Model3D'))   // 3D детали — из просмотра бирки
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { savedNestings, sheetGeo } from '../lib/savedNesting'
import QrPartsEditor from '../components/QrPartsEditor'
import { REM_QR_PARTS, REM_ITEMS, PART_ITEMS, SHAPE_ITEMS, isShape, remTplOf, remInfo, remQrText, remSheetCtx } from '../lib/labelMaker'
import { sheetOffcuts, drawOffcutLabel, labelPages, OFFCUT_CORNERS, labelQr, qrHasLink, itemKind, itemTitle, isBox, isVert, itemBox, textRot, textThick, metaItems, userItems, preloadLabelImages, labelImageSize, imageToLabel, labelImageSrc, newLabelItem, DEFAULT_LABEL, resizeLabel, getLabelTpl, saveLabelTpl, getLabelSaved, saveLabelSaved, normalizeLabel, labelInfo, drawLabel, demoLabelSample, labelPx, labelOrder, buildLabelFiles, buildLabelsPdf, canCaption, defaultCap } from '../lib/labelMaker'
import { getCnc, routerPost, sawPost, normalizeCnc } from '../lib/cncSettings'
import { beamLabelSeq, beamExitPart } from '../lib/beamSawLabels'
import CncLoader from '../components/CncLoader'
import { orderTitle, orderFileName, toLatin, programName, folderName, fileNameOf } from '../lib/orderUtils'
import { fileNamesOf } from '../lib/fileNames'
import { orderClient } from '../lib/productionApi'
import SaveFilesDialog from '../components/SaveFilesDialog'
import { getUserSettings, saveUserSettings } from '../lib/userSettings'

// Бирки деталей по принятому раскрою. Бирку собирает пользователь: размер и какие параметры детали на ней есть.
// На бирке — карта раскроя, где эта деталь закрашена чёрным. Шаблон идёт за аккаунтом; с ним же ЧПУ делает
// файлы для маркировочного стола.
const CSS = `
.lbl-grid { display: grid; grid-template-columns: repeat(var(--lbl-cols, 2), minmax(0, 1fr)); gap: 6px; }
.lbl-grid canvas { width: 100%; height: auto; border: 1px solid #2C2C2A; border-radius: 3px; background: #fff; display: block; }
@media print {
  .no-print, .bottom-nav { display: none !important; }
  body { background: #fff; }
  .page { max-width: none; padding: 0; }
  .lbl-grid { display: block; }
  .lbl-grid canvas { width: var(--lbl-w); height: var(--lbl-h); border: none; border-radius: 0; break-after: page; }
}`
const safeName = s => toLatin(String(s || '')).replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '')   // имена файлов и папок — латиницей

// Пильный центр: бирки — по готовности деталей (обход дерева резов) и в положении выхода детали со станка
// (поворот — по настройке постпроцессора пилы). У фрезера и форматника — как было.
const isBeamMat = mat => !!mat?.result?.beamSaw
// постпроцессор пилы аккаунта (сторона поворота заготовки, «ещё 180°»); у normalizeCnc без beam пильного центра нет
const beamPostOf = user => sawPost(normalizeCnc(getUserSettings(user).cnc, [], { beam: true }))
const beamPart = (mat, sheet, pi, bp) => (isBeamMat(mat) ? beamExitPart(sheet.placed[pi], sheet, bp) : null)
const beamOpts = (mat, bp) => (isBeamMat(mat) ? { seqOf: beamLabelSeq, partOf: (sheet, pi) => beamExitPart(sheet.placed[pi], sheet, bp) } : {})

function Label({ tpl, order, mat, si, pi, n, onOpen, bp, page, pages }) {
  const ref = useRef(null)
  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const { w, h } = labelPx(tpl, true)
    cv.width = w; cv.height = h
    const sheet = mat.sheets[si], part = beamPart(mat, sheet, pi, bp)
    const draw = () => drawLabel(cv, tpl, { ...labelInfo(order, mat, si, pi, part), page, pages }, { sheet, geo: sheetGeo(order, mat.result, sheet), index: pi, detail: mat.details[sheet.placed[pi].detailIndex], part })
    draw(); if (tpl.items.some(i => i.img)) preloadLabelImages(tpl).then(draw)
  }, [tpl, order, mat, si, pi, bp, page, pages])
  return <canvas ref={ref} data-lbl={n} onClick={onOpen} style={{ cursor: 'zoom-in' }} />
}

// Бирка на деловой обрезок листа: заказ, материал, размер
function OffcutLabel({ tpl, order, mat, si, o, client = '' }) {
  const ref = useRef(null)
  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const { w, h } = labelPx(tpl, true)
    cv.width = w; cv.height = h
    const draw = () => drawOffcutLabel(cv, tpl, { order, mat, si, o, client })
    draw(); const rt = remTplOf(tpl); if (rt.items.some(i => i.img)) preloadLabelImages(rt).then(draw)
  }, [tpl, order, mat, si, o.w, o.h, o.x, o.y, client])
  return <canvas ref={ref} />
}

// Шаблон бирки делового остатка — тот же редактор, что у бирки детали: элементы ставятся куда угодно, тянутся,
// поворачиваются, выравниваются, заменяются картинкой. Размер — как у бирки детали (тот же рулон).
function RemLabelSetup({ tpl, onChange, sample, previewEl = null }) {
  const rt = remTplOf(tpl)
  const set = next => onChange({ ...tpl, remTpl: normalizeLabel({ ...next, kind: 'rem', enabled: true }) })
  return (
    <div className="card no-print" style={{ marginBottom: 12, padding: '10px 12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
        <div style={{ flex: 1, fontSize: 14, fontWeight: 600 }}>Бирка делового остатка</div>
        <button type="button" onClick={() => { if (window.confirm('Вернуть раскладку бирки остатка по образцу?')) onChange({ ...tpl, remTpl: null }) }}
          style={{ padding: '5px 10px', borderRadius: 14, fontSize: 12, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}>↺ По образцу</button>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text-hint)', marginBottom: 8 }}>Размер — как у бирки детали ({tpl.w}×{tpl.h} мм). Нажмите на элемент — двигайте, растягивайте, поворачивайте, меняйте шрифт или ставьте картинку; «Добавить на бирку» — новые элементы.</div>
      <LabelEditor tpl={rt} onChange={set} order={sample.order} mat={sample.mat} shared={false} rem={sample} previewEl={previewEl} />
    </div>
  )
}

// Просмотр бирки во весь экран — как фотография в галерее: щипок увеличивает, палец двигает, двойное касание —
// крупнее / целиком, смахивание в стороны — соседняя бирка. Бирка перерисована крупно, поэтому при увеличении чёткая.
function LabelViewer({ tpl, order, mat, list, index, onIndex, onClose, on3d, bp }) {
  const cvRef = useRef(null), boxRef = useRef(null)
  const v = useRef({ s: 1, x: 0, y: 0 })                 // масштаб и сдвиг
  const g = useRef({ pts: new Map(), start: null, tap: 0, moved: false })
  const { si, pi, page, pages } = list[index]
  const apply = (anim = false) => {
    const cv = cvRef.current, box = boxRef.current
    if (!cv || !box) return
    const st = v.current
    st.s = Math.max(1, Math.min(10, st.s))
    // картинка не уходит за края экрана
    const mx = Math.max(0, (cv.offsetWidth * st.s - box.clientWidth) / 2), my = Math.max(0, (cv.offsetHeight * st.s - box.clientHeight) / 2)
    st.x = Math.max(-mx, Math.min(mx, st.x)); st.y = Math.max(-my, Math.min(my, st.y))
    cv.style.transition = anim ? 'transform 0.18s ease-out' : 'none'
    cv.style.transform = `translate(${st.x}px, ${st.y}px) scale(${st.s})`
  }
  useEffect(() => {
    const cv = cvRef.current
    if (!cv) return
    const k = Math.min(32, Math.floor(4096 / Math.max(tpl.w, tpl.h)))       // точек на мм — с запасом под увеличение
    cv.width = Math.round(tpl.w * k); cv.height = Math.round(tpl.h * k)
    const sheet = mat.sheets[si], part = beamPart(mat, sheet, pi, bp)
    const draw = () => drawLabel(cv, tpl, { ...labelInfo(order, mat, si, pi, part), page, pages }, { sheet, geo: sheetGeo(order, mat.result, sheet), index: pi, detail: mat.details[sheet.placed[pi].detailIndex], part })
    draw(); if (tpl.items.some(i => i.img)) preloadLabelImages(tpl).then(draw)
    v.current = { s: 1, x: 0, y: 0 }; apply()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tpl, order, mat, si, pi])
  const zoomAt = (cx, cy, ns, anim) => {                 // увеличение вокруг точки экрана
    const box = boxRef.current.getBoundingClientRect(), st = v.current
    const px = cx - box.left - box.width / 2, py = cy - box.top - box.height / 2
    const k = Math.max(1, Math.min(10, ns)) / st.s
    st.x = px - (px - st.x) * k; st.y = py - (py - st.y) * k; st.s *= k
    apply(anim)
  }
  const down = e => {
    e.currentTarget.setPointerCapture?.(e.pointerId)
    const G = g.current
    G.pts.set(e.pointerId, [e.clientX, e.clientY]); G.moved = false
    const P = [...G.pts.values()]
    G.start = P.length === 2 ? { d: Math.hypot(P[0][0] - P[1][0], P[0][1] - P[1][1]), s: v.current.s } : { x: e.clientX, y: e.clientY, vx: v.current.x, vy: v.current.y }
  }
  const move = e => {
    const G = g.current
    if (!G.pts.has(e.pointerId)) return
    G.pts.set(e.pointerId, [e.clientX, e.clientY])
    const P = [...G.pts.values()]
    if (P.length === 2 && G.start?.d) {
      G.moved = true
      zoomAt((P[0][0] + P[1][0]) / 2, (P[0][1] + P[1][1]) / 2, G.start.s * Math.hypot(P[0][0] - P[1][0], P[0][1] - P[1][1]) / G.start.d)
    } else if (P.length === 1 && G.start && G.start.d == null) {
      const dx = e.clientX - G.start.x, dy = e.clientY - G.start.y
      if (Math.hypot(dx, dy) > 6) G.moved = true
      if (v.current.s > 1.01) { v.current.x = G.start.vx + dx; v.current.y = G.start.vy + dy; apply() }
      else { v.current.x = dx; v.current.y = 0; const cv = cvRef.current; cv.style.transition = 'none'; cv.style.transform = `translate(${dx}px, 0px) scale(1)` }
    }
  }
  const up = e => {
    const G = g.current, had = G.pts.size
    G.pts.delete(e.pointerId)
    if (had === 1 && G.start && G.start.d == null) {
      const dx = e.clientX - G.start.x
      if (v.current.s <= 1.01) {
        if (Math.abs(dx) > 70) { const n = index + (dx < 0 ? 1 : -1); if (n >= 0 && n < list.length) { onIndex(n); return } }
        v.current.x = 0; apply(true)
      }
      if (!G.moved) {                                    // двойное касание
        const now = Date.now()
        if (now - G.tap < 320) { zoomAt(e.clientX, e.clientY, v.current.s > 1.5 ? 1 : 3, true); if (v.current.s <= 1.01) { v.current.x = 0; v.current.y = 0; apply(true) } G.tap = 0 } else G.tap = now
      }
    }
    const P = [...G.pts.values()]
    G.start = P.length === 1 ? { x: P[0][0], y: P[0][1], vx: v.current.x, vy: v.current.y } : null
  }
  const nav = { position: 'absolute', top: '50%', transform: 'translateY(-50%)', width: 40, height: 56, border: 'none', borderRadius: 10, background: 'rgba(255,255,255,0.14)', color: '#fff', fontSize: 22 }
  return (
    <div className="no-print" style={{ position: 'fixed', inset: 0, zIndex: 500, background: '#1b1b1a', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', color: '#fff' }}>
        <div style={{ flex: 1, fontSize: 14 }}>Лист {si + 1} · бирка {index + 1} из {list.length}</div>
        <button type="button" onClick={on3d} style={{ background: '#185FA5', border: 'none', color: '#fff', borderRadius: 20, padding: '6px 14px', fontSize: 13, fontWeight: 500 }}>3D</button>
        <button type="button" onClick={() => { v.current = { s: 1, x: 0, y: 0 }; apply(true) }} style={{ background: 'none', border: '0.5px solid rgba(255,255,255,0.4)', color: '#fff', borderRadius: 20, padding: '5px 12px', fontSize: 12 }}>Целиком</button>
        <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', color: '#fff', fontSize: 26, lineHeight: 1, padding: '0 4px' }}>×</button>
      </div>
      <div ref={boxRef} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
        onWheel={e => zoomAt(e.clientX, e.clientY, v.current.s * (e.deltaY < 0 ? 1.2 : 1 / 1.2))}
        style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden', touchAction: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', userSelect: 'none' }}>
        <canvas ref={cvRef} style={{ maxWidth: '100%', maxHeight: '100%', background: '#fff', transformOrigin: 'center center', willChange: 'transform' }} />
        {index > 0 && <button type="button" onPointerDown={e => e.stopPropagation()} onClick={() => onIndex(index - 1)} style={{ ...nav, left: 6 }}>‹</button>}
        {index < list.length - 1 && <button type="button" onPointerDown={e => e.stopPropagation()} onClick={() => onIndex(index + 1)} style={{ ...nav, right: 6 }}>›</button>}
      </div>
      <div style={{ padding: '8px 14px calc(8px + env(safe-area-inset-bottom))', color: 'rgba(255,255,255,0.6)', fontSize: 11, textAlign: 'center' }}>Щипок — увеличить · двойное касание — крупнее / целиком · смахните в сторону — следующая бирка</div>
    </div>
  )
}

// Конструктор бирки: элементы перетаскиваются по бирке пальцем, за уголок — меняется размер.
// Показана бирка первой детали первого листа — на настоящих данных заказа.
import LabelImageEditor from '../components/LabelImageEditor'

// Сетка бирки в мм: тонкая — через 1 мм (когда крупно), через 5 мм, жирнее — через 10 мм с цифрами по верху и слева
function LabelGrid({ w, h, scale }) {
  const lines = [], step1 = scale >= 7
  for (let x = 0; x <= w + 0.001; x += 1) { const k = Math.round(x); if (k % 5 && !step1) continue; lines.push(<line key={'x' + k} x1={x * scale} y1={0} x2={x * scale} y2={h * scale} stroke={k % 10 ? (k % 5 ? 'rgba(24,95,165,.12)' : 'rgba(24,95,165,.25)') : 'rgba(24,95,165,.45)'} strokeWidth={1} />) }
  for (let y = 0; y <= h + 0.001; y += 1) { const k = Math.round(y); if (k % 5 && !step1) continue; lines.push(<line key={'y' + k} x1={0} y1={y * scale} x2={w * scale} y2={y * scale} stroke={k % 10 ? (k % 5 ? 'rgba(24,95,165,.12)' : 'rgba(24,95,165,.25)') : 'rgba(24,95,165,.45)'} strokeWidth={1} />) }
  const nums = []
  for (let x = 10; x < w; x += 10) nums.push(<text key={'nx' + x} x={x * scale + 2} y={10} fontSize={9} fill="#185FA5">{x}</text>)
  for (let y = 10; y < h; y += 10) nums.push(<text key={'ny' + y} x={2} y={y * scale - 2} fontSize={9} fill="#185FA5">{y}</text>)
  return <svg width={w * scale} height={h * scale} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>{lines}{nums}</svg>
}

// Место элемента в мм: X, Y, ширина, высота — числами; отступы до краёв бирки
function ItemPlace({ it, tpl, edit }) {
  const [bw, bh] = itemBox(it), box = isBox(it)
  const f = v => String(Math.round(v * 10) / 10).replace('.', ',')
  const num = (v, set) => { const x = Number(String(v).replace(',', '.')); if (isFinite(x)) set(x) }
  const inp = { width: 58, padding: '5px 6px', fontSize: 12.5, marginLeft: 4 }
  const field = (lab, val, set, k) => (
    <label key={k} style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: 0, display: 'flex', alignItems: 'center' }}>{lab}
      <input type="text" inputMode="decimal" key={k + it.id + val} defaultValue={f(val)} onBlur={e => num(e.target.value, set)} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} style={inp} /></label>
  )
  return (
    <div style={{ flex: '1 1 100%', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      {field('X', it.x, x => edit({ x }), 'x')}
      {field('Y', it.y, y => edit({ y }), 'y')}
      {box && it.type !== 'vline' && field(it.type === 'hline' ? 'Длина' : 'Ширина', it.w, w => edit({ w }), 'w')}
      {box && it.type !== 'hline' && field(it.type === 'vline' ? 'Длина' : 'Высота', it.h, h => edit({ h }), 'h')}
      {!box && field('Длина строки', it.w, w => edit({ w }), 'w')}
      <span style={{ fontSize: 11, color: 'var(--text-hint)' }}>мм · до краёв: слева {f(it.x)}, сверху {f(it.y)}, справа {f(tpl.w - it.x - bw)}, снизу {f(tpl.h - it.y - bh)}</span>
    </div>
  )
}

// Оформление: у линий, рамки и таблицы — толщина, заливка, скругление, ячейки; у остальных — рамка вокруг и «белым по чёрному»
function ItemStyle({ it, tpl, edit, chip }) {
  const row = { flex: '1 1 100%', display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }
  const lab = { fontSize: 11.5, color: 'var(--text-muted)', minWidth: 62 }
  const hint = { fontSize: 11, color: 'var(--text-hint)' }
  const lw = it.lw || 0.3, f = v => String(Math.round(v * 10) / 10).replace('.', ',')
  const thick = (
    <>
      <span style={lab}>Толщина линии:</span>
      <button type="button" style={chip(false)} onClick={() => edit({ lw: Math.max(0.1, Math.round((lw - 0.1) * 10) / 10) })}>−</button>
      <span style={hint}>{f(lw)} мм</span>
      <button type="button" style={chip(false)} onClick={() => edit({ lw: Math.round((lw + 0.1) * 10) / 10 })}>+</button>
    </>
  )
  if (isShape(it)) {
    const st = (n, d, lo, hi) => Math.max(lo, Math.min(hi, (it[n] || 0) + d))
    return (
      <>
        <div style={row}>{thick}</div>
        {it.type === 'hline' && <div style={row}><button type="button" style={chip(false)} onClick={() => edit({ x: 0, w: tpl.w })}>↔ Во всю ширину</button><button type="button" style={chip(false)} onClick={() => edit({ y: (tpl.h - lw) / 2 })}>↕ По центру бирки</button></div>}
        {it.type === 'vline' && <div style={row}><button type="button" style={chip(false)} onClick={() => edit({ y: 0, h: tpl.h })}>↕ Во всю высоту</button><button type="button" style={chip(false)} onClick={() => edit({ x: (tpl.w - lw) / 2 })}>↔ По центру бирки</button></div>}
        {(it.type === 'rect' || it.type === 'table') && (
          <div style={row}>
            <button type="button" style={chip(false)} onClick={() => edit({ x: 0, y: 0, w: tpl.w, h: tpl.h })}>⛶ По краю бирки</button>
            <button type="button" style={chip(false)} onClick={() => { const m = 2; edit({ x: m, y: m, w: tpl.w - 2 * m, h: tpl.h - 2 * m }) }}>С отступом 2 мм</button>
            <button type="button" style={chip(false)} onClick={() => edit({ x: (tpl.w - it.w) / 2, y: (tpl.h - it.h) / 2 })}>✛ В центр бирки</button>
          </div>
        )}
        {it.type === 'rect' && (
          <div style={row}>
            <button type="button" style={chip(!!it.inv)} onClick={() => edit({ inv: !it.inv || undefined })}>■ Залить чёрным</button>
            <span style={{ ...lab, minWidth: 0, marginLeft: 4 }}>Скругление:</span>
            <button type="button" style={chip(false)} onClick={() => edit({ rad: st('rad', -0.5, 0, 10) })}>−</button>
            <span style={hint}>{f(it.rad || 0)} мм</span>
            <button type="button" style={chip(false)} onClick={() => edit({ rad: st('rad', 0.5, 0, 10) })}>+</button>
            {it.inv && <span style={{ ...hint, flex: '1 1 100%' }}>Залитая рамка лежит под остальными элементами. Текст поверх неё сделайте «белым по чёрному».</span>}
          </div>
        )}
        {it.type === 'table' && (
          <div style={row}>
            <span style={lab}>Столбцов:</span>
            <button type="button" style={chip(false)} onClick={() => edit({ cols: st('cols', -1, 1, 12) })}>−</button>
            <span style={hint}>{it.cols}</span>
            <button type="button" style={chip(false)} onClick={() => edit({ cols: st('cols', 1, 1, 12) })}>+</button>
            <span style={{ ...lab, minWidth: 0, marginLeft: 6 }}>Строк:</span>
            <button type="button" style={chip(false)} onClick={() => edit({ rows: st('rows', -1, 1, 12) })}>−</button>
            <span style={hint}>{it.rows}</span>
            <button type="button" style={chip(false)} onClick={() => edit({ rows: st('rows', 1, 1, 12) })}>+</button>
            <span style={{ ...hint, flex: '1 1 100%' }}>Ячейка {f(it.w / it.cols)} × {f(it.h / it.rows)} мм. Текст и другие элементы ставьте в ячейки сверху — с «📐 Разметкой» видно, куда.</span>
          </div>
        )}
      </>
    )
  }
  return (
    <div style={row}>
      <span style={lab}>Оформление:</span>
      <button type="button" style={chip(!!it.box)} onClick={() => edit({ box: !it.box || undefined })}>▭ В рамке</button>
      <button type="button" style={chip(!!it.inv)} onClick={() => edit({ inv: !it.inv || undefined })}>◼ Белым по чёрному</button>
      {it.inv && it.type === 'qr' && <span style={{ flex: '1 1 100%', fontSize: 11, color: 'var(--text-hint)' }}>Перевёрнутый QR-код читают не все сканеры — проверьте своим.</span>}
      {it.box && thick}
    </div>
  )
}

function LabelEditor({ tpl, onChange, order, mat, shared, previewEl = null, rem = null }) {
  const wrapRef = useRef(null), cvRef = useRef(null), drag = useRef(null)
  const [live, setLive] = useState(null)            // шаблон во время перетаскивания
  const [sel, setSel] = useState(null)
  const [fitScale, setFitScale] = useState(4)       // точек экрана на мм, когда бирка во всю ширину
  // увеличение бирки для точной расстановки с телефона: кнопки −/+ или щипок двумя пальцами; одним пальцем по пустому
  // месту — двигать увеличенную бирку
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  // разметка: сетка в мм с цифрами по краям; включена — элементы встают по сетке через 0,5 мм
  const [grid, setGrid] = useState(() => { try { return localStorage.getItem('lblGrid') === '1' } catch { return false } })
  const toggleGrid = () => setGrid(v => { try { localStorage.setItem('lblGrid', v ? '0' : '1') } catch { /* без памяти */ } return !v })
  const scale = fitScale * zoom
  const t = live || tpl
  // компьютер (previewEl): бирка — в левой колонке, целиком по ширине и высоте колонки; ширину колонки тянут мышью
  const boxRef = useRef(null)
  useEffect(() => {
    const fit = () => {
      if (previewEl) {
        const w = boxRef.current?.clientWidth || previewEl.clientWidth, h = (previewEl.parentElement?.clientHeight || window.innerHeight) - 120
        if (w > 0) setFitScale(Math.max(1, Math.min(w / tpl.w, h / tpl.h)))
        return
      }
      const w = wrapRef.current?.clientWidth; if (w) setFitScale(w / tpl.w)
    }
    fit(); window.addEventListener('resize', fit)
    const ro = previewEl && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null
    if (ro && previewEl.parentElement) ro.observe(previewEl.parentElement)
    return () => { window.removeEventListener('resize', fit); ro?.disconnect() }
  }, [tpl.w, tpl.h, previewEl])
  const viewOf = H => (previewEl ? tpl.h * fitScale : Math.min(H, Math.max(tpl.h * fitScale, (typeof window !== 'undefined' ? window.innerHeight : 800) * 0.55)))
  const viewH = viewOf(tpl.h * scale)
  const clampPan = (p, z = zoom) => {
    const W = tpl.w * fitScale * z, H = tpl.h * fitScale * z, vw = tpl.w * fitScale, vh = viewOf(H)
    return { x: Math.min(0, Math.max(vw - W, p.x)), y: Math.min(0, Math.max(vh - H, p.y)) }
  }
  const zoomAt = (nz, cx, cy) => {      // cx, cy — точка экрана внутри окна бирки, которая остаётся на месте
    const z = Math.max(1, Math.min(8, nz))
    setPan(p => clampPan({ x: cx - (cx - p.x) * z / zoom, y: cy - (cy - p.y) * z / zoom }, z))
    setZoom(z)
  }
  const gest = useRef({ pts: new Map(), moved: false })
  const bgDown = e => {
    const G = gest.current
    G.pts.set(e.pointerId, [e.clientX, e.clientY]); G.moved = false
    e.currentTarget.setPointerCapture?.(e.pointerId)
    if (G.pts.size === 2) { const [a, b] = [...G.pts.values()]; G.pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), z: zoom } }
    else G.last = [e.clientX, e.clientY]
  }
  const bgMove = e => {
    const G = gest.current
    if (drag.current) { move(e); return }
    if (!G.pts.has(e.pointerId)) return
    G.pts.set(e.pointerId, [e.clientX, e.clientY])
    const r = wrapRef.current.getBoundingClientRect()
    if (G.pts.size >= 2 && G.pinch) {
      const [a, b] = [...G.pts.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1])
      zoomAt(G.pinch.z * d / (G.pinch.d || 1), (a[0] + b[0]) / 2 - r.left, (a[1] + b[1]) / 2 - r.top); G.moved = true
    } else if (G.last && zoom > 1) {
      const dx = e.clientX - G.last[0], dy = e.clientY - G.last[1]
      if (Math.abs(dx) + Math.abs(dy) > 2) G.moved = true
      G.last = [e.clientX, e.clientY]
      setPan(p => clampPan({ x: p.x + dx, y: p.y + dy }))
    }
  }
  const bgUp = e => {
    const G = gest.current
    if (drag.current) { up(); G.pts.delete(e.pointerId); return }
    const tap = G.pts.size === 1 && !G.moved
    G.pts.delete(e.pointerId)
    if (G.pts.size < 2) G.pinch = null
    G.last = G.pts.size ? [...G.pts.values()][0] : null
    if (tap) setSel(null)
  }
  useEffect(() => {
    const cv = cvRef.current
    if (!cv || !mat) return
    const { w, h } = labelPx(t, true)
    cv.width = w; cv.height = h
    const sheet = mat.sheets[0]
    // бирка остатка — на образцовом остатке; бирка детали — на первой детали
    const draw = rem ? () => drawLabel(cv, t, remInfo(rem), remSheetCtx(rem, true), { preview: true })
      : () => drawLabel(cv, t, { ...labelInfo(order, mat, 0, 0), page: 1, pages: 1 }, { sheet, geo: sheetGeo(order, mat.result, sheet), index: 0, detail: mat.details[sheet.placed[0].detailIndex] }, { preview: true })
    draw(); if (t.items.some(i => i.img)) preloadLabelImages(t).then(draw)
  }, [t, order, mat, rem])
  // компьютер: колёсико мыши над биркой — увеличить/уменьшить в точке под курсором
  const zoomAtRef = useRef(null)
  zoomAtRef.current = zoomAt
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  useEffect(() => {
    const el = wrapRef.current
    if (!el || !previewEl) return
    const onWheel = e => {
      e.preventDefault()
      const r = el.getBoundingClientRect(), dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY
      zoomAtRef.current(zoomRef.current * Math.exp(-dy * 0.0016), e.clientX - r.left, e.clientY - r.top)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [previewEl])
  const fileRef = useRef(null)
  const [imgErr, setImgErr] = useState('')
  // картинка сначала открывается в редакторе (убрать фон → прозрачный PNG, обрезать поля), потом ставится на бирку
  const [imgEdit, setImgEdit] = useState(null)      // { src } — открыт редактор картинки
  const setImage = src => { setImgErr(''); setImgEdit({ src }) }
  const putImage = async blob => {
    setImgEdit(null)
    try {
      const img = await imageToLabel(blob)
      // пропорции рамки — как у картинки
      let ar = 1
      try { const u = URL.createObjectURL(blob); const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = u }); ar = (im.naturalWidth || 1) / (im.naturalHeight || 1); URL.revokeObjectURL(u) } catch { /* квадрат */ }
      const h = cur?.img ? cur.h : Math.min(tpl.h * 0.3, 10), w = cur?.img ? cur.w : Math.min(tpl.w * 0.6, h * ar)
      edit({ img, h, w })
    } catch (e) { setImgErr(String(e?.message || e)) }
  }
  const reEdit = async () => { const src = await labelImageSrc(cur?.img); if (src) setImgEdit({ src }) }
  const down = (e, it, mode) => {
    e.stopPropagation(); e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    setSel(it.id)
    drag.current = { id: it.id, mode, x: e.clientX, y: e.clientY, it: { ...it } }
  }
  const move = e => {
    const d = drag.current
    if (!d) return
    const dx = (e.clientX - d.x) / scale, dy = (e.clientY - d.y) / scale, o = d.it, pic = isBox(o)
    const sn = v => (grid ? Math.round(v * 2) / 2 : v)
    const patch = d.mode === 'move' ? { x: sn(o.x + dx), y: sn(o.y + dy) }
      : o.type === 'hline' ? { w: Math.max(1, sn(o.x + o.w + dx) - o.x) }        // линия тянется только в длину
      : o.type === 'vline' ? { h: Math.max(1, sn(o.y + o.h + dy) - o.y) }
      : pic ? { w: Math.max(isShape(o) ? 1 : 4, sn(o.x + o.w + dx) - o.x), h: Math.max(isShape(o) ? 1 : 4, sn(o.y + o.h + dy) - o.y) }
        : isVert(o) ? { w: Math.max(4, o.w + dy), size: Math.max(1.2, o.size + dx / 1.25) } : { w: Math.max(4, o.w + dx), size: Math.max(1.2, o.size + dy / 1.25) }
    setLive(normalizeLabel({ ...tpl, items: tpl.items.map(i => (i.id === d.id ? { ...i, ...patch } : i)) }))
  }
  const up = () => { if (drag.current && live) onChange(live); drag.current = null; setLive(null) }
  const cur = t.items.find(i => i.id === sel) || null
  const edit = patch => onChange({ ...tpl, items: tpl.items.map(i => (i.id === sel ? { ...i, ...patch } : i)) })
  const chip = on => ({ padding: '6px 11px', borderRadius: 20, fontSize: 12, border: '0.5px solid ' + (on ? 'var(--blue)' : 'var(--border-md)'), background: on ? 'var(--blue-light)' : 'transparent', color: on ? 'var(--blue-dark)' : 'var(--text-muted)', whiteSpace: 'nowrap' })
  const used = new Set(t.items.map(i => i.type))
  // кнопка «+ параметр»: любой параметр можно поставить несколько раз (копия — чуть в стороне)
  const addChip = (k, label) => {
    const n = t.items.filter(i => i.type === k).length
    return (
      <button key={k} type="button" style={chip(n > 0)} onClick={() => {
        let it = newLabelItem(k, tpl)
        if (n) { const [bw, bh] = itemBox(it); it = { ...it, x: Math.min(tpl.w - bw, it.x + 3 * n), y: Math.min(tpl.h - bh, it.y + 3 * n) } }
        onChange({ ...tpl, items: [...tpl.items, it] }); setSel(it.id)
      }}>+ {label}{n ? ` · ${n}` : ''}</button>
    )
  }
  const previewPart = (
    <div ref={boxRef}>
      <div ref={wrapRef} onPointerDown={bgDown} onPointerMove={bgMove} onPointerUp={bgUp} onPointerCancel={bgUp}
        style={{ position: 'relative', width: previewEl ? tpl.w * fitScale + 2 : '100%', margin: previewEl ? '0 auto' : undefined, height: viewH, border: '1px solid #2C2C2A', borderRadius: 3, background: zoom > 1 ? 'var(--bg2)' : '#fff', touchAction: 'none', userSelect: 'none', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', left: pan.x, top: pan.y, width: tpl.w * scale, height: tpl.h * scale, background: '#fff' }}>
        <canvas ref={cvRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
        {grid && <LabelGrid w={tpl.w} h={tpl.h} scale={scale} />}
        {/* рамки и таблицы — под остальными элементами: щелчок по тексту в ячейке выбирает текст, по пустой ячейке — таблицу */}
        {[...t.items].sort((a, b) => (['rect', 'table'].includes(b.type) ? 1 : 0) - (['rect', 'table'].includes(a.type) ? 1 : 0)).map(it => {
          const on = it.id === sel
          // тонкую линию легко схватить: поле для мыши/пальца — не тоньше 12 точек
          const [bw, bh] = itemBox(it), W = bw * scale, H = bh * scale, gw = Math.max(0, 12 - W) / 2, gh = Math.max(0, 12 - H) / 2
          return (
            <div key={it.id} onPointerDown={e => down(e, it, 'move')} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
              style={{ position: 'absolute', left: it.x * scale - gw, top: it.y * scale - gh, width: W + 2 * gw, height: H + 2 * gh, boxSizing: 'border-box', cursor: 'move',
                border: on ? '1.5px solid #185FA5' : '1px dashed rgba(24,95,165,0.45)', background: on ? 'rgba(24,95,165,0.08)' : 'transparent' }}>
              {on && <div onPointerDown={e => down(e, it, 'size')} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
                style={{ position: 'absolute', right: -9, bottom: -9, width: 20, height: 20, borderRadius: 10, background: '#185FA5', border: '2px solid #fff', cursor: 'nwse-resize' }} />}
            </div>
          )
        })}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '6px 0 4px', flexWrap: 'wrap' }}>
        <button type="button" style={chip(false)} onClick={() => zoomAt(zoom / 1.5, tpl.w * fitScale / 2, viewH / 2)} disabled={zoom <= 1}>−</button>
        <span style={{ fontSize: 12, color: 'var(--text-muted)', minWidth: 44, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
        <button type="button" style={chip(false)} onClick={() => zoomAt(zoom * 1.5, tpl.w * fitScale / 2, viewH / 2)} disabled={zoom >= 8}>+</button>
        {zoom > 1 && <button type="button" style={chip(false)} onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }) }}>Вся бирка</button>}
        <button type="button" style={chip(grid)} onClick={toggleGrid} title="Сетка в миллиметрах, элементы встают по ней через 0,5 мм">📐 Разметка</button>
        {cur && zoom < 2.5 && <button type="button" style={chip(false)} onClick={() => { const [bw, bh] = itemBox(cur), z = 3; setZoom(z); setPan(clampPan({ x: tpl.w * fitScale / 2 - (cur.x + bw / 2) * fitScale * z, y: viewH / 2 - (cur.y + bh / 2) * fitScale * z }, z)) }}>🔍 К выбранному</button>}
      </div>
      <p style={{ fontSize: 11, color: 'var(--text-hint)', margin: '0 0 8px' }}>Перетащите элемент на своё место; у выбранного — синяя точка в углу меняет размер. {previewEl ? 'Увеличить — колёсиком мыши или «+», сдвинуть увеличенную бирку — мышью по пустому месту. Параметры выбранного элемента — справа.' : 'Увеличить — «+» или щипком двумя пальцами, сдвинуть увеличенную бирку — пальцем по пустому месту.'}</p>
    </div>
  )
  return (
    <div>
      {previewEl ? createPortal(previewPart, previewEl) : previewPart}
      {previewEl && !cur && <p style={{ fontSize: 12, color: 'var(--text-hint)', margin: '0 0 8px', padding: '8px 10px', background: 'var(--bg2)', borderRadius: 'var(--radius)' }}>Щёлкните по элементу на бирке слева — здесь откроются его настройки.</p>}
      {cur && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10, padding: '8px 10px', background: 'var(--bg2)', borderRadius: 'var(--radius)' }}>
          <div style={{ flex: '1 1 100%', fontSize: 13, fontWeight: 500 }}>{rem && cur.type === 'map' ? 'Карта раскроя — остаток чёрным' : itemTitle(cur.type)}{cur.img ? ' · картинкой' : ''}</div>
          {/* точная подвижка: шаг 0,5 мм (с увеличением — 0,2 мм) */}
          <div style={{ flex: '1 1 100%', display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>Сдвинуть на {zoom > 1.5 ? '0,2' : '0,5'} мм:</span>
            {[['←', -1, 0], ['→', 1, 0], ['↑', 0, -1], ['↓', 0, 1]].map(([l, ix, iy]) => {
              const st = zoom > 1.5 ? 0.2 : 0.5
              return <button key={l} type="button" style={{ ...chip(false), padding: '6px 13px', fontSize: 14 }} onClick={() => edit({ x: cur.x + ix * st, y: cur.y + iy * st })}>{l}</button>
            })}
          </div>
          <ItemPlace it={cur} tpl={tpl} edit={edit} />
          {!isBox(cur) && (
            <>
              <button type="button" style={chip(false)} onClick={() => edit({ size: cur.size - 0.3 })}>A−</button>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{cur.size.toFixed(1)} мм</span>
              <button type="button" style={chip(false)} onClick={() => edit({ size: cur.size + 0.3 })}>A+</button>
              <button type="button" style={{ ...chip(cur.bold), fontWeight: 700 }} onClick={() => edit({ bold: !cur.bold })}>Ж</button>
              <button type="button" style={chip(cur.ul !== 'none')} onClick={() => edit({ ul: cur.ul === 'none' ? 'below' : cur.ul === 'below' ? 'above' : 'none' })}>{cur.ul === 'below' ? 'Черта снизу' : cur.ul === 'above' ? 'Черта сверху' : 'Без черты'}</button>
              {/* текст в рамке: по строке — влево / центр / вправо; поперёк — вверх / центр / вниз; поворот */}
              <div style={{ flex: '1 1 100%', display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 11.5, color: 'var(--text-muted)', minWidth: 62 }}>По строке:</span>
                {[['left', '⇤ Влево'], ['center', '↔ Центр'], ['right', 'Вправо ⇥']].map(([k, l]) => <button key={k} type="button" style={chip(cur.align === k)} onClick={() => edit({ align: k })}>{l}</button>)}
              </div>
              <div style={{ flex: '1 1 100%', display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 11.5, color: 'var(--text-muted)', minWidth: 62 }}>По высоте:</span>
                {[['top', '⤒ Вверх'], ['middle', '↕ Центр'], ['bottom', '⤓ Вниз']].map(([k, l]) => (
                  <button key={k} type="button" style={chip((cur.valign || 'top') === k)} onClick={() => {
                    // рамка ещё в одну строку — сделать выше, иначе прижимать некуда
                    const th = textThick(cur), line = cur.size * 1.25
                    edit({ valign: k === 'top' ? undefined : k, ...(k !== 'top' && th <= line + 0.01 ? { th: Math.min(isVert(cur) ? tpl.w : tpl.h, line * 2) } : {}) })
                  }}>{l}</button>
                ))}
                <span style={{ fontSize: 11.5, color: 'var(--text-muted)', marginLeft: 4 }}>Высота поля:</span>
                <button type="button" style={chip(false)} onClick={() => edit({ th: Math.max(cur.size * 1.25, textThick(cur) - 1) })}>−</button>
                <span style={{ fontSize: 11, color: 'var(--text-hint)' }}>{textThick(cur).toFixed(1)} мм</span>
                <button type="button" style={chip(false)} onClick={() => edit({ th: textThick(cur) + 1 })}>+</button>
              </div>
              <div style={{ flex: '1 1 100%', display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 11.5, color: 'var(--text-muted)', minWidth: 62 }}>Поворот:</span>
                {[[-90, '⟲ 90°'], [90, '⟳ 90°']].map(([d, l]) => (
                  <button key={d} type="button" style={chip(false)} onClick={() => {
                    // поворот вокруг центра рамки: ширина и высота рамки меняются местами
                    const [bw, bh] = itemBox(cur), cx = cur.x + bw / 2, cy = cur.y + bh / 2
                    edit({ trot: (textRot(cur) + d + 360) % 360, x: cx - bh / 2, y: cy - bw / 2 })
                  }}>{l}</button>
                ))}
                <span style={{ fontSize: 11, color: 'var(--text-hint)' }}>{textRot(cur)}°</span>
              </div>
              {!rem && !['edgeTop', 'edgeBottom', 'edgeLeft', 'edgeRight'].includes(cur.type) && (
                <label style={{ flex: '1 1 100%', display: 'flex', alignItems: 'flex-start', gap: 7, fontSize: 12.5, margin: 0, cursor: 'pointer' }}>
                  <input type="checkbox" checked={!!cur.bind} onChange={e => edit({ bind: e.target.checked || undefined })} style={{ width: 17, height: 17, flex: '0 0 auto', marginTop: 1 }} />
                  <span>Привязать к стороне детали
                    <span style={{ display: 'block', fontSize: 11, color: 'var(--text-hint)' }}>Деталь повернулась на раскрое или на выходе со станка — элемент переезжает к той же стороне детали, как кромка (например, свойство «паз» у своей стороны). Без галочки стоит на своём месте.</span>
                  </span>
                </label>
              )}
            </>
          )}
          {canCaption(cur.type) && cur.type !== 'order' && !cur.img && !isBox(cur) && (
            <div style={{ flex: '1 1 100%', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>Подпись
                <input type="text" key={'cap' + cur.id + (cur.cap ?? '\u0000')} defaultValue={cur.cap ?? defaultCap(cur.type, tpl)} placeholder="без подписи" maxLength={30}
                  onBlur={e => { const v = e.target.value; if (v !== (cur.cap ?? defaultCap(cur.type, tpl))) edit({ cap: v }) }}
                  style={{ width: 140, marginLeft: 6, padding: '6px 8px' }} /></label>
              {cur.cap != null && cur.cap !== defaultCap(cur.type, tpl) && <button type="button" style={chip(false)} onClick={() => edit({ cap: undefined })}>Как было</button>}
              <span style={{ flex: '1 1 100%', fontSize: 11, color: 'var(--text-hint)' }}>Текст перед значением («Поз.», «Карта», «Пазов:» …). Сотрите — останется только значение, или напишите своё.</span>
            </div>
          )}
          {cur.type === 'order' && !cur.img && (
            <div style={{ flex: '1 1 100%', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>Подпись
                <input type="text" key={'op' + tpl.order.prefix} defaultValue={tpl.order.prefix} placeholder="без подписи" onBlur={e => { if (e.target.value !== tpl.order.prefix) onChange({ ...tpl, order: { ...tpl.order, prefix: e.target.value.trim() } }) }} style={{ width: 120, marginLeft: 6, padding: '6px 8px' }} /></label>
            </div>
          )}
          <ItemStyle it={cur} tpl={tpl} edit={edit} chip={chip} />
          {cur.type === 'part' && (
            <div style={{ flex: '1 1 100%', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button type="button" style={chip(tpl.part.dims)} onClick={() => onChange({ ...tpl, part: { ...tpl.part, dims: !tpl.part.dims } })}>{tpl.part.dims ? '✓ ' : ''}Размеры торцевых отверстий от края</button>
              {tpl.part.dims && (
                <>
                  <button type="button" style={chip(false)} onClick={() => onChange({ ...tpl, part: { ...tpl.part, dimSize: tpl.part.dimSize - 0.2 } })}>A−</button>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>цифры {tpl.part.dimSize.toFixed(1)} мм</span>
                  <button type="button" style={chip(false)} onClick={() => onChange({ ...tpl, part: { ...tpl.part, dimSize: tpl.part.dimSize + 0.2 } })}>A+</button>
                </>
              )}
            </div>
          )}
          {itemKind(cur.type) === 'text' && (
            <>
              <button type="button" style={chip(!!cur.img)} onClick={() => fileRef.current?.click()}>🖼 {cur.img ? 'Другая картинка' : 'Картинка вместо текста'}</button>
              <button type="button" style={chip(false)} onClick={() => { const u = window.prompt('Адрес картинки в интернете (https://…)'); if (u) setImage(u.trim()) }}>🔗 По ссылке</button>
              {cur.img && <button type="button" style={chip(false)} onClick={reEdit}>✂ Убрать фон / обработать</button>}
              {cur.img && cur.type !== 'image' && <button type="button" style={chip(false)} onClick={() => edit({ img: undefined })}>Вернуть текст</button>}
              <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) setImage(f) }} />
            </>
          )}
          {/* картинка: повернуть, вписать рамку по картинке, во всю бирку, крупнее / мельче, по центру бирки */}
          {cur.img && (() => {
            const r = cur.irot || 0, sz = labelImageSize(cur.img, r), ar = sz ? sz.w / sz.h : cur.w / cur.h
            const cx = cur.x + cur.w / 2, cy = cur.y + cur.h / 2
            // рамка с пропорциями картинки, не больше бирки; центр — на месте
            const box = (w, h, mx = cx, my = cy) => {
              const k = Math.min(1, tpl.w / w, tpl.h / h), W = Math.max(3, w * k), H = Math.max(3, h * k)
              return { w: W, h: H, x: Math.max(0, Math.min(tpl.w - W, mx - W / 2)), y: Math.max(0, Math.min(tpl.h - H, my - H / 2)) }
            }
            const rotate = d => { const nr = (r + d + 360) % 360, nar = 1 / ar; edit({ irot: nr || undefined, ...box(Math.sqrt(cur.w * cur.h * nar), Math.sqrt(cur.w * cur.h / nar)) }) }
            const fit = () => edit(box(Math.sqrt(cur.w * cur.h * ar), Math.sqrt(cur.w * cur.h / ar)))
            const full = () => { const W = Math.min(tpl.w, tpl.h * ar); edit(box(W, W / ar, tpl.w / 2, tpl.h / 2)) }
            const scale = f => edit(box(Math.max(3, cur.w * f), Math.max(3, cur.h * f)))
            return (
              <div style={{ flex: '1 1 100%', display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>Картинка:</span>
                <button type="button" style={chip(false)} onClick={() => rotate(-90)} title="Повернуть влево">⟲ 90°</button>
                <button type="button" style={chip(false)} onClick={() => rotate(90)} title="Повернуть вправо">⟳ 90°</button>
                {r ? <span style={{ fontSize: 11, color: 'var(--text-hint)' }}>{r}°</span> : null}
                <button type="button" style={chip(false)} onClick={() => scale(1 / 1.15)}>− мельче</button>
                <button type="button" style={chip(false)} onClick={() => scale(1.15)}>+ крупнее</button>
                <button type="button" style={chip(false)} onClick={fit} title="Рамка по форме картинки — без пустых полей">▣ Рамка по картинке</button>
                <button type="button" style={chip(false)} onClick={full} title="Максимально — во всю бирку, по центру">⛶ Во всю бирку</button>
                <button type="button" style={chip(false)} onClick={() => edit({ x: (tpl.w - cur.w) / 2 })}>↔ По центру</button>
                <button type="button" style={chip(false)} onClick={() => edit({ y: (tpl.h - cur.h) / 2 })}>↕ По центру</button>
                <button type="button" style={chip(false)} onClick={() => edit({ x: (tpl.w - cur.w) / 2, y: (tpl.h - cur.h) / 2 })}>✛ В центр бирки</button>
                <span style={{ fontSize: 11, color: 'var(--text-hint)' }}>{cur.w.toFixed(1)} × {cur.h.toFixed(1)} мм</span>
              </div>
            )
          })()}
          {imgErr && <div style={{ flex: '1 1 100%', fontSize: 11, color: 'var(--danger)' }}>{imgErr}</div>}
          {cur.img && cur.type !== 'image' && <div style={{ flex: '1 1 100%', fontSize: 11, color: 'var(--text-hint)' }}>Картинка печатается только на бирках тех деталей, у которых этот параметр есть.</div>}
          <button type="button" style={{ ...chip(false), color: 'var(--danger)', borderColor: 'var(--danger)', marginLeft: 'auto' }}
            onClick={() => { onChange({ ...tpl, items: tpl.items.filter(i => i.id !== sel) }); setSel(null) }}>Убрать</button>
        </div>
      )}
      {used.has('qr') && rem && (
        <div style={{ marginBottom: 10, padding: '8px 10px', border: '0.5px solid var(--border-md)', borderRadius: 'var(--radius)' }}>
          <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 6 }}>Что зашито в QR-код остатка</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {REM_QR_PARTS.map(([k, l]) => {
              const q = t.remQr || { parts: [], sep: ';' }, on = q.parts.includes(k)
              return <button key={k} type="button" style={chip(on)} onClick={() => onChange({ ...tpl, remQr: { ...q, parts: on ? q.parts.filter(x => x !== k) : REM_QR_PARTS.map(([x]) => x).filter(x => x === k || q.parts.includes(x)) } })}>{l}</button>
            })}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 6, wordBreak: 'break-all' }}>В коде: {remQrText(t, remInfo(rem))}</div>
          <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 2 }}>По этому коду остаток потом можно будет найти и учесть на складе деловых остатков.</div>
        </div>
      )}
      {used.has('qr') && !rem && (
        <div style={{ marginBottom: 10, padding: '8px 10px', border: '0.5px solid var(--border-md)', borderRadius: 'var(--radius)' }}>
          <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 6 }}>Что зашито в QR-код</div>
          {qrHasLink(tpl.qr) && (
            <p style={{ fontSize: 11, margin: '0 0 6px', color: shared ? 'var(--teal)' : 'var(--amber)' }}>
              {shared ? '✓ У заказа открыта ссылка на 3D-модель: по QR-коду откроется эта деталь, дальше — вверх по структуре (блок, изделие, вся модель). В коде только ссылка, остальные части не добавляются.'
                : 'Ссылка на 3D-модель у этого заказа не открыта — в код пойдут обычные части ниже. Откройте ссылку в заказе: «3D-модель» → «Ссылка».'}
            </p>
          )}
          {/* тот же конструктор — у имени файла присадочного станка (ЧПУ → постпроцессор присадки) */}
          <QrPartsEditor value={tpl.qr} props={userItems(mat?.details)} onChange={qr => onChange({ ...tpl, qr })} preview={mat ? labelQr(tpl, labelInfo(order, mat, 0, 0)) : null} />
          <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 6 }}>Этот же код может быть именем файла программы шестистороннего станка: на станке бирку сканируют — открывается программа детали (настройка в постпроцессоре присадки).</div>
        </div>
      )}
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Добавить на бирку</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        {/* любой параметр можно поставить несколько раз: например, один раз текстом, другой — картинкой в другом месте */}
        {(rem ? REM_ITEMS : [...PART_ITEMS, ...metaItems(mat?.details)]).map(([k, label]) => addChip(k, label))}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Разметка — линии, рамки, таблица</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        {SHAPE_ITEMS.map(([k, label]) => addChip(k, label))}
      </div>
      {/* пользовательские параметры деталей: колонки таблицы при импорте Excel/CSV и пользовательские свойства из Базиса —
          под теми же названиями, что в источнике; на бирке — значение у каждой детали */}
      {!rem && (() => {
        const list = userItems(mat?.details)
        t.items.forEach(i => { if (i.type.startsWith('user:') && !list.some(([k]) => k === i.type)) list.push([i.type, itemTitle(i.type)]) })
        return (
          <>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Параметры деталей — колонки таблицы, свойства из Базиса</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: list.length ? 10 : 4 }}>
              {list.map(([k, label]) => addChip(k, label))}
              {/* параметр можно поставить заранее, ещё до импорта: по названию колонки таблицы или свойства из Базиса */}
              <button type="button" style={{ ...chip(false), borderStyle: 'dashed' }} onClick={() => {
                const n = (window.prompt('Название параметра — точно как колонка в таблице или пользовательское свойство в Базисе:', '') || '').trim().slice(0, 40)
                if (!n) return
                const it = newLabelItem('user:' + n, tpl)
                onChange({ ...tpl, items: [...tpl.items, it] }); setSel(it.id)
              }}>+ Свой параметр…</button>
            </div>
            {!list.length && <div style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 10 }}>Параметры появляются после импорта таблицы (колонки «Свойство (на бирку)») или модели Базиса с пользовательскими свойствами. Можно добавить заранее — по названию.</div>}
          </>
        )
      })()}
      {imgEdit && <LabelImageEditor src={imgEdit.src} onDone={putImage} onCancel={() => setImgEdit(null)} />}
    </div>
  )
}

// Настройка шаблона бирки: размер, мои шаблоны, расстановка элементов, чертёж детали, разрешение.
// Одна и та же — в бирках заказа и в «Настройки производства → Бирки» (там — на образцовой детали, без заказа).
export function LabelSetup({ tpl, setTpl, user, order, mat, shared, previewEl = null }) {
  const [hist, setHist] = useState([])               // прежние состояния шаблона — для «Отменить»
  const [savedT, setSavedT] = useState(() => getLabelSaved(user))   // «Мои шаблоны бирок»
  const [curSaved, setCurSaved] = useState(() => getUserSettings(user).labelSavedCur || '')   // какой сохранённый шаблон открыт
  const apply = t => { setHist(h => [...h.slice(-39), tpl]); setTpl(t); saveLabelTpl(t, user) }
  const change = patch => apply(normalizeLabel({ ...tpl, ...patch, enabled: true }))
  const putSaved = list => { setSavedT(list); saveLabelSaved(list, user) }
  // Текущий шаблон: открыли сохранённый — правки сохраняются в него же («Сохранить» перезаписывает, а не плодит копии);
  // то же имя при сохранении — перезапись существующего. Новый шаблон — под новым именем
  const cur = savedT.find(x => x.id === curSaved) || null
  const setCur = id => { setCurSaved(id); saveUserSettings({ labelSavedCur: id || '' }, user) }
  const saveTpl = () => {
    const def = cur ? cur.name : `Бирка ${tpl.w}×${tpl.h}`
    const name = window.prompt(cur ? `Сохранить шаблон (то же имя — перезаписать «${cur.name}», другое — новый шаблон):` : 'Сохранить шаблон бирки под именем:', def)
    if (name === null) return
    const nm = name.trim() || def
    const same = savedT.find(x => x.name.trim().toLowerCase() === nm.toLowerCase())
    if (same) { putSaved(savedT.map(x => (x.id === same.id ? { ...x, name: nm, tpl: { ...tpl, enabled: true }, at: Date.now() } : x))); setCur(same.id); return }
    const id = Math.random().toString(36).slice(2, 10)
    putSaved([...savedT, { id, name: nm, at: Date.now(), tpl: { ...tpl, enabled: true } }]); setCur(id)
  }
  const applySaved = sv => { if (window.confirm(`Открыть шаблон «${sv.name}» (${sv.tpl.w}×${sv.tpl.h} мм)?\nТекущая раскладка заменится — её можно вернуть кнопкой «Отменить».`)) { apply(normalizeLabel({ ...sv.tpl, enabled: true })); setCur(sv.id) } }
  const undo = () => { const prev = hist[hist.length - 1]; if (!prev) return; setHist(h => h.slice(0, -1)); setTpl(prev); saveLabelTpl(prev, user) }
  const size = (k, v) => { const x = Number(String(v).replace(',', '.')); if (isFinite(x) && x > 0) { apply({ ...resizeLabel(tpl, k === 'w' ? x : tpl.w, k === 'h' ? x : tpl.h), enabled: true }) } }
  return (
    <>
            {/* компьютер: бирка слева, а настройки выбранного элемента и «добавить на бирку» — сразу вверху справа */}
            {previewEl && mat && <LabelEditor tpl={tpl} onChange={change} order={order} mat={mat} shared={shared} previewEl={previewEl} />}
            <div className="row2" style={{ marginTop: 8 }}>
              <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>Ширина, мм
                <input type="text" inputMode="decimal" key={'w' + tpl.w} defaultValue={tpl.w} onBlur={e => size('w', e.target.value)} style={{ marginTop: 3, padding: '8px 10px' }} /></label>
              <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>Высота, мм
                <input type="text" inputMode="decimal" key={'h' + tpl.h} defaultValue={tpl.h} onBlur={e => size('h', e.target.value)} style={{ marginTop: 3, padding: '8px 10px' }} /></label>
            </div>
            <div style={{ height: 10 }} />
            <button type="button" disabled={!hist.length} onClick={undo}
              style={{ padding: '7px 14px', borderRadius: 20, fontSize: 13, marginBottom: 8, border: '0.5px solid ' + (hist.length ? 'var(--blue)' : 'var(--border-md)'), background: 'transparent', color: hist.length ? 'var(--blue)' : 'var(--text-hint)' }}>
              ↶ Отменить{hist.length ? ` (${hist.length})` : ''}
            </button>
            {/* мои шаблоны бирок: сохранить текущий, применить сохранённый (другой размер, другая раскладка) */}
            <div style={{ margin: '0 0 10px', padding: '8px 10px', background: 'var(--bg2)', borderRadius: 'var(--radius)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: savedT.length ? 6 : 0 }}>
                <div style={{ flex: 1, fontSize: 13, fontWeight: 500 }}>Мои шаблоны{savedT.length ? ` · ${savedT.length}` : ''}{cur && <span style={{ display: 'block', fontSize: 11, fontWeight: 400, color: 'var(--text-hint)' }}>Открыт: {cur.name}</span>}</div>
                <button type="button" onClick={saveTpl} style={{ padding: '6px 12px', borderRadius: 20, fontSize: 12, border: 'none', background: 'var(--blue)', color: 'white' }}>💾 {cur ? 'Сохранить' : 'Сохранить шаблон'}</button>
              </div>
              {!savedT.length && <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 4 }}>Настройте бирку и сохраните — потом можно переключаться между шаблонами одним тапом.</div>}
              {[...savedT].sort((a, b) => (b.at || 0) - (a.at || 0)).map(sv => (
                <div key={sv.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 0', borderTop: '0.5px solid var(--border)' }}>
                  <div onClick={() => applySaved(sv)} style={{ flex: 1, minWidth: 0, cursor: 'pointer' }}>
                    <div style={{ fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--blue-dark)', fontWeight: sv.id === curSaved ? 600 : 400 }}>{sv.id === curSaved ? '● ' : ''}{sv.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-hint)' }}>{sv.tpl.w}×{sv.tpl.h} мм · элементов {sv.tpl.items?.length || 0}{sv.at ? ` · ${new Date(sv.at).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' })}` : ''}</div>
                  </div>
                  <button type="button" title="Перезаписать текущим" onClick={() => { if (window.confirm(`Перезаписать «${sv.name}» текущей биркой (${tpl.w}×${tpl.h} мм)?`)) putSaved(savedT.map(x => (x.id === sv.id ? { ...x, tpl: { ...tpl, enabled: true }, at: Date.now() } : x))) }}
                    style={{ width: 32, height: 32, borderRadius: 16, border: 'none', background: 'var(--bg)', fontSize: 13 }}>💾</button>
                  <button type="button" title="Переименовать" onClick={() => { const n = window.prompt('Название шаблона', sv.name); if (n && n.trim()) putSaved(savedT.map(x => (x.id === sv.id ? { ...x, name: n.trim() } : x))) }}
                    style={{ width: 32, height: 32, borderRadius: 16, border: 'none', background: 'var(--bg)', fontSize: 13 }}>✎</button>
                  <button type="button" title="Удалить" onClick={() => { if (window.confirm(`Удалить шаблон «${sv.name}»?`)) { putSaved(savedT.filter(x => x.id !== sv.id)); if (curSaved === sv.id) setCur('') } }}
                    style={{ width: 32, height: 32, borderRadius: 16, border: 'none', background: 'var(--bg)', fontSize: 13, color: 'var(--danger)' }}>🗑</button>
                </div>
              ))}
            </div>
            {mat ? (previewEl ? null   // компьютер: редактор стоит в начале правой колонки (см. выше), бирка — слева
              : <LabelEditor tpl={tpl} onChange={change} order={order} mat={mat} shared={shared} />)
              : <p style={{ fontSize: 12, color: 'var(--text-hint)' }}>Расставить элементы можно в заказе с сохранённым раскроем — бирка показывается на настоящей детали.</p>}
            {[['rot', 'Лист на бирке — горизонтально (длина листа слева направо); деталь и кромка повёрнуты так же'], ['edgeDims', 'Размер стороны у кромки (например «ПВХ 2 мм · 720»)']].map(([k, label]) => (
              <label key={k} style={{ display: 'flex', alignItems: 'flex-start', gap: 7, fontSize: 12.5, cursor: 'pointer', marginBottom: 6 }}>
                <input type="checkbox" checked={!!tpl[k]} onChange={e => change({ [k]: e.target.checked })} style={{ width: 17, height: 17, flex: '0 0 auto', marginTop: 1 }} />
                {label}
              </label>
            ))}
            <div style={{ fontSize: 12.5, fontWeight: 500, margin: '4px 0 6px' }}>Чертёж детали</div>
            {[['contour', 'Линия контура', 0.02, 2], ['hole', 'Точка отверстия', 0.05, 2]].map(([k, label, step, dg]) => (
              <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, fontSize: 12.5, color: 'var(--text-muted)' }}>
                <span style={{ flex: 1 }}>{label}</span>
                <button type="button" onClick={() => change({ part: { ...tpl.part, [k]: tpl.part[k] - step } })} style={{ padding: '5px 14px', borderRadius: 20, fontSize: 14, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text-muted)' }}>−</button>
                <span style={{ minWidth: 58, textAlign: 'center' }}>{tpl.part[k].toFixed(dg)} мм</span>
                <button type="button" onClick={() => change({ part: { ...tpl.part, [k]: tpl.part[k] + step } })} style={{ padding: '5px 14px', borderRadius: 20, fontSize: 14, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text-muted)' }}>+</button>
              </div>
            ))}
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 7, fontSize: 12.5, cursor: 'pointer', marginBottom: 6 }}>
              <input type="checkbox" checked={!!tpl.part.ring} onChange={e => change({ part: { ...tpl.part, ring: e.target.checked } })} style={{ width: 17, height: 17, flex: '0 0 auto', marginTop: 1 }} />
              Отверстия кружком, без заливки
            </label>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 7, fontSize: 12.5, cursor: 'pointer', marginBottom: 6 }}>
              <input type="checkbox" checked={!!tpl.part.dims} onChange={e => change({ part: { ...tpl.part, dims: e.target.checked } })} style={{ width: 17, height: 17, flex: '0 0 auto', marginTop: 1 }} />
              Показывать размеры торцевых отверстий от края
            </label>
            {tpl.part.dims && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 8px 24px', fontSize: 12.5, color: 'var(--text-muted)' }}>
                Высота цифр
                {[['A−', -0.2], ['A+', 0.2]].map(([t, d], i) => (
                  <button key={t} type="button" onClick={() => change({ part: { ...tpl.part, dimSize: tpl.part.dimSize + d } })}
                    style={{ order: i ? 3 : 1, padding: '5px 12px', borderRadius: 20, fontSize: 13, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text-muted)' }}>{t}</button>
                ))}
                <span style={{ order: 2 }}>{tpl.part.dimSize.toFixed(1)} мм</span>
              </div>
            )}
            {!tpl.items.some(i => i.type === 'part') && tpl.part.dims && <p style={{ fontSize: 11, color: 'var(--amber)', margin: '0 0 8px 24px' }}>Чертежа детали на бирке сейчас нет — добавьте его кнопкой «+ Чертёж детали».</p>}
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 8 }}>
              Разрешение печати
              <select value={tpl.dpi} onChange={e => change({ dpi: Number(e.target.value) })} style={{ width: 'auto', padding: '5px 8px', fontSize: 13 }}>
                <option value={203}>203 dpi (обычный принтер бирок)</option>
                <option value={300}>300 dpi</option>
                <option value={600}>600 dpi</option>
              </select>
            </label>
            <button type="button" onClick={() => { if (window.confirm('Вернуть раскладку по образцу?')) change(resizeLabel({ ...DEFAULT_LABEL(), rot: tpl.rot }, tpl.w, tpl.h)) }}
              style={{ padding: '6px 11px', borderRadius: 20, fontSize: 12, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text-muted)' }}>↺ Раскладка по образцу</button>
            <p style={{ fontSize: 11, color: 'var(--text-hint)', margin: '8px 0 0' }}>
              Шаблон сохраняется в аккаунте. Когда он настроен, в разделе ЧПУ при создании G-кода появляется галочка «Программа для маркировочного стола».
            </p>
    </>
  )
}

export default function LabelsPage() {
  const desk = useDesktop()   // компьютер: шаблон бирки открывается на весь экран — бирка слева, настройки справа
  const [lblPrev, setLblPrev] = useState(null)
  const { id } = useParams()
  const navigate = useNavigate()
  const { user, cabinet } = useAuth()
  const [order, setOrder] = useState(null)
  const [clientName, setClientName] = useState('')   // имя заказчика — для названий файлов и папки
  useEffect(() => { let alive = true; orderClient(id).then(r => { if (alive && !r.error) setClientName(r.data?.full_name || '') }); return () => { alive = false } }, [id])
  const [details, setDetails] = useState([])
  const [loading, setLoading] = useState(true)
  const [matKey, setMatKey] = useState('')
  const [tpl, setTpl] = useState(() => getLabelTpl(user))
  const [setup, setSetup] = useState(() => !getLabelTpl(user).enabled)
  const [busy, setBusy] = useState(false)
  // ссылка на 3D-модель заказа (для QR) и сама модель (для кнопки «3D» в просмотре бирки)
  const [shared, setShared] = useState(() => !!cachedShare(id))
  useEffect(() => { const sync = () => setShared(!!cachedShare(id)); const off = onShareChange(sync); getShare(id).then(sync); return off }, [id])
  const [scene, setScene] = useState(undefined)
  const [pdf, setPdf] = useState('')                 // ход сборки PDF
  // Бирка во весь экран и 3D её детали — в адресе страницы (?lbl=…&d3=1): кнопка «назад» телефона
  // закрывает 3D, затем просмотр бирки, а не уводит со страницы бирок.
  const [search] = useSearchParams()
  const view = search.get('lbl') != null ? Number(search.get('lbl')) : null
  const show3d = search.get('d3') === '1'
  const setView = n => navigate(`?lbl=${n}`, { replace: view != null })
  const closeView = () => navigate(-1)
  // Сколько бирок в ряд — как в галерее телефона и на картах раскроя: щипок раздвигает (крупнее, меньше в ряд)
  // или сводит (мельче, больше в ряд), сетка встаёт на ближайшее число колонок. Бирка под пальцами остаётся на месте.
  const MAX_COLS = 10
  const [cols, setColsRaw] = useState(() => { try { return Math.max(1, Math.min(MAX_COLS, Number(localStorage.getItem('lblCols')) || 2)) } catch { return 2 } })
  const colsRef = useRef(cols)
  colsRef.current = cols
  const anchor = useRef(null)                        // { n, y, k, step, ox, oy } — что было под пальцами
  const [gridEl, setGridEl] = useState(null)
  const [remEdit, setRemEdit] = useState(false)      // открыт шаблон бирки делового остатка
  const [remPrev, setRemPrev] = useState(null)       // компьютер: место для бирки остатка слева
  useEffect(() => () => document.getElementById('lbl-print')?.remove(), [])   // ушли со страницы — блок печати убрать
  const setCols = (next, a = null) => {
    const c = Math.max(1, Math.min(MAX_COLS, Math.round(next)))
    if (c === colsRef.current) { if (gridEl) { gridEl.style.transition = 'transform 180ms ease-out'; gridEl.style.transform = 'scale(1)' } return }
    if (!a && gridEl) {                              // кнопки: держим на месте первую видимую бирку
      const first = [...gridEl.querySelectorAll('[data-lbl]')].find(el => el.getBoundingClientRect().bottom > 60)
      if (first) a = { n: first.dataset.lbl, y: first.getBoundingClientRect().top }
    }
    anchor.current = a ? { ...a, step: colsRef.current / c } : null
    try { localStorage.setItem('lblCols', String(c)) } catch { /* без памяти */ }
    setColsRaw(c)
  }
  const setColsRef = useRef(setCols)
  setColsRef.current = setCols
  useLayoutEffect(() => {
    const a = anchor.current
    anchor.current = null
    if (!a || !gridEl) return
    const el = gridEl.querySelector(`[data-lbl="${a.n}"]`)
    if (el) window.scrollBy(0, el.getBoundingClientRect().top - a.y)
    if (a.k) {                                       // остаток растяжения пальцами плавно уходит в 1
      gridEl.style.transition = 'none'; gridEl.style.transform = `scale(${a.k / a.step})`
      requestAnimationFrame(() => requestAnimationFrame(() => { gridEl.style.transition = 'transform 180ms ease-out'; gridEl.style.transform = 'scale(1)' }))
    }
  }, [cols, gridEl])
  useEffect(() => {
    const el = gridEl
    if (!el) return
    const st = { on: false, d: 0, k: 1, n: null, y: 0 }
    const dist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)
    const start = e => {
      if (e.touches.length !== 2) return
      const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2, my = (e.touches[0].clientY + e.touches[1].clientY) / 2
      const r = el.getBoundingClientRect()
      // бирка под пальцами (или ближайшая к ним по высоте)
      const all = [...el.querySelectorAll('[data-lbl]')]
      const hit = all.find(c => { const b = c.getBoundingClientRect(); return mx >= b.left && mx <= b.right && my >= b.top && my <= b.bottom })
        || all.reduce((best, c) => { const b = c.getBoundingClientRect(), d = Math.abs((b.top + b.bottom) / 2 - my) + Math.abs((b.left + b.right) / 2 - mx); return !best || d < best.d ? { c, d } : best }, null)?.c
      st.on = true; st.d = dist(e.touches); st.k = 1
      st.n = hit ? hit.dataset.lbl : null; st.y = hit ? hit.getBoundingClientRect().top : my
      el.style.transition = 'none'; el.style.transformOrigin = `${mx - r.left}px ${my - r.top}px`
    }
    const move = e => {
      if (!st.on || e.touches.length !== 2) return
      if (e.cancelable) e.preventDefault()
      if (st.d <= 0) return
      const c = colsRef.current
      st.k = Math.max(c / MAX_COLS * 0.87, Math.min(c * 1.15, dist(e.touches) / st.d))      // от 10 в ряд до 1, с небольшой «пружиной»
      el.style.transform = `scale(${st.k})`
    }
    const end = e => {
      if (!st.on || e.touches.length >= 2) return
      st.on = false
      setColsRef.current(colsRef.current / st.k, st.n != null ? { n: st.n, y: st.y, k: st.k } : null)
    }
    el.addEventListener('touchstart', start, { passive: true })
    el.addEventListener('touchmove', move, { passive: false })
    el.addEventListener('touchend', end, { passive: true })
    el.addEventListener('touchcancel', end, { passive: true })
    return () => { el.removeEventListener('touchstart', start); el.removeEventListener('touchmove', move); el.removeEventListener('touchend', end); el.removeEventListener('touchcancel', end) }
  }, [gridEl])
  const [saveAsk, setSaveAsk] = useState(null)       // файлы маркировочного стола: вопрос «по отдельности или архивом»
  useEffect(() => {
    let alive = true
    ;(async () => {
      const { data: o } = await supabase.from('orders').select('*').eq('id', id).single()
      const { data: d } = await supabase.from('order_details').select('*').eq('order_id', id).order('sort_order')
      if (alive) { setOrder(o || null); setDetails(cutDetails(d || [], parseEdgeTypes(o?.edge_types)))   /* заготовки: с учётом кромки, как в раскрое */; setLoading(false) }
    })()
    return () => { alive = false }
  }, [id])
  const mats = useMemo(() => savedNestings(order, details), [order, details])
  const mat = mats.find(m => m.key === matKey) || mats[0] || null
  const bp = useMemo(() => beamPostOf(user), [user])   // постпроцессор пилы — для бирок пильного центра
  if (loading) return <div className="page"><CncLoader label="Готовим бирки…" /></div>
  if (!order) return <div className="page"><p>Заказ не найден</p></div>
  const total = mat ? mat.sheets.reduce((a, s) => a + s.placed.length, 0) : 0
  // номера страниц — как в PDF всех бирок (с бирками обрезков, если они включены)
  const pageNos = mat && tpl ? labelPages(order, mat, tpl, isBeamMat(mat) ? beamLabelSeq : null) : { map: new Map(), total: 0 }
  const allLabels = mat ? mat.sheets.flatMap((sh, si) => (isBeamMat(mat) ? beamLabelSeq(sh, sheetGeo(order, mat.result, sh), null).map(q => q.pi) : labelOrder(sh, sheetGeo(order, mat.result, sh), 'manual')).map(pi => ({ si, pi }))).map((q, n) => ({ ...q, n, page: pageNos.map.get(`${q.si}:${q.pi}`), pages: pageNos.total })) : []
  const apply = t => { setTpl(t); saveLabelTpl(t, user) }   // настройки бирок на деловые остатки
  // файлы маркировочного стола — тем же набором, что делает ЧПУ вместе с G-кодом
  // все бирки одним PDF: бирка — страница, страница размером с бирку
  const savePdf = async () => {
    setPdf('Готовим PDF…')
    try {
      const data = await buildLabelsPdf({ order, mat, tpl, onProgress: (a, b) => setPdf(`PDF: ${a} из ${b}`), ...beamOpts(mat, bp) })
      const url = URL.createObjectURL(new Blob([data], { type: 'application/pdf' }))
      const a = document.createElement('a'); a.href = url; a.download = `Birki_${orderFileName(order)}${mats.length > 1 ? '_' + safeName(mat.name).slice(0, 24) : ''}.pdf`
      document.body.appendChild(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 5000)
    } finally { setPdf('') }
  }
  // Печать: бирки — картинками в отдельном блоке, а всё приложение на время печати скрыто. Раньше печатались сами
  // canvas внутри страницы — на компьютере выходили пустые страницы (слой с will-change/transform, сдвиг закреплённого
  // меню, анимация появления страницы). Картинка печатается всегда, независимо от раскладки экрана.
  const printLabels = async () => {
    const cvs = gridEl ? [...gridEl.querySelectorAll('.lbl-grid canvas')] : []
    let urls
    try { urls = cvs.map(cv => cv.toDataURL('image/png')) } catch { urls = null }   // картинка с чужого сайта — печатаем по-старому
    if (!urls || !urls.length) { window.print(); return }
    document.getElementById('lbl-print')?.remove()
    const box = document.createElement('div')
    box.id = 'lbl-print'
    const css = document.createElement('style')
    css.textContent = `@media screen { #lbl-print { display: none } }
@media print {
  @page { size: ${tpl.w}mm ${tpl.h}mm; margin: 0 }
  html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
  body > *:not(#lbl-print) { display: none !important; }
  #lbl-print { display: block !important; }
  #lbl-print img { display: block; width: ${tpl.w}mm; height: ${tpl.h}mm; margin: 0; break-after: page; page-break-after: always; }
  #lbl-print img:last-child { break-after: auto; page-break-after: auto; }
}`
    box.appendChild(css)
    const imgs = urls.map(u => { const im = document.createElement('img'); im.src = u; im.alt = ''; box.appendChild(im); return im })
    document.body.appendChild(box)
    await Promise.all(imgs.map(im => (im.decode ? im.decode().catch(() => {}) : Promise.resolve())))
    const done = () => { window.removeEventListener('afterprint', done); setTimeout(() => box.remove(), 500) }
    window.addEventListener('afterprint', done)
    window.print()
  }
  const exportFiles = async () => {
    setBusy(true)
    try {
      const post = routerPost(getCnc(user)), base = programName(post.nameTpl, { n: null, total: mat.sheets.length, order, material: mat.name || order.material_name || '', thickness: mat.thickness, client: clientName })   // как у программ ЧПУ
      const files = await buildLabelFiles({ order, mat, base, post, tpl, ...beamOpts(mat, bp), sheets: mat.sheets.map((_, si) => ({ si, nc: `${programName(post.nameTpl, { n: si + 1, total: mat.sheets.length, order, material: mat.name || order.material_name || '', thickness: mat.thickness, client: clientName })}.${post.ext || 'nc'}` })) })
      setSaveAsk({ files, zipName: `Birki_${fileNameOf('zip', fileNamesOf(user).zip, { total: mat.sheets.length, order, material: mat.name || order.material_name || '', thickness: mat.thickness, client: clientName })}.zip` })
    } finally { setBusy(false) }
  }
  const pill = { padding: '8px 14px', borderRadius: 20, border: 'none', background: 'var(--blue)', color: 'white', fontSize: 13 }
  return (
    <div className="page" style={{ paddingBottom: 40, '--lbl-w': tpl.w + 'mm', '--lbl-h': tpl.h + 'mm' }}>
      <style>{CSS}{`@media print { @page { size: ${tpl.w}mm ${tpl.h}mm; margin: 0 } }`}</style>
      <div className="no-print" style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, paddingTop: 4 }}>
        <button onClick={() => navigate(-1)} style={{ background: 'none', border: 'none', color: 'var(--blue)', fontSize: 22, padding: 0 }}>←</button>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 500 }}>Бирки</div>
          <div style={{ fontSize: 12, color: 'var(--text-hint)' }}><span>{orderTitle(order)}</span> · {total} шт. · {tpl.w}×{tpl.h} мм</div>
          <ShareBadge orderId={order.id} style={{ marginTop: 3 }} />
        </div>
        <button onClick={() => navigate(cabinet === 'production' ? '/production' : '/orders')} style={{ padding: '7px 11px', borderRadius: 20, fontSize: 12, border: '0.5px solid var(--blue)', background: 'transparent', color: 'var(--blue)', whiteSpace: 'nowrap' }}>К заказам</button>
        {mat && <button onClick={savePdf} disabled={!!pdf} style={{ ...pill, background: 'var(--teal)' }}>{pdf || '⬇ PDF'}</button>}
        {mat && <button onClick={printLabels} style={pill}>🖨 Печать</button>}
      </div>

      <div className="card no-print" style={{ marginBottom: 10, padding: 0, overflow: 'hidden' }}>
        <div onClick={() => setSetup(v => !v)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', cursor: 'pointer' }}>
          <span style={{ fontSize: 12, color: 'var(--text-hint)', width: 12 }}>{setup ? '▼' : '▶'}</span>
          <div style={{ flex: 1, fontSize: 14, fontWeight: 500 }}>Шаблон бирки</div>
          <span style={{ fontSize: 11, color: tpl.enabled ? 'var(--teal)' : 'var(--text-hint)' }}>{tpl.enabled ? '✓ настроен' : 'не настроен'}</span>
        </div>
        {setup && desk && (
          <div className="no-print" style={{ position: 'fixed', inset: 0, zIndex: 900, background: 'var(--bg2)', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 20px', background: 'var(--bg)', borderBottom: '0.5px solid var(--border)' }}>
              <button type="button" onClick={() => setSetup(false)} style={{ background: 'none', border: 'none', color: 'var(--blue)', fontSize: 22, padding: 0, lineHeight: 1 }}>←</button>
              <div style={{ flex: 1, fontSize: 16, fontWeight: 500 }}>Шаблон бирки · {tpl.w}×{tpl.h} мм</div>
              {mat && <button type="button" disabled={busy} onClick={exportFiles} style={{ padding: '7px 12px', borderRadius: 20, fontSize: 12, border: '0.5px solid var(--blue)', background: 'transparent', color: 'var(--blue)' }}>{busy ? 'Собираем файлы…' : '⬇ Файлы для маркировочного стола'}</button>}
              <button type="button" onClick={() => setSetup(false)} style={{ padding: '7px 16px', borderRadius: 'var(--radius)', border: 'none', background: 'var(--blue)', color: 'white', fontSize: 13 }}>Готово</button>
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
              <DeskSplit id="label-tpl" def={0.6} full="parent" left={<div ref={setLblPrev} />}
                right={<LabelSetup tpl={tpl} setTpl={setTpl} user={user} order={order} mat={mat} shared={shared} previewEl={lblPrev} />} />
            </div>
          </div>
        )}
        {setup && !desk && (
          <div style={{ padding: '4px 12px 12px', borderTop: '0.5px solid var(--border)' }}>
            <LabelSetup tpl={tpl} setTpl={setTpl} user={user} order={order} mat={mat} shared={shared} />
            {mat && <button type="button" className="btn-secondary" style={{ marginTop: 10 }} disabled={busy} onClick={exportFiles}>{busy ? 'Собираем файлы…' : '⬇ Файлы для маркировочного стола'}</button>}
          </div>
        )}
      </div>

      {!mat && <div className="card no-print"><p style={{ fontSize: 13, color: 'var(--text-muted)' }}>У заказа нет сохранённого раскроя — бирки строятся по листам раскроя.</p></div>}
      {mats.length > 1 && (
        <select className="no-print" value={mat.key} onChange={e => setMatKey(e.target.value)} style={{ marginBottom: 10 }}>
          {mats.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
        </select>
      )}
      {mat && (() => {
        const n = mat.sheets.reduce((x, sh) => x + sheetOffcuts(sh).length, 0)
        return (
          <label className="no-print" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 8, cursor: 'pointer', color: n ? 'var(--text)' : 'var(--text-hint)' }}>
            <input type="checkbox" checked={!!tpl.offcuts} onChange={e => apply({ ...tpl, offcuts: e.target.checked })} style={{ width: 18, height: 18, flex: '0 0 auto' }} />
            Печатать бирки на деловые остатки{n ? ` · ${n} шт.` : ' (в раскрое деловые остатки не отмечены)'}
          </label>
        )
      })()}
      {mat && tpl.offcuts && (() => {
        const st = tpl.offcut, num = (k, v) => { const x = Number(String(v).replace(',', '.')); if (isFinite(x) && x >= 0) apply({ ...tpl, offcut: { ...st, [k]: x } }) }
        const inp = { width: 64, padding: '5px 6px', fontSize: 13, textAlign: 'center', marginLeft: 4 }
        return (
          <div className="no-print" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--text-muted)', margin: '-2px 0 10px 26px' }}>
            <span>Клеить на остаток:</span>
            <select value={st.corner} onChange={e => apply({ ...tpl, offcut: { ...st, corner: e.target.value } })} style={{ width: 'auto', padding: '5px 8px', fontSize: 13 }}>
              {OFFCUT_CORNERS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
            {st.corner !== 'center' && <>
              <label style={{ margin: 0 }}>отступ по X<input type="text" inputMode="decimal" key={'dx' + st.dx} defaultValue={st.dx} onBlur={e => num('dx', e.target.value)} style={inp} /></label>
              <label style={{ margin: 0 }}>по Y<input type="text" inputMode="decimal" key={'dy' + st.dy} defaultValue={st.dy} onBlur={e => num('dy', e.target.value)} style={inp} /></label>
              <span style={{ fontSize: 11, color: 'var(--text-hint)' }}>мм от сторон остатка — для маркировочного стола</span>
            </>}
            <button type="button" onClick={() => setRemEdit(v => !v)} style={{ padding: '5px 11px', borderRadius: 14, border: '1px solid var(--blue)', background: remEdit ? 'var(--blue)' : 'transparent', color: remEdit ? '#fff' : 'var(--blue)', fontSize: 12.5, cursor: 'pointer' }}>✎ Шаблон бирки остатка</button>
          </div>
        )
      })()}
      {mat && tpl.offcuts && remEdit && (() => {
        const sh = mat.sheets.findIndex(x => sheetOffcuts(x).length), o = sh >= 0 ? sheetOffcuts(mat.sheets[sh])[0] : { w: 600, h: 1200 }
        const sample = { order, mat, si: Math.max(0, sh), o, client: clientName }
        // компьютер: как шаблон бирки детали — во весь экран, бирка слева, параметры справа
        if (desk) return (
          <div className="no-print" style={{ position: 'fixed', inset: 0, zIndex: 900, background: 'var(--bg2)', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 20px', background: 'var(--bg)', borderBottom: '0.5px solid var(--border)' }}>
              <button type="button" onClick={() => setRemEdit(false)} style={{ background: 'none', border: 'none', color: 'var(--blue)', fontSize: 22, padding: 0, lineHeight: 1 }}>←</button>
              <div style={{ flex: 1, fontSize: 16, fontWeight: 500 }}>Бирка делового остатка · {tpl.w}×{tpl.h} мм</div>
              <button type="button" onClick={() => setRemEdit(false)} style={{ padding: '7px 16px', borderRadius: 'var(--radius)', border: 'none', background: 'var(--blue)', color: 'white', fontSize: 13 }}>Готово</button>
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
              <DeskSplit id="label-tpl" def={0.6} full="parent" left={<div ref={setRemPrev} />}
                right={<div style={{ padding: '12px 16px' }}><RemLabelSetup tpl={tpl} onChange={apply} sample={sample} previewEl={remPrev} /></div>} />
            </div>
          </div>
        )
        return <RemLabelSetup tpl={tpl} onChange={apply} sample={sample} />
      })()}
      {mat && (
        <div className="no-print" style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{ flex: 1, fontSize: 11, color: 'var(--text-hint)' }}>Щипок двумя пальцами — крупнее или мельче, как в галерее</span>
          <span style={{ fontSize: 11, color: 'var(--text-hint)' }}>в ряд: {cols}</span>
          {[['−', 1, cols >= MAX_COLS, 'Мельче — больше бирок в ряд'], ['+', -1, cols <= 1, 'Крупнее — меньше бирок в ряд']].map(([t, d, off, title]) => (
            <button key={t} type="button" disabled={off} title={title} onClick={() => setCols(cols + d)}
              style={{ width: 32, height: 30, borderRadius: 8, border: '0.5px solid var(--border-md)', background: 'var(--bg)', color: off ? 'var(--text-hint)' : 'var(--text)', fontSize: 16, padding: 0 }}>{t}</button>
          ))}
        </div>
      )}
      <div ref={setGridEl} style={{ '--lbl-cols': cols, touchAction: 'pan-y', willChange: 'transform' }}>
        {mat && mat.sheets.map((sh, si) => (
          <div key={si} style={{ marginBottom: 14 }}>
            <p className="section-title no-print">{sh.stock === 'offcut' ? 'Остаток' : 'Лист'} {si + 1} · {sh.placed.length} дет.</p>
            <div className="lbl-grid">
              {allLabels.filter(q => q.si === si).map(q => <Label key={q.pi} tpl={tpl} order={order} mat={mat} si={si} pi={q.pi} n={q.n} page={q.page} pages={q.pages} bp={bp} onOpen={() => setView(q.n)} />)}
              {tpl.offcuts && sheetOffcuts(sh).map((o, k) => <OffcutLabel key={'o' + k} tpl={tpl} order={order} mat={mat} si={si} o={o} client={clientName} />)}
            </div>
          </div>
        ))}
      </div>
      {view != null && allLabels[view] && <LabelViewer tpl={tpl} order={order} mat={mat} bp={bp} list={allLabels} index={view} onIndex={setView} onClose={closeView} on3d={async () => { if (scene === undefined && hasModel(details)) { try { setScene((await loadOrderModel(id)) || null) } catch (e) { if (e?.limit) { window.alert(e.message); return } setScene(null) } } navigate(`?lbl=${view}&d3=1`) }} />}
      {view != null && show3d && allLabels[view] && (() => {
        const q = allLabels[view], d = mat.details[mat.sheets[q.si].placed[q.pi].detailIndex] || {}
        let c = d.contour
        if (typeof c === 'string') { try { c = JSON.parse(c) } catch { c = null } }
        c = c || {}
        const wait = <div style={{ position: 'fixed', inset: 0, zIndex: 960, background: 'var(--bg2)' }}><CncLoader label="Строим 3D-модель…" /></div>
        const name = [c.meta?.des, d.name].filter(Boolean).join(' ') || 'Деталь'
        // У заказа есть 3D-модель: деталь показывается в ней — сначала одна, затем «вверх по структуре» (блок, изделие, вся модель)
        if (hasModel(details)) {
          if (scene === undefined) return wait
          return (
            <Suspense fallback={wait}>
              <Model3D key={view} details={details} scene={scene || null} title={name} onClose={closeView} readOnly orderId={null}
                materialThickness={mat.thickness} focus={{ di: details.indexOf(d), des: c.meta?.des || '' }} />
            </Suspense>
          )
        }
        // модели нет — одна деталь, лицевой пластью к зрителю
        const W = Number(d.width) || 0, L = Number(d.length) || 0, T = Number(c.meta?.thickness) || mat.thickness || 16
        const one = [{ name: d.name || 'Деталь', w: L, h: W, edges: { top: d.edge_top || null, right: d.edge_right || null, bottom: d.edge_bottom || null, left: d.edge_left || null },
          contour: { ...c, meta: { des: c.meta?.des || '', material: c.meta?.material || mat.name || '', product: '', thickness: T, texDir: 2, turned: false, flipped: false,
            local: { x0: 0, y0: 0, dx: W, dy: L }, inst: [[1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]], ids: [0], anims: [null] } } }]
        return <Suspense fallback={wait}><Model3D key={view} details={one} title={name} onClose={closeView} readOnly materialThickness={T} /></Suspense>
      })()}
      {saveAsk && <SaveFilesDialog files={saveAsk.files} zipName={saveAsk.zipName} onClose={() => setSaveAsk(null)}
        folders={(rp => [folderName(rp.folderTpl, { total: mat?.sheets?.length || 0, order, material: mat?.name || order?.material_name || '', thickness: mat?.thickness, client: clientName, latin: rp.dirLatin !== false }), (rp.dirLatin !== false ? safeName(mat?.name || order?.material_name) : folderName('{MAT}', { material: mat?.name || order?.material_name || '', latin: false })).slice(0, 40) || 'material'])(routerPost(getCnc(user)))} />}
    </div>
  )
}

// «Настройки производства → Бирки»: тот же шаблон бирки, но без заказа — на образцовой детали,
// чтобы настроить бирку сразу, не проходя заказ до раскроя
export function LabelSettingsPage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [tpl, setTpl] = useState(() => getLabelTpl(user))
  const applyTpl = t => { setTpl(t); saveLabelTpl(t, user) }      // бирка остатка — сохраняется сразу, как на странице бирок
  const sample = useMemo(() => demoLabelSample(), [])
  const desk = useDesktop()
  const [previewEl, setPreviewEl] = useState(null)
  const [which, setWhich] = useState('part')          // какую бирку настраиваем: детали или делового остатка
  const tab = (k, l) => <button key={k} type="button" onClick={() => setWhich(k)} style={{ flex: 1, padding: '6px 8px', borderRadius: 15, border: 'none', fontSize: 13, fontWeight: which === k ? 600 : 400, background: which === k ? 'var(--bg)' : 'transparent', color: which === k ? 'var(--blue)' : 'var(--text-muted)', boxShadow: which === k ? '0 1px 2px rgba(0,0,0,0.12)' : 'none', cursor: 'pointer' }}>{l}</button>
  const body = (<>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, paddingTop: 4 }}>
        <button onClick={() => navigate(-1)} style={{ background: 'none', border: 'none', color: 'var(--blue)', fontSize: 22, padding: 0 }}>←</button>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 500 }}>Шаблоны бирок</div>
          <div style={{ fontSize: 12, color: 'var(--text-hint)' }}>{tpl.w}×{tpl.h} мм · {tpl.enabled ? '✓ настроен' : 'не настроен'}</div>
        </div>
        <button onClick={() => navigate('/production')} style={{ padding: '7px 11px', borderRadius: 20, fontSize: 12, border: '0.5px solid var(--blue)', background: 'transparent', color: 'var(--blue)', whiteSpace: 'nowrap' }}>К заказам</button>
      </div>
      <div style={{ display: 'flex', gap: 4, background: 'var(--bg2)', borderRadius: 18, padding: 3, marginBottom: 10 }}>
        {tab('part', 'Бирка детали')}{tab('rem', 'Бирка делового остатка')}
      </div>
      {which === 'part' ? (
        <div className="card" style={{ marginBottom: 10 }}>
          <p style={{ fontSize: 11.5, color: 'var(--text-hint)', margin: '0 0 4px' }}>Бирка показана на образцовой детали. Шаблон тот же, что в бирках заказа: настроили здесь — он сразу работает во всех заказах.</p>
          <LabelSetup key="part" tpl={tpl} setTpl={setTpl} user={user} order={sample.order} mat={sample.mat} shared={false} previewEl={desk ? previewEl : null} />
        </div>
      ) : (
        <>
          {/* бирка делового остатка — тот же шаблон, что на странице бирок заказа: настраивается и здесь, и там */}
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, margin: '4px 0 8px', cursor: 'pointer' }}>
            <input type="checkbox" checked={!!tpl.offcuts} onChange={e => applyTpl({ ...tpl, offcuts: e.target.checked })} style={{ width: 18, height: 18 }} />
            Печатать бирки на деловые остатки
          </label>
          <RemLabelSetup key="rem" tpl={tpl} onChange={applyTpl} sample={{ order: sample.order, mat: sample.mat, si: 0, o: { w: 612, h: 1250 }, client: 'Иван Петров' }} previewEl={desk ? previewEl : null} />
        </>
      )}
  </>)
  // компьютер: слева — бирка на образцовой детали, справа — размеры и параметры шаблона
  if (desk) return (
    <div className="page desk-page">
      <DeskSplit id="label-tpl" def={0.6} left={<div ref={setPreviewEl} />} right={body} />
    </div>
  )
  return <div className="page" style={{ paddingBottom: 40 }}>{body}</div>
}
