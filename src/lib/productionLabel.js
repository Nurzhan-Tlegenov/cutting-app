// Производство в списке выбора: «KZ · Алматы · Название» — сначала страна (коротким обозначением), потом город,
// потом организация. Сортировка — в том же порядке, по алфавиту.
const CODES = { казахстан: 'KZ', россия: 'RU', узбекистан: 'UZ', кыргызстан: 'KG', киргизия: 'KG', беларусь: 'BY', белоруссия: 'BY', таджикистан: 'TJ',
  азербайджан: 'AZ', армения: 'AM', грузия: 'GE', туркменистан: 'TM', туркмения: 'TM', украина: 'UA', молдова: 'MD', монголия: 'MN', китай: 'CN', турция: 'TR',
  kazakhstan: 'KZ', russia: 'RU', uzbekistan: 'UZ', kyrgyzstan: 'KG', belarus: 'BY' }
const clean = v => String(v || '').trim()

/** Короткое обозначение страны: KZ, RU… Неизвестная страна — как записана. */
export function countryCode(country) {
  const c = clean(country)
  if (!c) return ''
  const k = c.toLowerCase().replace(/^(республика|рф|рк)\s+/, '')
  if (CODES[k]) return CODES[k]
  if (/^(рк|kz|кз)$/i.test(c)) return 'KZ'
  if (/^(рф|ru|ру)$/i.test(c)) return 'RU'
  return /^[a-z]{2,3}$/i.test(c) ? c.toUpperCase() : c
}

export const productionLabel = pr => [countryCode(pr?.country), clean(pr?.city), clean(pr?.name)].filter(Boolean).join(' · ')

const cmp = (a, b) => a.localeCompare(b, 'ru', { sensitivity: 'base', numeric: true })
/** Страна -> город -> название; без страны или города — в конце своей группы */
export function sortProductions(list) {
  const key = v => clean(v) || '￿'
  return [...(list || [])].sort((a, b) => cmp(key(countryCode(a.country)), key(countryCode(b.country))) || cmp(key(a.city), key(b.city)) || cmp(clean(a.name), clean(b.name)))
}
