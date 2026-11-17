// Пробный режим без регистрации («Попробовать без регистрации» на экране входа).
// Гость создаёт заказ, импортирует модель, кроит — всё хранится ТОЛЬКО на его устройстве (IndexedDB):
// запросы к базе Supabase перехватываются здесь (supabase.js → guestFetch) и обслуживаются локально.
// Серверу гость не стоит ничего и ничего на нём не видит. 3D, PDF, DXF, бирки, ЧПУ, отправка на производство —
// просьба зарегистрироваться (guestBlock). После регистрации заказы гостя переносятся в аккаунт (claimGuestOrders).
// Выключатель — у мастер-аккаунта («Пользователи» → «Пробный режим без регистрации»), см. ROLLBACK.md.

const FLAG = 'guestMode'
export const GUEST_ID = '00000000-0000-4000-8000-00000000c0de'
export const GUEST_USER = { id: GUEST_ID, email: 'guest@raskroypro.local', guest: true, user_metadata: {}, app_metadata: {} }
export const GUEST_PROFILE = { id: GUEST_ID, full_name: 'Гость', role: 'client', country: '', city: '', guest: true }

export const guestFlag = () => { try { return localStorage.getItem(FLAG) === '1' } catch { return false } }
const setFlag = on => { try { on ? localStorage.setItem(FLAG, '1') : localStorage.removeItem(FLAG) } catch { /* без памяти */ } }

// перехват запросов включён (гость в приложении); на экране входа/регистрации — выключен, там нужна настоящая база
let active = false
export const guestActive = () => active
export const setGuestActive = on => { active = !!on && !real }

// вошёл ли человек по-настоящему (ставит AuthContext) — тогда перехват не включается ни при каких условиях
let real = false
export const setRealSession = on => { real = !!on; if (real) active = false }
export const hasRealSession = () => real
/** Экран входа/регистрации у гостя: перехват на время выключить (там нужна настоящая база), потом вернуть */
export function pauseGuest() { active = false }
export function resumeGuest() { if (guestFlag() && !real) active = true }

export function startGuest() { setFlag(true); active = true; window.dispatchEvent(new Event('guest-change')) }
export function endGuest() { setFlag(false); active = false; window.dispatchEvent(new Event('guest-change')) }

/** Действие только для зарегистрированных: у гостя — окно «Зарегистрируйтесь» и true (действие не выполнять) */
export function guestBlock(what = '') {
  if (!active) return false
  window.dispatchEvent(new CustomEvent('guest-register', { detail: what }))
  return true
}

// ── Локальная «база» гостя: { orders: [...], order_details: [...], <прочие таблицы>: [...] } в IndexedDB ──
const IDB = 'raskroypro-guest', STORE = 'kv', KEY = 'db'
let db = null, loading = null, saveT = null
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(IDB, 1)
    r.onupgradeneeded = () => r.result.createObjectStore(STORE)
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
}
async function idbGet() {
  try {
    const d = await idb()
    return await new Promise(res => { const q = d.transaction(STORE).objectStore(STORE).get(KEY); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null) })
  } catch { try { return JSON.parse(localStorage.getItem('guestDb') || 'null') } catch { return null } }
}
async function idbSet(v) {
  try {
    const d = await idb()
    await new Promise(res => { const t = d.transaction(STORE, 'readwrite'); t.objectStore(STORE).put(v, KEY); t.oncomplete = res; t.onerror = res })
  } catch { try { localStorage.setItem('guestDb', JSON.stringify(v)) } catch { /* места нет */ } }
}
async function loadDb() {
  if (db) return db
  if (!loading) loading = idbGet().then(v => { db = v && typeof v === 'object' ? v : {}; return db })
  return loading
}
const persist = () => { clearTimeout(saveT); saveT = setTimeout(() => idbSet(db), 300) }
export async function guestOrders() { const d = await loadDb(); return d.orders || [] }
export async function clearGuestDb() { db = {}; clearTimeout(saveT); await idbSet({}) }

