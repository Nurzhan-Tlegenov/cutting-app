// Код для смены пароля на почту — для тех, кто зарегистрирован по номеру и указал почту при регистрации
// (migration_reset_channels.sql). Письмо уходит через Gmail приложения (тот же ящик, что настроен в Supabase → Auth → SMTP).
//
// Установка (один раз): Supabase → Edge Functions → Deploy a new function → Via Editor, имя «reset-mail»,
// вставить этот файл целиком → Deploy. В настройках функции выключить «Verify JWT» (вызывается с экрана входа, без аккаунта).
// Секреты (Edge Functions → Secrets): SMTP_USER — адрес Gmail, SMTP_PASS — пароль приложения Gmail (16 букв, тот же,
// что в настройках SMTP). Порт 465: 587 и 25 Supabase из функций не выпускает.
//
// Запрос: POST { phone } → { ok: true } (есть ли почта у номера, не сообщается) | { wait: true } | { error }

import { createClient } from 'npm:@supabase/supabase-js@2'
import nodemailer from 'npm:nodemailer@6.9.16'

const SB_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SMTP_USER = Deno.env.get('SMTP_USER') ?? ''
const SMTP_PASS = (Deno.env.get('SMTP_PASS') ?? '').replace(/\s+/g, '')
function serviceKey(): string {
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (legacy) return legacy
  try {
    const all = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}')
    return all.default ?? Object.values(all)[0] ?? ''
  } catch { return '' }
}
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

const APP = 'raskroypro.com'
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return new Response('RaskroyPro reset-mail', { headers: CORS })
  let body: any = {}
  try { body = JSON.parse(await req.text()) } catch { body = {} }
  const key = serviceKey()
  if (!SB_URL || !key) return json({ error: 'Нет серверного ключа в окружении функции' })
  if (!SMTP_USER || !SMTP_PASS) return json({ error: 'Нет секретов SMTP_USER / SMTP_PASS в Supabase → Edge Functions → Secrets' })
  const db = createClient(SB_URL, key, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await db.rpc('svc_reset_email', { p_phone: String(body?.phone || '') })
  if (error) return json({ error: /svc_reset_email/.test(error.message) ? 'Выполните migration_reset_channels.sql в Supabase' : error.message })
  if (data?.result === 'wait') return json({ wait: true })
  if (data?.result !== 'ok') return json({ ok: true })   // почты нет — снаружи не видно
  const code = String(data.code)
  const tel = String(body?.phone || '').replace(/\D/g, '')
  const link = `https://${APP}/auth?reset=${encodeURIComponent(code)}&tel=${encodeURIComponent(tel)}`
  try {
    const t = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: SMTP_USER, pass: SMTP_PASS } })
    await t.sendMail({
      from: `RaskroyPro <${SMTP_USER}>`, to: String(data.email),
      subject: `Код для смены пароля RaskroyPro: ${code}`,
      text: `Код для смены пароля RaskroyPro: ${code}\n\nОткройте ${link}\nили ${APP} → «Забыли пароль?», введите код и новый пароль. Код действует 1 час.\n\nЕсли вы не просили — просто ничего не делайте.`,
      html: `<p>Код для смены пароля <b>RaskroyPro</b>:</p><p style="font-size:24px;letter-spacing:4px"><b>${esc(code)}</b></p>` +
        `<p><a href="${esc(link)}">Сменить пароль</a> — номер и код уже подставлены. Или откройте ${APP} → «Забыли пароль?».</p>` +
        `<p style="color:#888">Код действует 1 час. Если вы не просили — просто ничего не делайте.</p>`,
    })
  } catch (e) {
    console.error('mail', e)
    return json({ error: 'Письмо не ушло: ' + String((e as Error)?.message || e) })
  }
  return json({ ok: true })
})
