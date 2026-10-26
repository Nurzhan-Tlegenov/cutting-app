// «Что нового»: новости мастер-аккаунта, которые человек ещё не видел, всплывают окном — при открытии приложения,
// при возврате в него и раз в 10 минут, на телефоне и на компьютере. Несколько новых — по очереди («1 из 3»).
// «Понятно» — новость прочитана (глазик у мастера), второй раз не появится (на любом устройстве); вышла новая — снова окно.
// Мастер-аккаунту окно не показывается (новости пишет он сам).
import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { fetchUserSettings, getUserSettings, saveUserSettings } from '../lib/userSettings'
import { markNewsSeen } from '../lib/activity'

const FRESH_DAYS = 21          // старше — уже не «новое», окном не показываем
const PUBLIC = /^\/(auth|view|v|s|join|r)(\/|$)/

export default function NewsPopup() {
  const { user, isMaster } = useAuth()
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const [queue, setQueue] = useState([])      // непрочитанные новости, от старой к новой: показываем по одной
  const [pos, setPos] = useState(0)
  const off = !user || isMaster || PUBLIC.test(pathname)
  const news = queue[pos] || null
  const showing = useRef(false)
  showing.current = !!news

  // Проверка: при открытии приложения, при возврате в него (вкладка / приложение снова на экране) и раз в 10 минут —
  // вышла новость, которую человек ещё не видел, — окно появляется (на телефоне и на компьютере одинаково)
  useEffect(() => {
    if (off) return
    let alive = true
    const check = async () => {
      if (showing.current || document.hidden) return
      try {
        const st = await fetchUserSettings(user)
        // видел всё, что вышло до этой отметки: «Понятно» в окне или открыл «Сообщения»
        const seen = [st.msgSeenAt || '', user.created_at || '', new Date(Date.now() - FRESH_DAYS * 86400000).toISOString()].sort().pop()
        const { data, error } = await supabase.from('app_messages').select('id,created_at,title,body')
          .eq('kind', 'news').is('to_id', null).gt('created_at', seen).order('created_at', { ascending: true }).limit(10)
        if (!alive || error || !data?.length || showing.current) return
        const list = data.filter(n => n.id !== st.newsPopupId)
        if (list.length) { setQueue(list); setPos(0) }
      } catch { /* нет связи — проверим в другой раз */ }
    }
    const t = setTimeout(check, 1500)   // сначала пусть откроется сама страница
    const iv = setInterval(check, 10 * 60 * 1000)
    const onShow = () => { if (!document.hidden) check() }
    document.addEventListener('visibilitychange', onShow)
    window.addEventListener('focus', onShow)
    return () => { alive = false; clearTimeout(t); clearInterval(iv); document.removeEventListener('visibilitychange', onShow); window.removeEventListener('focus', onShow) }
  }, [off, user?.id])   // eslint-disable-line react-hooks/exhaustive-deps

  if (off || !news) return null
  // «Понятно» — эта новость прочитана, следующая (если есть) открывается сразу; «Все новости» — прочитаны все и переход в «Сообщения»
  const close = more => {
    const done = more ? queue.slice(pos) : [news]
    markNewsSeen(done.map(n => n.id))
    const last = done[done.length - 1]
    const seen = getUserSettings(user).msgSeenAt || ''
    saveUserSettings({ newsPopupId: last.id, ...(last.created_at > seen ? { msgSeenAt: last.created_at } : {}) }, user)
    window.dispatchEvent(new Event('messages-recount'))
    if (!more && pos + 1 < queue.length) { setPos(pos + 1); return }
    setQueue([]); setPos(0)
    if (more) navigate('/messages')
  }
  const when = new Date(news.created_at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 3000, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div role="dialog" aria-modal="true" style={{ background: 'var(--bg)', borderRadius: 18, width: '100%', maxWidth: 460, maxHeight: '85vh', display: 'flex', flexDirection: 'column', boxShadow: '0 12px 40px rgba(0,0,0,0.25)' }}>
        <div style={{ padding: '16px 18px 8px' }}>
          <div style={{ fontSize: 12, color: 'var(--blue)', fontWeight: 600, marginBottom: 4 }}>🚀 Что нового · {when}{queue.length > 1 ? ` · ${pos + 1} из ${queue.length}` : ''}</div>
          <div style={{ fontSize: 17, fontWeight: 600 }}>{news.title || 'Новость РаскройPro'}</div>
        </div>
        <div style={{ padding: '0 18px', overflowY: 'auto', fontSize: 14, lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{news.body}</div>
        <div style={{ display: 'flex', gap: 8, padding: 16 }}>
          <button type="button" className="btn-secondary" style={{ flex: 1 }} onClick={() => close(true)}>Все новости</button>
          <button type="button" className="btn-primary" style={{ flex: 1 }} onClick={() => close(false)}>{pos + 1 < queue.length ? 'Понятно · дальше' : 'Понятно'}</button>
        </div>
      </div>
    </div>
  )
}
