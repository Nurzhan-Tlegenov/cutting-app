import { useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { getLabelTpl } from '../lib/labelMaker'
import { orderTitle } from '../lib/orderUtils'
import { ruleOf, ruleText, stageParts, loadOrderParts, codeMatcher, stageScan, stageScans } from '../lib/stageParts'
import { stageDone } from '../lib/posts'
import QrCamera from './QrCamera'
import CncLoader from './CncLoader'

// Детали заказа на рабочем посту: список по правилу поста и отметка сканированием бирок (камера телефона или
// сканер-пистолет — он печатает код как клавиатура) или вручную. Видно, какие детали ещё не прошли пост.
// stage — { stage_id, post_name, rule, status }, orderId; onClose(changed) — закрыть; «Выполнено» — с проверкой пропущенных.
const beep = ok => { try { navigator.vibrate?.(ok ? 60 : [80, 60, 80]) } catch { /* без вибрации */ } }

export default function StageParts({ stage, orderId, onClose }) {
  const { user } = useAuth() || {}
  const rule = ruleOf(stage.rule, stage.post_name)
  const [data, setData] = useState(null)       // { order, rows }
  const [scans, setScans] = useState(() => new Map())
  const [cam, setCam] = useState(false)
  const [code, setCode] = useState('')
  const [msg, setMsg] = useState(null)          // { ok, text }
  const [show, setShow] = useState('left')      // left — не отмечены, all
  const [busy, setBusy] = useState(false)
  const [changed, setChanged] = useState(false)
  const inputRef = useRef(null)
  useEffect(() => {
    let alive = true
    Promise.all([loadOrderParts(orderId), stageScans(stage.stage_id)]).then(([d, s]) => { if (alive) { setData(d); setScans(s) } })
    return () => { alive = false }
  }, [orderId, stage.stage_id])
  const parts = useMemo(() => (data?.order ? stageParts(data.order, data.rows, rule) : []), [data])   // eslint-disable-line react-hooks/exhaustive-deps
  const match = useMemo(() => (data?.order ? codeMatcher(data.order, data.rows, getLabelTpl(user)) : () => null), [data, user])
  const total = parts.reduce((a, p) => a + p.qty, 0)
  const done = parts.reduce((a, p) => a + Math.min(p.qty, scans.get(p.id) || 0), 0)
  const left = total - done

  const setN = async (p, n) => {
    const v = Math.max(0, Math.min(p.qty, n))
    const prev = scans.get(p.id) || 0
    setScans(m => new Map(m).set(p.id, v)); setChanged(true)
    const { error } = await stageScan(stage.stage_id, p.id, v)
    if (error) { setScans(m => new Map(m).set(p.id, prev)); setMsg({ ok: false, text: /not active/.test(error.message) ? 'Пост уже закрыт.' : error.message }); return false }
    return true
  }
  const onScan = async text => {
    const id = match(text)
    const p = id && parts.find(x => x.id === id)
    if (!id) { beep(false); setMsg({ ok: false, text: `Не найдено в этом заказе: ${text}` }); return }
    if (!p) { beep(false); const r = data.rows.find(x => x.id === id); setMsg({ ok: false, text: `«${r?.name || 'Деталь'}» — не для этого поста (${ruleText(rule)})` }); return }
    const n = scans.get(p.id) || 0
    if (n >= p.qty) { beep(false); setMsg({ ok: false, text: `«${p.name}» — уже отмечены все ${p.qty} шт.` }); return }
    if (await setN(p, n + 1)) { beep(true); setMsg({ ok: true, text: `✓ ${p.name}${p.des ? ` (${p.des})` : ''} — ${n + 1} из ${p.qty}` }) }
  }
  const submitCode = e => { e.preventDefault(); const t = code.trim(); setCode(''); if (t) onScan(t); inputRef.current?.focus() }
  const finish = async () => {
    if (left > 0 && !window.confirm(`Не отмечено ${left} шт. Всё равно отметить пост «${stage.post_name}» выполненным?`)) return
    if (left === 0 && !window.confirm(`Все детали отмечены. Пост «${stage.post_name}» выполнен?`)) return
    setBusy(true)
    const r = await stageDone(stage.stage_id)
    setBusy(false)
    if (r.error) { setMsg({ ok: false, text: r.error }); return }
    onClose(true)
  }
  const shown = show === 'left' ? parts.filter(p => (scans.get(p.id) || 0) < p.qty) : parts
  const small = { padding: '5px 11px', borderRadius: 16, fontSize: 12, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text-muted)' }
  const step = { width: 30, height: 28, borderRadius: 8, border: '0.5px solid var(--border-md)', background: 'var(--bg)', fontSize: 15, padding: 0 }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 230, background: 'var(--bg)', display: 'flex', flexDirection: 'column', height: '100dvh' }}>
      <div style={{ flex: '0 0 auto', padding: '10px 12px 6px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 15 }}>📍 {stage.post_name}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{data?.order ? orderTitle(data.order) : ''} · {ruleText(rule)}</div>
          </div>
          <button type="button" onClick={() => onClose(changed)} style={{ background: 'none', border: 'none', fontSize: 26, color: 'var(--text-muted)', padding: '0 4px' }}>×</button>
        </div>
        {rule.list !== 'none' && data && (
          <>
            {/* прогресс */}
            <div style={{ margin: '8px 0 6px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 3 }}>
                <span>Отмечено <b>{done}</b> из <b>{total}</b> шт.</span>
                <span style={{ color: left ? 'var(--amber)' : 'var(--teal)', fontWeight: 500 }}>{left ? `осталось ${left}` : '✓ все детали'}</span>
              </div>
              <div style={{ height: 6, borderRadius: 3, background: 'var(--bg2)', overflow: 'hidden' }}>
                <div style={{ width: `${total ? done / total * 100 : 0}%`, height: '100%', background: left ? 'var(--blue)' : 'var(--teal)', transition: 'width .2s' }} />
              </div>
            </div>
            {cam && <QrCamera onCode={onScan} />}
            <form onSubmit={submitCode} style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <input ref={inputRef} value={code} onChange={e => setCode(e.target.value)} placeholder="Код бирки — сканер-пистолет или вручную" enterKeyHint="go" style={{ flex: 1, minWidth: 0, fontSize: 13, padding: '7px 10px' }} />
              <button type="button" onClick={() => setCam(c => !c)} style={{ ...small, color: cam ? 'white' : 'var(--blue)', background: cam ? 'var(--blue)' : 'transparent', borderColor: 'var(--blue)' }}>📷 {cam ? 'Скрыть' : 'Камера'}</button>
            </form>
            {msg && <div style={{ marginTop: 6, fontSize: 12.5, padding: '6px 9px', borderRadius: 'var(--radius)', background: msg.ok ? 'var(--teal-light)' : 'var(--amber-light)', color: msg.ok ? 'var(--teal)' : 'var(--amber)' }}>{msg.text}</div>}
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              {[['left', `Не отмечены · ${parts.filter(p => (scans.get(p.id) || 0) < p.qty).length}`], ['all', `Все · ${parts.length}`]].map(([k, l]) => (
                <button key={k} type="button" onClick={() => setShow(k)} style={{ flex: 1, padding: '6px 4px', borderRadius: 18, border: 'none', fontSize: 12, background: show === k ? 'var(--blue)' : 'var(--bg2)', color: show === k ? 'white' : 'var(--text-muted)' }}>{l}</button>
              ))}
            </div>
          </>
        )}
      </div>
      <div style={{ flex: '1 1 0', overflowY: 'auto', padding: '4px 12px 12px' }}>
        {!data ? <CncLoader compact label="Загружаем детали…" /> : rule.list === 'none' ? (
          <p style={{ fontSize: 13, color: 'var(--text-muted)', padding: '16px 0' }}>На этом посту список деталей не ведётся. Когда закончите — нажмите «Выполнено».</p>
        ) : !parts.length ? (
          <p style={{ fontSize: 13, color: 'var(--text-muted)', padding: '16px 0' }}>У заказа нет деталей для этого поста ({ruleText(rule)}). Пост можно сразу отметить выполненным.</p>
        ) : !shown.length ? (
          <p style={{ fontSize: 13, color: 'var(--teal)', padding: '16px 0', textAlign: 'center' }}>✓ Все детали отмечены</p>
        ) : shown.map(p => {
          const n = scans.get(p.id) || 0, full = n >= p.qty
          return (
            <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0', borderBottom: '0.5px solid var(--border)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 500, color: full ? 'var(--teal)' : 'var(--text)' }}>{full ? '✓ ' : ''}{p.name}{p.des ? <span style={{ fontWeight: 400, color: 'var(--text-hint)', fontFamily: 'monospace', fontSize: 11.5 }}> {p.des}</span> : null}</div>
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{p.size}{p.what ? ` · ${p.what}` : ''}{p.edged && rule.list === 'edge' ? ' · кромка' : ''}</div>
              </div>
              <button type="button" style={step} onClick={() => setN(p, n - 1)} disabled={!n}>−</button>
              <span style={{ minWidth: 42, textAlign: 'center', fontSize: 13, fontWeight: 600, color: full ? 'var(--teal)' : n ? 'var(--blue)' : 'var(--text-hint)' }}>{n}/{p.qty}</span>
              <button type="button" style={step} onClick={() => setN(p, n + 1)} disabled={full}>+</button>
            </div>
          )
        })}
      </div>
      <div style={{ flex: '0 0 auto', padding: '8px 12px calc(10px + env(safe-area-inset-bottom))', borderTop: '0.5px solid var(--border)' }}>
        <button type="button" className="btn-primary" disabled={busy || !data} onClick={finish} style={{ background: left ? undefined : 'var(--teal)' }}>✓ Пост выполнен{left && rule.list !== 'none' && parts.length ? ` (не отмечено ${left})` : ''}</button>
      </div>
    </div>
  )
}
