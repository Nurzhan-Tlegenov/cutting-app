import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import BottomNav from './BottomNav'
import { requestClientAccess, openWorkplace } from '../lib/workplaces'

// Кабинет клиента у сотрудника, зарегистрированного по ссылке производства: свои заказы — после одобрения мастера.
export default function ClientGate({ access, onChange }) {
  const navigate = useNavigate()
  const { setCabinet } = useAuth()
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const status = access?.request
  const send = async () => {
    setBusy(true); setErr('')
    const r = await requestClientAccess(comment)
    setBusy(false)
    if (r.error) { setErr(r.error); return }
    onChange?.({ ...access, request: r.status, ok: r.status === 'approved' })
  }
  return (
    <div className="page" style={{ paddingBottom: 100 }}>
      <h1 style={{ fontSize: 18, fontWeight: 500, marginBottom: 16, paddingTop: 8 }}>Кабинет клиента</h1>
      <div className="card">
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 10 }}>
          Вы зарегистрированы как сотрудник производства. Чтобы самому подавать заказы и делать раскрой как клиент, отправьте заявку — её одобрит администратор приложения.
        </p>
        {status === 'new' ? <p style={{ fontSize: 13, color: 'var(--amber)' }}>Заявка отправлена и ждёт одобрения администратора.</p>
          : status === 'rejected' ? <p style={{ fontSize: 13, color: 'var(--danger)' }}>Заявка отклонена. Свяжитесь с администратором.</p>
          : (
            <>
              <label className="label">Комментарий (необязательно)</label>
              <input type="text" value={comment} onChange={e => setComment(e.target.value)} maxLength={300} placeholder="Для чего нужен кабинет клиента" style={{ marginBottom: 10 }} />
              {err && <p className="error-text" style={{ marginBottom: 8 }}>{err}</p>}
              <button type="button" className="btn-primary" disabled={busy} onClick={send}>{busy ? 'Отправляем…' : 'Отправить заявку'}</button>
            </>
          )}
        <button type="button" className="btn-secondary" style={{ marginTop: 10 }} onClick={() => { openWorkplace(); setCabinet('production'); navigate('/production') }}>← В производство</button>
      </div>
      <BottomNav />
    </div>
  )
}
