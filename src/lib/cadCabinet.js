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
  legH: 100, plinthH: 80, plinthInset: 50, plinthBack: null, plinthBackOffset: 20,   // цоколь: передняя царга с отступом от фасада, задняя — по галочке с отступом от зада
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
  // ручки по умолчанию (у каждого блока дверей / ящиков — свои, front.handle): type bar — скоба (межцентровое cc, шаг 32),
  // knob — кнопка, edge — торцевая (крепится сзади фасада, выходит за верхний торец), none — нет;
  // orient h / v; anchor — привязка: c (центр), tc / bc, tl / tr / bl / br (углы), ml / mr, free-t / free-c / free-b (свободная сторона двери — против петель);
  // dx, dy — от края фасада до первого отверстия (или до линии ручки)
  handleDoor: { on: true, type: 'rail', cc: 128, orient: 'v', anchor: 'free-t', dx: 40, dy: 80 },
  handleDrawer: { on: true, type: 'rail', cc: 128, orient: 'h', anchor: 'c', dx: 40, dy: 40 },
}

// системы ящиков: ball — ЛДСП-короб на шариковых направляющих (зазор на сторону slideGap); under — ЛДСП-короб на направляющих скрытого монтажа
// (короб уже проёма на side с каждой стороны, дно в паз выше низа боковин на bottomUp); metal — металлобокс (дно и задняя ЛДСП уже проёма на reduce);
// msys — система с металлическими боковинами: дно уже проёма на bottomRed, задняя — на backRed, высота боковины sideH, дно короче направляющей на lenRed.
// Значения — типовые, их нужно сверить с каталогом производителя (меняются в блоке ящиков).
// фрезеровка фасадов МДФ (как выглядят на модели; программы фрезеровки для ЧПУ — следующим этапом):
// flat — гладкий, shaker — рамка 65 / филёнка, slim — тонкая рамка 25, classic — рамка с выпуклой филёнкой,
// fluted — рифлёный (полукруглые рейки), vgroove — вертикальные V-пазы, wave — 3D-волна, gola — интегрированная ручка (скос по верху)
export const FACADE_STYLES = [
  ['flat', 'Гладкий'], ['shaker', 'Шейкер (рамка)'], ['slim', 'Тонкая рамка'], ['classic', 'Классика (филёнка)'],
  ['fluted', 'Рифлёный'], ['vgroove', 'V-пазы'], ['wave', '3D-волна'], ['gola', 'Интегрированная ручка'],
]
// ручки: скобы и рейлинги (межцентровое), кнопки (одно отверстие), торцевые (крепятся сзади фасада, профиль — в зазоре над фасадом)
export const HANDLE_TYPES = [
  ['rail', 'Рейлинг'], ['bar', 'Скоба прямоугольная'], ['arch', 'Скоба-дуга'], ['knob', 'Кнопка круглая'], ['knobsq', 'Кнопка квадратная'],
  ['edge', 'Торцевая с язычком'], ['edgeflat', 'Торцевая плоская'],
]
// lens — ряд номинальных длин направляющих (NL) системы: длина берётся только из ряда (410 мм не бывает — встанет 400);
// значения — типовые по каталогам, сверить с каталогом поставщика
const BALL_LENS = [250, 300, 350, 400, 450, 500, 550, 600, 650, 700]
const BLUM_LENS = [270, 300, 350, 400, 450, 500, 550, 600, 650]
export const DRAWER_SYSTEMS = [
  ['ldsp_overlay', 'ЛДСП, дно накладное · шариковые', { type: 'ball', lens: BALL_LENS }],
  ['ldsp_groove', 'ЛДСП, дно в паз · шариковые', { type: 'ball', lens: BALL_LENS }],
  ['hidden', 'ЛДСП · скрытого монтажа (Blum Tandem / Movento, Hettich Quadro, DTC, GTV)', { type: 'under', side: 5, bottomUp: 13, lenRed: 10, lens: [250, 270, 300, 350, 400, 450, 500, 550, 600] }],
  ['metal', 'Метабокс (металлобокс)', { type: 'metal', lens: [270, 300, 350, 400, 450, 500, 550] }],
  ['tandembox', 'Blum Tandembox / Antaro', { type: 'msys', bottomRed: 75, backRed: 87, sideH: 83, lenRed: 10, lens: BLUM_LENS }],
  ['legrabox', 'Blum Legrabox', { type: 'msys', bottomRed: 35, backRed: 38, sideH: 90, lenRed: 10, lens: BLUM_LENS }],
  ['innotech', 'Hettich InnoTech Atira', { type: 'msys', bottomRed: 75, backRed: 87, sideH: 70, lenRed: 10, lens: [270, 300, 350, 400, 420, 450, 470, 500, 520, 550, 600] }],
  ['dtc', 'DTC Modern Box', { type: 'msys', bottomRed: 75, backRed: 87, sideH: 84, lenRed: 10, lens: [270, 300, 350, 400, 450, 500, 550] }],
]
/** длина направляющих из ряда системы: want — желаемая (null — самая длинная, что помещается), avail — свободная глубина */
export function slideLength(lens, want, avail) {
  const fit = (lens || BALL_LENS).filter(l => l <= avail)
  if (!fit.length) return { len: Math.min(...(lens || BALL_LENS)), tooDeep: true }
  if (want == null || want === '' || !Number.isFinite(Number(want))) return { len: fit[fit.length - 1] }
  const below = fit.filter(l => l <= Number(want))
  const len = below.length ? below[below.length - 1] : fit[0]
  return { len, snapped: len !== Number(want) }
}
export const drawerSystem = id => (DRAWER_SYSTEMS.find(s => s[0] === id) || DRAWER_SYSTEMS[0])
/**
 * задать высоту ящика i (снизу вверх) = v. cur — текущие высоты, pinned — заданные (null — авто).
 * pull: 'all' — остаток делят все незаданные; 'up' — меняются только ящики выше (нижние фиксируются как есть);
 * 'down' — только ниже (верхние фиксируются). v = null — ящик снова «авто».
 */
export function drawerSetHeight(cur, pinned, i, v, pull = 'all') {
  const n = cur.length
  const arr = Array.from({ length: n }, (_, k) => pinned?.[k] ?? null)
  if (pull === 'up' || pull === 'down') {
    for (let k = 0; k < n; k++) {
      if (k === i) continue
      const keep = pull === 'up' ? k < i : k > i
      arr[k] = keep ? Math.round(cur[k] * 10) / 10 : null
    }
  }
  arr[i] = v
  return arr
}
/** высоты фасадов ящиков блока (снизу вверх): hs[i] — заданная высота или null (авто — поровну из остатка) */
export function drawerHeights(total, n, g, hs = []) {
  const avail = total - (n - 1) * g
  const set = Array.from({ length: n }, (_, i) => (hs?.[i] != null && hs[i] !== '' && Number.isFinite(Number(hs[i])) ? Number(hs[i]) : null))
  const fixed = set.reduce((a, v) => a + (v ?? 0), 0)
  const autos = set.filter(v => v == null).length
  if (!autos) { set[n - 1] = null; return drawerHeights(total, n, g, set) }   // все заданы — верхний берёт остаток
  const auto = (avail - fixed) / autos
  return set.map(v => (v ?? auto))
}

