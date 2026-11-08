// Конструктор: параметрический корпус (шкаф, тумба, пенал, модуль кухни).
// Корпус описывается параметрами (габарит, крышка/дно вкладные или накладные, опора, задняя стенка, наполнение, фасады),
// а детали считаются из них — поменял ширину, и все детали пересчитались.
//
// Система координат корпуса (мм): X — вправо, Y — вверх, Z — вперёд (к зрителю). Начало — левый нижний задний угол.
// Каждая деталь — «запись»: прямоугольный брусок box [x0, y0, z0, x1, y1, z1] + какая ось — толщина (tAxis),
// куда смотрит её лицевая (внутренняя) пласть (tSign), какая ось — длина детали (lAxis, обычно вдоль текстуры),
// материал, кромка по сторонам (по направлениям '+z' и т. д.) и пазы.

export const CAB_DEFAULTS = {
  W: 800, H: 2100, D: 560,
  t: 16, material: 'ЛДСП Белый 16',
  top: 'inset',          // крышка: inset — вкладная (между боковинами), overlay — накладная, rails — царги, none — нет
  bottom: 'inset',       // дно: inset — вкладное, overlay — накладное, rails — царги, none — нет
  base: 'none',          // опора: none — стоит на дне/боковинах, legs — ножки, plinth — цоколь
  legH: 100, plinthH: 80, plinthInset: 50,
  back: 'groove',        // задняя стенка: groove — в паз, overlay — накладная, inset — вкладная (ЛДСП), none — нет
  backT: 3, backMaterial: 'ХДФ Белый 3',
  grooveOffset: 16, grooveDepth: 8, grooveWidth: 4,   // паз под заднюю стенку: от заднего торца до паза, глубина, ширина
  railDepth: 100,
  sideL: true, sideR: true, sideFront: 0, sideBack: 0,      // боковины: есть / нет, отступ спереди и сзади
  topRails: 2, topRailOffset: 0, topDown: 0, topFront: 0, topBack: 0,          // крышка: царг 1/2 и отступ от верха; вкладная — отступы (минус — выступает)
  bottomRails: 2, bottomRailOffset: 0, bottomRailDepth: null, bottomUp: 0, bottomFront: 0, bottomBack: 0,  // дно — так же
  partitions: 0,         // вертикальные стойки — делят корпус на секции
  fill: 'shelves',       // наполнение: shelves — полки, drawers — ящики (комод)
  shelves: 0, shelfType: 'fixed', shelfSetback: 0,   // новый корпус — только каркас: полки, фасады, ящики включаются галочками    // fixed — неподвижные, loose — съёмные (меньше на зазор)
  drawers: 3, box: 'ldsp_overlay', slideGap: 13, slideLen: 450, boxTopGap: 40, boxBottomT: 3, boxBottomMaterial: 'ХДФ Белый 3', metalReduce: 42,
  doors: 0, gap: 3, facadeT: 16, facadeMaterial: 'ЛДСП Белый 16',
  edgeBody: '0,4', edgeFront: '1', edgeFacade: '1',
  kind: 'wardrobe',                       // тип корпуса: для «применить ко всем корпусам этого типа» (верхний / нижний кухни, шкаф…)
  doorLayout: 'v', doorOpen: 'left',      // фасады на весь корпус (быстрый режим): v — рядом, h — друг над другом; открывание одной двери
  soloOverlap: null,                      // перехлёст на полку/панель, за которой нет соседнего фасада (пусто — как на боковину)
  hingeCount: 0,                          // петель на дверь (0 — по высоте/ширине двери)
  frontMode: 'full', frontOffset: 1.5,   // фасад на боковине/дне/крышке: full — перекрывает торец полностью с отступом, half — до середины торца
  underTop: true,                         // при накладной крышке фасады — под крышкой (крышка над фасадами), иначе перекрывают её торец
  overhangFront: 0, overhangSide: 0,      // свес (козырёк) накладной крышки: вперёд от фасадов и в стороны
  tree: null,                             // проёмы и наполнение (см. ниже); нет — строится из старых параметров (стойки, полки, двери, ящики)
  hingeCup: 22, hingeEnd: 100, plateFront: 37,   // петли: центр чашки от края двери, первая/последняя от торца двери, планка от переднего торца
  pinFront: 37, pinBelow: 8,                       // полкодержатели: от переднего/заднего торца полки, центр ниже полки
}

