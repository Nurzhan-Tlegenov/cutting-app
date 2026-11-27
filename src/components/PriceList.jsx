import Hint from './Hint'
import { useEffect, useState } from 'react'
import { loadPrices, savePrices, PRICE_GROUPS, HDF_ITEMS, PLATE_CLASSES, EDGE_CLASSES, HOLE_CLASSES, productionClients } from '../lib/pricing'
import { useBackClose } from '../lib/backStack'

// Прайс-лист производства: цены на операции, с которыми сталкивается раскрой.
// Заполнять можно не всё — в расчёт идут только операции с ценой. Видит и меняет прайс только владелец производства.
const clean = v => String(v ?? '').replace(/[^0-9.,]/g, '')
const CURRENCIES = ['₸', '₽', 'сом', 'сум', 'Br', '₴', '$', '€']

export default function PriceList({ production, onClose }) {
  useBackClose(true, onClose)   // «Назад» телефона — закрыть
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    let alive = true
    loadPrices(production.id).then(r => { if (!alive) return; if (r.error) setError(r.error); setData({ on: true, currency: '₸', tiers: [], ...(r.data || {}) }) })
    return () => { alive = false }
  }, [production.id])
  const set = (k, v) => { setSaved(false); setData(d => ({ ...d, [k]: v })) }
  const tiersOf = key => (Array.isArray(data?.[key]) ? data[key] : [])
  const tiers = tiersOf('tiers'), hdfTiers = tiersOf('hdf_tiers')
  const setTier = (key, i, k, v) => set(key, tiersOf(key).map((t, j) => (j === i ? { ...t, [k]: clean(v) } : t)))
  // ступени — по возрастанию числа деталей; ступень без числа («свыше») — последней
  const sortTiers = list => list.filter(t => String(t.price ?? '') !== '').sort((a, b) => (Number(String(a.to).replace(',', '.')) || Infinity) - (Number(String(b.to).replace(',', '.')) || Infinity))
  const save = async () => {
    setBusy(true); setError('')
    const dia = key => (Array.isArray(data[key]) ? data[key] : []).filter(r => Number(String(r.d).replace(',', '.')) > 0 && String(r.price ?? '') !== '')
      .sort((a, b) => Number(String(a.d).replace(',', '.')) - Number(String(b.d).replace(',', '.')))
    const out = { ...data, tiers: sortTiers(tiers), hdf_tiers: sortTiers(hdfTiers), hole_list: dia('hole_list'), edge_hole_list: dia('edge_hole_list') }
    const r = await savePrices(production.id, out)
    setBusy(false)
    if (r.error) setError(r.error); else { setData(out); setSaved(true) }
  }
  const inp = { padding: '6px 8px', fontSize: 14, textAlign: 'right' }
  // ступени цены за лист по числу деталей (key — 'tiers' у плиты, 'hdf_tiers' у ХДФ)
  const tiersEditor = (key, title) => {
    const list = tiersOf(key)
    return (
                  <div style={{ marginTop: 8, paddingTop: 8, borderTop: '0.5px solid var(--border)' }}>
                    <div style={{ fontSize: 13 }}>{title}</div>
                    <Hint>Цена за лист зависит от того, сколько на нём деталей: до 5 — одна цена, до 10 — другая. Строка без числа — «свыше».</Hint>
                    {list.map((t, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
                        <span style={{ fontSize: 12, color: 'var(--text-muted)', flex: '0 0 auto' }}>{i > 0 && list[i - 1].to ? `от ${Number(String(list[i - 1].to).replace(',', '.')) + 1} ` : ''}до</span>
                        <input type="text" inputMode="numeric" placeholder="свыше" value={t.to ?? ''} onChange={e => setTier(key, i, 'to', e.target.value)} style={{ ...inp, width: 64, flex: '0 0 auto' }} />
                        <span style={{ fontSize: 12, color: 'var(--text-muted)', flex: 1 }}>дет. — за лист</span>
                        <input type="text" inputMode="decimal" placeholder="цена" value={t.price ?? ''} onChange={e => setTier(key, i, 'price', e.target.value)} style={{ ...inp, width: 96, flex: '0 0 auto' }} />
                        <button type="button" onClick={() => set(key, list.filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', color: 'var(--text-hint)', fontSize: 18, padding: '0 2px' }}>×</button>
                      </div>
                    ))}
                    <button type="button" onClick={() => set(key, [...list, { to: '', price: '' }])}
                      style={{ padding: '6px 12px', borderRadius: 20, fontSize: 12, border: '0.5px solid var(--blue)', background: 'transparent', color: 'var(--blue)' }}>+ Добавить ступень</button>
                  </div>
    )
  }
  // цены по классам (толщина плиты, диаметр): строка «название — поле»; пустое поле — серым цена по умолчанию
  const filled = keys => keys.some(k => (Array.isArray(data?.[k]) ? data[k].some(r => r.d && r.price) : String(data?.[k] ?? '') !== ''))
  const classList = (prefix, list, base, hint) => (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '4px 8px', alignItems: 'center', marginTop: 4 }}>
      {list.map(([c, l]) => (
        <div key={c} style={{ display: 'contents' }}>
          <span style={{ fontSize: 13 }}>{l}</span>
          <input type="text" inputMode="decimal" placeholder={base && data[base] ? String(data[base]) : '—'} value={data[prefix + c] ?? ''}
            onChange={e => set(prefix + c, clean(e.target.value))} style={{ ...inp, width: 96 }} />
        </div>
      ))}
      {hint && <div style={{ gridColumn: '1 / -1' }}><Hint>{hint}</Hint></div>}
    </div>
  )
  const section = (title, keys, body) => <Sec title={title} on={filled(keys)}>{body}</Sec>
  // свои строки «диаметр → цена»: [{ d, price }]
  const diaRows = key => (Array.isArray(data?.[key]) ? data[key] : [])
  const setDia = (key, i, k, v) => set(key, diaRows(key).map((r, j) => (j === i ? { ...r, [k]: clean(v) } : r)))
  const diaList = (key, title, base) => (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', margin: '2px 0 4px' }}>{title}</div>
      {diaRows(key).map((r, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
          <span style={{ fontSize: 13, flex: '0 0 auto' }}>Ø</span>
          <input type="text" inputMode="decimal" placeholder="мм" value={r.d ?? ''} onChange={e => setDia(key, i, 'd', e.target.value)} style={{ ...inp, width: 54, flex: '0 0 auto' }} />
          <span style={{ fontSize: 12, color: 'var(--text-muted)', flex: '0 0 auto' }}>до</span>
          <input type="text" inputMode="decimal" placeholder="—" value={r.to ?? ''} onChange={e => setDia(key, i, 'to', e.target.value)} style={{ ...inp, width: 54, flex: '0 0 auto' }} />
          <span style={{ flex: 1 }} />
          <input type="text" inputMode="decimal" placeholder={data[base] ? String(data[base]) : 'цена'} value={r.price ?? ''} onChange={e => setDia(key, i, 'price', e.target.value)} style={{ ...inp, width: 96, flex: '0 0 auto' }} />
          <button type="button" onClick={() => set(key, diaRows(key).filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', color: 'var(--text-hint)', fontSize: 18, padding: '0 2px' }}>×</button>
        </div>
      ))}
      <button type="button" onClick={() => set(key, [...diaRows(key), { d: '', price: '' }])}
        style={{ padding: '5px 12px', borderRadius: 20, fontSize: 12, border: '0.5px solid var(--blue)', background: 'transparent', color: 'var(--blue)' }}>+ Добавить диаметр</button>
    </div>
  )
  const plateKeys = p => PLATE_CLASSES.map(([c]) => p + c)
  const edgeKeys = PLATE_CLASSES.flatMap(([pc]) => EDGE_CLASSES.map(([ec]) => `edge_${pc}_${ec}`))
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 900, background: 'var(--bg2)', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', background: 'var(--bg)', borderBottom: '0.5px solid var(--border)' }}>
        <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--blue)', fontSize: 22, padding: 0, lineHeight: 1 }}>←</button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 500 }}>Прайс-лист</div>
          <div style={{ fontSize: 11, color: 'var(--text-hint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{production.name}</div>
        </div>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: 14 }}>
        {!data ? <p style={{ fontSize: 13, color: 'var(--text-hint)' }}>Загрузка…</p> : (
          <>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
              Укажите цены на свои операции — заполнять можно не всё. Заказчик, выбравший ваше производство, после раскроя сразу видит общую стоимость работ
              (сами расценки ему не показываются). Другим производствам ваши цены и стоимость недоступны.
            </p>
            <div className="card" style={{ marginBottom: 10 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
                <input type="checkbox" checked={data.on !== false} onChange={e => set('on', e.target.checked)} style={{ width: 'auto' }} />
                Показывать заказчикам стоимость по этому прайс-листу
              </label>
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <label style={{ flex: 1, fontSize: 11, color: 'var(--text-muted)' }}>Валюта
                  <select value={data.currency || ''} onChange={e => set('currency', e.target.value)} style={{ padding: '6px 8px', fontSize: 14 }}>
                    {[...new Set([data.currency || '₸', ...CURRENCIES])].map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </label>
                <label style={{ flex: 2, fontSize: 11, color: 'var(--text-muted)' }}>Минимальная сумма заказа
                  <input type="text" inputMode="decimal" placeholder="нет" value={data.min ?? ''} onChange={e => set('min', clean(e.target.value))} style={inp} />
                </label>
              </div>
            </div>

            {PRICE_GROUPS.map(g => (
              <div key={g.id} className="card" style={{ marginBottom: 10 }}>
                <p className="section-title">{g.title}</p>
                {g.items.map(([k, title, unit]) => (
                  <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13 }}>{title}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-hint)' }}>{unit}{k === 'cut_sheet' && tiers.length ? ' — не действует, пока заданы ступени ниже' : ''}{k === 'edge_thick_m' ? ' — пусто: как обычная кромка' : ''}</div>
                    </div>
                    <input type="text" inputMode="decimal" placeholder="—" value={data[k] ?? ''} onChange={e => set(k, clean(e.target.value))} style={{ ...inp, width: 96, flex: '0 0 auto' }} />
                  </div>
                ))}
                {g.id === 'cut' && tiersEditor('tiers', 'Раскрой листа по числу деталей на листе')}
                {g.id === 'cut' && section('Раскрой листа по толщине плиты', plateKeys('cut_sheet_'), classList('cut_sheet_', PLATE_CLASSES, 'cut_sheet',
                  'Цена за лист своей толщины. Пустое поле — лист этой толщины считается как раньше (по ступеням или общей цене за лист). На ХДФ не действует.'))}
                {g.id === 'edge' && section('Кромка по толщине плиты и кромки', edgeKeys, (
                  <div style={{ marginTop: 4 }}>
                    <div style={{ display: 'grid', gridTemplateColumns: `minmax(0, 1fr) repeat(${EDGE_CLASSES.length}, 72px)`, gap: 4, alignItems: 'center' }}>
                      <span style={{ fontSize: 10.5, color: 'var(--text-hint)' }}>плита \ кромка, мм</span>
                      {EDGE_CLASSES.map(([ec, l]) => <span key={ec} style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>{l}</span>)}
                      {PLATE_CLASSES.map(([pc, pl]) => (
                        <div key={pc} style={{ display: 'contents' }}>
                          <span style={{ fontSize: 12.5 }}>{pl}</span>
                          {EDGE_CLASSES.map(([ec]) => (
                            <input key={ec} type="text" inputMode="decimal" placeholder={String((ec === 'a' ? data.edge_m : data.edge_thick_m || data.edge_m) || '—')}
                              value={data[`edge_${pc}_${ec}`] ?? ''} onChange={e => set(`edge_${pc}_${ec}`, clean(e.target.value))} style={{ ...inp, width: '100%', padding: '6px 5px', fontSize: 13 }} />
                          ))}
                        </div>
                      ))}
                    </div>
                    <Hint>Цена за метр прямой кромки по толщине плиты (строки) и кромки (столбцы). Пустая клетка — как раньше: «Кромка прямая до 1 мм» / «толще 1 мм». Склеенная деталь (2 × 16) считается как плита 30 мм и толще, если у широкой кромки нет своей цены.</Hint>
                  </div>
                ))}
                {g.id === 'drill' && section('Свои диаметры и диапазоны — своя цена', ['hole_list', 'edge_hole_list'], (
                  <div style={{ marginTop: 4 }}>
                    {diaList('hole_list', 'В пласть', 'hole')}
                    {diaList('edge_hole_list', 'В торец', 'edge_hole')}
                    <Hint>Цена за отверстие. Только «Ø» — точный диаметр (Ø8 — своя цена, Ø5 — своя). «Ø … до …» — свой диапазон (Ø3 до 10 — одна цена на всё от 3 до 10 мм). Точный диаметр важнее диапазона. Что не попало в строки — по диапазонам ниже или по общей цене отверстия.</Hint>
                  </div>
                ))}
                {g.id === 'drill' && section('Отверстие в пласть по диаметру', HOLE_CLASSES.map(([c]) => 'hole_' + c), classList('hole_', HOLE_CLASSES, 'hole',
                  'Цена за отверстие своего диаметра. Пустое поле — по цене «Отверстие в пласть».'))}
              </div>
            ))}
            {/* ХДФ / ДВП — тонкий материал задних стенок, режется на пиле: распил по своим ценам */}
            <div className="card" style={{ marginBottom: 10 }}>
              <p className="section-title">Распил ХДФ, ДВП (задние стенки)</p>
              <div style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 4 }}>Для заказов с типом материала «ХДФ, ДВП». Пустое поле — цена как у плиты (серым).</div>
              {HDF_ITEMS.map(([k, title, unit, base]) => (
                <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13 }}>{title}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-hint)' }}>{unit}{k === 'hdf_cut_sheet' && hdfTiers.length ? ' — не действует, пока заданы ступени ниже' : ''}</div>
                  </div>
                  <input type="text" inputMode="decimal" placeholder={data[base] ? String(data[base]) : '—'} value={data[k] ?? ''} onChange={e => set(k, clean(e.target.value))} style={{ ...inp, width: 96, flex: '0 0 auto' }} />
                </div>
              ))}
              {tiersEditor('hdf_tiers', 'Раскрой листа ХДФ по числу деталей на листе')}
            </div>
            <div className="card" style={{ marginBottom: 10 }}>
              <p className="section-title">Разгрузка</p>
              <div style={{ fontSize: 11, color: 'var(--text-hint)' }}>За каждый лист заказа, цена — по толщине листа. Пустое поле — разгрузка листов этой толщины не считается. Обрезки со склада не считаются.</div>
              {classList('unload_', PLATE_CLASSES, null)}
            </div>
            <RetailCard production={production} data={data} set={set} inp={inp} />
            <Hint>Все заполненные цены складываются: например, «за метр реза» и «за лист» вместе. Стоимость материала и самой кромки в расчёт не входит — только работа.</Hint>
          </>
        )}
      </div>
      <div style={{ padding: '10px 14px calc(10px + env(safe-area-inset-bottom))', background: 'var(--bg)', borderTop: '0.5px solid var(--border)' }}>
        {error && <p className="error-text" style={{ marginBottom: 6 }}>{error}</p>}
        {saved && <p style={{ fontSize: 12, color: 'var(--teal)', marginBottom: 6, textAlign: 'center' }}>Сохранено</p>}
        <button type="button" className="btn-primary" disabled={busy || !data} onClick={save}>{busy ? 'Сохраняем…' : 'Сохранить прайс-лист'}</button>
      </div>
    </div>
  )
}

