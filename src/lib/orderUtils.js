export function generateOrderNumber(sequenceNum) {
  const now = new Date()
  const yy = String(now.getFullYear()).slice(2)
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  const seq = String(sequenceNum).padStart(3, '0')
  return `${yy}${mm}${dd}_${seq}`
}

export async function getNextOrderNumber(supabase) {
  const today = new Date()
  const yy = String(today.getFullYear()).slice(2)
  const mm = String(today.getMonth() + 1).padStart(2, '0')
  const dd = String(today.getDate()).padStart(2, '0')
  const prefix = `${yy}${mm}${dd}_`

  // Номер должен быть уникален среди заказов ВСЕХ пользователей, а чужие заказы пользователю не видны —
  // поэтому номер выдаёт функция базы (migration_access_lockdown.sql). Нет функции — считаем по-старому.
  try {
    const { data: next, error } = await supabase.rpc('next_order_number', { p_prefix: prefix })
    if (!error && typeof next === 'string' && next.startsWith(prefix)) return next
  } catch { /* ниже — прежний способ */ }

  const { data } = await supabase
    .from('orders')
    .select('order_number')
    .like('order_number', `${prefix}%`)
    .order('order_number', { ascending: false })
    .limit(1)

  if (!data || data.length === 0) return `${prefix}001`
  const last = data[0].order_number
  const lastSeq = parseInt(last.split('_')[1]) || 0
  return `${prefix}${String(lastSeq + 1).padStart(3, '0')}`
}

export const STATUS_LABELS = {
  new: 'Отправлен, ждёт ответа',
  discussion: 'В обсуждении',
  inwork: 'Принят в работу',
  done: 'Исполнен'
}

export const STATUS_BADGE = {
  new: 'badge-new',
  discussion: 'badge-discussion',
  inwork: 'badge-inwork',
  done: 'badge-done'
}

// Название заказа — то, как его назвал пользователь (или как назывался загруженный файл).
// Номер, который приложение присваивает само, показывается только у заказа без названия.
export const orderTitle = order => String(order?.order_name || '').trim() || order?.order_number || ''

// кириллица -> латиница (как в именах файлов станка: «Белый» -> «Belij»)
const LAT = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'j', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'i', ь: '', э: 'e', ю: 'yu', я: 'ya',
  ә: 'a', ғ: 'g', қ: 'k', ң: 'n', ө: 'o', ұ: 'u', ү: 'u', һ: 'h', і: 'i' }
export const toLatin = str => String(str || '').replace(/[а-яёәғқңөұүһі]/gi, ch => { const l = LAT[ch.toLowerCase()] ?? ch; return ch === ch.toLowerCase() ? l : l.charAt(0).toUpperCase() + l.slice(1) })
/** Название заказа для имён файлов: латиницей, без пробелов и знаков, которые не любят станки */
export const orderFileName = order => toLatin(orderTitle(order)).replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'zakaz'
