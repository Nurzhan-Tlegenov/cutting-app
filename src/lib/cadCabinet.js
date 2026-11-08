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
  bottom: 'inset',       // дно: inset — вкладное, overlay — накладное
  base: 'none',          // опора: none — стоит на дне/боковинах, legs — ножки, plinth — цоколь
  legH: 100, plinthH: 80, plinthInset: 50,
  back: 'groove',        // задняя стенка: groove — в паз, overlay — накладная, inset — вкладная (ЛДСП), none — нет
  backT: 3, backMaterial: 'ХДФ Белый 3',
  grooveOffset: 16, grooveDepth: 8, grooveWidth: 4,   // паз под заднюю стенку: от заднего торца до паза, глубина, ширина
  railDepth: 100,
  partitions: 0,         // вертикальные стойки — делят корпус на секции
  fill: 'shelves',       // наполнение: shelves — полки, drawers — ящики (комод)
  shelves: 2, shelfType: 'fixed', shelfSetback: 0,    // fixed — неподвижные, loose — съёмные (меньше на зазор)
  drawers: 3, box: 'ldsp_overlay', slideGap: 13, slideLen: 450, boxTopGap: 40, boxBottomT: 3, boxBottomMaterial: 'ХДФ Белый 3', metalReduce: 42,
  doors: 2, gap: 3, facadeT: 16, facadeMaterial: 'ЛДСП Белый 16',
  edgeBody: '0,4', edgeFront: '1', edgeFacade: '1',
  frontMode: 'full', frontOffset: 1.5,   // фасад на боковине/дне/крышке: full — перекрывает торец полностью с отступом, half — до середины торца
  underTop: true,                         // при накладной крышке фасады — под крышкой (крышка над фасадами), иначе перекрывают её торец
  overhangFront: 0, overhangSide: 0,      // свес (козырёк) накладной крышки: вперёд от фасадов и в стороны
  tree: null,                             // проёмы и наполнение (см. ниже); нет — строится из старых параметров (стойки, полки, двери, ящики)
  hingeCup: 22, hingeEnd: 100, plateFront: 37,   // петли: центр чашки от края двери, первая/последняя от торца двери, планка от переднего торца
  pinFront: 37, pinBelow: 8,                       // полкодержатели: от переднего/заднего торца полки, центр ниже полки
}