export const CAB_KINDS = [['wardrobe', 'Шкаф'], ['base', 'Кухня: нижний'], ['wall', 'Кухня: верхний'], ['shelf', 'Стеллаж'], ['dresser', 'Комод'], ['other', 'Другое']]
// какие параметры переносятся «на все корпуса этого типа» — по группам
export const CAB_GROUPS = {
  body: ['material', 't', 'top', 'bottom', 'base', 'legH', 'plinthH', 'plinthInset', 'railDepth', 'overhangFront', 'overhangSide', 'underTop', 'edgeFront', 'edgeBody',
    'sideL', 'sideR', 'sideFront', 'sideBack', 'topRails', 'topRailOffset', 'topDown', 'topFront', 'topBack', 'bottomRails', 'bottomRailOffset', 'bottomRailDepth', 'bottomUp', 'bottomFront', 'bottomBack'],
  back: ['back', 'backT', 'backMaterial', 'grooveOffset', 'grooveDepth', 'grooveWidth'],
  fronts: ['facadeMaterial', 'facadeT', 'gap', 'frontMode', 'frontOffset', 'soloOverlap', 'edgeFacade', 'hingeCup', 'hingeEnd', 'plateFront', 'hingeCount'],
  boxes: ['box', 'slideGap', 'slideLen', 'boxTopGap', 'boxBottomT', 'boxBottomMaterial', 'metalReduce'],
}

export const CAB_PRESETS = [
  ['wardrobe', 'Шкаф распашной', { kind: 'wardrobe', shelves: 2, doors: 2 }],
  ['base', 'Кухня: нижний модуль', { kind: 'base', W: 600, H: 820, D: 560, top: 'rails', base: 'legs', legH: 100, shelves: 1, doors: 2 }],
  ['wall', 'Кухня: верхний модуль', { kind: 'wall', W: 600, H: 720, D: 300, top: 'inset', base: 'none', shelves: 2, doors: 2 }],
  ['dresser', 'Комод с ящиками', { kind: 'dresser', W: 800, H: 900, D: 450, top: 'overlay', base: 'plinth', fill: 'drawers', drawers: 4, doors: 0 }],
  ['shelf', 'Стеллаж открытый', { kind: 'shelf', W: 800, H: 1800, D: 350, back: 'none', shelves: 4, doors: 0 }],
]

const num = (v, d = 0) => (v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d)
const r1 = v => Math.round(v * 10) / 10

// ── Проёмы ──
// Внутренность корпуса — дерево проёмов. Проём можно разделить стойками (split 'v', дети слева направо)
// или полками (split 'h', дети снизу вверх). size ребёнка — ширина (v) или высота (h) проёма в свету, мм;
// null — «авто»: свободное место делится поровну между авто-проёмами. Габарит корпуса при этом не меняется.
// На проём ставится фасад: двери (n, сторона петель) или ящики (n) — фасад закрывает проём с перехлёстом.
export const nodeId = () => 'o' + Math.random().toString(36).slice(2, 8)
export const newNode = (extra = {}) => ({ id: nodeId(), size: null, split: null, children: [], front: null, shelfType: 'fixed', ...extra })

