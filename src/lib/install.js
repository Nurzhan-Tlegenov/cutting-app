// Установка приложения на телефон / компьютер (PWA).
// Android и компьютер (Chrome, Edge, Яндекс): браузер присылает событие beforeinstallprompt — тогда кнопка «Установить»
// показывает его окно установки. Событие приходит один раз и рано, поэтому ловим его сразу при запуске (main.jsx).
// iPhone / iPad: такого окна нет — только вручную: «Поделиться» → «На экран „Домой“» (пошагово — InstallGuide).

let deferred = null
const subs = new Set()
export function catchInstallPrompt() {
  if (typeof window === 'undefined') return
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; subs.forEach(f => f()) })
  window.addEventListener('appinstalled', () => { deferred = null; subs.forEach(f => f()) })
}
export const canPromptInstall = () => !!deferred
export const onInstallChange = f => { subs.add(f); return () => subs.delete(f) }
/** Показать окно установки браузера. -> 'accepted' | 'dismissed' | null (окна нет) */
export async function promptInstall() {
  if (!deferred) return null
  const e = deferred
  deferred = null
  try { await e.prompt(); const r = await e.userChoice; subs.forEach(f => f()); return r?.outcome || null } catch { return null }
}

/** Открыто как установленное приложение (с рабочего стола), а не во вкладке браузера */
export const isInstalled = () => {
  try { return window.matchMedia('(display-mode: standalone)').matches || window.matchMedia('(display-mode: fullscreen)').matches || window.navigator.standalone === true } catch { return false }
}

/** Какое устройство и браузер: { os: 'ios' | 'android' | 'desktop', browser: 'safari' | 'chrome' | 'yandex' | 'samsung' | 'firefox' | 'edge' | 'inapp' | 'other' } */
export function platform() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  const ios = /iPad|iPhone|iPod/.test(ua) || (typeof navigator !== 'undefined' && navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const os = ios ? 'ios' : /Android/i.test(ua) ? 'android' : 'desktop'
  // встроенный браузер мессенджера (Telegram, WhatsApp, Instagram…) — установить оттуда нельзя, нужно открыть в обычном браузере
  const inapp = /Telegram|WhatsApp|Instagram|FBAN|FBAV|VKClient|wv\)/i.test(ua)
  const browser = inapp ? 'inapp'
    : /YaBrowser|YaApp/i.test(ua) ? 'yandex'
    : /SamsungBrowser/i.test(ua) ? 'samsung'
    : /EdgiOS|EdgA|Edg\//i.test(ua) ? 'edge'
    : /FxiOS|Firefox/i.test(ua) ? 'firefox'
    : /CriOS|Chrome/i.test(ua) ? 'chrome'
    : ios && /Safari/i.test(ua) ? 'safari' : 'other'
  return { os, browser }
}
