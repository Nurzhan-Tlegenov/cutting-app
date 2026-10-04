import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// По ссылке для клиента (/v/…, /view/…) название приложения не показывается
if (!/^\/(v|view)\//.test(window.location.pathname)) document.title = 'РаскройPro'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
