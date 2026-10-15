// Service worker RaskroyPro — только для push-уведомлений. Страницы и файлы он НЕ кэширует
// (нет обработчика fetch), поэтому старых версий приложения из-за него не бывает.

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()))

// уведомление пришло — показать в шторке телефона (со звуком и вибрацией телефона)
self.addEventListener('push', e => {
  let d = {}
  try { d = e.data ? e.data.json() : {} } catch { d = { title: 'RaskroyPro', body: e.data ? e.data.text() : '' } }
  e.waitUntil((async () => {
    await self.registration.showNotification(d.title || 'RaskroyPro', {
      body: d.body || '',
      icon: '/icon-192.png',
      badge: '/badge-72.png',
      tag: d.tag || undefined,
      renotify: !!d.tag,
      vibrate: [180, 90, 180],
      data: { url: d.url || '/' },
    })
    // открытое приложение сразу обновляет отметки
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const c of list) c.postMessage({ type: 'notices-refresh' })
  })())
})

// нажали на уведомление — открыть приложение сразу на нужной заявке / заказе
self.addEventListener('notificationclick', e => {
  e.notification.close()
  const url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const c = list.find(x => new URL(x.url).origin === self.location.origin)
    if (c) {
      try { await c.focus() } catch { /* окно не дало фокус */ }
      c.postMessage({ type: 'open-url', url })
      return
    }
    await self.clients.openWindow(url)
  })())
})
