// Номер телефона при регистрации: страна (код) + номер без кода фиксированной длины.
// Номер, где не хватает цифры, отправить нельзя — человек видит это сразу, а не после одобрения заявки.
// len — сколько цифр после кода страны: [мин, макс].

export const PHONE_COUNTRIES = [
  { iso: 'KZ', name: 'Казахстан', dial: '7', len: [10, 10], mask: '700 000 00 00' },
  { iso: 'RU', name: 'Россия', dial: '7', len: [10, 10], mask: '900 000 00 00' },
  { iso: 'UZ', name: 'Узбекистан', dial: '998', len: [9, 9], mask: '90 000 00 00' },
  { iso: 'KG', name: 'Кыргызстан', dial: '996', len: [9, 9], mask: '700 000 000' },
  { iso: 'TJ', name: 'Таджикистан', dial: '992', len: [9, 9], mask: '90 000 0000' },
  { iso: 'TM', name: 'Туркменистан', dial: '993', len: [8, 8], mask: '60 000000' },
  { iso: 'AZ', name: 'Азербайджан', dial: '994', len: [9, 9], mask: '50 000 00 00' },
  { iso: 'AM', name: 'Армения', dial: '374', len: [8, 8], mask: '90 000000' },
  { iso: 'GE', name: 'Грузия', dial: '995', len: [9, 9], mask: '500 00 00 00' },
  { iso: 'BY', name: 'Беларусь', dial: '375', len: [9, 9], mask: '29 000 00 00' },
  { iso: 'UA', name: 'Украина', dial: '380', len: [9, 9], mask: '50 000 00 00' },
  { iso: 'MD', name: 'Молдова', dial: '373', len: [8, 8], mask: '600 00 000' },
  { iso: 'MN', name: 'Монголия', dial: '976', len: [8, 8], mask: '8800 0000' },
  { iso: 'TR', name: 'Турция', dial: '90', len: [10, 10], mask: '500 000 00 00' },
  { iso: 'CN', name: 'Китай', dial: '86', len: [11, 11], mask: '130 0000 0000' },
  { iso: 'PL', name: 'Польша', dial: '48', len: [9, 9], mask: '500 000 000' },
  { iso: 'DE', name: 'Германия', dial: '49', len: [10, 11], mask: '1500 0000000' },
  { iso: 'LT', name: 'Литва', dial: '370', len: [8, 8], mask: '600 00000' },
  { iso: 'LV', name: 'Латвия', dial: '371', len: [8, 8], mask: '2000 0000' },
  { iso: 'EE', name: 'Эстония', dial: '372', len: [7, 8], mask: '5000 0000' },
  { iso: 'GB', name: 'Великобритания', dial: '44', len: [10, 10], mask: '7400 000000' },
  { iso: 'CZ', name: 'Чехия', dial: '420', len: [9, 9], mask: '600 000 000' },
  { iso: 'OTHER', name: 'Другая страна', dial: '', len: [6, 13], mask: 'номер без кода страны' },
]

// Страны для поля «Страна» (регистрация, производство): все страны из кодов телефона и ещё несколько.
// Список — только подсказка: любую страну можно вписать вручную.
export const COUNTRY_NAMES = [...new Set([...PHONE_COUNTRIES.filter(c => c.iso !== 'OTHER').map(c => c.name),
  'Латвия', 'Литва', 'Эстония', 'Израиль', 'ОАЭ', 'Чехия', 'Казахстан'])]

export const phoneCountry = iso => PHONE_COUNTRIES.find(c => c.iso === iso) || PHONE_COUNTRIES[0]

