import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { fetchSharedSim } from '../lib/simShare'

const GcodeSimulator = lazy(() => import('../components/GcodeSimulator'))

// Симуляция обработки листа по ссылке: только просмотр, вход не нужен.
export default function SharedSimPage() {
  const { code } = useParams()
  const [state, setState] = useState({ loading: true })
  useEffect(() => {
    let alive = true
    ;(async () => {
      const data = /^[A-Za-z0-9]{6,16}$/.test(code || '') ? await fetchSharedSim(code) : null
      if (!alive) return
      setState(!data ? { closed: true } : data.error ? { error: data.error } : { sim: data })
    })()
    return () => { alive = false }
  }, [code])
  useEffect(() => { if (state.sim) document.title = `${state.sim.name} — симуляция` }, [state.sim])
  const toolDia = useMemo(() => { const m = state.sim?.tools || {}; return t => Number(m[t]) || 0 }, [state.sim])

  const box = { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', padding: 24, textAlign: 'center', gap: 8 }
  if (state.loading) return <div style={{ ...box, color: 'var(--text-hint)' }}>Загрузка симуляции…</div>
  if (state.closed) return (
    <div style={box}>
      <div style={{ fontSize: 17, fontWeight: 500 }}>Ссылка не работает</div>
      <div style={{ fontSize: 13, color: 'var(--text-muted)', maxWidth: 320 }}>Доступ к этой симуляции закрыт или ссылка указана с ошибкой. Попросите новую ссылку у того, кто вам её прислал.</div>
    </div>
  )
  if (state.error) return <div style={box}><div style={{ fontSize: 15 }}>Не удалось открыть симуляцию</div><div style={{ fontSize: 12, color: 'var(--text-hint)' }}>{state.error}</div></div>
  const s = state.sim
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--bg)', padding: 10, boxSizing: 'border-box', height: '100dvh' }}>
      <div style={{ maxWidth: 1100, margin: '0 auto', height: '100%' }}>
        <Suspense fallback={<div style={{ ...box, color: 'var(--text-hint)' }}>Загрузка симуляции…</div>}>
          <GcodeSimulator text={s.text} kinds={s.kinds} opIds={s.opIds} title={s.name} thickness={s.thickness} rapid={s.rapid} toolDia={toolDia} sheet={s.sheet} outlines={s.outlines} />
        </Suspense>
      </div>
    </div>
  )
}
