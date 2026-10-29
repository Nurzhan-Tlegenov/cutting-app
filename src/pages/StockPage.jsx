// Деловые остатки — склад производства: ввод списком (как деталировка), ячейки хранения, поиск и отбор,
// карточка остатка с быстрыми действиями (ячейка, перерезать, списать) и журналом «кто, когда, что сделал».
// Менять склад могут владелец, начальник производства и ответственные за склад (полномочие «Склад остатков»);
// остальные сотрудники — только смотрят. Открывается: /stock?p=<производство>&id=<номер остатка>.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { MenuButton } from '../components/NavDrawer'
import BottomNav from '../components/BottomNav'
import CncLoader from '../components/CncLoader'
import { useBackClose } from '../lib/backStack'
import { myProduction } from '../lib/productionApi'
import { myWorkplaces, workPid, prodView } from '../lib/workplaces'
import { supabase } from '../lib/supabase'
import {
  stockInfo, stockList, stockEvents, stockJournal, stockAdd, stockEdit, stockCell, stockRecut, stockWriteoff, stockRestore, stockDelete,
  stockSetSettings, stockAllEvents, KINDS, kindText, sizeText, num, normMaterial, eventText, dateText, dayText,
} from '../lib/stock'
import { readStockFile, exportStockXlsx, stockFileName } from '../lib/stockExcel'
import { backupSupported, backupConf, chooseBackupFile, setBackupHours, stopBackup, backupPermission, runBackup, BACKUP_HOURS } from '../lib/stockBackup'

