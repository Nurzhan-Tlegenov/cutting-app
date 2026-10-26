import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { getUserSettings, saveUserSettings } from '../lib/userSettings'
import { drawSummaryPreview, demoPdfSample } from '../lib/nestingPdf'
import { nestingStats, statsRows, emptyStats } from '../lib/nestingStats'
import { pdfSummaryOf, orderRows } from '../lib/pdfSummary'
import { useBackClose } from '../lib/backStack'

// Конструктор страницы «Статистика раскроя» (последняя страница PDF карт): что выводить, в каком порядке, каким шрифтом,
// в одну или две колонки; порядок разделов (раскрой, стоимость работ, примечания) и вид сметы. Видно сразу на образце.
// Хранится за аккаунтом в pdfSummary: { off, order, sections, size, cols, price, noNotes, noOrderNote, noProdNote }.
const PAGE_W = 210, PAGE_H = 297
const SECTIONS = { stats: 'Статистика раскроя', cost: 'Стоимость работ (смета)', notes: 'Примечания' }
const PRICE_MODES = [['lines', 'Построчно'], ['total', 'Только итог'], ['none', 'Без сметы']]
// образец сметы — чтобы видеть, как она ляжет на страницу
const DEMO_QUOTE = { total: 18640, currency: '₸', lines: [{ key: 'cut_m', qty: 34.55, rate: 40, sum: 1382 }, { key: 'edge_m', qty: 18.94, rate: 120, sum: 2272.8 }, { key: 'hole', qty: 48, rate: 30, sum: 1440 }] }

// все строки статистики (в заказе выводятся только те, что в нём есть)
function allRows() {
  const st = { ...emptyStats(), sheets: [{ parts: 1 }, { parts: 2 }], sheetCount: 2, parts: 3, partsM2: 1, sheetsM2: 2, kerf: 4, cuts: 1, cutM: 1, perimM: 1,
    shapedParts: 1, cutouts: 1, edgeM: 1, edgeThinM: 1, edgeThickM: 1, edgeCurvedM: 1, edgeCurvedParts: 1, holes: 1, edgeHoles: 1, drillM2: 1, drillParts: 1, grooves: 1, grooveM: 1, pockets: 1, edgeByType: { 'ПВХ 0,4': 1, 'ПВХ 2': 1 } }
  const out = []
  for (const r of statsRows(st)) {
    if (r.key === 'edgeTypes') { if (!out.some(x => x.key === 'edgeTypes')) out.push({ key: r.key, label: 'Кромка по видам (каждый вид — своей строкой)' }) } else out.push({ key: r.key, label: r.label })
  }
  return out
}

