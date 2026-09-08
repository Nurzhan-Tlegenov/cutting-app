import { useEffect, useRef, useState } from 'react'

// Перехватывает системную/браузерную кнопку "назад" (и закрытие вкладки),
// показывая подтверждение, если есть несохранённые изменения.
// shouldGuard — булево значение (пересчитывается снаружи), стух через ref, чтобы
// не пересоздавать обработчики истории на каждый рендер.
export function useLeaveGuard(shouldGuard) {
  const guardRef = useRef(shouldGuard)
  guardRef.current = shouldGuard
  const [showConfirm, setShowConfirm] = useState(false)

  useEffect(() => {
    // Добавляем "запасную" запись в историю — первое нажатие "назад" перехватываем здесь
    window.history.pushState(null, '', window.location.href)
    const handlePopState = () => {
      if (!guardRef.current) {
        window.history.back()
        return
      }
      setShowConfirm(true)
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  useEffect(() => {
    const handler = (e) => {
      if (guardRef.current) { e.preventDefault(); e.returnValue = '' }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])

  // Остаться на странице — восстанавливаем "запасную" запись для следующего "назад"
  const stayOnPage = () => {
    window.history.pushState(null, '', window.location.href)
    setShowConfirm(false)
  }
  // Уйти со страницы по-настоящему (без сохранения)
  const leavePage = () => {
    setShowConfirm(false)
    window.history.back()
  }

  return { showLeaveConfirm: showConfirm, stayOnPage, leavePage }
}
