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
    const { data } = await supabase.from('profiles').select('*').eq('id', userId).single()
    setProfile(data)
    setLoading(false)
  }

  async function signUp(email, password, profileData) {
    // Вход идёт по номеру телефона (служебный адрес собирается из него). Настоящая почта необязательна и лежит
    // в данных аккаунта (contact_email) — для восстановления пароля; на вход она не влияет.
    const contact = String(profileData.contact_email || '').trim()
    const { data, error } = await supabase.auth.signUp({ email, password, ...(contact ? { options: { data: { contact_email: contact } } } : {}) })
    if (error) throw error
    if (data.user) {
      await supabase.from('profiles').insert({
        id: data.user.id,
        email,
        full_name: profileData.full_name,
        phone: profileData.phone,
        whatsapp: profileData.whatsapp,
        role: 'client'
      })
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
