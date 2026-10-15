// Языки интерфейса. Приложение написано по-русски; на другом языке русские фразы интерфейса заменяются прямо
// на экране по словарю (src/i18n/dict/<язык>.json: { "русская фраза": "перевод" }). Так переводится всё сразу —
// кнопки, подписи, подсказки, всплывающие окна — без переписывания каждого экрана, а то, что вводит пользователь
// (названия заказов, деталей, материалов), не трогается: его нет в словаре.
// Фразы с числами и именами — шаблоны: «Отмечено: {0} дет.» подходит к «Отмечено: 12 дет.».
// Чего нет в словаре — остаётся по-русски.

export const LANGS = [
  ['ru', 'Русский'], ['uk', 'Українська'], ['en', 'English'], ['kk', 'Қазақша'], ['ky', 'Кыргызча'], ['uz', 'Oʻzbekcha'], ['az', 'Azərbaycanca'],
  ['tr', 'Türkçe'], ['zh', '中文'], ['de', 'Deutsch'], ['pl', 'Polski'], ['ar', 'العربية'],
]
const LOCALE = { ru: 'ru-RU', uk: 'uk-UA', en: 'en-GB', kk: 'kk-KZ', ky: 'ky-KG', uz: 'uz-UZ', az: 'az-AZ', tr: 'tr-TR', zh: 'zh-CN', de: 'de-DE', pl: 'pl-PL', ar: 'ar' }
const RTL = new Set(['ar'])
const KEY = 'appLang'
const dicts = import.meta.glob('./dict/*.json')     // подгружается только словарь выбранного языка

const known = c => LANGS.some(([x]) => x === c)
/** Язык телефона / браузера, если он есть в приложении (uk-UA → uk, kk-KZ → kk …); иначе — русский */
export function deviceLang() {
  try {
    for (const l of navigator.languages || [navigator.language]) {
      const c = String(l || '').toLowerCase().split('-')[0]
      if (known(c)) return c
    }
  } catch { /* нет navigator */ }
  return 'ru'
}
/** Язык сам пользователь выбирал (тогда автоопределение его не трогает) */
export const langChosen = () => { try { return known(localStorage.getItem(KEY)) } catch { return false } }
// Язык: выбранный пользователем, а если он ещё ничего не выбирал — язык его телефона, чтобы не пришлось искать свой
// Тот, кто уже входил в приложение (есть сохранённый вход), остаётся на русском, как и работал: язык телефона — только для новых
const hadSession = () => { try { for (let i = 0; i < localStorage.length; i++) if (/^sb-.*-auth-token$/.test(localStorage.key(i) || '')) return true } catch { /* без памяти */ } return false }
let first = null
export function getLang() {
  try {
    const v = localStorage.getItem(KEY)
    if (known(v)) return v
    if (first == null) first = hadSession() ? 'ru' : deviceLang()     // один раз за запуск: вход после него язык уже не меняет
    return first
  } catch { return 'ru' }
}

/**
 * Язык по тому, что человек написал (имя, страна, город при регистрации) — по буквам, которые есть только в этом языке.
 * Русский и украинский/казахский различаются как раз такими буквами: ї, є, ґ, і — украинский; ә, ғ, қ, ң, ө, ұ, һ — казахский.
 * -> код языка или '' (не понять)
 */
