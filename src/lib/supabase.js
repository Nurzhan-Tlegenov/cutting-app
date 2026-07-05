import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://bmcmyrdsxievaglpspcn.supabase.co'
const SUPABASE_ANON_KEY = 'sb_publishable_M1nC2YyHn_4zJI5QFAI9Cw_IaC6Ou7u'

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
