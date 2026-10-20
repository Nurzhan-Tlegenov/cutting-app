import './lib/backStack'   // «Назад» телефона закрывает окна поверх страницы — обработчик ставится раньше роутера
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { startI18n } from './i18n'
import { registerSW } from './lib/push'

registerSW()   // только для push-уведомлений, ничего не кэширует

// По ссылке для клиента (/v/…, /view/…) название приложения не показывается
if (!/^\/(v|view)\//.test(window.location.pathname)) document.title = 'РаскройPro'

// язык интерфейса: словарь загружается до первого показа, чтобы русский текст не мелькал
startI18n().finally(() => createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
))

// iPhone (Safari) не слушает user-scalable=no — запрещаем масштаб страницы жестом двумя пальцами явно.
// Карты раскроя и редакторы масштабируются своими обработчиками касаний — их это не касается
if (typeof document !== 'undefined') {
  const stop = e => e.preventDefault()
  document.addEventListener('gesturestart', stop, { passive: false })
  document.addEventListener('gesturechange', stop, { passive: false })
  document.addEventListener('gestureend', stop, { passive: false })
  // Два пальца на странице (список деталей, статистика, меню) — масштаб страницы запрещён везде: в установленном
  // приложении iPhone gesture-события приходят не всегда. Карты раскроя и редакторы масштабируют себя сами, своими
  // обработчиками касаний — им запрет масштаба СТРАНИЦЫ не мешает (события до них доходят как обычно)
  document.addEventListener('touchmove', e => { if (e.touches && e.touches.length > 1 && e.cancelable) e.preventDefault() }, { passive: false })
}
