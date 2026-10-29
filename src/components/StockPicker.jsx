// «Взять со склада» в раскрое: остатки склада производства по материалу заказа. Точное совпадение материала —
// сразу отмечено; похожий материал («Белый Эстетик» ↔ «Белый») — показывается с пометкой, решает человек.
// Выбранные остатки идут в «Обрезки со склада» этого раскроя (раскраиваются первыми).
import { useEffect, useMemo, useState } from 'react'
import { stockForNesting, materialMatch, sizeText } from '../lib/stock'

const btn = main => ({ padding: '8px 14px', borderRadius: 20, fontSize: 13, cursor: 'pointer', border: main ? 'none' : '0.5px solid var(--border-md)', background: main ? 'var(--blue)' : 'transparent', color: main ? 'white' : 'var(--text)' })

export default function StockPicker({ prodId, prodName, orderId, material, taken, onPick, onClose }) {
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')
  const [sel, setSel] = useState(() => new Map())       // id -> кол-во
  const [all, setAll] = useState(false)                 // показать и другие материалы
  useEffect(() => {
    let alive = true
    stockForNesting(prodId, orderId).then(r => {
      if (!alive) return
      if (r.error) { setErr(r.error); setData({ items: [] }); return }
      const d = r.data || { items: [] }
      setData(d)
      // точное совпадение материала — сразу отмечено (кроме уже взятых)
      setSel(new Map((d.items || []).filter(x => materialMatch(material, x.material) === 'exact' && !taken.has(x.id)).map(x => [x.id, x.qty])))
    })
    return () => { alive = false }
  }, [prodId, orderId])   // eslint-disable-line react-hooks/exhaustive-deps
  const groups = useMemo(() => {
    const items = (data?.items || []).filter(x => !taken.has(x.id))
    const m = x => materialMatch(material, x.material)
    return { exact: items.filter(x => m(x) === 'exact'), similar: items.filter(x => m(x) === 'similar'), other: items.filter(x => !m(x)) }
  }, [data, material, taken])
  const toggle = x => setSel(p => { const n = new Map(p); if (n.has(x.id)) n.delete(x.id); else n.set(x.id, x.qty); return n })
  const row = (x, tag) => (
    <label key={x.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 4px', borderTop: '0.5px solid var(--border)', cursor: 'pointer' }}>
      <input type="checkbox" checked={sel.has(x.id)} onChange={() => toggle(x)} style={{ width: 20, height: 20, flex: '0 0 auto' }} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 14, fontWeight: 600 }}>{sizeText(x)}{x.qty > 1 && <span style={{ color: 'var(--blue)', fontWeight: 500 }}> × {x.qty} шт</span>}</span>
        <span style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          №{x.id} · {x.material || 'материал не указан'}{x.thickness ? ` · ${x.thickness} мм` : ''}{x.cell ? ` · ячейка ${x.cell}` : ''}{x.status === 'reserved' ? ' · уже за этим заказом' : ''}
        </span>
      </span>
      {tag && <span style={{ fontSize: 11, color: 'var(--amber)', whiteSpace: 'nowrap' }}>{tag}</span>}
      {sel.has(x.id) && x.qty > 1 && (
        <input type="text" inputMode="numeric" value={sel.get(x.id)} onClick={e => e.preventDefault()}
          onChange={e => { const v = Math.max(1, Math.min(x.qty, Number(e.target.value.replace(/\D/g, '')) || 1)); setSel(p => new Map(p).set(x.id, v)) }}
          style={{ width: 46, padding: '4px 6px', fontSize: 13, textAlign: 'center' }} title="Сколько штук взять" />
      )}
    </label>
  )
  const pick = () => {
    const items = (data?.items || []).filter(x => sel.has(x.id)).map(x => ({ length: x.length, width: x.width, qty: sel.get(x.id), stock: x.id, material: x.material }))
    onPick(items)
  }
  const n = [...sel.values()].reduce((a, b) => a + b, 0)
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 300, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }} onClick={onClose}>
      <div style={{ background: 'var(--bg)', width: '100%', maxWidth: 560, maxHeight: '88vh', overflowY: 'auto', borderRadius: '16px 16px 0 0', padding: '14px 16px calc(18px + env(safe-area-inset-bottom))' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 2 }}>
          <span style={{ flex: 1, fontSize: 15, fontWeight: 600 }}>Остатки со склада</span>
          <button type="button" onClick={onClose} style={{ border: 'none', background: 'none', fontSize: 22, color: 'var(--text-hint)', cursor: 'pointer', padding: 0 }}>×</button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>{prodName ? `Склад «${prodName}» · ` : ''}материал заказа: {material || 'не указан'}</div>
        {data === null ? <p style={{ fontSize: 13 }}>Загружаю склад…</p> : err ? <p className="error-text">{err}</p>
          : data.allowed === false ? <p style={{ fontSize: 13 }}>Производство не показывает свой склад остатков клиентам.</p> : <>
            {!groups.exact.length && !groups.similar.length && <p style={{ fontSize: 13, color: 'var(--text-hint)' }}>Остатков этого материала на складе нет.</p>}
            {groups.exact.map(x => row(x))}
            {!!groups.similar.length && <div style={{ fontSize: 12, fontWeight: 600, margin: '10px 0 2px', color: 'var(--amber)' }}>Похожий материал — проверьте, подходит ли</div>}
            {groups.similar.map(x => row(x, 'похожий материал'))}
            {!!groups.other.length && (all
              ? <><div style={{ fontSize: 12, fontWeight: 600, margin: '10px 0 2px', color: 'var(--text-muted)' }}>Другие материалы</div>{groups.other.map(x => row(x, 'другой материал'))}</>
              : <button type="button" style={{ ...btn(false), marginTop: 8, fontSize: 12 }} onClick={() => setAll(true)}>Показать другие материалы · {groups.other.length}</button>)}
            <p style={{ fontSize: 11.5, color: 'var(--text-hint)', margin: '10px 0 0' }}>Взятые остатки раскраиваются первыми. Когда раскрой выбран («Выбрать» / «Оформить»), они резервируются за заказом и другим заказам не предлагаются; когда выпустят программы ЧПУ (или пройдут раскрой) — списываются.</p>
          </>}
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button type="button" disabled={!n} style={{ ...btn(true), flex: 1, opacity: n ? 1 : 0.5 }} onClick={pick}>Взять · {n} шт</button>
          <button type="button" style={btn(false)} onClick={onClose}>Отмена</button>
        </div>
      </div>
    </div>
  )
}
