import { lazy } from 'react'
import { importRetry as netImport } from './lazyPage'

// Часть приложения, которая подгружается по требованию (3D, симулятор, редактор контура).
// Слабая связь — файл докачивается с повторами (lazyPage.js); вышла новая версия, а у открытой страницы
// адреса частей устарели — страница один раз перезагружается сама и берёт свежую версию.
export function lazyRetry(load) {
  return lazy(() => netImport(load))
}

// То же для подгружаемых библиотек (чтение Excel, QR, PDF): страницу сами не перезагружаем — в ней может быть
// несохранённый заказ, — а говорим человеку понятными словами, что делать.
export function importRetry(load) {
  return netImport(load, { reload: false }).catch(err => {
    if (err?.newVersion) throw new Error('приложение обновилось, а эта страница открыта в старой версии. Сохраните заказ, обновите страницу (потяните вниз или закройте и откройте приложение) и повторите')
    if (/dynamically imported module|Importing a module script failed|module script|Failed to fetch|Load failed/i.test(String(err?.message || err))) {
      throw new Error('слабая связь — не удалось загрузить часть приложения. Дождитесь связи и повторите')
    }
    throw err
  })
}
