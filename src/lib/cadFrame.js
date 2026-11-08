// Конструктор: металлический каркас (стеллаж, витрина, торговое оборудование) из профиля + стекло / ЛДСП.
// Четыре стойки по углам, на каждом уровне — обвязка из 4 перемычек; полки лежат на перемычках;
// стенки из стекла (бока, задняя) крепятся стеклодержателями. Профиль идёт в спецификацию и в линейный раскрой хлыстов.

export const FRAME_DEFAULTS = {
  W: 1000, H: 1800, D: 400,
  a: 20, b: 20, material: 'Профиль 20×20 сталь',
  levels: 5,                 // уровней обвязки (низ, промежуточные, верх)
  foot: 30,                  // нижняя обвязка от пола
  shelf: 'glass',            // полки: glass — стекло, sheet — ЛДСП, none — нет
  topShelf: true,
  shelfT: 6, shelfMaterial: 'Стекло прозрачное 6 мм',
  walls: 'none',             // стеклянные стенки: none, sides — бока, sides_back — бока и задняя, back — задняя
  glassT: 4, glassMaterial: 'Стекло прозрачное 4 мм',
  holders: 4,                // стеклодержателей на одну стенку
}

export const FRAME_PRESETS = [
  ['rack_glass', 'Стеллаж металл, полки стекло', {}],
  ['vitrina', 'Витрина: стекло бока и зад', { W: 800, H: 1900, D: 450, levels: 6, walls: 'sides_back' }],
  ['rack_ldsp', 'Стеллаж металл, полки ЛДСП', { W: 1200, H: 2000, D: 500, a: 40, b: 20, material: 'Профиль 40×20 сталь', shelf: 'sheet', shelfT: 16, shelfMaterial: 'ЛДСП Белый 16', levels: 5 }],
  ['counter', 'Прилавок со стеклом', { W: 1500, H: 950, D: 600, levels: 3, walls: 'sides', a: 25, b: 25, material: 'Профиль 25×25 сталь' }],
]

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d)
const r1 = v => Math.round(v * 10) / 10

function rec(key, name, kind, role, box, material, extra = {}) {
  const size = [box[3] - box[0], box[4] - box[1], box[5] - box[2]]
  const order = [0, 1, 2].sort((i, j) => size[j] - size[i])
  // длина — самая длинная ось, толщина — самая тонкая
  return { key, name, kind, role, box: box.map(r1), lAxis: order[0], tAxis: order[2], tSign: 1, material, edges: {}, grooves: [], ...extra }
}

export function frameParts(params) {
  const p = { ...FRAME_DEFAULTS, ...(params || {}) }
  const W = num(p.W, 1000), H = num(p.H, 1800), D = num(p.D, 400)
  const a = num(p.a, 20), b = num(p.b, a)          // a — по ширине/глубине, b — по высоте перемычки
  const mat = p.material || 'Профиль'
  const parts = [], hw = [], warn = []
  const n = Math.max(2, Math.round(num(p.levels, 5)))
  const foot = num(p.foot, 30)
  const ys = Array.from({ length: n }, (_, i) => foot + ((H - b - foot) * i) / (n - 1))
  // стойки
  ;[[0, 0], [W - a, 0], [0, D - a], [W - a, D - a]].forEach(([x, z], i) =>
    parts.push(rec('post' + i, 'Стойка', 'profile', 'металл', [x, 0, z, x + a, H, z + a], mat)))
  hw.push({ name: 'Подпятник регулируемый', qty: 4 })
  // обвязка уровней
  ys.forEach((y, i) => {
    parts.push(rec(`rf${i}`, 'Перемычка по ширине', 'profile', 'металл', [a, y, D - a, W - a, y + b, D], mat))
    parts.push(rec(`rb${i}`, 'Перемычка по ширине', 'profile', 'металл', [a, y, 0, W - a, y + b, a], mat))
    parts.push(rec(`rl${i}`, 'Перемычка по глубине', 'profile', 'металл', [0, y, a, a, y + b, D - a], mat))
    parts.push(rec(`rr${i}`, 'Перемычка по глубине', 'profile', 'металл', [W - a, y, a, W, y + b, D - a], mat))
  })
  // стенки из стекла
  const gt = num(p.glassT, 4)
  const sides = p.walls === 'sides' || p.walls === 'sides_back', back = p.walls === 'back' || p.walls === 'sides_back'
  const wy0 = ys[0] + b, wy1 = ys[n - 1]
  const holders = Math.max(0, Math.round(num(p.holders, 4)))
  if (sides) {
    parts.push(rec('gl', 'Стекло боковое', 'glass', 'стекло', [a, wy0, a, a + gt, wy1, D - a], p.glassMaterial))
    parts.push(rec('gr', 'Стекло боковое', 'glass', 'стекло', [W - a - gt, wy0, a, W - a, wy1, D - a], p.glassMaterial))
  }
  if (back) parts.push(rec('gb', 'Стекло заднее', 'glass', 'стекло', [a + (sides ? gt : 0), wy0, a, W - a - (sides ? gt : 0), wy1, a + gt], p.glassMaterial))
  const walls = (sides ? 2 : 0) + (back ? 1 : 0)
  if (walls && holders) hw.push({ name: 'Стеклодержатель', qty: walls * holders })
  // полки на перемычках (между стойками, по всей глубине — опираются на переднюю и заднюю перемычки)
  if (p.shelf !== 'none') {
    const st = num(p.shelfT, 6)
    const sx0 = a + (sides ? gt : 0) + 1, sx1 = W - a - (sides ? gt : 0) - 1
    const sz0 = back ? a + gt + 1 : 1
    ys.forEach((y, i) => {
      if (i === n - 1 && !p.topShelf) return
      const glass = p.shelf === 'glass'
      parts.push(rec('sh' + i, glass ? 'Полка стекло' : 'Полка', glass ? 'glass' : 'sheet', glass ? 'стекло' : 'наполнение',
        [sx0, y + b, sz0, sx1, y + b + st, D - 1], p.shelfMaterial || (glass ? 'Стекло' : 'ЛДСП'), glass ? {} : { edges: { '+z': '1' } }))
    })
    if (p.shelf === 'glass') hw.push({ name: 'Отбойник силиконовый (под стекло)', qty: 4 * (p.topShelf ? n : n - 1) })
  }
  if (W - 2 * a < 100 || D - 2 * a < 60) warn.push('Каркас слишком узкий для профиля такого сечения')
  return { parts, hw, warn, holes: [] }
}
