import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { savedNestings, sheetGeo } from '../lib/savedNesting'
import { LABEL_ITEMS, itemKind, itemTitle, newLabelItem, DEFAULT_LABEL, resizeLabel, getLabelTpl, saveLabelTpl, normalizeLabel, labelInfo, drawLabel, labelPx, buildLabelFiles, zipFiles } from '../lib/labelMaker'
import { getCnc, activePost } from '../lib/cncSettings'
import CncLoader from '../components/CncLoader'

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
    const { w, h } = labelPx(tpl)
    cv.width = w; cv.height = h
    const sheet = mat.sheets[si]
    drawLabel(cv, tpl, labelInfo(order, mat, si, pi), { sheet, geo: sheetGeo(order, mat.result, sheet), index: pi, detail: mat.details[sheet.placed[pi].detailIndex] })
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
    const { w, h } = labelPx(t)
    cv.width = w; cv.height = h
    const sheet = mat.sheets[0]
    drawLabel(cv, t, labelInfo(order, mat, 0, 0), { sheet, geo: sheetGeo(order, mat.result, sheet), index: 0, detail: mat.details[sheet.placed[0].detailIndex] })
  }, [t, order, mat])
  const boxH = it => (itemKind(it.type) === 'pic' ? it.h : it.size * 1.25)
  const down = (e, it, mode) => {
    e.stopPropagation(); e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    setSel(it.id)
    drag.current = { id: it.id, mode, x: e.clientX, y: e.clientY, it: { ...it } }
  }
  const move = e => {
    const d = drag.current
    if (!d) return
    const dx = (e.clientX - d.x) / scale, dy = (e.clientY - d.y) / scale, o = d.it, pic = itemKind(o.type) === 'pic'
    const patch = d.mode === 'move' ? { x: o.x + dx, y: o.y + dy }
      : pic ? { w: Math.max(4, o.w + dx), h: Math.max(4, o.h + dy) } : { w: Math.max(4, o.w + dx), size: Math.max(1.2, o.size + dy / 1.25) }
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
              style={{ position: 'absolute', left: it.x * scale, top: it.y * scale, width: it.w * scale, height: boxH(it) * scale, boxSizing: 'border-box', cursor: 'move',
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
          {itemKind(cur.type) === 'text' && (
            <>
              <button type="button" style={chip(false)} onClick={() => edit({ size: cur.size - 0.3 })}>A−</button>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{cur.size.toFixed(1)} мм</span>
              <button type="button" style={chip(false)} onClick={() => edit({ size: cur.size + 0.3 })}>A+</button>
              <button type="button" style={{ ...chip(cur.bold), fontWeight: 700 }} onClick={() => edit({ bold: !cur.bold })}>Ж</button>
              <button type="button" style={chip(cur.align === 'right')} onClick={() => edit({ align: cur.align === 'right' ? 'left' : 'right' })}>{cur.align === 'right' ? 'По правому краю' : 'По левому краю'}</button>
            </>
          )}
          <button type="button" style={{ ...chip(false), color: 'var(--danger)', borderColor: 'var(--danger)', marginLeft: 'auto' }}
            onClick={() => { onChange({ ...tpl, items: tpl.items.filter(i => i.id !== sel) }); setSel(null) }}>Убрать</button>
        </div>
      )}
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Добавить на бирку</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        {LABEL_ITEMS.filter(([k]) => !used.has(k)).map(([k, label]) => (
          <button key={k} type="button" style={chip(false)} onClick={() => { const it = newLabelItem(k, tpl); onChange({ ...tpl, items: [...tpl.items, it] }); setSel(it.id) }}>+ {label}</button>
        ))}
        {LABEL_ITEMS.every(([k]) => used.has(k)) && <span style={{ fontSize: 12, color: 'var(--text-hint)' }}>Все элементы уже на бирке.</span>}
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
  const change = patch => { const t = normalizeLabel({ ...tpl, ...patch, enabled: true }); setTpl(t); saveLabelTpl(t, user) }
  const size = (k, v) => { const x = Number(String(v).replace(',', '.')); if (isFinite(x) && x > 0) { const t = { ...resizeLabel(tpl, k === 'w' ? x : tpl.w, k === 'h' ? x : tpl.h), enabled: true }; setTpl(t); saveLabelTpl(t, user) } }
  // файлы стола бирковки — тем же набором, что делает ЧПУ вместе с G-кодом
  const exportFiles = async () => {
    setBusy(true)
    try {
      const post = activePost(getCnc(user)), base = `${safeName(order.order_number)}${mats.length > 1 ? '_' + safeName(mat.name).slice(0, 24) : ''}`
      const files = await buildLabelFiles({ order, mat, base, post, tpl, sheets: mat.sheets.map((_, si) => ({ si, nc: `${si + 1}_${base}.${post.ext || 'nc'}` })) })
      const url = URL.createObjectURL(new Blob([zipFiles(files)], { type: 'application/zip' }))
      const a = document.createElement('a'); a.href = url; a.download = `Birki_${base}.zip`; document.body.appendChild(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 3000)
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
            {mat ? <LabelEditor tpl={tpl} onChange={change} order={order} mat={mat} />
              : <p style={{ fontSize: 12, color: 'var(--text-hint)' }}>Расставить элементы можно в заказе с сохранённым раскроем — бирка показывается на настоящей детали.</p>}
            {[['rot', 'Лист на бирке — горизонтально (длина листа слева направо); деталь и кромка повёрнуты так же'], ['edges', 'Кромка — по сторонам бирки, там же, где она у детали']].map(([k, label]) => (
              <label key={k} style={{ display: 'flex', alignItems: 'flex-start', gap: 7, fontSize: 12.5, cursor: 'pointer', marginBottom: 6 }}>
                <input type="checkbox" checked={!!tpl[k]} onChange={e => change({ [k]: e.target.checked })} style={{ width: 17, height: 17, flex: '0 0 auto', marginTop: 1 }} />
                {label}
              </label>
            ))}
            <button type="button" onClick={() => { if (window.confirm('Вернуть раскладку по образцу?')) change(resizeLabel({ ...DEFAULT_LABEL(), rot: tpl.rot, edges: tpl.edges }, tpl.w, tpl.h)) }}
              style={{ padding: '6px 11px', borderRadius: 20, fontSize: 12, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text-muted)' }}>↺ Раскладка по образцу</button>
            <p style={{ fontSize: 11, color: 'var(--text-hint)', margin: '8px 0 0' }}>
              Шаблон сохраняется в аккаунте. Когда он настроен, в разделе ЧПУ при создании G-кода появляется галочка «Программа для стола бирковки».
            </p>
            {mat && <button type="button" className="btn-secondary" style={{ marginTop: 10 }} disabled={busy} onClick={exportFiles}>{busy ? 'Собираем файлы…' : '⬇ Файлы для стола бирковки (zip)'}</button>}
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
    </div>
  )
}
