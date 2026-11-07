// Управляющие программы по отдельным деталям (кабинет производства → карточка заказа → список деталей).
// Зачем: деталь после раскроя испортили, а форматника и шестистороннего станка нет — её вырезают на том же фрезере
// из заготовки чуть больше (деловой остаток): одна деталь, со всей обработкой (присадка, пазы, вырезы, контур).
// Программа — тем же генератором и по тем же настройкам постпроцессора и «Обработки» (в т.ч. «Выводить в УП»), что и
// программы листов. Деталь стоит как в раскрое (тот же поворот), «лист» — заготовка «деталь + отступ с каждой стороны»:
// обработка начинается с отступа X / Y от нуля станка. Отступы — настройка аккаунта (запоминаются).
import { useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { useCnc } from '../hooks/useCnc'
import { routerPost } from '../lib/cncSettings'
import { buildSheetGcode } from '../lib/gcode'
import { savedNestings, sheetGeo } from '../lib/savedNesting'
import { cutDetails, parseEdgeTypes } from '../lib/edgeCut'
import { getUserSettings, saveUserSettings } from '../lib/userSettings'
import { programName, toLatin } from '../lib/orderUtils'
import { detailMeta } from '../lib/partLabel'
import { isTwoSided } from '../lib/partInfo'
import SaveFilesDialog from './SaveFilesDialog'
import Hint from './Hint'

const n0 = v => Number(String(v ?? '').replace(',', '.')) || 0

export default function PartPrograms({ order, details, selected, onClear }) {
  const { user } = useAuth()
  const { cnc, ready } = useCnc(null, order?.production_id || null)
  const [off, setOff] = useState(() => ({ x: 10, y: 10, ...(getUserSettings(user).partProg || {}) }))
  const [res, setRes] = useState(null)           // { files, notes }
  const [save, setSave] = useState(false)
  const setO = patch => { const v = { ...off, ...patch }; setOff(v); setRes(null); saveUserSettings({ partProg: v }, user) }
  const mats = useMemo(() => savedNestings(order, cutDetails(details, parseEdgeTypes(order?.edge_types))), [order, details])

  const build = () => {
    const post = routerPost(cnc)
    if (!post) { setRes({ files: [], notes: ['Нет раскроечного станка (фрезера) в настройках ЧПУ.'] }); return }
    const ox = Math.max(0, n0(off.x)), oy = Math.max(0, n0(off.y))
    const files = [], notes = [], used = new Set()
    for (const id of selected) {
      const row = details.find(d => d.id === id)
      const label = [detailMeta(row)?.des, row?.name].filter(Boolean).join(' ') || 'Деталь'
      let hit = null
      for (const mat of mats) {
        if (mat.result?.beamSaw) continue
        const di = mat.details.findIndex(d => d.id === id)
        if (di < 0) continue
        for (const sh of mat.sheets || []) {
          const p = (sh.placed || []).find(q => q.detailIndex === di)
          if (p) { hit = { mat, sh, p }; break }
        }
        if (hit) break
      }
      if (!hit) { notes.push(`«${label}» — нет в раскрое на фрезере, программа не создана.`); continue }
      const { mat, sh, p } = hit
      const pw = n0(p.origX), ph = n0(p.origY)
      const g0 = sheetGeo(order, mat.result, sh)
      const geo = { ...g0, sheetW: pw + 2 * ox, sheetL: ph + 2 * oy, marginL: 0, marginR: 0, marginT: 0, marginB: 0, usableX: pw + 2 * ox, usableY: ph + 2 * oy }
      const sheet = { placed: [{ ...p, x: ox, y: oy }], manualOffcuts: [] }
      const r = buildSheetGcode({ sheet, geo, details: mat.details, thickness: mat.thickness, cnc: { ...cnc, post: post.id }, score: false })
      const base = programName(post.nameTpl, { n: null, total: 0, order, material: mat.name || '', thickness: mat.thickness, latin: post.progLatin !== false })
      let name = `${String(base || 'part').replace(/_+$/, '')}_${toLatin(label).replace(/[^\w.-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'part'}`
      for (let k = 2; used.has(name); k++) name = `${name.replace(/_\d+$/, '')}_${k}`
      used.add(name)
      files.push({ name: `${name}.${post.ext || 'nc'}`, data: r.text, label, size: `${Math.round(pw)} × ${Math.round(ph)}`, blank: `${Math.round(pw + 2 * ox)} × ${Math.round(ph + 2 * oy)}`, warnings: r.warnings || [] })
      if (isTwoSided(row, mat.thickness)) notes.push(`«${label}» — обработка с двух сторон: в программе только лицевая сторона, обратную доприсадить отдельно.`)
    }
    setRes({ files, notes })
  }

  const inp = { width: 70, padding: '6px 8px', textAlign: 'center' }
  return (
    <div style={{ position: 'sticky', bottom: 72, zIndex: 30, marginTop: 8, padding: '10px 12px', borderRadius: 'var(--radius-lg)', background: 'var(--bg)', border: '1px solid var(--blue)', boxShadow: '0 4px 14px rgba(0,0,0,.12)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <b style={{ fontSize: 14 }}>Выбрано деталей: {selected.length}</b>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={onClear} style={{ padding: '4px 10px', fontSize: 12, borderRadius: 14, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}>Снять выбор</button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 8, fontSize: 13 }}>
        <span style={{ color: 'var(--text-muted)' }}>Отступ от нуля станка:</span>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>X <input type="text" inputMode="decimal" key={`x${off.x}`} defaultValue={off.x} onBlur={e => setO({ x: Math.max(0, n0(e.target.value)) })} style={inp} /> мм</label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>Y <input type="text" inputMode="decimal" key={`y${off.y}`} defaultValue={off.y} onBlur={e => setO({ y: Math.max(0, n0(e.target.value)) })} style={inp} /> мм</label>
      </div>
      <button type="button" className="btn-primary" disabled={!ready || !selected.length} onClick={build} style={{ marginTop: 8 }}>
        {ready ? `Создать УП только на ${selected.length === 1 ? 'эту деталь' : 'эти детали'}` : 'Загружаем настройки ЧПУ…'}
      </button>
      <Hint>Отдельная программа на каждую выбранную деталь — чтобы вырезать испорченную деталь из заготовки чуть больше (делового остатка) на том же фрезере. Обработка — как в программах листов: настройки постпроцессора и «Обработка» → «Выводить в УП» (присадка, пазы, вырезы, контур). Деталь стоит как в раскрое; обработка начинается с отступа X / Y от нуля станка — заготовку берите больше детали хотя бы на два отступа. Отступы запоминаются.</Hint>
      {res && (
        <div style={{ marginTop: 8 }}>
          {res.files.map(f => (
            <div key={f.name} style={{ fontSize: 12.5, padding: '5px 0', borderTop: '0.5px solid var(--border)' }}>
              <b>{f.label}</b> · деталь {f.size} · заготовка не меньше {f.blank} <span style={{ color: 'var(--text-hint)' }}>· {f.name}</span>
              {f.warnings.map((w, i) => <div key={i} style={{ fontSize: 11.5, color: 'var(--amber)' }}>⚠ {w}</div>)}
            </div>
          ))}
          {res.notes.map((n, i) => <div key={i} style={{ fontSize: 12, color: 'var(--amber)', marginTop: 4 }}>⚠ {n}</div>)}
          {res.files.length > 0 && <button type="button" className="btn-primary" onClick={() => setSave(true)} style={{ marginTop: 8, background: 'var(--teal)', borderColor: 'var(--teal)' }}>⬇ Сохранить {res.files.length === 1 ? 'программу' : `программы (${res.files.length})`}</button>}
        </div>
      )}
      {save && res?.files?.length > 0 && (
        <SaveFilesDialog files={res.files.map(f => ({ name: f.name, data: f.data }))} zipName={`${toLatin(order?.order_number || 'order')}_detali`}
          onClose={() => setSave(false)} onDone={() => setSave(false)} />
      )}
    </div>
  )
}
