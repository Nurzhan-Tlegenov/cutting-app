import { lazy, Suspense, useEffect, useState } from 'react'
import { hasModel } from '../lib/model3d'
import { cachedShare, getShare, onShareChange } from '../lib/modelShare'

import { lazyRetry } from '../lib/lazyRetry'
const Model3D = lazyRetry(() => import('./Model3D'))

// Кнопка «3D-модель»: открывает просмотр поверх текущей страницы (страница не закрывается
// и ничего не теряет). getScene — откуда взять всю модель Базиса (может вернуть null).
// onDetailsChange — если передан, модель можно править прямо в 3D (кромка, присадка, деталь).
// orderId — заказ уже сохранён: можно дать клиенту ссылку; значок 🔗 на кнопке — ссылка открыта.
// onSceneChange — в 3D подвинули блоки: вся модель (профили, фурнитура, детали других материалов) тоже изменилась.
export default function Model3DButton({ details, title, getScene, label = '3D-модель', style, onDetailsChange, onSceneChange, edgeNames, edgeTypes, onEdgeTypesChange, onEdgeNamesChange, orderId, editPath, materialThickness }) {
  const [open, setOpen] = useState(false)
  const [scene, setScene] = useState(undefined)   // undefined — ещё не загружали
  const [shared, setShared] = useState(() => !!(orderId && cachedShare(orderId)))
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
      try { s = getScene ? await getScene() : null } catch { s = null }
      setScene(s)
    }
    setOpen(true)
  }
  return (
    <>
      <button type="button" onClick={show} title={shared ? 'Открыта ссылка для просмотра модели' : undefined}
        style={{ fontSize: 12, color: 'var(--blue)', background: 'none', border: '0.5px solid var(--blue-mid)', borderRadius: 20, padding: '3px 10px', whiteSpace: 'nowrap', cursor: 'pointer', ...style }}>
        {label}{shared ? ' 🔗' : ''}
      </button>
      {open && (
        <Suspense fallback={null}>
          <Model3D details={details} scene={scene || null} title={title} onClose={() => setOpen(false)}
            onDetailsChange={onDetailsChange} onSceneChange={s => { setScene(s); onSceneChange?.(s) }} edgeNames={edgeNames} edgeTypes={edgeTypes} onEdgeTypesChange={onEdgeTypesChange} onEdgeNamesChange={onEdgeNamesChange} orderId={orderId ?? null} editPath={editPath} materialThickness={materialThickness} />
        </Suspense>
      )}
    </>
  )
}
