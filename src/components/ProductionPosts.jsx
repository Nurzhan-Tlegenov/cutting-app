import { useEffect, useState } from 'react'
import { useKeptState, useKeptDetails } from '../hooks/useKeptState'
import StageParts from './StageParts'
import StageProgress from './StageProgress'
import StageReturn from './StageReturn'
import { RULE_LISTS, DRILL_KEYS, ruleOf, ruleText, savePostRule, byDefaultOf } from '../lib/stageParts'
import { POST_PRESETS, STAGE_LABEL, postsList, savePost, deletePost, orderPosts, setPostMembers, orderStages, stageSkip, startOrderStages, stageDone, stageAccept, stageUnaccept, since, clock, postLink, orderOps, setOrderOp, planStages } from '../lib/posts'

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
  const [edit, setEdit] = useKeptState('postEdit', null)
  const dPosts = useKeptDetails('posts')
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
    <details style={{ marginTop: 8 }} {...dPosts}>
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
                  <PostLinkBox post={p} />
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
  const [ret, setRet] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const load = () => orderStages(orderId).then(r => setSt(r.error ? [] : r.data || []))
  useEffect(() => {
    let alive = true
    // посты кромления / присадки без деталей у этого заказа пропускаются сами (нет кромки — нет кромления)
    orderStages(orderId).then(async r => {
      if (!alive) return
      setSt(r.error ? [] : r.data || [])
      if (status === 'inwork' && (r.data || []).length && await planStages(orderId) > 0 && alive) { await load(); onChange?.() }
    })
    return () => { alive = false }
  }, [orderId, refresh, status])   // eslint-disable-line react-hooks/exhaustive-deps
  const act = async fn => { setBusy(true); setErr(''); const r = await fn(); setBusy(false); if (r?.error) setErr(r.error); await load(); onChange?.() }
  if (!st) return null
  const ops = manage ? <OrderOps orderId={orderId} onChange={async () => { await load(); onChange?.() }} /> : null
  // галочки операций — и до принятия заказа (отметили сборку / установку → при принятии маршрут сразу с ними)
  if (!st.length) return manage && ['new', 'discussion', 'inwork'].includes(status) ? (
    <div style={{ marginTop: 8 }} onClick={e => e.stopPropagation()}>
      {ops}
      {status === 'inwork' && (
        <>
          <div style={{ fontSize: 11.5, color: 'var(--amber)', margin: '2px 0 5px' }}>Заказ принят, по постам ещё не запущен. Отметьте операции заказа и нажмите «Пустить в работу».</div>
          <button type="button" disabled={busy} style={{ padding: '7px 14px', borderRadius: 20, fontSize: 13, fontWeight: 500, border: 'none', background: 'var(--teal)', color: 'white', cursor: 'pointer' }}
            onClick={() => { if (window.confirm('Пустить заказ в работу?\nОн встанет на первый пост техпроцесса, сотрудники поста получат его.')) act(async () => { const r = await startOrderStages(orderId); if (!r.error) await planStages(orderId); return r }) }}>▶ Пустить в работу</button>
        </>
      )}
      {err && <span style={{ fontSize: 11, color: 'var(--danger)', marginLeft: 6 }}>{err}</span>}
    </div>
  ) : null
  const cur = st.find(s => s.status === 'queued' || s.status === 'accepted')
  return (
    <div style={{ marginTop: 8 }} onClick={e => e.stopPropagation()}>
      {ops}
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
      {/* время по постам: увидел — от прихода на пост до «Принять» (кто принял), в работе — от «Принять» до «Выполнено» */}
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
        {st.filter(s => s.queued_at || s.status === 'skipped').map(s => (
          <div key={s.id}>
            <b style={{ fontWeight: 500 }}>{s.name}</b>{': '}
            {s.status === 'skipped' ? 'пропущен'
              : s.status === 'queued' ? <span style={{ color: 'var(--amber)' }}>пришёл {clock(s.queued_at)}, ждёт принятия{s.members?.length ? ` (${s.members.join(', ')})` : ''} · {since(s.queued_at)}</span>
              : s.status === 'accepted' ? `принял ${s.accepted_me ? 'вы' : s.accepted_by || '—'} ${clock(s.accepted_at)} (увидел через ${since(s.queued_at, s.accepted_at)}), в работе ${since(s.accepted_at)}`
              : s.accepted_at ? `увидел через ${since(s.queued_at, s.accepted_at)}, в работе ${since(s.accepted_at, s.done_at)} · принял ${s.accepted_by || '—'}${s.done_by && s.done_by !== s.accepted_by ? `, выполнил ${s.done_by}` : ''}`
              : <span>пройден без принятия{s.done_by ? ` · перенёс ${s.done_by}` : ''}, на посту {since(s.queued_at, s.done_at)}</span>}
          </div>
        ))}
      </div>
      {cur && <StageProgress orderId={orderId} rule={cur.rule} postName={cur.name} scanned={cur.scanned} onOpen={manage ? () => setParts(true) : undefined} />}
      {cur && (manage || cur.can_accept || cur.can_unaccept || cur.mine) && (
        <div style={{ display: 'flex', gap: 5, marginTop: 6, flexWrap: 'wrap' }}>
          {/* принять — только сотрудники поста (если за постом закреплены); руководитель двигает сам заказ */}
          {cur.status === 'queued' && (cur.can_accept ?? manage) && <button type="button" disabled={busy} style={{ ...small, background: 'var(--blue)', color: 'white', border: 'none' }} onClick={() => act(() => stageAccept(cur.id))}>✓ Принять</button>}
          {cur.status === 'accepted' && cur.can_unaccept && <button type="button" disabled={busy} style={small} onClick={() => { if (window.confirm(`Отменить принятие на посту «${cur.name}»?\nЗаказ снова будет новым на этом посту.`)) act(() => stageUnaccept(cur.id)) }}>✕ Отменить принятие</button>}
          {manage && ruleOf(cur.rule, cur.name).list !== 'none' && <button type="button" style={{ ...small, color: 'var(--blue)', borderColor: 'var(--blue)' }} onClick={() => setParts(true)}>📦 Список деталей</button>}
          {(cur.status === 'accepted' && (manage || cur.mine)) && <button type="button" disabled={busy} style={small} onClick={() => { if (window.confirm(`Отметить пост «${cur.name}» выполненным?`)) act(() => stageDone(cur.id)) }}>✓ Выполнено</button>}
          {manage && <button type="button" disabled={busy} style={small} onClick={() => { if (window.confirm(`Пропустить пост «${cur.name}» для этого заказа?`)) act(() => stageSkip(cur.id)) }}>Пропустить пост</button>}
          {manage && st.some(s => s.status === 'done' && (!cur || s.sort < cur.sort)) && <button type="button" disabled={busy} style={{ ...small, color: 'var(--amber)', borderColor: 'var(--amber)' }} onClick={() => setRet(true)}>↩ Вернуть на пост</button>}
        </div>
      )}
      {err && <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 3 }}>{err}</div>}
      {ret && <StageReturn orderId={orderId} title="" onClose={ch => { setRet(false); if (ch) { load(); onChange?.() } }} />}
      {parts && cur && <StageParts stage={{ stage_id: cur.id, post_name: cur.name, rule: cur.rule, status: cur.status }} orderId={orderId} onClose={ch => { setParts(false); if (ch) { load(); onChange?.() } }} />}
    </div>
  )
}

