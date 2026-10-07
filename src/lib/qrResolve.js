// QR-код с бирки -> заказ и деталь. В коде обычный текст (его же читает сканер станка): название заказа, обозначение
// детали, номер карты и номер детали на ней — в том составе, который пользователь выбрал в шаблоне бирки.
// Заказ ищется по названию среди заказов, доступных пользователю; деталь — по обозначению, а если его в коде нет —
// по номеру карты (L…) и номеру детали на ней (N…).
import { supabase } from './supabase'
import { orderTitle, toLatin } from './orderUtils'
import { savedNestings } from './savedNesting'
import { detailMeta } from './partLabel'

// как текст выглядит в коде: латиница (если была включена), пробелы -> «_», без различия регистра
const norm = s => String(s || '').trim().replace(/\s+/g, '_').toLowerCase()
const forms = s => [...new Set([norm(s), norm(toLatin(s))])].filter(Boolean)

/** Ссылка на 3D-модель (QR со ссылкой): -> путь внутри приложения или null */
export function qrLink(text) {
  try {
    const u = new URL(String(text).trim())
    return /^\/(v|view)\//.test(u.pathname) ? u.pathname + u.search : null
  } catch { return null }
}

/**
 * Найти заказ и деталь по тексту кода.
 * -> { order, details, di, des } | { error } ; di — номер детали в заказе (или -1: заказ найден, деталь — нет)
 */
export async function resolveQr(text) {
  const code = norm(text)
  if (!code) return { error: 'Код пустой' }
  const { data: orders, error } = await supabase.from('orders').select('id,order_number,order_name,created_at').order('created_at', { ascending: false }).limit(2000)
  if (error) return { error: error.message }
  // заказ: его название (или номер) входит в код; из подходящих — с самым длинным совпадением, при равенстве — самый новый
  let best = null
  for (const o of orders || []) for (const f of [...forms(orderTitle(o)), ...forms(o.order_number)]) {
    if (f.length >= 2 && code.includes(f) && (!best || f.length > best.len)) best = { o, len: f.length, f }
  }
  if (!best) return { error: 'Заказ с таким названием не найден среди ваших заказов' }
  const [{ data: order }, { data: details }] = await Promise.all([
    supabase.from('orders').select('*').eq('id', best.o.id).single(),
    supabase.from('order_details').select('*').eq('order_id', best.o.id).order('sort_order'),
  ])
  if (!order) return { error: 'Заказ не открывается' }
  const list = details || []
  // части кода, кроме названия заказа
  const rest = code.replace(best.f, ' ')
  const tokens = rest.split(/[^\p{L}\p{N}._/\\-]+/u).filter(Boolean)
  // 1) по обозначению: самое длинное обозначение, совпавшее с частью кода
  let di = -1, des = ''
  list.forEach((d, i) => {
    const v = detailMeta(d)?.des
    if (!v) return
    if (forms(v).some(f => tokens.includes(f)) && String(v).length > des.length) { di = i; des = String(v) }
  })
  // 2) по номеру карты и номеру детали на ней (L3;N12)
  if (di < 0) {
    const L = (rest.match(/(?:^|[^a-z0-9])l(\d+)(?![a-z0-9])/) || [])[1], N = (rest.match(/(?:^|[^a-z0-9])n(\d+)(?![a-z0-9])/) || [])[1]
    if (L && N) for (const m of savedNestings(order, list)) {
      const p = m.sheets[Number(L) - 1]?.placed[Number(N) - 1]
      const d = p && m.details[p.detailIndex]
      if (d) { di = list.indexOf(d); des = detailMeta(d)?.des || ''; break }
    }
  }
  // 3) по наименованию детали
  if (di < 0) list.forEach((d, i) => { if (di < 0 && d.name && forms(d.name).some(f => f.length > 2 && tokens.includes(f))) di = i })
  return { order, details: list, di, des }
}
