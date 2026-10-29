import { createClient } from '@supabase/supabase-js'
import { recordRequest, startPerf, perfMark } from './perf'

// База напрямую. Из России адреса Supabase и Vercel заблокированы — там приложение открывается через зеркало
// (ru.raskroypro.com, сервер-посредник, см. deploy/mirror-setup.sh): на зеркале запросы к базе идут через тот же адрес /sb.
export const SUPABASE_DIRECT = 'https://bmcmyrdsxievaglpspcn.supabase.co'
const onMirror = typeof window !== 'undefined' && /^ru\./i.test(window.location.hostname)
export const SUPABASE_URL = onMirror ? `${window.location.origin}/sb` : SUPABASE_DIRECT
export const SUPABASE_ANON_KEY = 'sb_publishable_M1nC2YyHn_4zJI5QFAI9Cw_IaC6Ou7u'

// каждый запрос к базе засекается — для страницы «Нагрузка» мастер-аккаунта (perf.js)
const timedFetch = async (input, init) => {
  const t0 = performance.now(), mark = perfMark(), url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url || ''
  try {
    const res = await fetch(input, init)
    recordRequest(url, performance.now() - t0, res.status < 500, mark)
    return res
  } catch (e) { if (e?.name !== 'AbortError') recordRequest(url, performance.now() - t0, false, mark); throw e }   // отменённый запрос — не ошибка базы
}
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { fetch: timedFetch } })
startPerf(supabase)
