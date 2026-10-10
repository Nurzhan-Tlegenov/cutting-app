import { useEffect, useState } from 'react'
import StageParts from './StageParts'
import { RULE_LISTS, DRILL_KEYS, ruleOf, ruleText, savePostRule } from '../lib/stageParts'
import { POST_PRESETS, STAGE_LABEL, postsList, savePost, deletePost, orderPosts, setPostMembers, orderStages, stageSkip, stageBack, startOrderStages, stageDone, stageAccept, since, clock } from '../lib/posts'

// Рабочие посты (техпроцесс): производство само задаёт посты, их порядок и сотрудников на каждом посту.
// Заказ, принятый в работу, идёт по постам по порядку; маршрут заказа с временем на каждом посту — StageTrack.
const small = { padding: '4px 10px', borderRadius: 14, fontSize: 11.5, border: '0.5px solid var(--border-md)', background: 'transparent', color: 'var(--text-muted)', whiteSpace: 'nowrap' }
const chip = on => ({ padding: '4px 10px', borderRadius: 14, fontSize: 11.5, cursor: 'pointer', border: '0.5px solid ' + (on ? 'var(--blue)' : 'var(--border-md)'), background: on ? 'var(--blue-light)' : 'transparent', color: on ? 'var(--blue-dark)' : 'var(--text-muted)' })
const arrow = { width: 28, height: 26, padding: 0, borderRadius: 8, border: '0.5px solid var(--border-md)', background: 'var(--bg)', color: 'var(--text-muted)', fontSize: 13 }

/** Настройка постов. members — сотрудники производства (из membersList) */
export function PostsSection({ members }) {
  const [posts, setPosts] = useState(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [edit, setEdit] = useState(null)
  const load = () => postsList().then(r => { if (r.error) { setErr(r.error); setPosts([]) } else { setErr(''); setPosts(r.data || []) } })
  useEffect(() => { Promise.resolve().then(load) }, [])
  const act = async fn => { setBusy(true); setErr(''); const r = await fn(); setBusy(false); if (r?.error) setErr(r.error); await load() }
  const move = (i, d) => {
    const ids = posts.map(p => p.id), j = i + d
    if (j < 0 || j >= ids.length) return
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
    setPosts(ps => { const n = [...ps]; [n[i], n[j]] = [n[j], n[i]]; return n })
    act(() => orderPosts(ids))
  }
  const add = name => act(() => savePost(null, name))
  const staff = (members || []).filter(m => m.active)
  const toggleMember = (p, uid) => {
    const cur = new Set(p.members || [])
    if (cur.has(uid)) cur.delete(uid); else cur.add(uid)
    act(() => setPostMembers(p.id, [...cur]))
  }
  const missing = posts && err && /migration_posts/.test(err)
  return (
    <details style={{ marginTop: 8 }}>
      <summary style={{ fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}>Рабочие посты (техпроцесс){posts?.length ? ` · ${posts.filter(p => p.active).length}` : ''}</summary>
      {missing ? <p style={{ fontSize: 11.5, color: 'var(--amber)', marginTop: 6 }}>{err}</p> : (
        <div style={{ marginTop: 6 }}>
          <p style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 6 }}>Заказ, принятый в работу, идёт по постам сверху вниз. Сотрудники поста видят заказ новым, принимают и отмечают «Выполнено» — заказ сам переходит на следующий пост. После последнего поста заказ исполнен. Порядок меняется стрелками.</p>
          {err && <p className="error-text" style={{ marginBottom: 6 }}>{err}</p>}
          {(posts || []).map((p, i) => (
            <div key={p.id} style={{ padding: '7px 0', borderTop: '0.5px solid var(--border)', opacity: p.active ? 1 : 0.5 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 20, fontSize: 12, color: 'var(--text-hint)', textAlign: 'right' }}>{i + 1}.</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 500 }}>{p.name}{!p.active ? ' · выключен' : ''}{p.queue ? <span style={{ fontWeight: 400, fontSize: 11.5, color: 'var(--blue)' }}> · заказов на посту: {p.queue}</span> : null}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-hint)' }}>Детали: {ruleText(ruleOf(p.rule, p.name))}</div>
                  <div style={{ fontSize: 11, color: (p.members || []).length ? 'var(--text-muted)' : 'var(--amber)' }}>
                    {(p.members || []).length ? (p.members || []).map(u => { const m = staff.find(x => x.user_id === u) || (members || []).find(x => x.user_id === u); return m?.name || m?.full_name || 'сотрудник' }).join(', ') : 'сотрудники не закреплены — заказ на этом посту увидят только владелец и начальник'}
                  </div>
                </div>
                <button type="button" style={arrow} disabled={busy || i === 0} onClick={() => move(i, -1)} title="Выше">↑</button>
                <button type="button" style={arrow} disabled={busy || i === posts.length - 1} onClick={() => move(i, 1)} title="Ниже">↓</button>
                <button type="button" style={small} onClick={() => setEdit(edit === p.id ? null : p.id)}>{edit === p.id ? 'Готово' : 'Изменить'}</button>
              </div>
              {edit === p.id && (
                <div style={{ margin: '6px 0 0 26px' }}>
                  <div style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 4 }}>Сотрудники поста — нажмите, чтобы закрепить или снять:</div>
                  {staff.length ? (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                      {staff.map(m => <button key={m.user_id} type="button" disabled={busy} style={chip((p.members || []).includes(m.user_id))} onClick={() => toggleMember(p, m.user_id)}>{(p.members || []).includes(m.user_id) ? '✓ ' : ''}{m.name || m.full_name || 'Сотрудник'}</button>)}
                    </div>
                  ) : <div style={{ fontSize: 11.5, color: 'var(--amber)' }}>Сначала пригласите сотрудников (раздел «Сотрудники»).</div>}
                  <RuleEditor post={p} busy={busy} onSave={rule => act(async () => { const { error } = await savePostRule(p.id, rule); return error ? { error: error.message } : null })} />
                  <div style={{ display: 'flex', gap: 5, marginTop: 6, flexWrap: 'wrap' }}>
                    <button type="button" disabled={busy} style={small} onClick={() => { const n = window.prompt('Название поста', p.name); if (n) act(() => savePost(p.id, n)) }}>Переименовать</button>
                    <button type="button" disabled={busy} style={small} onClick={() => act(() => savePost(p.id, p.name, !p.active))}>{p.active ? 'Выключить' : 'Включить'}</button>
                    <button type="button" disabled={busy} style={{ ...small, color: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={() => { if (window.confirm(`Удалить пост «${p.name}»? В заказах, которые уже идут по маршруту, этап останется.`)) act(() => deletePost(p.id)) }}>Удалить</button>
                  </div>
                </div>
              )}
            </div>
          ))}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 8 }}>
            {POST_PRESETS.filter(n => !(posts || []).some(p => p.name === n)).map(n => <button key={n} type="button" disabled={busy} style={{ ...small, color: 'var(--blue)', borderColor: 'var(--blue-mid)' }} onClick={() => add(n)}>+ {n}</button>)}
            <button type="button" disabled={busy} style={{ ...small, color: 'var(--blue)', borderColor: 'var(--blue)' }} onClick={() => { const n = window.prompt('Название поста (операции)', ''); if (n) add(n) }}>+ Свой пост</button>
          </div>
        </div>
      )}
    </details>
  )
}

