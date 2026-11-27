import { createClient } from '@supabase/supabase-js'
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase'

// Переключение аккаунтов для «Официального представителя RaskroyPro» (PartnerPage):
// представитель держит на своём устройстве входы в аккаунты своих производств и переходит в них одним нажатием —
// настроить постпроцессоры, зазоры, открыть заказ, — без выхода из своего аккаунта и без повторного ввода пароля.
// Входы хранятся только на этом устройстве (как обычный вход в приложение). Владелец списка — аккаунт представителя;
// в списке — только закреплённые за ним клиенты (проверяется при добавлении и при каждом открытии кабинета).
const KEY = 'rpAccounts'

function read() {
  try { const s = JSON.parse(localStorage.getItem(KEY) || 'null'); return s && s.owner && Array.isArray(s.list) ? s : null } catch { return null }
}
function write(s) {
  try { if (s) localStorage.setItem(KEY, JSON.stringify(s)); else localStorage.removeItem(KEY) } catch { /* без памяти */ }
  try { window.dispatchEvent(new Event('accounts')) } catch { /* вне браузера */ }
}

export const accountsState = () => read()
export const clearAccounts = () => write(null)
/** вошли в аккаунт производства из кабинета представителя → { owner, ownerName, me: { id, label } } */
export function switchedInfo(userId) {
  const s = read()
  if (!s || !userId || userId === s.owner) return null
  const me = s.list.find(a => a.id === userId)
  return me ? { owner: s.owner, ownerName: s.list.find(a => a.id === s.owner)?.label || 'представитель', me } : null
}

// токены всех входов из списка держим свежими: после обновления сессии старый refresh-токен уже не годится
supabase.auth.onAuthStateChange((event, session) => {
  if (!session?.user) return
  const s = read()
  const a = s?.list.find(x => x.id === session.user.id)
  if (!a || (a.at === session.access_token && a.rt === session.refresh_token)) return
  a.at = session.access_token; a.rt = session.refresh_token
  write(s)
})

/** кабинет представителя: он — владелец списка; клиенты, которые больше не закреплены за ним, убираются */
export function initOwner(user, label, clientIds) {
  if (!user?.id) return
  let s = read()
  if (!s || s.owner !== user.id) s = { owner: user.id, list: [] }   // на устройстве вошёл другой представитель — чужие входы не нужны
  const ok = new Set(clientIds || [])
  s.list = s.list.filter(a => a.id === user.id || ok.has(a.id))
  const me = s.list.find(a => a.id === user.id)
  if (me) me.label = label || me.label
  else s.list.unshift({ id: user.id, label: label || 'Мой аккаунт' })
  write(s)
}

async function saveCurrent() {
  const { data: { session } } = await supabase.auth.getSession()
  const s = read()
  const a = session && s?.list.find(x => x.id === session.user.id)
  if (a) { a.at = session.access_token; a.rt = session.refresh_token; write(s) }
}

/** перейти в другой аккаунт из списка (приложение открывается заново, уже в нём) */
export async function switchTo(id, path = '/') {
  const s = read()
  const a = s?.list.find(x => x.id === id)
  if (!a?.rt) return { error: 'Нет сохранённого входа — добавьте вход заново' }
  await saveCurrent()
  const { error } = await supabase.auth.setSession({ access_token: a.at || '', refresh_token: a.rt })
  if (error) {
    if (id !== s.owner) { a.at = a.rt = null; write(s) }
    return { error: id === s.owner ? 'Вход в ваш аккаунт истёк — войдите заново' : 'Вход в этот аккаунт истёк — добавьте вход заново (номер и пароль компании)' }
  }
  window.location.assign(path)
  return { ok: true }
}

function addSession(label, session) {
  const s = read()
  if (!s) return
  const i = s.list.findIndex(x => x.id === session.user.id)
  const row = { id: session.user.id, label, at: session.access_token, rt: session.refresh_token }
  if (i >= 0) s.list[i] = { ...s.list[i], ...row }; else s.list.push(row)
  write(s)
}
export function removeAccount(id) {
  const s = read()
  if (!s || id === s.owner) return
  s.list = s.list.filter(x => x.id !== id)
  write(s)
}

// отдельный клиент базы без сохранения входа: вход/регистрация компании, не трогая вход представителя
const tmpClient = () => createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'rp-tmp-' + Date.now() } })
function loginEmails(login) {
  const t = String(login || '').trim()
  if (t.includes('@')) return [t.toLowerCase()]
  const d = t.replace(/\D/g, '')
  const out = [d]
  if (d.length === 11 && d[0] === '8') out.push('7' + d.slice(1))
  if (d.length === 10) out.push('7' + d)
  return [...new Set(out)].map(x => `${x}@raskoypro.local`)
}

/** добавить вход в аккаунт своего клиента: номер (или почта) и пароль — один раз */
export async function addAccountByPassword(login, password, label, clientIds) {
  const tmp = tmpClient()
  let res = null, last = null
  for (const email of loginEmails(login)) {
    const r = await tmp.auth.signInWithPassword({ email, password })
    if (!r.error) { res = r.data; break }
    last = r.error
    if (!/Invalid login/i.test(r.error.message)) break
  }
  if (!res?.session) return { error: /Invalid login/i.test(last?.message || '') ? 'Неверный номер или пароль' : (last?.message || 'Не удалось войти') }
  if (!(clientIds || []).includes(res.session.user.id)) return { error: 'Этот аккаунт не закреплён за вами — переходить можно только в аккаунты своих клиентов' }
  addSession(label, res.session)
  return { ok: true, id: res.session.user.id }
}

/** представитель создаёт аккаунт компании по коду (partner_register_company) — производство сразу подтверждено и закреплено за ним */
export async function createCompanyAccount({ name, digits, code, ref, password, country, city }) {
  const phone = '+' + digits, email = `${digits}@raskoypro.local`
  const c = await supabase.rpc('confirm_signup_code', { p_phone: phone, p_code: code })
  if (c.error) return { error: c.error.message }
  if (c.data && c.data !== 'ok') {
    const t = { bad: 'Код не подошёл', expired: 'Срок кода вышел — сформируйте новый', blocked: 'Слишком много попыток — сформируйте новый код', registered: 'Номер уже зарегистрирован', nocode: 'Код не сформирован' }
    return { error: t[c.data] || 'Код не подошёл' }
  }
  const tmp = tmpClient()
  const { data, error } = await tmp.auth.signUp({ email, password, options: { data: { full_name: name, phone, country, city } } })
  if (error) return { error: /already registered/i.test(error.message) ? 'Номер уже зарегистрирован' : error.message }
  if (!data.session) return { error: 'Аккаунт создан, но вход не получен — войдите в него через «Добавить вход»' }
  const uid = data.user.id
  const row = { id: uid, email, full_name: name, phone, whatsapp: phone, role: 'client' }
  let p = await tmp.from('profiles').insert({ ...row, country, city })
  if (p.error) p = await tmp.from('profiles').insert(row)
  if (p.error) await tmp.from('profiles').update({ full_name: name, phone, whatsapp: phone }).eq('id', uid)
  try { await tmp.rpc('ensure_profile') } catch { /* база ещё старая */ }
  await tmp.rpc('accept_ref', { p_code: ref })   // закрепляется за представителем (trg_partner_ref)
  const pr = await tmp.rpc('register_production', { p_name: name, p_phone: phone, p_city: city || '', p_kerf: null, p_ml: null, p_mr: null, p_mt: null, p_mb: null, p_country: country || '' })
  addSession(name, data.session)
  return { ok: true, id: uid, productionError: pr.error ? pr.error.message : '' }
}
