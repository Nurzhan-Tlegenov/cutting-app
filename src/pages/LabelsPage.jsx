import { cutDetails, parseEdgeTypes } from '../lib/edgeCut'
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
import { sheetOffcuts, drawOffcutLabel, OFFCUT_CORNERS, QR_PARTS, labelQr, LABEL_ITEMS, itemKind, itemTitle, isBox, isVert, itemBox, metaItems, preloadLabelImages, imageToLabel, newLabelItem, DEFAULT_LABEL, resizeLabel, getLabelTpl, saveLabelTpl, normalizeLabel, labelInfo, drawLabel, labelPx, labelOrder, buildLabelFiles, buildLabelsPdf } from '../lib/labelMaker'
import { getCnc, activePost } from '../lib/cncSettings'
import CncLoader from '../components/CncLoader'
import { orderTitle, orderFileName, toLatin, programName } from '../lib/orderUtils'
import SaveFilesDialog from '../components/SaveFilesDialog'

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

function Label({ tpl, order, mat, si, pi, n, onOpen }) {
  const ref = useRef(null)
  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const { w, h } = labelPx(tpl, true)
    cv.width = w; cv.height = h
    const sheet = mat.sheets[si]
    const draw = () => drawLabel(cv, tpl, labelInfo(order, mat, si, pi), { sheet, geo: sheetGeo(order, mat.result, sheet), index: pi, detail: mat.details[sheet.placed[pi].detailIndex] })
    draw(); if (tpl.items.some(i => i.img)) preloadLabelImages(tpl).then(draw)
  }, [tpl, order, mat, si, pi])
  return <canvas ref={ref} data-lbl={n} onClick={onOpen} style={{ cursor: 'zoom-in' }} />
}

// Бирка на деловой обрезок листа: заказ, материал, размер
function OffcutLabel({ tpl, order, mat, si, o }) {
  const ref = useRef(null)
  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const { w, h } = labelPx(tpl, true)
    cv.width = w; cv.height = h
    drawOffcutLabel(cv, tpl, { order, mat, si, o })
  }, [tpl, order, mat, si, o.w, o.h])
  return <canvas ref={ref} />
}

