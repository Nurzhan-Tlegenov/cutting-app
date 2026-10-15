import { useNavigate } from 'react-router-dom'
import { useState } from 'react'
import { MenuButton } from '../components/NavDrawer'
import BottomNav from '../components/BottomNav'
import { TOURS, setTour } from '../lib/tours'
import { useAuth } from '../context/AuthContext'

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
  return (
    <div className="page" style={{ paddingBottom: 100 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6, paddingTop: 4 }}><MenuButton /><h1 style={{ fontSize: 18, fontWeight: 500 }}>Обучение</h1></div>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.45 }}>
        Тур проходит по настоящим экранам приложения: подсвечивает кнопку и объясняет, что она делает. Подсвеченное можно нажимать — тур идёт следом. Закрыть можно в любой момент.
      </p>
      {COURSES.map(([id, ico]) => {
        const c = TOURS[id], shown = open === id
        return (
          <div key={id} className="card" style={{ marginBottom: 10, padding: '12px 14px' }}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <span style={{ fontSize: 26, lineHeight: 1 }}>{ico}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 15 }}>{c.title}</div>
                <div style={{ fontSize: 12, color: 'var(--text-hint)', marginTop: 2 }}>{c.short} · {c.steps.length} шагов</div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button type="button" className="btn-primary" style={{ flex: 1, padding: 9, fontSize: 14 }} onClick={() => start(id)}>▶ Начать тур</button>
              <button type="button" className="btn-secondary" style={{ flex: '0 0 auto', padding: '9px 14px', fontSize: 13 }} onClick={() => setOpen(shown ? null : id)}>{shown ? 'Скрыть шаги' : 'Шаги'}</button>
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
    </div>
  )
}
