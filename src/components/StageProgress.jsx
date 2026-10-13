import { useEffect, useState } from 'react'
import { ruleOf, stageParts, loadOrderParts } from '../lib/stageParts'
import { planStages } from '../lib/posts'

// Счётчик поста прямо на карточке заказа: сколько деталей (или сторон кромления) идёт через пост, сколько уже
// отмечено сканированием и сколько осталось — убывает с каждым сканом. Список деталей заказа грузится один раз на заказ.
const cache = new Map()   // orderId -> Promise<{ order, rows }>
const partsOf = orderId => {
  if (!cache.has(orderId)) cache.set(orderId, loadOrderParts(orderId).catch(() => ({ order: null, rows: [] })))
  return cache.get(orderId)
}

/** Итог поста: { total, unit } — сколько единиц должно пройти пост */
function useStageTotal(orderId, rule, postName) {
  const [res, setRes] = useState(null)
  const r = ruleOf(rule, postName)
  const key = JSON.stringify(r)
  useEffect(() => {
    let alive = true
    if (r.list === 'none') { Promise.resolve().then(() => alive && setRes({ total: 0, unit: '' })); return () => { alive = false } }
    partsOf(orderId).then(d => {
      if (!alive) return
      if (!d?.order || !d.rows.length) { setRes(null); return }          // деталей не видно — счётчик не показываем и пост не пропускаем
      const parts = stageParts(d.order, d.rows, r)
      setRes({ total: parts.reduce((a, p) => a + p.qty, 0), kinds: parts.length, unit: r.list === 'edge' && r.sides ? 'стор.' : 'шт.' })
    })
    return () => { alive = false }
  }, [orderId, key])   // eslint-disable-line react-hooks/exhaustive-deps
  return res
}

export default function StageProgress({ orderId, rule, postName, scanned, onOpen, onSkipped }) {
  const t = useStageTotal(orderId, rule, postName)
  // кромление / присадка, а деталей для поста у заказа нет — пост пропускается сам, заказ идёт дальше
  const empty = t && !t.total && ['edge', 'drill'].includes(ruleOf(rule, postName).list) && !Number(scanned)
  useEffect(() => { if (empty) planStages(orderId).then(n => { if (n) onSkipped?.() }) }, [empty, orderId])   // eslint-disable-line react-hooks/exhaustive-deps
  if (ruleOf(rule, postName).list === 'none' || !t) return null
  const done = Math.min(t.total, Number(scanned) || 0), left = Math.max(0, t.total - done)
  if (!t.total) return <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>У заказа нет деталей для этого поста — пост пропускается.</div>
  return (
    <div onClick={onOpen} style={{ marginTop: 7, cursor: onOpen ? 'pointer' : 'default' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, fontSize: 12.5, flexWrap: 'wrap' }}>
        <span>Всего <b>{t.total}</b> {t.unit}</span>
        <span style={{ color: 'var(--blue)' }}>отмечено <b>{done}</b></span>
        <span style={{ color: left ? 'var(--amber)' : 'var(--teal)', fontWeight: 600, marginLeft: 'auto' }}>{left ? `осталось ${left}` : '✓ все прошли'}</span>
      </div>
      <div style={{ height: 5, borderRadius: 3, background: 'var(--bg2)', overflow: 'hidden', marginTop: 3 }}>
        <div style={{ width: `${done / t.total * 100}%`, height: '100%', background: left ? 'var(--blue)' : 'var(--teal)' }} />
      </div>
    </div>
  )
}
