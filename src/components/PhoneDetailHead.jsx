// Телефон: подписи колонок над строками деталей бланка (Длина · Ширина · Кол. · Дл Дп Шв Шн ↻) — та же сетка, что у
// строки детали (index.css, .det-card до 1100px), и кнопка «Поз. и наименование»: показать / скрыть их строку у деталей
// (по умолчанию скрыта, запоминается на этом телефоне). На компьютере — своя таблица (DetailTableHead).
import { useState } from 'react'

const KEY = 'detNamePosShow'
const read = () => { try { return localStorage.getItem(KEY) === '1' } catch { return false } }
const apply = on => { if (typeof document !== 'undefined') document.body.classList.toggle('np-show', !!on) }
apply(read())

export function NamePosToggle() {
  const [on, setOn] = useState(read)
  const flip = () => { const v = !on; setOn(v); apply(v); try { localStorage.setItem(KEY, v ? '1' : '0') } catch { /* без памяти */ } }
  return (
    <button type="button" className="desk-hide" onClick={flip}
      style={{ fontSize: 12, color: on ? 'white' : 'var(--blue)', background: on ? 'var(--blue)' : 'none', border: '0.5px solid var(--blue-mid)', borderRadius: 20, padding: '3px 10px', cursor: 'pointer' }}>
      Поз. и наименование
    </button>
  )
}

export default function PhoneDetailHead({ showEdge }) {
  const cell = (col, text, extra = {}) => <div style={{ gridRow: 1, gridColumn: col, minWidth: 0, textAlign: 'center', ...extra }}>{text}</div>
  return (
    <div className="card det-card det-phead desk-hide" style={{ paddingLeft: 10, paddingRight: 10 }}>
      {cell(2, 'Длина')}
      {cell(3, 'Ширина')}
      {cell(4, 'Кол.')}
      {showEdge && (
        <div style={{ gridRow: 1, gridColumn: 5, display: 'flex', gap: 2 }}>
          {['Дл', 'Дп', 'Шв', 'Шн', '↻'].map(t => <div key={t} style={{ width: 22, textAlign: 'center' }}>{t}</div>)}
        </div>
      )}
    </div>
  )
}
