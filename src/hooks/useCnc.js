import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { getCnc, fetchCnc, saveCnc, withShared, normalizeCnc } from '../lib/cncSettings'
import { listSharedPosts, saveSharedPost, removeSharedPost, sendNews } from '../lib/messages'
import { productionCnc, saveProductionCnc } from '../lib/productionApi'
import { hasBeta } from '../lib/beta'

// Настройки ЧПУ (постпроцессоры, инструменты, обработка) — одни и те же в кабинете производства и в заказе:
// поправили в одном месте — в другом уже так же. onSaved — что сделать после изменения (например, сбросить созданные программы).
// prodId — производство: владелец работает со своими настройками и они копируются в производство; начальник производства
// и сотрудник с правом «Управляющие программы» берут настройки производства (начальник может их и менять).
const forStore = cnc => ({ ...cnc, posts: cnc.posts.filter(p => !p.shared) })
export function useCnc(onSaved, prodId = null) {
  const { user, profile, isMaster } = useAuth()
  const [cnc, setCnc] = useState(() => getCnc(user))
  // последние настройки — сразу, без ожидания перерисовки: две правки подряд (ушли из поля «Название» и нажали кнопку)
  // не должны затирать друг друга
  const latest = useRef(cnc)
  const [ready, setReady] = useState(false)
  const [staff, setStaff] = useState(false)
  const mode = useRef({ prod: null, staff: false, edit: false })    // staff — настройки производства, а не свои
  useEffect(() => {
    let alive = true
    // свои настройки + общие постпроцессоры (мастер-аккаунт отметил «для всех») + настройки производства
    // β Пильный центр: постпроцессор пилы — только у мастер-аккаунта и бета-тестеров
    Promise.all([fetchCnc(user), listSharedPosts(), productionCnc(prodId), hasBeta('beam_saw')]).then(([c, sh, pc, beam]) => {
      if (!alive) return
      const shared = sh.data || []
      const opts = { beam: !!beam }
      if (pc && !pc.own && pc.cnc) {
        mode.current = { prod: prodId, staff: true, edit: !!pc.edit }
        const v = withShared(normalizeCnc(pc.cnc, [], opts), shared, opts)
        latest.current = v; setCnc(v); setStaff(true)
      } else {
        mode.current = { prod: pc?.own ? prodId : null, staff: false, edit: false }
        const mine = withShared(c, shared, opts)
        latest.current = mine; setCnc(mine); setStaff(false)
        if (pc?.own) saveProductionCnc(prodId, forStore(mine))            // сотрудники сразу получают актуальные настройки
      }
      setReady(true)
    })
    return () => { alive = false }
  }, [user?.id, prodId])   // eslint-disable-line react-hooks/exhaustive-deps

  // next — новые настройки или функция от последних (prev => next)
  const change = arg => {
    const prev = latest.current
    const next = typeof arg === 'function' ? arg(prev) : arg
    latest.current = next
    setCnc(next); onSaved?.(next)
    const md = mode.current
    if (md.staff) { if (md.edit) saveProductionCnc(md.prod, forStore(next)); return }   // сотрудник без права менять — только на время
    saveCnc(next, user)
    if (md.prod) saveProductionCnc(md.prod, forStore(next))
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
  return { cnc, change, ready, isMaster, staff }
}