// ── Мини-PostgREST: фильтры eq/neq/in/is/gt/lt/like, order, limit, select (без вложенных связей) ──
const KEEP = new Set(['orders', 'order_details', 'order_models', 'user_settings'])
const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns', 'or', 'and'])
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2))
function test(v, op, arg) {
  const s = v == null ? null : String(v)
  switch (op) {
    case 'eq': return s === arg
    case 'neq': return s !== arg
    case 'gt': return Number(v) > Number(arg) || (isNaN(Number(arg)) && s > arg)
    case 'gte': return Number(v) >= Number(arg) || (isNaN(Number(arg)) && s >= arg)
    case 'lt': return Number(v) < Number(arg) || (isNaN(Number(arg)) && s < arg)
    case 'lte': return Number(v) <= Number(arg) || (isNaN(Number(arg)) && s <= arg)
    case 'is': return arg === 'null' ? v == null : arg === 'true' ? v === true : arg === 'false' ? v === false : true
    case 'in': return arg.replace(/^\(|\)$/g, '').split(',').map(x => x.replace(/^"|"$/g, '')).includes(s)
    case 'like': case 'ilike': {
      const re = new RegExp('^' + arg.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/%/g, '.*') + '$', op === 'ilike' ? 'i' : '')
      return s != null && re.test(s)
    }
    default: return true
  }
}
function matcher(params) {
  const conds = []
  for (const [k, raw] of params) {
    if (RESERVED.has(k)) continue
    let v = raw, not = false
    if (v.startsWith('not.')) { not = true; v = v.slice(4) }
    const i = v.indexOf('.')
    if (i < 0) continue
    const op = v.slice(0, i), arg = v.slice(i + 1)
    conds.push(row => { const r = test(row[k], op, arg); return not ? !r : r })
  }
  return row => conds.every(c => c(row))
}
function sortRows(rows, order) {
  if (!order) return rows
  const keys = order.split(',').map(p => { const [col, dir, nulls] = p.split('.'); return { col, desc: dir === 'desc', nullsFirst: nulls === 'nullsfirst' } })
  return [...rows].sort((a, b) => {
    for (const { col, desc, nullsFirst } of keys) {
      const x = a[col], y = b[col]
      if (x == null && y == null) continue
      if (x == null) return nullsFirst ? -1 : 1
      if (y == null) return nullsFirst ? 1 : -1
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))
      if (c) return desc ? -c : c
    }
    return 0
  })
}
const res = (body, status = 200, extra = {}) => new Response(status === 204 || status === 304 ? null : body == null ? '' : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...extra } })
const noRow = () => res({ code: 'PGRST116', details: 'The result contains 0 rows', hint: null, message: 'JSON object requested, multiple (or no) rows returned' }, 406)

