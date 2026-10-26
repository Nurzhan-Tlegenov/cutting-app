import { useNavigate } from 'react-router-dom'
import { Suspense, useState } from 'react'
import { MenuButton } from '../components/NavDrawer'
import BottomNav from '../components/BottomNav'
import { TOURS, setTour } from '../lib/tours'
import { useAuth } from '../context/AuthContext'
import { lazyRetry } from '../lib/lazyRetry'
import { demoLang } from '../components/demo/demoLang'

const DemoVideo = lazyRetry(() => import('../components/demo/DemoVideo'))

// «Обучение»: интерактивные туры по настоящим экранам — для клиента и для производства.
// Под каждым — краткий план шагов, чтобы можно было прочитать, не запуская тур.
const COURSES = [['client', '🧾'], ['production', '🏭']]

export default function HelpPage() {
  const navigate = useNavigate()
  const { setCabinet } = useAuth()
  // начать тур: сразу открыть его первый экран и кабинет (вводный шаг пропускаем — он про то же)
  const start = id => {
    const g = TOURS[id].steps[0].go
    if (g.cabinet) setCabinet(g.cabinet)
    if (g.tab) { try { sessionStorage.setItem('keep:/production#prodTab', JSON.stringify(g.tab)) } catch { /* без памяти */ } }
    setTour({ id, i: 1 })
    navigate(g.to, g.tab ? { state: { tab: g.tab } } : undefined)
  }
  const [open, setOpen] = useState(null)
  const [video, setVideo] = useState(null)
  // туры по настоящим экранам пока только по-русски — на других языках остаётся видео (оно переведено полностью)
  const ruOnly = demoLang() === 'ru'
  return (
    <div className="page page-read" style={{ paddingBottom: 100 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6, paddingTop: 4 }}><MenuButton /><h1 style={{ fontSize: 18, fontWeight: 500 }}>Обучение</h1></div>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.45 }}>
        {ruOnly ? '«Смотреть видео» — ролик сам показывает, куда нажимать: палец со стрелкой проходит весь путь по экранам, с субтитрами и голосом. «Пройти самому» — подсказки на настоящих экранах, на своих заказах.'
          : 'Ролик сам показывает, куда нажимать: палец со стрелкой проходит весь путь по экранам, с субтитрами и голосом.'}
      </p>
      {COURSES.map(([id, ico]) => {
        const c = TOURS[id], shown = open === id
        return (
          <div key={id} className="card" style={{ marginBottom: 10, padding: '12px 14px' }}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <span style={{ fontSize: 26, lineHeight: 1 }}>{ico}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 15 }}>{c.title}</div>
                <div style={{ fontSize: 12, color: 'var(--text-hint)', marginTop: 2 }}>{c.short}</div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button type="button" className="btn-primary" style={{ flex: 1, padding: 9, fontSize: 14 }} onClick={() => setVideo(id)}>▶ Смотреть видео</button>
              {ruOnly && <button type="button" className="btn-secondary" style={{ flex: '0 0 auto', padding: '9px 12px', fontSize: 13 }} onClick={() => start(id)}>Пройти самому</button>}
              {ruOnly && <button type="button" className="btn-secondary" style={{ flex: '0 0 auto', padding: '9px 14px', fontSize: 13 }} onClick={() => setOpen(shown ? null : id)}>{shown ? 'Скрыть шаги' : 'Шаги'}</button>}
            </div>
            {shown && (
              <ol style={{ margin: '10px 0 0', paddingLeft: 20, fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.45 }}>
                {c.steps.map((s, i) => <li key={i} style={{ marginBottom: 6 }}><b style={{ color: 'var(--text)', fontWeight: 500 }}>{s.title}.</b> {s.text}</li>)}
              </ol>
            )}
          </div>
        )
      })}
      <BottomNav />
      {video && <Suspense fallback={null}><DemoVideo id={video} onClose={() => setVideo(null)} /></Suspense>}
    </div>
  )
}
