import OrderEdge from '../components/OrderEdge'
import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { postPage, stageAccept, stageUnaccept, stageDone, since, clock } from '../lib/posts'
import { ruleOf, ruleText } from '../lib/stageParts'
import { orderTitle } from '../lib/orderUtils'
import StageParts from '../components/StageParts'
import StageReturn from '../components/StageReturn'
import StageProgress from '../components/StageProgress'
import CncLoader from '../components/CncLoader'
import { useKeptState } from '../hooks/useKeptState'

// Рабочий пост по ссылке (/post/<id>) — окно одного поста для настольного компьютера со сканером-пистолетом:
// очередь заказов на посту, «Принять», детали (сканирование бирок), «Выполнено». Ссылку даёт производство
// в настройках поста. Пост видят только свои: сотрудники поста, владелец и начальник этого производства.
export default function PostPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { cabinet } = useAuth()
  const [data, setData] = useState(undefined)   // { post, queue } | null — нет доступа
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  const [parts, setParts] = useKeptState('parts', null)   // открыт список деталей: { stage, orderId } — переживает обновление страницы
  const [tick, setTick] = useState(0)
  const [ret, setRet] = useState(null)                 // выбор поста, на который вернуть заказ
  const load = async () => {
    const r = await postPage(id)
    if (r.error) { setErr(r.error); if (r.missing) setData(null); return }
    setErr(''); setData(r.data || null); setTick(t => t + 1)
  }
  useEffect(() => {
    Promise.resolve().then(load)
    const timer = setInterval(() => { if (!document.hidden) load() }, 30000)   // новые заказы на посту — без перезагрузки
    return () => clearInterval(timer)
  }, [id])   // eslint-disable-line react-hooks/exhaustive-deps
  void tick

  const act = async (q, fn, confirmText) => {
    if (confirmText && !window.confirm(confirmText)) return
    setBusy(q.stage_id)
    const r = await fn(q.stage_id)
    setBusy('')
    if (r.error) window.alert(r.error)
    load()
  }
  const home = cabinet === 'client' ? '/orders' : '/production'
  const btn = kind => ({ padding: '8px 14px', borderRadius: 20, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap', border: kind === 'main' || kind === 'ok' ? 'none' : '0.5px solid var(--border-md)', background: kind === 'main' ? 'var(--blue)' : kind === 'ok' ? 'var(--teal)' : 'transparent', color: kind === 'main' || kind === 'ok' ? 'white' : 'var(--text-muted)' })

  if (data === undefined && !err) return <CncLoader full label="Открываем пост…" />
  if (!data) return (
    <div className="page" style={{ maxWidth: 560, margin: '0 auto', padding: 16 }}>
      <div className="card">
        <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 6 }}>Пост недоступен</div>
        <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>{err || 'Этот рабочий пост виден только сотрудникам своего производства. Войдите в аккаунт, которому производство дало доступ к посту, или попросите руководителя закрепить вас за постом.'}</p>
        <button type="button" className="btn-primary" style={{ marginTop: 10 }} onClick={() => navigate(home)}>В кабинет</button>
      </div>
    </div>
  )
  const { post, queue } = data
  const rule = ruleOf(post.rule, post.name)
  const news = queue.filter(q => q.status === 'queued'), work = queue.filter(q => q.status === 'accepted')
  const card = q => {
    const isNew = q.status === 'queued'
    const withParts = rule.list !== 'none'
    return (
      <div key={q.stage_id} className="card" style={{ padding: '12px 14px', border: isNew ? '1px solid var(--amber)' : undefined }}>
        <div style={{ fontWeight: 600, fontSize: 16 }}>{orderTitle(q)}</div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{[q.client_name, q.material_name, q.sheets > 0 && `листов ${q.sheets}`, `деталей ${q.parts}`].filter(Boolean).join(' · ')}<OrderEdge orderId={q.order_id} /></div>
        <div style={{ fontSize: 12, color: isNew ? 'var(--amber)' : 'var(--text-muted)', marginTop: 2 }}>
          {isNew ? `Новый · пришёл ${clock(q.queued_at)}, ждёт принятия ${since(q.queued_at)}` : `В работе · принял ${q.accepted_me ? 'вы' : q.accepted_by || '—'} ${clock(q.accepted_at)} (увидел через ${since(q.queued_at, q.accepted_at)}), ${since(q.accepted_at)}`}
          {q.next_post ? ` · дальше: ${q.next_post}` : ' · последний пост'}
        </div>
        <StageProgress orderId={q.order_id} rule={post.rule} postName={post.name} scanned={q.scanned} onOpen={() => setParts({ stage: q, orderId: q.order_id })} onSkipped={load} />
        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          {isNew && <button type="button" disabled={busy === q.stage_id} style={btn('main')} onClick={() => act(q, stageAccept)}>✓ Принять</button>}
          {!isNew && q.accepted_me && <button type="button" disabled={busy === q.stage_id} style={btn()} onClick={() => act(q, stageUnaccept, `Отменить принятие заказа «${orderTitle(q)}»?\nОн снова будет новым на посту.`)}>✕ Отменить принятие</button>}
          {withParts && <button type="button" style={{ ...btn(), color: 'var(--blue)', borderColor: 'var(--blue)' }} onClick={() => setParts({ stage: q, orderId: q.order_id })}>📦 Детали — сканировать</button>}
          {!isNew && <button type="button" disabled={busy === q.stage_id} style={btn('ok')} onClick={() => (withParts ? setParts({ stage: q, orderId: q.order_id })
            : act(q, stageDone, `Пост «${post.name}» выполнен?\n${q.next_post ? `Заказ перейдёт на пост «${q.next_post}».` : 'Это последний пост — заказ будет исполнен.'}`))}>✓ Выполнено</button>}
          <button type="button" disabled={busy === q.stage_id} style={{ ...btn(), color: 'var(--amber)', borderColor: 'var(--amber)' }} onClick={() => setRet({ orderId: q.order_id, title: orderTitle(q) })}>↩ Вернуть на пост</button>
        </div>
      </div>
    )
  }
  return (
    <div className="page" style={{ maxWidth: 760, margin: '0 auto', padding: '14px 16px 24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 20 }}>📍 {post.name}{!post.active ? <span> · выключен</span> : null}</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{post.production_name} · <span>{ruleText(rule)}</span></div>
        </div>
        <button type="button" style={btn()} onClick={load}>Обновить</button>
        <button type="button" style={btn()} onClick={() => navigate(home)}>Кабинет</button>
      </div>
      {err && <p className="error-text" style={{ marginBottom: 10 }}>{err}</p>}
      {!queue.length ? (
        <p style={{ fontSize: 14, color: 'var(--text-hint)', textAlign: 'center', padding: '30px 0' }}>{`На посту сейчас нет заказов. Когда заказ дойдёт до поста «${post.name}», он появится здесь сам.`}</p>
      ) : (
        <>
          {news.length > 0 && <p className="section-title">{`Новые · ${news.length}`}</p>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{news.map(card)}</div>
          {work.length > 0 && <p className="section-title" style={{ marginTop: news.length ? 14 : 0 }}>{`В работе · ${work.length}`}</p>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{work.map(card)}</div>
        </>
      )}
      <p style={{ fontSize: 11.5, color: 'var(--text-hint)', marginTop: 18 }}>Сканер-пистолет работает как клавиатура: откройте «Детали» заказа, поставьте курсор в поле кода и сканируйте бирки. Список обновляется сам каждые полминуты.</p>
      {ret && <StageReturn orderId={ret.orderId} title={ret.title} onClose={ch => { setRet(null); if (ch) load() }} />}
      {parts && <StageParts stage={parts.stage} orderId={parts.orderId} onClose={ch => { setParts(null); if (ch) load() }} />}
    </div>
  )
}
