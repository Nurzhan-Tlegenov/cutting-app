import { useSideWidth } from './DeskSplit'
import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { getUserSettings, saveUserSettings } from '../lib/userSettings'
import PdfPreview from './PdfPreview'
import { userSameAlpha } from '../lib/sameParts'
import { pdfSummaryOf } from '../lib/pdfSummary'
import { nestingStats } from '../lib/nestingStats'
import { drawPdfPreview, renderPdfPages, normalizePdfTpl, newPdfItem, PDF_ITEMS, pdfItemTitle, pdfItemKind, pdfItemHasLabel, demoPdfSample } from '../lib/nestingPdf'
import { useBackClose } from '../lib/backStack'

// Конструктор листа PDF карт раскроя — как конструктор бирки: карта листа, список деталей, заголовок и каждая строка
// статистики ставятся на страницу там, где нужно; у карты и у текста — размер и поворот в обе стороны.
// Макет хранится за аккаунтом (pdfTpl) и действует для всех PDF карт из кабинета производства.
const PAGE_W = 210, PAGE_H = 297
const ZOOMS = [1, 1.5, 2, 3]

// что добавить на лист — по группам, чтобы длинный список не путал
const ADD_GROUPS = [
  ['Карта и оформление', ['map', 'list', 'legend', 'line', 'text']],
  ['Шапка', ['title', 'order', 'sheetNo', 'material', 'date']],
  ['Лист', ['used', 'sheetSize', 'usable', 'kerf', 'partsOnSheet', 'partsArea', 'offcuts', 'edgeSheet', 'edgeTypesSheet']],
  ['Операции на листе', ['sheetCuts', 'sheetCutM', 'sheetPerim', 'sheetHoles', 'sheetEdgeHoles', 'sheetGrooves']],
  ['Всего по материалу', ['totals', 'allArea', 'allCuts', 'allCutM', 'allPerim', 'edgeTotal', 'edgeTypesAll', 'overs', 'allHoles', 'allEdgeHoles', 'allGrooves']],
  ['Примечания', ['orderNote', 'prodNote']],
  ['Низ страницы', ['footer', 'pageNo']],
]

