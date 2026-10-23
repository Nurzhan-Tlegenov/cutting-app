import { useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { getUserSettings, saveUserSettings } from '../lib/userSettings'
import { emptyStats, statsRows } from '../lib/nestingStats'
import { userPdfTpl } from '../lib/pdfSummary'
import PdfLayoutEditor from './PdfLayoutEditor'

// Настройки производства → «Отчёты (PDF)»: всё, что касается PDF карт раскроя, в одном месте —
// конструктор листа (что и где выводить на странице листа), статистика на отдельной странице,
// какие строки статистики раскроя и как показывать смету на последней странице.
// Настройки — за аккаунтом (pdfTpl, pdfStatsPage, pdfSummary); те же, что в окне «PDF» на странице раскроя.
const PRICE_MODES = [['lines', 'Смета построчно'], ['total', 'Только итог'], ['none', 'Без сметы']]

// все строки статистики раскроя (в заказе показываются только те, что есть: пазы — если есть пазы и т. п.)
function allStatsRows() {
  const st = { ...emptyStats(), sheets: [{ parts: 1 }, { parts: 2 }], sheetCount: 2, parts: 3, partsM2: 1, sheetsM2: 2, kerf: 4, cuts: 1, cutM: 1, perimM: 1,
    shapedParts: 1, cutouts: 1, edgeM: 1, edgeThinM: 1, edgeThickM: 1, edgeCurvedM: 1, edgeCurvedParts: 1, holes: 1, edgeHoles: 1, grooves: 1, grooveM: 1, pockets: 1 }
  return statsRows(st).map(r => ({ key: r.key, label: r.label }))
}

export default function ReportsSettings() {
  const { user } = useAuth()
  const [layout, setLayout] = useState(false)
  const [, setTick] = useState(0)
  const st = getUserSettings(user)
  const [statsPage, setStatsPageS] = useState(() => !!st.pdfStatsPage)
  const [estimate, setEstimateS] = useState(() => !!st.pdfEstimate)
  const [cfg, setCfg] = useState(() => ({ off: [], price: 'lines', ...(st.pdfSummary || {}) }))
  const rows = allStatsRows()
  const off = new Set(cfg.off || [])
  const change = patch => { const next = { ...cfg, ...patch }; setCfg(next); saveUserSettings({ pdfSummary: next }, user) }
  const toggle = key => change({ off: off.has(key) ? [...off].filter(k => k !== key) : [...off, key] })
  const custom = userPdfTpl(user)
  const chip = on => ({ flex: 1, padding: '7px 4px', borderRadius: 20, fontSize: 12, border: on ? 'none' : '0.5px solid var(--border-md)', background: on ? 'var(--blue)' : 'transparent', color: on ? 'white' : 'var(--text-muted)' })
  const check = (on, set, title, sub) => (
    <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 0', borderTop: '0.5px solid var(--border)', fontSize: 13, cursor: 'pointer' }}>
      <input type="checkbox" checked={on} onChange={e => set(e.target.checked)} style={{ width: 'auto', marginTop: 2 }} />
      <span>{title}{sub && <span style={{ display: 'block', fontSize: 11, color: 'var(--text-hint)' }}>{sub}</span>}</span>
    </label>
  )
  return (
    <div>
      <p style={{ fontSize: 12, color: 'var(--text-hint)', margin: '0 0 10px' }}>PDF карт раскроя: что выводить на странице листа и где, статистика и смета. Действует для всех PDF карт — со страницы раскроя и из ЧПУ.</p>

      <p className="section-title">Страница листа</p>
      <div onClick={() => setLayout(true)} style={{ display: 'flex', alignItems: 'center', padding: '10px 12px', border: '0.5px solid var(--blue-mid)', borderRadius: 'var(--radius)', cursor: 'pointer', marginBottom: 6 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, color: 'var(--blue)', fontWeight: 500 }}>Конструктор листа PDF</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-hint)' }}>{custom ? 'Свой макет: карта, список, подписи, операции расставлены вами' : 'Стандартный вид. Двигайте карту и список, меняйте шрифты, размеры на карте, добавляйте резы, длину реза, площади, присадку'}</div>
        </div>
        <span style={{ color: 'var(--blue)', fontSize: 18 }}>›</span>
      </div>
      {check(statsPage, v => { setStatsPageS(v); saveUserSettings({ pdfStatsPage: v }, user) }, 'Статистика листов на отдельной странице',
        'Для стандартного вида: на листе только карта на всю ширину и обозначения; использование, кромка, обрезки и списки деталей — в конце')}

      <p className="section-title" style={{ marginTop: 12 }}>Последняя страница: статистика раскроя и смета</p>
      {check(estimate, v => { setEstimateS(v); saveUserSettings({ pdfEstimate: v }, user) }, 'Добавлять страницу статистики и сметы', 'Та же галочка «Смета» под кнопкой PDF на странице раскроя')}
      {rows.map(r => (
        <label key={r.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0 5px 24px', borderTop: '0.5px solid var(--border)', fontSize: 13 }}>
          <input type="checkbox" checked={!off.has(r.key)} onChange={() => toggle(r.key)} style={{ width: 'auto' }} />
          <span style={{ flex: 1, color: off.has(r.key) ? 'var(--text-hint)' : 'var(--text)' }}>{r.label}</span>
        </label>
      ))}
      <p style={{ fontSize: 11, color: 'var(--text-hint)', margin: '4px 0 8px 24px' }}>Строки, которых в заказе нет (например, пазы), не выводятся.</p>
      <div style={{ display: 'flex', gap: 8, margin: '0 0 12px 24px' }}>
        <button type="button" style={{ ...chip(false), flex: '0 0 auto', padding: '5px 12px' }} onClick={() => change({ off: [] })}>Выбрать всё</button>
        <button type="button" style={{ ...chip(false), flex: '0 0 auto', padding: '5px 12px' }} onClick={() => change({ off: rows.map(r => r.key) })}>Снять всё</button>
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
        {PRICE_MODES.map(([k, l]) => <button key={k} type="button" style={chip(cfg.price === k)} onClick={() => change({ price: k })}>{l}</button>)}
      </div>
      <p style={{ fontSize: 11, color: 'var(--text-hint)', margin: 0 }}>Цены берутся из прайс-листа производства.</p>

      {layout && <PdfLayoutEditor onClose={() => { setLayout(false); setTick(t => t + 1) }} />}
    </div>
  )
}
