// Детали заказа (order_details) — чтение и запись без потерь на больших заказах.
//
// Supabase (PostgREST) отдаёт на один запрос не больше 1000 строк. Заказ из Базиса на 1578 строк
// загружался обрезанным: в списке, раскрое, бирках были только первые 1000 строк, а после
// «Сохранить» на странице правки остальные удалялись навсегда (там «удалить всё → вставить загруженное»).
// Поэтому читаем страницами по 1000, а пишем пачками — один запрос на 6 МБ контуров с телефона
// может не дойти.
import { supabase } from './supabase'

const PAGE = 1000          // столько отдаёт Supabase за раз (max rows)
const INSERT_CHUNK = 250   // строк за один insert — контуры тяжёлые

// Все детали заказа по порядку. Возвращает { data, error } — как обычный запрос Supabase.
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

// Вставка деталей пачками. Ошибка — { error } как у Supabase; уже вставленные пачки
// удаляются (по id), чтобы заказ не остался наполовину заполненным.
export async function insertOrderDetails(rows) {
  if (!rows?.length) return { error: null }
  const done = []
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const { data, error } = await supabase.from('order_details').insert(rows.slice(i, i + INSERT_CHUNK)).select('id')
    if (error) {
      for (let k = 0; k < done.length; k += 200) await supabase.from('order_details').delete().in('id', done.slice(k, k + 200))
      return { error }
    }
    for (const r of data || []) done.push(r.id)
  }
  return { error: null }
}
