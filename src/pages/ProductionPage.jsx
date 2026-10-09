import { orderFaults, faultText } from '../lib/nestingCheck'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import BottomNav from '../components/BottomNav'
import ProductionForm from '../components/ProductionForm'
import { myProduction, productionOrders, productionSetStatus, productionReturnOrder, orderMarks, MARKS_SQL_HINT, productionStats, productionArchive } from '../lib/productionApi'
import { Results, usePeriod } from '../components/OrderStats'
import { getUserSettings, saveUserSettings } from '../lib/userSettings'
import { STATUS_LABELS, STATUS_BADGE, orderTitle } from '../lib/orderUtils'
import { simShareOrders } from '../lib/simShare'
import CncLoader from '../components/CncLoader'
import PriceList from '../components/PriceList'

// Кабинет производства: моё производство и заявки — заказы, которые заказчики оформили на него.
const date = v => (v ? new Date(v).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '')
const digits = v => String(v || '').replace(/\D/g, '')
const FILTERS = [['new', 'Новые'], ['work', 'В работе'], ['done', 'Исполнены'], ['all', 'Все'], ['archive', 'Архив']]
const MARGINS = [['kerf_width', 'Рез / фреза'], ['margin_left', 'Отступ ←'], ['margin_right', 'Отступ →'], ['margin_top', 'Отступ ↑'], ['margin_bottom', 'Отступ ↓']]
// то же для ХДФ / ДВП (задние стенки): тонкий материал режется на пиле — рез и отступы свои
const HDF_MARGINS = MARGINS.map(([k, l]) => ['hdf_' + k, k === 'kerf_width' ? 'Рез (пила)' : l])
const KIND_HINT = 'Чтобы задать параметры для ХДФ и видеть число листов в заявках, выполните migration_material_kind.sql в Supabase (SQL Editor) — один раз.'