// Категории клиентов: розница — цена с повышающим коэффициентом (по умолчанию все клиенты), постоянные — базовая цена.
// Своё производство (заказы, оформленные владельцем) — всегда по базовой цене
function RetailCard({ production, data, set, inp }) {
  const [list, setList] = useState(null)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')
  const regular = Array.isArray(data.regular) ? data.regular : []
  const k = Number(String(data.retail_k ?? '').replace(',', '.')) || 0
  useEffect(() => {
    let alive = true
    productionClients(production.id).then(r => { if (!alive) return; if (r.error) setErr(r.error); setList(r.data || []) })
    return () => { alive = false }
  }, [production.id])
  const toggle = id => set('regular', regular.includes(id) ? regular.filter(x => x !== id) : [...regular, id])
  const shown = (list || []).filter(c => !q || `${c.name || ''} ${c.phone || ''}`.toLowerCase().includes(q.toLowerCase()))
  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <p className="section-title">Категории клиентов</p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13 }}>Розница — коэффициент к цене</div>
          <div style={{ fontSize: 11, color: 'var(--text-hint)' }}>например 1,2 — на 20 % дороже; пусто или 1 — у всех одна цена</div>
        </div>
        <input type="text" inputMode="decimal" placeholder="1" value={data.retail_k ?? ''} onChange={e => set('retail_k', String(e.target.value).replace(/[^0-9.,]/g, ''))} style={{ ...inp, width: 96, flex: '0 0 auto' }} />
      </div>
      <Hint>Все клиенты сначала — розница. Постоянных отметьте ниже: им — базовая цена прайс-листа. Клиент видит только итоговую сумму, коэффициент ему не показывается. Ваши собственные заказы — всегда по базовой цене. Уже оформленные заказы не пересчитываются.</Hint>
      {err ? <p style={{ fontSize: 12, color: 'var(--amber)', marginTop: 6 }}>{err}</p> : list === null ? <p style={{ fontSize: 12, color: 'var(--text-hint)', marginTop: 6 }}>Загрузка клиентов…</p> : !list.length ? (
        <p style={{ fontSize: 12, color: 'var(--text-hint)', marginTop: 6 }}>Клиентов пока нет — появятся, когда оформят заказы на ваше производство.</p>
      ) : (
        <div style={{ marginTop: 6 }}>
          {list.length > 8 && <input type="text" placeholder="Поиск по имени или телефону" value={q} onChange={e => setQ(e.target.value)} style={{ padding: '6px 8px', fontSize: 13, marginBottom: 6 }} />}
          <div style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 2 }}>Клиенты · постоянных {regular.filter(id => list.some(c => c.id === id)).length} из {list.length}</div>
          <div style={{ maxHeight: 280, overflowY: 'auto' }}>
            {shown.map(c => {
              const reg = regular.includes(c.id)
              return (
                <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderTop: '0.5px solid var(--border)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={reg} onChange={() => toggle(c.id)} style={{ width: 18, height: 18, flex: '0 0 auto' }} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name || 'без имени'}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-hint)' }}>{c.phone || ''}{c.phone ? ' · ' : ''}заказов {c.orders}</span>
                  </span>
                  <span style={{ fontSize: 11, color: reg ? 'var(--teal)' : 'var(--text-hint)', whiteSpace: 'nowrap' }}>{reg ? 'постоянный' : k > 0 && k !== 1 ? `розница ×${String(k).replace('.', ',')}` : 'розница'}</span>
                </label>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// раздел прайса, который можно свернуть: открыт сразу, если в нём уже есть цены; дальше — как оставил пользователь
function Sec({ title, on, children }) {
  const [open, setOpen] = useState(on)
  return (
    <div style={{ marginTop: 8, paddingTop: 8, borderTop: '0.5px solid var(--border)' }}>
      <button type="button" onClick={() => setOpen(v => !v)} style={{ width: '100%', display: 'flex', gap: 6, alignItems: 'center', background: 'none', border: 'none', padding: 0, fontSize: 13, color: 'var(--text)', cursor: 'pointer', textAlign: 'left' }}>
        <span style={{ color: 'var(--text-hint)', fontSize: 11, transform: open ? 'rotate(90deg)' : 'none' }}>▶</span>
        <span style={{ flex: 1 }}>{title}{on ? ' ✓' : ''}</span>
      </button>
      {open && children}
    </div>
  )
}
