// Управляющие программы по отдельным деталям (кабинет производства → карточка заказа → список деталей).
// Зачем: деталь после раскроя испортили, а форматника и шестистороннего станка нет — её вырезают на том же фрезере
// из заготовки чуть больше (деловой остаток): одна деталь, со всей обработкой (присадка, пазы, вырезы, контур).
// Программа — тем же генератором и по тем же настройкам постпроцессора и «Обработки» (в т.ч. «Выводить в УП»), что и
// программы листов. Деталь стоит как в раскрое (тот же поворот), «лист» — заготовка «деталь + отступ с каждой стороны»:
// обработка начинается с отступа X / Y от нуля станка. Отступы — настройка аккаунта (запоминаются).
import { useMemo, useState, Suspense } from 'react'
import { createPortal } from 'react-dom'
import { useAuth } from '../context/AuthContext'
import { useCnc } from '../hooks/useCnc'
import { routerPost, postView } from '../lib/cncSettings'
import { buildSheetGcode, partFeatures, skipOf } from '../lib/gcode'
import { parseGcode, fmtTime } from '../lib/gcodeSim'
import { cornerShift } from '../lib/sheetCorner'
import { lazyRetry } from '../lib/lazyRetry'
import { useBackClose } from '../lib/backStack'
import CncLoader from './CncLoader'
import { savedNestings, sheetGeo, dropDetailsFromNesting } from '../lib/savedNesting'
import { productionDeleteDetails, productionStripDrilling } from '../lib/productionApi'
import { cutDetails, parseEdgeTypes } from '../lib/edgeCut'
import { getUserSettings, saveUserSettings } from '../lib/userSettings'
import { toLatin } from '../lib/orderUtils'
import { detailMeta } from '../lib/partLabel'
import { isTwoSided } from '../lib/partInfo'
import SaveFilesDialog from './SaveFilesDialog'
import QrPartsEditor from './QrPartsEditor'
import { labelInfo, labelQr } from '../lib/labelMaker'
import Hint from './Hint'

