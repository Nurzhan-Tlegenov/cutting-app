import { nestingFaults, FAULT_TITLE } from '../lib/nestingCheck'
import { cutDetails, parseEdgeTypes } from '../lib/edgeCut'
import { useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import BottomNav from '../components/BottomNav'
import { CncBasic, CncCommands, CncTools, CncOps } from '../components/CncSettings'
import { savedNestings, sheetGeo } from '../lib/savedNesting'
import { getCnc, fetchCnc, saveCnc, activePost, withShared } from '../lib/cncSettings'
import { buildSheetGcode, collectLayers, partFeatures, holeToolFor, pocketKey, grooveOpFor } from '../lib/gcode'
import { listSharedPosts, saveSharedPost, removeSharedPost, sendNews } from '../lib/messages'
import { getLabelTpl, buildLabelFiles } from '../lib/labelMaker'
import CncLoader from '../components/CncLoader'
import { orderTitle, toLatin, programName, folderName } from '../lib/orderUtils'
import { orderClient } from '../lib/productionApi'
import SaveFilesDialog from '../components/SaveFilesDialog'
import { productionMark, orderMarks } from '../lib/productionApi'
import PdfSetup from '../components/PdfSetup'
import { parseGcode, fmtTime } from '../lib/gcodeSim'
import SimLinksBox from '../components/SimLinksBox'
import { packSim, getSimShare, saveSimShare, deleteSimShare, simShareUrl } from '../lib/simShare'

// ЧПУ: листы принятого раскроя → управляющая программа (G-код) + симулятор.
// Настройки (постпроцессор, инструменты, обработка контуров, команды) идут за аккаунтом.
import { lazyRetry } from '../lib/lazyRetry'
const GcodeSimulator = lazyRetry(() => import('../components/GcodeSimulator'))   // 3D — подгружается при открытии
const TABS = [['sheets', 'Листы'], ['ops', 'Обработка'], ['tools', 'Инструменты'], ['basic', 'Основные'], ['cmd', 'Команды']]
const num = v => { const x = Number(String(v ?? '').replace(',', '.')); return isFinite(x) ? x : 0 }
// имена программ и папок — строго латиницей: станки и флешки кириллицу читают не везде
const safeName = s => toLatin(String(s || '')).replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '')