/** Ответ на запрос к Supabase для гостя — без сети */
export async function guestFetch(input, init = {}) {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url || ''
  const url = new URL(href, window.location.origin)
  const method = String(init.method || input?.method || 'GET').toUpperCase()
  const h = new Headers(init.headers || input?.headers || {})
  const accept = h.get('Accept') || '', prefer = h.get('Prefer') || ''
  const one = accept.includes('vnd.pgrst.object')
  const path = url.pathname
  // функции базы, хранилище, edge-функции: «ничего нет», ошибок не поднимаем
  if (/\/rest\/v1\/rpc\//.test(path)) return res(null)
  if (/\/storage\/v1\//.test(path)) return method === 'GET' ? res(null, 404) : res({ Key: 'guest' })
  const m = path.match(/\/rest\/v1\/([^/]+)$/)
  if (!m) return res({})
  const table = decodeURIComponent(m[1])
  // хранятся только заказы, детали и настройки; остальное (статистика нагрузки, уведомления…) — «принято» и забыто
  if (!KEEP.has(table)) {
    if (method === 'GET' || method === 'HEAD') return one ? noRow() : res([], 200, { 'Content-Range': '*/0' })
    if (!/return=representation/.test(prefer)) return res(null, method === 'POST' ? 201 : 204)
    let b; try { b = typeof init.body === 'string' ? JSON.parse(init.body) : null } catch { b = null }
    const list = Array.isArray(b) ? b : b ? [b] : []
    return one ? (list[0] ? res(list[0], 201) : noRow()) : res(list, 201)
  }
  const d = await loadDb()
  const rows = d[table] || (d[table] = [])
  const match = matcher(url.searchParams)
  let body = null
  if (init.body != null) { try { body = typeof init.body === 'string' ? JSON.parse(init.body) : null } catch { body = null } }
  const wantRep = /return=representation/.test(prefer)
  const reply = (list, status = 200) => {
    if (!wantRep && method !== 'GET' && method !== 'HEAD') return res(null, status === 200 ? 204 : status)
    if (one) return list.length === 1 ? res(list[0], status) : noRow()
    return res(list, status, { 'Content-Range': `0-${Math.max(list.length - 1, 0)}/${list.length}` })
  }

  if (method === 'GET' || method === 'HEAD') {
    let list = sortRows(rows.filter(match), url.searchParams.get('order'))
    const total = list.length
    const off = Number(url.searchParams.get('offset')) || 0, lim = url.searchParams.get('limit')
    const range = (h.get('Range') || '').match(/^(\d+)-(\d+)$/)
    if (range) list = list.slice(Number(range[1]), Number(range[2]) + 1)
    else list = list.slice(off, lim != null ? off + Number(lim) : undefined)
    if (method === 'HEAD') return res(null, 200, { 'Content-Range': `0-${Math.max(total - 1, 0)}/${total}` })
    if (one) return list.length ? res(list[0]) : noRow()
    return res(list, 200, { 'Content-Range': `0-${Math.max(list.length - 1, 0)}/${total}` })
  }
  if (method === 'POST') {
    const items = Array.isArray(body) ? body : body ? [body] : []
    const upsert = /resolution=merge-duplicates/.test(prefer)
    const keys = (url.searchParams.get('on_conflict') || 'id').split(',')
    const out = []
    for (const it of items) {
      const ex = upsert ? rows.find(r => keys.every(k => it[k] != null && String(r[k]) === String(it[k]))) : null
      if (ex) { Object.assign(ex, it); out.push(ex); continue }
      const row = { id: uuid(), created_at: new Date().toISOString(), ...(table === 'orders' ? { user_id: GUEST_ID, status: 'draft' } : {}), ...it }
      rows.push(row); out.push(row)
    }
    persist()
    return reply(out, 201)
  }
  if (method === 'PATCH') {
    const hit = rows.filter(match)
    for (const r of hit) Object.assign(r, body || {}, table === 'orders' ? { updated_at: new Date().toISOString() } : {})
    persist()
    return reply(hit)
  }
  if (method === 'DELETE') {
    const hit = rows.filter(match)
    d[table] = rows.filter(r => !hit.includes(r))
    persist()
    return reply(hit)
  }
  return res(null, 204)
}

/**
 * После регистрации / входа: заказы гостя — в аккаунт (новые записи в базе), затем локальная база очищается.
 * sb — клиент Supabase (уже с сессией). -> число перенесённых заказов
 */
let claiming = false
export async function claimGuestOrders(sb, userId) {
  if (claiming) return 0
  claiming = true
  try { return await claimAll(sb, userId) } finally { claiming = false }
}
async function claimAll(sb, userId) {
  const d = await loadDb()
  const orders = d.orders || []
  if (!orders.length) { endGuest(); return 0 }
  let moved = 0
  const left = []
  for (const o of orders) {
    const row = { ...o }
    delete row.id; delete row.created_at; delete row.updated_at
    row.user_id = userId; row.status = 'draft'; row.production_id = null
    let { data, error } = await sb.from('orders').insert(row).select('id').single()
    if (error) {   // колонки, которых в базе нет (старые версии), — без них
      const slim = { ...row }
      delete slim.nesting_result; delete slim.offcuts; delete slim.linear
      ;({ data, error } = await sb.from('orders').insert(slim).select('id').single())
    }
    if (error || !data?.id) { left.push(o); continue }
    const det = (d.order_details || []).filter(x => String(x.order_id) === String(o.id)).map(x => { const c = { ...x }; delete c.id; delete c.created_at; c.order_id = data.id; return c })
    for (let i = 0; i < det.length; i += 200) {
      const part = det.slice(i, i + 200)
      const { error: e1 } = await sb.from('order_details').insert(part)
      if (e1) await sb.from('order_details').insert(part.map(x => { const c = { ...x }; delete c.part_group; delete c.part_group_dir; delete c.part_group_pos; return c }))
    }
    // 3D-модель заказа (импорт из мебельных программ) — тоже в аккаунт
    const mdl = (d.order_models || []).find(x => String(x.order_id) === String(o.id))
    if (mdl?.data) { try { await sb.from('order_models').upsert({ order_id: data.id, data: mdl.data }, { onConflict: 'order_id' }) } catch { /* без модели */ } }
    try { if (localStorage.getItem('ownParams:' + o.id) === '1') localStorage.setItem('ownParams:' + data.id, '1') } catch { /* без памяти */ }
    moved++
  }
  if (left.length) { d.orders = left; d.order_details = (d.order_details || []).filter(x => left.some(o => String(o.id) === String(x.order_id))); d.order_models = (d.order_models || []).filter(x => left.some(o => String(o.id) === String(x.order_id))); await idbSet(d) }
  else await clearGuestDb()
  setFlag(false); active = false
  return moved
}

/** Куда гостю можно: список заказов, новый заказ, заказ, раскрой, правка */
export const guestPathOk = path => /^\/orders(\/new)?\/?$/.test(path) || /^\/orders\/[^/]+(\/(nesting|edit))?\/?$/.test(path)
