import { useEffect, useState } from 'react'
import { APP_VERSION } from '../lib/version'
import { hasUnsaved } from '../hooks/useLeaveGuard'

// Обновление без переустановки. Установленное приложение на телефоне неделями живёт в памяти и само код не
// перечитывает — поэтому оно сверяет свою версию с /version.json (при возврате в приложение и раз в 10 минут).
// Вышла новая версия:
//  • вернулись в приложение после перерыва (≥ 3 мин), несохранённого нет, раскрой не идёт — перезагружаемся сами;
//  • иначе внизу плашка «Вышло обновление — Обновить» (данные человека не теряем).
const EVERY = 10 * 60 * 1000, IDLE = 3 * 60 * 1000
const busyPage = () => /nesting|cnc/i.test(window.location.pathname)     // идёт раскрой / выгрузка — сами не трогаем

async function latest() {
  try {
    const r = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' })
    if (!r.ok) return null
    const j = await r.json()
    return typeof j?.v === 'string' ? j.v : null
  } catch { return null }
}

export default function UpdateWatcher() {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (APP_VERSION === 'dev') return
    let hiddenAt = 0, stop = false
    const check = async resumed => {
      const v = await latest()
      if (stop || !v || v === APP_VERSION) return
      if (resumed && !hasUnsaved() && !busyPage()) { window.location.reload(); return }
      setReady(true)
    }
    const onVis = () => {
      if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return }
      const long = hiddenAt && Date.now() - hiddenAt >= IDLE
      hiddenAt = 0
      check(long)
    }
    document.addEventListener('visibilitychange', onVis)
    const t = setInterval(() => { if (document.visibilityState === 'visible') check(false) }, EVERY)
    check(false)
    return () => { stop = true; document.removeEventListener('visibilitychange', onVis); clearInterval(t) }
  }, [])
  if (!ready) return null
  return (
    <div style={{ position: 'fixed', left: 12, right: 12, bottom: 'calc(12px + env(safe-area-inset-bottom))', zIndex: 9999, display: 'flex', alignItems: 'center', gap: 10,
      padding: '10px 12px', borderRadius: 12, background: 'var(--blue, #1a73e8)', color: '#fff', boxShadow: '0 4px 16px rgba(0,0,0,.25)', fontSize: 13.5 }}>
      <span style={{ flex: 1 }}>Вышло обновление приложения{hasUnsaved() ? ' — сначала сохраните изменения' : ''}</span>
      <button type="button" onClick={() => window.location.reload()} style={{ border: 'none', borderRadius: 8, padding: '7px 12px', background: '#fff', color: 'var(--blue, #1a73e8)', fontWeight: 600, fontSize: 13 }}>Обновить</button>
      <button type="button" onClick={() => setReady(false)} aria-label="Позже" style={{ border: 'none', background: 'none', color: '#fff', fontSize: 16, padding: '0 4px' }}>✕</button>
    </div>
  )
}