// Страна по часовому поясу телефона — чтобы сразу подставить код
const TZ = {
  Almaty: 'KZ', Qostanay: 'KZ', Aqtobe: 'KZ', Aqtau: 'KZ', Atyrau: 'KZ', Oral: 'KZ', Qyzylorda: 'KZ',
  Moscow: 'RU', Samara: 'RU', Yekaterinburg: 'RU', Omsk: 'RU', Novosibirsk: 'RU', Krasnoyarsk: 'RU', Irkutsk: 'RU', Yakutsk: 'RU', Vladivostok: 'RU',
  Kaliningrad: 'RU', Volgograd: 'RU', Saratov: 'RU', Barnaul: 'RU', Tomsk: 'RU', Novokuznetsk: 'RU', Magadan: 'RU', Kamchatka: 'RU', Astrakhan: 'RU', Ulyanovsk: 'RU', Kirov: 'RU',
  Tashkent: 'UZ', Samarkand: 'UZ', Bishkek: 'KG', Dushanbe: 'TJ', Ashgabat: 'TM', Baku: 'AZ', Yerevan: 'AM', Tbilisi: 'GE', Minsk: 'BY',
  Kiev: 'UA', Kyiv: 'UA', Chisinau: 'MD', Ulaanbaatar: 'MN', Istanbul: 'TR', Shanghai: 'CN', Urumqi: 'CN', Warsaw: 'PL', Berlin: 'DE', Busingen: 'DE',
  Vilnius: 'LT', Riga: 'LV', Tallinn: 'EE', London: 'GB', Prague: 'CZ',
}
/** Страна по часовому поясу или '' — для регистрации по почте (там нет номера, по которому угадать) */
export function guessCountryName() {
  try {
    const iso = TZ[String(Intl.DateTimeFormat().resolvedOptions().timeZone || '').split('/').pop()]
    return iso ? phoneCountry(iso).name : ''
  } catch { return '' }
}
export function guessPhoneCountry() {
  try {
    const city = String(Intl.DateTimeFormat().resolvedOptions().timeZone || '').split('/').pop()
    if (TZ[city]) return TZ[city]
  } catch { /* нет Intl */ }
  return 'KZ'
}

const onlyDigits = v => String(v || '').replace(/\D/g, '')

/** Цифры номера без кода страны. Вставили номер целиком (+7…, 8…) — код страны отрезается. */
export function nationalDigits(input, c) {
  let d = onlyDigits(input)
  if (c.dial && d.length > c.len[1] && d.startsWith(c.dial)) d = d.slice(c.dial.length)
  if (c.dial === '7' && d.length === 11 && d.startsWith('8')) d = d.slice(1)
  return d.slice(0, c.len[1] + (c.dial ? 0 : 4))
}

/** Красивый вид: «700 000 00 00» по маске страны */
export function formatNational(d, c) {
  if (!c.dial) return d
  const groups = c.mask.split(' ').map(g => g.length)
  const out = []; let i = 0
  for (const g of groups) { if (i >= d.length) break; out.push(d.slice(i, i + g)); i += g }
  if (i < d.length) out.push(d.slice(i))
  return out.join(' ')
}

/** Полный номер для входа и заявки: «+7 700 000 00 00» */
export function fullPhone(c, national, otherDial = '') {
  const dial = c.dial || onlyDigits(otherDial)
  return `+${dial} ${formatNational(national, c)}`.trim()
}

/** Ошибка номера или '' */
export function phoneProblem(c, national, otherDial = '') {
  const n = national.length
  if (!c.dial && onlyDigits(otherDial).length < 1) return 'Укажите код страны'
  if (n < c.len[0]) return `Не хватает цифр: нужно ${c.len[0] === c.len[1] ? c.len[0] : `${c.len[0]}–${c.len[1]}`}, введено ${n}`
  if (n > c.len[1]) return 'Лишние цифры в номере'
  return ''
}

/** Полный номер цифрами (77011234567) -> { iso, national }; код страны угадывается по началу (7 6…/7 7… — Казахстан, иначе Россия) */
export function splitFullPhone(digits, fallbackIso = 'KZ') {
  const d = String(digits || '').replace(/\D/g, '')
  if (!d) return { iso: fallbackIso, national: '' }
  const byDial = PHONE_COUNTRIES.filter(c => c.dial && d.startsWith(c.dial) && d.length - c.dial.length >= c.len[0] && d.length - c.dial.length <= c.len[1])
    .sort((a, b) => b.dial.length - a.dial.length)
  if (!byDial.length) return { iso: fallbackIso, national: '' }
  let c = byDial[0]
  if (c.dial === '7') c = phoneCountry(/^[67]/.test(d.slice(1)) ? 'KZ' : 'RU')
  return { iso: c.iso, national: d.slice(c.dial.length) }
}
