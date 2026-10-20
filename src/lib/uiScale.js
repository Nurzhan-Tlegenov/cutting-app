// Масштаб интерфейса (меню слева → «Размер текста и кнопок»): текст и кнопки крупнее или мельче под свой телефон.
// Делается через viewport страницы — так, как телефон сам масштабирует сайты: всё приложение одинаково (шрифт, кнопки,
// отступы) и без горизонтальной прокрутки — ширина страницы уменьшается ровно настолько, насколько всё крупнее.
// Координаты касаний, карты и редакторы при этом считают как обычно (всё в тех же CSS-пикселях) — их это не ломает.
// Хранится на устройстве (у каждого телефона свой экран). На компьютере viewport не действует — там Ctrl + / Ctrl −.
const KEY = 'uiScale'
export const UI_SCALE_MIN = 0.85, UI_SCALE_MAX = 1.25
export const isTouchDevice = () => typeof window !== 'undefined' && (navigator.maxTouchPoints > 0 || !!window.matchMedia?.('(pointer: coarse)')?.matches)
export function getUiScale() {
  try { const v = Number(localStorage.getItem(KEY)); return v >= UI_SCALE_MIN && v <= UI_SCALE_MAX ? v : 1 } catch { return 1 }
}
export function applyUiScale(s = getUiScale()) {
  const meta = document.querySelector('meta[name="viewport"]')
  if (!meta) return
  if (!isTouchDevice() || Math.abs(s - 1) < 0.001) {
    meta.setAttribute('content', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no')
    return
  }
  // ширина экрана в CSS-пикселях при масштабе 1 — с учётом поворота телефона
  const portrait = window.matchMedia?.('(orientation: portrait)')?.matches ?? true
  const sw = Math.min(screen.width, screen.height), lw = Math.max(screen.width, screen.height)
  const w = Math.round((portrait ? sw : lw) / s)
  meta.setAttribute('content', `width=${w}, initial-scale=${s}, minimum-scale=${s}, maximum-scale=${s}, user-scalable=no`)
}
export function setUiScale(s) {
  const v = Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, Math.round(s * 100) / 100))
  try { if (Math.abs(v - 1) < 0.001) localStorage.removeItem(KEY); else localStorage.setItem(KEY, String(v)) } catch { /* без памяти — до перезагрузки */ }
  applyUiScale(v)
  return v
}
let inited = false
export function initUiScale() {
  if (inited || typeof window === 'undefined') return
  inited = true
  applyUiScale()
  const re = () => setTimeout(() => applyUiScale(), 50)
  window.addEventListener('orientationchange', re)
  window.matchMedia?.('(orientation: portrait)')?.addEventListener?.('change', re)
}