/**
 * Галочки операций в заказе: посты «по галочке» (сборка, установка, упаковка…) — их не видно в свойствах деталей.
 * Отмечен — заказ пройдёт этот пост; не отмечен — пост пропускается. Кромление и присадка решаются по деталям сами.
 */
export function OrderOps({ orderId, onChange }) {
  const [d, setD] = useState(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  useEffect(() => { let alive = true; orderOps(orderId).then(r => { if (!alive) return; if (r.error) setErr(r.missing ? r.error : ''); setD(r.data || null) }); return () => { alive = false } }, [orderId])
  if (err) return <div style={{ fontSize: 11, color: 'var(--amber)', marginBottom: 6 }}>{err}</div>
  if (!d || !d.posts?.length) return null
  const toggle = async p => {
    const on = !d.ops?.[p.id]
    setBusy(p.id)
    const r = await setOrderOp(orderId, p.id, on)
    setBusy('')
    if (r.error) { setErr(r.error); return }
    setD(x => ({ ...x, ops: { ...(x.ops || {}), [p.id]: on } }))
    onChange?.()
  }
  return (
    <div style={{ marginBottom: 7 }}>
      <div style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 3 }}>Операции заказа (чего не видно в деталях):</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
        {d.posts.map(p => {
          const on = !!d.ops?.[p.id]
          return (
            <label key={p.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, padding: '3px 9px', borderRadius: 14, cursor: 'pointer',
              border: `0.5px solid ${on ? 'var(--blue)' : 'var(--border-md)'}`, background: on ? 'var(--blue-light)' : 'transparent', color: on ? 'var(--blue-dark)' : 'var(--text-muted)' }}>
              <input type="checkbox" checked={on} disabled={busy === p.id} onChange={() => toggle(p)} style={{ width: 14, height: 14, margin: 0 }} />{p.name}
            </label>
          )
        })}
      </div>
    </div>
  )
}

