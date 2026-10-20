import './lib/backStack'   // «Назад» телефона закрывает окна поверх страницы — обработчик ставится раньше роутера
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { startI18n } from './i18n'
import { registerSW } from './lib/push'
import { initUiScale } from './lib/uiScale'

registerSW()   // только для push-уведомлений, ничего не кэширует

// По ссылке для клиента (/v/…, /view/…) название приложения не показывается
if (!/^\/(v|view)\//.test(window.location.pathname)) document.title = 'РаскройPro'

// масштаб интерфейса (текст и кнопки) — до первого показа, чтобы не прыгало
initUiScale()

// язык интерфейса: словарь загружается до первого показа, чтобы русский текст не мелькал
startI18n().finally(() => createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
))

// Масштаб СТРАНИЦЫ жестом двумя пальцами запрещён на всех телефонах (Android — Chrome, Samsung Internet; iPhone):
// user-scalable=no слушают не все браузеры (у Chrome есть «принудительное масштабирование» в спец. возможностях, Safari
// его не слушает вовсе). Карты раскроя и редакторы масштабируются своими обработчиками касаний — их это не касается
if (typeof document !== 'undefined') {
  const stop = e => e.preventDefault()
  document.addEventListener('gesturestart', stop, { passive: false })
  document.addEventListener('gesturechange', stop, { passive: false })
  document.addEventListener('gestureend', stop, { passive: false })
  // Два пальца на странице (список деталей, статистика, меню) — браузер страницу не масштабирует. Прокрутка одним пальцем
  // не затронута. Карты раскроя и редакторы масштабируют себя сами — события касаний до них доходят как обычно
  document.addEventListener('touchmove', e => { if (e.touches && e.touches.length > 1 && e.cancelable) e.preventDefault() }, { passive: false })
}
