// «Что нового»: свежая новость мастер-аккаунта один раз всплывает окном при открытии приложения.
// «Понятно» — новость засчитывается как прочитанная (глазик у мастера), второй раз это окно не появится (на любом устройстве).
import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { fetchUserSettings, saveUserSettings } from '../lib/userSettings'
import { markNewsSeen } from '../lib/activity'

const FRESH_DAYS = 21          // старше — уже не «новое», окном не показываем
const PUBLIC = /^\/(auth|view|v|s|join|r)(\/|$)/

export default function NewsPopup() {
  const { user, isMaster } = useAuth()
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const [news, setNews] = useState(null)
  const off = !user || isMaster || PUBLIC.test(pathname)

  useEffect(() => {
    if (off) return
    let alive = true
    const t = setTimeout(async () => {   // сначала пусть откроется сама страница
      try {
        const st = await fetchUserSettings(user)
        const since = new Date(Date.now() - FRESH_DAYS * 86400000).toISOString()
        const { data, error } = await supabase.from('app_messages').select('id,created_at,title,body')
          .eq('kind', 'news').is('to_id', null).gt('created_at', since).order('created_at', { ascending: false }).limit(1)
        const n = !error && data?.[0]
        if (!alive || !n || st.newsPopupId === n.id) return
        // новость вышла раньше, чем человек зарегистрировался, — для него это не новость
        if (user.created_at && n.created_at < user.created_at) return
        setNews(n)
      } catch { /* нет связи — покажем в другой раз */ }
    }, 1500)
    return () => { alive = false; clearTimeout(t) }
  }, [off, user?.id])   // eslint-disable-line react-hooks/exhaustive-deps

  if (off || !news) return null
  const close = more => {
    markNewsSeen([news.id])
    saveUserSettings({ newsPopupId: news.id }, user)
    setNews(null)
    if (more) navigate('/messages')
  }
  const when = new Date(news.created_at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 3000, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div role="dialog" aria-modal="true" style={{ background: 'var(--bg)', borderRadius: 18, width: '100%', maxWidth: 460, maxHeight: '85vh', display: 'flex', flexDirection: 'column', boxShadow: '0 12px 40px rgba(0,0,0,0.25)' }}>
        <div style={{ padding: '16px 18px 8px' }}>
          <div style={{ fontSize: 12, color: 'var(--blue)', fontWeight: 600, marginBottom: 4 }}>🚀 Что нового · {when}</div>
          <div style={{ fontSize: 17, fontWeight: 600 }}>{news.title || 'Новость РаскройPro'}</div>
        </div>
        <div style={{ padding: '0 18px', overflowY: 'auto', fontSize: 14, lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{news.body}</div>
        <div style={{ display: 'flex', gap: 8, padding: 16 }}>
          <button type="button" className="btn-secondary" style={{ flex: 1 }} onClick={() => close(true)}>Все новости</button>
          <button type="button" className="btn-primary" style={{ flex: 1 }} onClick={() => close(false)}>Понятно</button>
        </div>
      </div>
    </div>
  )
}