/** Ссылка на пост: открывает окно одного поста (очередь, сканирование деталей) — например, на настольном компьютере со
 * сканером-пистолетом. Видят только свои: сотрудники поста, владелец и начальник; чужой аккаунт по ссылке ничего не увидит. */
function PostLinkBox({ post }) {
  const [msg, setMsg] = useState('')
  const url = postLink(post.id)
  const copy = async () => { try { await navigator.clipboard.writeText(url); setMsg('Ссылка скопирована') } catch { setMsg('Выделите ссылку и скопируйте вручную') } }
  const send = async () => { try { await navigator.share({ title: `Рабочий пост «${post.name}»`, url }) } catch { /* отменили */ } }
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 3 }}>Ссылка на пост — открыть на компьютере со сканером (нужен вход в аккаунт сотрудника этого поста):</div>
      <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
        <input type="text" readOnly value={url} onFocus={e => e.target.select()} style={{ flex: '1 1 180px', minWidth: 0, fontSize: 12, padding: '5px 8px' }} />
        <button type="button" style={small} onClick={copy}>Копировать</button>
        {typeof navigator.share === 'function' && <button type="button" style={small} onClick={send}>Отправить</button>}
        <a href={url} target="_blank" rel="noreferrer" style={{ ...small, textDecoration: 'none', color: 'var(--blue)', borderColor: 'var(--blue)' }}>Открыть</a>
      </div>
      {msg && <div style={{ fontSize: 11, color: 'var(--teal)', marginTop: 3 }}>{msg}</div>}
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
      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 7, fontSize: 12.5, marginTop: 6, cursor: 'pointer' }}>
        <input type="checkbox" checked={byDefaultOf(post.rule, post.name)} disabled={busy} onChange={e => set({ byDefault: e.target.checked, onDemand: !e.target.checked })} style={{ width: 16, height: 16, flex: '0 0 auto', marginTop: 1 }} />
        <span><span>Учитывать техпроцесс по умолчанию</span> <span style={{ color: 'var(--text-hint)', fontSize: 11 }}>— включено: пост всегда добавляется в приходящие заказы{r.list === 'edge' || r.list === 'drill' ? ' (пропускается, только если таких деталей в заказе нет)' : ''}; выключено: пост выбирается галочкой в «Операциях» заказа.</span></span>
      </label>
      {r.list === 'edge' && (
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 7, fontSize: 12.5, marginTop: 6, cursor: 'pointer' }}>
          <input type="checkbox" checked={!!r.sides} disabled={busy} onChange={e => set({ sides: e.target.checked })} style={{ width: 16, height: 16, flex: '0 0 auto', marginTop: 1 }} />
          <span><span>Считать по сторонам: прямолинейная деталь с кромкой на 3 сторонах — 3 прохода через станок, сканируется 3 раза.</span> <span style={{ color: 'var(--text-hint)', fontSize: 11 }}>Фигурные детали (кромка по контуру) — 1 проход на штуку.</span></span>
        </label>
      )}
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
