// Слабый интернет: запрос оборвался — повторяем, а не показываем ошибку.
//
// Повторяем только то, что безопасно повторить: чтение (GET/HEAD). Запись повторяется там, где
// повтор не создаст дубль (вставка деталей с заранее заданными id — orderDetails.js).
// Пока идёт повтор, внизу экрана видно «Слабая связь — повторяю…» (NetStatus.jsx).

const DELAYS = [1000, 2500, 5000, 10000]          // 4 повтора, всего ~20 с ожидания
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])

let pending = 0
const listeners = new Set()
const emit = () => { for (const f of listeners) f(pending) }
// подписка на «сейчас повторяем запросы»: f(число запросов в повторе)
export function onNetRetry(f) { listeners.add(f); return () => listeners.delete(f) }
export function retrying(delta) { pending = Math.max(0, pending + delta); emit() }

const sleep = ms => new Promise(r => setTimeout(r, ms))
// нет сети совсем — ждём, пока появится (но не дольше ms)
export function waitOnline(ms = 30000) {
  if (typeof navigator === 'undefined' || navigator.onLine !== false) return Promise.resolve()
  return new Promise(r => { const t = setTimeout(done, ms); function done() { clearTimeout(t); window.removeEventListener('online', done); r() } window.addEventListener('online', done) })
}

// Сеть оборвалась (ответа нет вообще)
export const isNetError = e => e && e.name !== 'AbortError' && (e.name === 'TypeError' || /network|fetch|load failed|timeout/i.test(String(e.message || e)))

// Обёртка над fetch: повторы для чтения
export async function fetchRetry(input, init) {
  const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') return fetch(input, init)
  let counted = false
  try {
    for (let i = 0; ; i++) {
      try {
        const res = await fetch(input, init)
        if (!RETRY_STATUS.has(res.status) || i >= DELAYS.length) return res
      } catch (e) {
        if (!isNetError(e) || i >= DELAYS.length || init?.signal?.aborted) throw e
      }
      if (!counted) { counted = true; retrying(+1) }
      await waitOnline()
      await sleep(DELAYS[i])
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    }
  } finally { if (counted) retrying(-1) }
}

// Повтор любого действия (для записи — только если повтор безопасен). fn(попытка) -> результат Supabase { data, error }
export async function withRetry(fn) {
  let counted = false
  try {
    for (let i = 0; ; i++) {
      let r
      try { r = await fn(i) } catch (e) { if (!isNetError(e) || i >= DELAYS.length) throw e; r = { error: e } }
      const err = r?.error
      if (!err || i >= DELAYS.length || !isNetError(err)) return r
      if (!counted) { counted = true; retrying(+1) }
      await waitOnline()
      await sleep(DELAYS[i])
    }
  } finally { if (counted) retrying(-1) }
}
