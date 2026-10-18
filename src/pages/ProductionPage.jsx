import { MenuButton, Ico } from '../components/NavDrawer'
import ShareBadge from '../components/ShareBadge'
import { listShares, onShareChange, cachedShare } from '../lib/modelShare'
import { I } from '../lib/navIcons'
import { useBackClose } from '../lib/backStack'
import { orderFaults, faultText } from '../lib/nestingCheck'
import { useEffect, useState, useMemo } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import BottomNav from '../components/BottomNav'
import ProductionForm from '../components/ProductionForm'
import { serviceBadges, servicesKnown } from '../lib/productionServices'
import { myProduction, productionOrders, productionSetStatus, productionReturnOrder, orderMarks, MARKS_SQL_HINT, productionStats, productionArchive, productionExcludeStats, testOrderMinutes } from '../lib/productionApi'
import { Results, usePeriod } from '../components/OrderStats'
import { getUserSettings, saveUserSettings } from '../lib/userSettings'
import { STATUS_LABELS, STATUS_BADGE, orderTitle } from '../lib/orderUtils'
import { simShareOrders } from '../lib/simShare'
import CncLoader from '../components/CncLoader'
import PriceList from '../components/PriceList'
import CncSetup from '../components/CncSetup'
import { useKeptState } from '../hooks/useKeptState'
import { StaffSection } from '../components/ProductionStaff'
import { PostsSection, StageTrack } from '../components/ProductionPosts'
import { productionStageMap, postsList } from '../lib/posts'
import WorkerProduction from '../components/WorkerProduction'
import ProductionBoard from '../components/ProductionBoard'
import StageReturn from '../components/StageReturn'
import { planStages } from '../lib/posts'
import { sendAppeal } from '../lib/messages'
import { membersList, myWorkplaces, prodView, workPid } from '../lib/workplaces'
import LimitsBar from '../components/LimitsBar'
import { flashFocus } from '../lib/noticeNav'
import { limitFromError, resetLimitsCache } from '../lib/limits'
import Drill6Viewer from '../components/Drill6Viewer'
import GcodeFileSim from '../components/GcodeFileSim'
import BeamSawSettings from '../components/BeamSawSettings'
import { hasBeta } from '../lib/beta'

// Кабинет производства: моё производство и заявки — заказы, которые заказчики оформили на него.
const date = v => (v ? new Date(v).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '')
const digits = v => String(v || '').replace(/\D/g, '')
// исполненный заказ уходит из производства совсем (остаётся только в «Итогах» — для статистики), поэтому разделов «Исполнены» и «Архив» нет
const FILTERS = [['new', 'Новые'], ['work', 'В работе'], ['all', 'Все'], ['done', 'Исполнены']]   // «Исполнены» — последние: вернуть в техпроцесс, если что-то нажали не так
const MARGINS = [['kerf_width', 'Рез / фреза'], ['margin_left', 'Отступ ←'], ['margin_right', 'Отступ →'], ['margin_top', 'Отступ ↑'], ['margin_bottom', 'Отступ ↓']]
// то же для ХДФ / ДВП (задние стенки): тонкий материал режется на пиле — рез и отступы свои
const HDF_MARGINS = MARGINS.map(([k, l]) => ['hdf_' + k, k === 'kerf_width' ? 'Рез (пила)' : l])
const KIND_HINT = 'Чтобы задать параметры для ХДФ и видеть число листов в заявках, выполните migration_material_kind.sql в Supabase (SQL Editor) — один раз.'

