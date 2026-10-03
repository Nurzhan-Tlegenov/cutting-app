import { lazy, Suspense, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { fetchSharedModel } from '../lib/modelShare'
import { textureKey } from '../lib/materialTextures'

const Model3D = lazy(() => import('../components/Model3D'))

// 3D-модель заказа по ссылке — для клиента: только просмотр, вход не нужен.
export default function SharedModelPage() {
  const { token } = useParams()
  const [state, setState] = useState({ loading: true })
  useEffect(() => {
    let alive = true
    ;(async () => {
      const ok = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token || '')
      const data = ok ? await fetchSharedModel(token) : null
      if (!alive) return
      if (!data) { setState({ closed: true }); return }
      if (data.error) { setState({ error: data.error }); return }
      let scene = null
      if (data.model) {
        try { scene = (await import('../lib/basisB3d')).unpackScene(data.model) } catch { scene = null }
      }
      const textures = {}
      for (const t of data.textures || []) textures[textureKey(t.name)] = { name: t.name, data: t.data, size: Number(t.size_mm) || 600, rot: !!t.rot }
      if (alive) setState({ title: data.title || '', details: data.details || [], scene, textures })
    })()
    return () => { alive = false }
  }, [token])
  useEffect(() => { if (state.title) document.title = `${state.title} — 3D-модель` }, [state.title])

  const box = { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', padding: 24, textAlign: 'center', gap: 8 }
  if (state.loading) return <div style={{ ...box, color: 'var(--text-hint)' }}>Загрузка модели…</div>
  if (state.closed) return (
    <div style={box}>
      <div style={{ fontSize: 17, fontWeight: 500 }}>Ссылка не работает</div>
      <div style={{ fontSize: 13, color: 'var(--text-muted)', maxWidth: 320 }}>Доступ к этой модели закрыт или ссылка указана с ошибкой. Попросите новую ссылку у того, кто вам её прислал.</div>
    </div>
  )
  if (state.error) return <div style={box}><div style={{ fontSize: 15 }}>Не удалось открыть модель</div><div style={{ fontSize: 12, color: 'var(--text-hint)' }}>{state.error}</div></div>
  if (!state.details.some(d => String(d.contour || '').includes('"inst"'))) return <div style={box}><div style={{ fontSize: 15 }}>В этом заказе нет 3D-модели</div></div>
  return (
    <Suspense fallback={<div style={{ ...box, color: 'var(--text-hint)' }}>Загрузка модели…</div>}>
      <Model3D details={state.details} scene={state.scene} title={state.title} readOnly sharedTextures={state.textures} />
    </Suspense>
  )
}