const n0 = v => Number(String(v ?? '').replace(',', '.')) || 0
// Имя программы детали — тем же конструктором, что QR бирки и имя файла шестистороннего (запоминается за аккаунтом).
// В конце имени всегда обозначение (или позиция) детали — иначе у разных деталей имена совпадут.
const PART_NAME_DEFAULT = { tpl: '{ZAKAZ}_{MAT}_{NAIM}_{OBOZ}', sep: '_', latin: true }
const BAD = /[\\/:*?"<>|\s]+/g
const GcodeSimulator = lazyRetry(() => import('./GcodeSimulator'))   // тот же симулятор, что у программ листов
function download(name, data) {
  const url = URL.createObjectURL(new Blob([data], { type: 'text/plain' }))
  const a = document.createElement('a')
  a.href = url; a.download = name
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export default function PartPrograms({ order, details, selected, onClear, onChanged }) {
  const { user } = useAuth()
  const { cnc, ready } = useCnc(null, order?.production_id || null)
  const [off, setOff] = useState(() => ({ x: 10, y: 10, ...(getUserSettings(user).partProg || {}) }))
  const [res, setRes] = useState(null)           // { files, notes }
  const [save, setSave] = useState(false)
  const [sim, setSim] = useState(null)           // программа в симуляторе
  useBackClose(!!sim, () => setSim(null))        // «назад» на телефоне закрывает симулятор, а не страницу
  const setO = patch => { const v = { ...off, ...patch }; setOff(v); setRes(null); saveUserSettings({ partProg: { ...v, name: nameQ } }, user) }
  const mats = useMemo(() => savedNestings(order, cutDetails(details, parseEdgeTypes(order?.edge_types))), [order, details])
  const [nameQ, setNameQ] = useState(() => ({ ...PART_NAME_DEFAULT, ...(getUserSettings(user).partProg?.name || {}) }))
  const [nameEdit, setNameEdit] = useState(false)
  const [busy, setBusy] = useState('')
  const [done, setDone] = useState('')
  // у скольких выбранных деталей есть присадка (отверстия в пласть и в торец)
  const drilled = selected.filter(id => {
    const d = details.find(x => x.id === id)
    let c = d?.contour
    if (typeof c === 'string') { try { c = JSON.parse(c) } catch { c = null } }
    return (c?.drillings || []).length > 0
  })
  const nm = id => { const d = details.find(x => x.id === id); return [detailMeta(d)?.des, d?.name].filter(Boolean).join(' ') || 'Деталь' }
  const list = ids => ids.slice(0, 8).map(nm).join(', ') + (ids.length > 8 ? ` и ещё ${ids.length - 8}` : '')
  // удалить детали из заказа: из карт раскроя они убираются, остальные остаются на своих местах (перекроить — по желанию)
  const delParts = async () => {
    if (!window.confirm(`Удалить из заказа ${selected.length === 1 ? 'деталь' : `детали (${selected.length})`}: ${list(selected)}?\nИз карт раскроя ${selected.length === 1 ? 'она уберётся' : 'они уберутся'}, остальные детали останутся на местах. Отменить нельзя.`)) return
    setBusy('del'); setDone('')
    const nx = dropDetailsFromNesting(order, details, selected)
    const r = await productionDeleteDetails(order.id, selected, nx.value)
    setBusy('')
    if (r.error) { window.alert('Не удалось удалить: ' + r.error); return }
    setRes(null); onClear?.(); onChanged?.()
    if (nx.reset.length) window.alert(`Раскрой под пильный центр (${nx.reset.join(', ')}) сброшен — перекроите этот материал.`)
  }
  // удалить всю присадку у деталей: отверстия в пласть и в торец; пазы, выемки, вырезы и контур остаются
  const stripDrill = async () => {
    if (!drilled.length) return
    if (!window.confirm(`Удалить всю присадку (отверстия в пласть и в торец) у ${drilled.length === 1 ? 'детали' : `деталей (${drilled.length})`}: ${list(drilled)}?\nПазы, выемки, вырезы и контур останутся. Отменить нельзя.`)) return
    setBusy('drill'); setDone('')
    const r = await productionStripDrilling(order.id, drilled)
    setBusy('')
    if (r.error) { window.alert('Не удалось удалить присадку: ' + r.error); return }
    setRes(null); onChanged?.()
    setDone(`Присадка удалена у ${r.data ?? drilled.length} дет. Программы и бирки этого заказа создайте заново.`)
  }
  const setName = v => { setNameQ(v); setRes(null); saveUserSettings({ partProg: { ...off, name: v } }, user) }
  // где деталь стоит в раскрое на фрезере -> { mat, sh, p, si, pi } или null
  const findHit = id => {
    for (const mat of mats) {
      if (mat.result?.beamSaw) continue
      const di = mat.details.findIndex(d => d.id === id)
      if (di < 0) continue
      for (let si = 0; si < (mat.sheets || []).length; si++) {
        const sh = mat.sheets[si], pi = (sh.placed || []).findIndex(q => q.detailIndex === di)
        if (pi >= 0) return { mat, sh, p: sh.placed[pi], si, pi }
      }
    }
    return null
  }
  // имя файла без расширения: по шаблону; в конце — обозначение / позиция детали (если шаблон их не дал в конце)
  const partName = (hit, latin) => {
    let info
    try { info = labelInfo(order, hit.mat, hit.si, hit.pi) } catch { info = {} }
    const lat = t => (latin ? toLatin(t) : String(t))
    const clean = t => lat(String(t || '')).replace(BAD, '_').replace(/_{2,}/g, '_').replace(/^[_.-]+|[_.-]+$/g, '')
    let name = clean(labelQr({ qr: { ...nameQ, parts: [], latin } }, info))
    // уже кончается обозначением или позицией — так и оставляем; иначе дописываем обозначение (нет его — позицию)
    const ends = [info.des, info.pos].map(clean).filter(Boolean)
    const tail = clean(info.des || info.pos || (info.num ? `N${info.num}` : ''))
    if (tail && !ends.some(e => name.endsWith(e))) name = name ? `${name}${nameQ.sep ?? '_'}${tail}` : tail
    return name || 'part'
  }

  const build = () => {
    const post = routerPost(cnc)
    if (!post) { setRes({ files: [], notes: ['Нет раскроечного станка (фрезера) в настройках ЧПУ.'] }); return }
    const ox = Math.max(0, n0(off.x)), oy = Math.max(0, n0(off.y))
    const files = [], notes = [], used = new Set()
    for (const id of selected) {
      const row = details.find(d => d.id === id)
      const label = [detailMeta(row)?.des, row?.name].filter(Boolean).join(' ') || 'Деталь'
      const hit = findHit(id)
      if (!hit) { notes.push(`«${label}» — нет в раскрое на фрезере, программа не создана.`); continue }
      const { mat, sh, p } = hit
      const pw = n0(p.origX), ph = n0(p.origY)
      const g0 = sheetGeo(order, mat.result, sh)
      const geo = { ...g0, sheetW: pw + 2 * ox, sheetL: ph + 2 * oy, marginL: 0, marginR: 0, marginT: 0, marginB: 0, usableX: pw + 2 * ox, usableY: ph + 2 * oy }
      const sheet = { placed: [{ ...p, x: ox, y: oy }], manualOffcuts: [] }
      const r = buildSheetGcode({ sheet, geo, details: mat.details, thickness: mat.thickness, cnc: { ...cnc, post: post.id }, score: false })
      // для симулятора: заготовка и контур детали в координатах программы (как у листов на странице ЧПУ)
      const view = postView({ ...cnc, post: post.id })
      const z = cornerShift(post.corner, geo.sheetW, geo.sheetL)
      const sx = n0(post.originX) + z.dx, sy = n0(post.originY) + z.dy
      const outline = partFeatures(sheet.placed[0], mat.details[p.detailIndex], mat.thickness, skipOf(view.ops)).outline.map(([x, y]) => [sx + ox + x, sy + oy + y])
      const simData = { text: r.text, kinds: r.kinds, opIds: r.opIds, zShift: r.zShift, thickness: mat.thickness, rapid: n0(post.rapid) || 20000,
        sheet: { x: sx, y: sy, w: geo.sheetW, l: geo.sheetL }, outlines: [outline],
        tools: view.tools || [], head: post.drillHead ? (view.tools || []).filter(t => t.type === 'drill' && t.inHead).map(t => Math.round(n0(t.t))) : [] }
      let time
      try { time = parseGcode(r.text, { rapid: simData.rapid, zShift: r.zShift }).time } catch { time = 0 }
      const base = partName(hit, post.progLatin !== false)
      let name = base
      for (let k = 2; used.has(name); k++) name = `${base}_${k}`
      used.add(name)
      files.push({ name: `${name}.${post.ext || 'nc'}`, data: r.text, sim: simData, time, empty: !!r.empty, label, size: `${Math.round(pw)} × ${Math.round(ph)}`, blank: `${Math.round(pw + 2 * ox)} × ${Math.round(ph + 2 * oy)}`, warnings: r.warnings || [] })
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
      {(() => {
        const post = routerPost(cnc), h = selected.length ? findHit(selected[0]) : null
        const ex = h ? `${partName(h, post?.progLatin !== false)}.${post?.ext || 'nc'}` : ''
        return (
          <div style={{ marginTop: 8, fontSize: 12.5 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0, color: 'var(--text-muted)' }}>Имя программы: <b style={{ fontFamily: 'monospace', color: 'var(--text)', wordBreak: 'break-all' }}>{ex || '—'}</b></div>
              <button type="button" onClick={() => setNameEdit(x => !x)} style={{ padding: '4px 10px', fontSize: 12, borderRadius: 14, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text)', cursor: 'pointer', flex: '0 0 auto' }}>{nameEdit ? 'Готово' : 'Изменить'}</button>
            </div>
            {nameEdit && (
              <div style={{ marginTop: 6 }}>
                <QrPartsEditor value={nameQ} exclude={['link']} onChange={setName} preview={ex} />
                <Hint>Имя собирается из частей, как код QR бирки: заказ, материал, наименование, обозначение, позиция, размер… В конце имени всегда обозначение детали (нет обозначения — позиция): так у каждой детали своё имя. Запоминается.</Hint>
              </div>
            )}
          </div>
        )
      })()}
      <button type="button" className="btn-primary" disabled={!ready || !selected.length} onClick={build} style={{ marginTop: 8 }}>
        {ready ? `Создать УП только на ${selected.length === 1 ? 'эту деталь' : 'эти детали'}` : 'Загружаем настройки ЧПУ…'}
      </button>
      <Hint>Отдельная программа на каждую выбранную деталь — чтобы вырезать испорченную деталь из заготовки чуть больше (делового остатка) на том же фрезере. Обработка — как в программах листов: настройки постпроцессора и «Обработка» → «Выводить в УП» (присадка, пазы, вырезы, контур). Деталь стоит как в раскрое; обработка начинается с отступа X / Y от нуля станка — заготовку берите больше детали хотя бы на два отступа. Отступы запоминаются.</Hint>
      {/* другие действия с отмеченными деталями: удалить из заказа или удалить у них всю присадку */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
        <button type="button" disabled={!!busy || !selected.length} onClick={delParts}
          style={{ flex: 1, minWidth: 140, padding: '8px 10px', fontSize: 13, borderRadius: 'var(--radius)', border: '0.5px solid var(--danger)', background: 'transparent', color: 'var(--danger)', cursor: 'pointer' }}>
          {busy === 'del' ? 'Удаляем…' : `🗑 Удалить ${selected.length === 1 ? 'деталь' : 'детали'}`}</button>
        <button type="button" disabled={!!busy || !drilled.length} onClick={stripDrill}
          style={{ flex: 1, minWidth: 140, padding: '8px 10px', fontSize: 13, borderRadius: 'var(--radius)', border: '0.5px solid var(--amber)', background: 'transparent', color: drilled.length ? 'var(--amber)' : 'var(--text-hint)', cursor: drilled.length ? 'pointer' : 'default' }}>
          {busy === 'drill' ? 'Удаляем…' : drilled.length ? `⊘ Удалить присадку (${drilled.length})` : '⊘ Присадки нет'}</button>
      </div>
      <Hint>«Удалить детали» — убрать из заказа (и из карт раскроя; остальные детали остаются на местах, перекроить можно потом). «Удалить присадку» — убрать у отмеченных деталей все отверстия: в пласть и в торец. Пазы, выемки, вырезы и контур остаются.</Hint>
      {done && <div style={{ fontSize: 12, color: 'var(--teal)', marginTop: 6 }}>✓ {done}</div>}
      {res && (
        <div style={{ marginTop: 8 }}>
          {res.files.map(f => (
            <div key={f.name} style={{ fontSize: 12.5, padding: '5px 0', borderTop: '0.5px solid var(--border)' }}>
              <b>{f.label}</b> · деталь {f.size} · заготовка не меньше {f.blank}{f.time ? ` · ≈ ${fmtTime(f.time)}` : ''} <span style={{ color: 'var(--text-hint)' }}>· {f.name}</span>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                {!f.empty && <button type="button" onClick={() => setSim(f)} style={{ padding: '4px 10px', fontSize: 12, borderRadius: 14, border: '0.5px solid var(--blue)', background: 'var(--blue-light)', color: 'var(--blue-dark)', cursor: 'pointer' }}>▶ Симулятор</button>}
                <button type="button" onClick={() => download(f.name, f.data)} style={{ padding: '4px 10px', fontSize: 12, borderRadius: 14, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text)', cursor: 'pointer' }}>⬇ Скачать</button>
              </div>
              {f.warnings.map((w, i) => <div key={i} style={{ fontSize: 11.5, color: 'var(--amber)' }}>⚠ {w}</div>)}
            </div>
          ))}
          {res.notes.map((n, i) => <div key={i} style={{ fontSize: 12, color: 'var(--amber)', marginTop: 4 }}>⚠ {n}</div>)}
          {res.files.length > 0 && <button type="button" className="btn-primary" onClick={() => setSave(true)} style={{ marginTop: 8, background: 'var(--teal)', borderColor: 'var(--teal)' }}>⬇ Сохранить {res.files.length === 1 ? 'программу' : `программы (${res.files.length})`}</button>}
        </div>
      )}
      {/* симулятор — поверх всего экрана, как на странице ЧПУ */}
      {sim && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'var(--bg)', zIndex: 1100, padding: 10, boxSizing: 'border-box', height: '100dvh', overscrollBehavior: 'contain' }}>
          <div style={{ maxWidth: window.innerWidth >= 1100 ? 'none' : 1100, margin: '0 auto', height: '100%' }}>
            <Suspense fallback={<CncLoader label="Запускаем симулятор…" />}>
              <GcodeSimulator key={sim.name} text={sim.sim.text} kinds={sim.sim.kinds} opIds={sim.sim.opIds} title={`${sim.label} · ${sim.name}`} thickness={sim.sim.thickness}
                rapid={sim.sim.rapid} zShift={sim.sim.zShift} toolDia={t => n0((sim.sim.tools.find(x => n0(x.t) === t) || {}).d)} headTools={sim.sim.head}
                onClose={() => setSim(null)} onDownload={() => download(sim.name, sim.data)} sheet={sim.sim.sheet} outlines={sim.sim.outlines} />
            </Suspense>
          </div>
        </div>, document.body
      )}
      {save && res?.files?.length > 0 && (
        <SaveFilesDialog files={res.files.map(f => ({ name: f.name, data: f.data }))} zipName={`${toLatin(order?.order_number || 'order')}_detali`}
          onClose={() => setSave(false)} onDone={() => setSave(false)} />
      )}
    </div>
  )
}
