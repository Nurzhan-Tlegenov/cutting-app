// Адрес для ссылок, которые уходят людям (приглашения, 3D, симуляция, коды): всегда raskroypro.com.
// Открыли со старого адреса (cutting-app-nine.vercel.app и т. п.) — ссылка всё равно на raskroypro.com.
// Зеркало (ru.raskroypro.com) и локальная разработка — свой адрес.
export const SITE_ORIGIN = 'https://raskroypro.com'
export function siteOrigin() {
  try {
    const { origin, hostname } = window.location
    if (/(^|\.)raskroypro\.com$/i.test(hostname) || hostname === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return origin
  } catch { /* без окна — основной адрес */ }
  return SITE_ORIGIN
}