export default function ProductionPage() {
  const navigate = useNavigate()
  const { user, profile, isMaster, refreshProfile } = useAuth()
  const [prod, setProd] = useState(undefined)       // undefined — загрузка, null — производства нет
  const [orders, setOrders] = useState([])
  const [error, setError] = useState('')
  // раздел списка запоминается: вернувшись из ЧПУ или бирок «к заказам», попадаем туда же, где были
  const [filter, setFilterState] = useState(() => { try { const f = sessionStorage.getItem('prodFilter'); return FILTERS.some(([k]) => k === f) ? f : 'new' } catch { return 'new' } })
  const setFilter = f => { setFilterState(f); try { sessionStorage.setItem('prodFilter', f) } catch { /* без памяти */ } }
  const [edit, setEdit] = useKeptState('edit', false)
  const [busy, setBusy] = useState('')
  const [prices, setPrices] = useKeptState('prices', false)       // открыт прайс-лист
  const [xmlView, setXmlView] = useKeptState('xml', false)     // просмотрщик XML-программ присадочного станка
  const [gsim, setGsim] = useState(false)                       // симуляция G-кода из файла (любой программы)
  const [openIds, setOpenIds] = useKeptState('open', [])   // развёрнутые заявки; по умолчанию все свёрнуты — список короткий
  const open = useMemo(() => new Set(openIds), [openIds])
  const toggle = id => setOpenIds(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]))
  const [sheet, setSheet] = useState({})
  const [staff, setStaff] = useState({ data: null, error: '' })   // сотрудники и приглашения (владелец)
  const [wps, setWps] = useState([])                              // где я сотрудник (своего производства нет)
  const [stages, setStages] = useState({})                        // где сейчас заказы: id -> { name (пост), status, done, total }
  const loadStages = () => productionStageMap().then(r => setStages(r.data || {}))
  const [reopen, setReopen] = useState(null)                  // исполненный заказ — вернуть в техпроцесс (выбор поста)
  const [tab, setTab] = useKeptState('prodTab', 'orders')    // вкладка кабинета: orders | board | settings
  const [setSec, setSetSec] = useKeptState('setSec', null)   // открытый раздел настроек; null — список разделов
  // переход из бокового меню: сразу нужная вкладка
  const loc = useLocation()
  useEffect(() => { const t = loc.state?.tab; if (t) Promise.resolve().then(() => setTab(t)) }, [loc.key])   // eslint-disable-line react-hooks/exhaustive-deps
  // пришли по уведомлению о новой заявке: нужный раздел, карточка развёрнута и подсвечена
  const [focusId, setFocusId] = useState(null)
  useEffect(() => { const f = loc.state?.focus; if (f) Promise.resolve().then(() => setFocusId(f)) }, [loc.key])   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const o = focusId && orders.find(x => x.id === focusId)
    if (!o) return
    Promise.resolve().then(() => {
      setFilter(o.status === 'new' ? 'new' : o.status === 'done' ? 'done' : o.status === 'draft' ? 'all' : 'work')
      setOpenIds(prev => (prev.includes(o.id) ? prev : [...prev, o.id]))
      setFocusId(null)
      flashFocus(o.id)
    })
  }, [focusId, orders])   // eslint-disable-line react-hooks/exhaustive-deps
  useBackClose(tab === 'settings' && !!setSec && !edit, () => setSetSec(null))   // «Назад» телефона — к списку разделов
  const [hasPosts, setHasPosts] = useState(false)       // есть посты — принятый, но не пущенный заказ помечается
  const [betaBeam, setBetaBeam] = useState(false)       // β Пильный центр: раздел настроек — мастеру и бета-тестерам
  useEffect(() => { let alive = true; hasBeta('beam_saw').then(v => { if (alive) setBetaBeam(v) }); return () => { alive = false } }, [])
  useEffect(() => { let alive = true; postsList().then(r => { if (alive) setHasPosts((r.data || []).some(p => p.active !== false)) }); return () => { alive = false } }, [])
  const loadStaff = () => membersList().then(r => setStaff({ data: r.data || null, error: r.error || '' }))
  const [simShares, setSimShares] = useState(() => new Map())   // у каких заявок открыты ссылки на симуляцию
  const [shares, setShares] = useState(() => new Map())         // у каких заявок открыта ссылка на 3D-модель
  useEffect(() => onShareChange(() => setShares(prev => {
    const next = new Map(prev)
    for (const o of orders) { const t = cachedShare(o.id); if (t) next.set(o.id, t); else if (t === null) next.delete(o.id) }
    return next
  })), [orders])
  const [archived, setArchived] = useState(() => new Map())     // заказы в архиве: id -> когда отправлен
  const [stats, setStats] = useState(null)                       // строки статистики (вместе с удалёнными заказами); null — в базе её ещё нет
  const [statsHint, setStatsHint] = useState('')
  const per = usePeriod('prodStats_')
  // что показывать в итогах — галочки, хранятся в настройках аккаунта
  const [resShow, setResShow] = useState(() => getUserSettings(user).resultsShow || null)
  const saveResShow = v => { setResShow(v); saveUserSettings({ resultsShow: v }, user) }
  // «В архив» у производства — убрать исполненный заказ из своих списков. Заказ клиента не трогается: он хранит его сам
  // (и при рекламации отправит заново). В статистике и в счётчике «Исполнено» заказ остаётся.
  // «Исполнен»: заказ исполнен и сразу уходит из списков производства — к заказчику; в «Итогах» он остаётся
  const finish = async o => {
    if (!window.confirm(`Заказ «${orderTitle(o)}» исполнен?\nОн уйдёт из списка производства и останется только в «Итогах» (статистика). Заказ остаётся у заказчика.`)) return
    if (!(await setStatus(o, 'done'))) return
    await toArchive(o)
  }
  const toArchive = async o => {
    setBusy(o.id)
    const r = await productionArchive(o.id, true)
    setBusy('')
    if (r.error) { setError(r.error); return }
    setArchived(m => new Map(m).set(o.id, r.at || new Date().toISOString()))
  }
  // тестовые заказы: время прохождения всех этапов задаёт мастер-аккаунт
  const [testMin, setTestMin] = useState(60)
  useEffect(() => { let alive = true; testOrderMinutes().then(m => { if (alive) setTestMin(m) }); return () => { alive = false } }, [])
  // заказ прошёл этапы дольше — просим мастер-аккаунт убрать его из итогов (обращение в «Сообщения»)
  const askExclude = async o => {
    const note = window.prompt(`Попросить мастер-аккаунт убрать тестовый заказ «${orderTitle(o)}» из итогов производства?\nКомментарий (необязательно):`, '')
    if (note === null) return
    const body = `Прошу убрать из итогов тестовый заказ «${orderTitle(o)}»${o.order_number ? ` (№ ${o.order_number})` : ''} производства «${prod?.name || ''}».${note.trim() ? ` ${note.trim()}` : ''}\nСделать: Профиль → Заказы всех производств → «${prod?.name || ''}» → заказ → «Не в итоги».`
    const r = await sendAppeal(user, profile, body)
    window.alert(r.error ? `Не отправилось: ${r.error}` : 'Обращение отправлено мастер-аккаунту.')
  }
  // тестовый заказ — убрать из итогов / вернуть
  const excludeStats = async (o, on) => {
    if (on && !window.confirm(`Заказ «${orderTitle(o)}» — тестовый?\nЕго сумма, листы и работы не будут считаться в итогах. Вернуть можно в «Тестовые, не в итогах».`)) return
    const r = await productionExcludeStats(o.id, on)
    if (r.error) { window.alert(r.error); return }
    setStats(list => (list || []).map(x => (x.id === o.id ? { ...x, excluded: on } : x)))
  }
  const loadStats = async () => {
    const r = await productionStats()
    if (r.error) { setStats(null); setStatsHint(r.missing ? r.error : ''); return }
    setStatsHint(''); setStats(r.data || [])
    setArchived(new Map((r.data || []).filter(x => !x.deleted && x.prod_archived_at).map(x => [x.id, x.prod_archived_at])))
  }

  const load = async () => {
    const p = (await myProduction(user?.id)) ?? null
    { const w = await myWorkplaces(); setWps(w.data || []) }    // где я сотрудник — рабочие места (может быть и своё производство)
    setProd(p)
    if (p && (p.status ?? 'approved') === 'approved') { loadStaff(); loadStages() }
    if (p && (p.status ?? 'approved') === 'approved') {
      setSheet(Object.fromEntries([...MARGINS, ...HDF_MARGINS].map(([k]) => [k, p[k] != null ? String(p[k]) : ''])))
      const r = await productionOrders()
      if (r.error) setError(r.error); else { setError(''); setOrders(r.data || []); loadStats(); listShares((r.data || []).map(o => o.id)).then(setShares) }
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
    const lim = r.error && limitFromError(r.error)
    if (lim) { window.alert(lim.text); return false }      // заказ видно, а принять нельзя — предел бесплатного использования
    if (r.error) { setError(r.error); return false }
    resetLimitsCache()
    if (status === 'inwork') await planStages(o.id)          // посты без деталей у заказа (нет кромки / присадки) — пропустить
    setOrders(list => list.map(x => (x.id === o.id ? { ...x, status } : x)))
    loadStats()
    return true
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
  const live = orders.filter(o => !archived.has(o.id) && o.status !== 'done')
  const count = { new: live.filter(o => o.status === 'new').length, work: live.filter(o => o.status === 'discussion' || o.status === 'inwork').length, done: live.filter(o => o.status === 'done').length, all: live.length, archive: archived.size }
  const doneList = orders.filter(o => o.status === 'done').sort((a, b) => String(b.done_at || '').localeCompare(String(a.done_at || ''))).slice(0, 40)
  const shown = filter === 'done' ? doneList : live.filter(o => filter === 'all' || (filter === 'new' ? o.status === 'new' : o.status === 'discussion' || o.status === 'inwork'))
  // разделы экрана «Настройки»: [id, значок, название, пояснение, число]
  const activeStaff = (staff.data?.members || []).filter(m => m.active).length
  const settingsMenu = prod ? [
    ['company', I.factory, prod.name || 'Производство', servicesKnown(prod.services) ? ([prod.country, prod.city, prod.phone].filter(Boolean).join(' · ') || 'Данные производства') : '⚠ Укажите услуги — их видят заказчики'],
    ['staff', I.users, 'Сотрудники', 'Рабочие места, приглашения, права', activeStaff],
    ['posts', I.posts, 'Рабочие посты', 'Техпроцесс: порядок постов, кто на них'],
    ['prices', I.tag, 'Прайс-лист', 'Распил плиты и ХДФ, кромление, присадка'],
    ['sheet', I.sliders, 'Параметры станка', 'Рез и отступы листа — по типу материала'],
    ...(betaBeam ? [['beamsaw', I.sliders, 'Пильный центр β', 'Уровни резов, повороты, захват, узкие детали, полосы']] : []),
    ['post', I.cnc, 'Постпроцессоры', 'Станки ЧПУ, инструменты, обработка'],
    ['xml', I.file, 'Просмотр XML присадки', 'Программы присадочного станка'],
    ['gsim', I.cnc, 'Симуляция G-кода', 'Любая УП — в том числе из других программ'],
  ] : []
  const btn = kind => ({ padding: '6px 12px', borderRadius: 20, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap', border: kind === 'main' ? 'none' : '0.5px solid var(--border-md)', background: kind === 'main' ? 'var(--blue)' : 'transparent', color: kind === 'main' ? 'white' : 'var(--text-muted)' })

  return (
    <div className="page" style={{ paddingBottom: 100 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 16, paddingTop: 4 }}><MenuButton /><h1 style={{ fontSize: 18, fontWeight: 500 }}>Производство</h1></div>
      {error && <p className="error-text" style={{ marginBottom: 12 }}>{error}</p>}
      {prod === undefined ? <CncLoader label="Открываем производство…" /> : wps.length && (prod ? prodView() === 'work' : prodView() !== 'own') ? (
        <WorkerProduction key={workPid() || 'w'} wps={wps} />
      ) : !prod ? (
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
          {/* вкладки кабинета: заказы, техпроцесс (доска постов), настройки — небольшие, чтобы беречь экран телефона */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 10, alignItems: 'center' }}>
          <div data-tour="prod-tabs" style={{ flex: 1, minWidth: 0, display: 'flex', gap: 4, background: 'var(--bg2)', borderRadius: 18, padding: 3 }}>
            {[['orders', `Заказы${count.all ? ` · ${count.all}` : ''}`], ['board', `Техпроцесс${Object.keys(stages).length ? ` · ${Object.keys(stages).length}` : ''}`], ['settings', '⚙ Настройки']].map(([k, l]) => (
              <button key={k} type="button" data-tour={`prod-tab-${k}`} onClick={() => setTab(k)}
                style={{ flex: 1, padding: '5px 6px', borderRadius: 15, border: 'none', fontSize: 12.5, fontWeight: tab === k ? 600 : 400, whiteSpace: 'nowrap',
                  background: tab === k ? 'var(--bg)' : 'transparent', color: tab === k ? 'var(--blue)' : 'var(--text-muted)', boxShadow: tab === k ? '0 1px 2px rgba(0,0,0,0.12)' : 'none' }}>{l}</button>
            ))}
          </div>
          {/* сканер бирки: деталь в 3D-модели заказа и вверх по структуре — для сборки */}
          <button type="button" title="Сканер бирки — деталь в 3D-модели (сборка)" onClick={() => navigate('/scan')} style={{ flex: '0 0 auto', width: 36, height: 34, borderRadius: 17, border: '0.5px solid var(--blue)', background: 'var(--blue-light)', fontSize: 16, padding: 0, cursor: 'pointer' }}>📷</button>
          </div>

          {tab === 'settings' && (edit ? (
            <div className="card" style={{ marginBottom: 12 }}>
              <ProductionForm initial={prod} submitLabel="Сохранить" onCancel={() => setEdit(false)} onDone={() => { setEdit(false); load() }} />
            </div>
          ) : !setSec ? (
            // разделы настроек — кнопками-строками, как в боковом меню: значок, название, пояснение, ›
            <div className="card" data-tour="prod-settings" style={{ marginBottom: 12, padding: 4 }}>
              {settingsMenu.map(([id, icon, title, sub, cnt], i) => (
                <button key={id} type="button" onClick={() => (id === 'prices' ? setPrices(true) : id === 'xml' ? setXmlView(true) : id === 'gsim' ? setGsim(true) : setSetSec(id))}
                  style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: '10px 10px', border: 'none', borderTop: i ? '0.5px solid var(--border)' : 'none',
                    background: 'transparent', textAlign: 'left', cursor: 'pointer', color: 'var(--text)', borderRadius: 0 }}>
                  <span style={{ width: 34, height: 34, borderRadius: 10, background: 'var(--blue-light)', color: 'var(--blue)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Ico d={icon} size={19} /></span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 14, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}{cnt ? <span style={{ fontWeight: 400, color: 'var(--text-hint)' }}> · {cnt}</span> : null}</span>
                    {sub && <span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-hint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub}</span>}
                  </span>
                  <span style={{ color: 'var(--text-hint)', fontSize: 20, lineHeight: 1, flexShrink: 0 }}>›</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="card" style={{ marginBottom: 12 }}>
              {/* открытый раздел: назад — к списку разделов (и кнопкой «Назад» телефона) */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <button type="button" onClick={() => setSetSec(null)} style={{ background: 'none', border: 'none', color: 'var(--blue)', fontSize: 14, padding: '2px 0', cursor: 'pointer', whiteSpace: 'nowrap' }}>‹ Настройки</button>
                <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 500, textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{(settingsMenu.find(m => m[0] === setSec) || [])[2]}</span>
              </div>
              {setSec === 'company' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 500 }}>{prod.name}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-hint)' }}>{[prod.country, prod.city, prod.phone].filter(Boolean).join(' · ') || 'Страна и телефон не указаны'}</div>
                    {servicesKnown(prod.services)
                      ? <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>Услуги: {serviceBadges(prod.services, betaBeam ? ['beam_saw'] : []).join(' · ') || '—'}</div>
                      : <div style={{ fontSize: 12, color: 'var(--amber)', marginTop: 4 }}>Услуги не указаны — нажмите «Изменить» и ответьте на вопросы «да / нет». Заказчики видят их при выборе производства.</div>}
                  </div>
                  <button type="button" style={btn()} onClick={() => setEdit(true)}>Изменить</button>
                </div>
              )}
              {setSec === 'staff' && <StaffSection bare data={staff.data} error={staff.error} onReload={loadStaff} />}
              {setSec === 'posts' && <PostsSection bare members={staff.data?.members} />}
              {setSec === 'sheet' && <>
                <p style={{ fontSize: 11, color: 'var(--text-hint)', margin: '0 0 6px' }}>Подставляются в раскрой заказчика, когда он выбирает ваше производство, — по типу материала, который он указал в заказе.</p>
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
              </>}
              {/* настройки постпроцессора — дубль окна ЧПУ из заказа: станки можно настроить до заказов */}
              {setSec === 'post' && <CncSetup prodId={prod.id} />}
              {setSec === 'beamsaw' && <BeamSawSettings key={prod.id} prod={prod} onSaved={v => setProd(p => ({ ...p, beam_saw_settings: v }))} />}
            </div>
          ))}

          {tab === 'board' && <ProductionBoard onChange={() => { loadStages(); load() }} />}

          {tab === 'orders' && <>
          <div className="card" style={{ marginBottom: 10, padding: '8px 12px' }}>
                {/* статистика за период: заявки, в работе, исполнено, суммы, листы, объёмы работ. Исполненные считаются и после
                    архива, и после того, как клиент удалил заказ, — от него остаётся запись */}
                <div>
                  {stats ? <Results list={stats.map(x => (x.client_name ? x : { ...x, client_name: x.own ? '' : orders.find(o => o.id === x.id)?.client_name || '' }))} per={per} show={resShow} onShow={saveResShow} onOpen={o => navigate(`/orders/${o.id}`)} test={{ min: testMin, master: isMaster, onExclude: excludeStats, onAsk: askExclude }} /> : (
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
          </div>
          <LimitsBar cabinet="production" refresh={orders.map(o => o.status).join() + archived.size} />
          <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            {FILTERS.map(([id, label]) => (
              <button key={id} type="button" onClick={() => setFilter(id)} style={{ flex: 1, padding: '7px 4px', borderRadius: 20, border: 'none', fontSize: 12, background: filter === id ? 'var(--blue)' : 'var(--bg2)', color: filter === id ? 'white' : 'var(--text-muted)' }}>
                {label}{id !== 'done' && count[id] ? ` · ${count[id]}` : ''}
              </button>
            ))}
          </div>
          {orders.length > 0 && 'gcode_at' in orders[0] && !('sheets' in orders[0]) && <p style={{ fontSize: 11, color: 'var(--amber)', marginBottom: 8 }}>{KIND_HINT}</p>}
          {orders.length > 0 && !('gcode_at' in orders[0]) && <p style={{ fontSize: 11, color: 'var(--amber)', marginBottom: 8 }}>{MARKS_SQL_HINT}</p>}
          {!shown.length && <p style={{ fontSize: 13, color: 'var(--text-hint)', textAlign: 'center', padding: '24px 0' }}>{orders.length ? 'В этом разделе пусто.' : 'Заявок пока нет. Они появятся, когда заказ оформят на ваше производство.'}</p>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {shown.map((o, oi) => {
              const tel = digits(o.client_phone), wa = digits(o.client_whatsapp) || tel
              const isOpen = open.has(o.id)
              return (
                <div key={o.id} data-focus={o.id} data-tour={oi === 0 ? 'prod-order' : undefined} className="card" style={{ padding: isOpen ? '8px 12px 10px' : '7px 12px' }}>
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
                        {shares.has(o.id) && <ShareBadge orderId={o.id} known style={{ alignSelf: 'flex-end', lineHeight: '14px' }} />}
                        {hasPosts && o.status === 'inwork' && !stages[o.id] && <span title="Принят, но ещё не пущен в работу по постам" style={{ fontSize: 11, lineHeight: '16px', color: 'var(--amber)', whiteSpace: 'nowrap' }}>▶ не пущен в работу</span>}
                        {stages[o.id]?.name && <span title="Пост, на котором сейчас заказ" style={{ fontSize: 11, lineHeight: '16px', color: stages[o.id].status === 'queued' ? 'var(--amber)' : 'var(--blue)', whiteSpace: 'nowrap' }}>📍 {stages[o.id].name} · {stages[o.id].done}/{stages[o.id].total}</span>}
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
                    {/* по постам «Исполнен» ставится сам после последнего поста; без маршрута — кнопкой */}
                    {o.status === 'done' && <button type="button" disabled={busy === o.id} style={{ ...btn(), color: 'var(--amber)', borderColor: 'var(--amber)' }} onClick={() => setReopen(o)}>↩ Вернуть в техпроцесс</button>}
                    {o.status === 'inwork' && !stages[o.id] && <button type="button" disabled={busy === o.id} style={btn('main')} onClick={() => finish(o)}>Исполнен</button>}
                    {/* отменить своё «Принять»: пока ни один пост заказ не взял — заказ снова новый */}
                    {o.status === 'inwork' && (!stages[o.id] || (stages[o.id].status === 'queued' && !stages[o.id].done)) && <button type="button" disabled={busy === o.id} style={btn()}
                      onClick={() => { if (window.confirm(`Отменить принятие заказа «${orderTitle(o)}»?\nОн снова станет новой заявкой${stages[o.id] ? ', маршрут по постам сбросится' : ''}.`)) setStatus(o, 'new') }}>✕ Отменить принятие</button>}
                    <button type="button" data-tour={oi === 0 ? 'prod-open' : undefined} style={btn()} onClick={() => navigate(`/orders/${o.id}`)}>Открыть</button>
                    {!o.own && wa && <a href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer" style={{ ...btn(), textDecoration: 'none', color: 'var(--teal)', borderColor: 'var(--teal)' }}>WhatsApp</a>}
                    {o.status !== 'done' && <button type="button" disabled={busy === o.id} style={{ ...btn(), color: 'var(--amber)', borderColor: 'var(--amber)' }} onClick={() => returnOrder(o)}>↩ Вернуть на доработку</button>}
                  </div>
                  <StageTrack orderId={o.id} status={o.status} manage onChange={loadStages} />
                  </>}
                </div>
              )
            })}
          </div>
          </>}
        </>
      )}
      {reopen && <StageReturn reopen orderId={reopen.id} title={orderTitle(reopen)}
        onNoRoute={async () => { const r = await productionSetStatus(reopen.id, 'inwork'); if (r.error) { window.alert(r.error); return false } await productionArchive(reopen.id, false) }}
        onClose={ch => { setReopen(null); if (ch) { setFilter('work'); load(); loadStages() } }} />}
      {gsim && <GcodeFileSim onClose={() => setGsim(false)} />}
      {xmlView && <Drill6Viewer title="Просмотр XML присадки" onClose={() => setXmlView(false)} />}
      {prices && prod && <PriceList production={prod} onClose={() => setPrices(false)} />}
      <BottomNav />
    </div>
  )
}
