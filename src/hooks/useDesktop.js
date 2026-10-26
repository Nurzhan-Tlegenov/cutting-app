import { useEffect, useState } from 'react'

// Экран компьютера: широкое окно. На телефоне и узком окне — привычный вид «в одну колонку».
// Порог — ширина окна, а не тип устройства: планшет в альбомной ориентации тоже получает две колонки,
// а окно браузера на компьютере, сжатое до узкой полосы, — телефонный вид.
export const DESKTOP_QUERY = '(min-width: 1100px)'

export function isDesktop() {
  return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(DESKTOP_QUERY).matches
}

export function useDesktop() {
  const [desk, setDesk] = useState(isDesktop)
  useEffect(() => {
    if (!window.matchMedia) return
    const mq = window.matchMedia(DESKTOP_QUERY)
    const upd = () => setDesk(mq.matches)
    upd()
    mq.addEventListener ? mq.addEventListener('change', upd) : mq.addListener(upd)
    return () => { mq.removeEventListener ? mq.removeEventListener('change', upd) : mq.removeListener(upd) }
  }, [])
  return desk
}

// Плотность пикселей экрана меняется, когда в браузере меняют масштаб (Ctrl + колёсико / Ctrl +−)
// или переносят окно на другой монитор. Холсты карт рисуются под эту плотность — при её смене их надо
// перерисовать, иначе карта остаётся размытой, пока её не тронешь.
export function useDevicePixelRatio() {
  const [dpr, setDpr] = useState(() => (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1))
  useEffect(() => {
    if (!window.matchMedia) return
    let mq = null
    const listen = () => {
      mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
      const on = () => { mq.removeEventListener?.('change', on); setDpr(window.devicePixelRatio || 1); listen() }
      mq.addEventListener?.('change', on)
      mq._on = on
    }
    listen()
    return () => { if (mq?._on) mq.removeEventListener?.('change', mq._on) }
  }, [])
  return dpr
}
