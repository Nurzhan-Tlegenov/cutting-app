// Линейный раскрой (бета: мастер-аккаунт и бета-тестеры «Линейный раскрой»).
// Погонные материалы — профиль, труба, карниз, плинтус, брус: отрезки раскладываются по хлыстам.
// Хлысты бывают разной длины (2000, 3000, 6000…) и в ограниченном количестве (остатки) — приложение само подбирает,
// какие хлысты брать, чтобы отходов было меньше. Пропил и торцовка учитываются. Результат — карты хлыстов и PDF.
// Задания хранятся в настройках пользователя (linearJobs); из конструктора отрезки профиля приходят сюда кнопкой.
import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { MenuButton } from '../components/NavDrawer'
import BottomNav from '../components/BottomNav'
import Hint from '../components/Hint'
import CncLoader from '../components/CncLoader'
import { useDesktop } from '../hooks/useDesktop'
import { hasBeta } from '../lib/beta'
import { LINEAR_FEATURE, nid, newLinearJob, readJobs, writeJobs } from '../lib/linearJobs'
import { linearCut, groupBars } from '../lib/linearNest'
import { shareLinearPdf } from '../lib/linearPdf'

const num = v => { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : null }
const fmt = v => (Math.round(v * 10) / 10).toLocaleString('ru-RU')
const inp = { width: '100%', padding: '7px 8px', fontSize: 14, border: '0.5px solid var(--border-md)', borderRadius: 8, background: 'var(--bg)', color: 'var(--text)', boxSizing: 'border-box' }
const lbl = { fontSize: 11.5, color: 'var(--text-muted)', display: 'block', marginBottom: 2 }
const sect = { fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.3, margin: '12px 0 6px' }
const btnS = main => ({ padding: '8px 12px', borderRadius: 10, fontSize: 13.5, cursor: 'pointer', border: main ? 'none' : '0.5px solid var(--border-md)', background: main ? 'var(--blue)' : 'var(--bg)', color: main ? 'white' : 'var(--text)', whiteSpace: 'nowrap' })
const xBtn = { border: 'none', background: 'none', color: 'var(--danger)', fontSize: 16, cursor: 'pointer', padding: '0 4px' }

// строки «1200 4 Стойка» / «1200x4» / «1200;4;Стойка» -> отрезки
function parsePaste(text) {
  const out = []
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+(?:[.,]\d+)?)(.*)$/)
    if (!m) continue
    const len = num(m[1]); if (!(len > 0)) continue
    let rest = m[2], qty = 1
    const q = rest.match(/^\s*[x×*;,\t ]?\s*(\d+)(?=$|[\s;,\t])(.*)$/i)
    if (q) { qty = Number(q[1]); rest = q[2] }
    out.push({ id: nid(), len, qty, name: rest.replace(/^[\s;,\t]+/, '').trim() })
  }
  return out
}

function BarView({ g, maxLen, trim, kerf }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}>
        <b>{g.count > 1 ? `${g.count} × ` : ''}хлыст {g.stock}</b><span style={{ color: 'var(--text-muted)' }}>остаток {fmt(g.rest)} мм</span>
      </div>
      <div style={{ position: 'relative', display: 'flex', height: 22, width: `${(g.stock / maxLen) * 100}%`, borderRadius: 3, overflow: 'hidden', background: 'var(--bg2)', border: '1px solid var(--border-md)', paddingLeft: `${(trim / g.stock) * 100}%`, boxSizing: 'border-box' }}>
        {g.cuts.map((c, j) => <div key={j} title={`${c.len} мм ${c.name || ''}`} style={{ flex: `0 0 ${(c.len / g.stock) * 100}%`, marginRight: `${(kerf / g.stock) * 100}%`, background: j % 2 ? '#9fb3c8' : '#b8c8d8', fontSize: 10.5, color: '#123', overflow: 'hidden', textAlign: 'center', lineHeight: '22px', whiteSpace: 'nowrap' }}>{c.len}</div>)}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{g.cuts.map(c => c.name ? `${c.len} ${c.name}` : c.len).join(' + ')}</div>
    </div>
  )
}

