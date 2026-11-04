import { useState } from 'react'

// Подсказка «как это работает», свёрнутая под значок «?». Нажал — текст раскрылся под строкой, нажал ещё раз
// (на «?» или на сам текст) — спрятался. Тексты подсказок не удаляются: они нужны при знакомстве с приложением,
// а опытному пользователю не занимают место. Работает одинаково на телефоне и на мониторе (нажатием, не наведением).
// inline — значок в строке рядом с текстом (в заголовке, подписи), текст раскрывается блоком ниже.
export default function Hint({ children, inline = false, style }) {
  const [open, setOpen] = useState(false)
  if (children == null || children === false || children === '') return null
  const btn = (
    <button type="button" aria-label={open ? 'Скрыть подсказку' : 'Подсказка'} aria-expanded={open} title={open ? 'Скрыть подсказку' : 'Подсказка'}
      onClick={e => { e.preventDefault(); e.stopPropagation(); setOpen(v => !v) }}
      style={{
        width: 18, height: 18, minWidth: 18, padding: 0, borderRadius: '50%', lineHeight: '16px', fontSize: 11, fontWeight: 600,
        border: `1px solid ${open ? 'var(--teal, #0f9d8a)' : 'var(--border-md)'}`, background: open ? 'var(--teal, #0f9d8a)' : 'transparent',
        color: open ? 'white' : 'var(--text-hint)', cursor: 'pointer', verticalAlign: 'middle', flexShrink: 0,
      }}>?</button>
  )
  const text = open ? (
    <span onClick={() => setOpen(false)} style={{ display: 'block', fontSize: 11, color: 'var(--text-hint)', margin: '4px 0 0', cursor: 'pointer', whiteSpace: 'normal' }}>{children}</span>
  ) : null
  if (inline) return <span style={{ display: 'inline', marginLeft: 6, ...style }}>{btn}{text}</span>
  return <div style={{ margin: '3px 0 0', ...style }}>{btn}{text}</div>
}
