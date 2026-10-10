import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { startI18n } from './i18n'

// По ссылке для клиента (/v/…, /view/…) название приложения не показывается
if (!/^\/(v|view)\//.test(window.location.pathname)) document.title = 'РаскройPro'

// язык интерфейса: словарь загружается до первого показа, чтобы русский текст не мелькал
startI18n().finally(() => createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
))