// Просмотр бирки во весь экран — как фотография в галерее: щипок увеличивает, палец двигает, двойное касание —
// крупнее / целиком, смахивание в стороны — соседняя бирка. Бирка перерисована крупно, поэтому при увеличении чёткая.
function LabelViewer({ tpl, order, mat, list, index, onIndex, onClose, on3d }) {
  const cvRef = useRef(null), boxRef = useRef(null)
  const v = useRef({ s: 1, x: 0, y: 0 })                 // масштаб и сдвиг
  const g = useRef({ pts: new Map(), start: null, tap: 0, moved: false })
  const { si, pi } = list[index]
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
    const sheet = mat.sheets[si]
    const draw = () => drawLabel(cv, tpl, labelInfo(order, mat, si, pi), { sheet, geo: sheetGeo(order, mat.result, sheet), index: pi, detail: mat.details[sheet.placed[pi].detailIndex] })
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
function LabelEditor({ tpl, onChange, order, mat, shared }) {
  const wrapRef = useRef(null), cvRef = useRef(null), drag = useRef(null)
  const [live, setLive] = useState(null)            // шаблон во время перетаскивания
  const [sel, setSel] = useState(null)
  const [scale, setScale] = useState(4)             // точек экрана на мм
  const t = live || tpl
  useEffect(() => {
    const fit = () => { const w = wrapRef.current?.clientWidth; if (w) setScale(w / tpl.w) }
    fit(); window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [tpl.w])
  useEffect(() => {
    const cv = cvRef.current
    if (!cv || !mat) return
    const { w, h } = labelPx(t, true)
    cv.width = w; cv.height = h
    const sheet = mat.sheets[0]
    const draw = () => drawLabel(cv, t, labelInfo(order, mat, 0, 0), { sheet, geo: sheetGeo(order, mat.result, sheet), index: 0, detail: mat.details[sheet.placed[0].detailIndex] })
    draw(); if (t.items.some(i => i.img)) preloadLabelImages(t).then(draw)
  }, [t, order, mat])
  const fileRef = useRef(null)
  const [imgErr, setImgErr] = useState('')
  const setImage = async src => {
    setImgErr('')
    try { const img = await imageToLabel(src); edit({ img, h: cur?.h || 9, w: cur?.img ? cur.w : 9 }) }
    catch (e) { setImgErr(typeof src === 'string' ? 'С этого адреса картинку взять не получилось (сайт не разрешает). Сохраните её на телефон и выберите файлом.' : String(e?.message || e)) }
  }
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
    const patch = d.mode === 'move' ? { x: o.x + dx, y: o.y + dy }
      : pic ? { w: Math.max(4, o.w + dx), h: Math.max(4, o.h + dy) }
        : isVert(o) ? { w: Math.max(4, o.w + dy), size: Math.max(1.2, o.size + dx / 1.25) } : { w: Math.max(4, o.w + dx), size: Math.max(1.2, o.size + dy / 1.25) }
    setLive(normalizeLabel({ ...tpl, items: tpl.items.map(i => (i.id === d.id ? { ...i, ...patch } : i)) }))
  }
  const up = () => { if (drag.current && live) onChange(live); drag.current = null; setLive(null) }
  const cur = t.items.find(i => i.id === sel) || null
  const edit = patch => onChange({ ...tpl, items: tpl.items.map(i => (i.id === sel ? { ...i, ...patch } : i)) })
  const chip = on => ({ padding: '6px 11px', borderRadius: 20, fontSize: 12, border: '0.5px solid ' + (on ? 'var(--blue)' : 'var(--border-md)'), background: on ? 'var(--blue-light)' : 'transparent', color: on ? 'var(--blue-dark)' : 'var(--text-muted)', whiteSpace: 'nowrap' })
  const used = new Set(t.items.map(i => i.type))
  return (
    <div>
      <div ref={wrapRef} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerDown={() => setSel(null)}
        style={{ position: 'relative', width: '100%', aspectRatio: `${t.w} / ${t.h}`, border: '1px solid #2C2C2A', borderRadius: 3, background: '#fff', touchAction: 'none', userSelect: 'none', overflow: 'hidden' }}>
        <canvas ref={cvRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
        {t.items.map(it => {
          const on = it.id === sel
          return (
            <div key={it.id} onPointerDown={e => down(e, it, 'move')}
              style={{ position: 'absolute', left: it.x * scale, top: it.y * scale, width: itemBox(it)[0] * scale, height: itemBox(it)[1] * scale, boxSizing: 'border-box', cursor: 'move',
                border: on ? '1.5px solid #185FA5' : '1px dashed rgba(24,95,165,0.45)', background: on ? 'rgba(24,95,165,0.08)' : 'transparent' }}>
              {on && <div onPointerDown={e => down(e, it, 'size')}
                style={{ position: 'absolute', right: -9, bottom: -9, width: 20, height: 20, borderRadius: 10, background: '#185FA5', border: '2px solid #fff', cursor: 'nwse-resize' }} />}
            </div>
          )
        })}
      </div>
      <p style={{ fontSize: 11, color: 'var(--text-hint)', margin: '6px 0 8px' }}>Перетащите элемент на своё место; у выбранного — синяя точка в углу меняет размер.</p>
      {cur && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10, padding: '8px 10px', background: 'var(--bg2)', borderRadius: 'var(--radius)' }}>
          <div style={{ flex: '1 1 100%', fontSize: 13, fontWeight: 500 }}>{itemTitle(cur.type)}</div>
          {!isBox(cur) && (
            <>
              <button type="button" style={chip(false)} onClick={() => edit({ size: cur.size - 0.3 })}>A−</button>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{cur.size.toFixed(1)} мм</span>
              <button type="button" style={chip(false)} onClick={() => edit({ size: cur.size + 0.3 })}>A+</button>
              <button type="button" style={{ ...chip(cur.bold), fontWeight: 700 }} onClick={() => edit({ bold: !cur.bold })}>Ж</button>
              <button type="button" style={chip(cur.align !== 'left')} onClick={() => edit({ align: cur.align === 'left' ? 'center' : cur.align === 'center' ? 'right' : 'left' })}>{cur.align === 'right' ? 'По правому краю' : cur.align === 'center' ? 'По центру' : 'По левому краю'}</button>
              <button type="button" style={chip(cur.ul !== 'none')} onClick={() => edit({ ul: cur.ul === 'none' ? 'below' : cur.ul === 'below' ? 'above' : 'none' })}>{cur.ul === 'below' ? 'Черта снизу' : cur.ul === 'above' ? 'Черта сверху' : 'Без черты'}</button>
            </>
          )}
          {cur.type === 'order' && !cur.img && (
            <div style={{ flex: '1 1 100%', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>Подпись
                <input type="text" key={'op' + tpl.order.prefix} defaultValue={tpl.order.prefix} placeholder="без подписи" onBlur={e => { if (e.target.value !== tpl.order.prefix) onChange({ ...tpl, order: { ...tpl.order, prefix: e.target.value.trim() } }) }} style={{ width: 120, marginLeft: 6, padding: '6px 8px' }} /></label>
            </div>
          )}
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
              {cur.img && cur.type !== 'image' && <button type="button" style={chip(false)} onClick={() => edit({ img: undefined })}>Вернуть текст</button>}
              <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) setImage(f) }} />
            </>
          )}
          {imgErr && <div style={{ flex: '1 1 100%', fontSize: 11, color: 'var(--danger)' }}>{imgErr}</div>}
          {cur.img && cur.type !== 'image' && <div style={{ flex: '1 1 100%', fontSize: 11, color: 'var(--text-hint)' }}>Картинка печатается только на бирках тех деталей, у которых этот параметр есть.</div>}
          <button type="button" style={{ ...chip(false), color: 'var(--danger)', borderColor: 'var(--danger)', marginLeft: 'auto' }}
            onClick={() => { onChange({ ...tpl, items: tpl.items.filter(i => i.id !== sel) }); setSel(null) }}>Убрать</button>
        </div>
      )}
      {used.has('qr') && (
        <div style={{ marginBottom: 10, padding: '8px 10px', border: '0.5px solid var(--border-md)', borderRadius: 'var(--radius)' }}>
          <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 6 }}>Что зашито в QR-код</div>
          {tpl.qr.parts.includes('link') && (
            <p style={{ fontSize: 11, margin: '0 0 6px', color: shared ? 'var(--teal)' : 'var(--amber)' }}>
              {shared ? '✓ У заказа открыта ссылка на 3D-модель: по QR-коду откроется эта деталь, дальше — вверх по структуре (блок, изделие, вся модель). В коде только ссылка, остальные части не добавляются.'
                : 'Ссылка на 3D-модель у этого заказа не открыта — в код пойдут обычные части ниже. Откройте ссылку в заказе: «3D-модель» → «Ссылка».'}
            </p>
          )}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {QR_PARTS.map(([k, label]) => {
              const on = tpl.qr.parts.includes(k)
              return <button key={k} type="button" style={chip(on)} onClick={() => onChange({ ...tpl, qr: { ...tpl.qr, parts: on ? tpl.qr.parts.filter(x => x !== k) : [...tpl.qr.parts, k] } })}>{on ? '✓ ' : ''}{label}</button>
            })}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            {tpl.qr.parts.includes('text') && (
              <label style={{ flex: 1, fontSize: 12, color: 'var(--text-muted)' }}>Свой текст
                <input type="text" key={'t' + tpl.qr.text} defaultValue={tpl.qr.text} onBlur={e => { if (e.target.value !== tpl.qr.text) onChange({ ...tpl, qr: { ...tpl.qr, text: e.target.value } }) }} style={{ marginTop: 3, padding: '7px 9px' }} /></label>
            )}
            <label style={{ flex: '0 0 96px', fontSize: 12, color: 'var(--text-muted)' }}>Разделитель
              <input type="text" key={'s' + tpl.qr.sep} defaultValue={tpl.qr.sep} maxLength={3} onBlur={e => { if (e.target.value !== tpl.qr.sep) onChange({ ...tpl, qr: { ...tpl.qr, sep: e.target.value } }) }} style={{ marginTop: 3, padding: '7px 9px', textAlign: 'center' }} /></label>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, cursor: 'pointer', marginTop: 8 }}>
            <input type="checkbox" checked={!!tpl.qr.latin} onChange={e => onChange({ ...tpl, qr: { ...tpl.qr, latin: e.target.checked } })} style={{ width: 17, height: 17 }} />
            Перевести в латиницу
          </label>
          <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 4 }}>Пробелы в коде всегда заменяются прочерком «_».</div>
          <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 6, wordBreak: 'break-all' }}>
            Сейчас в коде: <span style={{ fontFamily: 'monospace', color: 'var(--text)' }}>{mat ? labelQr(tpl, labelInfo(order, mat, 0, 0)) || '— пусто —' : '—'}</span>
          </div>
        </div>
      )}
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Добавить на бирку</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        {[...LABEL_ITEMS, ...metaItems(mat?.details)].filter(([k]) => !used.has(k) || k === 'image').map(([k, label]) => (
          <button key={k} type="button" style={chip(false)} onClick={() => { const it = newLabelItem(k, tpl); onChange({ ...tpl, items: [...tpl.items, it] }); setSel(it.id) }}>+ {label}</button>
        ))}
      </div>
    </div>
  )
}

