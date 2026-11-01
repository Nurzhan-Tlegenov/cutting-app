// Объединённый раскрой (страница раскроя): из каких заказов, «Объединить материал» / «Разъединить»,
// «Обновить детали из заказов», если заказы поменяли после объединения. Логика — lib/mergeOrders.js.
import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { mergeList, srcOrderLabel, mergeMaterials, mergedGroups, unmergeMaterial, staleSources, refreshMerged, dissolveMerged } from '../lib/mergeOrders'

// галочка / кружок своего размера: общий стиль input растягивает поле на всю ширину — название материала сжималось в столбик
const tick = { width: 20, height: 20, flex: '0 0 20px', margin: 0, padding: 0, accentColor: 'var(--blue)' }
const row = { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 4px', borderBottom: '0.5px solid var(--border)', cursor: 'pointer' }
const keyLabel = k => { const i = String(k).lastIndexOf('|'); const n = i < 0 ? k : k.slice(0, i), t = i < 0 ? '' : k.slice(i + 1); return `${n || 'Без материала'}${t ? ` · ${t} мм` : ''}` }
const box = { marginBottom: 8, padding: '8px 10px', borderRadius: 'var(--radius)', background: 'var(--blue-light)', border: '0.5px solid var(--blue)' }
const btn = { border: '0.5px solid var(--blue)', background: 'var(--bg)', color: 'var(--blue)', borderRadius: 'var(--radius)', padding: '5px 10px', fontSize: 12.5, cursor: 'pointer' }

export default function MergePanel({ order, allDetails, materials, savedByMat, editable, canDissolve, disabled, onChanged, onDissolved }) {
  const srcs = mergeList(order)
  const [open, setOpen] = useState(false)          // окно «Объединить материал»
  const [checked, setChecked] = useState(() => new Set())
  const [step, setStep] = useState(1)              // 1 — какие материалы, 2 — каким режем
  const [cut, setCut] = useState('')
  const [own, setOwn] = useState('')
  const [busy, setBusy] = useState('')
  const [stale, setStale] = useState([])
  const groups = useMemo(() => mergedGroups(allDetails, order), [allDetails, order])
  // какие заказы и сколько деталей в каждом материале — для окна выбора
  const matInfo = useMemo(() => {
    const m = new Map()
    for (const x of materials) m.set(x.key, { ...x, orders: new Set() })
    for (const d of allDetails) {
      let meta
      try { meta = typeof d.contour === 'string' ? JSON.parse(d.contour)?.meta : d.contour?.meta } catch { meta = null }
      const k = meta?.material != null ? `${meta.material}|${meta.thickness ?? ''}` : null
      if (k && m.has(k) && meta.srcOrder?.seq) m.get(k).orders.add(meta.srcOrder.seq)
    }
    return m
  }, [materials, allDetails])

  useEffect(() => {
    let alive = true
    if (editable && srcs.length) staleSources(order).then(s => { if (alive) setStale(s) })
    return () => { alive = false }
  }, [order?.id, order?.merge_of, editable])   // eslint-disable-line react-hooks/exhaustive-deps

  if (!srcs.length) return null

  // раскрой материалов, которые меняются, больше не про эти детали — убираем его из заказа
  async function dropSaved(keys) {
    const rest = { ...savedByMat }
    keys.forEach(k => delete rest[k])
    const value = Object.keys(rest).length ? JSON.stringify({ multi: true, byMat: rest }) : null
    await supabase.from('orders').update({ nesting_result: value }).eq('id', order.id)
  }
  const progress = (n, all) => setBusy(`${n} из ${all}`)

  async function doMerge() {
    const keys = [...checked]
    const name = own.trim()
    let cutKey = cut || keys[0]
    if (name) cutKey = `${name}|${cutKey.slice(cutKey.lastIndexOf('|') + 1)}`
    setBusy('…')
    await dropSaved([...keys, cutKey])
    const r = await mergeMaterials(allDetails, order, keys, cutKey, progress)
    setBusy('')
    if (r.error) { window.alert('Не удалось объединить материал: ' + r.error.message); return }
    setOpen(false); setChecked(new Set()); setStep(1); setCut(''); setOwn('')
    onChanged()
  }
  async function doUnmerge(g) {
    if (!window.confirm(`Разъединить «${keyLabel(g.key)}»? Детали вернутся к своим материалам:\n${g.sources.map(k => '· ' + keyLabel(k)).join('\n')}`)) return
    setBusy('…')
    await dropSaved([g.key, ...g.sources])
    const r = await unmergeMaterial(allDetails, order, g.key, progress)
    setBusy('')
    if (r.error) { window.alert('Не удалось разъединить: ' + r.error.message); return }
    onChanged()
  }
  async function doRefresh() {
    if (!window.confirm('Перечитать детали из заказов? Объединение материалов сохранится, раскрой нужно будет выполнить заново.')) return
    setBusy('…')
    const r = await refreshMerged(order, allDetails, progress)
    setBusy('')
    if (r.error) { window.alert('Не удалось обновить: ' + r.error); return }
    setStale([])
    onChanged()
  }

  // расформировать: объединение удаляется, заказы снова отдельные — каждый со своим прежним раскроем
  async function doDissolve() {
    if (!window.confirm(`Расформировать объединение?\n\nОбъединённый раскрой (его карты, программы, бирки) удалится, заказы снова станут отдельными — каждый со своим прежним раскроем:\n${srcs.map(s => '· ' + srcOrderLabel(s)).join('\n')}`)) return
    setBusy('…')
    const r = await dissolveMerged(order)
    setBusy('')
    if (r.error) { window.alert(r.error); return }
    onDissolved?.()
  }

  const picked = [...checked]
  return (
    <div style={box}>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--blue-dark, var(--blue))', marginBottom: 4 }}>🔗 Объединённый раскрой · {srcs.length} заказа</div>
      <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.45 }}>
        {srcs.map(s => <div key={s.id}>{srcOrderLabel(s)}</div>)}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 3 }}>
        Обозначение детали начинается с номера заказа: «1·…», «2·…». На бирке «Заказ» — заказ самой детали. Смета — общая.
      </div>
      {stale.length > 0 && (
        <div style={{ marginTop: 6, fontSize: 12, color: 'var(--amber)', background: 'var(--amber-light)', border: '0.5px solid var(--amber)', borderRadius: 'var(--radius)', padding: '5px 8px' }}>
          Заказ {stale.join(', ')} изменили после объединения — детали здесь старые.
          {editable && <button type="button" disabled={disabled || !!busy} onClick={doRefresh} style={{ ...btn, marginLeft: 6, borderColor: 'var(--amber)', color: 'var(--amber)' }}>↻ Обновить детали из заказов</button>}
        </div>
      )}
      {groups.map(g => (
        <div key={g.key} style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 12 }}>
          <span style={{ flex: 1, minWidth: 0 }}>⧉ <b>{keyLabel(g.key)}</b> ← {g.sources.map(keyLabel).join(', ')}</span>
          {editable && <button type="button" disabled={disabled || !!busy} onClick={() => doUnmerge(g)} style={btn}>Разъединить</button>}
        </div>
      ))}
      {editable && materials.length > 1 && (
        <button type="button" disabled={disabled || !!busy} onClick={() => { setOpen(true); setStep(1); setChecked(new Set()) }}
          style={{ ...btn, marginTop: 7, width: '100%', background: 'var(--blue)', color: 'white', border: 'none', padding: '7px 10px', fontSize: 13 }}>
          {busy ? `Сохраняем… ${busy}` : '⧉ Объединить материал'}
        </button>
      )}
      {busy && !(editable && materials.length > 1) && <div style={{ fontSize: 12, marginTop: 6 }}>Сохраняем… {busy}</div>}
      {canDissolve && (
        <button type="button" disabled={disabled || !!busy} onClick={doDissolve}
          style={{ ...btn, marginTop: 7, width: '100%', borderColor: 'var(--danger)', color: 'var(--danger)', padding: '6px 10px' }}>✂ Расформировать объединение</button>
      )}

      {open && (
        <div onClick={() => !busy && setOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: 'var(--bg)', borderRadius: 12, padding: 14, width: '100%', maxWidth: 440, maxHeight: '85vh', overflowY: 'auto' }}>
            {step === 1 ? (
              <>
                <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>Объединить материал</div>
                <div style={{ fontSize: 12, color: 'var(--text-hint)', marginBottom: 8 }}>Отметьте материалы, которые режем одним листом (например, «Белый» и «Белый Эст»).</div>
                {materials.map(m => {
                  const on = checked.has(m.key), info = matInfo.get(m.key)
                  return (
                    <label key={m.key} style={row}>
                      <input type="checkbox" style={tick} checked={on} onChange={() => setChecked(s => { const n = new Set(s); if (on) n.delete(m.key); else n.add(m.key); return n })} />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ fontSize: 14, lineHeight: 1.3, wordBreak: 'break-word' }}>{m.label}</span>
                        <span style={{ display: 'block', fontSize: 11, color: 'var(--text-hint)' }}>
                          {m.pieces} шт.{info?.orders?.size ? ` · заказ ${[...info.orders].sort((a, b) => a - b).join(', ')}` : ''}
                        </span>
                      </span>
                    </label>
                  )
                })}
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button type="button" onClick={() => setOpen(false)} style={{ ...btn, flex: 1, padding: '9px' }}>Отмена</button>
                  <button type="button" disabled={picked.length < 2} onClick={() => { setCut(picked[0]); setStep(2) }}
                    style={{ ...btn, flex: 1, padding: '9px', background: picked.length >= 2 ? 'var(--blue)' : 'var(--bg2)', color: picked.length >= 2 ? 'white' : 'var(--text-hint)', border: 'none' }}>Далее ({picked.length})</button>
                </div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>Каким материалом режем?</div>
                <div style={{ fontSize: 12, color: 'var(--text-hint)', marginBottom: 8 }}>Все отмеченные детали раскроятся одним материалом. В самих заказах материал не меняется.</div>
                {picked.map(k => (
                  <label key={k} style={row}>
                    <input type="radio" name="mm-cut" style={tick} checked={cut === k} onChange={() => setCut(k)} />
                    <span style={{ flex: 1, minWidth: 0, fontSize: 14, lineHeight: 1.3, wordBreak: 'break-word' }}>{keyLabel(k)}</span>
                  </label>
                ))}
                <label className="label" style={{ marginTop: 10 }}>Или своё название (необязательно)</label>
                <input value={own} onChange={e => setOwn(e.target.value)} placeholder="например, ЛДСП Белый 16" style={{ width: '100%' }} />
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button type="button" disabled={!!busy} onClick={() => setStep(1)} style={{ ...btn, flex: 1, padding: '9px' }}>‹ Назад</button>
                  <button type="button" disabled={!!busy} onClick={doMerge}
                    style={{ ...btn, flex: 1, padding: '9px', background: 'var(--blue)', color: 'white', border: 'none' }}>{busy ? `Сохраняем… ${busy}` : 'Объединить'}</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
