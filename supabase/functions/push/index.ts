// Push-уведомления RaskroyPro: приходят в шторку телефона со звуком, даже когда приложение закрыто.
//
// Установка (один раз): Supabase → Edge Functions → Deploy a new function → Via Editor, имя функции «push»,
// вставить этот файл целиком → Deploy. В настройках функции выключить «Verify JWT» (её вызывает сама база
// после каждого события — без токена входа; функция только рассылает то, что база уже положила в очередь).
// Ключи шифрования (VAPID) функция создаёт сама при первом запуске и хранит в базе — секреты заводить не нужно.
// Затем выполнить migration_push.sql в SQL Editor.
//
// Как работает: событие в базе (новая заявка, смена статуса заказа…) → триггер кладёт строку в push_outbox
// и «будит» эту функцию → функция шифрует сообщение (RFC 8291) и отправляет его на все телефоны получателя.
// Если у человека push не включён, но номер подтверждён в Telegram — сообщение уходит от бота @RaskroyProBot.
//
// Запросы: { action: 'wake' } — разослать очередь; { action: 'init' } — вернуть открытый ключ;
//          { action: 'test', jwt } — проверочное уведомление себе.

import { createClient } from 'npm:@supabase/supabase-js@2'

const SB_URL = Deno.env.get('SUPABASE_URL') ?? ''
const TG_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const APP = 'https://raskroypro.com'
function serviceKey(): string {
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (legacy) return legacy
  try { const all = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}'); return all.default ?? Object.values(all)[0] ?? '' } catch { return '' }
}
let _db: ReturnType<typeof createClient> | null = null
function db() {
  if (_db) return _db
  const key = serviceKey()
  if (!SB_URL || !key) throw new Error('Нет SUPABASE_URL или серверного ключа в окружении функции')
  _db = createClient(SB_URL, key, { auth: { persistSession: false, autoRefreshToken: false } })
  return _db
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

// ── base64url ──
const b64u = (buf: ArrayBuffer | Uint8Array) => {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let s = ''; for (const x of b) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const unb64u = (s: string) => {
  const t = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)
  return Uint8Array.from(atob(t), c => c.charCodeAt(0))
}
const cat = (...a: Uint8Array[]) => { const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of a) { out.set(x, o); o += x.length } return out }
const enc = (s: string) => new TextEncoder().encode(s)

// ── ключи VAPID: создаются один раз и хранятся в push_keys ──
type Keys = { pub: string, priv: CryptoKey }
let _keys: Keys | null = null
async function keys(): Promise<Keys> {
  if (_keys) return _keys
  let { data } = await db().from('push_keys').select('public_key, private_jwk').eq('id', 1).maybeSingle()
  if (!data) {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair
    const pub = b64u(await crypto.subtle.exportKey('raw', kp.publicKey))
    const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey)
    await db().from('push_keys').upsert({ id: 1, public_key: pub, private_jwk: jwk }, { onConflict: 'id', ignoreDuplicates: true })
    data = (await db().from('push_keys').select('public_key, private_jwk').eq('id', 1).single()).data   // кто первый записал — того и берём
  }
  const priv = await crypto.subtle.importKey('jwk', data!.private_jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  _keys = { pub: data!.public_key, priv }
  return _keys
}

