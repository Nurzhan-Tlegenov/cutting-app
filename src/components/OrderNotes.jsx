import { useState } from 'react'
import { saveProdNote } from '../lib/orderNotes'

// Примечания заказа на странице заказа (у статистики): примечание из бланка заказа — для сведения,
// примечание производства — пишет производство перед тем, как выводить карты и отдавать в работу.
// Оба выводятся в PDF карт раскроя. canEdit — открыто в кабинете производства.
export default function OrderNotes({ order, canEdit, onSaved, style }) {
  const [text, setText] = useState(order?.prod_note || '')
  const [saved, setSaved] = useState(order?.prod_note || '')
  const [state, setState] = useState('')     // '' | 'saving' | 'ok' | текст ошибки
  const orderNote = String(order?.order_note || '').trim()
  if (!canEdit && !orderNote && !saved) return null
  const save = async () => {
    if (text.trim() === saved.trim()) return
    setState('saving')
    try { const v = await saveProdNote(order.id, text); setSaved(v || ''); setState('ok'); onSaved?.(v || '') } catch (e) { setState(e?.message || String(e)) }
  }
  return (
    <div className="card" style={{ padding: '10px 12px', ...style }}>
      {orderNote && (
        <div style={{ marginBottom: canEdit || saved ? 10 : 0 }}>
          <div style={{ fontSize: 11.5, color: 'var(--text-hint)', marginBottom: 2 }}>Примечание к заказу</div>
          <div style={{ fontSize: 13.5, whiteSpace: 'pre-wrap' }}>{orderNote}</div>
        </div>
      )}
      {canEdit ? (
        <>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 3 }}>
            <span style={{ fontSize: 11.5, color: 'var(--text-hint)', flex: 1 }}>Примечание производства — выводится в PDF карт раскроя</span>
            <span style={{ fontSize: 11, color: state === 'ok' ? 'var(--teal)' : state && state !== 'saving' ? 'var(--danger)' : 'var(--text-hint)' }}>
              {state === 'saving' ? 'Сохранение…' : state === 'ok' ? '✓ Сохранено' : ''}
            </span>
          </div>
          <textarea rows={2} value={text} maxLength={2000} placeholder="Например: кромку 2 мм — только по фасадам; резать после заказа №…"
            onChange={e => { setText(e.target.value); if (state === 'ok') setState('') }} onBlur={save}
            style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit', fontSize: 13.5, padding: '6px 8px' }} />
          {state && state !== 'saving' && state !== 'ok' && <p className="error-text" style={{ margin: '4px 0 0', fontSize: 12 }}>{state}</p>}
        </>
      ) : saved ? (
        <div>
          <div style={{ fontSize: 11.5, color: 'var(--text-hint)', marginBottom: 2 }}>Примечание производства</div>
          <div style={{ fontSize: 13.5, whiteSpace: 'pre-wrap' }}>{saved}</div>
        </div>
      ) : null}
    </div>
  )
}
