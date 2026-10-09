import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { getUserSettings, saveUserSettings } from '../lib/userSettings'
import { drawPdfPreview, normalizePdfTpl, newPdfItem, PDF_ITEMS, pdfItemTitle, pdfItemKind, pdfItemHasLabel } from '../lib/nestingPdf'

// Конструктор листа PDF карт раскроя — как конструктор бирки: карта листа, список деталей, заголовок и каждая строка
// статистики ставятся на страницу там, где нужно; у карты и у текста — размер и поворот в обе стороны.
// Макет хранится за аккаунтом (pdfTpl) и действует для всех PDF карт из кабинета производства.
const PAGE_W = 210, PAGE_H = 297
const ZOOMS = [1, 1.5, 2, 3]

export default function PdfLayoutEditor({ order, mat, onClose }) {
  const { user } = useAuth()
  const [tpl, setTpl] = useState(() => normalizePdfTpl(getUserSettings(user).pdfTpl))
  const [sel, setSel] = useState(null)
  const [boxes, setBoxes] = useState([])
  const [zoom, setZoom] = useState(1)
  const [baseW, setBaseW] = useState(320)
  const [live, setLive] = useState(null)             // идёт перетаскивание: { id, dx, dy, dw, dh } в мм
  const holderRef = useRef(null), cvRef = useRef(null), drag = useRef(null)
  const scale = baseW * zoom / PAGE_W                // точек экрана на мм

  useEffect(() => {
    const fit = () => { const w = holderRef.current?.clientWidth; if (w) setBaseW(w - 2) }
    fit(); window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])
  useEffect(() => {
    if (!cvRef.current || !mat) return
    const id = requestAnimationFrame(() => { try { setBoxes(drawPdfPreview(cvRef.current, { order, mat, tpl })) } catch { setBoxes([]) } })
    return () => cancelAnimationFrame(id)
  }, [tpl, order, mat])

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
          <div style={{ fontSize: 11, color: 'var(--text-hint)' }}>Страница A4 · показан первый лист</div>
        </div>
        <button type="button" style={chip(false)} disabled={zoom === ZOOMS[0]} onClick={() => setZoom(z => ZOOMS[Math.max(0, ZOOMS.indexOf(z) - 1)])}>−</button>
        <span style={{ fontSize: 12, color: 'var(--text-muted)', minWidth: 28, textAlign: 'center' }}>{zoom}×</span>
        <button type="button" style={chip(false)} disabled={zoom === ZOOMS[ZOOMS.length - 1]} onClick={() => setZoom(z => ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(z) + 1)])}>+</button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 12px' }}>
        <div ref={holderRef} style={{ overflow: 'auto', maxHeight: '58vh', border: '1px solid var(--border-md)', background: '#8a8a86' }}>
          <div onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerDown={() => setSel(null)}
            style={{ position: 'relative', width: PAGE_W * scale, height: PAGE_H * scale, background: '#fff', userSelect: 'none', overflow: 'hidden' }}>
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
        <p style={{ fontSize: 11, color: 'var(--text-hint)', margin: '6px 0 8px' }}>Перетащите элемент на своё место; синяя точка в углу меняет размер. Лист двигается за пустое место.</p>

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
            <button type="button" style={{ ...chip(false), color: 'var(--danger)', borderColor: 'var(--danger)', marginLeft: 'auto' }}
              onClick={() => { change(tpl.items.filter(i => i.id !== sel)); setSel(null) }}>Убрать</button>
          </div>
        )}

        <p style={{ fontSize: 11, color: 'var(--text-hint)', margin: '0 0 8px' }}>Знак RaskroyPro и адрес raskroypro.com всегда стоят в левом верхнем углу страницы — убрать или передвинуть их нельзя.</p>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Добавить на лист</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
          {PDF_ITEMS.filter(([k]) => !used.has(k) || k === 'text' || k === 'line').map(([k, label]) => (
            <button key={k} type="button" style={chip(false)} onClick={() => { const it = newPdfItem(k); change([...tpl.items, it]); setSel(it.id) }}>+ {label}</button>
          ))}
        </div>
        <p style={{ fontSize: 11, color: 'var(--text-hint)' }}>Если список деталей не помещается в свою высоту, он продолжается на следующей странице. Статистика всего раскроя и смета идут отдельной последней страницей.</p>
      </div>

      <div style={{ display: 'flex', gap: 8, padding: '10px 14px calc(10px + env(safe-area-inset-bottom))', background: 'var(--bg)', borderTop: '0.5px solid var(--border)' }}>
        <button type="button" className="btn-secondary" style={{ flex: 1 }} onClick={reset}>Стандартный вид</button>
        <button type="button" className="btn-primary" style={{ flex: 1.4 }} onClick={save}>Сохранить макет</button>
      </div>
    </div>
  )
}