export default function LinearCutPage() {
  const { user, isMaster } = useAuth()
  const navigate = useNavigate()
  const { search } = useLocation()
  const jid = new URLSearchParams(search).get('job')
  const desk = useDesktop()
  const [allowed, setAllowed] = useState(isMaster ? true : null)
  const [jobs, setJobs] = useState(() => readJobs(user))
  const [paste, setPaste] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => { if (isMaster) return; let a = true; hasBeta(LINEAR_FEATURE).then(v => { if (a) setAllowed(v) }); return () => { a = false } }, [isMaster])
  const job = jobs.find(j => j.id === jid) || null
  const save = next => { setJobs(next); writeJobs(next, user) }
  const setJob = j => save(jobs.map(x => (x.id === j.id ? { ...j, updated: new Date().toISOString() } : x)))

  const res = useMemo(() => (job ? linearCut({
    pieces: job.pieces.map(p => ({ len: num(p.len), qty: num(p.qty) ?? 1, name: p.name })),
    stocks: job.stocks.map(s => ({ len: num(s.len), qty: s.qty === '' || s.qty == null ? null : num(s.qty) })),
    kerf: num(job.kerf) ?? 0, trim: num(job.trim) ?? 0,
  }) : null), [job])
  const groups = useMemo(() => (res ? groupBars(res.bars) : []), [res])

  if (allowed === null) return <div className="page"><CncLoader label="Открываем…" /></div>
  if (!allowed) return (
    <div className="page"><div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 10 }}><MenuButton /><h1 style={{ fontSize: 18, fontWeight: 500 }}>Линейный раскрой</h1></div>
      <p style={{ fontSize: 14, color: 'var(--text-muted)' }}>Линейный раскрой сейчас в бета-тесте. Доступ выдаёт мастер-аккаунт.</p><BottomNav /></div>
  )

  if (!job) return (
    <div className="page" style={{ paddingBottom: 100 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 10, paddingTop: 4 }}>
        <MenuButton /><h1 style={{ fontSize: 18, fontWeight: 500, flex: 1 }}>Линейный раскрой <span style={{ fontSize: 11, color: 'var(--amber)', fontWeight: 600 }}>β</span></h1>
      </div>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 10 }}>Профиль, труба, карниз, плинтус, брус: отрезки раскладываются по хлыстам любой длины — 2, 3, 6 м и свои остатки.</p>
      <button type="button" className="btn-primary" style={{ marginBottom: 12 }} onClick={() => { const j = newLinearJob(); save([j, ...jobs]); navigate(`/linear?job=${j.id}`) }}>+ Новый раскрой</button>
      {jobs.map(j => (
        <div key={j.id} className="card" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', marginBottom: 6, cursor: 'pointer' }} onClick={() => navigate(`/linear?job=${j.id}`)}>
          <span style={{ flex: 1, minWidth: 0, fontSize: 14.5 }}>{j.name}{j.material ? <span style={{ color: 'var(--text-muted)', fontSize: 12.5 }}> · {j.material}</span> : null}</span>
          <span style={{ fontSize: 11.5, color: 'var(--text-hint)' }}>{j.updated ? new Date(j.updated).toLocaleDateString('ru-RU') : ''}</span>
          <button type="button" style={xBtn} onClick={e => { e.stopPropagation(); if (window.confirm(`Удалить «${j.name}»?`)) save(jobs.filter(x => x.id !== j.id)) }}>🗑</button>
        </div>
      ))}
      {!jobs.length && <p style={{ fontSize: 13, color: 'var(--text-hint)' }}>Пока нет ни одного раскроя.</p>}
      <BottomNav />
    </div>
  )

  const up = patch => setJob({ ...job, ...patch })
  const setStock = (i, patch) => up({ stocks: job.stocks.map((s, k) => (k === i ? { ...s, ...patch } : s)) })
  const setPiece = (id, patch) => up({ pieces: job.pieces.map(p => (p.id === id ? { ...p, ...patch } : p)) })
  const total = job.pieces.reduce((a, p) => a + (num(p.qty) || 0), 0)
  const maxLen = Math.max(1, ...(res?.bars || []).map(b => b.stock))

  const inputs = (<>
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
      <label><span style={lbl}>Название</span><input style={inp} value={job.name} onChange={e => up({ name: e.target.value })} /></label>
      <label><span style={lbl}>Материал</span><input style={inp} value={job.material} placeholder="Профиль 20×20" onChange={e => up({ material: e.target.value })} /></label>
    </div>
    <div style={sect}>Хлысты<Hint inline>Длины хлыстов, которые можно купить или взять со склада. Количество пусто — сколько понадобится; цифра — только столько (например, остатки). Приложение само выберет, какие хлысты брать, чтобы отходов было меньше.</Hint></div>
    {job.stocks.map((s, i) => (
      <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 6, marginBottom: 5, alignItems: 'end' }}>
        <label><span style={lbl}>Длина, мм</span><input style={inp} inputMode="decimal" value={s.len} onChange={e => setStock(i, { len: e.target.value })} /></label>
        <label><span style={lbl}>Есть, шт</span><input style={inp} inputMode="numeric" value={s.qty ?? ''} placeholder="сколько нужно" onChange={e => setStock(i, { qty: e.target.value })} /></label>
        <button type="button" style={xBtn} onClick={() => up({ stocks: job.stocks.filter((_, k) => k !== i) })}>✕</button>
      </div>
    ))}
    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 6 }}>
      {[2000, 3000, 6000].map(l => <button key={l} type="button" style={{ ...btnS(), padding: '5px 10px', fontSize: 12.5 }} onClick={() => up({ stocks: [...job.stocks, { len: l, qty: '' }] })}>+ {l}</button>)}
      <button type="button" style={{ ...btnS(), padding: '5px 10px', fontSize: 12.5 }} onClick={() => up({ stocks: [...job.stocks, { len: '', qty: '' }] })}>+ своя длина</button>
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
      <label><span style={lbl}>Пропил, мм</span><input style={inp} inputMode="decimal" value={job.kerf} onChange={e => up({ kerf: e.target.value })} /></label>
      <label><span style={lbl}>Торцовка с конца, мм<Hint inline>Сколько отрезать с каждого конца хлыста, чтобы получить ровный торец (кривой заводской торец, заусенец).</Hint></span><input style={inp} inputMode="decimal" value={job.trim} onChange={e => up({ trim: e.target.value })} /></label>
    </div>
    <div style={sect}>Отрезки · {total} шт</div>
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.4fr) minmax(0,1fr) 64px auto', gap: 5, fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 3 }}><span>Название</span><span>Длина, мм</span><span>Шт</span><span /></div>
    {job.pieces.map(p => (
      <div key={p.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.4fr) minmax(0,1fr) 64px auto', gap: 5, marginBottom: 4 }}>
        <input style={inp} value={p.name} placeholder="Стойка" onChange={e => setPiece(p.id, { name: e.target.value })} />
        <input style={inp} inputMode="decimal" value={p.len} onChange={e => setPiece(p.id, { len: e.target.value })} />
        <input style={inp} inputMode="numeric" value={p.qty} onChange={e => setPiece(p.id, { qty: e.target.value })} />
        <button type="button" style={xBtn} onClick={() => up({ pieces: job.pieces.filter(x => x.id !== p.id) })}>✕</button>
      </div>
    ))}
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
      <button type="button" style={btnS()} onClick={() => up({ pieces: [...job.pieces, { id: nid(), name: '', len: '', qty: 1 }] })}>+ Отрезок</button>
      <button type="button" style={btnS()} onClick={() => setPaste(paste == null ? '' : null)}>Вставить списком</button>
    </div>
    {paste != null && <div style={{ marginTop: 6 }}>
      <textarea style={{ ...inp, minHeight: 90, fontFamily: 'inherit' }} value={paste} placeholder={'1200 4 Стойка\n850 8 Перемычка'} onChange={e => setPaste(e.target.value)} />
      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        <button type="button" style={btnS(true)} onClick={() => { const add = parsePaste(paste); if (add.length) up({ pieces: [...job.pieces.filter(p => num(p.len) > 0), ...add] }); setPaste(null) }}>Добавить</button>
        <span style={{ fontSize: 11.5, color: 'var(--text-hint)', alignSelf: 'center' }}>строка: длина, количество, название (из Excel — копировать столбцы)</span>
      </div>
    </div>}
  </>)

  const result = res && (<>
    <div className="card" style={{ padding: '10px 12px', marginBottom: 10 }}>
      <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 2 }}>Хлысты: {res.byStock.map(b => `${b.len} × ${b.count}`).join(', ') || '—'}</div>
      <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Закупить {fmt(res.total / 1000)} м · в отрезках {fmt(res.cutLen / 1000)} м · отход {fmt(res.waste)}%</div>
      {res.unplaced.length > 0 && <p className="error-text" style={{ fontSize: 12.5, marginTop: 4 }}>Не разложены: {res.unplaced.map(u => `${u.len}${u.name ? ' ' + u.name : ''} × ${u.qty}`).join(', ')} — длиннее хлыста или хлысты кончились</p>}
      <button type="button" style={{ ...btnS(true), marginTop: 8 }} disabled={busy || !res.bars.length}
        onClick={async () => { setBusy(true); try { await shareLinearPdf(job, res) } finally { setBusy(false) } }}>{busy ? 'Готовлю…' : 'PDF'}</button>
    </div>
    {groups.map((g, i) => <BarView key={i} g={g} maxLen={maxLen} trim={num(job.trim) || 0} kerf={num(job.kerf) || 0} />)}
  </>)

  const head = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, paddingTop: 4 }}>
      <MenuButton />
      <button type="button" onClick={() => navigate('/linear')} style={{ border: 'none', background: 'none', color: 'var(--blue)', fontSize: 13, cursor: 'pointer', padding: 0 }}>‹ Все раскрои</button>
      <h1 style={{ fontSize: 16, fontWeight: 500, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{job.name}</h1>
    </div>
  )
  if (desk) return (
    <div style={{ padding: '6px 14px 90px' }}>
      {head}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(360px, 460px) 1fr', gap: 18, alignItems: 'start' }}>
        <div>{inputs}</div><div>{result}</div>
      </div>
      <BottomNav />
    </div>
  )
  return (
    <div className="page" style={{ paddingBottom: 100 }}>
      {head}{inputs}
      <div style={sect}>Раскрой</div>
      {result}
      <BottomNav />
    </div>
  )
}
