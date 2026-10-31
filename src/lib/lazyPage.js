import { lazy } from 'react'
import { APP_VERSION } from './version'
import { retrying, waitOnline } from './netRetry'

// Страницы приложения грузятся по требованию: при открытии скачивается только вход и список заказов,
// а раскрой, ЧПУ, бирки, 3D и импорт — когда их открывают. На слабом интернете первое открытие в разы легче.
//
// Файл страницы не скачался:
//  • связь оборвалась — повторяем (до 5 раз, ждём появления сети);
//  • вышла новая версия, а старых файлов на сервере уже нет — перезагружаем приложение один раз.
const DELAYS = [1000, 2500, 5000, 10000, 15000]
const RELOAD_KEY = 'chunkReload'

async function versionChanged() {
  try {
    const r = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' })
    const j = r.ok ? await r.json() : null
    return typeof j?.v === 'string' && j.v !== APP_VERSION
  } catch { return false }
}

// reload: false — не перезагружать сами (на странице может быть несохранённый заказ); тогда ошибка помечается e.newVersion
export async function importRetry(factory, { reload = true } = {}) {
  let counted = false, url = null
  try {
    for (let i = 0; ; i++) {
      try {
        // Браузер запоминает неудачную загрузку файла и при повторе того же адреса сразу отдаёт ту же ошибку,
        // даже не идя в сеть. Поэтому повтор — по тому же файлу с меткой в адресе (?r=…).
        const m = url ? await import(/* @vite-ignore */ `${url}${url.includes('?') ? '&' : '?'}r=${Date.now()}`) : await factory()
        try { sessionStorage.removeItem(RELOAD_KEY) } catch { /* без памяти */ }
        return m
      } catch (e) {
        // адрес файла — из текста ошибки («Failed to fetch dynamically imported module: https://…/assets/X-abc.js»)
        const m = /(https?:\/\/[^\s'"]+?\.m?js)(?:\?[^\s'"]*)?/.exec(String(e?.message || ''))
        if (m && !url) url = m[1]
        if (APP_VERSION !== 'dev' && await versionChanged()) {
          if (!reload) { e.newVersion = true; throw e }
          let last = 0
          try { last = Number(sessionStorage.getItem(RELOAD_KEY)) || 0 } catch { /* без памяти */ }
          if (Date.now() - last > 60000) {            // не чаще раза в минуту — без вечной перезагрузки
            try { sessionStorage.setItem(RELOAD_KEY, String(Date.now())) } catch { /* без памяти */ }
            window.location.reload()
            return new Promise(() => {})               // ждём перезагрузку
          }
        }
        if (i >= DELAYS.length) { e.chunkLoad = true; throw e }
        if (!counted) { counted = true; retrying(+1) }
        await waitOnline(60000)
        await new Promise(r => setTimeout(r, DELAYS[i]))
      }
    }
  } finally { if (counted) retrying(-1) }
}

// lazyPage(() => import('../pages/X'))            — страница по умолчанию
// lazyPage(() => import('../pages/X'), 'Named')    — именованный экспорт
const preloaders = []
export function lazyPage(factory, name) {
  let p = null
  const pick = m => (name ? { default: m[name] } : m)
  const load = () => (p ||= importRetry(factory).then(pick).catch(e => { p = null; throw e }))
  // фоновая докачка: одна тихая попытка — без плашки «слабая связь» и без перезагрузки посреди работы
  preloaders.push(() => p || factory().then(m => { p ||= Promise.resolve(pick(m)) }))
  const C = lazy(load)
  C.preload = load
  return C
}

// После запуска — тихо докачиваем остальные страницы по одной, чтобы переходы потом были мгновенными.
// Не на экономии трафика и не на 2G: там качаем только то, что открывают.
export function preloadPages(delay = 6000) {
  const c = navigator.connection
  if (c?.saveData || /(^|-)2g$/.test(c?.effectiveType || '')) return
  if (c?.effectiveType === '3g') delay = Math.max(delay, 20000)    // медленно — сначала пусть дойдут данные открытой страницы
  setTimeout(async () => {
    for (const load of preloaders) {
      try { await load() } catch { /* докачаем при открытии */ }
      await new Promise(r => setTimeout(r, 300))
    }
  }, delay)
}