export function guessLang(text) {
  const t = String(text || '')
  if (/[\u4e00-\u9fff]/.test(t)) return 'zh'
  if (/[\u0600-\u06ff]/.test(t)) return 'ar'
  if (/[әғқұһ]/i.test(t)) return 'kk'
  if (/[їєґ]/i.test(t) || (/[іІ]/.test(t) && !/[ыэъЫЭЪ]/.test(t) && /[А-Яа-я]/.test(t))) return 'uk'
  if (/[ңөү]/i.test(t) && /[А-Яа-я]/.test(t)) return 'ky'
  if (/ə/i.test(t)) return 'az'
  if (/[ğşı]/i.test(t)) return 'tr'
  if (/[oʻgʻ]ʻ|[og]['ʼ‘]/i.test(t) && /[a-z]/i.test(t)) return 'uz'
  if (/[ąćęłńśźż]/i.test(t)) return 'pl'
  if (/[äöüß]/i.test(t)) return 'de'
  return ''
}
const NAMES = Object.fromEntries(LANGS)
// вопрос «переключить язык?» — на том языке, который предлагаем
const ASK = {
  uk: 'Схоже, ви пишете українською. Перемкнути застосунок на українську мову?',
  kk: 'Сіз қазақша жазып отырған сияқтысыз. Қолданбаны қазақ тіліне ауыстыру керек пе?',
  ky: 'Сиз кыргызча жазып жаткандайсыз. Колдонмону кыргыз тилине которобузбу?',
  uz: 'Oʻzbekcha yozayotganga oʻxshaysiz. Ilovani oʻzbek tiliga oʻtkazaylikmi?',
  az: 'Deyəsən, azərbaycanca yazırsınız. Tətbiqi Azərbaycan dilinə keçirək?',
  tr: 'Türkçe yazıyorsunuz gibi görünüyor. Uygulamayı Türkçeye geçirelim mi?',
  zh: '您似乎在使用中文。要将应用切换为中文吗？',
  ar: 'يبدو أنك تكتب بالعربية. هل تريد تبديل لغة التطبيق إلى العربية؟',
  pl: 'Wygląda na to, że piszesz po polsku. Przełączyć aplikację na język polski?',
  de: 'Sie schreiben anscheinend auf Deutsch. App auf Deutsch umstellen?',
}
/** После регистрации: если человек писал на своём языке, а язык он сам не выбирал — предложить переключиться (одним «ОК») */
export function offerLangFrom(text, goTo = null) {
  const g = guessLang(text)
  if (!g || g === getLang() || langChosen() || !ASK[g]) return false
  // confirm здесь — без перевода: вопрос уже на нужном языке
  if (window.__nativeConfirm ? window.__nativeConfirm(ASK[g]) : window.confirm(ASK[g])) {
    try { localStorage.setItem(KEY, g) } catch { /* без памяти */ }
    if (goTo) window.location.assign(goTo); else window.location.reload()
    return true
  }
  try { localStorage.setItem(KEY, getLang()) } catch { /* без памяти */ }   // отказался — больше не спрашивать
  return false
}
export const langName = c => NAMES[c] || c
export function setLang(code) {
  try { localStorage.setItem(KEY, code) } catch { /* без памяти */ }
  window.location.reload()            // проще и надёжнее, чем возвращать каждую надпись обратно
}
export const langDir = code => (RTL.has(code) ? 'rtl' : 'ltr')

// ── перевод строки ──
let exact = new Map(), patterns = [], byHead = new Map()
const norm = s => s.replace(/\s+/g, ' ').trim()
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function compile(dict) {
  exact = new Map(); patterns = []; byHead = new Map()
  for (const [k, v] of Object.entries(dict)) {
    if (!v) continue
    if (/\{\d+\}/.test(k)) {
      const parts = k.split(/\{(\d+)\}/)        // текст, номер, текст, номер…
      let re = '^', order = []
      parts.forEach((p, i) => { if (i % 2) { re += '(.+?)'; order.push(Number(p)) } else re += esc(p) })
      const head = parts[0].slice(0, 4)
      const pat = { re: new RegExp(re + '$', 's'), order, to: v }
      if (head.length >= 4) { if (!byHead.has(head)) byHead.set(head, []); byHead.get(head).push(pat) } else patterns.push(pat)
    } else exact.set(k, v)
  }
}
/** Перевести фразу (с сохранением пробелов по краям). Нет в словаре — та же фраза */
export function tr(text) {
  if (!active || !text || !/[А-Яа-яЁё]/.test(text)) return text
  const lead = text.match(/^\s*/)[0], tail = text.match(/\s*$/)[0], core = norm(text)
  let out = exact.get(core)
  if (out == null) {
    for (const p of [...(byHead.get(core.slice(0, 4)) || []), ...patterns]) {
      const m = p.re.exec(core)
      if (m) { const vals = {}; p.order.forEach((n, i) => { vals[n] = tr(m[i + 1]) }); out = p.to.replace(/\{(\d+)\}/g, (_, n) => vals[n] ?? ''); break }
    }
  }
  if (out == null && core.includes('\n') === false && /[.!?] /.test(core)) {
    // несколько предложений подряд — по предложениям
    const parts = core.split(/(?<=[.!?])\s+/)
    if (parts.length > 1) { const t = parts.map(s => exact.get(s) ?? s); if (t.some((s, i) => s !== parts[i])) out = t.join(' ') }
  }
  return out == null ? text : lead + out + tail
}
/** Многострочное сообщение (alert, confirm): целиком, а если нет — по строкам */
export const trLines = text => { const t = tr(String(text ?? '')); return t !== text ? t : String(text ?? '').split('\n').map(tr).join('\n') }

// ── перевод экрана ──
let active = false
const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'CODE', 'PRE', 'NOSCRIPT'])
const ATTRS = ['placeholder', 'title', 'aria-label']
const skipEl = el => { for (let e = el; e; e = e.parentElement) { if (SKIP.has(e.tagName) || e.isContentEditable || e.dataset?.noI18n != null) return true } return false }
function doText(n) {
  const v = n.nodeValue
  if (!v || v === n.__tr || !/[А-Яа-яЁё]/.test(v) || skipEl(n.parentElement)) return
  const t = tr(v)
  if (t !== v) { n.__tr = t; n.nodeValue = t }
}
function doAttrs(el) {
  if (el.nodeType !== 1 || skipEl(el.parentElement)) return
  for (const a of ATTRS) {
    const v = el.getAttribute(a)
    if (v && /[А-Яа-яЁё]/.test(v) && v !== el['__tr_' + a]) { const t = tr(v); if (t !== v) { el['__tr_' + a] = t; el.setAttribute(a, t) } }
  }
}
function doTree(root) {
  if (root.nodeType === 3) { doText(root); return }
  if (root.nodeType !== 1 && root.nodeType !== 11) return
  if (root.nodeType === 1) { if (SKIP.has(root.tagName) && root.tagName !== 'INPUT') return; doAttrs(root) }
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
  for (let n = w.nextNode(); n; n = w.nextNode()) { if (n.nodeType === 3) doText(n); else doAttrs(n) }
}

