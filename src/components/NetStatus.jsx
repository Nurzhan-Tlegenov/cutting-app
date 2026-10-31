import { useEffect, useState } from 'react'
import { onNetRetry } from '../lib/netRetry'

// Плашка внизу экрана: нет интернета / связь слабая и запросы повторяются.
// Человек видит, что приложение работает и ждёт связь, а не «сломалось».
export default function NetStatus() {
  const [offline, setOffline] = useState(typeof navigator !== 'undefined' && navigator.onLine === false)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const on = () => setOffline(false), off = () => setOffline(true)
    window.addEventListener('online', on); window.addEventListener('offline', off)
    let t = null
    // короткие сбои (< 1,5 с) не показываем, чтобы плашка не мигала
    const un = onNetRetry(n => { clearTimeout(t); if (n > 0) t = setTimeout(() => setRetry(n), 1500); else setRetry(0) })
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); un(); clearTimeout(t) }
  }, [])
  if (!offline && !retry) return null
  return (
    <div role="status" style={{ position: 'fixed', left: '50%', transform: 'translateX(-50%)', top: 'calc(8px + env(safe-area-inset-top))', zIndex: 10000,
      maxWidth: 'calc(100% - 24px)', padding: '7px 14px', borderRadius: 20, fontSize: 13, fontWeight: 500, boxShadow: '0 3px 12px rgba(0,0,0,.2)',
      background: offline ? '#c62828' : '#f9a825', color: offline ? '#fff' : '#222', display: 'flex', alignItems: 'center', gap: 8, pointerEvents: 'none' }}>
      <span style={{ width: 8, height: 8, borderRadius: 4, background: 'currentColor', opacity: 0.8, animation: 'netpulse 1s ease-in-out infinite' }} />
      {offline ? 'Нет интернета — ждём связь…' : 'Слабая связь — повторяю…'}
      <style>{'@keyframes netpulse{0%,100%{opacity:.3}50%{opacity:1}}'}</style>
    </div>
  )
}
