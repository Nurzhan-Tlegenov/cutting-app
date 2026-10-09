import { useEffect, useRef, useState } from 'react'

// Цифровая клавиатура iPhone / iPad не имеет кнопки «Далее» (на Android она есть), и по полям приходится
// переходить пальцем. Пока открыта цифровая клавиатура, над ней показывается своя полоса: «Далее» и «Готово».
// «Далее» делает то же, что Enter на Android: поле само решает, куда перейти (длина -> ширина -> количество ->
// новая деталь); если поле ничего не решило — фокус уходит в следующее поле по порядку.
const IOS = typeof navigator !== 'undefined' && (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))
const H = 44

const isNumeric = el => el?.tagName === 'INPUT' && !el.readOnly && !el.disabled && ['numeric', 'decimal', 'tel'].includes(el.inputMode || el.getAttribute('inputmode') || (el.type === 'tel' || el.type === 'number' ? 'numeric' : ''))
const visible = el => el.offsetParent !== null && !el.disabled && !el.readOnly
const fields = () => [...document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file]):not([type=button]), textarea, select')].filter(visible)

export function goNext(el) {
  if (!el) return
  const ev = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true })
  const free = el.dispatchEvent(ev)                       // false — поле обработало Enter само
  if (!free || document.activeElement !== el) return
  const list = fields(), i = list.indexOf(el), next = list[i + 1]
  if (next) { next.focus(); next.select?.() } else el.blur()
}

export default function KeyboardNext() {
  const [el, setEl] = useState(null)
  const [top, setTop] = useState(null)
  const timer = useRef(0)

  useEffect(() => {
    if (!IOS) return
    const onIn = e => { clearTimeout(timer.current); setEl(isNumeric(e.target) ? e.target : null) }
    const onOut = () => { clearTimeout(timer.current); timer.current = setTimeout(() => { if (!isNumeric(document.activeElement)) setEl(null) }, 80) }
    document.addEventListener('focusin', onIn)
    document.addEventListener('focusout', onOut)
    return () => { document.removeEventListener('focusin', onIn); document.removeEventListener('focusout', onOut); clearTimeout(timer.current) }
  }, [])

  useEffect(() => {
    const vv = window.visualViewport
    if (!el || !vv) return
    const place = () => setTop(vv.height < window.innerHeight - 80 ? vv.offsetTop + vv.height - H : null)   // полоса — только пока клавиатура открыта
    place()
    vv.addEventListener('resize', place); vv.addEventListener('scroll', place); window.addEventListener('scroll', place, { passive: true })
    const t = setInterval(place, 400)                      // клавиатура выезжает с анимацией — событие приходит не всегда
    return () => { vv.removeEventListener('resize', place); vv.removeEventListener('scroll', place); window.removeEventListener('scroll', place); clearInterval(t) }
  }, [el])

  // поле под полосой не прячется: если оно оказалось за ней — подкручиваем
  useEffect(() => {
    if (!el || top == null) return
    const r = el.getBoundingClientRect(), vv = window.visualViewport
    const over = r.bottom + 8 - (vv.height - H)
    if (over > 0) window.scrollBy(0, over)
  }, [el, top != null])   // eslint-disable-line react-hooks/exhaustive-deps

  if (!IOS || !el || top == null) return null
  const hold = e => e.preventDefault()                     // нажатие на полосу не снимает фокус с поля — клавиатура не закрывается
  const btn = { border: 'none', background: 'none', fontSize: 16, padding: '0 16px', height: H, cursor: 'pointer', WebkitTapHighlightColor: 'transparent' }
  return (
    <div onMouseDown={hold} onTouchStart={hold} onPointerDown={hold}
      style={{ position: 'fixed', left: 0, right: 0, top: 0, transform: `translateY(${top}px)`, height: H, zIndex: 5000, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        background: 'var(--bg2, #f0ede6)', borderTop: '0.5px solid var(--border-md, #ccc)', boxShadow: '0 -2px 8px rgba(0,0,0,0.08)' }}>
      <button type="button" style={{ ...btn, color: 'var(--text-muted, #666)' }} onTouchEnd={e => { e.preventDefault(); el.blur() }} onClick={() => el.blur()}>Готово</button>
      <button type="button" style={{ ...btn, color: 'white', background: 'var(--blue, #2f6fed)', fontWeight: 600, padding: '0 28px' }}
        onTouchEnd={e => { e.preventDefault(); goNext(el) }} onClick={() => goNext(el)}>Далее →</button>
    </div>
  )
}