/** дерево из старых параметров (стойки, полки, двери/ящики) — чтобы старые проекты и шаблоны работали как раньше */
export function legacyTree(p) {
  // id — по месту в дереве (не случайные): дерево из параметров строится заново при каждом расчёте
  const mkN = (id, extra = {}) => ({ id, size: null, split: null, children: [], front: null, shelfType: 'fixed', ...extra })
  const root = mkN('root')
  if (p.fill === 'drawers') { root.front = { type: 'drawers', n: Math.max(1, Math.round(num(p.drawers, 3))) }; return root }
  const k = Math.max(0, Math.round(num(p.shelves, 0)))
  const shelvesNode = node => {
    if (k > 0) { node.split = 'h'; node.shelfType = p.shelfType || 'fixed'; node.children = Array.from({ length: k + 1 }, (_, i) => mkN(`${node.id}_${i}`)) }
    return node
  }
  const nPart = Math.max(0, Math.round(num(p.partitions, 0)))
  if (nPart > 0) { root.split = 'v'; root.children = Array.from({ length: nPart + 1 }, (_, i) => shelvesNode(mkN(`s${i}`))) }
  else shelvesNode(root)
  const doors = Math.max(0, Math.round(num(p.doors, 0)))
  if (doors) root.front = { type: 'doors', n: doors, hinge: doors === 1 ? (p.doorOpen || 'left') : 'auto', layout: p.doorLayout || 'v', open: p.doorOpen || 'left' }
  return root
}
export const treeOf = p => (p?.tree && typeof p.tree === 'object' ? p.tree : legacyTree({ ...CAB_DEFAULTS, ...(p || {}) }))
export function findNode(node, id, parent = null) {
  if (!node) return null
  if (node.id === id) return { node, parent }
  for (const c of node.children || []) { const r = findNode(c, id, node); if (r) return r }
  return null
}
// ── операции с деревом проёмов (возвращают новое дерево) ──
const clone = n => JSON.parse(JSON.stringify(n))
/** разделить проём панелями: kind 'v' — вертикальные, 'h' — горизонтальные; уже разделён так же — добавить ещё */
export function opSplit(tree, id, kind, n = 1) {
  const t = clone(tree), r = findNode(t, id)
  if (!r) return t
  const node = r.node
  if (node.split === kind && node.children?.length) { for (let i = 0; i < n; i++) node.children.push(newNode()); return t }
  if (node.split && node.children?.length) return null      // уже разделён по-другому — делим один из его проёмов
  node.split = kind; node.children = Array.from({ length: n + 1 }, () => newNode()); node.shelfType = node.shelfType || 'fixed'
  if (node.front?.type === 'drawers') node.front = null
  return t
}
/**
 * задать размер проёма в свету. dir — какие соседи «тянутся»: 'after' (выше / правее) или 'before' (ниже / левее):
 * «авто»-проёмы с этой стороны делят изменение поровну (заданные остаются), с другой стороны — всё остаётся как есть.
 * sizes — текущие размеры всех проёмов { id: { w, h } }.
 */
export function opSetSize(tree, id, v, dir, sizes) {
  const t = clone(tree), r = findNode(t, id)
  if (!r?.parent) return t
  const sib = r.parent.children, i = sib.indexOf(r.node)
  const key = r.parent.split === 'v' ? 'w' : 'h'
  let side = dir === 'before' ? sib.slice(0, i) : sib.slice(i + 1)
  if (!side.length) side = dir === 'before' ? sib.slice(i + 1) : sib.slice(0, i)
  // с выбранной стороны тянутся «авто»-проёмы (заданные 📌 остаются); авто нет — тянутся все проёмы этой стороны
  const pull = side.some(c => c.size == null) ? side.filter(c => c.size == null) : side
  sib.forEach(c => { if (c !== r.node) c.size = pull.includes(c) ? null : (sizes?.[c.id]?.[key] ?? c.size) })
  r.node.size = v
  return t
}
export function opPatch(tree, id, fn) { const t = clone(tree), r = findNode(t, id); if (r) fn(r.node, r.parent); return t }
export function opFront(tree, id, f) {
  return opPatch(tree, id, n => { n.front = f; if (f) { const clear = x => (x.children || []).forEach(c => { c.front = null; clear(c) }); clear(n) } })
}

const anyFront = n => !!n && (!!n.front || (n.children || []).some(anyFront))

/** размеры детей проёма: span — свет проёма по оси деления, t — толщина разделителя */
export function childSizes(node, span, t) {
  const ch = node.children || []
  const free = span - (ch.length - 1) * t
  const fixed = ch.reduce((a, c) => a + (c.size != null ? num(c.size) : 0), 0)
  const autos = ch.filter(c => c.size == null).length
  const auto = autos ? (free - fixed) / autos : 0
  return ch.map(c => (c.size != null ? num(c.size) : auto))
}

function mk(key, name, role, box, tAxis, tSign, lAxis, material, extra = {}) {
  return { key, name, role, kind: 'sheet', box: box.map(r1), tAxis, tSign, lAxis, material, edges: {}, grooves: [], ...extra }
}