/** Включить язык: загрузить словарь и переводить всё, что появляется на экране */
export async function startI18n() {
  const lang = getLang()
  document.documentElement.lang = lang
  document.documentElement.dir = langDir(lang)
  if (lang === 'ru') return
  const load = dicts[`./dict/${lang}.json`]
  if (!load) return
  let dict
  try { dict = (await load()).default || {} } catch { return }
  compile(dict)
  active = true
  // даты и время — в формате выбранного языка (в коде везде 'ru-RU')
  const loc = LOCALE[lang]
  for (const fn of ['toLocaleDateString', 'toLocaleString', 'toLocaleTimeString']) {
    const orig = Date.prototype[fn]
    Date.prototype[fn] = function (l, o) { return orig.call(this, l === 'ru-RU' || l === 'ru' ? loc : l, o) }
  }
  // всплывающие окна
  const { alert, confirm, prompt } = window
  window.__nativeConfirm = m => confirm.call(window, m)
  window.alert = m => alert.call(window, trLines(m))
  window.confirm = m => confirm.call(window, trLines(m))
  window.prompt = (m, d) => prompt.call(window, trLines(m), d)
  // экран: сейчас и всё, что появится
  doTree(document.body)
  document.title = tr(document.title)
  let queue = new Set(), planned = false
  const flush = () => { planned = false; const q = queue; queue = new Set(); q.forEach(n => { if (n.isConnected) doTree(n) }) }
  new MutationObserver(list => {
    for (const m of list) {
      if (m.type === 'characterData') queue.add(m.target)
      else if (m.type === 'attributes') queue.add(m.target)
      else m.addedNodes.forEach(n => queue.add(n))
    }
    if (!planned) { planned = true; queueMicrotask(flush) }
  }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS })
}
