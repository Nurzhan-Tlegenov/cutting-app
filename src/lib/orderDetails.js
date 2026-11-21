// Детали заказа (order_details) — чтение и запись без потерь на больших заказах и слабом интернете.
//
// Supabase (PostgREST) отдаёт на один запрос не больше 1000 строк. Заказ из Базиса на 1578 строк
// загружался обрезанным: в списке, раскрое, бирках были только первые 1000 строк, а после
// «Сохранить» на странице правки остальные удалялись навсегда (там «удалить всё → вставить загруженное»).
// Поэтому читаем страницами по 1000, а пишем пачками — один запрос на 6 МБ контуров с телефона
// может не дойти.
//
// Слабая связь: каждая пачка при обрыве повторяется (до 4 раз). Чтобы повтор не создал дубли,
// у строк заранее свой id: если первая попытка всё-таки дошла до базы, повтор получит «такой id уже есть»
// — значит, пачка уже записана.
import { supabase } from './supabase'
import { withRetry } from './netRetry'

const PAGE = 1000          // столько отдаёт Supabase за раз (max rows)
const INSERT_CHUNK = 150   // строк за один insert — контуры тяжёлые, на слабой связи пачка должна дойти целиком

// Все детали заказа по порядку. Возвращает { data, error } — как обычный запрос Supabase.
// (чтение повторяется при обрыве в самом клиенте базы — supabase.js → netRetry.js)
export async function fetchOrderDetails(orderId, { cols = '*', ordered = true } = {}) {
  const all = []
  for (let from = 0; ; from += PAGE) {
    let q = supabase.from('order_details').select(cols).eq('order_id', orderId)
    // id — второй ключ: при одинаковом sort_order страницы не должны перекрываться или терять строки
    q = ordered ? q.order('sort_order').order('id') : q.order('id')
    const { data, error } = await q.range(from, from + PAGE - 1)
    if (error) return { data: all.length ? all : null, error }
    all.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return { data: all, error: null }
}

function uuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID()
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

// Вставка деталей пачками. Ошибка — { error } как у Supabase; уже вставленные пачки
// удаляются, чтобы заказ не остался наполовину заполненным.
// onProgress(записано, всего) — для подписи «Сохраняем 300 из 1578…».
export async function insertOrderDetails(rows, onProgress) {
  if (!rows?.length) return { error: null }
  const list = rows.map(r => (r.id ? r : { ...r, id: uuid() }))
  const done = []
  for (let i = 0; i < list.length; i += INSERT_CHUNK) {
    const part = list.slice(i, i + INSERT_CHUNK)
    const { error } = await withRetry(attempt => supabase.from('order_details').insert(part).then(r => (
      // повтор после обрыва: «такой id уже есть» — первая попытка дошла, пачка записана
      attempt > 0 && r.error?.code === '23505' ? { error: null } : r
    )))
    if (error) {
      for (let k = 0; k < done.length; k += 200) await withRetry(() => supabase.from('order_details').delete().in('id', done.slice(k, k + 200)))
      return { error }
    }
    for (const r of part) done.push(r.id)
    onProgress?.(done.length, list.length)
  }
  return { error: null }
}
