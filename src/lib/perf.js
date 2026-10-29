// Замер скорости базы у пользователя (для страницы мастер-аккаунта «Нагрузка», migration_load.sql).
// Каждый запрос к базе засекается (обёртка fetch в supabase.js). Раз в 5 минут — одна строка-сводка в perf_samples:
// сколько запросов, ошибок, обычное (p50) и худшее (p95) время, самые медленные места. Сами замеры почти ничего не весят.
const EVERY = 5 * 60 * 1000
let buf = [], paths = new Map(), client = null, off = false
const via = () => (typeof window !== 'undefined' && /^ru\./i.test(window.location.hostname) ? 'mirror' : 'direct')

// путь запроса без параметров и номеров: /rest/v1/orders, /rest/v1/rpc/имя, /storage, /auth/token, /functions/push
function pathOf(url) {
  let p
  try { p = new URL(url).pathname } catch { return '' }
  p = p.replace(/^\/sb(?=\/)/, '')
  if (p.startsWith('/storage/')) return '/storage'
  if (p.startsWith('/auth/')) return '/auth/' + (p.split('/')[3] || '')
  return p.replace(/\/[0-9a-f-]{20,}.*/i, '/…')
}

// Время честное, только если приложение всё время запроса было на экране: свёрнутое приложение и уснувший телефон
// замораживают ответ на минуты (так в первых замерах получалось «худший ответ 328 с»). Каждое сворачивание/разворачивание
// меняет «эпоху» — запрос, начатый в другой эпохе или в фоне, не считается. Без сети — тоже (это не база тормозит).
let epoch = 0
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { epoch++ })
const onScreen = () => typeof document === 'undefined' || document.visibilityState === 'visible'
/** Метка начала запроса (для recordRequest) */
export const perfMark = () => (onScreen() && (typeof navigator === 'undefined' || navigator.onLine !== false) ? epoch : -1)

/** Записать один запрос: url, время (мс), успех, метка начала (perfMark) */
export function recordRequest(url, ms, ok, mark = epoch) {
  if (off || mark < 0 || mark !== epoch || !onScreen()) return
  if (ms > 60000) return                                    // минута и дольше — зависший запрос / сон телефона, не скорость базы
  const p = pathOf(url)
  if (!p || p.includes('perf_samples')) return           // сами сводки не меряем
  // файлы (модели, картинки) и функции (уведомления) идут долго по своей природе — в скорость базы не считаем,
  // но в «самых медленных местах» они видны
  if (!p.startsWith('/storage') && !p.startsWith('/functions')) buf.push({ ms, ok })
  const t = paths.get(p) || { n: 0, ms: 0, mx: 0 }
  t.n++; t.ms += ms; t.mx = Math.max(t.mx, ms); paths.set(p, t)
  if (buf.length > 5000) buf = buf.slice(-5000)
}

const pct = (a, q) => a[Math.min(a.length - 1, Math.floor(a.length * q))]
async function flush() {
  if (!client || !paths.size || off) return
  const { data: { session } = {} } = await client.auth.getSession().catch(() => ({ data: {} }))
  if (!session?.user) return
  const ms = buf.map(x => x.ms).sort((a, b) => a - b), err = buf.filter(x => !x.ok).length
  const top = [...paths.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 6).map(([p, t]) => ({ p, n: t.n, ms: Math.round(t.ms), mx: Math.round(t.mx) }))
  const row = { via: via(), n: ms.length, err, p50: ms.length ? Math.round(pct(ms, 0.5)) : null, p95: ms.length ? Math.round(pct(ms, 0.95)) : null, mx: ms.length ? Math.round(ms[ms.length - 1]) : null, top }
  buf = []; paths = new Map()
  const { error } = await client.from('perf_samples').insert(row)
  if (error && /perf_samples|42P01|PGRST20|schema cache/i.test(String(error.message) + ' ' + String(error.code))) off = true   // миграции нет — не меряем
}

/** Начать отправку сводок (один раз, после создания клиента базы) */
export function startPerf(sb) {
  if (client || typeof window === 'undefined') return
  client = sb
  setInterval(() => { flush().catch(() => {}) }, EVERY)
  // приложение свернули — отправить то, что накопилось (иначе короткие заходы не попадут в сводку)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && buf.length >= 5) flush().catch(() => {}) })
}
