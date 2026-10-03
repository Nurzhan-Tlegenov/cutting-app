import { useState } from 'react'
import { registerProduction } from '../lib/productionApi'

// Форма «Моё производство»: название, телефон, город. sheet — рез и отступы станка (берутся из текущего заказа).
export default function ProductionForm({ initial = null, sheet = null, submitLabel = 'Зарегистрировать производство', onDone, onCancel }) {
  const [form, setForm] = useState({ name: initial?.name || '', phone: initial?.phone || '', city: initial?.city || '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const save = async () => {
    if (form.name.trim().length < 2) { setError('Введите название производства'); return }
    setBusy(true); setError('')
    const r = await registerProduction(form, sheet || {})
    setBusy(false)
    if (r.error) { setError(r.error); return }
    onDone?.(r.id, form)
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div><label className="label">Название производства *</label><input type="text" placeholder="Мебельный цех «…»" value={form.name} onChange={e => set('name', e.target.value)} maxLength={80} /></div>
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1.2, minWidth: 0 }}><label className="label">Телефон для заказчиков</label><input type="tel" placeholder="+7 700 000 00 00" value={form.phone} onChange={e => set('phone', e.target.value)} /></div>
        <div style={{ flex: 1, minWidth: 0 }}><label className="label">Город</label><input type="text" value={form.city} onChange={e => set('city', e.target.value)} maxLength={80} /></div>
      </div>
      {sheet && <p style={{ fontSize: 11, color: 'var(--text-hint)' }}>Рез и отступы листа возьмём из этого заказа — потом их можно поменять в кабинете производства.</p>}
      {error && <p className="error-text">{error}</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="btn-primary" disabled={busy} onClick={save} style={{ flex: 1 }}>{busy ? 'Сохраняем…' : submitLabel}</button>
        {onCancel && <button type="button" onClick={onCancel} style={{ padding: '0 14px', border: '0.5px solid var(--border-md)', borderRadius: 'var(--radius)', background: 'transparent', color: 'var(--text-muted)' }}>Отмена</button>}
      </div>
    </div>
  )
}
