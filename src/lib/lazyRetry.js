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

// То же для подгружаемых библиотек (чтение Excel, QR): страницу сами не перезагружаем — в ней может быть
// несохранённый заказ, — а говорим человеку понятными словами, что делать.
export function importRetry(load) {
  return load().catch(() => load()).catch(err => {
    if (/dynamically imported module|Importing a module script failed|module script|Failed to fetch/i.test(String(err?.message || err))) {
      throw new Error('приложение обновилось, а эта страница открыта в старой версии. Сохраните заказ, обновите страницу (потяните вниз или закройте и откройте приложение) и повторите')
    }
    throw err
  })
}
