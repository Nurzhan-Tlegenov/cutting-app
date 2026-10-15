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