export default function ProductionPage() {
  const navigate = useNavigate()
  const { user, refreshProfile } = useAuth()
  const [prod, setProd] = useState(undefined)       // undefined — загрузка, null — производства нет
  const [orders, setOrders] = useState([])
  const [error, setError] = useState('')
  // раздел списка запоминается: вернувшись из ЧПУ или бирок «к заказам», попадаем туда же, где были
  const [filter, setFilterState] = useState(() => { try { return sessionStorage.getItem('prodFilter') || 'new' } catch { return 'new' } })
  const setFilter = f => { setFilterState(f); try { sessionStorage.setItem('prodFilter', f) } catch { /* без памяти */ } }
  const [edit, setEdit] = useState(false)
  const [busy, setBusy] = useState('')
  const [prices, setPrices] = useState(false)       // открыт прайс-лист
  const [open, setOpen] = useState(() => new Set())   // развёрнутые заявки; по умолчанию все свёрнуты — список короткий
  const toggle = id => setOpen(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const [sheet, setSheet] = useState({})
  const [simShares, setSimShares] = useState(() => new Map())   // у каких заявок открыты ссылки на симуляцию
  const [archived, setArchived] = useState(() => new Map())     // заказы в архиве: id -> когда отправлен
  const [stats, setStats] = useState(null)                       // строки статистики (вместе с удалёнными заказами); null — в базе её ещё нет
  const [statsHint, setStatsHint] = useState('')
  const per = usePeriod('prodStats_')
  // что показывать в итогах — галочки, хранятся в настройках аккаунта
  const [resShow, setResShow] = useState(() => getUserSettings(user).resultsShow || null)
  const saveResShow = v => { setResShow(v); saveUserSettings({ resultsShow: v }, user) }
  // «В архив» у производства — убрать исполненный заказ из своих списков. Заказ клиента не трогается: он хранит его сам
  // (и при рекламации отправит заново). В статистике и в счётчике «Исполнено» заказ остаётся.
  const toArchive = async o => {
    setBusy(o.id)
    const r = await productionArchive(o.id, true)
    setBusy('')
    if (r.error) { setError(r.error); return }
    setArchived(m => new Map(m).set(o.id, r.at || new Date().toISOString()))
  }
  const fromArchive = async o => {
    setBusy(o.id)
    const r = await productionArchive(o.id, false)
    setBusy('')
    if (r.error) { setError(r.error); return }
    setArchived(m => { const n = new Map(m); n.delete(o.id); return n })
  }
  const loadStats = async () => {
    const r = await productionStats()
    if (r.error) { setStats(null); setStatsHint(r.missing ? r.error : ''); return }
    setStatsHint(''); setStats(r.data || [])
    setArchived(new Map((r.data || []).filter(x => !x.deleted && x.prod_archived_at).map(x => [x.id, x.prod_archived_at])))
  }

  const load = async () => {
    const p = (await myProduction(user?.id)) ?? null
    setProd(p)
    if (p && (p.status ?? 'approved') === 'approved') {
      setSheet(Object.fromEntries([...MARGINS, ...HDF_MARGINS].map(([k]) => [k, p[k] != null ? String(p[k]) : ''])))
      const r = await productionOrders()
      if (r.error) setError(r.error); else { setError(''); setOrders(r.data || []); loadStats() }
      simShareOrders().then(setSimShares)
    }
  }
  useEffect(() => { Promise.resolve().then(load) }, [user?.id])   // eslint-disable-line react-hooks/exhaustive-deps

  const setStatus = async (o, status) => {
    setBusy(o.id)
    if (status === 'inwork') {              // раскрой с нарушением реза в работу не принимается
      const faults = await orderFaults(o.id)
      if (faults.length) { setBusy(''); window.alert(faultText(faults, 'Принять такой заказ в работу нельзя. Откройте заказ и исправьте раскрой или верните заказ заказчику на доработку.')); return }
    }
    const r = await productionSetStatus(o.id, status)
    setBusy('')
    if (r.error) { setError(r.error); return }
    setOrders(list => list.map(x => (x.id === o.id ? { ...x, status } : x)))
    loadStats()
  }
  // вернуть заказ заказчику на доработку: он снова сможет править заказ и оформить его заново
  const returnOrder = async o => {
    const note = window.prompt(`Вернуть заказ «${orderTitle(o)}» заказчику на доработку?\nНапишите, что нужно поправить (заказчик это увидит):`, '')
    if (note === null) return
    setBusy(o.id)
    const r = await productionReturnOrder(o.id, note)
    setBusy('')
    if (r.error) { setError(r.error); return }
    setOrders(list => list.filter(x => x.id !== o.id))
  }
  const saveSheet = async key => {
    const v = sheet[key] === '' ? null : Number(String(sheet[key]).replace(',', '.'))
    if (v != null && (!isFinite(v) || v < 0)) return
    if ((prod[key] ?? null) === v) return
    const { error: e } = await supabase.from('productions').update({ [key]: v }).eq('id', prod.id)
    if (e) setError(/hdf_/.test(String(e.message)) ? KIND_HINT : e.message); else setProd(p => ({ ...p, [key]: v }))
  }

  // заказы в архиве — в своём разделе; в остальных разделах и счётчиках их нет
  const live = orders.filter(o => !archived.has(o.id))
  const count = { new: live.filter(o => o.status === 'new').length, work: live.filter(o => o.status === 'discussion' || o.status === 'inwork').length, done: live.filter(o => o.status === 'done').length, all: live.length, archive: archived.size }
  const shown = filter === 'archive' ? orders.filter(o => archived.has(o.id))
    : live.filter(o => filter === 'all' || (filter === 'new' ? o.status === 'new' : filter === 'done' ? o.status === 'done' : o.status === 'discussion' || o.status === 'inwork'))
  const btn = kind => ({ padding: '6px 12px', borderRadius: 20, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap', border: kind === 'main' ? 'none' : '0.5px solid var(--border-md)', background: kind === 'main' ? 'var(--blue)' : 'transparent', color: kind === 'main' ? 'white' : 'var(--text-muted)' })

  return (
    <div className="page" style={{ paddingBottom: 100 }}>
      <h1 style={{ fontSize: 18, fontWeight: 500, marginBottom: 16, paddingTop: 8 }}>Производство</h1>
      {error && <p className="error-text" style={{ marginBottom: 12 }}>{error}</p>}
      {prod === undefined ? <CncLoader label="Открываем производство…" /> : !prod ? (
        <div className="card">
          <div style={{ fontWeight: 500, fontSize: 15, marginBottom: 4 }}>У вас есть своё производство?</div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
            Зарегистрируйте его — и заказы, которые вы или ваши заказчики оформят на ваше производство, будут приходить сюда заявками. Вы принимаете заявку — заказчик видит, что заказ принят. Если производства нет, просто выбирайте чужое при оформлении заказа. Пока регистрация идёт по запросу, новое производство начинает работать после подтверждения администратором.
          </p>
          <ProductionForm onDone={async () => { await refreshProfile?.(); load() }} />
        </div>
      ) : (prod.status ?? 'approved') !== 'approved' ? (
        <div className="card" style={{ border: '1px solid var(--amber)' }}>
          <div style={{ fontWeight: 500, fontSize: 15, marginBottom: 4 }}>{prod.name}</div>
          <div style={{ fontSize: 12, color: 'var(--text-hint)', marginBottom: 8 }}>{[prod.country, prod.city, prod.phone].filter(Boolean).join(' · ')}</div>
          {prod.status === 'rejected' ? (
            <>
              <p style={{ fontSize: 13, color: 'var(--danger)', marginBottom: 10 }}>Заявка на регистрацию производства отклонена. Можно поправить данные и подать её заново.</p>
              <ProductionForm initial={prod} submitLabel="Подать заявку заново" onDone={load} />
            </>
          ) : (
            <p style={{ fontSize: 13, color: 'var(--amber)' }}>Заявка на регистрацию производства отправлена и ждёт подтверждения администратора. После подтверждения производство появится в списке у заказчиков, а заявки начнут приходить сюда.</p>
          )}
        </div>
      ) : (
        <>
          <div className="card" style={{ marginBottom: 12 }}>
            {edit ? (
              <ProductionForm initial={prod} submitLabel="Сохранить" onCancel={() => setEdit(false)} onDone={() => { setEdit(false); load() }} />
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 500, fontSize: 16 }}>{prod.name}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-hint)' }}>{[prod.country, prod.city, prod.phone].filter(Boolean).join(' · ') || 'Страна и телефон не указаны'}</div>
                  </div>
                  <button type="button" style={btn()} onClick={() => setEdit(true)}>Изменить</button>
                </div>
                {/* статистика за период: заявки, в работе, исполнено, суммы, листы, объёмы работ. Исполненные считаются и после
                    архива, и после того, как клиент удалил заказ, — от него остаётся запись */}
                <div style={{ marginTop: 8 }}>
                  {stats ? <Results list={stats.map(x => (x.client_name ? x : { ...x, client_name: x.own ? '' : orders.find(o => o.id === x.id)?.client_name || '' }))} per={per} show={resShow} onShow={saveResShow} onOpen={o => navigate(`/orders/${o.id}`)} /> : (
                    <>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
                        {[['Заявок', orders.length], ['Принято', orders.filter(o => o.status === 'inwork' || o.status === 'done').length], ['Исполнено', orders.filter(o => o.status === 'done').length]].map(([l, v]) => (
                          <div key={l} style={{ background: 'var(--bg2)', borderRadius: 'var(--radius)', padding: '3px 9px', display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 6, minWidth: 0 }}>
                            <span style={{ fontSize: 11, color: 'var(--text-hint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l}</span>
                            <span style={{ fontSize: 15, fontWeight: 500 }}>{v}</span>
                          </div>
                        ))}
                      </div>
                      {statsHint && <p style={{ fontSize: 11, color: 'var(--amber)', marginTop: 6 }}>{statsHint}</p>}
                    </>
                  )}
                </div>
                <details style={{ marginTop: 10 }}>
                  <summary style={{ fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}>Параметры станка (рез и отступы листа) — по типу материала</summary>
                  <p style={{ fontSize: 11, color: 'var(--text-hint)', margin: '6px 0' }}>Подставляются в раскрой заказчика, когда он выбирает ваше производство, — по типу материала, который он указал в заказе.</p>
                  {[['Плита: ЛДСП, МДФ — фрезер ЧПУ или пила', MARGINS], ['ХДФ, ДВП (задние стенки) — пила', HDF_MARGINS]].map(([title, list]) => (
                    <div key={title} style={{ marginBottom: 8 }}>
                      <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 3 }}>{title}</div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {list.map(([k, l]) => (
                          <label key={k} style={{ flex: 1, minWidth: 0, fontSize: 10, color: 'var(--text-muted)' }}>{l}
                            <input type="text" inputMode="decimal" value={sheet[k] ?? ''} placeholder={k.startsWith('hdf_') && prod[k.slice(4)] != null ? String(prod[k.slice(4)]) : ''} onChange={e => setSheet(s => ({ ...s, [k]: e.target.value.replace(/[^0-9.,]/g, '') }))} onBlur={() => saveSheet(k)} style={{ padding: '4px 6px', fontSize: 13 }} />
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                  <p style={{ fontSize: 11, color: 'var(--text-hint)' }}>Если для ХДФ поле пустое — берётся значение из верхней строки.</p>
                </details>
                <div onClick={() => setPrices(true)} style={{ display: 'flex', alignItems: 'center', marginTop: 8, cursor: 'pointer' }}>
                  <span style={{ flex: 1, fontSize: 12, color: 'var(--text-muted)' }}>Прайс-лист (цены на распил, кромление, присадку)</span>
                  <span style={{ color: 'var(--blue)', fontSize: 16 }}>›</span>
                </div>
              </>
            )}
          </div>

          <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            {FILTERS.map(([id, label]) => (
              <button key={id} type="button" onClick={() => setFilter(id)} style={{ flex: 1, padding: '7px 4px', borderRadius: 20, border: 'none', fontSize: 12, background: filter === id ? 'var(--blue)' : 'var(--bg2)', color: filter === id ? 'white' : 'var(--text-muted)' }}>
                {label}{count[id] ? ` · ${count[id]}` : ''}
              </button>
            ))}
          </div>
          {orders.length > 0 && 'gcode_at' in orders[0] && !('sheets' in orders[0]) && <p style={{ fontSize: 11, color: 'var(--amber)', marginBottom: 8 }}>{KIND_HINT}</p>}
          {orders.length > 0 && !('gcode_at' in orders[0]) && <p style={{ fontSize: 11, color: 'var(--amber)', marginBottom: 8 }}>{MARKS_SQL_HINT}</p>}
          {!shown.length && <p style={{ fontSize: 13, color: 'var(--text-hint)', textAlign: 'center', padding: '24px 0' }}>{orders.length ? 'В этом разделе пусто.' : 'Заявок пока нет. Они появятся, когда заказ оформят на ваше производство.'}</p>}
          {filter === 'archive' && shown.length > 0 && <p style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 8 }}>Исполненные заказы, убранные из ваших списков. У заказчика они остаются; когда он удалит заказ, отсюда тот тоже исчезнет. В статистике «Исполнено» они учтены всегда.</p>}
          {filter !== 'archive' && count.done > 0 && (
            <div style={{ fontSize: 12, color: 'var(--amber)', background: 'var(--amber-light)', border: '0.5px solid var(--amber)', borderRadius: 'var(--radius)', padding: '7px 10px', marginBottom: 8 }}>
              Исполненных заказов не в архиве: <b>{count.done}</b>. Уберите их в архив — кнопка «📦 В архив» в заказе: список станет короче, в статистике они останутся.
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {shown.map(o => {
              const tel = digits(o.client_phone), wa = digits(o.client_whatsapp) || tel
              const isOpen = open.has(o.id)
              return (
                <div key={o.id} className="card" style={{ padding: isOpen ? '8px 12px 10px' : '7px 12px' }}>
                  {/* свёрнуто — только строка заказа со статусом и пометками; нажатие разворачивает: заказчик и действия */}
                  <div onClick={() => toggle(o.id)} style={{ cursor: 'pointer' }}>
                    {/* слева — заказ, справа — статус и под ним короткие пометки (G-код, Файлы): серые — не сделано, синие — сделано */}
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                      <span style={{ flex: '0 0 auto', width: 10, fontSize: 11, lineHeight: '20px', color: 'var(--text-hint)' }}>{isOpen ? '▾' : '▸'}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 500, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{orderTitle(o)}</div>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{[o.material_name, o.material_kind === 'hdf' && 'ХДФ', o.sheets > 0 && `листов ${o.sheets}`, `деталей ${o.parts}`, date(o.submitted_at)].filter(Boolean).join(' · ')}</div>
                        {/* заказчик — сразу в карточке: имя и телефон (звонок по нажатию) */}
                        <div style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {o.own ? <span style={{ color: 'var(--text-hint)' }}>Ваш собственный заказ</span> : <>
                            {(o.client_name || !tel) && <span style={{ marginRight: 8, color: o.client_name ? 'inherit' : 'var(--text-hint)' }}>{o.client_name || 'Заказчик не указал имя и телефон'}</span>}
                            {tel && <a href={`tel:+${tel}`} onClick={e => e.stopPropagation()} style={{ color: 'var(--blue)' }}>{o.client_phone}</a>}
                          </>}
                        </div>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3, flex: '0 0 auto' }}>
                        <span className={`badge ${STATUS_BADGE[o.status] || 'badge-new'}`}>{archived.has(o.id) ? 'В архиве' : STATUS_LABELS[o.status] || o.status}</span>
                        {(o.status === 'inwork' || o.status === 'done' || o.gcode_at || o.files_saved_at) && 'gcode_at' in o && (
                          <div style={{ display: 'flex', gap: 4 }}>
                            {orderMarks(o).map(m => (
                              <span key={m.key} title={m.text} style={{ fontSize: 11, lineHeight: '16px', borderRadius: 9, padding: '0 7px', whiteSpace: 'nowrap', border: `0.5px solid ${m.on ? 'var(--blue)' : 'var(--border-md)'}`, background: m.on ? 'var(--blue)' : 'transparent', color: m.on ? 'white' : 'var(--text-hint)' }}>{m.short}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  {isOpen && simShares.has(o.id) && (
                    <div title="По ссылке открыта симуляция обработки этого заказа. Закрыть доступ можно в заказе."
                      style={{ display: 'inline-block', fontSize: 11, color: 'var(--teal)', background: 'var(--teal-light)', border: '0.5px solid var(--teal)', borderRadius: 10, padding: '1px 8px', marginTop: 2 }}>
                      🔗 открыта ссылка на симуляцию{simShares.get(o.id) > 1 ? ` · ${simShares.get(o.id)}` : ''}
                    </div>
                  )}
                  </div>
                  {isOpen && <>
                  <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                    {o.status !== 'inwork' && o.status !== 'done' && <button type="button" disabled={busy === o.id} style={btn('main')} onClick={() => setStatus(o, 'inwork')}>✓ Принять</button>}
                    {o.status === 'new' && <button type="button" disabled={busy === o.id} style={btn()} onClick={() => setStatus(o, 'discussion')}>Обсудить</button>}
                    {o.status === 'inwork' && <button type="button" disabled={busy === o.id} style={btn('main')} onClick={() => setStatus(o, 'done')}>Исполнен</button>}
                    {o.status === 'done' && !archived.has(o.id) && <button type="button" disabled={busy === o.id} style={{ ...btn('main'), background: 'var(--amber)' }} onClick={() => toArchive(o)}>📦 В архив</button>}
                    {archived.has(o.id) && <button type="button" disabled={busy === o.id} style={btn()} onClick={() => fromArchive(o)}>↩ Вернуть из архива</button>}
                    {o.status === 'done' && !archived.has(o.id) && <button type="button" disabled={busy === o.id} style={btn()} onClick={() => setStatus(o, 'inwork')}>Вернуть в работу</button>}
                    <button type="button" style={btn()} onClick={() => navigate(`/orders/${o.id}`)}>Открыть</button>
                    {!o.own && wa && <a href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer" style={{ ...btn(), textDecoration: 'none', color: 'var(--teal)', borderColor: 'var(--teal)' }}>WhatsApp</a>}
                    {o.status !== 'done' && <button type="button" disabled={busy === o.id} style={{ ...btn(), color: 'var(--amber)', borderColor: 'var(--amber)' }} onClick={() => returnOrder(o)}>↩ Вернуть на доработку</button>}
                  </div>
                  </>}
                </div>
              )
            })}
          </div>
        </>
      )}
      {prices && prod && <PriceList production={prod} onClose={() => setPrices(false)} />}
      <BottomNav />
    </div>
  )
}
