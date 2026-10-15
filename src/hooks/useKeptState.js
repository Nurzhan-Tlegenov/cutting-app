import { useCallback, useEffect, useState } from 'react'

// Состояние окна, которое переживает обновление страницы (F5, «потянуть вниз» на телефоне):
// открытая вкладка, развёрнутый раздел, открытое окно деталей поста и т. п. Хранится в sessionStorage
// отдельно для каждого адреса страницы — после обновления пользователь остаётся там же, где был.
// Значение — любое, что переживает JSON (Set и функции — нет).
const store = (k, v) => { try { if (v === undefined) sessionStorage.removeItem(k); else sessionStorage.setItem(k, JSON.stringify(v)) } catch { /* без памяти */ } }
const read = k => { try { const s = sessionStorage.getItem(k); return s == null ? undefined : JSON.parse(s) } catch { return undefined } }
const keyOf = (key, global) => `keep:${global ? '' : window.location.pathname}#${key}`

/** [value, set] — как useState, но значение сохраняется; init — начальное (значение или функция). global — одно на всё приложение, не на страницу */
export function useKeptState(key, init, { global = false } = {}) {
  const k = keyOf(key, global)
  const [v, setV] = useState(() => { const s = read(k); return s !== undefined ? s : (typeof init === 'function' ? init() : init) })
  useEffect(() => { store(k, v) }, [k, v])
  return [v, setV]
}

/** Свойства для <details>: open + onToggle — раздел остаётся развёрнутым после обновления. onToggle — свой обработчик, если нужен */
export function useKeptDetails(key, { init = false, onToggle } = {}) {
  const [open, setOpen] = useKeptState(key, init)
  const toggle = useCallback(e => { setOpen(e.currentTarget.open); onToggle?.(e) }, [setOpen, onToggle])
  return { open, onToggle: toggle }
}
