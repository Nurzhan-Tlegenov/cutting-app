import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { getUserSettings, saveUserSettings, fetchUserSettings } from '../lib/userSettings'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  // Кабинет, в котором сейчас работает пользователь: 'client' (заказы, раскрой) или 'production' (заявки, ЧПУ, бирки).
  // Выбор идёт за аккаунтом.
  const [cabinet, setCabinetState] = useState('client')
  useEffect(() => {
    if (!user) { setCabinetState('client'); return }
    setCabinetState(getUserSettings(user).cabinet === 'production' ? 'production' : 'client')
    let alive = true
    fetchUserSettings(user).then(st => { if (alive) setCabinetState(st.cabinet === 'production' ? 'production' : 'client') })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])
  const setCabinet = mode => { const m = mode === 'production' ? 'production' : 'client'; setCabinetState(m); saveUserSettings({ cabinet: m }, user) }

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null)
      if (session?.user) fetchProfile(session.user.id)
      else setLoading(false)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
      if (session?.user) fetchProfile(session.user.id)
      else { setProfile(null); setLoading(false) }
    })
    return () => subscription.unsubscribe()
  }, [])

  async function fetchProfile(userId) {
    let { data } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle()
    // Профиля нет или в нём нет имени / телефона (так бывало после регистрации по заявке) — производство тогда не видит,
    // чей заказ. Дозаполняем: база берёт имя из заявки на регистрацию и номер входа, остальное — из данных регистрации.
    if (!data || !String(data.full_name || '').trim() || !String(data.phone || '').trim()) {
      try {
        await supabase.rpc('ensure_profile')
        const { data: u } = await supabase.auth.getUser()
        const meta = u?.user?.user_metadata || {}
        const { data: again } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle()
        if (again) {
          data = again
          const patch = {}
          if (!String(again.full_name || '').trim() && meta.full_name) patch.full_name = meta.full_name
          if (!String(again.phone || '').trim() && meta.phone) patch.phone = meta.phone
          if (Object.keys(patch).length) { const { error } = await supabase.from('profiles').update(patch).eq('id', userId); if (!error) data = { ...again, ...patch } }
        }
      } catch { /* база ещё не обновлена — работаем с тем, что есть */ }
    }
    setProfile(data || null)
    setLoading(false)
  }

  async function signUp(email, password, profileData) {
    // Вход идёт по номеру телефона (служебный адрес собирается из него). Настоящая почта необязательна и лежит
    // в данных аккаунта (contact_email) — для восстановления пароля; на вход она не влияет.
    const contact = String(profileData.contact_email || '').trim()
    // имя и телефон дублируются в данных аккаунта: если профиль почему-то не создастся, они не потеряются
    const meta = { full_name: profileData.full_name || '', phone: profileData.phone || '', ...(contact ? { contact_email: contact } : {}) }
    const { data, error } = await supabase.auth.signUp({ email, password, options: { data: meta } })
    if (error) throw error
    if (data.user) {
      const row = { id: data.user.id, email, full_name: profileData.full_name, phone: profileData.phone, whatsapp: profileData.whatsapp, role: 'client' }
      const { error: pErr } = await supabase.from('profiles').insert(row)
      // профиль не создался (например, запись уже есть пустая) — записываем те же данные обновлением
      if (pErr) await supabase.from('profiles').update({ full_name: row.full_name, phone: row.phone, whatsapp: row.whatsapp }).eq('id', row.id)
    }
    return data
  }

  async function signIn(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
    return data
  }

  /** Почта для восстановления пароля ('' — убрать). -> текст ошибки или '' */
  async function setContactEmail(value) {
    const { data, error } = await supabase.auth.updateUser({ data: { contact_email: String(value || '').trim() } })
    if (error) return error.message
    if (data?.user) setUser(data.user)
    return ''
  }

  async function signOut() {
    await supabase.auth.signOut()
  }

  return (
    <AuthContext.Provider value={{ user, profile, loading, signUp, signIn, signOut, setContactEmail, refreshProfile: () => (user ? fetchProfile(user.id) : null),
      cabinet, setCabinet, isMaster: profile?.role === 'admin' }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