/** Маршрут заказа по постам: где заказ сейчас, кто принял, сколько времени. manage — владелец/начальник (пропустить, вернуть) */
export function StageTrack({ orderId, status, manage = false, refresh, onChange }) {
  const [st, setSt] = useState(null)
  const [parts, setParts] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const load = () => orderStages(orderId).then(r => setSt(r.error ? [] : r.data || []))
  useEffect(() => { let alive = true; orderStages(orderId).then(r => { if (alive) setSt(r.error ? [] : r.data || []) }); return () => { alive = false } }, [orderId, refresh])
  const act = async fn => { setBusy(true); setErr(''); const r = await fn(); setBusy(false); if (r?.error) setErr(r.error); await load(); onChange?.() }
  if (!st) return null
  if (!st.length) return manage && status === 'inwork' ? (
    <div style={{ marginTop: 8 }} onClick={e => e.stopPropagation()}>
      <button type="button" disabled={busy} style={{ ...small, color: 'var(--blue)', borderColor: 'var(--blue)' }} onClick={() => act(() => startOrderStages(orderId))}>▶ Запустить по постам</button>
      {err && <span style={{ fontSize: 11, color: 'var(--danger)', marginLeft: 6 }}>{err}</span>}
    </div>
  ) : null
  const cur = st.find(s => s.status === 'queued' || s.status === 'accepted')
  return (
    <div style={{ marginTop: 8 }} onClick={e => e.stopPropagation()}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 3 }}>
        {st.map((s, i) => {
          const on = s === cur, done = s.status === 'done', skip = s.status === 'skipped'
          return (
            <span key={s.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              {i > 0 && <span style={{ color: 'var(--text-hint)', fontSize: 11 }}>→</span>}
              <span title={STAGE_LABEL[s.status]} style={{ fontSize: 11.5, padding: '2px 8px', borderRadius: 12, whiteSpace: 'nowrap',
                border: `0.5px solid ${on ? 'var(--blue)' : done ? 'var(--teal)' : 'var(--border-md)'}`, background: on ? 'var(--blue)' : 'transparent',
                color: on ? 'white' : done ? 'var(--teal)' : 'var(--text-hint)', textDecoration: skip ? 'line-through' : 'none' }}>{done ? '✓ ' : ''}{s.name}</span>
            </span>
          )
        })}
      </div>
      {/* время по постам: ждал — от прихода на пост до «Принять», в работе — от «Принять» до «Выполнено» */}
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
        {st.filter(s => s.queued_at || s.status === 'skipped').map(s => (
          <div key={s.id}>
            <b style={{ fontWeight: 500 }}>{s.name}</b>{': '}
            {s.status === 'skipped' ? 'пропущен'
              : s.status === 'queued' ? `пришёл ${clock(s.queued_at)}, ждёт ${since(s.queued_at)}`
              : s.status === 'accepted' ? `принял ${s.accepted_by || '—'} ${clock(s.accepted_at)}, в работе ${since(s.accepted_at)}`
              : `ждал ${since(s.queued_at, s.accepted_at)}, в работе ${since(s.accepted_at, s.done_at)} · принял ${s.accepted_by || '—'}${s.done_by && s.done_by !== s.accepted_by ? `, выполнил ${s.done_by}` : ''}`}
          </div>
        ))}
      </div>
      {manage && cur && (
        <div style={{ display: 'flex', gap: 5, marginTop: 6, flexWrap: 'wrap' }}>
          {cur.status === 'queued' && <button type="button" disabled={busy} style={small} onClick={() => act(() => stageAccept(cur.id))}>Принять за пост</button>}
          {ruleOf(cur.rule, cur.name).list !== 'none' && <button type="button" style={{ ...small, color: 'var(--blue)', borderColor: 'var(--blue)' }} onClick={() => setParts(true)}>📦 Детали{Number(cur.scanned) ? ` · ${cur.scanned}` : ''}</button>}
          <button type="button" disabled={busy} style={small} onClick={() => { if (window.confirm(`Отметить пост «${cur.name}» выполненным?`)) act(() => stageDone(cur.id)) }}>✓ Выполнено</button>
          <button type="button" disabled={busy} style={small} onClick={() => { if (window.confirm(`Пропустить пост «${cur.name}» для этого заказа?`)) act(() => stageSkip(cur.id)) }}>Пропустить пост</button>
          {st.some(s => s.status === 'done') && <button type="button" disabled={busy} style={small} onClick={() => { if (window.confirm('Вернуть заказ на предыдущий пост (переделать)?')) act(() => stageBack(orderId)) }}>↩ На предыдущий пост</button>}
        </div>
      )}
      {err && <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 3 }}>{err}</div>}
      {parts && cur && <StageParts stage={{ stage_id: cur.id, post_name: cur.name, rule: cur.rule, status: cur.status }} orderId={orderId} onClose={ch => { setParts(false); if (ch) { load(); onChange?.() } }} />}
    </div>
  )
}

