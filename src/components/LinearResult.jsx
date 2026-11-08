// Результат линейного раскроя: сводка (хлысты, метраж, отход), PDF карт хлыстов, бирки на отрезки, карты хлыстов.
// Используется на странице «Линейный раскрой» и в заказе (блок «Погонные материалы»).
import { useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { groupBars } from '../lib/linearNest'
import { computeJob } from '../lib/linearJobs'
import { shareLinearPdf, shareLinearLabels } from '../lib/linearPdf'
import { getUserSettings, saveUserSettings } from '../lib/userSettings'

const num = v => { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : null }
const fmt = v => (Math.round(v * 10) / 10).toLocaleString('ru-RU')
const btnS = main => ({ padding: '7px 11px', borderRadius: 10, fontSize: 13, cursor: 'pointer', border: main ? 'none' : '0.5px solid var(--border-md)', background: main ? 'var(--blue)' : 'var(--bg)', color: main ? 'white' : 'var(--text)', whiteSpace: 'nowrap' })
const small = { width: 52, padding: '5px 6px', fontSize: 13, border: '0.5px solid var(--border-md)', borderRadius: 8, background: 'var(--bg)', color: 'var(--text)' }

export function BarView({ g, maxLen, trim, kerf }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}>
        <b>{g.count > 1 ? `${g.count} × ` : ''}хлыст {g.stock}</b><span style={{ color: 'var(--text-muted)' }}>остаток {fmt(g.rest)} мм</span>
      </div>
      <div style={{ display: 'flex', height: 22, width: `${(g.stock / maxLen) * 100}%`, borderRadius: 3, overflow: 'hidden', background: 'var(--bg2)', border: '1px solid var(--border-md)', paddingLeft: `${(trim / g.stock) * 100}%`, boxSizing: 'border-box' }}>
        {g.cuts.map((c, j) => <div key={j} title={`${c.len} мм ${c.name || ''}`} style={{ flex: `0 0 ${(c.len / g.stock) * 100}%`, marginRight: `${(kerf / g.stock) * 100}%`, background: j % 2 ? '#9fb3c8' : '#b8c8d8', fontSize: 10.5, color: '#123', overflow: 'hidden', textAlign: 'center', lineHeight: '22px', whiteSpace: 'nowrap', clipPath: c.angles ? (c.angles.includes('/') ? 'polygon(6px 0, calc(100% - 6px) 0, 100% 100%, 0 100%)' : 'polygon(6px 0, 100% 0, 100% 100%, 0 100%)') : undefined }}>{c.len}</div>)}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{g.cuts.map(c => [c.len, c.angles ? `∠${c.angles}` : '', c.name].filter(Boolean).join(' ')).join(' + ')}</div>
    </div>
  )
}

export default function LinearResult({ job, res: given, compact = false }) {
  const { user } = useAuth()
  const res = useMemo(() => given || computeJob(job), [given, job])
  const groups = useMemo(() => groupBars(res.bars), [res])
  const [busy, setBusy] = useState('')
  const [open, setOpen] = useState(!compact)
  const [size, setSize] = useState(() => { try { return getUserSettings(user)?.linearLabelSize || { w: 58, h: 40 } } catch { return { w: 58, h: 40 } } })
  const setSz = patch => { const n = { ...size, ...patch }; setSize(n); saveUserSettings({ linearLabelSize: n }, user) }
  const maxLen = Math.max(1, ...res.bars.map(b => b.stock))
  const run = async (k, fn) => { setBusy(k); try { await fn() } catch (e) { window.alert(e.message) } finally { setBusy('') } }
  return (<>
    <div className="card" style={{ padding: '10px 12px', marginBottom: 8 }}>
      <div style={{ fontSize: 14.5, fontWeight: 600, marginBottom: 2 }}>{compact && job.material ? `${job.material}: ` : ''}хлысты {res.byStock.map(b => `${b.len} × ${b.count}`).join(', ') || '—'}</div>
      <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Закупить {fmt(res.total / 1000)} м · в отрезках {fmt(res.cutLen / 1000)} м · отход {fmt(res.waste)}% · пропил {job.kerf ?? 0}{Number(job.trim) ? ` · торцовка ${job.trim}` : ''}</div>
      {res.unplaced.length > 0 && <p className="error-text" style={{ fontSize: 12.5, marginTop: 4 }}>Не разложены: {res.unplaced.map(u => `${u.len}${u.name ? ' ' + u.name : ''} × ${u.qty}`).join(', ')} — длиннее хлыста или хлысты кончились</p>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginTop: 8 }}>
        <button type="button" style={btnS(true)} disabled={!!busy || !res.bars.length} onClick={() => run('pdf', () => shareLinearPdf(job, res))}>{busy === 'pdf' ? 'Готовлю…' : 'PDF карт'}</button>
        <button type="button" style={btnS()} disabled={!!busy || !res.bars.length} onClick={() => run('lab', () => shareLinearLabels(job, res, size))}>{busy === 'lab' ? 'Готовлю…' : 'Бирки на отрезки'}</button>
        <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>бирка</span>
        <input style={small} inputMode="numeric" value={size.w} onChange={e => setSz({ w: num(e.target.value) || 58 })} />×<input style={small} inputMode="numeric" value={size.h} onChange={e => setSz({ h: num(e.target.value) || 40 })} /><span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>мм</span>
        {compact && <button type="button" style={{ ...btnS(), border: 'none', color: 'var(--blue)', background: 'none' }} onClick={() => setOpen(v => !v)}>{open ? 'скрыть хлысты' : 'показать хлысты'}</button>}
      </div>
    </div>
    {open && groups.map((g, i) => <BarView key={i} g={g} maxLen={maxLen} trim={num(job.trim) || 0} kerf={num(job.kerf) || 0} />)}
  </>)
}

/** Блок заказа «Погонные материалы»: order.linear — [задание линейного раскроя] (из конструктора или прикреплено) */
export function OrderLinear({ order }) {
  const jobs = Array.isArray(order?.linear) ? order.linear : []
  if (!jobs.length) return null
  return (
    <details style={{ margin: '10px 0' }} open>
      <summary style={{ fontSize: 14, fontWeight: 600, cursor: 'pointer', marginBottom: 6 }}>Погонные материалы (линейный раскрой) · {jobs.length}</summary>
      {jobs.map((j, i) => <LinearResult key={i} job={j} compact />)}
    </details>
  )
}
