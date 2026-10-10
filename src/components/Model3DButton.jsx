import { Suspense, useEffect, useMemo, useState } from 'react'
import { hasModel } from '../lib/model3d'
import { cachedShare, getShare, onShareChange } from '../lib/modelShare'
import { supabase } from '../lib/supabase'
import { saveOrderModel } from '../lib/orderModel'
import { packScene } from '../lib/basisB3d'
import { parseEdgeTypes, typesToSave, EDGE_TYPES_HINT } from '../lib/edgeCut'

import { lazyRetry } from '../lib/lazyRetry'
const Model3D = lazyRetry(() => import('./Model3D'))

const COLS = ['prefix', 'name', 'display_name', 'length', 'width', 'qty', 'edge_top', 'edge_right', 'edge_bottom', 'edge_left', 'rotatable', 'sort_order', 'contour']
const edgeNamesOf = rows => [...new Set((rows || []).flatMap(d => [d.edge_top, d.edge_right, d.edge_bottom, d.edge_left]).filter(v => v && v !== 'default' && v !== 'false' && v !== true).map(String))]

// Кнопка «3D-модель»: открывает просмотр поверх текущей страницы (страница не закрывается
// и ничего не теряет). getScene — откуда взять всю модель Базиса (может вернуть null).
// onDetailsChange — если передан, модель можно править прямо в 3D (кромка, присадка, деталь) — правки уходят в бланк заказа.
// onSceneChange — в 3D подвинули блоки: вся модель (профили, фурнитура, детали других материалов) тоже изменилась.
// saveToOrder — страница сама заказ не правит (раскрой, просмотр заказа): тогда 3D правит сохранённый заказ напрямую.
//   Правки копятся в 3D и пишутся в базу кнопкой «Сохранить изменения»; готовый раскрой при этом сбрасывается.
//   order — заказ (для настроек кромки), onSaved — что сделать после записи (обычно перечитать страницу).
// orderId — заказ уже сохранён: можно дать клиенту ссылку; значок 🔗 на кнопке — ссылка открыта.
export default function Model3DButton({ details, title, getScene, label = '3D-модель', style, onDetailsChange, onSceneChange, edgeNames, edgeTypes, onEdgeTypesChange, onEdgeNamesChange, orderId, editPath, materialThickness, saveToOrder = false, order = null, onSaved = null }) {
  const [open, setOpen] = useState(false)
  const [scene, setScene] = useState(undefined)   // undefined — ещё не загружали
  const [shared, setShared] = useState(() => !!(orderId && cachedShare(orderId)))
  // правка сохранённого заказа прямо из 3D
  const self = saveToOrder && !onDetailsChange && !!orderId
  const [draft, setDraft] = useState(null)        // изменённые детали (ещё не записаны)
  const [sceneDirty, setSceneDirty] = useState(false)
  const [types, setTypes] = useState(null)        // изменённые настройки кромки
  const [names, setNames] = useState(null)
  const [saving, setSaving] = useState(false)
  const orderTypes = useMemo(() => parseEdgeTypes(order?.edge_types), [order?.edge_types])
  const dirty = !!draft || sceneDirty || !!types
  useEffect(() => {
    if (!orderId) return
    const sync = () => setShared(!!cachedShare(orderId))
    const off = onShareChange(sync)
    if (cachedShare(orderId) === undefined) getShare(orderId)
    return off
  }, [orderId])
  if (!hasModel(details)) return null
  const show = async () => {
    if (scene === undefined) {
      let s
      try { s = getScene ? await getScene() : null } catch (e) { if (e?.limit) { window.alert(e.message); return } s = null }
      setScene(s)
    }
    setOpen(true)
  }
  const save = async () => {
    if (!dirty || saving) return true
    if (!window.confirm('Сохранить изменения в заказ? Готовый раскрой будет сброшен — его нужно выполнить заново.')) return false
    setSaving(true)
    try {
      for (const row of draft || []) {
        const src = (details || []).find(d => d.id && d.id === row.id)
        const patch = {}
        for (const k of COLS) if (k in row) patch[k] = k === 'contour' && row.contour && typeof row.contour !== 'string' ? JSON.stringify(row.contour) : row[k]
        if (row.id) {
          if (src && COLS.every(k => (src[k] ?? null) === (patch[k] ?? null))) continue      // строку не трогали
          const { error } = await supabase.from('order_details').update(patch).eq('id', row.id)
          if (error) throw new Error(error.message)
        } else {
          const { error } = await supabase.from('order_details').insert({ ...patch, order_id: orderId })     // строка разделилась (детали стали разными)
          if (error) throw new Error(error.message)
        }
      }
      const edgeSave = types ? typesToSave({ ...orderTypes, ...types }, [...edgeNamesOf(draft || details), ...(names || [])]) : null
      let { error: oErr } = await supabase.from('orders').update({ nesting_result: null, ...(edgeSave ? { edge_types: edgeSave } : {}) }).eq('id', orderId)
      if (oErr && /edge_types/.test(String(oErr.message))) {
        ({ error: oErr } = await supabase.from('orders').update({ nesting_result: null }).eq('id', orderId))
        if (!oErr) window.alert(EDGE_TYPES_HINT)
      }
      if (oErr) throw new Error(oErr.message)
      if (sceneDirty && scene) { const r = await saveOrderModel(orderId, packScene(scene)); if (!r.ok) window.alert('Детали сохранены, но 3D-модель целиком сохранить не удалось' + (r.message ? ': ' + r.message : '')) }
      setDraft(null); setSceneDirty(false); setTypes(null); setNames(null)
      onSaved?.()
      return true
    } catch (err) {
      window.alert('Не удалось сохранить изменения: ' + (err?.message || err) + '\nВозможно, заказ уже оформлен — тогда его детали менять нельзя.')
      return false
    } finally { setSaving(false) }
  }
  const close = async () => {
    if (self && dirty && window.confirm('В 3D есть несохранённые изменения. Сохранить их в заказ?')) { if (!(await save())) return }
    else if (self && dirty) { setDraft(null); setSceneDirty(false); setTypes(null); setNames(null) }
    setOpen(false)
  }
  return (
    <>
      <button type="button" onClick={show} title={shared ? 'Открыта ссылка для просмотра модели' : undefined}
        style={{ fontSize: 12, color: 'var(--blue)', background: 'none', border: '0.5px solid var(--blue-mid)', borderRadius: 20, padding: '3px 10px', whiteSpace: 'nowrap', cursor: 'pointer', ...style }}>
        {label}{shared ? ' 🔗' : ''}
      </button>
      {open && (
        <Suspense fallback={null}>
          {self
            ? <Model3D details={draft || details} scene={scene || null} title={title} onClose={close}
              onDetailsChange={setDraft} onSceneChange={s => { setScene(s); setSceneDirty(true) }}
              edgeNames={[...new Set([...edgeNamesOf(draft || details), ...(names || [])])]} edgeTypes={{ ...orderTypes, ...(types || {}) }} onEdgeTypesChange={setTypes}
              onEdgeNamesChange={fn => setNames(prev => (typeof fn === 'function' ? fn(prev || []) : fn))}
              orderId={orderId ?? null} editPath={editPath} materialThickness={materialThickness}
              actions={dirty ? [{ label: saving ? 'Сохраняем…' : '💾 Сохранить изменения в заказ', onClick: save, primary: true }] : null} />
            : <Model3D details={details} scene={scene || null} title={title} onClose={() => setOpen(false)}
              onDetailsChange={onDetailsChange} onSceneChange={s => { setScene(s); onSceneChange?.(s) }} edgeNames={edgeNames} edgeTypes={edgeTypes} onEdgeTypesChange={onEdgeTypesChange} onEdgeNamesChange={onEdgeNamesChange} orderId={orderId ?? null} editPath={editPath} materialThickness={materialThickness} />}
        </Suspense>
      )}
    </>
  )
}
