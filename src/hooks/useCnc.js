import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { getCnc, fetchCnc, saveCnc, withShared } from '../lib/cncSettings'
import { listSharedPosts, saveSharedPost, removeSharedPost, sendNews } from '../lib/messages'

// Настройки ЧПУ аккаунта (постпроцессоры, инструменты, обработка) — одни и те же в кабинете производства и в заказе:
// поправили в одном месте — в другом уже так же. onSaved — что сделать после изменения (например, сбросить созданные программы).
export function useCnc(onSaved) {
  const { user, profile, isMaster } = useAuth()
  const [cnc, setCnc] = useState(() => getCnc(user))
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let alive = true
    // свои настройки + общие постпроцессоры (мастер-аккаунт отметил «для всех»)
    Promise.all([fetchCnc(user), listSharedPosts()]).then(([c, sh]) => { if (alive) { setCnc(withShared(c, sh.data || [])); setReady(true) } })
    return () => { alive = false }
  }, [user?.id])   // eslint-disable-line react-hooks/exhaustive-deps

  const change = next => {
    const prev = cnc
    setCnc(next); saveCnc(next, user); onSaved?.(next)
    if (!isMaster) return
    // «для всех»: общий постпроцессор хранится отдельно и виден каждому пользователю
    for (const p of next.posts) {
      const was = prev.posts.find(q => q.id === p.id)
      if (p.forAll && p !== was) {
        saveSharedPost(p, user)
        if (!was?.forAll && !was?.shared) sendNews(user, profile, 'Новый постпроцессор', `Добавлен постпроцессор «${p.name}». Он уже доступен в разделе ЧПУ → Основные.`)
      } else if (!p.forAll && (was?.forAll || was?.shared)) removeSharedPost(p.id)
    }
    prev.posts.forEach(q => { if ((q.forAll || q.shared) && !next.posts.some(p => p.id === q.id)) removeSharedPost(q.id) })
  }
  return { cnc, change, ready, isMaster }
}
