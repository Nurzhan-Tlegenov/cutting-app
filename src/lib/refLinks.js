// Пригласительные ссылки «Поделиться» (migration_ref_links.sql):
//   • производство → клиенту (kind 'client'): клиент регистрируется без одобрения мастера, только подтверждает номер;
//     в раскрое у него сразу выбрано это производство;
//   • любой пользователь → производству (kind 'production'): приглашённое производство подтверждается сразу.
import { supabase } from './supabase'
import { siteOrigin } from './siteOrigin'

export const REF_SQL_HINT = 'Пригласительные ссылки ещё не включены в базе: выполните migration_ref_links.sql в Supabase (SQL Editor) — один раз.'
const isMissing = e => /PGRST202|42883|schema cache|Could not find the function/i.test(String(e?.message || '') + ' ' + String(e?.code || ''))

async function call(fn, args) {
  try {
    const { data, error } = await supabase.rpc(fn, args)
    if (error) {
      if (isMissing(error)) return { error: REF_SQL_HINT, missing: true }
      const m = String(error.message || '')
      return { error: /no production/.test(m) ? 'Ссылка для клиентов появится, когда ваше производство подтвердят.' : /not allowed/.test(m) ? 'Нет прав на это действие.' : m }
    }
    return { data }
  } catch (e) { return { error: String(e?.message || e) } }
}

/** Моя личная ссылка-приглашение. kind: 'client' (от производства клиентам) | 'production' */
export const myRefCode = kind => call('my_ref_code', { p_kind: kind })
export const refInfo = code => call('ref_info', { p_code: code || '' })
export const acceptRef = code => call('accept_ref', { p_code: code || '' })
export const myRefPeople = () => call('my_ref_people')
export const refSendCode = id => call('ref_send_code', { p_id: id })
export const refUrl = code => `${siteOrigin()}/r/${code}`

/** Заявка по ссылке — одобряется сразу, остаётся подтвердить номер. Ответ как у requestSignup2 плюс ref ('ok' | 'bad'). */
export async function requestSignupRef(name, phone, comment, country, city, messenger, code) {
  const r = await call('request_signup_ref', { p_name: name || '', p_phone: phone || '', p_comment: comment || '', p_country: country || '', p_city: city || '', p_messenger: messenger, p_ref: code || '' })
  if (r.missing) return { missing: true }
  if (r.error) return { error: /bad phone/.test(r.error) ? 'Проверьте номер телефона' : r.error }
  return r.data || {}
}

// Ссылка, открытая до входа: запоминаем, чтобы после регистрации / входа вернуться на неё
const KEY = 'pendingRef'
export const savePendingRef = code => { try { localStorage.setItem(KEY, code) } catch { /* без памяти */ } }
export const pendingRef = () => { try { return localStorage.getItem(KEY) || '' } catch { return '' } }
export const clearPendingRef = () => { try { localStorage.removeItem(KEY) } catch { /* без памяти */ } }

/** Текст приглашения для мессенджера */
export function refText(kind, url, { name = '', production = '', plain = false } = {}) {
  if (plain) return `Здравствуйте!${name ? ` Это ${name}.` : ''} Хочу отправлять вам заказы на раскрой через приложение RaskroyPro — карты раскроя будут сразу с вашим резом и отступами. Зарегистрируйте, пожалуйста, своё производство: ${url}`
  if (kind === 'client') return `Здравствуйте!${production ? ` Это ${production}.` : ''} Оформляйте у нас заказы на раскрой через приложение RaskroyPro: вводите детали с телефона — карты раскроя сразу с нашим резом и отступами. Регистрация по ссылке, без ожидания: ${url}`
  return `Здравствуйте!${name ? ` Это ${name}.` : ''} Хочу отправлять вам заказы на раскрой через приложение RaskroyPro — карты раскроя будут сразу с вашим резом и отступами. Зарегистрируйте своё производство по ссылке — подтверждение не нужно: ${url}`
}