const pill = on => ({ padding: '6px 11px', borderRadius: 16, border: 'none', fontSize: 12.5, cursor: 'pointer', whiteSpace: 'nowrap', background: on ? 'var(--blue)' : 'var(--bg2)', color: on ? 'white' : 'var(--text-muted)' })
const btn = kind => ({ padding: '8px 14px', borderRadius: 20, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap', border: kind === 'main' ? 'none' : kind === 'danger' ? '0.5px solid var(--danger)' : '0.5px solid var(--border-md)', background: kind === 'main' ? 'var(--blue)' : 'transparent', color: kind === 'main' ? 'white' : kind === 'danger' ? 'var(--danger)' : 'var(--text)' })
const bigBtn = { flex: '1 1 45%', minWidth: 0, padding: '12px 8px', borderRadius: 12, border: '0.5px solid var(--border-md)', background: 'var(--bg2)', fontSize: 14, fontWeight: 500, cursor: 'pointer', color: 'var(--text)' }
const lbl = { display: 'block', fontSize: 11, color: 'var(--text-muted)', minWidth: 0 }
const inp = { padding: '7px 8px', fontSize: 14, width: '100%' }
const SORTS = [['new', 'Новые сверху'], ['big', 'Крупные сверху'], ['small', 'Мелкие сверху'], ['mat', 'По материалу'], ['cell', 'По ячейке']]
const PERIODS = [[7, '7 дней'], [30, '30 дней'], [90, '90 дней'], [0, 'Всё время']]
const emptyRow = () => ({ k: Math.random().toString(36).slice(2), length: '', width: '', qty: '1', note: '' })
const cleanNum = v => v.replace(/[^0-9.,]/g, '')

export default function StockPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const loc = useLocation()
  const params = new URLSearchParams(loc.search)
  const [pid, setPid] = useState(params.get('p') || '')
  const [info, setInfo] = useState(null)          // { access: edit|view, settings, name, owner }
  const [rows, setRows] = useState(null)
  const [error, setError] = useState('')
  const [tab, setTab] = useState('free')          // free | nocell | used | journal
  const [q, setQ] = useState('')
  const [sort, setSort] = useState('new')
  const [adding, setAdding] = useState(false)
  const [openId, setOpenId] = useState(() => Number(params.get('id')) || null)
  const [showSet, setShowSet] = useState(false)
  const [imp, setImp] = useState(null)            // прочитанный файл Excel — ждёт подтверждения
  const [exporting, setExporting] = useState(false)
  const edit = info?.access === 'edit'

  // какое производство: из ссылки, своё или рабочее место сотрудника
  useEffect(() => {
    if (pid) return
    let alive = true
    ;(async () => {
      const own = await myProduction(user?.id)
      const w = await myWorkplaces()
      const wps = w.data || []
      const pick = (prodView() === 'work' || !own) && wps.length ? (wps.find(x => x.production_id === workPid()) || wps[0]).production_id : own?.id
      if (!alive) return
      if (pick) setPid(pick); else setError('Склад остатков есть у производства. У вас нет своего производства и рабочего места.')
    })()
    return () => { alive = false }
  }, [pid, user?.id])

  const load = async () => {
    if (!pid) return
    const [a, b] = await Promise.all([stockInfo(pid), stockList(pid)])
    if (a.error || b.error) { setError(a.error || b.error); setRows([]); return }
    setError(''); setInfo(a.data); setRows(b.data)
  }
  useEffect(() => { Promise.resolve().then(load) }, [pid])   // eslint-disable-line react-hooks/exhaustive-deps

  // подсказки: материалы из склада и своих заказов, ячейки — из склада
  const [orderMats, setOrderMats] = useState([])
  useEffect(() => {
    let alive = true
    supabase.from('orders').select('material_name').eq('user_id', user?.id || '').neq('material_name', '').limit(300)
      .then(({ data }) => { if (alive) setOrderMats((data || []).map(x => x.material_name)) })
    return () => { alive = false }
  }, [user?.id])
  const materials = useMemo(() => [...new Set([...(rows || []).map(r => r.material), ...orderMats].map(s => String(s || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru')), [rows, orderMats])
  const cells = useMemo(() => [...new Set((rows || []).filter(r => r.status !== 'used').map(r => r.cell).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru', { numeric: true })), [rows])

  const live = (rows || []).filter(r => r.status !== 'used')
  const count = { free: live.length, nocell: live.filter(r => !r.cell).length, used: (rows || []).length - live.length }
  const shown = useMemo(() => {
    const t = normMaterial(q)
    let list = (rows || []).filter(r => (tab === 'used' ? r.status === 'used' : r.status !== 'used') && (tab !== 'nocell' || !r.cell))
    if (t) list = list.filter(r => normMaterial(`${r.material} ${r.cell || ''} ${r.note || ''} ${r.id} ${r.length}x${r.width}`).includes(t) || String(r.id) === q.trim())
    const area = r => num(r.length) * num(r.width)
    const by = { new: (a, b) => b.id - a.id, big: (a, b) => area(b) - area(a), small: (a, b) => area(a) - area(b),
      mat: (a, b) => a.material.localeCompare(b.material, 'ru') || area(b) - area(a),
      cell: (a, b) => (a.cell ? 0 : 1) - (b.cell ? 0 : 1) || String(a.cell || '').localeCompare(String(b.cell || ''), 'ru', { numeric: true }) || area(b) - area(a) }
    return [...list].sort(tab === 'used' ? (a, b) => String(b.used_at || '').localeCompare(String(a.used_at || '')) : by[sort])
  }, [rows, tab, q, sort])
  const totalPcs = shown.reduce((s, r) => s + (r.qty || 1), 0)
  const totalM2 = shown.reduce((s, r) => s + num(r.length) * num(r.width) * (r.qty || 1), 0) / 1e6

  const open = (rows || []).find(r => r.id === openId)
  useBackClose(!!openId, () => setOpenId(null))
  useBackClose(adding, () => setAdding(false))

  return (
    <div className="page" style={{ paddingBottom: 100 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 10, paddingTop: 4 }}>
        <MenuButton />
        <h1 style={{ fontSize: 18, fontWeight: 500, flex: 1, minWidth: 0 }}>Деловые остатки</h1>
        {info?.owner && <button type="button" title="Настройки склада" onClick={() => setShowSet(v => !v)} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', padding: 6 }}>⚙</button>}
      </div>
      <button type="button" onClick={() => navigate('/production')} style={{ background: 'none', border: 'none', color: 'var(--blue)', fontSize: 13, padding: '0 0 8px', cursor: 'pointer' }}>‹ {info?.name || 'Производство'}</button>
      {error && <p className="error-text" style={{ marginBottom: 12 }}>{error}</p>}
      {!error && (rows === null || !info) ? <CncLoader label="Открываем склад…" /> : info && <>
        {info.access === 'view' && <p style={{ fontSize: 12, color: 'var(--text-muted)', background: 'var(--bg2)', borderRadius: 10, padding: '6px 10px', marginBottom: 10 }}>Только просмотр. Вносить, перерезать и списывать остатки могут ответственные за склад.</p>}
        {showSet && info.owner && <StockSettings pid={pid} settings={info.settings || {}} onSaved={s => setInfo(i => ({ ...i, settings: s }))} />}

        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
          {edit && !adding && <button type="button" style={{ ...btn('main'), flex: 1, padding: '10px 14px' }} onClick={() => setAdding(true)}>+ Внести остатки</button>}
          {edit && <label style={{ ...btn(), padding: '10px 12px', display: 'inline-flex', alignItems: 'center' }} title="Загрузить готовую таблицу остатков (.xlsx, .xls, .csv)">
            Из Excel<input type="file" accept=".xlsx,.xls,.csv,.txt" style={{ display: 'none' }} onChange={async e => {
              const f = e.target.files?.[0]; e.target.value = ''
              if (!f) return
              try { setImp({ ...(await readStockFile(f)), file: f.name }) } catch (x) { setError('Не удалось прочитать файл: ' + String(x?.message || x)) }
            }} /></label>}
          <button type="button" disabled={exporting} style={{ ...btn(), padding: '10px 12px', flex: edit ? '0 0 auto' : 1 }} title="Скачать весь склад и журнал в Excel — резервная копия" onClick={async () => {
            setExporting(true)
            const ev = await stockAllEvents(pid)
            try { await exportStockXlsx(rows || [], ev.data || [], info.name) } catch (x) { setError('Не удалось выгрузить: ' + String(x?.message || x)) }
            setExporting(false)
          }}>{exporting ? '…' : '⬇ В Excel'}</button>
        </div>
        <BackupBox pid={pid} prodName={info.name} />
        {imp && <ImportPreview imp={imp} pid={pid} materials={materials} onClose={() => setImp(null)} onSaved={load} />}
        {adding && <AddRows pid={pid} materials={materials} cells={cells} onClose={() => setAdding(false)} onSaved={load} />}

        <div style={{ display: 'flex', gap: 5, marginBottom: 8, flexWrap: 'wrap' }}>
          {[['free', `На складе · ${count.free}`], ['nocell', `Без ячейки · ${count.nocell}`], ['used', `Списанные · ${count.used}`], ['journal', 'Журнал']].map(([k, l]) => (
            <button key={k} type="button" style={pill(tab === k)} onClick={() => setTab(k)}>{l}</button>
          ))}
        </div>

        {tab === 'journal' ? <Journal pid={pid} onOpen={setOpenId} /> : <>
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            <input type="search" placeholder="Поиск: материал, ячейка, №, размер" value={q} onChange={e => setQ(e.target.value)} style={{ ...inp, flex: 1 }} />
            {tab !== 'used' && <select value={sort} onChange={e => setSort(e.target.value)} style={{ padding: '6px', fontSize: 13, width: 140, flex: '0 0 auto' }}>{SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>}
          </div>
          {!!cells.length && tab !== 'used' && (
            <div style={{ display: 'flex', gap: 4, marginBottom: 8, overflowX: 'auto' }}>
              {cells.slice(0, 30).map(c => <button key={c} type="button" style={{ ...pill(q === c), padding: '3px 9px', fontSize: 11.5 }} onClick={() => setQ(q === c ? '' : c)}>{c}</button>)}
            </div>
          )}
          <div style={{ fontSize: 11.5, color: 'var(--text-hint)', marginBottom: 6 }}>{shown.length} строк · {totalPcs} шт · {totalM2.toFixed(2)} м²</div>
          {!shown.length ? <p style={{ fontSize: 13, color: 'var(--text-hint)', textAlign: 'center', padding: '18px 0' }}>{(rows || []).length ? 'Ничего не найдено.' : 'Склад пуст. Внесите остатки — строка за строкой, как детали в бланке заказа.'}</p> : (
            <div className="card" style={{ padding: 0 }}>
              {shown.map((r, i) => <RemRow key={r.id} r={r} first={!i} onOpen={() => setOpenId(r.id)} />)}
            </div>
          )}
        </>}
      </>}
      {open && <RemCard r={open} edit={edit} cells={cells} materials={materials} settings={info?.settings || {}} onClose={() => setOpenId(null)} onChanged={async id => { await load(); if (id) setOpenId(id) }} />}
      {openId && rows && !open && <div className="modal-backdrop" onClick={() => setOpenId(null)} style={backdrop}><div style={sheet} onClick={e => e.stopPropagation()}><p style={{ fontSize: 14 }}>Остаток №{openId} не найден на этом складе — возможно, его удалили.</p><button type="button" style={btn()} onClick={() => setOpenId(null)}>Закрыть</button></div></div>}
      <BottomNav />
    </div>
  )
}

/** Строка списка: №, размер, кол-во, материал, ячейка, бирка */
function RemRow({ r, first, onOpen }) {
  return (
    <button type="button" onClick={onOpen} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '9px 12px', border: 'none', borderTop: first ? 'none' : '0.5px solid var(--border)', background: 'transparent', textAlign: 'left', cursor: 'pointer', color: 'var(--text)' }}>
      <span style={{ fontSize: 11, color: 'var(--text-hint)', width: 34, flexShrink: 0 }}>№{r.id}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 14.5, fontWeight: 600 }}>{sizeText(r)}{r.qty > 1 && <span style={{ fontWeight: 500, color: 'var(--blue)' }}> × {r.qty} шт</span>}</span>
        <span style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.material || 'материал не указан'}{r.thickness ? ` · ${r.thickness} мм` : ''}{r.note ? ` · ${r.note}` : ''}</span>
      </span>
      <span style={{ textAlign: 'right', flexShrink: 0 }}>
        {r.status === 'used' ? <span style={{ display: 'block', fontSize: 11.5, color: 'var(--danger)' }}>{kindText(r.used_kind)} · {dayText(r.used_at)}</span>
          : r.cell ? <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--teal)' }}>{r.cell}</span>
          : <span style={{ display: 'block', fontSize: 11.5, color: 'var(--amber)' }}>ячейка не указана</span>}
        {r.status === 'reserved' && <span style={{ display: 'block', fontSize: 11, color: 'var(--amber)' }}>в резерве</span>}
        <span style={{ display: 'block', fontSize: 10.5, color: r.label_at ? 'var(--text-hint)' : 'var(--text-hint)', opacity: r.label_at ? 1 : 0.6 }}>{r.label_at ? `🏷 ${dayText(r.label_at)}` : 'без бирки'}</span>
      </span>
    </button>
  )
}

/** Ввод остатков списком: общие материал / толщина / ячейка, строки длина × ширина × кол-во. Enter ведёт дальше. */
function AddRows({ pid, materials, cells, onClose, onSaved }) {
  const [common, setCommon] = useState({ material: '', thickness: '', cell: '' })
  const [list, setList] = useState([emptyRow()])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const refs = useRef({})
  const focus = (k, f) => { const go = () => { const el = refs.current[`${k}:${f}`]; if (el) { el.focus(); el.select?.() } return !!el }; if (!go()) setTimeout(go, 50) }
  const set = (k, f, v) => setList(l => l.map(x => (x.k === k ? { ...x, [f]: v } : x)))
  const onKey = (i, f) => e => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    const r = list[i]
    if (f === 'length') return focus(r.k, 'width')
    if (f === 'width') return focus(r.k, 'qty')
    if (i < list.length - 1) return focus(list[i + 1].k, 'length')
    const n = emptyRow(); setList(l => [...l, n]); focus(n.k, 'length')
  }
  const ready = list.filter(r => num(r.length) > 0 && num(r.width) > 0)
  const save = async () => {
    if (!ready.length) { setErr('Введите хотя бы одну строку: длину и ширину.'); return }
    setBusy(true); setErr('')
    const res = await stockAdd(pid, ready.map(r => ({ length: num(r.length), width: num(r.width), qty: Math.max(1, Math.round(num(r.qty) || 1)), material: common.material, thickness: common.thickness ? num(common.thickness) : '', cell: common.cell, note: r.note })))
    setBusy(false)
    if (res.error) { setErr(res.error); return }
    await onSaved()
    setList([emptyRow()]); focus(null, null)
  }
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Внести остатки</div>
      <p style={{ fontSize: 11.5, color: 'var(--text-hint)', margin: '0 0 8px' }}>Материал и ячейка — общие для строк ниже (поменяли — следующие строки пойдут с новыми). Ячейку можно оставить пустой и вписать потом.</p>
      <datalist id="stock-mats">{materials.map(m => <option key={m} value={m} />)}</datalist>
      <datalist id="stock-cells">{cells.map(c => <option key={c} value={c} />)}</datalist>
      <label style={lbl}>Материал<input list="stock-mats" value={common.material} onChange={e => setCommon(c => ({ ...c, material: e.target.value }))} placeholder="ЛДСП Белый 16 мм" style={inp} /></label>
      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
        <label style={{ ...lbl, flex: 1 }}>Толщина, мм<input inputMode="decimal" value={common.thickness} onChange={e => setCommon(c => ({ ...c, thickness: cleanNum(e.target.value) }))} placeholder="если нет в названии" style={inp} /></label>
        <label style={{ ...lbl, flex: 1 }}>Ячейка<input list="stock-cells" value={common.cell} onChange={e => setCommon(c => ({ ...c, cell: e.target.value }))} placeholder="А-3 / пусто" style={inp} /></label>
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 10, fontSize: 11, color: 'var(--text-muted)' }}>
        <span style={{ flex: 3 }}>Длина</span><span style={{ flex: 3 }}>Ширина</span><span style={{ flex: 2 }}>Кол-во</span><span style={{ flex: 4 }}>Примечание</span><span style={{ width: 24 }} />
      </div>
      {list.map((r, i) => (
        <div key={r.k} style={{ display: 'flex', gap: 6, marginTop: 4, alignItems: 'center' }}>
          {[['length', 3], ['width', 3], ['qty', 2]].map(([f, fl]) => (
            <input key={f} ref={el => { refs.current[`${r.k}:${f}`] = el }} inputMode={f === 'qty' ? 'numeric' : 'decimal'} enterKeyHint="next" value={r[f]}
              onChange={e => set(r.k, f, cleanNum(e.target.value))} onKeyDown={onKey(i, f)} onFocus={e => e.target.select()} style={{ ...inp, flex: fl, minWidth: 0 }} />
          ))}
          <input value={r.note} onChange={e => set(r.k, 'note', e.target.value)} style={{ ...inp, flex: 4, minWidth: 0 }} />
          <button type="button" title="Убрать строку" onClick={() => setList(l => (l.length > 1 ? l.filter(x => x.k !== r.k) : [emptyRow()]))} style={{ width: 24, border: 'none', background: 'none', color: 'var(--text-hint)', fontSize: 16, cursor: 'pointer', padding: 0 }}>×</button>
        </div>
      ))}
      <button type="button" style={{ ...btn(), marginTop: 8, fontSize: 12 }} onClick={() => { const n = emptyRow(); setList(l => [...l, n]); focus(n.k, 'length') }}>+ Строка</button>
      {err && <p className="error-text" style={{ marginTop: 8 }}>{err}</p>}
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button type="button" disabled={busy} style={{ ...btn('main'), flex: 1 }} onClick={save}>{busy ? 'Сохраняю…' : `Сохранить${ready.length ? ` · ${ready.length} стр., ${ready.reduce((s, r) => s + Math.max(1, Math.round(num(r.qty) || 1)), 0)} шт` : ''}`}</button>
        <button type="button" style={btn()} onClick={onClose}>Закрыть</button>
      </div>
    </div>
  )
}

/** Автокопия склада в файл на компьютере: выбрать файл, как часто, состояние */
function BackupBox({ pid, prodName }) {
  const [conf, setConf] = useState(() => backupConf(pid))
  const [open, setOpen] = useState(false)
  const [perm, setPerm] = useState('')
  const [msg, setMsg] = useState('')
  const ok = backupSupported()
  useEffect(() => {
    const on = e => { if (e.detail === pid) setConf(backupConf(pid)) }
    window.addEventListener('stock-backup', on)
    return () => window.removeEventListener('stock-backup', on)
  }, [pid])
  useEffect(() => { let alive = true; if (ok && conf) backupPermission(pid).then(p => { if (alive) setPerm(p) }); return () => { alive = false } }, [pid, ok, conf])
  const res = r => setMsg(r.error === 'need-permission' ? 'Браузер просит разрешение — нажмите «Разрешить запись».' : r.error ? 'Не получилось: ' + r.error : r.skipped ? 'Изменений не было — файл уже свежий.' : 'Копия сохранена.')
  const choose = async () => {
    setMsg('')
    try { res(await chooseBackupFile(pid, prodName, stockFileName(prodName))); setPerm('granted') } catch (e) { if (e?.name !== 'AbortError') setMsg('Не получилось: ' + String(e?.message || e)) }
  }
  const need = conf && perm && perm !== 'granted'
  const t = iso => (iso ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—')
  return (
    <div style={{ marginBottom: 10, fontSize: 12.5 }}>
      <button type="button" onClick={() => setOpen(v => !v)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: need ? 'var(--amber)' : 'var(--text-muted)', fontSize: 12.5, textAlign: 'left' }}>
        💾 Автокопия в файл: {conf ? `${conf.file} · ${(BACKUP_HOURS.find(h => h[0] === conf.hours) || ['', ''])[1]} · последняя ${t(conf.savedAt)}${need ? ' · нужно разрешение' : ''}` : 'выключена'} {open ? '▴' : '▾'}
      </button>
      {open && (
        <div className="card" style={{ marginTop: 6 }}>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 8px' }}>
            Резервная копия склада у вас на компьютере: файл Excel (остатки и журнал) сам перезаписывается, пока приложение открыто. Пишется только если на складе что-то поменялось и в свободную минуту — работе не мешает.
          </p>
          <p style={{ fontSize: 12, margin: '0 0 8px', padding: '6px 8px', borderRadius: 8, background: 'var(--bg2)' }}>
            Работает на компьютере в браузерах <b>Chrome, Edge, Яндекс.Браузер, Opera</b>. В Firefox, Safari и на телефоне автокопии нет — там скачивайте склад кнопкой «⬇ В Excel».
            {' '}Файл удобно положить в папку облака (Яндекс.Диск, Google Диск, OneDrive) — копия будет и вне компьютера.
          </p>
          {!ok ? <p style={{ fontSize: 12.5, color: 'var(--amber)' }}>В этом браузере автокопия недоступна.</p> : <>
            {conf && <label style={{ ...lbl, marginBottom: 8, maxWidth: 260 }}>Как часто перезаписывать
              <select value={conf.hours} onChange={e => setBackupHours(pid, Number(e.target.value))} style={{ padding: 6, fontSize: 13 }}>{BACKUP_HOURS.map(([h, l]) => <option key={h} value={h}>{l}</option>)}</select></label>}
            {need && <p style={{ fontSize: 12, color: 'var(--amber)', margin: '0 0 6px' }}>После перезапуска браузера он один раз спрашивает разрешение на запись в файл.</p>}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {need && <button type="button" style={btn('main')} onClick={async () => { const p = await backupPermission(pid, true); setPerm(p); if (p === 'granted') res(await runBackup(pid)) }}>Разрешить запись</button>}
              <button type="button" style={conf ? btn() : btn('main')} onClick={choose}>{conf ? 'Другой файл' : 'Выбрать файл и включить'}</button>
              {conf && !need && <button type="button" style={btn()} onClick={async () => res(await runBackup(pid, { force: true }))}>Сохранить сейчас</button>}
              {conf && <button type="button" style={btn()} onClick={async () => { await stopBackup(pid); setMsg('Автокопия выключена. Файл остался на компьютере.') }}>Выключить</button>}
            </div>
            <p style={{ fontSize: 11.5, color: 'var(--text-hint)', margin: '6px 0 0' }}>Настраивается на каждом компьютере отдельно. По умолчанию — каждые 3 часа.</p>
          </>}
          {msg && <p style={{ fontSize: 12.5, margin: '6px 0 0' }}>{msg}</p>}
        </div>
      )}
    </div>
  )
}

/** Импорт из Excel: что нашлось в файле, общий материал / ячейка, если в таблице их нет, — и «Добавить на склад» */
function ImportPreview({ imp, pid, materials, onClose, onSaved }) {
  const [mat, setMat] = useState('')
  const [cell, setCell] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const pcs = imp.items.reduce((a, x) => a + x.qty, 0)
  const save = async () => {
    setBusy(true); setErr('')
    const rows = imp.items.map(x => ({ ...x, material: x.material || mat, cell: x.cell || cell }))
    for (let i = 0; i < rows.length; i += 500) {          // большие таблицы — частями
      const r = await stockAdd(pid, rows.slice(i, i + 500))
      if (r.error) { setBusy(false); setErr(r.error + (i ? ` Добавлено до строки ${i}.` : '')); return }
    }
    setBusy(false)
    await onSaved()
    onClose()
  }
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 14, fontWeight: 600 }}>Импорт из Excel</div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', margin: '2px 0 8px' }}>{imp.file}{imp.sheet && imp.sheet !== imp.file ? ` · лист «${imp.sheet}»` : ''}</div>
      {!imp.items.length ? <p style={{ fontSize: 13 }}>Не нашлось ни одного остатка. Нужны колонки «Длина» и «Ширина» (можно «Кол-во», «Материал», «Толщина», «Ячейка», «Примечание») — или два числа в строке.</p> : <>
        <p style={{ fontSize: 13, margin: '0 0 6px' }}>Найдено <b>{imp.items.length}</b> строк, <b>{pcs}</b> шт.{imp.skipped ? ` Пропущено строк без размера: ${imp.skipped}.` : ''}</p>
        {!imp.hasMaterial && <label style={lbl}>В таблице нет материала — для всех строк<input list="stock-mats-imp" value={mat} onChange={e => setMat(e.target.value)} placeholder="ЛДСП Белый 16 мм" style={inp} /></label>}
        <datalist id="stock-mats-imp">{materials.map(m => <option key={m} value={m} />)}</datalist>
        {!imp.hasCell && <label style={{ ...lbl, marginTop: 6 }}>Ячейка для всех (необязательно)<input value={cell} onChange={e => setCell(e.target.value)} placeholder="пусто — вписать потом" style={inp} /></label>}
        <div style={{ maxHeight: 220, overflowY: 'auto', marginTop: 8, border: '0.5px solid var(--border)', borderRadius: 8 }}>
          {imp.items.slice(0, 200).map((x, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, fontSize: 12.5, padding: '4px 8px', borderTop: i ? '0.5px solid var(--border)' : 'none' }}>
              <span style={{ fontWeight: 600, minWidth: 92 }}>{sizeText(x)}{x.qty > 1 ? ` ×${x.qty}` : ''}</span>
              <span style={{ flex: 1, minWidth: 0, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.material || mat || '—'}{x.thickness ? ` · ${x.thickness} мм` : ''}{x.note ? ` · ${x.note}` : ''}</span>
              <span style={{ color: 'var(--teal)' }}>{x.cell || cell}</span>
            </div>
          ))}
          {imp.items.length > 200 && <div style={{ fontSize: 12, padding: '4px 8px', color: 'var(--text-hint)' }}>…и ещё {imp.items.length - 200}</div>}
        </div>
        <p style={{ fontSize: 11.5, color: 'var(--text-hint)', margin: '6px 0 0' }}>Строки добавятся к складу как новые остатки (не заменят имеющиеся). В журнале будет записано, кто их внёс.</p>
      </>}
      {err && <p className="error-text" style={{ marginTop: 8 }}>{err}</p>}
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        {!!imp.items.length && <button type="button" disabled={busy} style={{ ...btn('main'), flex: 1 }} onClick={save}>{busy ? 'Добавляю…' : `Добавить на склад · ${pcs} шт`}</button>}
        <button type="button" style={btn()} onClick={onClose}>Отмена</button>
      </div>
    </div>
  )
}