export const CAB_PRESETS = [
  ['wardrobe', 'Шкаф распашной', {}],
  ['base', 'Тумба кухни (нижний модуль)', { W: 600, H: 820, D: 560, top: 'rails', base: 'legs', legH: 100, shelves: 1, doors: 2 }],
  ['wall', 'Навесной модуль', { W: 600, H: 720, D: 300, top: 'inset', base: 'none', shelves: 2, doors: 2 }],
  ['dresser', 'Комод с ящиками', { W: 800, H: 900, D: 450, top: 'overlay', base: 'plinth', fill: 'drawers', drawers: 4, doors: 0 }],
  ['shelf', 'Стеллаж открытый', { W: 800, H: 1800, D: 350, back: 'none', shelves: 4, doors: 0 }],
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
  if (doors) root.front = { type: 'doors', n: doors, hinge: 'auto' }
  return root
}
export const treeOf = p => (p?.tree && typeof p.tree === 'object' ? p.tree : legacyTree({ ...CAB_DEFAULTS, ...(p || {}) }))
export function findNode(node, id, parent = null) {
  if (!node) return null
  if (node.id === id) return { node, parent }
  for (const c of node.children || []) { const r = findNode(c, id, node); if (r) return r }
  return null
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

  parts.push(mk('sideL', 'Боковина левая', 'каркас', [0, sideY0, zb, t, sideY1, D], 0, +1, 1, mat, { edges: front }))
  parts.push(mk('sideR', 'Боковина правая', 'каркас', [W - t, sideY0, zb, W, sideY1, D], 0, -1, 1, mat, { edges: front }))
  const bx0 = bottomInset ? t : 0, bx1 = bottomInset ? W - t : W
  parts.push(mk('bottom', 'Дно', 'каркас', [bx0, yb, zb, bx1, yb + t, D], 1, +1, 0, mat, { edges: front }))
  let yi1 = H
  const tree = treeOf(p)
  const hasFronts = anyFront(tree)
  const fT0 = num(p.facadeT, 16)
  if (p.top === 'inset' || topOver) {
    // накладная крышка: свес в стороны и вперёд (козырёк) — вперёд считается от фасадов, если фасады под крышкой
    const os = topOver ? num(p.overhangSide, 0) : 0
    const zf = topOver ? D + (hasFronts && p.underTop !== false ? fT0 : 0) + num(p.overhangFront, 0) : D
    const tx0 = topOver ? -os : t, tx1 = topOver ? W + os : W - t
    parts.push(mk('top', 'Крышка', 'каркас', [tx0, H - t, zb, tx1, H, topOver ? Math.max(D, zf) : D], 1, -1, 0, mat, { edges: topOver ? { '+z': eF, '-x': eF, '+x': eF } : front }))
    yi1 = H - t
  } else if (p.top === 'rails') {
    const rd = Math.min(num(p.railDepth, 100), (D - zb) / 2)
    parts.push(mk('railF', 'Царга передняя', 'каркас', [t, H - t, D - rd, W - t, H, D], 1, -1, 0, mat, { edges: front }))
    parts.push(mk('railB', 'Царга задняя', 'каркас', [t, H - t, zb, W - t, H, zb + rd], 1, -1, 0, mat))
    yi1 = H - t
  }
  const yi0 = yb + t
  const xi0 = t, xi1 = W - t

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
    const y1 = topHas ? yi1 + gd - 1 : H - 1
    parts.push(mk('back', 'Задняя стенка', 'задняя', [xi0 - gd + 1, yi0 - gd + 1, z0, xi1 + gd - 1, y1, z0 + backT], 2, +1, 1, p.backMaterial || 'ХДФ', { t: backT }))
    const g = { from: '-z', offset: go, width: gw, depth: gd, along: 'L' }
    for (const pr of parts) if (['sideL', 'sideR', 'bottom', ...(topHas ? ['top'] : [])].includes(pr.key)) pr.grooves.push({ ...g })
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
        if (node.split === 'v') parts.push(mk('st_' + c.id, 'Стойка', 'наполнение', [b, y0, zi0, b + t, y1, D], 0, +1, 1, mat, { edges: front }))
        else {
          const loose = node.shelfType === 'loose', g = loose ? 1 : 0
          const sb = loose ? Math.max(shelfSetback, 2) : shelfSetback
          parts.push(mk('sh_' + c.id, loose ? 'Полка съёмная' : 'Полка', 'наполнение', [x0 + g, b, zi0 + g, x1 - g, b + t, D - sb], 1, +1, 0, mat, { edges: front }))
          if (loose) {
            shelfLoose++
            const pf = num(p.pinFront, 37), yp = b - num(p.pinBelow, 8)
            for (const z of [D - sb - pf, zi0 + g + pf]) {
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
  const EPS = 0.05
  const extOf = (edge, v) => {
    if (edge === 'l') return Math.abs(v - xi0) < EPS ? outerExt : innerExt
    if (edge === 'r') return Math.abs(v - xi1) < EPS ? outerExt : innerExt
    if (edge === 'b') return Math.abs(v - yi0) < EPS ? outerExt : innerExt
    if (Math.abs(v - yi1) > EPS) return innerExt
    if (topOver && p.underTop !== false) return -gap / 2
    if (p.top === 'none') return -off
    return outerExt
  }
  const he = num(p.hingeEnd, 100), hc = num(p.hingeCup, 22), pf = num(p.plateFront, 37)
  const sg = num(p.slideGap, 13)
  const bT = num(p.boxBottomT, 3), bMat = p.boxBottomMaterial || 'ХДФ'
  let doorsN = 0, hingesN = 0, drawersN = 0
  fronts.forEach(({ node, x0, x1, y0, y1 }, fi) => {
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
    // двери: n по ширине; петли — у левой двери слева, у правой справа (одна дверь — сторона из настройки, по умолчанию слева)
    const dw = (fx1 - fx0 - (n - 1) * gap) / n
    const dh = fy1 - fy0
    const hinges = dh < 900 ? 2 : dh < 1600 ? 3 : dh < 2000 ? 4 : 5
    const hy = Array.from({ length: hinges }, (_, j) => fy0 + he + ((dh - 2 * he) * j) / (hinges - 1))
    for (let i = 0; i < n; i++) {
      const dx0 = fx0 + i * (dw + gap), dx1 = dx0 + dw
      const left = n === 1 ? fr.hinge !== 'right' : i < n / 2
      parts.push(mk(`door${fi}_${i}`, n > 1 ? (i === 0 ? 'Дверь левая' : i === n - 1 ? 'Дверь правая' : 'Дверь') : 'Дверь', 'фасад',
        [dx0, fy0, D, dx1, fy1, D + fT], 2, +1, 1, fMat, { edges: allE, t: fT }))
      const xc = left ? dx0 + hc : dx1 - hc
      for (const y of hy) {
        holes.push({ p: [xc, y, D], n: '+z', d: 35, depth: 12, note: 'Петля (чашка)' })
        // планка — на стенке проёма со стороны петель (боковина или стойка); у средних дверей при n > 2 — нет стенки
        if (left && i === 0) for (const dy of [-16, 16]) holes.push({ p: [x0, y + dy, D - pf], n: '-x', d: 5, depth: 12, note: 'Планка петли' })
        if (!left && i === n - 1) for (const dy of [-16, 16]) holes.push({ p: [x1, y + dy, D - pf], n: '+x', d: 5, depth: 12, note: 'Планка петли' })
      }
      doorsN++; hingesN += hinges
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
