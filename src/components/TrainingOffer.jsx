// Новым пользователям — предложение пройти обучение (видео «Клиент» / «Производство») прямо на главном экране.
// «Позже» — скрыть до следующего входа; «Больше не показывать» — навсегда (настройка аккаунта trainOffer: 'off').
// Показывается первые 30 дней после регистрации.
import { Suspense, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { getUserSettings, saveUserSettings } from '../lib/userSettings'
import { lazyRetry } from '../lib/lazyRetry'

const DemoVideo = lazyRetry(() => import('./demo/DemoVideo'))
const NEW_DAYS = 30
const LATER = 'trainOfferLater'

export default function TrainingOffer({ first = 'client' }) {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [hidden, setHidden] = useState(() => { try { return sessionStorage.getItem(LATER) === '1' } catch { return false } })
  const [video, setVideo] = useState(null)
  const [now] = useState(() => Date.now())
  const created = Date.parse(user?.created_at || '') || 0
  const fresh = created && now - created < NEW_DAYS * 864e5
  if (!user || !fresh || getUserSettings(user).trainOffer === 'off' || (hidden && !video)) {
    return video ? <Suspense fallback={null}><DemoVideo id={video} onClose={() => setVideo(null)} /></Suspense> : null
  }
  const later = () => { try { sessionStorage.setItem(LATER, '1') } catch { /* без памяти */ } setHidden(true) }
  const never = () => { saveUserSettings({ trainOffer: 'off' }, user); setHidden(true) }
  const order = first === 'production' ? [['production', '🏭 Как производство'], ['client', '🧾 Как клиент']] : [['client', '🧾 Как клиент'], ['production', '🏭 Как производство']]
  const link = { background: 'none', border: 'none', padding: '4px 2px', fontSize: 12.5, cursor: 'pointer' }
  return (
    <>
      <div className="card" style={{ marginBottom: 12, padding: '12px 14px', border: '1px solid var(--blue)', background: 'var(--blue-light)' }}>
        <div style={{ fontWeight: 600, fontSize: 14.5 }}>🎓 Пройдите обучение — 3 минуты</div>
        <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 3 }}>Видео само показывает, куда нажимать: палец проходит весь путь по экранам, с голосом и субтитрами.</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          {order.map(([id, label]) => (
            <button key={id} type="button" className={id === first ? 'btn-primary' : 'btn-secondary'} style={{ flex: 1, minWidth: 140, padding: 9, fontSize: 13.5 }} onClick={() => setVideo(id)}>▶ {label}</button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 14, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" style={{ ...link, color: 'var(--blue)' }} onClick={() => navigate('/help')}>Все уроки</button>
          <span style={{ flex: 1 }} />
          <button type="button" style={{ ...link, color: 'var(--text-muted)' }} onClick={later}>Позже</button>
          <button type="button" style={{ ...link, color: 'var(--text-muted)' }} onClick={never}>Больше не показывать</button>
        </div>
      </div>
      {video && <Suspense fallback={null}><DemoVideo id={video} onClose={() => setVideo(null)} /></Suspense>}
    </>
  )
}
