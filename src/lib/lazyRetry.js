import { lazy } from 'react'

// Часть приложения, которая подгружается по требованию (3D, симулятор). После обновления приложения у открытой
// страницы адреса таких частей устаревают — «Failed to fetch dynamically imported module». Тогда страница
// один раз перезагружается сама и берёт свежую версию.
const KEY = 'chunkReloadAt'
export function lazyRetry(load) {
  return lazy(() => load().catch(err => {
    let last = 0
    try { last = Number(sessionStorage.getItem(KEY)) || 0 } catch { /* без памяти */ }
    if (Date.now() - last > 15000) {
      try { sessionStorage.setItem(KEY, String(Date.now())) } catch { /* без памяти */ }
      window.location.reload()
      return new Promise(() => {})            // страница перезагружается — ничего не показываем
    }
    throw err
  }))
}
