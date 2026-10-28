import { nameOk, phoneOk } from '../lib/profileRules'
import { createContext, useContext, useEffect, useState } from 'react'
import { forgetPush } from '../lib/push'
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from '../lib/supabase'
import { purgeArchived } from '../lib/orderArchive'
import { touchActivity } from '../lib/activity'

let purged = false   // заказы с истёкшим сроком хранения в архиве удаляются раз за запуск приложения
import { getUserSettings, saveUserSettings, fetchUserSettings } from '../lib/userSettings'

const AuthContext = createContext(null)

/** Аккаунт по номеру телефона (служебный адрес «цифры@raskoypro.local»); иначе — настоящая почта (email или Google) */
export const isPhoneAccount = u => /@raskoypro\.local$/i.test(String(u?.email || ''))
/** Включён ли вход через Google в Supabase (Authentication → Providers). На зеркале для России — нет: Google туда не вернёт */
let googleOnCache = null
export async function googleEnabled() {
  if (typeof window !== 'undefined' && /^ru\./i.test(window.location.hostname)) return false
  if (googleOnCache != null) return googleOnCache
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/settings`, { headers: { apikey: SUPABASE_ANON_KEY } })
    const j = await r.json()
    googleOnCache = !!j?.external?.google
  } catch { googleOnCache = false }
  return googleOnCache
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  const [recovery, setRecovery] = useState(() => { try { return /type=recovery/.test(window.location.hash) } catch { return false } })   // открыли ссылку «сменить пароль» из письма — сначала новый пароль
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
  // «пользователь в приложении» — для статистики вовлечённости мастер-аккаунта (раз в полчаса, и когда приложение снова открыли)
  useEffect(() => {
    if (!user?.id) return
    touchActivity(user.id)
    const on = () => { if (document.visibilityState === 'visible') touchActivity(user.id) }
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [user?.id])
  const setCabinet = mode => { const m = mode === 'production' ? 'production' : 'client'; setCabinetState(m); saveUserSettings({ cabinet: m }, user) }

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null)
      if (session?.user) fetchProfile(session.user.id)
      else setLoading(false)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') setRecovery(true)
      setUser(session?.user ?? null)
      if (session?.user) fetchProfile(session.user.id)
      else { setProfile(null); setLoading(false) }
    })
    return () => subscription.unsubscribe()
  }, [])

  async function fetchProfile(userId) {
    if (!purged) { purged = true; purgeArchived() }
    let { data } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle()
    const { data: { session: ses } } = await supabase.auth.getSession()
    const byPhone = isPhoneAccount(ses?.user)
    // Профиля нет или в нём нет имени / телефона (так бывало после регистрации по заявке) — производство тогда не видит,
    // чей заказ. Дозаполняем: база берёт имя из заявки на регистрацию и номер входа, остальное — из данных регистрации.
    // У аккаунта по почте (email, Google) телефона может не быть — его отсутствие не повод для лишних запросов при каждом входе.
    if (!data || !String(data.full_name || '').trim() || (byPhone && !String(data.phone || '').trim())) {
      try {
        await supabase.rpc('ensure_profile')
        const { data: u } = await supabase.auth.getUser()
        const meta = u?.user?.user_metadata || {}
        const { data: again } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle()
        if (again) {
          data = again
          const patch = {}
          const metaName = meta.full_name || meta.name   // Google кладёт имя в full_name / name
          if (!String(again.full_name || '').trim() && metaName) patch.full_name = metaName
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
    const country = String(profileData.country || '').trim(), city = String(profileData.city || '').trim()
    const invite = String(profileData.invite || '').trim()   // регистрация по приглашению производства — без заявки, сразу сотрудник
    const meta = { full_name: profileData.full_name || '', phone: profileData.phone || '', country, city, ...(contact ? { contact_email: contact } : {}), ...(invite ? { invite } : {}) }
    const { data, error } = await supabase.auth.signUp({ email, password, options: { data: meta } })
    if (error) throw error
    if (data.user) {
      const row = { id: data.user.id, email, full_name: profileData.full_name, phone: profileData.phone, whatsapp: profileData.whatsapp, role: 'client' }
      // страна и город — в профиле (migration_user_location.sql); пока в базе нет этих колонок, они остаются в данных аккаунта
      // Пустое не записываем поверх заполненного: при входе «У меня есть код» имени здесь нет (оно в заявке), а профиль
      // параллельно уже создан с именем из заявки (ensure_profile при входе) — обновление пустым затирало имя, и мастер
      // видел «Без имени», пока человек не открывал приложение снова
      const filled = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && String(v).trim() !== ''))
      let { error: pErr } = await supabase.from('profiles').insert({ ...row, country, city })
      if (pErr) ({ error: pErr } = await supabase.from('profiles').insert(row))
      // профиль не создался (например, запись уже есть) — дописываем непустые данные обновлением
      if (pErr) {
        const base = filled({ full_name: row.full_name, phone: row.phone, whatsapp: row.whatsapp })
        if (Object.keys(base).length) await supabase.from('profiles').update(base).eq('id', row.id)
        const loc = filled({ country, city })
        if (Object.keys(loc).length) await supabase.from('profiles').update(loc).eq('id', row.id)   // нет колонок — ошибка, это не страшно
      }
      // имени нет (вход по коду) — сразу из заявки, а не при следующем открытии приложения
      if (!String(row.full_name || '').trim()) { try { await supabase.rpc('ensure_profile') } catch { /* база ещё старая */ } }
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

  /** Вход через Google: уходим на страницу Google, возвращаемся на /auth уже с входом */
  async function signInWithGoogle() {
    const { error } = await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: `${window.location.origin}/auth` } })
    if (error) throw error
  }

  /** Письмо со ссылкой для смены пароля (аккаунт по почте) */
  async function sendResetEmail(email) {
    const { error } = await supabase.auth.resetPasswordForEmail(String(email || '').trim(), { redirectTo: `${window.location.origin}/auth` })
    if (error) throw error
  }

  /** Новый пароль после ссылки из письма */
  async function setNewPassword(password) {
    const { error } = await supabase.auth.updateUser({ password })
    if (error) throw error
    setRecovery(false)
  }

  /** Дозаполнить профиль (аккаунт по почте: имя, страна, город, телефон — необязательно) */
  async function completeProfile(fields) {
    const { data: { session } } = await supabase.auth.getSession()
    const u = session?.user
    if (!u) throw new Error('Войдите заново')
    const clean = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, String(v ?? '').trim()]))
    const row = { full_name: clean.full_name, country: clean.country, city: clean.city, ...(clean.phone ? { phone: clean.phone, whatsapp: clean.phone } : {}) }
    let { data, error } = await supabase.from('profiles').update(row).eq('id', u.id).select('id')
    if (!error && !data?.length) ({ error } = await supabase.from('profiles').insert({ id: u.id, email: u.email, role: 'client', ...row }))
    if (error) throw error
    await fetchProfile(u.id)
  }

  async function signOut() {
    await forgetPush()   // этот телефон больше не получает уведомления этого аккаунта
    await supabase.auth.signOut()
  }

  // аккаунт по почте без имени, страны или города — сначала дозаполнить профиль (у Google их нет до входа)
  const needsProfile = !!user && !loading && !isPhoneAccount(user) && profile?.role !== 'admin'
    && (!nameOk(profile?.full_name) || !phoneOk(profile?.phone) || !String(profile?.country || '').trim() || !String(profile?.city || '').trim())

  return (
    <AuthContext.Provider value={{ user, profile, loading, signUp, signIn, signOut, setContactEmail, refreshProfile: () => (user ? fetchProfile(user.id) : null),
      signInWithGoogle, sendResetEmail, setNewPassword, completeProfile, recovery, needsProfile,
      cabinet, setCabinet, isMaster: profile?.role === 'admin' }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