/** параметры корпуса -> { parts: [записи], hw: [{ name, qty }], warn: [] } */
export function cabinetParts(params) {
  const p = { ...CAB_DEFAULTS, ...(params || {}) }
  const W = num(p.W, 800), H = num(p.H, 2100), D = num(p.D, 560), t = num(p.t, 16)
  const mat = p.material || 'ЛДСП'
  const parts = [], hw = [], warn = [], holes = []   // holes — отверстия фурнитуры: точка входа + направление внутрь детали
  const eB = p.edgeBody, eF = p.edgeFront
  const backT = num(p.backT, 3)
  const zb = p.back === 'overlay' ? backT : 0               // накладная задняя — сзади на торцах, корпус начинается за ней
  const plinth = p.base === 'plinth', legs = p.base === 'legs'
  const raise = legs ? num(p.legH, 100) : 0                  // корпус на ножках поднят
  const yb = legs ? raise : plinth ? num(p.plinthH, 80) : 0  // низ дна
  const bottomInset = p.bottom !== 'overlay'
  // боковины: при цоколе и вкладном дне — до пола (цоколь между ними), иначе стоят на опоре
  const sideY0 = plinth && bottomInset ? 0 : bottomInset ? yb : yb + t
  const topOver = p.top === 'overlay'
  const sideY1 = topOver ? H - t : H
  const front = { '+z': eF }
  // боковины можно убрать (галочки) и укоротить по глубине: отступ спереди / сзади
  const hasL = p.sideL !== false, hasR = p.sideR !== false
  const sF = num(p.sideFront, 0), sB = num(p.sideBack, 0)
  if (hasL) parts.push(mk('sideL', 'Боковина левая', 'каркас', [0, sideY0, zb + sB, t, sideY1, D - sF], 0, +1, 1, mat, { edges: front }))
  if (hasR) parts.push(mk('sideR', 'Боковина правая', 'каркас', [W - t, sideY0, zb + sB, W, sideY1, D - sF], 0, -1, 1, mat, { edges: front }))
  const xi0 = hasL ? t : 0, xi1 = hasR ? W - t : W

  // царги (планки): 1 — передняя, 2 — передняя и задняя; лежат плашмя между боковинами с отступом от верха / низа
  const rails = (pos, y0, count, depth, key, name, sign) => {
    const rd = Math.min(num(depth, 100), (D - zb) / 2)
    parts.push(mk(key + 'F', name + ' передняя', 'каркас', [xi0, y0, D - rd, xi1, y0 + t, D], 1, sign, 0, mat, { edges: front }))
    if (num(count, 2) >= 2) parts.push(mk(key + 'B', name + ' задняя', 'каркас', [xi0, y0, zb, xi1, y0 + t, zb + rd], 1, sign, 0, mat))
  }

  // ── дно: вкладное (с отступами снизу / спереди / сзади; минус — выступает), накладное, царги или нет ──
  let yi0 = yb
  if (p.bottom === 'overlay') {
    parts.push(mk('bottom', 'Дно', 'каркас', [0, yb, zb, W, yb + t, D], 1, +1, 0, mat, { edges: front }))
    yi0 = yb + t
  } else if (p.bottom === 'rails') {
    const y = yb + num(p.bottomRailOffset, 0)
    rails('b', y, p.bottomRails, p.bottomRailDepth ?? p.railDepth, 'brail', 'Царга нижняя', +1)
    yi0 = y + t
  } else if (p.bottom !== 'none') {
    const y = yb + num(p.bottomUp, 0)
    parts.push(mk('bottom', 'Дно', 'каркас', [xi0, y, zb + num(p.bottomBack, 0), xi1, y + t, D - num(p.bottomFront, 0)], 1, +1, 0, mat, { edges: front }))
    yi0 = y + t
  }

  // ── крышка: вкладная (с отступами сверху / спереди / сзади), накладная (свесы), царги или нет ──
  let yi1 = H
  const tree = treeOf(p)
  const hasFronts = anyFront(tree)
  const fT0 = num(p.facadeT, 16)
  if (topOver) {
    // накладная крышка: свес в стороны и вперёд (козырёк) — вперёд считается от фасадов, если фасады под крышкой
    const os = num(p.overhangSide, 0)
    const zf = D + (hasFronts && p.underTop !== false ? fT0 : 0) + num(p.overhangFront, 0)
    parts.push(mk('top', 'Крышка', 'каркас', [-os, H - t, zb, W + os, H, Math.max(D, zf)], 1, -1, 0, mat, { edges: { '+z': eF, '-x': eF, '+x': eF } }))
    yi1 = H - t
  } else if (p.top === 'inset') {
    const y = H - t - num(p.topDown, 0)
    parts.push(mk('top', 'Крышка', 'каркас', [xi0, y, zb + num(p.topBack, 0), xi1, y + t, D - num(p.topFront, 0)], 1, -1, 0, mat, { edges: front }))
    yi1 = y
  } else if (p.top === 'rails') {
    const y = H - t - num(p.topRailOffset, 0)
    rails('t', y, p.topRails, p.railDepth, 'rail', 'Царга', -1)
    yi1 = y
  }

  // ── задняя стенка ──
  let zi0 = zb
  if (p.back === 'overlay') {
    const by0 = Math.min(sideY0, yb)
    parts.push(mk('back', 'Задняя стенка', 'задняя', [1, by0 + 1, 0, W - 1, H - 1, backT], 2, +1, 1, p.backMaterial || 'ХДФ', { t: backT }))
    zi0 = backT
  } else if (p.back === 'groove') {
    const go = num(p.grooveOffset, 16), gd = num(p.grooveDepth, 8), gw = num(p.grooveWidth, backT + 1)
    const z0 = go + (gw - backT) / 2
    const topHas = p.top === 'inset' || topOver
    const botHas = p.bottom === 'inset' || p.bottom === 'overlay' || p.bottom == null
    const y1 = topHas ? yi1 + gd - 1 : H - 1
    const y0 = botHas ? yi0 - gd + 1 : Math.min(sideY0, yb) + 1
    parts.push(mk('back', 'Задняя стенка', 'задняя', [hasL ? xi0 - gd + 1 : 1, y0, z0, hasR ? xi1 + gd - 1 : W - 1, y1, z0 + backT], 2, +1, 1, p.backMaterial || 'ХДФ', { t: backT }))
    const g = { from: '-z', offset: go, width: gw, depth: gd, along: 'L' }
    for (const pr of parts) if (['sideL', 'sideR', ...(botHas ? ['bottom'] : []), ...(topHas ? ['top'] : [])].includes(pr.key)) pr.grooves.push({ ...g })
    if (go + gw > D - 50) warn.push('Паз под заднюю стенку слишком далеко от заднего торца')
    zi0 = z0 + backT
  } else if (p.back === 'inset') {
    parts.push(mk('back', 'Задняя стенка', 'задняя', [xi0, yi0, zb, xi1, yi1, zb + t], 2, +1, 1, mat))
    zi0 = zb + t
  }

  // ── опора ──
  if (plinth) {
    const ph = num(p.plinthH, 80), pi = num(p.plinthInset, 50)
    const px0 = bottomInset ? t : 0, px1 = bottomInset ? W - t : W
    parts.push(mk('plinthF', 'Цоколь передний', 'цоколь', [px0, 0, D - pi - t, px1, ph, D - pi], 2, -1, 0, mat, { edges: { '+z': eB } }))
    if (!bottomInset) parts.push(mk('plinthB', 'Цоколь задний', 'цоколь', [px0, 0, zb + 20, px1, ph, zb + 20 + t], 2, +1, 0, mat))
  }
  if (legs) {
    const s = 40, ins = 40
    const pts = [[ins, D - ins], [W - ins, D - ins], [ins, zb + ins], [W - ins, zb + ins]]
    if (W > 1000) pts.push([W / 2, D - ins], [W / 2, zb + ins])
    pts.forEach(([x, z], i) => parts.push({ ...mk('leg' + i, 'Ножка', 'опора', [x - s / 2, 0, z - s / 2, x + s / 2, raise, z + s / 2], 1, +1, 0, 'Ножка опора'), kind: 'hw' }))
    hw.push({ name: `Ножка ${raise} мм`, qty: pts.length })
  }

  // ── наполнение: дерево проёмов ──
  const gap = num(p.gap, 3), fT = fT0, fMat = p.facadeMaterial || mat
  const allE = { all: p.edgeFacade }
  const openings = []        // проёмы в свету: { id, box, w, h, leaf, depth }
  const fronts = []          // проёмы с фасадом
  const shelfSetback = num(p.shelfSetback, 0)
  let shelfLoose = 0
  const walk = (node, x0, x1, y0, y1, depth) => {
    openings.push({ id: node.id, box: [x0, y0, zi0, x1, y1, D].map(r1), w: r1(x1 - x0), h: r1(y1 - y0), leaf: !(node.split && node.children?.length), depth })
    if (x1 - x0 < 50 || y1 - y0 < 30) warn.push(`Проём ${r1(x1 - x0)}×${r1(y1 - y0)} — слишком маленький`)
    if (node.front) fronts.push({ node, x0, x1, y0, y1 })
    // фронтальная панель в проёме: параллельно фасаду, по глубине — от зада или от переда проёма, с отступами от сторон проёма
    if (node.fpanel) {
      const f = node.fpanel, d = num(f.dist, 0)
      const fz0 = f.from === 'front' ? D - d - t : zi0 + d
      parts.push(mk('fp_' + node.id, 'Фронтальная панель', 'наполнение',
        [x0 + num(f.l, 0), y0 + num(f.b, 0), fz0, x1 - num(f.r, 0), y1 - num(f.t, 0), fz0 + t], 2, f.from === 'front' ? -1 : +1, 1, mat, { edges: f.from === 'front' ? {} : {} }))
      if (fz0 < zi0 - 0.05 || fz0 + t > D + 0.05) warn.push('Фронтальная панель выходит за глубину проёма')
    }
    const ch = node.children || []
    if (!node.split || !ch.length) return
    const sizes = childSizes(node, node.split === 'v' ? x1 - x0 : y1 - y0, t)
    if (sizes.some(v => v < 0)) warn.push('Проёмы не помещаются — уменьшите заданные размеры проёмов')
    let pos = node.split === 'v' ? x0 : y0
    ch.forEach((c, i) => {
      const a = pos, b = pos + sizes[i]
      if (node.split === 'v') walk(c, a, b, y0, y1, depth + 1)
      else walk(c, x0, x1, a, b, depth + 1)
      if (i < ch.length - 1) {
        // отступы панелей этого деления спереди и сзади (короче по глубине)
        const setF = node.setFront != null ? num(node.setFront) : null, setB = num(node.setBack, 0)
        if (node.split === 'v') parts.push(mk('st_' + c.id, 'Вертикальная панель', 'наполнение', [b, y0, zi0 + setB, b + t, y1, D - (setF ?? 0)], 0, +1, 1, mat, { edges: front }))
        else {
          const loose = node.shelfType === 'loose', g = loose ? 1 : 0
          const sb = setF ?? (loose ? Math.max(shelfSetback, 2) : shelfSetback)
          parts.push(mk('sh_' + c.id, loose ? 'Горизонтальная панель (съёмная)' : 'Горизонтальная панель', 'наполнение', [x0 + g, b, zi0 + g + setB, x1 - g, b + t, D - sb], 1, +1, 0, mat, { edges: front }))
          if (loose) {
            shelfLoose++
            const pf = num(p.pinFront, 37), yp = b - num(p.pinBelow, 8)
            for (const z of [D - sb - pf, zi0 + g + setB + pf]) {
              holes.push({ p: [x0, yp, z], n: '-x', d: 5, depth: 12, note: 'Полкодержатель' })
              holes.push({ p: [x1, yp, z], n: '+x', d: 5, depth: 12, note: 'Полкодержатель' })
            }
          }
        }
      }
      pos = b + t
    })
  }
  walk(tree, xi0, xi1, yi0, yi1, 0)
  if (shelfLoose) hw.push({ name: 'Полкодержатель', qty: 4 * shelfLoose })

  // фасад закрывает проём с перехлёстом: на боковину / дно / крышку — полностью с отступом (или до середины торца),
  // на стойку / полку — до середины (зазор между соседними фасадами = зазор); под накладной крышкой — ниже крышки на зазор/2
  const off = num(p.frontOffset, gap / 2), half = p.frontMode === 'half'
  const outerExt = half ? t / 2 - gap / 2 : t - off
  const innerExt = t / 2 - gap / 2
  // на панель, за которой соседнего фасада нет, — перекрываем торец (как на боковину или своё значение)
  const soloExt = p.soloOverlap != null && p.soloOverlap !== '' ? num(p.soloOverlap) : outerExt
  const EPS = 0.05
  const ov = (a0, a1, b0, b1) => Math.min(a1, b1) - Math.max(a0, b0) > 1
  // есть ли фасад по ту сторону панели: проём с фасадом начинается сразу за панелью (через толщину t) и перекрывается по другой оси
  let cur = null
  const neighbor = edge => fronts.some(f => f !== cur && (
    edge === 'l' ? Math.abs(f.x1 + t - cur.x0) < EPS && ov(f.y0, f.y1, cur.y0, cur.y1)
      : edge === 'r' ? Math.abs(cur.x1 + t - f.x0) < EPS && ov(f.y0, f.y1, cur.y0, cur.y1)
        : edge === 'b' ? Math.abs(f.y1 + t - cur.y0) < EPS && ov(f.x0, f.x1, cur.x0, cur.x1)
          : Math.abs(cur.y1 + t - f.y0) < EPS && ov(f.x0, f.x1, cur.x0, cur.x1)))
  const inner = edge => (neighbor(edge) ? innerExt : soloExt)
  const extOf = (edge, v) => {
    if (edge === 'l') return Math.abs(v - xi0) < EPS ? outerExt : inner('l')
    if (edge === 'r') return Math.abs(v - xi1) < EPS ? outerExt : inner('r')
    if (edge === 'b') return Math.abs(v - yi0) < EPS ? outerExt : inner('b')
    if (Math.abs(v - yi1) > EPS) return inner('t')
    if (topOver && p.underTop !== false) return -gap / 2
    if (p.top === 'none') return -off
    return outerExt
  }
  const he = num(p.hingeEnd, 100), hc = num(p.hingeCup, 22), pf = num(p.plateFront, 37)
  const sg = num(p.slideGap, 13)
  const bT = num(p.boxBottomT, 3), bMat = p.boxBottomMaterial || 'ХДФ'
  let doorsN = 0, hingesN = 0, drawersN = 0
  fronts.forEach((F, fi) => {
    const { node, x0, x1, y0, y1 } = F
    cur = F
    const fx0 = x0 - extOf('l', x0), fx1 = x1 + extOf('r', x1), fy0 = y0 - extOf('b', y0), fy1 = y1 + extOf('t', y1)
    const fr = node.front
    const n = Math.max(1, Math.round(num(fr.n, 1)))
    if (fr.type === 'drawers') {
      const fh = (fy1 - fy0 - (n - 1) * gap) / n
      const bd = Math.min(num(p.slideLen, 450), D - zi0 - 10)
      const bxa = x0 + sg, bxb = x1 - sg
      for (let i = 0; i < n; i++) {
        const dy0 = fy0 + i * (fh + gap)
        const k = `dr${fi}_${i}_`
        parts.push(mk(k + 'f', 'Фасад ящика', 'фасад', [fx0, dy0, D, fx1, dy0 + fh, D + fT], 2, +1, 0, fMat, { edges: allE, t: fT }))
        const by0 = Math.max(dy0, y0) + 15
        const bh = Math.max(60, Math.min(fh - num(p.boxTopGap, 40), y1 - by0 - 5))
        const zf = D - 2, z0 = zf - bd
        const ys = by0 + 20
        for (const z of [D - 37, D - 37 - 224, D - 37 - Math.max(256, bd - 64)].filter(z => z > zi0 + 10)) {
          holes.push({ p: [x0, ys, z], n: '-x', d: 4, depth: 10, note: 'Направляющая' })
          holes.push({ p: [x1, ys, z], n: '+x', d: 4, depth: 10, note: 'Направляющая' })
        }
        if (p.box === 'metal') {
          const red = num(p.metalReduce, 42)
          parts.push(mk(k + 'bot', 'Ящик: дно', 'ящик', [x0 + red / 2, by0, z0, x1 - red / 2, by0 + t, zf], 1, +1, 0, mat))
          parts.push(mk(k + 'back', 'Ящик: задняя', 'ящик', [x0 + red / 2, by0 + t, z0, x1 - red / 2, by0 + bh, z0 + t], 2, +1, 0, mat))
          hw.push({ name: `Металлобокс ${bd} мм (боковины)`, qty: 1 })
          continue
        }
        const grooveBot = p.box === 'ldsp_groove'
        const sy0 = grooveBot ? by0 : by0 + bT
        const bE = { '+y': eB }
        parts.push(mk(k + 'sL', 'Ящик: боковина', 'ящик', [bxa, sy0, z0, bxa + t, sy0 + bh, zf], 0, +1, 2, mat, { edges: bE }))
        parts.push(mk(k + 'sR', 'Ящик: боковина', 'ящик', [bxb - t, sy0, z0, bxb, sy0 + bh, zf], 0, -1, 2, mat, { edges: bE }))
        parts.push(mk(k + 'ff', 'Ящик: передняя', 'ящик', [bxa + t, sy0, zf - t, bxb - t, sy0 + bh, zf], 2, -1, 0, mat, { edges: bE }))
        parts.push(mk(k + 'b', 'Ящик: задняя', 'ящик', [bxa + t, sy0, z0, bxb - t, sy0 + bh, z0 + t], 2, +1, 0, mat, { edges: bE }))
        if (grooveBot) {
          const go = 10, gd = 6, gw = bT + 1
          const yB = sy0 + go + (gw - bT) / 2
          parts.push(mk(k + 'bot', 'Ящик: дно', 'ящик', [bxa + t - gd + 1, yB, z0 + t - gd + 1, bxb - t + gd - 1, yB + bT, zf - t + gd - 1], 1, +1, 0, bMat, { t: bT }))
          for (const pr of parts.slice(-5, -1)) pr.grooves.push({ from: '-y', offset: go, width: gw, depth: gd, along: 'L', note: 'Паз под дно ящика' })
        } else {
          parts.push(mk(k + 'bot', 'Ящик: дно', 'ящик', [bxa, by0, z0, bxb, by0 + bT, zf], 1, +1, 0, bMat, { t: bT }))
        }
        drawersN++
        hw.push({ name: `Направляющие ${bd} мм, пара`, qty: 1 })
      }
      return
    }
    // двери: layout v — рядом (по ширине), h — друг над другом; открывание: left / right — петли сбоку, up / down — сверху / снизу.
    // Две и больше двери рядом: левые открываются влево, правые вправо.
    const lay = fr.layout === 'h' ? 'h' : 'v'
    const dw = lay === 'v' ? (fx1 - fx0 - (n - 1) * gap) / n : fx1 - fx0
    const dh = lay === 'h' ? (fy1 - fy0 - (n - 1) * gap) / n : fy1 - fy0
    const cnt = len => num(p.hingeCount, 0) > 0 ? Math.round(num(p.hingeCount)) : len < 900 ? 2 : len < 1600 ? 3 : len < 2000 ? 4 : 5
    const along = (a0, a1, k) => Array.from({ length: k }, (_, j) => a0 + he + ((a1 - a0 - 2 * he) * j) / Math.max(1, k - 1))
    for (let i = 0; i < n; i++) {
      const dx0 = lay === 'v' ? fx0 + i * (dw + gap) : fx0, dx1 = dx0 + dw
      const dy0 = lay === 'h' ? fy0 + i * (dh + gap) : fy0, dy1 = dy0 + dh
      const open = lay === 'v' && n > 1 ? (i < n / 2 ? 'left' : 'right') : (fr.open || (fr.hinge === 'right' ? 'right' : 'left'))
      const name = lay === 'v' && n > 1 ? (i === 0 ? 'Дверь левая' : i === n - 1 ? 'Дверь правая' : 'Дверь') : lay === 'h' && n > 1 ? (i === 0 ? 'Дверь нижняя' : i === n - 1 ? 'Дверь верхняя' : 'Дверь') : 'Дверь'
      parts.push(mk(`door${fi}_${i}`, name, 'фасад', [dx0, dy0, D, dx1, dy1, D + fT], 2, +1, 1, fMat, { edges: allE, t: fT }))
      let k
      if (open === 'left' || open === 'right') {
        const left = open === 'left'
        k = cnt(dh)
        const xc = left ? dx0 + hc : dx1 - hc
        for (const y of along(dy0, dy1, k)) {
          holes.push({ p: [xc, y, D], n: '+z', d: 35, depth: 12, note: 'Петля (чашка)' })
          // планка — на стенке проёма со стороны петель (боковина или вертикальная панель); у средних дверей при n > 2 — нет стенки
          const wall = left ? (lay === 'h' || i === 0) : (lay === 'h' || i === n - 1)
          if (wall) for (const d of [-16, 16]) holes.push(left ? { p: [x0, y + d, D - pf], n: '-x', d: 5, depth: 12, note: 'Планка петли' } : { p: [x1, y + d, D - pf], n: '+x', d: 5, depth: 12, note: 'Планка петли' })
        }
      } else {
        const up = open === 'up'
        k = cnt(dw)
        const yc = up ? dy1 - hc : dy0 + hc
        for (const x of along(dx0, dx1, k)) {
          holes.push({ p: [x, yc, D], n: '+z', d: 35, depth: 12, note: 'Петля (чашка)' })
          const wall = up ? (lay === 'v' || i === n - 1) : (lay === 'v' || i === 0)
          if (wall) for (const d of [-16, 16]) holes.push(up ? { p: [x + d, y1, D - pf], n: '+y', d: 5, depth: 12, note: 'Планка петли' } : { p: [x + d, y0, D - pf], n: '-y', d: 5, depth: 12, note: 'Планка петли' })
        }
      }
      doorsN++; hingesN += k
    }
  })
  if (hingesN) hw.push({ name: 'Петля накладная', qty: hingesN })
  if (doorsN + drawersN) hw.push({ name: 'Ручка', qty: doorsN + drawersN })

  // проверки
  for (const pr of parts) {
    const b = pr.box
    if (b[3] - b[0] <= 0 || b[4] - b[1] <= 0 || b[5] - b[2] <= 0) warn.push(`«${pr.name}»: размер получился нулевым или отрицательным — проверьте параметры`)
  }
  return { parts, hw, warn, holes, openings }
}