function download(name, data, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([data], { type }))
  const a = document.createElement('a')
  a.href = url; a.download = name
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export default function CncPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user, profile, isMaster, cabinet } = useAuth()
  const toOrders = () => navigate(cabinet === 'production' ? '/production' : '/orders')   // «К заказам» — в список своего кабинета
  const labelTpl = useMemo(() => getLabelTpl(user), [user])
  const [labelBusy, setLabelBusy] = useState(false)
  const [order, setOrder] = useState(null)
  const [clientName, setClientName] = useState('')   // имя заказчика — для названий программ и папки
  useEffect(() => { let alive = true; orderClient(id).then(r => { if (alive && !r.error) setClientName(r.data?.full_name || '') }); return () => { alive = false } }, [id])
  const [details, setDetails] = useState([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('sheets')
  const [matKey, setMatKey] = useState('')
  const [picked, setPicked] = useState(null)        // выбранные листы (индексы); null — все
  const [cnc, setCnc] = useState(() => getCnc(user))
  const [built, setBuilt] = useState(null)          // { for: cnc, files: [{ si, name, text, lines, time, warnings, empty }] }
  const [search] = useSearchParams()
  const simSi = search.get('sim')                   // лист в симуляторе — в адресе: кнопка «назад» телефона закрывает симулятор, а не страницу
  const [cncReady, setCncReady] = useState(false)
  const [pendingBuild, setPendingBuild] = useState(false)
  const restored = useRef(false)
  const [linksTick, setLinksTick] = useState(0)

  useEffect(() => {
    let alive = true
    ;(async () => {
      const { data: o } = await supabase.from('orders').select('*').eq('id', id).single()
      const { data: d } = await supabase.from('order_details').select('*').eq('order_id', id).order('sort_order')
      if (!alive) return
      setOrder(o || null); setDetails(cutDetails(d || [], parseEdgeTypes(o?.edge_types)))   /* заготовки: с учётом кромки, как в раскрое */; setLoading(false)
    })()
    // свои настройки + общие постпроцессоры (мастер-аккаунт отметил «для всех»)
    Promise.all([fetchCnc(user), listSharedPosts()]).then(([c, sh]) => { if (alive) { setCnc(withShared(c, sh.data || [])); setCncReady(true) } })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, user?.id])

  const mats = useMemo(() => savedNestings(order, details), [order, details])
  const mat = mats.find(m => m.key === matKey) || mats[0] || null
  // сохранённый раскрой проверяется ещё раз: пересечение деталей или зазор меньше реза — это брак, G-код по нему не выпускается
  const faults = useMemo(() => (order && mat ? nestingFaults(order, [mat]) : []), [order, mat])
  const layers = useMemo(() => (mat ? collectLayers(mat.sheets, mat.details, mat.thickness) : null), [mat])
  const post = activePost(cnc)
  const change = next => {
    const prev = cnc
    setCnc(next); saveCnc(next, user); setBuilt(null)
    if (!isMaster) return
    // «для всех»: общий постпроцессор хранится отдельно и виден каждому пользователю
    for (const p of next.posts) {
      const was = prev.posts.find(q => q.id === p.id)
      if (p.forAll && p !== was) {
        saveSharedPost(p, user)
        if (!was?.forAll && !was?.shared) sendNews(user, profile, 'Новый постпроцессор', `Добавлен постпроцессор «${p.name}». Он уже доступен в разделе ЧПУ → Основные.`)
      } else if (!p.forAll && (was?.forAll || was?.shared)) removeSharedPost(p.id)
    }
    prev.posts.forEach(q => { if ((q.forAll || q.shared) && !next.posts.some(p => p.id === q.id)) removeSharedPost(q.id) })
  }
  const sel = mat ? (picked ?? mat.sheets.map((_, i) => i)) : []
  const toggle = i => { setPicked(sel.includes(i) ? sel.filter(x => x !== i) : [...sel, i].sort((a, b) => a - b)); setBuilt(null) }

  // что не назначено — видно сразу, до создания программы
  const pre = useMemo(() => {
    if (!layers) return []
    const w = [], has = t => (cnc.tools || []).some(x => x.id === t)
    if (!has(cnc.ops.outer.tool)) w.push('контур детали')
    if (layers.cutouts && !has(cnc.ops.cutout.tool)) w.push(`контур выреза (${layers.cutouts} шт.)`)
    layers.grooveLayers.forEach(l => { if (!has(grooveOpFor(cnc.ops, l.key).tool)) w.push(`пазы ${l.width} × ${l.depth} (${l.count} шт.)`) })
    layers.pockets.forEach(l => { if (!has(cnc.ops.pockets?.[pocketKey(l.depth)]?.tool)) w.push(`выемки глубиной ${l.depth} (${l.count} шт.)`) })
    layers.holes.forEach(l => { if (!holeToolFor(l, cnc)) w.push(`отверстия Ø${l.d} × ${l.depth} (${l.count} шт.)`) })
    return w
  }, [layers, cnc])

  // название программы собирается по шаблону постпроцессора (заказ, материал, номер листа… — что выбрал пользователь)
  const nameCtx = n => ({ n, total: mat?.sheets?.length || 0, order, material: mat?.name || order?.material_name || '', thickness: mat?.thickness, client: clientName })
  const baseName = () => programName(post.nameTpl, nameCtx(null))                    // общая часть — для архива, бирок, PDF
  const fileName = si => `${programName(post.nameTpl, nameCtx(si + 1))}.${post.ext || 'nc'}`
  const build = () => {
    if (faults.length) return                              // раскрой с нарушением реза — программы не создаём
    const files = sel.map(si => {
      const sheet = mat.sheets[si], geo = sheetGeo(order, mat.result, sheet)
      const r = buildSheetGcode({ sheet, geo, details: mat.details, thickness: mat.thickness, cnc })
      return { si, name: fileName(si), text: r.text, kinds: r.kinds, opIds: r.opIds, lines: r.lines, warnings: r.warnings, empty: r.empty, zShift: r.zShift, time: parseGcode(r.text, { rapid: num(post.rapid) || 20000, zShift: r.zShift }).time }
    })
    setBuilt({ files }); setSaved('')
    // маркировка: файлы маркировочного стола для тех же листов (на линии сначала бирки, потом раскрой)
    const ok = files.filter(f => !f.empty)
    if (post.labelTable && ok.length) {                  // маркировочный стол включён у постпроцессора (вкладка «Основные»)
      setLabelBusy(true)
      buildLabelFiles({ order, mat, base: baseName(), post, tpl: labelTpl, sheets: ok.map(f => ({ si: f.si, nc: f.name })) })
        .then(labels => setBuilt(b => (b && b.files === files ? { ...b, labels } : b)))
        .catch(() => {})
        .finally(() => setLabelBusy(false))
    }
  }
  // Созданные программы не теряются при выходе из заказа и приложения: запоминаем, какие листы были созданы,
  // и при возвращении создаём их заново теми же настройками (программа однозначно получается из раскроя и настроек).
  const memKey = `cnc:${user?.id || ''}:${id}`
  useEffect(() => {
    if (restored.current || loading || !cncReady) return
    restored.current = true
    let m = null
    try { m = JSON.parse(localStorage.getItem(memKey) || 'null') } catch { m = null }
    if (!m) return
    if (m.matKey) setMatKey(m.matKey)
    if (Array.isArray(m.picked)) setPicked(m.picked)
    if (m.built) setPendingBuild(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, cncReady])
  useEffect(() => {
    if (!pendingBuild || !mat) return
    setPendingBuild(false)
    if (sel.length && sel.every(i => i < mat.sheets.length)) build()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingBuild, mat, picked])
  useEffect(() => {
    if (!restored.current || pendingBuild) return
    try { localStorage.setItem(memKey, JSON.stringify({ matKey, picked, built: !!built })) } catch { /* без памяти */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [built, picked, matKey, pendingBuild])
  const sim = (simSi != null && built?.files.find(f => String(f.si) === simSi && !f.empty)) || null
  const openSim = f => navigate(`?sim=${f.si}`)
  const closeSim = () => navigate(-1)
  const [saved, setSaved] = useState('')
  // пометки на заказе в кабинете производства: «G-код создан» и «файлы сохранены»
  const mark = what => { productionMark(id, what).then(r => { if (r.at) setOrder(o => (o ? { ...o, ...(what === 'gcode' ? { gcode_at: r.at, files_saved_at: null } : { files_saved_at: r.at, gcode_at: o.gcode_at || r.at }) } : o)) }) }
  const savedDone = msg => { setSaved(msg); mark('files') }
  // все файлы — отдельными файлами (не архивом): в выбранную папку, а где браузер этого не умеет — загрузками по одному
  // сохранение нескольких файлов — через вопрос «по отдельности или архивом»; сначала маркировка, потом раскрой
  const [saveAsk, setSaveAsk] = useState(null)      // { files, zipName }
  const [pdfAsk, setPdfAsk] = useState(false)        // открыт конструктор PDF карт раскроя
  const labelFiles = () => (built.labels || []).map(f => ({ name: f.name, data: f.data }))
  const saveAll = () => setSaveAsk({ files: [...labelFiles(), ...built.files.filter(f => !f.empty).map(f => ({ name: f.name, data: f.text }))], zipName: `${baseName()}.zip` })
  const simView = useMemo(() => {
    if (!sim || !mat) return null
    const sheet = mat.sheets[sim.si], geo = sheetGeo(order, mat.result, sheet)
    const ox = num(post.originX), oy = num(post.originY)
    const outlines = sheet.placed.map(p => partFeatures(p, mat.details[p.detailIndex], mat.thickness).outline.map(([x, y]) => [ox + geo.marginL + p.x + x, oy + geo.marginB + p.y + y]))
    return { sheet: { x: ox, y: oy, w: geo.sheetW, l: geo.sheetL }, outlines }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sim])
  // ссылка на симуляцию: снимок программы этого листа, открывается без входа
  const [share, setShare] = useState(null)          // null — окно закрыто; { busy, code, error, copied }
  useEffect(() => { setShare(null) }, [simSi])
  const openShare = async () => {
    setShare({ busy: true })
    const r = await getSimShare(id, sim.name)
    setShare({ code: r.code || '', error: r.error || '' })
  }
  const makeShare = async () => {
    setShare(x => ({ ...x, busy: true, error: '' }))
    const tools = Object.fromEntries((cnc.tools || []).map(x => [num(x.t), num(x.d)]))
    const payload = packSim({ text: sim.text, kinds: sim.kinds, opIds: sim.opIds, sheet: simView?.sheet, outlines: simView?.outlines, thickness: mat.thickness, rapid: num(post.rapid) || 20000, tools, zShift: sim.zShift })
    const r = await saveSimShare(id, sim.name, user.id, payload)
    setShare(x => ({ ...x, busy: false, code: r.code || x.code, error: r.error || '', fresh: !r.error }))
    setLinksTick(t => t + 1)
  }
  const closeShare = async () => {
    if (!window.confirm('Закрыть доступ? Ссылка перестанет открываться.')) return
    const r = await deleteSimShare(share.code)
    setShare(x => (r.error ? { ...x, error: r.error } : { code: '', error: '' }))
    setLinksTick(t => t + 1)
  }
  const copyShare = async () => {
    const url = simShareUrl(share.code)
    try { await navigator.clipboard.writeText(url); setShare(x => ({ ...x, copied: true })) } catch { window.prompt('Скопируйте ссылку', url) }
  }
  const toolDia = useMemo(() => { const m = new Map((cnc.tools || []).map(x => [num(x.t), num(x.d)])); return t => m.get(t) || 0 }, [cnc])

  if (loading) return <div className="page"><CncLoader label="Открываем ЧПУ…" /></div>
  if (!order) return <div className="page"><p>Заказ не найден</p></div>
  const warnings = built ? [...new Set(built.files.flatMap(f => f.warnings))] : []
  const chip = on => ({ flex: '0 0 auto', padding: '7px 12px', borderRadius: 20, border: 'none', fontSize: 13, background: on ? 'var(--blue)' : 'var(--bg)', color: on ? 'white' : 'var(--text-muted)' })
  const small = { padding: '6px 11px', borderRadius: 20, fontSize: 12, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text-muted)', whiteSpace: 'nowrap' }

  return (
    <div className="page" style={{ paddingBottom: 100 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, paddingTop: 4 }}>
        <button onClick={() => navigate(-1)} style={{ background: 'none', border: 'none', color: 'var(--blue)', fontSize: 22, padding: 0 }}>←</button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 500 }}>ЧПУ</div>
          <div style={{ fontSize: 12, color: 'var(--text-hint)' }}><span>{orderTitle(order)}</span>{mat ? ` · ${mat.label}` : ''}</div>
        </div>
        {order && <div style={{ display: 'flex', gap: 4, flex: '0 0 auto' }}>{orderMarks(order).map(m => <span key={m.key} title={m.text} style={{ fontSize: 11, lineHeight: '16px', borderRadius: 9, padding: '0 7px', whiteSpace: 'nowrap', border: `0.5px solid ${m.on ? 'var(--blue)' : 'var(--border-md)'}`, background: m.on ? 'var(--blue)' : 'transparent', color: m.on ? 'white' : 'var(--text-hint)' }}>{m.short}</span>)}</div>}
        <button type="button" onClick={toOrders} style={{ flex: '0 0 auto', padding: '6px 11px', borderRadius: 20, fontSize: 12, border: '0.5px solid var(--blue)', background: 'transparent', color: 'var(--blue)', whiteSpace: 'nowrap' }}>К заказам</button>
      </div>
      <div style={{ display: 'flex', gap: 6, overflowX: 'auto', marginBottom: 12, paddingBottom: 2 }}>
        {TABS.map(([k, l]) => <button key={k} type="button" onClick={() => setTab(k)} style={chip(tab === k)}>{l}{k === 'ops' && pre.length ? ' ⚠' : ''}</button>)}
      </div>

      {tab === 'sheets' && (!mat ? (
        <div className="card"><p style={{ fontSize: 13, color: 'var(--text-muted)' }}>У заказа нет сохранённого раскроя. Откройте раскрой, выберите вариант — и возвращайтесь.</p>
          <button className="btn-primary" style={{ marginTop: 10 }} onClick={() => navigate(`/orders/${id}/nesting`)}>Открыть раскрой</button></div>
      ) : (
        <>
          {mats.length > 1 && (
            <div style={{ marginBottom: 10 }}>
              <label className="label">Материал</label>
              <select value={mat.key} onChange={e => { setMatKey(e.target.value); setPicked(null); setBuilt(null) }}>
                {mats.map(m => <option key={m.key} value={m.key}>{m.label} — листов {m.sheets.length}</option>)}
              </select>
            </div>
          )}
          <div className="card" style={{ marginBottom: 10, padding: '10px 12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--text-muted)' }}>
                <div>Постпроцессор: <b style={{ color: 'var(--text)' }}>{post.name}</b></div>
                <div>Материал: {mat.name || '—'} · {mat.thickness} мм · поле {post.fieldX}×{post.fieldY}</div>
              </div>
              <button type="button" style={small} onClick={() => setTab('basic')}>Настроить</button>
            </div>
          </div>
          <SimLinksBox orderId={id} refresh={linksTick} style={{ marginBottom: 10, padding: '10px 12px' }} />
          {pre.length > 0 && (
            <div className="card" style={{ marginBottom: 10, border: '1px solid var(--amber)', background: 'var(--amber-light)', padding: '10px 12px' }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--amber)', marginBottom: 4 }}>⚠ Не назначен инструмент</div>
              {pre.map(w => <div key={w} style={{ fontSize: 12, color: 'var(--text-muted)' }}>· {w}</div>)}
              <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 4 }}>Программу создать можно — эти операции в неё не попадут.</div>
              <button type="button" style={{ ...small, marginTop: 6 }} onClick={() => setTab((cnc.tools || []).length ? 'ops' : 'tools')}>{(cnc.tools || []).length ? 'Назначить' : 'Создать инструменты'}</button>
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
            <p className="section-title" style={{ marginBottom: 0, flex: 1 }}>Листы ({sel.length} из {mat.sheets.length})</p>
            <button type="button" style={{ ...small, marginRight: 6 }} title="Карты раскроя: листы с деталями, размерами и кромкой; на последней странице — статистика раскроя и стоимость работ (что выводить, выбираете сами)"
              onClick={() => setPdfAsk(true)}>PDF карт</button>
            <button type="button" style={small} onClick={() => { setPicked(sel.length === mat.sheets.length ? [] : null); setBuilt(null) }}>{sel.length === mat.sheets.length ? 'Снять все' : 'Выбрать все'}</button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
            {mat.sheets.map((sh, i) => {
              const g = sheetGeo(order, mat.result, sh), on = sel.includes(i), f = built?.files.find(x => x.si === i)
              return (
                <div key={i} className="card" style={{ padding: '9px 12px', borderColor: on ? 'var(--blue)' : undefined }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                    <input type="checkbox" checked={on} onChange={() => toggle(i)} style={{ width: 20, height: 20, flex: '0 0 auto' }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 500 }}>{sh.stock === 'offcut' ? 'Обрезок' : 'Лист'} {i + 1}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-hint)' }}>{g.sheetL}×{g.sheetW} · деталей {sh.placed.length}</div>
                    </div>
                  </label>
                  {f && (
                    <div style={{ marginTop: 8, paddingTop: 8, borderTop: '0.5px solid var(--border)' }}>
                      <div style={{ fontSize: 12, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.name}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 6 }}>{f.empty ? 'пусто — нет назначенных инструментов' : `${f.lines} строк · ≈ ${fmtTime(f.time)}`}</div>
                      {!f.empty && (
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button type="button" onClick={() => openSim(f)} style={{ ...small, background: 'var(--blue-light)', color: 'var(--blue-dark)', borderColor: 'var(--blue)' }}>▶ Симулятор</button>
                          <button type="button" onClick={() => { download(f.name, f.text); mark('files') }} style={{ ...small, background: 'var(--teal-light)', color: 'var(--teal)', borderColor: 'var(--teal)' }}>⬇ Скачать</button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          {warnings.length > 0 && (
            <div className="card" style={{ marginBottom: 10, border: '1px solid var(--amber)', padding: '10px 12px' }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--amber)', marginBottom: 4 }}>Предупреждения</div>
              {warnings.map(w => <div key={w} style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 2 }}>· {w}</div>)}
            </div>
          )}
          {post.labelTable && (
            <p style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 10 }}>
              🏷 Вместе с G-кодом будут созданы файлы маркировочного стола (бирка {labelTpl.w}×{labelTpl.h} мм).{' '}
              <span style={{ color: 'var(--blue)', cursor: 'pointer' }} onClick={() => navigate(`/orders/${id}/labels`)}>Шаблон бирки</span>
              {' · '}<span style={{ color: 'var(--blue)', cursor: 'pointer' }} onClick={() => setTab('basic')}>отключить</span>
            </p>
          )}
          {faults.length > 0 && (
            <div style={{ padding: 8, marginBottom: 8, borderRadius: 'var(--radius)', background: 'rgba(220,53,69,0.08)', border: '1px solid rgba(220,53,69,0.4)' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#dc3545', marginBottom: 4 }}>⛔ {FAULT_TITLE}</div>
              {faults.slice(0, 10).map((e, i) => <div key={i} style={{ fontSize: 11, color: '#a71d2a', padding: '1px 0' }}>• {e}</div>)}
              <div style={{ fontSize: 11, color: '#a71d2a', marginTop: 5, fontWeight: 500 }}>G-код не создаётся. Откройте раскрой и исправьте раскладку или верните заказ заказчику на доработку.</div>
              <button type="button" className="btn-secondary" style={{ marginTop: 6 }} onClick={() => navigate(`/orders/${id}/nesting`)}>Открыть раскрой</button>
            </div>
          )}
          <button className="btn-primary" disabled={!sel.length || faults.length > 0} onClick={() => { if (faults.length) return; build(); mark('gcode') }}>{built ? '↻ Создать G-код заново' : 'Создать G-код'}</button>
          {labelBusy && <CncLoader compact label="Рисуем бирки…" />}
          {built?.labels?.length > 0 && (
            <div className="card" style={{ marginTop: 8, padding: '9px 12px' }}>
              <div style={{ fontSize: 13, fontWeight: 500 }}>Маркировочный стол</div>
              <div style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 6 }}>
                Файлов: {built.labels.length} — список листов (List), бирки по листам (Label_N.cyc), картинки бирок и листов. На линии сначала идёт маркировка, затем раскрой.
              </div>
              <button type="button" onClick={() => setSaveAsk({ files: labelFiles(), zipName: `Birki_${baseName()}.zip` })} style={{ ...small, background: 'var(--teal-light)', color: 'var(--teal)', borderColor: 'var(--teal)' }}>⬇ Сохранить файлы маркировки</button>
            </div>
          )}
          {built && (built.files.filter(f => !f.empty).length > 1 || built.labels?.length > 0) && (
            <button className="btn-secondary" style={{ marginTop: 8 }} onClick={saveAll}>⬇ Сохранить все файлы ({built.files.filter(f => !f.empty).length + (built.labels?.length || 0)})</button>
          )}
          {saved && built && <p style={{ fontSize: 12, color: 'var(--teal)', marginTop: 6, textAlign: 'center' }}>{saved}</p>}
          {saved && built && <button type="button" className="btn-secondary" style={{ marginTop: 8 }} onClick={toOrders}>← Перейти к заказам</button>}
        </>
      ))}
      {tab === 'ops' && <CncOps cnc={cnc} onChange={change} layers={layers} />}
      {tab === 'tools' && <CncTools cnc={cnc} onChange={change} />}
      {tab === 'basic' && <CncBasic cnc={cnc} onChange={change} isMaster={isMaster} />}
      {tab === 'cmd' && <CncCommands cnc={cnc} onChange={change} isMaster={isMaster} />}

      {sim && (
        <div style={{ position: 'fixed', inset: 0, background: 'var(--bg)', zIndex: 200, padding: 10, boxSizing: 'border-box', height: '100dvh' }}>
          <div style={{ maxWidth: 1100, margin: '0 auto', height: '100%' }}>
            <Suspense fallback={<CncLoader label="Запускаем симулятор…" />}>
              <GcodeSimulator key={sim.name} text={sim.text} kinds={sim.kinds} opIds={sim.opIds} title={sim.name} thickness={mat.thickness} rapid={num(post.rapid) || 20000} zShift={sim.zShift}
                toolDia={toolDia} onClose={closeSim} onDownload={() => { download(sim.name, sim.text); mark('files') }} onShare={openShare} sheet={simView?.sheet} outlines={simView?.outlines} />
            </Suspense>
          </div>
        </div>
      )}
      {sim && share && (
        <div onClick={() => setShare(null)} style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
          <div onClick={e => e.stopPropagation()} className="card" style={{ width: '100%', maxWidth: 480, borderRadius: '16px 16px 0 0', paddingBottom: 'calc(16px + env(safe-area-inset-bottom))' }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
              <div style={{ flex: 1, fontWeight: 500 }}>Ссылка на симуляцию</div>
              <button type="button" onClick={() => setShare(null)} style={{ background: 'none', border: 'none', fontSize: 22, color: 'var(--text-muted)', padding: 0 }}>×</button>
            </div>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>По ссылке симуляция этого листа открывается без входа в приложение — только просмотр. Ссылка хранит снимок программы: после изменения настроек или раскроя обновите её.</p>
            {share.error && <p className="error-text" style={{ marginBottom: 8 }}>{share.error}</p>}
            {share.busy && !share.code ? <p style={{ fontSize: 13, color: 'var(--text-hint)' }}>Подождите…</p> : share.code ? (
              <>
                <input readOnly value={simShareUrl(share.code)} onFocus={e => e.target.select()} style={{ fontSize: 13, marginBottom: 8 }} />
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button type="button" className="btn-primary" style={{ flex: 1, padding: 10, fontSize: 14 }} onClick={copyShare}>{share.copied ? '✓ Скопировано' : 'Копировать'}</button>
                  {navigator.share && <button type="button" className="btn-secondary" style={{ flex: 1, padding: 10, fontSize: 14 }} onClick={() => navigator.share({ title: sim.name, url: simShareUrl(share.code) }).catch(() => {})}>Поделиться</button>}
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                  <button type="button" className="btn-secondary" style={{ flex: 1, padding: 9, fontSize: 13 }} disabled={share.busy} onClick={makeShare}>{share.busy ? 'Обновление…' : share.fresh ? '✓ Снимок обновлён' : '↻ Обновить снимок'}</button>
                  <button type="button" onClick={closeShare} style={{ flex: 1, padding: 9, fontSize: 13, background: 'transparent', border: '1px solid var(--danger)', color: 'var(--danger)', borderRadius: 'var(--radius)' }}>Закрыть доступ</button>
                </div>
              </>
            ) : (
              <button type="button" className="btn-primary" disabled={share.busy} onClick={makeShare}>{share.busy ? 'Создание…' : '🔗 Создать ссылку'}</button>
            )}
          </div>
        </div>
      )}
      {pdfAsk && mat && <PdfSetup order={order} mat={mat} method={order?.cutting_method || 'nesting'} fileName={`Karty_${baseName()}.pdf`} onClose={() => setPdfAsk(false)} />}
      {saveAsk && <SaveFilesDialog files={saveAsk.files} zipName={saveAsk.zipName} onClose={() => setSaveAsk(null)} onDone={savedDone}
        folders={[folderName(post.folderTpl, nameCtx(null)), safeName(mat?.name || order?.material_name).slice(0, 40) || 'material']} />}
      <BottomNav />
    </div>
  )
}
