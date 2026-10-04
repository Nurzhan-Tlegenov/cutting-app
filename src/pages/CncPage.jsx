import { useEffect, useMemo, useState, lazy, Suspense } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import BottomNav from '../components/BottomNav'
import { CncBasic, CncCommands, CncTools, CncOps } from '../components/CncSettings'
import { savedNestings, sheetGeo } from '../lib/savedNesting'
import { getCnc, fetchCnc, saveCnc, activePost } from '../lib/cncSettings'
import { buildSheetGcode, collectLayers, partFeatures, holeToolFor, pocketKey } from '../lib/gcode'
import { parseGcode, fmtTime } from '../lib/gcodeSim'

// ЧПУ: листы принятого раскроя → управляющая программа (G-код) + симулятор.
// Настройки (постпроцессор, инструменты, обработка контуров, команды) идут за аккаунтом.
const GcodeSimulator = lazy(() => import('../components/GcodeSimulator'))   // 3D — подгружается при открытии
const TABS = [['sheets', 'Листы'], ['ops', 'Обработка'], ['tools', 'Инструменты'], ['basic', 'Основные'], ['cmd', 'Команды']]
const num = v => { const x = Number(String(v ?? '').replace(',', '.')); return isFinite(x) ? x : 0 }
const safeName = s => String(s || '').replace(/[^\wа-яё.-]+/gi, '_').replace(/^_+|_+$/g, '')

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
  const { user } = useAuth()
  const [order, setOrder] = useState(null)
  const [details, setDetails] = useState([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('sheets')
  const [matKey, setMatKey] = useState('')
  const [picked, setPicked] = useState(null)        // выбранные листы (индексы); null — все
  const [cnc, setCnc] = useState(() => getCnc(user))
  const [built, setBuilt] = useState(null)          // { for: cnc, files: [{ si, name, text, lines, time, warnings, empty }] }
  const [sim, setSim] = useState(null)              // файл в симуляторе

  useEffect(() => {
    let alive = true
    ;(async () => {
      const { data: o } = await supabase.from('orders').select('*').eq('id', id).single()
      const { data: d } = await supabase.from('order_details').select('*').eq('order_id', id).order('sort_order')
      if (!alive) return
      setOrder(o || null); setDetails(d || []); setLoading(false)
    })()
    fetchCnc(user).then(c => { if (alive) setCnc(c) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, user?.id])

  const mats = useMemo(() => savedNestings(order, details), [order, details])
  const mat = mats.find(m => m.key === matKey) || mats[0] || null
  const layers = useMemo(() => (mat ? collectLayers(mat.sheets, mat.details, mat.thickness) : null), [mat])
  const post = activePost(cnc)
  const change = next => { setCnc(next); saveCnc(next, user); setBuilt(null) }
  const sel = mat ? (picked ?? mat.sheets.map((_, i) => i)) : []
  const toggle = i => { setPicked(sel.includes(i) ? sel.filter(x => x !== i) : [...sel, i].sort((a, b) => a - b)); setBuilt(null) }

  // что не назначено — видно сразу, до создания программы
  const pre = useMemo(() => {
    if (!layers) return []
    const w = [], has = t => (cnc.tools || []).some(x => x.id === t)
    if (!has(cnc.ops.outer.tool)) w.push('контур детали')
    if (layers.cutouts && !has(cnc.ops.cutout.tool)) w.push(`контур выреза (${layers.cutouts} шт.)`)
    if (layers.grooves && !has(cnc.ops.groove.tool)) w.push(`пазы (${layers.grooves} шт.)`)
    layers.pockets.forEach(l => { if (!has(cnc.ops.pockets?.[pocketKey(l.depth)]?.tool)) w.push(`выемки глубиной ${l.depth} (${l.count} шт.)`) })
    layers.holes.forEach(l => { if (!holeToolFor(l, cnc)) w.push(`отверстия Ø${l.d} × ${l.depth} (${l.count} шт.)`) })
    return w
  }, [layers, cnc])

  const fileName = si => `${si + 1}_${safeName(order.order_number)}${mats.length > 1 ? '_' + safeName(mat.name).slice(0, 24) : ''}.${post.ext || 'nc'}`
  const build = () => {
    const files = sel.map(si => {
      const sheet = mat.sheets[si], geo = sheetGeo(order, mat.result, sheet)
      const r = buildSheetGcode({ sheet, geo, details: mat.details, thickness: mat.thickness, cnc })
      return { si, name: fileName(si), text: r.text, kinds: r.kinds, opIds: r.opIds, lines: r.lines, warnings: r.warnings, empty: r.empty, time: parseGcode(r.text, { rapid: num(post.rapid) || 20000 }).time }
    })
    setBuilt({ files }); setSaved('')
  }
  const [saved, setSaved] = useState('')
  // все файлы — отдельными файлами (не архивом): в выбранную папку, а где браузер этого не умеет — загрузками по одному
  const saveAll = async () => {
    const files = built.files.filter(f => !f.empty)
    if (files.length > 1 && window.showDirectoryPicker) {
      try {
        const dir = await window.showDirectoryPicker({ mode: 'readwrite' })
        for (const f of files) { const h = await dir.getFileHandle(f.name, { create: true }); const w = await h.createWritable(); await w.write(f.text); await w.close() }
        setSaved(`Сохранено файлов: ${files.length} — в папку «${dir.name}»`)
        return
      } catch (e) { if (e?.name === 'AbortError') return }
    }
    for (const f of files) { download(f.name, f.text); await new Promise(r => setTimeout(r, 400)) }
    setSaved(`Отправлено на сохранение файлов: ${files.length}`)
  }
  const simView = useMemo(() => {
    if (!sim || !mat) return null
    const sheet = mat.sheets[sim.si], geo = sheetGeo(order, mat.result, sheet)
    const ox = num(post.originX), oy = num(post.originY)
    const outlines = sheet.placed.map(p => partFeatures(p, mat.details[p.detailIndex], mat.thickness).outline.map(([x, y]) => [ox + geo.marginL + p.x + x, oy + geo.marginB + p.y + y]))
    return { sheet: { x: ox, y: oy, w: geo.sheetW, l: geo.sheetL }, outlines }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sim])
  const toolDia = useMemo(() => { const m = new Map((cnc.tools || []).map(x => [num(x.t), num(x.d)])); return t => m.get(t) || 0 }, [cnc])

  if (loading) return <div className="page"><p style={{ color: 'var(--text-hint)', paddingTop: 40 }}>Загрузка...</p></div>
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
          <div style={{ fontSize: 12, color: 'var(--text-hint)' }}><span style={{ fontFamily: 'monospace' }}>{order.order_number}</span>{mat ? ` · ${mat.label}` : ''}</div>
        </div>
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
                          <button type="button" onClick={() => setSim(f)} style={{ ...small, background: 'var(--blue-light)', color: 'var(--blue-dark)', borderColor: 'var(--blue)' }}>▶ Симулятор</button>
                          <button type="button" onClick={() => download(f.name, f.text)} style={{ ...small, background: 'var(--teal-light)', color: 'var(--teal)', borderColor: 'var(--teal)' }}>⬇ Скачать</button>
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
          <button className="btn-primary" disabled={!sel.length} onClick={build}>{built ? '↻ Создать G-код заново' : 'Создать G-код'}</button>
          {built && built.files.filter(f => !f.empty).length > 1 && (
            <button className="btn-secondary" style={{ marginTop: 8 }} onClick={saveAll}>⬇ Сохранить все файлы ({built.files.filter(f => !f.empty).length})</button>
          )}
          {saved && built && <p style={{ fontSize: 12, color: 'var(--teal)', marginTop: 6, textAlign: 'center' }}>{saved}</p>}
        </>
      ))}
      {tab === 'ops' && <CncOps cnc={cnc} onChange={change} layers={layers} />}
      {tab === 'tools' && <CncTools cnc={cnc} onChange={change} />}
      {tab === 'basic' && <CncBasic cnc={cnc} onChange={change} />}
      {tab === 'cmd' && <CncCommands cnc={cnc} onChange={change} />}

      {sim && (
        <div style={{ position: 'fixed', inset: 0, background: 'var(--bg)', zIndex: 200, padding: 10, boxSizing: 'border-box', height: '100dvh' }}>
          <div style={{ maxWidth: 1100, margin: '0 auto', height: '100%' }}>
            <Suspense fallback={<p style={{ color: 'var(--text-hint)', padding: 20 }}>Загрузка симулятора…</p>}>
              <GcodeSimulator key={sim.name} text={sim.text} kinds={sim.kinds} opIds={sim.opIds} title={sim.name} thickness={mat.thickness} rapid={num(post.rapid) || 20000}
                toolDia={toolDia} onClose={() => setSim(null)} onDownload={() => download(sim.name, sim.text)} sheet={simView?.sheet} outlines={simView?.outlines} />
            </Suspense>
          </div>
        </div>
      )}
      <BottomNav />
    </div>
  )
}
