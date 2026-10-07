import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { savedNestings, sheetGeo } from '../lib/savedNesting'
import { QR_PARTS, labelQr, LABEL_ITEMS, itemKind, itemTitle, isBox, isVert, itemBox, metaItems, preloadLabelImages, imageToLabel, newLabelItem, DEFAULT_LABEL, resizeLabel, getLabelTpl, saveLabelTpl, normalizeLabel, labelInfo, drawLabel, labelPx, buildLabelFiles, buildLabelsPdf } from '../lib/labelMaker'
import { getCnc, activePost } from '../lib/cncSettings'
import CncLoader from '../components/CncLoader'
import SaveFilesDialog from '../components/SaveFilesDialog'

// Бирки деталей по принятому раскрою. Бирку собирает пользователь: размер и какие параметры детали на ней есть.
// На бирке — карта раскроя, где эта деталь закрашена чёрным. Шаблон идёт за аккаунтом; с ним же ЧПУ делает
// файлы для стола бирковки.
const CSS = `
.lbl-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.lbl-grid canvas { width: 100%; height: auto; border: 1px solid #2C2C2A; border-radius: 3px; background: #fff; display: block; }
@media print {
  .no-print, .bottom-nav { display: none !important; }
  body { background: #fff; }
  .page { max-width: none; padding: 0; }
  .lbl-grid { display: block; }
  .lbl-grid canvas { width: var(--lbl-w); height: var(--lbl-h); border: none; border-radius: 0; break-after: page; }
}`
const safeName = s => String(s || '').replace(/[^\wа-яё.-]+/gi, '_').replace(/^_+|_+$/g, '')

function Label({ tpl, order, mat, si, pi }) {
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
  return <canvas ref={ref} />
}

// Конструктор бирки: элементы перетаскиваются по бирке пальцем, за уголок — меняется размер.
// Показана бирка первой детали первого листа — на настоящих данных заказа.
function LabelEditor({ tpl, onChange, order, mat }) {
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
              <button type="button" style={chip(tpl.order.number)} onClick={() => onChange({ ...tpl, order: { ...tpl.order, number: !tpl.order.number } })}>{tpl.order.number ? '✓ ' : ''}Номер от приложения</button>
              <button type="button" style={chip(tpl.order.name)} onClick={() => onChange({ ...tpl, order: { ...tpl.order, name: !tpl.order.name } })}>{tpl.order.name ? '✓ ' : ''}Название заказа</button>
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
  const [pdf, setPdf] = useState('')                 // ход сборки PDF
  const [saveAsk, setSaveAsk] = useState(null)       // файлы стола бирковки: вопрос «по отдельности или архивом»
  const [hist, setHist] = useState([])               // прежние состояния шаблона — для «Отменить»
  useEffect(() => {
    let alive = true
    ;(async () => {
      const { data: o } = await supabase.from('orders').select('*').eq('id', id).single()
      const { data: d } = await supabase.from('order_details').select('*').eq('order_id', id).order('sort_order')
      if (alive) { setOrder(o || null); setDetails(d || []); setLoading(false) }
    })()
    return () => { alive = false }
  }, [id])
  const mats = useMemo(() => savedNestings(order, details), [order, details])
  const mat = mats.find(m => m.key === matKey) || mats[0] || null
  if (loading) return <div className="page"><CncLoader label="Готовим бирки…" /></div>
  if (!order) return <div className="page"><p>Заказ не найден</p></div>
  const total = mat ? mat.sheets.reduce((a, s) => a + s.placed.length, 0) : 0
  const apply = t => { setHist(h => [...h.slice(-39), tpl]); setTpl(t); saveLabelTpl(t, user) }
  const change = patch => apply(normalizeLabel({ ...tpl, ...patch, enabled: true }))
  const undo = () => { const prev = hist[hist.length - 1]; if (!prev) return; setHist(h => h.slice(0, -1)); setTpl(prev); saveLabelTpl(prev, user) }
  const size = (k, v) => { const x = Number(String(v).replace(',', '.')); if (isFinite(x) && x > 0) { apply({ ...resizeLabel(tpl, k === 'w' ? x : tpl.w, k === 'h' ? x : tpl.h), enabled: true }) } }
  // файлы стола бирковки — тем же набором, что делает ЧПУ вместе с G-кодом
  // все бирки одним PDF: бирка — страница, страница размером с бирку
  const savePdf = async () => {
    setPdf('Готовим PDF…')
    try {
      const data = await buildLabelsPdf({ order, mat, tpl, onProgress: (a, b) => setPdf(`PDF: ${a} из ${b}`) })
      const url = URL.createObjectURL(new Blob([data], { type: 'application/pdf' }))
      const a = document.createElement('a'); a.href = url; a.download = `Birki_${safeName(order.order_number)}${mats.length > 1 ? '_' + safeName(mat.name).slice(0, 24) : ''}.pdf`
      document.body.appendChild(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 5000)
    } finally { setPdf('') }
  }
  const exportFiles = async () => {
    setBusy(true)
    try {
      const post = activePost(getCnc(user)), base = `${safeName(order.order_number)}${mats.length > 1 ? '_' + safeName(mat.name).slice(0, 24) : ''}`
      const files = await buildLabelFiles({ order, mat, base, post, tpl, sheets: mat.sheets.map((_, si) => ({ si, nc: `${si + 1}_${base}.${post.ext || 'nc'}` })) })
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
          <div style={{ fontSize: 12, color: 'var(--text-hint)' }}><span style={{ fontFamily: 'monospace' }}>{order.order_number}</span> · {total} шт. · {tpl.w}×{tpl.h} мм</div>
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
            {mat ? <LabelEditor tpl={tpl} onChange={change} order={order} mat={mat} />
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
              Шаблон сохраняется в аккаунте. Когда он настроен, в разделе ЧПУ при создании G-кода появляется галочка «Программа для стола бирковки».
            </p>
            {mat && <button type="button" className="btn-secondary" style={{ marginTop: 10 }} disabled={busy} onClick={exportFiles}>{busy ? 'Собираем файлы…' : '⬇ Файлы для стола бирковки'}</button>}
          </div>
        )}
      </div>

      {!mat && <div className="card no-print"><p style={{ fontSize: 13, color: 'var(--text-muted)' }}>У заказа нет сохранённого раскроя — бирки строятся по листам раскроя.</p></div>}
      {mats.length > 1 && (
        <select className="no-print" value={mat.key} onChange={e => setMatKey(e.target.value)} style={{ marginBottom: 10 }}>
          {mats.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
        </select>
      )}
      {mat && mat.sheets.map((sh, si) => (
        <div key={si} style={{ marginBottom: 14 }}>
          <p className="section-title no-print">{sh.stock === 'offcut' ? 'Обрезок' : 'Лист'} {si + 1} · {sh.placed.length} дет.</p>
          <div className="lbl-grid">
            {sh.placed.map((p, pi) => <Label key={pi} tpl={tpl} order={order} mat={mat} si={si} pi={pi} />)}
          </div>
        </div>
      ))}
      {saveAsk && <SaveFilesDialog files={saveAsk.files} zipName={saveAsk.zipName} onClose={() => setSaveAsk(null)} />}
    </div>
  )
}