export default function PdfLayoutEditor({ order: order0, mat: mat0, onClose }) {
  useBackClose(true, onClose)
  // из настроек производства заказа нет — показываем образец
  const [demo] = useState(() => (mat0 ? null : demoPdfSample()))
  const order = demo ? demo.order : order0, mat = demo ? demo.mat : mat0
  const { user } = useAuth()
  const [tpl, setTpl] = useState(() => normalizePdfTpl(getUserSettings(user).pdfTpl))
  const [sel, setSel] = useState(null)
  const [boxes, setBoxes] = useState([])
  const [zoom, setZoom] = useState(1)
  const [preview, setPreview] = useState(false)     // предварительный просмотр всего PDF с этим (ещё не сохранённым) макетом
  const [fitK, setFitK] = useState(1.5)             // точек экрана на мм, когда лист целиком помещается в окно превью
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 900)   // монитор: параметры справа
  const [sideW, sideHandle] = useSideWidth('pdf-layout', 380)   // монитор: ширину колонки параметров тянут мышью
  const [live, setLive] = useState(null)             // идёт перетаскивание: { id, dx, dy, dw, dh } в мм
  const holderRef = useRef(null), cvRef = useRef(null), drag = useRef(null)
  const scale = fitK * zoom                          // точек экрана на мм

  // превью всегда целиком в своём окне (по ширине и по высоте); «+» — крупнее, лист прокручивается
  useEffect(() => {
    const el = holderRef.current
    const fit = () => {
      setWide(window.innerWidth >= 900)
      if (!el) return
      const w = el.clientWidth - 16, h = el.clientHeight - 16
      if (w > 0 && h > 0) setFitK(Math.max(0.5, Math.min(w / PAGE_W, h / PAGE_H)))
    }
    fit()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null
    if (ro && el) ro.observe(el)
    window.addEventListener('resize', fit)
    return () => { ro?.disconnect(); window.removeEventListener('resize', fit) }
  }, [])
  useEffect(() => {
    if (!cvRef.current || !mat) return
    const id = requestAnimationFrame(() => { try { setBoxes(drawPdfPreview(cvRef.current, { order, mat, tpl })) } catch { setBoxes([]) } })
    return () => cancelAnimationFrame(id)
  }, [tpl, order, mat])

  // Ctrl + колёсико мыши (и щипок на тачпаде) над листом — крупнее / мельче (по ступеням масштаба)
  useEffect(() => {
    const el = holderRef.current
    if (!el) return
    let t = 0
    const onWheel = e => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const now = Date.now(); if (now - t < 180) return; t = now
      setZoom(z => ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, ZOOMS.indexOf(z) + (e.deltaY < 0 ? 1 : -1)))])
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])
  const change = items => setTpl(normalizePdfTpl({ custom: true, items }))
  const cur = tpl.items.find(i => i.id === sel) || null
  const edit = patch => change(tpl.items.map(i => (i.id === sel ? { ...i, ...patch } : i)))
  const down = (e, box, mode) => {
    e.stopPropagation(); e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    setSel(box.id)
    drag.current = { id: box.id, mode, x: e.clientX, y: e.clientY, kind: box.kind }
  }
  const move = e => {
    const d = drag.current
    if (!d) return
    const dx = (e.clientX - d.x) / scale, dy = (e.clientY - d.y) / scale
    setLive(d.mode === 'move' ? { id: d.id, dx, dy, dw: 0, dh: 0 } : { id: d.id, dx: 0, dy: 0, dw: dx, dh: dy })
  }
  const up = () => {
    const d = drag.current
    drag.current = null
    if (d && live) {
      change(tpl.items.map(i => {
        if (i.id !== d.id) return i
        if (d.mode === 'move') return { ...i, x: i.x + live.dx, y: i.y + live.dy }
        if (d.kind === 'box') return { ...i, w: i.w + live.dw, h: i.h + live.dh }
        if (d.kind === 'tall' || d.kind === 'square') return { ...i, h: i.h + live.dh }
        if (d.kind === 'wide') return { ...i, w: i.w + live.dw }
        if (d.kind === 'text') return { ...i, size: (i.size || 3) + live.dh / 1.15 }
        return i
      }))
    }
    setLive(null)
  }
  const turn = by => edit({ rot: (Number(cur.rot) || 0) + by })
  const used = new Set(tpl.items.map(i => i.type))
  const save = () => { saveUserSettings({ pdfTpl: { custom: true, items: tpl.items } }, user); onClose() }
  const reset = () => {
    if (!window.confirm('Вернуть стандартное оформление листа? Ваш макет будет удалён.')) return
    saveUserSettings({ pdfTpl: null }, user); onClose()
  }
  const chip = on => ({ padding: '6px 11px', borderRadius: 20, fontSize: 12, border: '0.5px solid ' + (on ? 'var(--blue)' : 'var(--border-md)'), background: on ? 'var(--blue-light)' : 'transparent', color: on ? 'var(--blue-dark)' : 'var(--text-muted)' })
  const kind = cur ? pdfItemKind(cur.type) : ''
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 980, background: 'var(--bg2)', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: 'var(--bg)', borderBottom: '0.5px solid var(--border)' }}>
        <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--blue)', fontSize: 22, padding: 0, lineHeight: 1 }}>←</button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 500 }}>Оформление листа PDF</div>
          <div style={{ fontSize: 11, color: 'var(--text-hint)' }}>Страница A4 · {demo ? 'на образце' : 'показан первый лист'}</div>
        </div>
        <button type="button" style={chip(false)} disabled={zoom === ZOOMS[0]} onClick={() => setZoom(z => ZOOMS[Math.max(0, ZOOMS.indexOf(z) - 1)])}>−</button>
        <span style={{ fontSize: 12, color: 'var(--text-muted)', minWidth: 28, textAlign: 'center' }}>{zoom}×</span>
        <button type="button" style={chip(false)} disabled={zoom === ZOOMS[ZOOMS.length - 1]} onClick={() => setZoom(z => ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(z) + 1)])}>+</button>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: wide ? 'row' : 'column' }}>
        {/* превью листа: на телефоне — сверху, на мониторе — слева; лист целиком в окне */}
        <div ref={holderRef} style={{ flex: wide ? 1 : '1 1 55%', minHeight: 0, minWidth: 0, overflow: 'auto', background: '#8a8a86', padding: 8, display: 'flex' }}>
          <div onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerDown={() => setSel(null)}
            style={{ position: 'relative', width: PAGE_W * scale, height: PAGE_H * scale, flex: 'none', margin: 'auto', background: '#fff', userSelect: 'none', overflow: 'hidden', boxShadow: '0 2px 10px rgba(0,0,0,0.25)' }}>
            <canvas ref={cvRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
            {boxes.map(b => {
              const on = b.id === sel, l = live && live.id === b.id ? live : null
              const grow = l && (l.dw || l.dh)
              const w = (b.w + (l && (b.kind === 'box' || b.kind === 'wide') ? l.dw : 0)) * scale
              const h = (b.h + (l && b.kind !== 'wide' && b.kind !== 'fixed' ? l.dh : 0)) * scale
              return (
                <div key={b.id} onPointerDown={e => down(e, b, 'move')}
                  style={{ position: 'absolute', left: (b.x + (l ? l.dx : 0)) * scale, top: (b.y + (l ? l.dy : 0)) * scale, width: Math.max(8, w), height: Math.max(8, h),
                    transformOrigin: '0 0', transform: b.rot ? `rotate(${b.rot}deg)` : 'none', boxSizing: 'border-box', cursor: 'move', touchAction: 'none',
                    border: on ? '1.5px solid #185FA5' : '1px dashed rgba(24,95,165,0.4)', background: on ? (grow || l ? 'rgba(24,95,165,0.18)' : 'rgba(24,95,165,0.08)') : 'transparent' }}>
                  {on && b.kind !== 'fixed' && <div onPointerDown={e => down(e, b, 'size')}
                    style={{ position: 'absolute', right: -10, bottom: -10, width: 22, height: 22, borderRadius: 11, background: '#185FA5', border: '2px solid #fff', cursor: 'nwse-resize', touchAction: 'none' }} />}
                </div>
              )
            })}
          </div>
        </div>
        {/* параметры: на телефоне — снизу своей прокруткой, на мониторе — колонкой справа */}
        {wide && sideHandle}
        <div style={{ flex: wide ? `0 0 ${sideW}px` : '1 1 45%', minHeight: 0, overflowY: 'auto', padding: '10px 12px', background: 'var(--bg2)',
          borderLeft: 'none', borderTop: wide ? 'none' : '0.5px solid var(--border)' }}>
        <p style={{ fontSize: 11, color: 'var(--text-hint)', margin: '0 0 8px' }}>{cur ? 'Перетащите элемент на своё место; синяя точка в углу меняет размер.' : 'Нажмите на элемент листа, чтобы настроить его, или добавьте новый ниже.'}</p>

        {cur && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10, padding: '8px 10px', background: 'var(--bg)', borderRadius: 'var(--radius)', border: '0.5px solid var(--border)' }}>
            <div style={{ flex: '1 1 100%', fontSize: 13, fontWeight: 500 }}>{pdfItemTitle(cur.type)}</div>
            {kind === 'text' && (
              <>
                <button type="button" style={chip(false)} onClick={() => edit({ size: cur.size - 0.3 })}>A−</button>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{cur.size.toFixed(1)} мм</span>
                <button type="button" style={chip(false)} onClick={() => edit({ size: cur.size + 0.3 })}>A+</button>
                <button type="button" style={{ ...chip(cur.bold), fontWeight: 700 }} onClick={() => edit({ bold: !cur.bold })}>Ж</button>
                <button type="button" style={chip(cur.muted)} onClick={() => edit({ muted: !cur.muted })}>Серым</button>
                {pdfItemHasLabel(cur.type) && <button type="button" style={chip(cur.label !== false)} onClick={() => edit({ label: cur.label === false ? true : false })}>{cur.label !== false ? '✓ ' : ''}С подписью</button>}
              </>
            )}
            {(kind === 'text' || cur.type === 'map') && (
              <>
                <button type="button" style={chip(false)} title="Повернуть против часовой стрелки" onClick={() => turn(-90)}>↺ −90°</button>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{cur.rot || 0}°</span>
                <button type="button" style={chip(false)} title="Повернуть по часовой стрелке" onClick={() => turn(90)}>↻ +90°</button>
              </>
            )}
            {cur.type === 'text' && (
              <input type="text" key={cur.id} defaultValue={cur.text} placeholder="Ваш текст: телефон, адрес, примечание…" maxLength={200}
                onBlur={e => { if (e.target.value !== cur.text) edit({ text: e.target.value }) }} style={{ flex: '1 1 100%', padding: '7px 9px', fontSize: 13 }} />
            )}
            {cur.type === 'map' && <button type="button" style={chip(false)} onClick={() => edit({ x: 10, w: 190 })}>На всю ширину</button>}
            {cur.type === 'map' && (
              <>
                <div style={{ flex: '1 1 100%', display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 11.5, color: 'var(--text-muted)', minWidth: 70 }}>Размеры:</span>
                  {[['sides', 'По сторонам'], ['line', 'Строкой Д×Ш'], ['none', 'Без размеров']].map(([k, l]) => (
                    <button key={k} type="button" style={chip((cur.dims || 'sides') === k)} onClick={() => edit({ dims: k === 'sides' ? undefined : k })}>{l}</button>
                  ))}
                </div>
                <div style={{ flex: '1 1 100%', display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 11.5, color: 'var(--text-muted)', minWidth: 70 }}>Шрифт на карте:</span>
                  <button type="button" style={chip(false)} onClick={() => edit({ dimK: Math.max(0.5, Math.round(((cur.dimK || 1) - 0.1) * 10) / 10) })}>A−</button>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', minWidth: 38, textAlign: 'center' }}>{Math.round((cur.dimK || 1) * 100)}%</span>
                  <button type="button" style={chip(false)} onClick={() => edit({ dimK: Math.min(2.5, Math.round(((cur.dimK || 1) + 0.1) * 10) / 10) })}>A+</button>
                  <button type="button" style={chip(cur.num !== false)} onClick={() => edit({ num: cur.num === false ? undefined : false })}>{cur.num !== false ? '✓ ' : ''}Номер позиции</button>
                </div>
              </>
            )}
            <button type="button" style={{ ...chip(false), color: 'var(--danger)', borderColor: 'var(--danger)', marginLeft: 'auto' }}
              onClick={() => { change(tpl.items.filter(i => i.id !== sel)); setSel(null) }}>Убрать</button>
          </div>
        )}

        <p style={{ fontSize: 11, color: 'var(--text-hint)', margin: '0 0 8px' }}>Знак RaskroyPro и адрес raskroypro.com всегда стоят в левом верхнем углу страницы — убрать или передвинуть их нельзя.</p>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Добавить на лист</div>
        {ADD_GROUPS.map(([title, keys]) => {
          const list = keys.filter(k => PDF_ITEMS.some(x => x[0] === k) && (!used.has(k) || k === 'text' || k === 'line'))
          if (!list.length) return null
          return (
            <div key={title} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 3 }}>{title}</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {list.map(k => (
                  <button key={k} type="button" style={chip(false)} onClick={() => { const it = newPdfItem(k); change([...tpl.items, it]); setSel(it.id) }}>+ {pdfItemTitle(k)}</button>
                ))}
              </div>
            </div>
          )
        })}
        <p style={{ fontSize: 11, color: 'var(--text-hint)' }}>Если список деталей не помещается в свою высоту, он продолжается на следующей странице. Статистика всего раскроя и смета идут отдельной последней страницей.</p>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, padding: '10px 14px calc(10px + env(safe-area-inset-bottom))', background: 'var(--bg)', borderTop: '0.5px solid var(--border)' }}>
        <button type="button" className="btn-secondary" style={{ flex: 1 }} onClick={reset}>Стандартный вид</button>
        <button type="button" className="btn-secondary" style={{ flex: 1.2, color: 'var(--blue)', borderColor: 'var(--blue)' }} onClick={() => setPreview(true)}>👁 Просмотр PDF</button>
        <button type="button" className="btn-primary" style={{ flex: 1.4 }} onClick={save}>Сохранить макет</button>
      </div>
      {preview && <PdfPreview title={demo ? 'Просмотр PDF · на образце' : 'Просмотр PDF'} onClose={() => setPreview(false)}
        make={prog => {
          let summary = null
          try { summary = pdfSummaryOf(nestingStats({ order, mat, method: order?.cutting_method || 'nesting' }), null, getUserSettings(user).pdfSummary || {}) } catch { /* без статистики */ }
          return renderPdfPages({ order, mat, summary, tpl: { custom: true, items: tpl.items }, same: userSameAlpha(user),
            statsPage: !!getUserSettings(user).pdfStatsPage, onProgress: (a, b) => prog(`${a}/${b}`) })
        }} />}
    </div>
  )
}
