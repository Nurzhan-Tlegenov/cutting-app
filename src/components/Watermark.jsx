import { useAuth } from '../context/AuthContext'

// Водяной знак поверх всего приложения: телефон и имя того, кто вошёл. Запретить снимок экрана
// браузер не даёт — зато на любом снимке видно, с чьего аккаунта он сделан. У администратора знака нет.
export default function Watermark() {
  const { user, profile } = useAuth()
  if (!user || profile?.role === 'admin') return null
  const digits = String(profile?.phone || user.email || '').split('@')[0].replace(/\D/g, '')
  const text = [digits ? '+' + digits : '', profile?.full_name || ''].filter(Boolean).join(' · ') || user.id.slice(0, 8)
  const esc = text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]))
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="190"><g transform="rotate(-24 150 95)" font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif" font-size="13" font-weight="600" fill="#000000" fill-opacity="0.085"><text x="150" y="60" text-anchor="middle">${esc}</text><text x="150" y="150" text-anchor="middle">РаскройPro</text></g></svg>`
  return <div aria-hidden="true" style={{ position: 'fixed', inset: 0, zIndex: 2000, pointerEvents: 'none', userSelect: 'none', backgroundImage: `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`, backgroundRepeat: 'repeat' }} />
}
