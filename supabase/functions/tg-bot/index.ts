// Telegram-бот @RaskroyProBot: подтверждение номера при регистрации и отправка кода после одобрения заявки.
//
// Установка (один раз): Supabase → Edge Functions → Deploy a new function → Via Editor, имя функции «tg-bot»,
// вставить этот файл целиком → Deploy. В настройках функции выключить «Verify JWT» (Telegram не присылает токен
// входа — функция сама проверяет, что запрос пришёл от Telegram или от мастер-аккаунта).
// Токен бота — в секретах: Edge Functions → Secrets → TELEGRAM_BOT_TOKEN.
// Затем в приложении: «Пользователи» → «Подключить Telegram-бота».
//
// Запросы:
//   • от Telegram (вебхук) — заголовок X-Telegram-Bot-Api-Secret-Token;
//   • из приложения (только мастер-аккаунт): { action: 'setup' } — подключить вебхук,
//     { action: 'send_code', request_id } — отправить код по одобренной заявке в Telegram.

import { createClient } from 'npm:@supabase/supabase-js@2'

const TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const SB_URL = Deno.env.get('SUPABASE_URL') ?? ''
function serviceKey(): string {
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (legacy) return legacy
  try {   // новые ключи проекта: SUPABASE_SECRET_KEYS = {"default":"sb_secret_..."}
    const all = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}')
    return all.default ?? Object.values(all)[0] ?? ''
  } catch { return '' }
}
// клиент создаётся при первом запросе — если ключа нет, функция ответит понятной ошибкой, а не упадёт при запуске
let _db: ReturnType<typeof createClient> | null = null
function getDb() {
  if (_db) return _db
  const key = serviceKey()
  if (!SB_URL || !key) throw new Error('Нет SUPABASE_URL или серверного ключа в окружении функции')
  _db = createClient(SB_URL, key, { auth: { persistSession: false, autoRefreshToken: false } })
  return _db
}

const APP = 'raskroypro.com'
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

// Секрет вебхука выводится из токена бота — отдельный секрет заводить не нужно
async function webhookSecret(): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('raskroypro-webhook:' + TOKEN))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 48)
}

