// Push-уведомления в шторку телефона: подписка этого телефона (браузера) и проверка.
// Сообщения рассылает функция Supabase «push» (supabase/functions/push) по событиям в базе (migration_push.sql).
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase'

export const PUSH_SQL_HINT = 'Push-уведомления ещё не включены в базе: установите функцию «push» и выполните migration_push.sql в Supabase (SQL Editor).'

export const pushSupported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
export const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
export const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true

/** Регистрируем service worker при запуске (он только показывает уведомления, ничего не кэширует) */
export function registerSW() {
  if (!('serviceWorker' in navigator)) return
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}) })
}

const b64 = s => { const t = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4); return Uint8Array.from(atob(t), c => c.charCodeAt(0)) }
const toB64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

async function fn(body) {
  const { data: { session } } = await supabase.auth.getSession()
  const r = await fetch(`${SUPABASE_URL}/functions/v1/push`, {
    // шлюз Supabase требует открытый ключ проекта (apikey) — без него отвечает 401 MISSING_CREDENTIALS
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ ...body, jwt: session?.access_token || '' }),
  })
  if (r.status === 404) return { error: 'Функция «push» не найдена в Supabase → Edge Functions (имя должно быть ровно push)' }
  const data = await r.json().catch(() => null)
  if (r.status === 401) return { error: `Функция push отвечает 401: ${String(data?.message || data?.msg || data?.code || '').slice(0, 160)}` }
  if (!data) return { error: `Функция push ответила ${r.status}` }
  if (!data.error && !data.key && !data.ok) return { error: `Функция push ответила ${r.status}: ${String(data.message || data.msg || JSON.stringify(data)).slice(0, 160)}` }
  return data
}

async function publicKey() {
  const { data, error } = await supabase.rpc('push_public_key')
  if (error) return { error: PUSH_SQL_HINT }
  if (data) return { key: data }
  const r = await fn({ action: 'init' })                // ключи ещё не созданы — функция создаст их сейчас
  return r.key ? { key: r.key } : { error: r.error || 'Нет ключа уведомлений' }
}

async function swReady() {
  if (!navigator.serviceWorker.controller && !(await navigator.serviceWorker.getRegistration())) await navigator.serviceWorker.register('/sw.js')
  return await Promise.race([navigator.serviceWorker.ready, new Promise((_, no) => setTimeout(() => no(new Error('Service worker не запустился')), 8000))])
}

async function save(sub) {
  const j = sub.toJSON()
  return supabase.from('push_subscriptions').upsert({ endpoint: sub.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, ua: navigator.userAgent.slice(0, 200) }, { onConflict: 'endpoint' })
}

/** 'unsupported' | 'ios-home' (iPhone: сначала «На экран Домой») | 'denied' | 'on' | 'off' */
export async function pushStatus() {
  if (!pushSupported()) return isIOS() && !isStandalone() ? 'ios-home' : 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  if (Notification.permission !== 'granted') return 'off'
  const reg = await navigator.serviceWorker.getRegistration()
  const sub = await reg?.pushManager.getSubscription()
  return sub ? 'on' : 'off'
}

/** Включить уведомления на этом телефоне. Вызывать по нажатию кнопки (иначе браузер не спросит разрешение) */
export async function enablePush() {
  try {
    if (!pushSupported()) return { error: isIOS() ? 'На iPhone уведомления работают, когда приложение добавлено на экран «Домой» (Поделиться → «На экран Домой»), и открыто оттуда.' : 'Этот браузер не поддерживает уведомления.' }
    const perm = await Notification.requestPermission()
    if (perm !== 'granted') return { error: perm === 'denied' ? 'Уведомления запрещены в настройках браузера для raskroypro.com — разрешите их там.' : 'Разрешение не дано.' }
    const k = await publicKey()
    if (k.error) return k
    const reg = await swReady()
    let sub = await reg.pushManager.getSubscription()
    if (sub && sub.options?.applicationServerKey && toB64(sub.options.applicationServerKey) !== k.key) { await sub.unsubscribe(); sub = null }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(k.key) })
    let r = await save(sub)
    if (r.error) {                                      // телефон был подписан на другой аккаунт — подписываем заново
      await sub.unsubscribe()
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(k.key) })
      r = await save(sub)
    }
    if (r.error) return { error: /push_subscriptions/.test(r.error.message) ? PUSH_SQL_HINT : r.error.message }
    return { ok: true }
  } catch (e) { return { error: String(e?.message || e) } }
}

/** При запуске: разрешение уже есть — подписка этого телефона привязывается к вошедшему аккаунту */
export async function syncPush() {
  try {
    if (!pushSupported() || Notification.permission !== 'granted') return
    const reg = await navigator.serviceWorker.getRegistration()
    const sub = await reg?.pushManager.getSubscription()
    if (sub) { const r = await save(sub); if (r.error) await enablePush() }
  } catch { /* без уведомлений */ }
}

/** Выход из аккаунта: этот телефон больше не получает уведомления этого аккаунта */
export async function forgetPush() {
  try {
    const reg = await navigator.serviceWorker?.getRegistration()
    const sub = await reg?.pushManager.getSubscription()
    if (sub) await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint)
  } catch { /* не важно */ }
}

export async function disablePush() {
  await forgetPush()
  try { const reg = await navigator.serviceWorker?.getRegistration(); const sub = await reg?.pushManager.getSubscription(); await sub?.unsubscribe() } catch { /* уже отписан */ }
}

/** Проверочное уведомление себе — приходит через сервер, как настоящее */
export const testPush = () => fn({ action: 'test' }).catch(e => ({ error: String(e?.message || e) }))

// ── звук внутри открытого приложения ──
const SOUND = 'noticeSound'
export const soundOn = () => { try { return localStorage.getItem(SOUND) !== '0' } catch { return true } }
export const setSoundOn = v => { try { localStorage.setItem(SOUND, v ? '1' : '0') } catch { /* без памяти */ } }
let ctx = null
export function playNoticeSound() {
  if (!soundOn()) return
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)()
    if (ctx.state === 'suspended') ctx.resume()
    const t = ctx.currentTime
    for (const [f, d] of [[880, 0], [1320, 0.16]]) {       // два коротких тона «дзинь-дзинь»
      const o = ctx.createOscillator(), g = ctx.createGain()
      o.type = 'sine'; o.frequency.value = f
      g.gain.setValueAtTime(0.0001, t + d); g.gain.exponentialRampToValueAtTime(0.35, t + d + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.25)
      o.connect(g); g.connect(ctx.destination); o.start(t + d); o.stop(t + d + 0.27)
    }
  } catch { /* без звука */ }
}
