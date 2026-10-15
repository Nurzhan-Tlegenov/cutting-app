import { createClient } from '@supabase/supabase-js'

// База напрямую. Из России адреса Supabase и Vercel заблокированы — там приложение открывается через зеркало
// (ru.raskroypro.com, сервер-посредник, см. deploy/mirror-setup.sh): на зеркале запросы к базе идут через тот же адрес /sb.
export const SUPABASE_DIRECT = 'https://bmcmyrdsxievaglpspcn.supabase.co'
const onMirror = typeof window !== 'undefined' && /^ru\./i.test(window.location.hostname)
export const SUPABASE_URL = onMirror ? `${window.location.origin}/sb` : SUPABASE_DIRECT
const SUPABASE_ANON_KEY = 'sb_publishable_M1nC2YyHn_4zJI5QFAI9Cw_IaC6Ou7u'

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
