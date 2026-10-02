import { lazy, Suspense, useState } from 'react'
import { hasModel } from '../lib/model3d'

const Model3D = lazy(() => import('./Model3D'))

// Кнопка «3D-модель»: открывает просмотр поверх текущей страницы (страница не закрывается
// и ничего не теряет). getScene — откуда взять всю модель Базиса (может вернуть null).
export default function Model3DButton({ details, title, getScene, label = '3D-модель', style }) {
  const [open, setOpen] = useState(false)
  const [scene, setScene] = useState(undefined)   // undefined — ещё не загружали
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
      <button type="button" onClick={show}
        style={{ fontSize: 12, color: 'var(--blue)', background: 'none', border: '0.5px solid var(--blue-mid)', borderRadius: 20, padding: '3px 10px', whiteSpace: 'nowrap', cursor: 'pointer', ...style }}>
        {label}
      </button>
      {open && (
        <Suspense fallback={null}>
          <Model3D details={details} scene={scene || null} title={title} onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  )
}