async function tg(method: string, payload: Record<string, unknown>): Promise<any> {
  try {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    })
    return await r.json().catch(() => ({ ok: false, description: `Telegram ответил ${r.status}` }))
  } catch (e) { return { ok: false, description: 'Нет связи с Telegram: ' + String((e as Error)?.message || e) } }
}
const send = (chat: number, text: string, extra: Record<string, unknown> = {}) =>
  tg('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra })

const SHARE_KB = { keyboard: [[{ text: '📱 Поделиться номером', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true }
const NO_KB = { remove_keyboard: true }

// Кнопка открывает «У меня есть код» с подставленными номером и кодом — человеку остаётся придумать пароль.
// origin — адрес, с которого работает мастер (raskroypro.com или зеркало); подставляем только свои адреса
const siteOf = (origin?: string) => (/^https:\/\/([a-z0-9-]+\.)?raskroypro\.com$/i.test(String(origin || '')) ? String(origin) : `https://${APP}`)
const codeLink = (code: string, tel: string, origin?: string) =>
  `${siteOf(origin)}/auth?code=${encodeURIComponent(code)}&tel=${encodeURIComponent(String(tel || '').replace(/\D/g, ''))}`
const codeText = (code: string) =>
  `✅ <b>Заявка в RaskroyPro одобрена.</b>\n\nКод: <code>${code}</code>\n\n` +
  `Нажмите кнопку ниже — откроется регистрация, номер и код уже подставлены, останется придумать пароль.\n` +
  `Или откройте ${APP} → «У меня есть код». Код действует 3 дня.`
const codeKb = (code: string, tel: string, origin?: string) =>
  ({ inline_keyboard: [[{ text: '✅ Завершить регистрацию', url: codeLink(code, tel, origin) }]] })

// ── Сообщения от Telegram ──
async function onUpdate(u: any) {
  const msg = u?.message
  if (!msg?.chat?.id) return
  const chat: number = msg.chat.id
  if (msg.chat.type !== 'private') return

  if (msg.contact) {
    // свой номер — только кнопкой «Поделиться номером»: тогда contact.user_id совпадает с отправителем
    if (msg.contact.user_id !== msg.from?.id) {
      await send(chat, 'Нужен ваш собственный номер. Нажмите кнопку «📱 Поделиться номером» внизу.', { reply_markup: SHARE_KB })
      return
    }
    const { data, error } = await getDb().rpc('tg_contact', { p_chat: chat, p_phone: String(msg.contact.phone_number || '') })
    if (error) { await send(chat, 'Не удалось проверить номер. Попробуйте позже.', { reply_markup: NO_KB }); return }
    if (data?.result === 'mismatch') {
      await send(chat, `⚠️ Номер этого Telegram не совпадает с номером в заявке (${data.expected}).\n\n` +
        `Скорее всего, в заявке ошибка в цифрах. Откройте ${APP} → «Регистрация», отправьте заявку с верным номером и снова нажмите «Подтвердить в Telegram».`,
        { reply_markup: NO_KB })
      return
    }
    if (data?.result !== 'ok') {
      await send(chat, `Заявки с этим номером не нашлось. Откройте ${APP} → «Регистрация» и отправьте заявку — там будет кнопка «Подтвердить в Telegram».`,
        { reply_markup: NO_KB })
      return
    }
    if (data.code) {
      await send(chat, '✅ Номер подтверждён.', { reply_markup: NO_KB })
      await send(chat, codeText(data.code), { reply_markup: codeKb(data.code, String(msg.contact.phone_number || '')) })
      return
    }
    await send(chat, '✅ <b>Номер подтверждён.</b>\n\nЗаявка ждёт одобрения администратора. Как только её одобрят, код для регистрации придёт сюда.',
      { reply_markup: NO_KB })
    return
  }

  const text = String(msg.text || '').trim()
  const start = text.match(/^\/start(?:\s+(\S+))?/)
  if (start?.[1]) {
    const { data } = await getDb().rpc('tg_start', { p_token: start[1], p_chat: chat })
    if (data === 'verified') { await send(chat, '✅ Номер уже подтверждён. Код придёт сюда, когда заявку одобрят.', { reply_markup: NO_KB }); return }
    if (data === 'ok') {
      await send(chat, '👋 Это бот <b>RaskroyPro</b>.\n\nЧтобы подтвердить номер телефона из заявки, нажмите кнопку <b>«📱 Поделиться номером»</b> внизу.',
        { reply_markup: SHARE_KB })
      return
    }
    await send(chat, `Ссылка устарела. Откройте ${APP} → «Регистрация» и нажмите «Подтвердить в Telegram» ещё раз.`)
    return
  }
  await send(chat, `👋 Это бот <b>RaskroyPro</b> — здесь подтверждается номер телефона и приходят коды и уведомления.\n\n` +
    `Чтобы зарегистрироваться, откройте ${APP} → «Регистрация». Уже оставили заявку? Можно подтвердить номер прямо сейчас:`,
    { reply_markup: SHARE_KB })
}

async function setupWebhook(): Promise<{ ok: boolean, bot?: string, error?: string }> {
  const r = await tg('setWebhook', {
    url: `${SB_URL}/functions/v1/tg-bot`, secret_token: await webhookSecret(),
    allowed_updates: ['message'], drop_pending_updates: true,
  })
  if (!r.ok) return { ok: false, error: r.description || 'Telegram не принял вебхук' }
  const me = await tg('getMe', {})
  return { ok: true, bot: me?.result?.username }
}

// ── Запросы из приложения: только мастер-аккаунт ──
async function isMaster(req: Request, body: any): Promise<boolean> {
  // токен входа — в теле запроса (приложение шлёт «простой» запрос без заголовков, его не задерживает шлюз Supabase)
  const jwt = String(body?.jwt || '') || (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
  if (!jwt) return false
  const { data } = await getDb().auth.getUser(jwt)
  const uid = data?.user?.id
  if (!uid) return false
  const { data: p } = await getDb().from('profiles').select('role').eq('id', uid).maybeSingle()
  return p?.role === 'admin'
}

async function onApp(req: Request, body: any) {
  if (!TOKEN) return json({ error: 'Нет секрета TELEGRAM_BOT_TOKEN в Supabase → Edge Functions → Secrets' })
  if (!(await isMaster(req, body))) return json({ error: 'Только для мастер-аккаунта' })

  if (body.action === 'setup') {
    const r = await setupWebhook()
    return json(r.ok ? { ok: true, bot: r.bot } : { error: r.error })
  }

  if (body.action === 'send_code') {
    const { data, error } = await getDb().rpc('svc_signup_code', { p_id: body.request_id })
    if (error) return json({ error: error.message })
    if (data?.error) return json({ error: data.error })
    const r = await send(data.chat, codeText(data.code), { reply_markup: codeKb(data.code, String(body.tel || ''), body.origin) })
    return json(r.ok ? { ok: true } : { error: r.description || 'Telegram не доставил сообщение' })
  }
  return json({ error: `Функция не поняла запрос (action: ${JSON.stringify(body?.action ?? null)})` })
}

Deno.serve(async req => {
  console.log('request', req.method, new URL(req.url).search)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  // Подключение вебхука можно открыть и просто ссылкой в браузере: …/functions/v1/tg-bot?action=setup
  // (безопасно — бот лишь указывает Telegram адрес этой же функции)
  if (req.method === 'GET' && new URL(req.url).searchParams.get('action') === 'setup') {
    if (!TOKEN) return new Response('Нет секрета TELEGRAM_BOT_TOKEN', { status: 200, headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' } })
    const r = await setupWebhook()
    return new Response(r.ok ? `Бот @${r.bot} подключён. Можно закрыть эту страницу.` : `Ошибка: ${r.error}`,
      { headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' } })
  }
  if (req.method !== 'POST') return new Response('RaskroyPro bot', { headers: CORS })
  const raw = await req.text().catch(() => '')
  let body: any = {}
  try { body = raw ? JSON.parse(raw) : {} } catch { body = {} }
  const qAction = new URL(req.url).searchParams.get('action')
  if (qAction && !body.action) body.action = qAction
  if (!req.headers.get('X-Telegram-Bot-Api-Secret-Token'))
    console.log('app call', JSON.stringify({ ct: req.headers.get('content-type'), len: raw.length, action: body.action ?? null, jwt: !!body.jwt }))
  const hdr = req.headers.get('X-Telegram-Bot-Api-Secret-Token')
  if (hdr) {
    if (hdr !== (await webhookSecret())) return new Response('forbidden', { status: 403 })
    try { await onUpdate(body) } catch (e) { console.error(e) }
    return new Response('ok')   // Telegram всегда получает 200 — иначе будет повторять сообщение
  }
  try { return await onApp(req, body) } catch (e) { return json({ error: String((e as Error)?.message || e) }, 500) }
})