const backdrop = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 300, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }
const sheet = { background: 'var(--bg)', width: '100%', maxWidth: 560, maxHeight: '92vh', overflowY: 'auto', borderRadius: '16px 16px 0 0', padding: '14px 16px calc(18px + env(safe-area-inset-bottom))' }

/** Карточка остатка: крупно размер и ячейка, быстрые действия, журнал */
function RemCard({ r, edit, cells, materials, settings, onClose, onChanged }) {
  const [mode, setMode] = useState('')         // '' | cell | recut | writeoff | edit
  const [ev, setEv] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [f, setF] = useState({})
  const needReason = !!settings.reasonRequired
  useEffect(() => { let alive = true; stockEvents(r.id).then(x => { if (alive) setEv(x.data || []) }); return () => { alive = false } }, [r.id, r.updated_at, r.qty, r.status])
  const go = m => { setErr(''); setMode(m); setF(m === 'cell' ? { cell: r.cell || '' } : m === 'recut' ? { length: String(r.length), width: String(r.width), reason: '' } : m === 'writeoff' ? { kind: '', qty: String(r.qty), reason: '' } : m === 'edit' ? { length: String(r.length), width: String(r.width), qty: String(r.qty), material: r.material, thickness: r.thickness ?? '', note: r.note || '' } : {}) }
  const run = async (fn, nextId) => {
    setBusy(true); setErr('')
    const res = await fn()
    setBusy(false)
    if (res.error) { setErr(res.error); return false }
    setMode('')
    await onChanged(nextId ? nextId(res.data) : r.id)
    return true
  }
  const reasonOk = !needReason || String(f.reason || '').trim()
  const used = r.status === 'used'
  return (
    <div style={backdrop} onClick={onClose}>
      <div style={sheet} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, color: 'var(--text-hint)' }}>Остаток №{r.id}{r.source === 'nesting' ? ' · из раскроя' : ''}</div>
            <div style={{ fontSize: 24, fontWeight: 700, lineHeight: 1.2 }}>{sizeText(r)}{r.qty > 1 && <span style={{ fontSize: 18, color: 'var(--blue)' }}> × {r.qty} шт</span>}</div>
            <div style={{ fontSize: 14, color: 'var(--text-muted)' }}>{r.material || 'материал не указан'}{r.thickness ? ` · ${r.thickness} мм` : ''}</div>
          </div>
          <button type="button" onClick={onClose} style={{ border: 'none', background: 'none', fontSize: 22, color: 'var(--text-hint)', cursor: 'pointer', padding: 0, lineHeight: 1 }}>×</button>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          {used ? <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--danger)' }}>Списан: {kindText(r.used_kind).toLowerCase()} · {dateText(r.used_at)}</span>
            : <span style={{ fontSize: 15, padding: '4px 12px', borderRadius: 10, fontWeight: 600, background: r.cell ? 'var(--teal-light, var(--bg2))' : 'var(--amber-light, var(--bg2))', color: r.cell ? 'var(--teal)' : 'var(--amber)' }}>{r.cell ? `Ячейка ${r.cell}` : 'Ячейка не указана'}</span>}
          {r.status === 'reserved' && <span style={{ fontSize: 12.5, color: 'var(--amber)' }}>в резерве за заказом</span>}
          <span style={{ fontSize: 12, color: 'var(--text-hint)' }}>{r.label_at ? `🏷 бирка выпущена ${dayText(r.label_at)}` : 'бирка не выпущена'}</span>
        </div>
        {r.note && <div style={{ fontSize: 13, marginTop: 8, color: 'var(--text-muted)' }}>{r.note}</div>}

        {edit && !mode && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
            {!used && <button type="button" style={bigBtn} onClick={() => go('cell')}>📦 {r.cell ? 'Сменить ячейку' : 'Указать ячейку'}</button>}
            {r.status === 'free' && <button type="button" style={bigBtn} onClick={() => go('recut')}>✂ Перерезать</button>}
            {!used && <button type="button" style={{ ...bigBtn, color: 'var(--danger)' }} onClick={() => go('writeoff')}>Списать</button>}
            {used && <button type="button" style={bigBtn} onClick={() => run(() => stockRestore(r.id))}>↩ Вернуть на склад</button>}
            <button type="button" style={bigBtn} onClick={() => go('edit')}>✎ Исправить</button>
          </div>
        )}

        {mode === 'cell' && (
          <div style={{ marginTop: 14 }}>
            <label style={lbl}>Ячейка хранения<input autoFocus list="stock-cells-card" value={f.cell} onChange={e => setF(x => ({ ...x, cell: e.target.value }))} onKeyDown={e => { if (e.key === 'Enter') run(() => stockCell(r.id, f.cell)) }} placeholder="А-3" style={{ ...inp, fontSize: 18 }} /></label>
            <datalist id="stock-cells-card">{cells.map(c => <option key={c} value={c} />)}</datalist>
            {!!cells.length && <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 6 }}>{cells.slice(0, 24).map(c => <button key={c} type="button" style={{ ...pill(f.cell === c), padding: '5px 10px' }} onClick={() => run(() => stockCell(r.id, c))}>{c}</button>)}</div>}
            <Actions busy={busy} ok="Сохранить" onOk={() => run(() => stockCell(r.id, f.cell))} onCancel={() => setMode('')} />
          </div>
        )}

        {mode === 'recut' && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 13, marginBottom: 6 }}>Новый размер остатка{r.qty > 1 ? ' (перерезается 1 шт из ' + r.qty + ' — она станет отдельной строкой)' : ''}:</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <label style={{ ...lbl, flex: 1 }}>Длина<input autoFocus inputMode="decimal" value={f.length} onFocus={e => e.target.select()} onChange={e => setF(x => ({ ...x, length: cleanNum(e.target.value) }))} style={{ ...inp, fontSize: 18 }} /></label>
              <label style={{ ...lbl, flex: 1 }}>Ширина<input inputMode="decimal" value={f.width} onFocus={e => e.target.select()} onChange={e => setF(x => ({ ...x, width: cleanNum(e.target.value) }))} style={{ ...inp, fontSize: 18 }} /></label>
            </div>
            <Reason f={f} setF={setF} need={needReason} hint="например: упилил под брак заказа 261029_004" />
            <p style={{ fontSize: 11.5, color: 'var(--text-hint)', margin: '6px 0 0' }}>Старая бирка станет неверной — перепечатайте её с новым размером.</p>
            <Actions busy={busy} ok="Сохранить новый размер" disabled={!(num(f.length) > 0 && num(f.width) > 0) || !reasonOk} onOk={() => run(() => stockRecut(r.id, num(f.length), num(f.width), f.reason), id => id)} onCancel={() => setMode('')} />
          </div>
        )}

        {mode === 'writeoff' && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 13, marginBottom: 6 }}>Куда ушёл остаток:</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{KINDS.map(([k, l]) => <button key={k} type="button" style={{ ...pill(f.kind === k), padding: '8px 14px', fontSize: 14 }} onClick={() => setF(x => ({ ...x, kind: k }))}>{l}</button>)}</div>
            {r.qty > 1 && <label style={{ ...lbl, marginTop: 8, maxWidth: 160 }}>Сколько штук из {r.qty}<input inputMode="numeric" value={f.qty} onFocus={e => e.target.select()} onChange={e => setF(x => ({ ...x, qty: e.target.value.replace(/\D/g, '') }))} style={inp} /></label>}
            <Reason f={f} setF={setF} need={needReason} hint="например: брак на кромке, заказ 261029_004" />
            <Actions busy={busy} ok="Списать" danger disabled={!f.kind || !reasonOk} onOk={() => run(() => stockWriteoff(r.id, Math.max(1, Math.min(r.qty, Math.round(num(f.qty) || r.qty))), f.kind, f.reason))} onCancel={() => setMode('')} />
          </div>
        )}

        {mode === 'edit' && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 12, color: 'var(--text-hint)', marginBottom: 6 }}>Исправить ошибку ввода. Если от остатка отрезали кусок — лучше «Перерезать»: так в журнале видно, что его перерезали.</div>
            <div style={{ display: 'flex', gap: 6 }}>
              {[['length', 'Длина'], ['width', 'Ширина'], ['qty', 'Кол-во']].map(([k, l]) => <label key={k} style={{ ...lbl, flex: 1 }}>{l}<input inputMode="decimal" value={f[k]} onChange={e => setF(x => ({ ...x, [k]: cleanNum(e.target.value) }))} style={inp} /></label>)}
            </div>
            <datalist id="stock-mats-card">{materials.map(m => <option key={m} value={m} />)}</datalist>
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <label style={{ ...lbl, flex: 3 }}>Материал<input list="stock-mats-card" value={f.material} onChange={e => setF(x => ({ ...x, material: e.target.value }))} style={inp} /></label>
              <label style={{ ...lbl, flex: 1 }}>Толщина<input inputMode="decimal" value={f.thickness} onChange={e => setF(x => ({ ...x, thickness: cleanNum(String(e.target.value)) }))} style={inp} /></label>
            </div>
            <label style={{ ...lbl, marginTop: 6 }}>Примечание<input value={f.note} onChange={e => setF(x => ({ ...x, note: e.target.value }))} style={inp} /></label>
            <Actions busy={busy} ok="Сохранить" disabled={!(num(f.length) > 0 && num(f.width) > 0)}
              onOk={() => run(() => stockEdit(r.id, { length: num(f.length), width: num(f.width), qty: Math.max(1, Math.round(num(f.qty) || 1)), material: f.material, thickness: f.thickness === '' ? '' : num(f.thickness), note: f.note }))} onCancel={() => setMode('')} />
            <button type="button" style={{ ...btn('danger'), marginTop: 12, fontSize: 12 }} disabled={busy} onClick={() => {
              const why = window.prompt(`Удалить остаток №${r.id} насовсем? Запись об удалении (кто и когда) останется в журнале.\nПричина (необязательно):`, '')
              if (why !== null) run(() => stockDelete(r.id, why), () => null).then(ok => { if (ok) onClose() })
            }}>Удалить насовсем</button>
          </div>
        )}
        {err && <p className="error-text" style={{ marginTop: 8 }}>{err}</p>}

        <div style={{ marginTop: 16, fontSize: 13, fontWeight: 600 }}>История</div>
        {ev === null ? <p style={{ fontSize: 12, color: 'var(--text-hint)' }}>Загружаю…</p> : !ev.length ? <p style={{ fontSize: 12, color: 'var(--text-hint)' }}>Пусто.</p> : (
          <div style={{ marginTop: 4 }}>
            {[...ev].reverse().map(e => (
              <div key={e.id} style={{ padding: '6px 0', borderTop: '0.5px solid var(--border)' }}>
                <div style={{ fontSize: 13 }}>{eventText(e)}</div>
                <div style={{ fontSize: 11.5, color: 'var(--text-hint)' }}>{dateText(e.at)} · {e.user_name || 'без имени'}{e.reason ? <span style={{ color: 'var(--text-muted)' }}> · «{e.reason}»</span> : ''}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function Reason({ f, setF, need, hint }) {
  return <label style={{ ...lbl, marginTop: 8 }}>Причина / примечание{need ? ' (обязательно)' : ' (необязательно)'}<input value={f.reason || ''} onChange={e => setF(x => ({ ...x, reason: e.target.value }))} placeholder={hint} style={inp} /></label>
}
function Actions({ busy, ok, danger, disabled, onOk, onCancel }) {
  return (
    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
      <button type="button" disabled={busy || disabled} style={{ ...btn('main'), flex: 1, background: danger ? 'var(--danger)' : 'var(--blue)', opacity: busy || disabled ? 0.5 : 1 }} onClick={onOk}>{busy ? '…' : ok}</button>
      <button type="button" style={btn()} onClick={onCancel}>Отмена</button>
    </div>
  )
}

/** Журнал склада: что перерезали, списали, удалили — кто и когда */
function Journal({ pid, onOpen }) {
  const [days, setDays] = useState(30)
  const [who, setWho] = useState('')
  const [list, setList] = useState(null)
  useEffect(() => {
    let alive = true
    const from = days ? new Date(Date.now() - days * 864e5).toISOString() : null
    stockJournal(pid, from).then(r => { if (alive) setList(r.data || []) })
    return () => { alive = false }
  }, [pid, days])
  const people = [...new Set((list || []).map(e => e.user_name || 'без имени'))]
  const shown = (list || []).filter(e => !who || (e.user_name || 'без имени') === who)
  return (
    <>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <select value={days} onChange={e => setDays(Number(e.target.value))} style={{ padding: 6, fontSize: 13, width: 120, flex: '0 0 auto' }}>{PERIODS.map(([d, l]) => <option key={d} value={d}>{l}</option>)}</select>
        <select value={who} onChange={e => setWho(e.target.value)} style={{ padding: 6, fontSize: 13, flex: 1, minWidth: 0 }}><option value="">Все сотрудники</option>{people.map(p => <option key={p} value={p}>{p}</option>)}</select>
      </div>
      <p style={{ fontSize: 11.5, color: 'var(--text-hint)', margin: '0 0 6px' }}>Перерезанные, списанные, удалённые и возвращённые остатки.</p>
      {list === null ? <CncLoader compact label="Загружаю журнал…" /> : !shown.length ? <p style={{ fontSize: 13, color: 'var(--text-hint)', textAlign: 'center', padding: '18px 0' }}>За этот период ничего.</p> : (
        <div className="card" style={{ padding: '0 12px' }}>
          {shown.map((e, i) => (
            <button key={e.id} type="button" onClick={() => e.action !== 'delete' && onOpen(e.remnant_id)} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 0', border: 'none', borderTop: i ? '0.5px solid var(--border)' : 'none', background: 'transparent', color: 'var(--text)', cursor: e.action === 'delete' ? 'default' : 'pointer' }}>
              <div style={{ fontSize: 13 }}><span style={{ color: 'var(--text-hint)' }}>№{e.remnant_id} · </span>{eventText(e)}</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-hint)' }}>{dateText(e.at)} · <b style={{ fontWeight: 600, color: 'var(--text-muted)' }}>{e.user_name || 'без имени'}</b>{e.reason ? ` · «${e.reason}»` : ''}</div>
            </button>
          ))}
        </div>
      )}
    </>
  )
}

/** Настройки склада (владелец и начальник производства) */
function StockSettings({ pid, settings, onSaved }) {
  const [err, setErr] = useState('')
  const toggle = async k => {
    const r = await stockSetSettings(pid, { [k]: !settings[k] })
    if (r.error) setErr(r.error); else { setErr(''); onSaved(r.data || { ...settings, [k]: !settings[k] }) }
  }
  const row = (k, title, sub) => (
    <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '6px 0', cursor: 'pointer' }}>
      <input type="checkbox" checked={!!settings[k]} onChange={() => toggle(k)} style={{ marginTop: 3, width: 18, height: 18, flex: '0 0 auto' }} />
      <span><span style={{ display: 'block', fontSize: 13.5 }}>{title}</span><span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-hint)' }}>{sub}</span></span>
    </label>
  )
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Настройки склада</div>
      {row('reasonRequired', 'Требовать причину при перерезке и списании', 'Выключено — причину пишут по желанию. Кто и когда перерезал или списал, записывается всегда.')}
      {row('clients', 'Показывать остатки клиентам', 'Клиенты, выбравшие ваше производство, увидят при раскрое размер, материал и количество (ячейку и примечание — нет).')}
      <p style={{ fontSize: 11.5, color: 'var(--text-hint)', margin: '6px 0 0' }}>Кто может менять склад: владелец, начальник производства и сотрудники с правом «Склад остатков» (Настройки → Сотрудники). Остальные сотрудники — только просмотр.</p>
      {err && <p className="error-text" style={{ marginTop: 6 }}>{err}</p>}
    </div>
  )
}
