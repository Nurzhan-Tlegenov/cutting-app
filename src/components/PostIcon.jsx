// Значки рабочих постов — линейные, в одном стиле. Пост хранит выбранный значок в своём правиле (rule.icon);
// не выбран — подбирается по названию поста.
const S = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' }

// пильный диск: зубья по кругу и отверстие под вал
const sawTeeth = (() => {
  const pts = [], n = 14, R = 10, r = 8
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2, b = ((i + 0.6) / n) * Math.PI * 2
    pts.push(`${12 + R * Math.cos(a)},${12 + R * Math.sin(a)}`, `${12 + r * Math.cos(b)},${12 + r * Math.sin(b)}`)
  }
  return pts.join(' ')
})()

export const POST_ICONS = [
  ['saw', 'Раскрой (пильный диск)', <><polygon points={sawTeeth} {...S} /><circle cx="12" cy="12" r="2.4" {...S} /><circle cx="12" cy="12" r="5" {...S} strokeOpacity=".45" /></>],
  ['router', 'Фрезер ЧПУ', <><path d="M8 3h8v5l-2 2v3h-4v-3L8 8z" {...S} /><path d="M12 13v4" {...S} /><path d="M10.5 17h3l-.6 4h-1.8z" {...S} /><path d="M4 21h16" {...S} /></>],
  ['edge', 'Кромление', <><circle cx="9" cy="10" r="6" {...S} /><circle cx="9" cy="10" r="2" {...S} /><path d="M9 16h12" {...S} /><path d="M15 4l6 6v6" {...S} strokeOpacity=".5" /></>],
  ['drill', 'Присадка (сверло)', <><path d="M9 2h6v5H9z" {...S} /><path d="M10 7h4v3h-4z" {...S} /><path d="M12 10v10" {...S} /><path d="M12 12l2 1.5M12 15l-2 1.5M12 18l2 1.5" {...S} /><path d="M12 20l-1 2h2z" {...S} /></>],
  ['groove', 'Пазы, фрезеровка', <><rect x="3" y="7" width="18" height="10" rx="1.5" {...S} /><path d="M3 12h18" {...S} strokeDasharray="2 2" /><path d="M7 10v4M17 10v4" {...S} /></>],
  ['sand', 'Шлифовка', <><path d="M4 15l9-9 5 5-9 9z" {...S} /><path d="M6.5 17.5l9-9" {...S} strokeOpacity=".5" /><path d="M3 21h8" {...S} /></>],
  ['paint', 'Покраска, лак', <><path d="M4 4h12v5H4z" {...S} /><path d="M16 6h3v5h-7v3" {...S} /><rect x="10.5" y="14" width="3" height="7" rx="1" {...S} /></>],
  ['assembly', 'Сборка', <><path d="M14.5 4.5a4 4 0 0 0-5 5L3 16l2.5 2.5 6.5-6.5a4 4 0 0 0 5-5l-2.5 2.5-2-.5-.5-2z" {...S} /><path d="M17 15l4 4-2 2-4-4" {...S} /></>],
  ['qc', 'ОТК, проверка', <><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" {...S} /><path d="M8.5 12l2.5 2.5 4.5-5" {...S} /></>],
  ['pack', 'Упаковка', <><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" {...S} /><path d="M4 7.5l8 4.5 8-4.5M12 12v9" {...S} /></>],
  ['store', 'Склад', <><path d="M3 10l9-6 9 6v10H3z" {...S} /><path d="M7 20v-6h10v6M7 17h10" {...S} /></>],
  ['truck', 'Доставка', <><path d="M2 6h11v10H2zM13 9h4l3 3.5V16h-7" {...S} /><circle cx="6" cy="17.5" r="1.8" {...S} /><circle cx="16.5" cy="17.5" r="1.8" {...S} /></>],
  ['install', 'Установка, монтаж', <><path d="M3 11l9-7 9 7" {...S} /><path d="M5 10v10h14V10" {...S} /><path d="M10 20v-5h4v5" {...S} /></>],
  ['office', 'Оформление, документы', <><path d="M6 3h9l4 4v14H6z" {...S} /><path d="M15 3v4h4M9 12h7M9 16h5" {...S} /></>],
  ['pin', 'Другое', <><path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z" {...S} /><circle cx="12" cy="10" r="2.2" {...S} /></>],
]
const BY_KEY = Object.fromEntries(POST_ICONS.map(([k, , svg]) => [k, svg]))

/** Значок по названию поста (если не выбран) */
export function iconFor(name) {
  const n = String(name || '').toLowerCase()
  if (/раскр|распил|пил/.test(n)) return 'saw'
  if (/чпу|фрезер/.test(n)) return 'router'
  if (/кром/.test(n)) return 'edge'
  if (/присад|сверл/.test(n)) return 'drill'
  if (/паз|фрез/.test(n)) return 'groove'
  if (/шлиф/.test(n)) return 'sand'
  if (/покрас|эмал|лак|краск/.test(n)) return 'paint'
  if (/сбор/.test(n)) return 'assembly'
  if (/отк|контрол|провер/.test(n)) return 'qc'
  if (/упак/.test(n)) return 'pack'
  if (/склад/.test(n)) return 'store'
  if (/достав|отгруз/.test(n)) return 'truck'
  if (/установ|монтаж/.test(n)) return 'install'
  if (/оформ|документ|офис/.test(n)) return 'office'
  return 'pin'
}

/** Своя картинка поста (rule.iconImg — маленький PNG) или значок из набора */
export default function PostIcon({ icon, name, img, size = 24, style }) {
  if (img) return <img src={img} alt="" width={size} height={size} style={{ display: 'block', objectFit: 'contain', borderRadius: 4, ...style }} />
  const k = BY_KEY[icon] ? icon : iconFor(name)
  return <svg viewBox="0 0 24 24" width={size} height={size} style={{ display: 'block', ...style }}>{BY_KEY[k]}</svg>
}

/** Файл картинки -> квадратный PNG 96×96 (вписан, прозрачный фон сохраняется) — для значка поста */
export async function iconFromFile(blob) {
  const url = URL.createObjectURL(blob)
  try {
    const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Не удалось прочитать картинку')); i.src = url })
    const N = 96, cv = document.createElement('canvas'); cv.width = N; cv.height = N
    const g = cv.getContext('2d'), w = im.naturalWidth || N, h = im.naturalHeight || N, k = Math.min(N / w, N / h)
    g.imageSmoothingQuality = 'high'; g.drawImage(im, (N - w * k) / 2, (N - h * k) / 2, w * k, h * k)
    return cv.toDataURL('image/png')
  } finally { URL.revokeObjectURL(url) }
}
