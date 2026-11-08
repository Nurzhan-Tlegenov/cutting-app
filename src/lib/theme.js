// Тема оформления: светлая (по умолчанию) или тёмная — чтобы глаза не уставали от яркого экрана.
// Тёмная — через те же переменные цветов (index.css, html[data-theme="dark"]). Хранится на устройстве (как размер текста),
// копия — в настройках аккаунта (ставится при входе на новом устройстве).
const KEY = 'theme'
export const getTheme = () => { try { return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light' } catch { return 'light' } }
export function applyTheme(t = getTheme()) {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.theme = t === 'dark' ? 'dark' : 'light'
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) { if (!meta.dataset.light) meta.dataset.light = meta.getAttribute('content') || ''; meta.setAttribute('content', t === 'dark' ? '#141517' : meta.dataset.light) }
}
export function setTheme(t) {
  try { if (t === 'dark') localStorage.setItem(KEY, 'dark'); else localStorage.removeItem(KEY) } catch { /* без памяти */ }
  applyTheme(t)
  window.dispatchEvent(new CustomEvent('themechange', { detail: t }))
  return t
}
