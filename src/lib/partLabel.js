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
  if (mode === 'des') return m?.des || base
  if (mode === 'des_name') return m?.des ? `${m.des} ${name}` : base
  if (mode === 'pos') return m?.pos ? String(m.pos) : base
  return base
}
