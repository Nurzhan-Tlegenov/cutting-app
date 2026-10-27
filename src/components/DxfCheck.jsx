import { useEffect, useRef, useState } from 'react'

// Проверка чертежа DXF перед импортом: картинка (детали, обработка, ошибки), что исправлено само,
// список проблем с кнопками. opts — { snap, close, skip, scale }; onOpts(новые) — пересчитать импорт.
const SNAPS = [0.1, 0.5, 1, 2, 5]
const COLORS = {
  part: '#1f2937', skipped: '#9ca3af', work: '#185FA5', edge: '#d97706', open: '#dc2626', lost: '#dc2626', ghost: '#cbd5e1',
}
const n1 = v => String(Math.round(v * 10) / 10).replace('.', ',')

export default function DxfCheck({ dxf, opts, onOpts, busy }) {
  const cvRef = useRef(null), boxRef = useRef(null)
  const [focus, setFocus] = useState(null)        // id проблемы, к которой приближена картинка
  const [zoom, setZoom] = useState(1)
  const [w, setW] = useState(0)
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el); setW(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  const problems = dxf.problems || []
  const focused = problems.find(p => p.id === focus && p.box)
  // видимая область чертежа
  const area = (() => {
    const b = focused ? focused.box : dxf.view
    const pad = focused ? Math.max(40, (b.x1 - b.x0 + b.y1 - b.y0) * 0.6) : Math.max(10, (b.x1 - b.x0 + b.y1 - b.y0) * 0.02)
    let x0 = b.x0 - pad, x1 = b.x1 + pad, y0 = b.y0 - pad, y1 = b.y1 + pad
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, hw = (x1 - x0) / 2 / zoom, hh = (y1 - y0) / 2 / zoom
    x0 = cx - hw; x1 = cx + hw; y0 = cy - hh; y1 = cy + hh
    return { x0, y0, x1, y1 }
  })()
  const H = Math.round(Math.min(420, Math.max(220, w * 0.62)))
  const sc = w ? Math.min(w / (area.x1 - area.x0), H / (area.y1 - area.y0)) : 1
  const ox = w ? (w - (area.x1 - area.x0) * sc) / 2 : 0, oy = (H - (area.y1 - area.y0) * sc) / 2
  const toPx = p => [ox + (p[0] - area.x0) * sc, H - oy - (p[1] - area.y0) * sc]

  useEffect(() => {
    const cv = cvRef.current
    if (!cv || !w) return
    const dpr = window.devicePixelRatio || 1
    cv.width = Math.round(w * dpr); cv.height = Math.round(H * dpr)
    cv.style.width = w + 'px'; cv.style.height = H + 'px'
    const ctx = cv.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, H)
    const order = ['ghost', 'skipped', 'part', 'work', 'edge', 'lost', 'open']
    for (const kind of order) {
      for (const d of dxf.draw || []) {
        if (d.k !== kind || d.pts.length < 2) continue
        ctx.beginPath()
        d.pts.forEach((q, i) => { const [x, y] = toPx(q); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y) })
        if (d.closed) ctx.closePath()
        if (kind === 'part') { ctx.fillStyle = 'rgba(24,95,165,0.07)'; ctx.fill() }
        ctx.setLineDash(kind === 'skipped' || kind === 'lost' ? [5, 4] : [])
        ctx.strokeStyle = COLORS[kind]
        ctx.lineWidth = kind === 'open' ? 2.2 : kind === 'part' ? 1.3 : 1
        ctx.stroke()
      }
    }
    ctx.setLineDash([])
    // отметки проблем: кружок вокруг места
    for (const p of problems) {
      if (!p.box) continue
      const pts = p.kind === 'open' ? [p.at, p.at2] : [[(p.box.x0 + p.box.x1) / 2, (p.box.y0 + p.box.y1) / 2]]
      for (const q of pts) {
        const [x, y] = toPx(q)
        ctx.beginPath(); ctx.arc(x, y, p.id === focus ? 13 : 9, 0, Math.PI * 2)
        ctx.strokeStyle = p.kind === 'lost' ? '#d97706' : '#dc2626'; ctx.lineWidth = p.id === focus ? 2.5 : 1.8; ctx.stroke()
      }
    }
  })

  // нажатие на деталь на картинке — не брать / вернуть
  const onTap = e => {
    const r = cvRef.current.getBoundingClientRect()
    const x = (e.clientX - r.left - ox) / sc + area.x0, y = (H - oy - (e.clientY - r.top)) / sc + area.y0
    let best = null, ba = Infinity
    for (const d of dxf.draw || []) {
      if (!d.key) continue
      const xs = d.pts.map(q => q[0]), ys = d.pts.map(q => q[1])
      if (x < Math.min(...xs) || x > Math.max(...xs) || y < Math.min(...ys) || y > Math.max(...ys)) continue
      let inside = false
      for (let i = 0, j = d.pts.length - 1; i < d.pts.length; j = i++) {
        const a = d.pts[i], b = d.pts[j]
        if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside
      }
      const ar = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys))
      if (inside && ar < ba) { best = d; ba = ar }
    }
    if (best) toggleSkip(best.key)
  }
  const toggleSkip = key => onOpts({ ...opts, skip: opts.skip.includes(key) ? opts.skip.filter(k => k !== key) : [...opts.skip, key] })
  const closeOpen = id => onOpts({ ...opts, close: [...opts.close, id] })
  const fx = dxf.fixed || {}
  const fixedTxt = [
    fx.gaps > 0 && `сшито разрывов: ${fx.gaps} (до ${n1(fx.maxGap)} мм)`,
    fx.dups > 0 && `убрано двойных линий: ${fx.dups}`,
    fx.tails > 0 && `обрезано «усов» на углах: ${fx.tails}`,
    fx.paths > 0 && `пазов и выемок одной линией: ${fx.paths}`,
  ].filter(Boolean)
  const chip = on => ({ padding: '4px 9px', borderRadius: 14, fontSize: 12, cursor: busy ? 'default' : 'pointer',
    border: on ? '1.5px solid var(--blue)' : '0.5px solid var(--border-md)', background: on ? 'var(--blue-light)' : 'transparent', color: on ? 'var(--blue)' : 'var(--text-muted)' })
  const btn = { padding: '4px 10px', borderRadius: 8, fontSize: 12, border: '0.5px solid var(--blue-mid)', background: 'var(--bg)', color: 'var(--blue)', cursor: busy ? 'default' : 'pointer', whiteSpace: 'nowrap' }
  const units = problems.find(p => p.kind === 'units')

  return (
    <div style={{ background: 'var(--bg)', border: `0.5px solid ${problems.length ? 'var(--amber)' : 'var(--border)'}`, borderRadius: 'var(--radius)', padding: '8px 10px', marginBottom: 10, fontSize: 12, color: 'var(--text-muted)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
        <b style={{ fontSize: 13, color: 'var(--text)', fontWeight: 600 }}>Проверка чертежа</b>
        <span>{problems.length ? `проблем: ${problems.length}` : 'ошибок не найдено ✓'}</span>
        {dxf.skippedParts > 0 && <span>· не берутся деталей: {dxf.skippedParts} <button type="button" style={{ ...btn, padding: '1px 7px' }} disabled={busy} onClick={() => onOpts({ ...opts, skip: [] })}>вернуть все</button></span>}
      </div>
      {fixedTxt.length > 0 && <div style={{ color: '#1F7A38', marginBottom: 6 }}>Исправлено само: {fixedTxt.join(' · ')}</div>}

      <div ref={boxRef} style={{ position: 'relative', border: '0.5px solid var(--border)', borderRadius: 8, background: '#fff', overflow: 'hidden', opacity: busy ? 0.6 : 1 }}>
        <canvas ref={cvRef} onClick={onTap} style={{ display: 'block', cursor: 'pointer' }} />
        <div style={{ position: 'absolute', right: 6, top: 6, display: 'flex', gap: 4 }}>
          {[['−', 1 / 1.6], ['+', 1.6]].map(([t, k]) => <button key={t} type="button" onClick={() => setZoom(z => Math.max(1, Math.min(40, z * k)))} style={{ width: 28, height: 26, borderRadius: 6, border: '0.5px solid var(--border-md)', background: 'var(--bg)', fontSize: 15, padding: 0, cursor: 'pointer' }}>{t}</button>)}
          {(focus || zoom > 1) && <button type="button" onClick={() => { setFocus(null); setZoom(1) }} style={{ height: 26, borderRadius: 6, border: '0.5px solid var(--border-md)', background: 'var(--bg)', fontSize: 11, padding: '0 8px', cursor: 'pointer' }}>весь чертёж</button>}
        </div>
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--text-hint)', margin: '3px 0 6px' }}>
        Нажмите на деталь на картинке — она не будет взята (серая пунктирная); ещё раз — вернётся. Красным — ошибки, синим — обработка, оранжевым — кромка.
      </div>

      {/* допуск сшивания */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', marginBottom: 6 }}>
        <span>Сшивать разрывы до:</span>
        {SNAPS.map(v => <button key={v} type="button" disabled={busy} style={chip(Math.abs(opts.snap - v) < 1e-9)} onClick={() => onOpts({ ...opts, snap: v })}>{n1(v)} мм</button>)}
      </div>
      {(units || opts.scale !== 1) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', marginBottom: 6 }}>
          <span>Единицы чертежа:</span>
          {[[1, 'мм (как есть)'], [10, 'см ×10'], [25.4, 'дюймы ×25,4']].map(([v, t]) => <button key={v} type="button" disabled={busy} style={chip(opts.scale === v)} onClick={() => onOpts({ ...opts, scale: v })}>{t}</button>)}
        </div>
      )}

      {problems.length > 0 && (
        <div style={{ borderTop: '0.5px solid var(--border)', paddingTop: 4 }}>
          {problems.slice(0, 60).map(p => (
            <div key={p.id} onClick={() => { if (p.box) { setFocus(p.id); setZoom(1) } }}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 4px', borderRadius: 6, cursor: p.box ? 'pointer' : 'default', background: p.id === focus ? 'var(--amber-light)' : 'transparent' }}>
              <span style={{ color: p.kind === 'lost' ? 'var(--amber)' : 'var(--danger)', flex: '0 0 auto' }}>●</span>
              <span style={{ flex: 1, minWidth: 0, color: 'var(--text)' }}>{p.text}</span>
              {p.kind === 'open' && p.canClose && <button type="button" style={btn} disabled={busy} onClick={e => { e.stopPropagation(); closeOpen(p.id) }}>Замкнуть прямой</button>}
              {p.kind === 'overlap' && p.keys.map((k, i) => <button key={k} type="button" style={btn} disabled={busy} onClick={e => { e.stopPropagation(); toggleSkip(k) }}>Не брать {p.sizes[i]}</button>)}
            </div>
          ))}
          {problems.length > 60 && <div style={{ color: 'var(--text-hint)' }}>…и ещё {problems.length - 60}</div>}
        </div>
      )}
    </div>
  )
}
