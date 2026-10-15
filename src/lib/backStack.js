// Кнопка «Назад» телефона закрывает открытое окно поверх страницы (3D-модель, редактор контура, прайс-лист,
// детали поста, диалог…), а не уводит со страницы. Окна вложены — «Назад» закрывает их по одному, сверху вниз,
// как шаги назад.
//
// Как устроено: открыли окно — в историю браузера добавляется запись с тем же адресом. «Назад» её снимает:
// наш обработчик popstate (ставится первым и в фазе перехвата) закрывает верхнее окно и не пускает событие
// дальше — роутер и защита от ухода со страницы (useLeaveGuard) его не видят. Окно закрыли кнопкой на экране —
// его запись снимается тихо (history.back с пропуском обработки). Ушли на другую страницу, не закрывая окно, —
// запись остаётся в истории как обычный шаг назад.
import { useEffect, useLayoutEffect, useRef } from 'react'

const stack = []          // [{ id, close, done }]
let skip = 0              // сколько ближайших popstate — наши собственные history.back(), их не обрабатываем
let seq = 0

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', e => {
    if (skip > 0) { skip--; e.stopImmediatePropagation(); return }
    const top = stack.pop()
    if (!top) return
    top.done = true
    e.stopImmediatePropagation()
    try { top.close() } catch (err) { console.warn(err) }
  }, true)
}

function push(close) {
  const entry = { id: ++seq, close, done: false }
  stack.push(entry)
  try { window.history.pushState({ ...(window.history.state || {}), __overlay: entry.id }, '', window.location.href) } catch { /* без истории */ }
  return entry
}
function remove(entry) {
  if (entry.done) return
  entry.done = true
  const i = stack.indexOf(entry)
  if (i >= 0) stack.splice(i, 1)
  // окно закрыли не «Назад» — снимаем его запись, если она ещё верхняя (на другую страницу не уходили)
  setTimeout(() => {
    if (window.history.state?.__overlay === entry.id) { skip++; window.history.back() }
  }, 0)
}

/** Окно поверх страницы: пока open — «Назад» закрывает его (вызывает onClose). Для окна, которое показано,
 *  пока смонтировано, — useBackClose(true, onClose). */
export function useBackClose(open, onClose) {
  const closeRef = useRef(onClose)
  useLayoutEffect(() => { closeRef.current = onClose })
  useEffect(() => {
    if (!open) return
    const entry = push(() => closeRef.current?.())
    return () => remove(entry)
  }, [open])
}
