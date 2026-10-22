// Что писать на детали на карте раскроя и в DXF — выбирает пользователь.
// Свойства детали (обозначение, позиция, ID из Базиса и т.д.) лежат в
// contour.meta — они же пригодятся для бирки.
export const LABEL_MODES = [
  ['name', 'Наименование'],
  ['des', 'Обозначение'],
  ['des_name', 'Обозначение + наименование'],
  ['pos', 'Позиция'],
  ['none', 'Без подписи'],
]

const metaCache = new WeakMap()
/** Свойства детали из contour.meta (detail — строка order_details или деталь из формы) */
export function detailMeta(detail) {
  if (!detail || !detail.contour) return null
  if (typeof detail.contour !== 'string') return detail.contour.meta || null
  const hit = metaCache.get(detail)
  if (hit && hit.src === detail.contour) return hit.meta
  let meta
  try { meta = JSON.parse(detail.contour)?.meta || null } catch { meta = null }
  metaCache.set(detail, { src: detail.contour, meta })
  return meta
}

// Позиция / обозначение: из модели (Базис, Астра — meta.pos / meta.des), а у импорта из Excel/CSV —
// из колонки, назначенной «Свойство (на бирку)» с похожим названием («Позиция детали», «Поз.», «Обозначение»)
const userProp = (m, re) => {
  const u = m?.user
  if (!u || typeof u !== 'object') return ''
  const k = Object.keys(u).find(x => re.test(String(x).trim()))
  return k ? String(u[k] ?? '').trim() : ''
}
export const metaPos = m => (m?.pos != null && String(m.pos).trim() ? String(m.pos).trim() : userProp(m, /^(позиц|поз\.?$|поз\b|pos\b|pos\.|position)/i))
export const metaDes = m => (m?.des != null && String(m.des).trim() ? String(m.des).trim() : userProp(m, /^(обознач|designation)/i))

/** Подпись уложенной детали p по выбранному режиму; short — префикс до 3 букв (для карты) */
export function partLabel(p, details, mode, short = false) {
  if (mode === 'none') return ''
  // p.label — это display_name, где префикс уже стоит впереди («Кухня БОК»): отрезаем его,
  // иначе на карте выходит «Кух Кухня БОК»; префикс, совпадающий с именем («БОК» у «БОК»), не пишем вовсе
  let name = String(p.label || '')
  const pfx = String(p.prefix || '').trim()
  if (pfx && name.startsWith(pfx + ' ')) name = name.slice(pfx.length + 1)
  name = name.replace(/Деталь\s*/, 'Д')
  const showPfx = pfx && pfx !== name.trim()
  const base = (showPfx ? (short ? pfx.slice(0, 3) : pfx) + ' ' : '') + name
  if (!mode || mode === 'name') return base
  const m = detailMeta(details?.[p.detailIndex])
  if (mode === 'des') return metaDes(m) || base
  if (mode === 'des_name') { const des = metaDes(m); return des ? `${des} ${name}` : base }
  if (mode === 'pos') return metaPos(m) || base
  return base
}
