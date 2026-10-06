import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { savedNestings, sheetGeo } from '../lib/savedNesting'
import { LABEL_FIELDS, getLabelTpl, saveLabelTpl, normalizeLabel, labelInfo, drawLabel, labelPx, buildLabelFiles, zipFiles } from '../lib/labelMaker'
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
  const size = (k, v) => { const x = Number(String(v).replace(',', '.')); if (isFinite(x) && x > 0) change({ [k]: x }) }
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
            <div style={{ fontSize: 12, color: 'var(--text-muted)', margin: '10px 0 4px' }}>Что показывать на бирке</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 10px' }}>
              {LABEL_FIELDS.map(([k, label]) => (
                <label key={k} style={{ display: 'flex', alignItems: 'flex-start', gap: 7, fontSize: 12.5, cursor: 'pointer' }}>
                  <input type="checkbox" checked={!!tpl.fields[k]} onChange={e => change({ fields: { ...tpl.fields, [k]: e.target.checked } })} style={{ width: 17, height: 17, flex: '0 0 auto', marginTop: 1 }} />
                  {label}
                </label>
              ))}
            </div>
            <p style={{ fontSize: 11, color: 'var(--text-hint)', margin: '8px 0 0' }}>
              Кромка пишется по тем сторонам бирки, где она на детали — как деталь лежит на листе. Шаблон сохраняется в аккаунте.
              Когда он настроен, в разделе ЧПУ при создании G-кода появляется галочка «Программа для стола бирковки».
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
