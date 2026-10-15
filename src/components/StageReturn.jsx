import { useEffect, useState } from 'react'
import { orderStages, stageReturn, stageReopen, stageReopenPost, postsList, STAGE_LABEL, clock } from '../lib/posts'
import { useBackClose } from '../lib/backStack'

// Вернуть заказ на пост: список пройденных постов заказа — выбираете, на какой вернуть. Заказ снова пойдёт
// по цепочке с этого поста. orderId, title — заказ; onClose(changed)
// reopen — любой пост, и у исполненного заказа (руководитель): заказ снова в работе с выбранного поста
export default function StageReturn({ orderId, title, onClose, reopen = false, onNoRoute }) {
  const [st, setSt] = useState(null)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  useBackClose(true, () => onClose(false))
  useEffect(() => { let alive = true; orderStages(orderId).then(r => { if (alive) setSt(r.data || []) }); return () => { alive = false } }, [orderId])
  // возврат в техпроцесс — все посты производства на сегодня, в т.ч. созданные после того, как заказ прошёл маршрут
  const [posts, setPosts] = useState(null)
  useEffect(() => { let alive = true; if (reopen) postsList().then(r => { if (alive) setPosts((r.data || []).filter(p => p.active !== false)) }); return () => { alive = false } }, [reopen])
  const cur = (st || []).find(s => s.status === 'queued' || s.status === 'accepted')
  const done = reopen
    ? (posts?.length ? posts.map(p => (st || []).find(s => s.post_id === p.id) || { id: 'p:' + p.id, post_id: p.id, name: p.name, status: 'new_post' }) : (st || [])).filter(s => s !== cur)
    : (st || []).filter(s => s.status === 'done' && (!cur || s.sort < cur.sort)).reverse()
  const pick = async s => {
    if (!window.confirm(`Вернуть заказ «${title || 'этот заказ'}» на пост «${s.name}»?\nДальше он снова пройдёт все посты после него.`)) return
    setBusy(s.id); setErr('')
    const r = !reopen ? await stageReturn(orderId, s.id) : s.status === 'new_post' ? await stageReopenPost(orderId, s.post_id) : await stageReopen(orderId, s.id)
    setBusy('')
    if (r.error) { setErr(r.error); return }
    if (r.data === false) { setErr('Вернуть на этот пост нельзя — обновите список.'); return }
    onClose(true)
  }
  return (
    <div onClick={() => onClose(false)} style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} className="card" style={{ width: '100%', maxWidth: 460, borderRadius: '16px 16px 0 0', paddingBottom: 'calc(16px + env(safe-area-inset-bottom))' }}>
        <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 2 }}>{reopen ? 'Вернуть в техпроцесс' : 'Вернуть на пост'}</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>{title}{cur ? ` · сейчас: ${cur.name}` : ''}</div>
        {st === null ? <p style={{ fontSize: 13, color: 'var(--text-hint)' }}>Загружаем…</p>
          : !done.length ? (reopen && !(st || []).length && onNoRoute
            ? <div><p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 8 }}>Заказ шёл без техпроцесса (по постам не пускался). Можно вернуть его в работу.</p>
                <button type="button" className="btn-primary" disabled={!!busy} onClick={async () => { setBusy('x'); const ok = await onNoRoute(); setBusy(''); if (ok !== false) onClose(true) }}>Вернуть в работу</button></div>
            : <p style={{ fontSize: 13, color: 'var(--text-hint)' }}>{reopen ? 'У заказа нет постов техпроцесса.' : 'Пройденных постов нет — возвращать некуда.'}</p>)
          : done.map(s => (
            <button key={s.id} type="button" disabled={!!busy} onClick={() => pick(s)}
              style={{ width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', marginBottom: 6, borderRadius: 'var(--radius)', border: '0.5px solid var(--amber)', background: 'transparent', cursor: 'pointer', color: 'var(--text)' }}>
              <span style={{ color: 'var(--amber)' }}>↩</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 14, fontWeight: 500 }}>{s.name}</span>
                <span style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)' }}>{s.status === 'new_post' ? 'заказ его не проходил — пост добавится в маршрут' : s.status === 'done' ? `выполнил ${s.done_by || s.accepted_by || '—'} ${clock(s.done_at)}` : `${STAGE_LABEL[s.status] || s.status}${s.done_at ? ' ' + clock(s.done_at) : ''}`}</span>
              </span>
              {busy === s.id && <span style={{ fontSize: 11 }}>…</span>}
            </button>
          ))}
        {err && <p className="error-text" style={{ marginTop: 6 }}>{err}</p>}
        <button type="button" className="btn-secondary" style={{ marginTop: 4 }} onClick={() => onClose(false)}>Отмена</button>
      </div>
    </div>
  )
}