export default function LabelsPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const [order, setOrder] = useState(null)
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
  const [hist, setHist] = useState([])               // прежние состояния шаблона — для «Отменить»
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
  if (loading) return <div className="page"><CncLoader label="Готовим бирки…" /></div>
  if (!order) return <div className="page"><p>Заказ не найден</p></div>
  const total = mat ? mat.sheets.reduce((a, s) => a + s.placed.length, 0) : 0
  const allLabels = mat ? mat.sheets.flatMap((sh, si) => labelOrder(sh, sheetGeo(order, mat.result, sh), 'manual').map(pi => ({ si, pi }))).map((q, n) => ({ ...q, n })) : []
  const apply = t => { setHist(h => [...h.slice(-39), tpl]); setTpl(t); saveLabelTpl(t, user) }
  const change = patch => apply(normalizeLabel({ ...tpl, ...patch, enabled: true }))
  const undo = () => { const prev = hist[hist.length - 1]; if (!prev) return; setHist(h => h.slice(0, -1)); setTpl(prev); saveLabelTpl(prev, user) }
  const size = (k, v) => { const x = Number(String(v).replace(',', '.')); if (isFinite(x) && x > 0) { apply({ ...resizeLabel(tpl, k === 'w' ? x : tpl.w, k === 'h' ? x : tpl.h), enabled: true }) } }
  // файлы маркировочного стола — тем же набором, что делает ЧПУ вместе с G-кодом
  // все бирки одним PDF: бирка — страница, страница размером с бирку
  const savePdf = async () => {
    setPdf('Готовим PDF…')
    try {
      const data = await buildLabelsPdf({ order, mat, tpl, onProgress: (a, b) => setPdf(`PDF: ${a} из ${b}`) })
      const url = URL.createObjectURL(new Blob([data], { type: 'application/pdf' }))
      const a = document.createElement('a'); a.href = url; a.download = `Birki_${orderFileName(order)}${mats.length > 1 ? '_' + safeName(mat.name).slice(0, 24) : ''}.pdf`
      document.body.appendChild(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 5000)
    } finally { setPdf('') }
  }
  const exportFiles = async () => {
    setBusy(true)
    try {
      const post = activePost(getCnc(user)), base = programName(post.nameTpl, { n: null, total: mat.sheets.length, order, material: mat.name || order.material_name || '', thickness: mat.thickness })   // как у программ ЧПУ
      const files = await buildLabelFiles({ order, mat, base, post, tpl, sheets: mat.sheets.map((_, si) => ({ si, nc: `${programName(post.nameTpl, { n: si + 1, total: mat.sheets.length, order, material: mat.name || order.material_name || '', thickness: mat.thickness })}.${post.ext || 'nc'}` })) })
      setSaveAsk({ files, zipName: `Birki_${base}.zip` })
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
        </div>
        {mat && <button onClick={savePdf} disabled={!!pdf} style={{ ...pill, background: 'var(--teal)' }}>{pdf || '⬇ PDF'}</button>}
        {mat && <button onClick={() => window.print()} style={pill}>🖨 Печать</button>}
      </div>

      <div className="card no-print" style={{ marginBottom: 10, padding: 0, overflow: 'hidden' }}>
        <div onClick={() => setSetup(v => !v)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', cursor: 'pointer' }}>
          <span style={{ fontSize: 12, color: 'var(--text-hint)', width: 12 }}>{setup ? '▼' : '▶'}</span>
          <div style={{ flex: 1, fontSize: 14, fontWeight: 500 }}>Шаблон бирки</div>
          <span style={{ fontSize: 11, color: tpl.enabled ? 'var(--teal)' : 'var(--text-hint)' }}>{tpl.enabled ? '✓ настроен' : 'не настроен'}</span>
        </div>
        {setup && (
          <div style={{ padding: '4px 12px 12px', borderTop: '0.5px solid var(--border)' }}>
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
            {mat ? <LabelEditor tpl={tpl} onChange={change} order={order} mat={mat} shared={shared} />
              : <p style={{ fontSize: 12, color: 'var(--text-hint)' }}>Расставить элементы можно в заказе с сохранённым раскроем — бирка показывается на настоящей детали.</p>}
            {[['rot', 'Лист на бирке — горизонтально (длина листа слева направо); деталь и кромка повёрнуты так же']].map(([k, label]) => (
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
            Печатать бирки на обрезки{n ? ` · ${n} шт.` : ' (в раскрое обрезки не отмечены)'}
          </label>
        )
      })()}
      {mat && tpl.offcuts && (() => {
        const st = tpl.offcut, num = (k, v) => { const x = Number(String(v).replace(',', '.')); if (isFinite(x) && x >= 0) apply({ ...tpl, offcut: { ...st, [k]: x } }) }
        const inp = { width: 64, padding: '5px 6px', fontSize: 13, textAlign: 'center', marginLeft: 4 }
        return (
          <div className="no-print" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--text-muted)', margin: '-2px 0 10px 26px' }}>
            <span>Клеить на обрезок:</span>
            <select value={st.corner} onChange={e => apply({ ...tpl, offcut: { ...st, corner: e.target.value } })} style={{ width: 'auto', padding: '5px 8px', fontSize: 13 }}>
              {OFFCUT_CORNERS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
            {st.corner !== 'center' && <>
              <label style={{ margin: 0 }}>отступ по X<input type="text" inputMode="decimal" key={'dx' + st.dx} defaultValue={st.dx} onBlur={e => num('dx', e.target.value)} style={inp} /></label>
              <label style={{ margin: 0 }}>по Y<input type="text" inputMode="decimal" key={'dy' + st.dy} defaultValue={st.dy} onBlur={e => num('dy', e.target.value)} style={inp} /></label>
              <span style={{ fontSize: 11, color: 'var(--text-hint)' }}>мм от сторон обрезка — для маркировочного стола</span>
            </>}
          </div>
        )
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
            <p className="section-title no-print">{sh.stock === 'offcut' ? 'Обрезок' : 'Лист'} {si + 1} · {sh.placed.length} дет.</p>
            <div className="lbl-grid">
              {allLabels.filter(q => q.si === si).map(q => <Label key={q.pi} tpl={tpl} order={order} mat={mat} si={si} pi={q.pi} n={q.n} onOpen={() => setView(q.n)} />)}
              {tpl.offcuts && sheetOffcuts(sh).map((o, k) => <OffcutLabel key={'o' + k} tpl={tpl} order={order} mat={mat} si={si} o={o} />)}
            </div>
          </div>
        ))}
      </div>
      {view != null && allLabels[view] && <LabelViewer tpl={tpl} order={order} mat={mat} list={allLabels} index={view} onIndex={setView} onClose={closeView} on3d={() => { if (scene === undefined && hasModel(details)) loadOrderModel(id).then(sc => setScene(sc || null)).catch(() => setScene(null)); navigate(`?lbl=${view}&d3=1`) }} />}
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
        folders={[orderFileName(order), safeName(mat?.name || order?.material_name).slice(0, 40) || 'material']} />}
    </div>
  )
}