export default function SummaryLayoutEditor({ onClose }) {
  useBackClose(true, onClose)
  const { user } = useAuth()
  const [demo] = useState(() => demoPdfSample())
  const [demoStats] = useState(() => nestingStats({ order: demo.order, mat: demo.mat, method: 'nesting' }))
  const [cfg, setCfg] = useState(() => ({ off: [], price: 'lines', ...(getUserSettings(user).pdfSummary || {}) }))
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 900)
  const [fitK, setFitK] = useState(1.5)
  const holderRef = useRef(null), cvRef = useRef(null)
  const off = new Set(cfg.off || [])
  const rows = orderRows(allRows(), cfg.order)
  const sections = (() => { const ok = Object.keys(SECTIONS), s = Array.isArray(cfg.sections) ? cfg.sections.filter(k => ok.includes(k)) : []; return [...new Set([...s, ...ok])] })()
  const set = patch => setCfg(c => ({ ...c, ...patch }))

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
    if (!cvRef.current) return
    const id = requestAnimationFrame(() => {
      try { drawSummaryPreview(cvRef.current, { order: demo.order, mat: demo.mat, summary: pdfSummaryOf(demoStats, DEMO_QUOTE, cfg) }) } catch { /* превью не нарисовалось */ }
    })
    return () => cancelAnimationFrame(id)
  }, [cfg, demo, demoStats])

  const moveRow = (key, d) => {
    const keys = rows.map(r => r.key), i = keys.indexOf(key), j = i + d
    if (j < 0 || j >= keys.length) return
    ;[keys[i], keys[j]] = [keys[j], keys[i]]
    set({ order: keys })
  }
  const moveSec = (key, d) => {
    const keys = sections.slice(), i = keys.indexOf(key), j = i + d
    if (j < 0 || j >= keys.length) return
    ;[keys[i], keys[j]] = [keys[j], keys[i]]
    set({ sections: keys })
  }
  const toggle = key => set({ off: off.has(key) ? [...off].filter(k => k !== key) : [...off, key] })
  const save = () => { saveUserSettings({ pdfSummary: cfg }, user); onClose() }
  const reset = () => setCfg(c => ({ off: [], price: c.price || 'lines' }))
  const chip = on => ({ padding: '6px 11px', borderRadius: 20, fontSize: 12, border: '0.5px solid ' + (on ? 'var(--blue)' : 'var(--border-md)'), background: on ? 'var(--blue-light)' : 'transparent', color: on ? 'var(--blue-dark)' : 'var(--text-muted)' })
  const arrow = { width: 30, height: 28, padding: 0, borderRadius: 8, border: '0.5px solid var(--border-md)', background: 'var(--bg)', color: 'var(--text-muted)', fontSize: 14, lineHeight: 1 }
  const size = Number(cfg.size) || 3.1
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 980, background: 'var(--bg2)', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: 'var(--bg)', borderBottom: '0.5px solid var(--border)' }}>
        <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--blue)', fontSize: 22, padding: 0, lineHeight: 1 }}>←</button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 500 }}>Страница статистики PDF</div>
          <div style={{ fontSize: 11, color: 'var(--text-hint)' }}>Последняя страница · на образце (цифры и цены — для примера)</div>
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: wide ? 'row' : 'column' }}>
        <div ref={holderRef} style={{ flex: wide ? 1 : '1 1 50%', minHeight: 0, minWidth: 0, overflow: 'auto', background: '#8a8a86', padding: 8, display: 'flex' }}>
          <canvas ref={cvRef} style={{ width: PAGE_W * fitK, height: PAGE_H * fitK, flex: 'none', margin: 'auto', background: '#fff', boxShadow: '0 2px 10px rgba(0,0,0,0.25)' }} />
        </div>
        <div style={{ flex: wide ? '0 0 400px' : '1 1 50%', minHeight: 0, overflowY: 'auto', padding: '10px 12px',
          borderLeft: wide ? '0.5px solid var(--border)' : 'none', borderTop: wide ? 'none' : '0.5px solid var(--border)' }}>
          <p className="section-title">Порядок разделов</p>
          {sections.map((k, i) => (
            <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0', borderTop: i ? '0.5px solid var(--border)' : 'none', fontSize: 13 }}>
              <span style={{ flex: 1 }}>{SECTIONS[k]}</span>
              {k === 'notes' && <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {/* каждое примечание — своей галочкой (старая общая noNotes снимается при первой правке) */}
                {[['noOrderNote', 'клиента (к заказу)'], ['noProdNote', 'производства']].map(([f, l]) => (
                  <label key={f} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
                    <input type="checkbox" checked={!(cfg.noNotes || cfg[f])} style={{ width: 'auto' }}
                      onChange={e => set({ noNotes: undefined, noOrderNote: cfg.noNotes ? true : cfg.noOrderNote, noProdNote: cfg.noNotes ? true : cfg.noProdNote, [f]: !e.target.checked || undefined })} />{l}</label>
                ))}
              </span>}
              <button type="button" style={arrow} disabled={i === 0} onClick={() => moveSec(k, -1)}>↑</button>
              <button type="button" style={arrow} disabled={i === sections.length - 1} onClick={() => moveSec(k, 1)}>↓</button>
            </div>
          ))}

          <p className="section-title" style={{ marginTop: 12 }}>Вид строк</p>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Шрифт:</span>
            <button type="button" style={chip(false)} onClick={() => set({ size: Math.max(2.4, Math.round((size - 0.2) * 10) / 10) })}>A−</button>
            <span style={{ fontSize: 12, color: 'var(--text-muted)', minWidth: 42, textAlign: 'center' }}>{size.toFixed(1)} мм</span>
            <button type="button" style={chip(false)} onClick={() => set({ size: Math.min(5, Math.round((size + 0.2) * 10) / 10) })}>A+</button>
            <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 8 }}>Колонки:</span>
            <button type="button" style={chip(cfg.cols === 1)} onClick={() => set({ cols: 1 })}>Одна</button>
            <button type="button" style={chip(cfg.cols !== 1)} onClick={() => set({ cols: undefined })}>Две</button>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Смета:</span>
            {PRICE_MODES.map(([k, l]) => <button key={k} type="button" style={chip((cfg.price || 'lines') === k)} onClick={() => set({ price: k })}>{l}</button>)}
          </div>

          <p className="section-title" style={{ marginTop: 12 }}>Строки статистики — галочка и порядок</p>
          {rows.map((r, i) => (
            <div key={r.key} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', borderTop: i ? '0.5px solid var(--border)' : 'none', fontSize: 13 }}>
              <input type="checkbox" checked={!off.has(r.key)} onChange={() => toggle(r.key)} style={{ width: 'auto' }} />
              <span style={{ flex: 1, minWidth: 0, color: off.has(r.key) ? 'var(--text-hint)' : 'var(--text)' }} onClick={() => toggle(r.key)}>{r.label}</span>
              <button type="button" style={arrow} disabled={i === 0} onClick={() => moveRow(r.key, -1)}>↑</button>
              <button type="button" style={arrow} disabled={i === rows.length - 1} onClick={() => moveRow(r.key, 1)}>↓</button>
            </div>
          ))}
          <p style={{ fontSize: 11, color: 'var(--text-hint)', margin: '6px 0 0' }}>Строки, которых в заказе нет (например, пазы), в PDF не выводятся. Цены сметы — из прайс-листа производства.</p>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, padding: '10px 14px calc(10px + env(safe-area-inset-bottom))', background: 'var(--bg)', borderTop: '0.5px solid var(--border)' }}>
        <button type="button" className="btn-secondary" style={{ flex: 1 }} onClick={reset}>Как было</button>
        <button type="button" className="btn-primary" style={{ flex: 1.4 }} onClick={save}>Сохранить</button>
      </div>
    </div>
  )
}