/** Какие детали идут через пост: все, с кромкой, с присадкой (что учитывать), без списка */
function RuleEditor({ post, busy, onSave }) {
  const r = ruleOf(post.rule, post.name)
  const set = patch => onSave({ ...r, ...patch })
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 4 }}>Детали на посту (сканируют бирки и отмечают, что прошло):</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
        {RULE_LISTS.map(([k, l]) => <button key={k} type="button" disabled={busy} style={chip(r.list === k)} onClick={() => set(k === 'drill' && r.list !== 'drill' ? { list: k, top: false, bottom: true, edge: true, grooves: false, mills: false } : { list: k })}>{r.list === k ? '✓ ' : ''}{l}</button>)}
      </div>
      {r.list === 'drill' && (
        <div style={{ marginTop: 6 }}>
          <div style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 3 }}>Учитывать (деталь попадёт в список, если у неё есть хоть что-то из отмеченного):</div>
          {DRILL_KEYS.map(([k, l]) => (
            <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, padding: '2px 0', cursor: 'pointer' }}>
              <input type="checkbox" checked={!!r[k]} disabled={busy} onChange={e => set({ [k]: e.target.checked })} style={{ width: 16, height: 16 }} />
              {l}{k === 'top' ? <span style={{ color: 'var(--text-hint)', fontSize: 11 }}> — обычно их делает фрезер на раскрое</span> : null}
            </label>
          ))}
        </div>
      )}
    </div>
  )
}