async function vapidHeader(endpoint: string): Promise<string> {
  const k = await keys()
  const aud = new URL(endpoint).origin
  const head = b64u(enc(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const body = b64u(enc(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:support@raskroypro.com' })))
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k.priv, enc(`${head}.${body}`))
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${k.pub}`
}

// ── шифрование сообщения: RFC 8291 (aes128gcm) ──
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8))
}
export async function encryptPayload(p256dh: string, authSecret: string, text: string): Promise<Uint8Array> {
  const uaPub = unb64u(p256dh), auth = unb64u(authSecret)
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey))
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256))
  const ikm = await hkdf(auth, shared, cat(enc('WebPush: info\0'), uaPub, asPub), 32)
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const cek = await hkdf(salt, ikm, enc('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, enc('Content-Encoding: nonce\0'), 12)
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, cat(enc(text), new Uint8Array([2]))))
  const rs = new Uint8Array([0, 0, 16, 0])                       // размер записи 4096
  return cat(salt, rs, new Uint8Array([asPub.length]), asPub, ct)
}

type Sub = { id: string, endpoint: string, p256dh: string, auth: string }
async function sendPush(s: Sub, msg: Record<string, unknown>): Promise<number> {
  try {
    const body = await encryptPayload(s.p256dh, s.auth, JSON.stringify(msg))
    const r = await fetch(s.endpoint, {
      method: 'POST',
      headers: { Authorization: await vapidHeader(s.endpoint), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'high' },
      body,
    })
    if (r.status >= 400) console.log('push', r.status, s.endpoint.slice(0, 60), (await r.text().catch(() => '')).slice(0, 200))
    return r.status
  } catch (e) { console.error('push error', e); return 0 }
}

// Telegram — тем, у кого push не включён, но номер подтверждён в боте
async function tgChat(userId: string): Promise<number | null> {
  if (!TG_TOKEN) return null
  const { data } = await db().rpc('push_tg_chat', { p_user: userId })
  return typeof data === 'number' ? data : data ? Number(data) : null
}
async function sendTg(chat: number, msg: { title: string, body: string, url: string }) {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text: `🔔 <b>${esc(msg.title)}</b>${msg.body ? '\n' + esc(msg.body) : ''}`, parse_mode: 'HTML', disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: 'Открыть в RaskroyPro', url: APP + msg.url }]] } }),
  }).catch(() => {})
}

// ── очередь ──
let running = false
async function drain() {
  if (running) return { sent: 0, busy: true }
  running = true
  let sent = 0
  try {
    for (let round = 0; round < 10; round++) {
      const { data: rows } = await db().from('push_outbox').select('*').is('sent_at', null).order('created_at').limit(50)
      if (!rows?.length) break
      for (const m of rows) {
        await db().from('push_outbox').update({ sent_at: new Date().toISOString() }).eq('id', m.id)   // сначала помечаем — повторно не уйдёт
        const msg = { title: m.title, body: m.body || '', url: m.url || '/', tag: m.tag || m.id }
        const { data: subs } = await db().from('push_subscriptions').select('id, endpoint, p256dh, auth').eq('user_id', m.user_id)
        let ok = 0
        for (const s of subs || []) {
          const st = await sendPush(s as Sub, msg)
          if (st >= 200 && st < 300) ok++
          else if (st === 404 || st === 410) await db().from('push_subscriptions').delete().eq('id', s.id)   // телефон отписался
        }
        if (!ok) { const chat = await tgChat(m.user_id); if (chat) await sendTg(chat, msg) }
        sent++
      }
    }
    await db().from('push_outbox').delete().lt('created_at', new Date(Date.now() - 7 * 864e5).toISOString())   // старое — убираем
  } finally { running = false }
  return { sent }
}

async function userOf(jwt: string): Promise<string | null> {
  if (!jwt) return null
  const { data } = await db().auth.getUser(jwt)
  return data?.user?.id ?? null
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const qa = new URL(req.url).searchParams.get('action')
  if (req.method === 'GET') {
    if (qa === 'init') { try { return json({ key: (await keys()).pub }) } catch (e) { return json({ error: String((e as Error)?.message || e) }) } }
    return new Response('RaskroyPro push', { headers: CORS })
  }
  let body: any = {}
  try { body = JSON.parse((await req.text()) || '{}') } catch { body = {} }
  const action = body.action || qa || 'wake'
  try {
    if (action === 'init') return json({ key: (await keys()).pub })
    if (action === 'test') {
      const uid = await userOf(String(body.jwt || ''))
      if (!uid) return json({ error: 'Войдите заново' })
      await db().from('push_outbox').insert({ user_id: uid, title: 'RaskroyPro: проверка', body: 'Уведомления работают — так будут приходить новые заявки и статусы заказов.', url: '/go?t=home', tag: 'test' })
      return json({ ok: true, ...(await drain()) })
    }
    return json({ ok: true, ...(await drain()) })
  } catch (e) { return json({ error: String((e as Error)?.message || e) }, 500) }
})