export const CAB_KINDS = [['wardrobe', 'Шкаф'], ['base', 'Кухня: нижний'], ['wall', 'Кухня: верхний'], ['shelf', 'Стеллаж'], ['dresser', 'Комод'], ['other', 'Другое']]
// какие параметры переносятся «на все корпуса этого типа» — по группам
export const CAB_GROUPS = {
  body: ['material', 't', 'top', 'bottom', 'base', 'legH', 'plinthH', 'plinthInset', 'plinthBack', 'plinthBackOffset', 'railDepth', 'overhangFront', 'overhangSide', 'overhangL', 'overhangR', 'topRL', 'topRR', 'underTop', 'edgeFront', 'edgeBody',
    'sideL', 'sideR', 'sideFront', 'sideBack', 'topRails', 'topRailOffset', 'topDown', 'topFront', 'topBack', 'bottomRails', 'bottomRailOffset', 'bottomRailDepth', 'bottomUp', 'bottomFront', 'bottomBack'],
  back: ['back', 'backT', 'backMaterial', 'grooveOffset', 'grooveDepth', 'grooveWidth', 'backGapL', 'backGapR', 'backGapB', 'backGapT'],
  fronts: ['facadeMaterial', 'facadeT', 'facadeStyle', 'gap', 'frontMode', 'frontOffset', 'soloOverlap', 'edgeFacade', 'hingeCup', 'hingeEnd', 'plateFront', 'plateType', 'hingeCount', 'handleDoor', 'handleDrawer'],
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

/** сколько панелей в делении проёма (n >= 1): лишние проёмы убираются с конца, новые — пустые; размеры — снова «авто» */
export function opCount(tree, id, n) {
  return opPatch(tree, id, nd => {
    const k = Math.max(1, Math.min(20, Math.round(num(n, 1))))
    if (!nd.split) return
    if (k + 1 > nd.children.length) while (nd.children.length < k + 1) nd.children.push(newNode())
    else nd.children = nd.children.slice(0, k + 1)
    nd.children.forEach(c => { c.size = null })
  })
}
/** убрать одну панель деления: панель после проёма childId — два соседних проёма сливаются (остаётся содержимое левого / нижнего) */
export function opRemovePanel(tree, id, childId) {
  return opPatch(tree, id, n => {
    const ch = n.children || [], i = ch.findIndex(c => c.id === childId)
    if (i < 0 || i >= ch.length - 1) return
    if (n.pan) delete n.pan[childId]
    if (ch.length <= 2) { const keep = ch[0]; n.split = null; n.children = []; if (keep && !n.front && keep.front) n.front = keep.front; return }
    ch.splice(i + 1, 1); ch[i].size = null
  })
}
/**
 * заменить блок проёма другим: 'h' / 'v' — горизонтальные / вертикальные панели (count штук), 'drawers' — ящики (count),
 * 'doors' — двери (count), null — убрать. Отступы деления сохраняются при замене h <-> v.
 */
export function opReplace(tree, id, what, count = 1) {
  const t = clone(tree), r = findNode(t, id)
  if (!r) return t
  const n = r.node, k = Math.max(1, Math.round(num(count, 1)))
  const unsplit = () => { n.split = null; n.children = []; delete n.pan }
  if (what === 'h' || what === 'v') {
    if (n.split && n.split !== what) { n.split = what; n.children.forEach(c => { c.size = null }); delete n.pan; return t }
    if (!n.split) { n.split = what; n.children = Array.from({ length: k + 1 }, () => newNode()) }
    if (n.front?.type === 'drawers') n.front = null
    return t
  }
  if (what === 'drawers') { unsplit(); n.front = { type: 'drawers', n: k }; return t }
  if (what === 'doors') { n.front = { type: 'doors', n: k, hinge: k === 1 ? 'left' : 'auto', layout: 'v', open: 'left' }; return t }
  if (what === 'fpanel-off') { n.fpanel = null; return t }
  if (what === 'front-off') { n.front = null; return t }
  unsplit()
  return t
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

// горизонтальная деталь (длина вдоль X) со скруглёнными передними углами: rl — слева, rr — справа (0 — без скругления).
// Перед детали в редакторе контура: tSign > 0 — сторона x = W, иначе x = 0; кромка на дуге — edgeR вершины
export function roundShape(box, tSign, rl, rr, edge) {
  const Wd = box[5] - box[2], L = box[3] - box[0]
  const v = [{ x: 0, y: 0, r: 0 }, { x: Wd, y: 0, r: 0 }, { x: Wd, y: L, r: 0 }, { x: 0, y: L, r: 0 }]
  const fl = tSign > 0 ? 1 : 0, fr = tSign > 0 ? 2 : 3
  const lim = x => Math.max(0, Math.min(x, Wd - 1, (rl > 0 && rr > 0 ? L / 2 : L) - 1))
  if (rl > 0) { v[fl].r = lim(rl); if (edge) v[fl].edgeR = edge }
  if (rr > 0) { v[fr].r = lim(rr); if (edge) v[fr].edgeR = edge }
  return v
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
  // нет боковины — торцы крышки, дна, царг, полок с этой стороны на виду: кромка как спереди
  const ends = { ...(hasL ? {} : { '-x': eF }), ...(hasR ? {} : { '+x': eF }) }
  const frontEnds = { ...front, ...ends }

  // царги (планки): 1 — передняя, 2 — передняя и задняя; лежат плашмя между боковинами с отступом от верха / низа
  const rails = (pos, y0, count, depth, key, name, sign) => {
    const rd = Math.min(num(depth, 100), (D - zb) / 2)
    parts.push(mk(key + 'F', name + ' передняя', 'каркас', [xi0, y0, D - rd, xi1, y0 + t, D], 1, sign, 0, mat, { edges: frontEnds }))
    if (num(count, 2) >= 2) parts.push(mk(key + 'B', name + ' задняя', 'каркас', [xi0, y0, zb, xi1, y0 + t, zb + rd], 1, sign, 0, mat, { edges: ends }))
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
    parts.push(mk('bottom', 'Дно', 'каркас', [xi0, y, zb + num(p.bottomBack, 0), xi1, y + t, D - num(p.bottomFront, 0)], 1, +1, 0, mat, { edges: frontEnds }))
    yi0 = y + t
  }

  // ── крышка: вкладная (с отступами сверху / спереди / сзади), накладная (свесы), царги или нет ──
  let yi1 = H
  const tree = treeOf(p)
  const hasFronts = anyFront(tree)
  const fT0 = num(p.facadeT, 16)
  if (topOver) {
    // накладная крышка: свес в стороны и вперёд (козырёк) — вперёд считается от фасадов, если фасады под крышкой
    // свес слева и справа — отдельно (по умолчанию — «в стороны»); передние углы можно скруглить радиусом
    const oL = num(p.overhangL ?? p.overhangSide, 0), oR = num(p.overhangR ?? p.overhangSide, 0)
    const zf = D + (hasFronts && p.underTop !== false ? fT0 : 0) + num(p.overhangFront, 0)
    const box = [-oL, H - t, zb, W + oR, H, Math.max(D, zf)]
    const rl = num(p.topRL, 0), rr = num(p.topRR, 0)
    parts.push(mk('top', 'Крышка', 'каркас', box, 1, -1, 0, mat, { edges: { '+z': eF, '-x': eF, '+x': eF }, ...(rl > 0 || rr > 0 ? { shape: roundShape(box, -1, rl, rr, eF) } : {}) }))
    yi1 = H - t
  } else if (p.top === 'inset') {
    const y = H - t - num(p.topDown, 0)
    parts.push(mk('top', 'Крышка', 'каркас', [xi0, y, zb + num(p.topBack, 0), xi1, y + t, D - num(p.topFront, 0)], 1, -1, 0, mat, { edges: frontEnds }))
    yi1 = y
  } else if (p.top === 'rails') {
    const y = H - t - num(p.topRailOffset, 0)
    rails('t', y, p.topRails, p.railDepth, 'rail', 'Царга', -1)
    yi1 = y
  }

  // ── задняя стенка ──
  // нет боковины, но есть вертикальная панель корпуса — задняя стенка идёт до крайней вертикальной панели;
  // эта панель тогда идёт на всю глубину, как боковина (и получает паз, если стенка в паз)
  const rootDiv = []
  if (tree.split === 'v' && tree.children?.length > 1) {
    const sz = childSizes(tree, xi1 - xi0, t)
    let pos = xi0
    for (let i = 0; i < sz.length - 1; i++) { pos += sz[i]; rootDiv.push(pos); pos += t }
  }
  const divL = !hasL && rootDiv.length ? rootDiv[0] : null
  const divR = !hasR && rootDiv.length ? rootDiv[rootDiv.length - 1] : null
  // отступ крайней панели от зада корпуса — своя настройка панели (pan[id].setB), иначе как у боковин
  const rootCh = tree.split === 'v' ? tree.children || [] : []
  const panSet = c => (c && tree.pan?.[c.id]) || {}
  const endBL = divL != null ? num(panSet(rootCh[0]).setB ?? sB) : 0
  const endBR = divR != null ? num(panSet(rootCh[rootCh.length - 2]).setB ?? sB) : 0
  const go = num(p.grooveOffset, 16), gd = num(p.grooveDepth, 8), gw = num(p.grooveWidth, backT + 1)
  // задняя стенка в паз, а крайняя панель отступлена от зада дальше паза — стенка проходит за панелью и закрывает её торец (внахлёст)
  const lapL = p.back === 'groove' && divL != null && endBL >= go + gw - 0.01
  const lapR = p.back === 'groove' && divR != null && endBR >= go + gw - 0.01
  const endDivs = new Map()   // x левой грани крайней панели -> { side: на какой стороне у неё задняя стенка '+x' / '-x', lap, setB }
  if (divL != null) endDivs.set(r1(divL), { side: '+x', lap: lapL, setB: endBL })
  if (divR != null) endDivs.set(r1(divR), { side: '-x', lap: lapR, setB: endBR })
  // зазоры задней стенки по 4 сторонам (в пазу — чтобы стенка входила свободно; накладная — от краёв)
  const gL = num(p.backGapL, 1), gR = num(p.backGapR, 1), gB = num(p.backGapB, 1), gT = num(p.backGapT, 1)
  let zi0 = zb
  let backGroove = null
  if (p.back === 'overlay') {
    const by0 = Math.min(sideY0, yb)
    const bx0 = hasL ? gL : divL != null ? divL + gL : gL, bx1 = hasR ? W - gR : divR != null ? divR + t - gR : W - gR
    parts.push(mk('back', 'Задняя стенка', 'задняя', [bx0, by0 + gB, 0, bx1, H - gT, backT], 2, +1, 1, p.backMaterial || 'ХДФ', { t: backT }))
    zi0 = backT
  } else if (p.back === 'groove') {
    const z0 = go + (gw - backT) / 2
    const topHas = p.top === 'inset' || topOver
    const botHas = p.bottom === 'inset' || p.bottom === 'overlay' || p.bottom == null
    const y1 = topHas ? yi1 + gd - gT : H - gT
    const y0 = botHas ? yi0 - gd + gB : Math.min(sideY0, yb) + gB
    const bx0 = hasL ? xi0 - gd + gL : divL != null ? (lapL ? divL + gL : divL + t - gd + gL) : gL
    const bx1 = hasR ? xi1 + gd - gR : divR != null ? (lapR ? divR + t - gR : divR + gd - gR) : W - gR
    parts.push(mk('back', 'Задняя стенка', 'задняя', [bx0, y0, z0, bx1, y1, z0 + backT], 2, +1, 1, p.backMaterial || 'ХДФ', { t: backT }))
    backGroove = { from: '-z', offset: go, width: gw, depth: gd, along: 'L' }
    const g = { from: '-z', offset: go, width: gw, depth: gd, along: 'L' }
    for (const pr of parts) if (['sideL', 'sideR', ...(botHas ? ['bottom'] : []), ...(topHas ? ['top'] : [])].includes(pr.key)) pr.grooves.push({ ...g })
    if (go + gw > D - 50) warn.push('Паз под заднюю стенку слишком далеко от заднего торца')
    zi0 = z0 + backT
  } else if (p.back === 'inset') {
    parts.push(mk('back', 'Задняя стенка', 'задняя', [hasL || divL == null ? xi0 : divL + t, yi0, zb, hasR || divR == null ? xi1 : divR, yi1, zb + t], 2, +1, 1, mat))
    zi0 = zb + t
  }

  // ── опора ──
  if (plinth) {
    const ph = num(p.plinthH, 80), pi = num(p.plinthInset, 50)
    const px0 = bottomInset ? xi0 : 0, px1 = bottomInset ? xi1 : W
    parts.push(mk('plinthF', 'Цоколь передний', 'цоколь', [px0, 0, D - pi - t, px1, ph, D - pi], 2, -1, 0, mat, { edges: { '+z': eB } }))
    // задняя царга цоколя — по галочке, с отступом от зада (накладное дно — по умолчанию есть)
    if (p.plinthBack ?? !bottomInset) {
      const bo = num(p.plinthBackOffset, 20)
      parts.push(mk('plinthB', 'Цоколь задний', 'цоколь', [px0, 0, zb + bo, px1, ph, zb + bo + t], 2, +1, 0, mat))
    }
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
  // zs..ze — глубина проёма: фронтальная панель у зада (или у переда) сужает её для всего, что внутри проёма
  const walk = (node, x0, x1, y0, y1, depth, zs = zi0, ze = D) => {
    if (x1 - x0 < 50 || y1 - y0 < 30) warn.push(`Проём ${r1(x1 - x0)}×${r1(y1 - y0)} — слишком маленький`)
    if (node.front) fronts.push({ node, x0, x1, y0, y1 })
    // фронтальная панель в проёме: параллельно фасаду, по глубине — от зада или от переда проёма, с отступами от сторон проёма
    if (node.fpanel) {
      const f = node.fpanel, d = num(f.dist, 0), blk = { n: node.id, t: 'fpanel' }
      const fz0 = f.from === 'front' ? ze - d - t : zs + d
      const fL = !hasL && Math.abs(x0 - xi0) < 0.05, fR = !hasR && Math.abs(x1 - xi1) < 0.05
      parts.push(mk('fp_' + node.id, 'Фронтальная панель', 'наполнение',
        [x0 + num(f.l, 0), y0 + num(f.b, 0), fz0, x1 - num(f.r, 0), y1 - num(f.t, 0), fz0 + t], 2, f.from === 'front' ? -1 : +1, 1, mat,
        { edges: { ...(fL ? { '-x': eF } : {}), ...(fR ? { '+x': eF } : {}) }, blk }))
      if (fz0 < zs - 0.05 || fz0 + t > ze + 0.05) warn.push('Фронтальная панель выходит за глубину проёма')
      if (f.from === 'front') ze = fz0; else zs = fz0 + t
    }
    openings.push({ id: node.id, box: [x0, y0, zs, x1, y1, ze].map(r1), w: r1(x1 - x0), h: r1(y1 - y0), leaf: !(node.split && node.children?.length), depth })
    // штанга: труба между стенками проёма, ось ниже верха проёма на top, по глубине — посередине (или от переда на front)
    if (node.rod) {
      const rd = node.rod, d = num(rd.d, 25), yc = y1 - num(rd.top, 60), zc = rd.front != null && rd.front !== '' ? ze - num(rd.front) : (zs + ze) / 2
      const blk = { n: node.id, t: 'rod' }
      parts.push({ ...mk('rod_' + node.id, 'Штанга', 'наполнение', [x0 + 1, yc - d / 2, zc - d / 2, x1 - 1, yc + d / 2, zc + d / 2], 2, +1, 0, rd.material || `Труба Ø${d} хром`), kind: 'profile', section: `Ø${d}`, len: r1(x1 - x0 - 2), blk })
      for (const [x, n] of [[x0, '-x'], [x1, '+x']]) {
        parts.push({ ...mk('rodh_' + node.id + n, 'Штангодержатель', 'фурнитура', [n === '-x' ? x : x - 6, yc - 22, zc - 22, n === '-x' ? x + 6 : x, yc + 22, zc + 22], 0, +1, 1, 'Фурнитура металл'), kind: 'hw', vis: true, blk })
        for (const dz of [-14, 14]) holes.push({ p: [x, yc + 8, zc + dz], n, d: 4, depth: 12, note: 'Штангодержатель' })
      }
      hw.push({ name: `Штанга Ø${d}`, qty: 1 }, { name: 'Штангодержатель', qty: 2 })
      if (yc - d < y0) warn.push('Штанга ниже проёма — уменьшите отступ от верха')
    }
    const ch = node.children || []
    if (!node.split || !ch.length) return
    const sizes = childSizes(node, node.split === 'v' ? x1 - x0 : y1 - y0, t)
    if (sizes.some(v => v < 0)) warn.push('Проёмы не помещаются — уменьшите заданные размеры проёмов')
    let pos = node.split === 'v' ? x0 : y0
    // свободная сторона проёма (там нет боковины) — у полок можно скруглить передний угол с этой стороны
    const freeL = !hasL && Math.abs(x0 - xi0) < 0.05, freeR = !hasR && Math.abs(x1 - xi1) < 0.05
    ch.forEach((c, i) => {
      const a = pos, b = pos + sizes[i]
      if (node.split === 'v') walk(c, a, b, y0, y1, depth + 1, zs, ze)
      else walk(c, x0, x1, a, b, depth + 1, zs, ze)
      if (i < ch.length - 1) {
        // отступы панелей этого деления спереди и сзади (короче по глубине); у отдельной панели — свои (pan[id])
        const pan = node.pan?.[c.id] || {}
        const blk = { n: node.id, t: 'split', c: c.id }
        const setF = pan.setF != null ? num(pan.setF) : node.setFront != null ? num(node.setFront) : null
        const setB = num(pan.setB ?? node.setBack, 0)
        const end = depth === 0 && node === tree ? endDivs.get(r1(b)) : null
        if (node.split === 'v') {
          // отступы вертикальных панелей снизу и сверху (короче по высоте) — торец на виду, с кромкой
          const sBot = num(node.setBot, 0), sTop = num(node.setTop, 0)
          const ed = { ...front, ...(sBot > 0 ? { '-y': eF } : {}), ...(sTop > 0 ? { '+y': eF } : {}) }
          if (end) {
            // крайняя вертикальная панель вместо боковины: на всю глубину, как боковина; паз под заднюю стенку — со стороны стенки
            // (панель отступлена от зада дальше паза — стенка закрывает её торец внахлёст, паза нет)
            const rec = mk('st_' + c.id, 'Вертикальная панель', 'наполнение', [b, y0 + sBot, zb + end.setB, b + t, y1 - sTop, D - (setF ?? sF)], 0, +1, 1, mat, { edges: ed, blk })
            if (backGroove && !end.lap) rec.grooves.push({ ...backGroove, face: end.side === '+x' ? 'front' : 'back' })
            parts.push(rec)
          } else parts.push(mk('st_' + c.id, 'Вертикальная панель', 'наполнение', [b, y0 + sBot, zs + setB, b + t, y1 - sTop, ze - (setF ?? 0)], 0, +1, 1, mat, { edges: ed, blk }))
        } else {
          const loose = (pan.type || node.shelfType) === 'loose', g = loose ? 1 : 0
          const sb = setF ?? (loose ? Math.max(shelfSetback, 2) : shelfSetback)
          // отступы слева и справа (минус — выступает за проём): торец со стороны отступа на виду
          const sl = num(node.setL, 0), sr = num(node.setR, 0)
          const box = [x0 + g + sl, b, zs + g + setB, x1 - g - sr, b + t, ze - sb]
          const oL = freeL || sl !== 0, oR = freeR || sr !== 0
          // открытый торец полки (со стороны без боковины или с отступом) — с кромкой, как перед
          const extra = { edges: { ...front, ...(oL ? { '-x': eF } : {}), ...(oR ? { '+x': eF } : {}) }, blk }
          // скруглённая полка: передние углы с открытой стороны; открытой стороны нет — оба передних угла
          if (node.shelfShape === 'round' && num(node.shelfR, 0) > 0) {
            const r = num(node.shelfR), rl = oL || !oR ? r : 0, rr = oR || !oL ? r : 0
            extra.shape = roundShape(box, +1, rl, rr, eF)
          }
          parts.push(mk('sh_' + c.id, loose ? 'Горизонтальная панель (съёмная)' : 'Горизонтальная панель', 'наполнение', box, 1, +1, 0, mat, extra))
          if (loose) {
            shelfLoose++
            const pf = num(p.pinFront, 37), yp = b - num(p.pinBelow, 8)
            for (const z of [ze - sb - pf, zs + g + setB + pf]) {
              if (!freeL && sl <= 0) holes.push({ p: [x0, yp, z], n: '-x', d: 5, depth: 12, note: 'Полкодержатель' })
              if (!freeR && sr <= 0) holes.push({ p: [x1, yp, z], n: '+x', d: 5, depth: 12, note: 'Полкодержатель' })
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
  const straight = p.plateType === 'straight'      // ответная планка петли: cross — крестообразная (по умолчанию), straight — прямая
  const bT = num(p.boxBottomT, 3), bMat = p.boxBottomMaterial || 'ХДФ'
  let hingesN = 0
  const MET = 'Фурнитура металл'
  // видимая фурнитура (петли, направляющие, ручки) — только для картинки и анимации, в раскрой не идёт.
  // model — как рисовать (CadView): type, L — ось длины, N — куда «наружу» (ось вылета / вглубь)
  const vis = (key, name, box, blk, anim, model) => parts.push({ ...mk(key, name, 'фурнитура', box, 1, +1, 0, MET), kind: 'hw', vis: true, blk, anim, ...(model ? { model } : {}) })
  // фрезеровка фасада: у блока своя (front.style), иначе — как в корпусе (facadeStyle)
  const millOf = fr => { const st = fr.style || p.facadeStyle || 'flat'; return st === 'flat' ? {} : { mill: { style: st } } }
  const hwCount = new Map()
  const addHw = name => hwCount.set(name, (hwCount.get(name) || 0) + 1)
  // ручка на фасаде [fx0..fx1]×[fy0..fy1] (фасад — z от D до D+fT); free — свободная сторона ('l' / 'r' / 't' / 'b').
  // Отверстия под ручку — от обратной пласти насквозь; как сверлить (насквозь / глухие с изнанки / с лица) — крепёж «Ручки»
  const putHandle = (fr, isDrawer, key, fkey, x0f, y0f, x1f, y1f, free, blk, anim) => {
    const h = { ...(isDrawer ? p.handleDrawer : p.handleDoor), ...(fr.handle || {}) }
    if (!h || h.on === false || h.type === 'none') return
    const type = HANDLE_TYPES.some(t => t[0] === h.type) ? h.type : 'rail'
    const dx = num(h.dx, 40), dy = num(h.dy, 40)
    const cx = (x0f + x1f) / 2, cy = (y0f + y1f) / 2, zf = D + fT
    if (type === 'edge' || type === 'edgeflat') {
      // торцевая: полка крепится к обратной пласти фасада у верхнего торца, тонкий профиль (2 мм) лежит в зазоре над фасадом,
      // у «с язычком» — язычок спускается на лицевую сторону фасада
      const len = Math.min(num(h.len, x1f - x0f), x1f - x0f)
      const a0 = cx - len / 2, a1 = cx + len / 2
      // у «с язычком» — козырёк выступает вперёд от лица фасада (proj, по умолчанию 20 мм) и загнут вниз: под него заводят пальцы
      const proj = type === 'edge' ? Math.max(2, num(h.proj, 20)) : 0
      vis(key + 'h', 'Ручка торцевая', [a0, y1f - 28, D - 2, a1, y1f + 2, zf + proj], blk, anim, { type, L: 'x', N: '+z' })
      for (const x of len > 120 ? [a0 + 25, a1 - 25] : [cx]) holes.push({ p: [x, y1f - 15, D], n: '+z', d: 3, depth: Math.min(10, fT - 4), note: 'Ручка торцевая', key: fkey })
      addHw(`Ручка торцевая ${r1(len)} мм`)
      return
    }
    let a = h.anchor || 'c'
    if (a.startsWith('free')) {
      const pos = { 't': 't', 'c': 'm', 'b': 'b' }[a.slice(5)] || 't'
      a = free === 'l' || free === 'r' ? pos + free : free + 'c'
    }
    if (a === 'c') a = 'mc'
    const knob = type === 'knob' || type === 'knobsq'
    const horiz = h.orient !== 'v'
    const cc = knob ? 0 : num(h.cc, 128)
    let pts
    if (horiz) {
      const y = a[0] === 't' ? y1f - dy : a[0] === 'b' ? y0f + dy : cy
      const xs = a[1] === 'l' ? [x0f + dx, x0f + dx + cc] : a[1] === 'r' ? [x1f - dx, x1f - dx - cc] : [cx - cc / 2, cx + cc / 2]
      pts = (cc ? xs : [xs[0] + (a[1] === 'c' ? cc / 2 : 0)]).map(x => [x, y])
    } else {
      const x = a[1] === 'l' ? x0f + dx : a[1] === 'r' ? x1f - dx : cx
      const ys = a[0] === 't' ? [y1f - dy, y1f - dy - cc] : a[0] === 'b' ? [y0f + dy, y0f + dy + cc] : [cy - cc / 2, cy + cc / 2]
      pts = (cc ? ys : [ys[0] + (a[0] === 'm' ? cc / 2 : 0)]).map(y => [x, y])
    }
    for (const [x, y] of pts) holes.push({ p: [x, y, D], n: '+z', d: 5, depth: fT, note: 'Ручка', key: fkey })
    const xs = pts.map(q => q[0]), ys = pts.map(q => q[1])
    const out = num(h.out, type === 'arch' ? 32 : 30), ext = type === 'rail' ? 20 : 12
    if (cc) vis(key + 'h', 'Ручка', horiz ? [Math.min(...xs) - ext, ys[0] - 7, zf, Math.max(...xs) + ext, ys[0] + 7, zf + out] : [xs[0] - 7, Math.min(...ys) - ext, zf, xs[0] + 7, Math.max(...ys) + ext, zf + out], blk, anim, { type, L: horiz ? 'x' : 'y', N: '+z', ext })
    else vis(key + 'h', 'Ручка-кнопка', [xs[0] - 15, ys[0] - 15, zf, xs[0] + 15, ys[0] + 15, zf + 28], blk, anim, { type, L: 'x', N: '+z' })
    if (pts.some(([x, y]) => x < x0f + 5 || x > x1f - 5 || y < y0f + 5 || y > y1f - 5)) warn.push('Ручка выходит за фасад — проверьте привязку и отступы')
    addHw(cc ? `${HANDLE_TYPES.find(t => t[0] === type)[1]} ${cc} мм` : HANDLE_TYPES.find(t => t[0] === type)[1])
  }
  fronts.forEach((F, fi) => {
    const { node, x0, x1, y0, y1 } = F
    cur = F
    const fx0 = x0 - extOf('l', x0), fx1 = x1 + extOf('r', x1), fy0 = y0 - extOf('b', y0), fy1 = y1 + extOf('t', y1)
    const fr = node.front
    const blk = { n: node.id, t: 'front' }
    const n = Math.max(1, Math.round(num(fr.n, 1)))
    if (fr.type === 'drawers') {
      // ящики блока: зазор между фасадами, высоты фасадов (заданные / авто), система, длина направляющих, отступы короба
      const g = num(fr.gap ?? gap, gap)
      const hs = drawerHeights(fy1 - fy0, n, g, fr.hs)
      if (hs.some(v => v < 60)) warn.push('Ящик получился ниже 60 мм — проверьте высоты ящиков')
      const avail = D - zi0 - 5
      let dy0 = fy0
      for (let i = 0; i < n; i++) {
        const fh = hs[i]
        // у каждого ящика могут быть свои настройки (fr.per[i], снизу вверх): система, направляющие, отступы короба;
        // чего нет у ящика — берётся у блока, затем у корпуса
        const per = fr.per?.[i] || {}
        const sysId = per.box || fr.box || p.box
        const sys = { ...drawerSystem(sysId)[2], ...((per.box && per.box !== fr.box) ? {} : (fr.sys || {})), ...(per.sys || {}) }
        // длина направляющих — только из ряда системы и чтобы помещалась по глубине
        const want = per.slideLen ?? fr.slideLen ?? p.slideLen
        const sl = slideLength(sys.lens, want === 'auto' ? null : want, avail)
        if (sl.tooDeep) warn.push(`Ящики: корпус мелкий — самые короткие направляющие (${sl.len} мм) не помещаются`)
        const bd = sl.len
        const bBot = num(per.boxBottom ?? fr.boxBottom, 15), bTop = num(per.boxTop ?? fr.boxTop ?? num(p.boxTopGap, 40) - 15, 25)
        const sg = sys.type === 'under' ? num(sys.side, 5) : num(per.slideGap ?? fr.slideGap ?? p.slideGap, 13)
        const k = `dr${fi}_${i}_`
        const p0 = parts.length
        const anim = { id: k, kind: 'slide', dir: [0, 0, 1], dist: r1(bd * 0.85) }
        parts.push(mk(k + 'f', 'Фасад ящика', 'фасад', [fx0, dy0, D, fx1, dy0 + fh, D + fT], 2, +1, 0, fMat, { edges: allE, t: fT, ...millOf(fr) }))
        putHandle(fr, true, k, k + 'f', fx0, dy0, fx1, dy0 + fh, 'r', blk, anim)
        const by0 = Math.max(dy0, y0) + bBot
        const bh = Math.max(60, Math.min(fh - bBot - bTop, y1 - by0 - 5))
        // короб: у скрытого монтажа — короче направляющей на lenRed (Blum Tandem: NL − 10)
        const zf = D - 2, z0 = zf - (sys.type === 'under' ? bd - num(sys.lenRed, 10) : bd)
        // направляющая по высоте короба: снизу с отступом (по умолчанию 3 мм от низа короба) или по центру короба
        // скрытый монтаж: шуруп в вертикальную стенку корпусной шины — она поднимается вдоль боковины корпуса в зазоре у ящика
        const ys = sys.type === 'under' ? by0 + 12 : fr.slidePos === 'center' ? by0 + bh / 2 : by0 + num(fr.slideOff, 3) + 22.5
        // крепление фасада к ящику: точки на обратной пласти фасада (саморезы изнутри — без присадки, или сверлить — крепёж «Фасад ящика»)
        const fixPts = []
        for (const z of [D - 37, D - 37 - 224, D - 37 - Math.max(256, bd - 64)].filter(z => z > zi0 + 10)) {
          holes.push({ p: [x0, ys, z], n: '-x', d: 4, depth: 10, note: 'Направляющая' })
          holes.push({ p: [x1, ys, z], n: '+x', d: 4, depth: 10, note: 'Направляющая' })
        }
        // направляющие: неподвижная часть — на стенке проёма, подвижная — едет с ящиком
        if (sys.type === 'ball') {
          for (const [a, s] of [[x0, 1], [x1, -1]]) {
            const xa = s > 0 ? a : a - 6, xb = s > 0 ? a + 6 : a
            vis(k + 'rf' + s, 'Направляющая', [xa, ys - 22.5, z0, xb, ys + 22.5, zf], null, null, { type: 'slideOuter', L: 'z', N: s > 0 ? '+x' : '-x' })
            vis(k + 'rm' + s, 'Направляющая', [s > 0 ? a + 6 : a - Math.min(12.5, sg), ys - 17, z0 + 4, s > 0 ? a + Math.min(12.5, sg) : a - 6, ys + 17, zf], blk, anim, { type: 'slideInner', L: 'z', N: s > 0 ? '+x' : '-x' })
          }
        } else if (sys.type === 'under') {
          for (const [a, s] of [[x0, 1], [x1, -1]]) {
            // как у Blum Tandem / Movento: короб из ЛДСП, дно поднято на 13 мм (bottomUp) — под ним спрятана направляющая.
            // Корпусная шина — Г-профиль: полка внизу под боковиной ящика, стенка вверх по боковине корпуса (в зазоре 5 мм),
            // через неё шурупы в корпус; выдвижная — П-профиль под дном у боковины ящика; спереди под дном — замок
            const rec = num(sys.bottomUp, 13), xi = s > 0 ? a + sg + t : a - sg - t
            vis(k + 'rf' + s, 'Направляющая скрытого монтажа', [s > 0 ? a : xi - 12, by0 - 6, z0 + 10, s > 0 ? xi + 12 : a, by0 + 22, zf - 4], null, null, { type: 'underOuter', L: 'z', N: s > 0 ? '+x' : '-x' })
            vis(k + 'rm' + s, 'Направляющая скрытого монтажа', [s > 0 ? xi - 1 : xi - 12, by0 + 0.5, z0 + 6, s > 0 ? xi + 12 : xi + 1, by0 + rec - 0.5, zf - 2], blk, anim, { type: 'underInner', L: 'z', N: s > 0 ? '+x' : '-x' })
            vis(k + 'lk' + s, 'Замок ящика', [s > 0 ? xi + 13 : xi - 55, by0 + 3, zf - 70, s > 0 ? xi + 55 : xi - 13, by0 + rec - 0.3, zf - 22], blk, anim, { type: 'clip', L: 'z', N: s > 0 ? '+x' : '-x' })
          }
        }
        if (sysId === 'metal') {
          const red = num(fr.sys?.reduce ?? p.metalReduce, 42)
          parts.push(mk(k + 'bot', 'Ящик: дно', 'ящик', [x0 + red / 2, by0, z0, x1 - red / 2, by0 + t, zf], 1, +1, 0, mat))
          parts.push(mk(k + 'back', 'Ящик: задняя', 'ящик', [x0 + red / 2, by0 + t, z0, x1 - red / 2, by0 + bh, z0 + t], 2, +1, 0, mat))
          for (const [a, s] of [[x0, 1], [x1, -1]]) vis(k + 'ms' + s, 'Металлобокс: боковина', [s > 0 ? a + 3 : a - red / 2, by0, z0, s > 0 ? a + red / 2 : a - 3, by0 + Math.min(bh, 150), zf], blk, anim, { type: 'mside', L: 'z', N: s > 0 ? '+x' : '-x', color: fr.sideColor || 'white' })
          for (const s of [1, -1]) { const xc = s > 0 ? x0 + red / 4 + 1.5 : x1 - red / 4 - 1.5; fixPts.push([xc, by0 + 25], [xc, by0 + Math.min(bh, 150) - 25]) }
          hw.push({ name: `Металлобокс ${bd} мм (боковины)`, qty: 1 })
        } else if (sys.type === 'msys') {
          const bR = num(sys.bottomRed, 75), kR = num(sys.backRed, 87), sh = num(sys.sideH, 83), lr = num(sys.lenRed, 10)
          const w = x1 - x0
          parts.push(mk(k + 'bot', 'Ящик: дно', 'ящик', [x0 + bR / 2, by0, zf - (bd - lr), x1 - bR / 2, by0 + t, zf], 1, +1, 0, mat, { edges: { '+z': eB } }))
          parts.push(mk(k + 'back', 'Ящик: задняя', 'ящик', [x0 + kR / 2, by0 + t, zf - (bd - lr), x1 - kR / 2, by0 + Math.max(t + 20, sh - 15), zf - (bd - lr) + t], 2, +1, 0, mat, { edges: { '+y': eB } }))
          for (const [a, s] of [[x0, 1], [x1, -1]]) vis(k + 'ms' + s, 'Боковина ящика (металл)', [s > 0 ? a + 3 : a - bR / 2 + 3, by0 - 5, z0, s > 0 ? a + bR / 2 - 3 : a - 3, by0 + sh, zf], blk, anim, { type: 'mside', L: 'z', N: s > 0 ? '+x' : '-x', color: fr.sideColor || 'white' })
          for (const s of [1, -1]) { const xc = s > 0 ? x0 + bR / 4 : x1 - bR / 4; fixPts.push([xc, by0 + 15], [xc, by0 + sh - 20]) }
          if (w - bR < 100) warn.push('Ящик слишком узкий для этой системы')
          hw.push({ name: `${drawerSystem(sysId)[1]} ${bd} мм, комплект`, qty: 1 })
        } else {
          const bxa = x0 + sg, bxb = x1 - sg
          const under = sys.type === 'under'
          const grooveBot = sysId === 'ldsp_groove'
          // скрытый монтаж: дно из ЛДСП короба между боковинами, поднято на rec; передняя стенка — над низом дна,
          // задняя стоит на дне (Blum: «дно до конца ящика, задняя короче»)
          const rec = under ? num(sys.bottomUp, 13) : 0
          const sy0 = grooveBot || under ? by0 : by0 + bT
          const bE = { '+y': eB }
          // фальшпанель (передняя стенка короба) — по галочке, по умолчанию есть; нет — боковины до фасада, фасад — передняя стенка короба
          const ffOn = fr.falseFront !== false
          const zs1 = ffOn ? zf : D
          parts.push(mk(k + 'sL', 'Ящик: боковина', 'ящик', [bxa, sy0, z0, bxa + t, sy0 + bh, zs1], 0, +1, 2, mat, { edges: bE }))
          parts.push(mk(k + 'sR', 'Ящик: боковина', 'ящик', [bxb - t, sy0, z0, bxb, sy0 + bh, zs1], 0, -1, 2, mat, { edges: bE }))
          if (ffOn) {
            parts.push(mk(k + 'ff', 'Ящик: передняя', 'ящик', [bxa + t, sy0 + rec, zf - t, bxb - t, sy0 + bh, zf], 2, -1, 0, mat, { edges: bE }))
            for (const x of [bxa + t + 40, bxb - t - 40]) for (const yy of [sy0 + bh * 0.3, sy0 + bh * 0.7]) fixPts.push([x, yy])
          } else for (const x of [bxa + t / 2, bxb - t / 2]) for (const yy of [sy0 + bh * 0.25, sy0 + bh * 0.75]) fixPts.push([x, yy])
          parts.push(mk(k + 'b', 'Ящик: задняя', 'ящик', [bxa + t, sy0 + (under ? rec + t : 0), z0, bxb - t, sy0 + bh, z0 + t], 2, +1, 0, mat, { edges: bE }))
          if (under) {
            parts.push(mk(k + 'bot', 'Ящик: дно', 'ящик', [bxa + t, sy0 + rec, z0, bxb - t, sy0 + rec + t, ffOn ? zf - t : D], 1, +1, 0, mat, { edges: { '-z': eB } }))
            // отверстия под задние крючки направляющих: в торце дна сзади, Ø6×10, 7 мм от боковины, 11 мм от низа дна
            for (const x of [bxa + t + 7, bxb - t - 7]) holes.push({ p: [x, sy0 + rec + 11, z0], n: '+z', d: 6, depth: 10, note: 'Крючок направляющей', key: k + 'bot' })
          } else if (grooveBot) {
            const go = 10, gd = 6, gw = bT + 1
            const yB = sy0 + go + (gw - bT) / 2
            parts.push(mk(k + 'bot', 'Ящик: дно', 'ящик', [bxa + t - gd + 1, yB, z0 + t - gd + 1, bxb - t + gd - 1, yB + bT, ffOn ? zf - t + gd - 1 : D + gd - 1], 1, +1, 0, bMat, { t: bT }))
            for (const pr of parts.filter(q => [k + 'sL', k + 'sR', k + 'ff', k + 'b'].includes(q.key))) pr.grooves.push({ from: '-y', offset: go, width: gw, depth: gd, along: 'L', note: 'Паз под дно ящика' })
            // без фальшпанели паз под дно — в самом фасаде (с обратной стороны), на той же высоте
            if (!ffOn) { const fp = parts.find(q => q.key === k + 'f'); fp.grooves.push({ from: '-y', offset: r1(sy0 + go - dy0), width: gw, depth: gd, along: 'L', face: 'back', note: 'Паз под дно ящика' }) }
          } else {
            parts.push(mk(k + 'bot', 'Ящик: дно', 'ящик', [bxa, by0, z0, bxb, by0 + bT, ffOn ? zf : D], 1, +1, 0, bMat, { t: bT }))
          }
          hw.push({ name: sys.type === 'under' ? `Направляющие скрытого монтажа ${bd} мм, пара` : `Направляющие ${bd} мм, пара`, qty: 1 })
        }
        for (const [x, yy] of fixPts) holes.push({ p: [x, yy, D], n: '+z', d: 5, depth: 10, note: 'Крепление фасада ящика', key: k + 'f' })
        for (const pr of parts.slice(p0)) { if (!pr.blk) pr.blk = blk; if (pr.anim === undefined) pr.anim = anim }
        for (const pr of parts.slice(p0)) if (pr.anim === null) delete pr.anim
        dy0 += fh + g
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
    const AN = 95 * Math.PI / 180
    for (let i = 0; i < n; i++) {
      const dx0 = lay === 'v' ? fx0 + i * (dw + gap) : fx0, dx1 = dx0 + dw
      const dy0 = lay === 'h' ? fy0 + i * (dh + gap) : fy0, dy1 = dy0 + dh
      const open = lay === 'v' && n > 1 ? (i < n / 2 ? 'left' : 'right') : (fr.open || (fr.hinge === 'right' ? 'right' : 'left'))
      const name = lay === 'v' && n > 1 ? (i === 0 ? 'Дверь левая' : i === n - 1 ? 'Дверь правая' : 'Дверь') : lay === 'h' && n > 1 ? (i === 0 ? 'Дверь нижняя' : i === n - 1 ? 'Дверь верхняя' : 'Дверь') : 'Дверь'
      const key = `door${fi}_${i}`
      // анимация: поворот вокруг оси петель у переднего края двери
      const anim = open === 'left' ? { id: key, kind: 'rot', p: [dx0, 0, D + fT], axis: [0, 1, 0], ang: -AN }
        : open === 'right' ? { id: key, kind: 'rot', p: [dx1, 0, D + fT], axis: [0, 1, 0], ang: AN }
          : open === 'up' ? { id: key, kind: 'rot', p: [0, dy1, D + fT], axis: [1, 0, 0], ang: -AN }
            : { id: key, kind: 'rot', p: [0, dy0, D + fT], axis: [1, 0, 0], ang: AN }
      parts.push(mk(key, name, 'фасад', [dx0, dy0, D, dx1, dy1, D + fT], 2, +1, 1, fMat, { edges: allE, t: fT, blk, anim, ...millOf(fr) }))
      putHandle(fr, false, key, key, dx0, dy0, dx1, dy1, { left: 'r', right: 'l', up: 'b', down: 't' }[open], blk, anim)
      let k
      if (open === 'left' || open === 'right') {
        const left = open === 'left'
        k = cnt(dh)
        const xc = left ? dx0 + hc : dx1 - hc
        along(dy0, dy1, k).forEach((y, j) => {
          holes.push({ p: [xc, y, D], n: '+z', d: 35, depth: 12, note: 'Петля (чашка)', key })
          for (const d of [-22.5, 22.5]) holes.push({ p: [left ? xc + 9.5 : xc - 9.5, y + d, D], n: '+z', d: 8, depth: 11.5, note: 'Петля (крепёж чашки)', key })
          vis(`${key}c${j}`, 'Петля', [xc - 24, y - 24, D - 4, xc + 24, y + 24, D + 11.5], blk, anim, { type: 'cup', L: 'x', N: '+z', side: left ? '-x' : '+x' })
          // планка — на стенке проёма со стороны петель (боковина или вертикальная панель); у средних дверей при n > 2 — нет стенки
          const wall = left ? (lay === 'h' || i === 0) : (lay === 'h' || i === n - 1)
          if (wall) {
            const wx = left ? x0 : x1
            const nw = left ? '-x' : '+x', N = left ? '+x' : '-x', a0 = left ? wx : wx - 4, a1 = left ? wx + 4 : wx
            // ответная планка: крестообразная (2 отв. по вертикали ±16 на линии pf) или прямая (2 отв. по глубине: pf и pf + 32)
            if (straight) {
              for (const z of [D - pf, D - pf - 32]) holes.push({ p: [wx, y, z], n: nw, d: 5, depth: 12, note: 'Планка петли' })
              vis(`${key}p${j}`, 'Петля: планка', [a0, y - 9, D - pf - 46, a1, y + 9, D - pf + 14], blk, null, { type: 'plate', L: 'z', N })
            } else {
              for (const d of [-16, 16]) holes.push({ p: [wx, y + d, D - pf], n: nw, d: 5, depth: 12, note: 'Планка петли' })
              vis(`${key}p${j}`, 'Петля: планка', [a0, y - 25, D - pf - 17, a1, y + 25, D - pf + 17], blk, null, { type: 'plateCross', L: 'y', N })
            }
            // плечо петли — на планке, неподвижно (двигаются дверь и чашка)
            vis(`${key}a${j}`, 'Петля: плечо', left ? [wx + 4, y - 8, D - pf - 20, Math.max(wx + 20, xc - 6), y + 8, D - 3] : [Math.min(wx - 20, xc + 6), y - 8, D - pf - 20, wx - 4, y + 8, D - 3], blk, null, { type: 'arm', L: 'z', N })
          }
        })
      } else {
        const up = open === 'up'
        k = cnt(dw)
        const yc = up ? dy1 - hc : dy0 + hc
        along(dx0, dx1, k).forEach((x, j) => {
          holes.push({ p: [x, yc, D], n: '+z', d: 35, depth: 12, note: 'Петля (чашка)', key })
          for (const d of [-22.5, 22.5]) holes.push({ p: [x + d, up ? yc - 9.5 : yc + 9.5, D], n: '+z', d: 8, depth: 11.5, note: 'Петля (крепёж чашки)', key })
          vis(`${key}c${j}`, 'Петля', [x - 24, yc - 24, D - 4, x + 24, yc + 24, D + 11.5], blk, anim, { type: 'cup', L: 'x', N: '+z' })
          const wall = up ? (lay === 'v' || i === n - 1) : (lay === 'v' || i === 0)
          if (wall) {
            const wy = up ? y1 : y0
            const nw = up ? '+y' : '-y', N = up ? '-y' : '+y', b0 = up ? wy - 4 : wy, b1 = up ? wy : wy + 4
            if (straight) {
              for (const z of [D - pf, D - pf - 32]) holes.push({ p: [x, wy, z], n: nw, d: 5, depth: 12, note: 'Планка петли' })
              vis(`${key}p${j}`, 'Петля: планка', [x - 9, b0, D - pf - 46, x + 9, b1, D - pf + 14], blk, null, { type: 'plate', L: 'z', N })
            } else {
              for (const d of [-16, 16]) holes.push({ p: [x + d, wy, D - pf], n: nw, d: 5, depth: 12, note: 'Планка петли' })
              vis(`${key}p${j}`, 'Петля: планка', [x - 25, b0, D - pf - 17, x + 25, b1, D - pf + 17], blk, null, { type: 'plateCross', L: 'x', N })
            }
            vis(`${key}a${j}`, 'Петля: плечо', up ? [x - 8, Math.min(wy - 20, yc + 6), D - pf - 20, x + 8, wy - 4, D - 3] : [x - 8, wy + 4, D - pf - 20, x + 8, Math.max(wy + 20, yc - 6), D - 3], blk, null, { type: 'arm', L: 'z', N })
          }
        })
      }
      hingesN += k
    }
  })
  for (const [name, qty] of hwCount) hw.push({ name, qty })
  for (const pr of parts) { if (pr.blk === null) delete pr.blk; if (pr.anim == null) delete pr.anim }
  if (hingesN) hw.push({ name: 'Петля накладная', qty: hingesN })

  // проверки
  for (const pr of parts) {
    const b = pr.box
    if (b[3] - b[0] <= 0 || b[4] - b[1] <= 0 || b[5] - b[2] <= 0) warn.push(`«${pr.name}»: размер получился нулевым или отрицательным — проверьте параметры`)
  }
  return { parts, hw, warn, holes, openings }
}
