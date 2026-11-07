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
}

export const CAB_PRESETS = [
  ['wardrobe', 'Шкаф распашной', {}],
  ['base', 'Тумба кухни (нижний модуль)', { W: 600, H: 820, D: 560, top: 'rails', base: 'legs', legH: 100, shelves: 1, doors: 2 }],
  ['wall', 'Навесной модуль', { W: 600, H: 720, D: 300, top: 'inset', base: 'none', shelves: 2, doors: 2 }],
  ['dresser', 'Комод с ящиками', { W: 800, H: 900, D: 450, top: 'overlay', base: 'plinth', fill: 'drawers', drawers: 4, doors: 0 }],
  ['shelf', 'Стеллаж открытый', { W: 800, H: 1800, D: 350, back: 'none', shelves: 4, doors: 0 }],
]

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d)
const r1 = v => Math.round(v * 10) / 10

function mk(key, name, role, box, tAxis, tSign, lAxis, material, extra = {}) {
  return { key, name, role, kind: 'sheet', box: box.map(r1), tAxis, tSign, lAxis, material, edges: {}, grooves: [], ...extra }
}

/** параметры корпуса -> { parts: [записи], hw: [{ name, qty }], warn: [] } */
export function cabinetParts(params) {
  const p = { ...CAB_DEFAULTS, ...(params || {}) }
  const W = num(p.W, 800), H = num(p.H, 2100), D = num(p.D, 560), t = num(p.t, 16)
  const mat = p.material || 'ЛДСП'
  const parts = [], hw = [], warn = []
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
  if (p.top === 'inset' || topOver) {
    const tx0 = topOver ? 0 : t, tx1 = topOver ? W : W - t
    parts.push(mk('top', 'Крышка', 'каркас', [tx0, H - t, zb, tx1, H, D], 1, -1, 0, mat, { edges: topOver ? { '+z': eF, '-x': eF, '+x': eF } : front }))
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

  // ── наполнение ──
  const drawerMode = p.fill === 'drawers'
  const nPart = drawerMode ? 0 : Math.max(0, Math.round(num(p.partitions, 0)))
  const secW = (xi1 - xi0 - nPart * t) / (nPart + 1)
  if (secW < 100) warn.push('Секции уже 100 мм — уменьшите число стоек')
  const sections = []
  for (let i = 0; i <= nPart; i++) {
    const sx0 = xi0 + i * (secW + t)
    sections.push([sx0, sx0 + secW])
    if (i < nPart) parts.push(mk('part' + i, 'Стойка', 'наполнение', [sx0 + secW, yi0, zi0, sx0 + secW + t, yi1, D], 0, +1, 1, mat, { edges: front }))
  }
  if (!drawerMode) {
    const k = Math.max(0, Math.round(num(p.shelves, 0)))
    const loose = p.shelfType === 'loose'
    const g = loose ? 1 : 0
    const setback = num(p.shelfSetback, loose ? 2 : 0)
    const step = (yi1 - yi0 - k * t) / (k + 1)
    sections.forEach(([sx0, sx1], si) => {
      for (let j = 0; j < k; j++) {
        const y0 = yi0 + (j + 1) * step + j * t
        parts.push(mk(`sh${si}_${j}`, loose ? 'Полка съёмная' : 'Полка', 'наполнение', [sx0 + g, y0, zi0 + g, sx1 - g, y0 + t, D - setback], 1, +1, 0, mat, { edges: front }))
      }
    })
    if (loose && k) hw.push({ name: 'Полкодержатель', qty: 4 * k * sections.length })
  }

  // ── фасады ──
  const gap = num(p.gap, 3), fT = num(p.facadeT, 16), fMat = p.facadeMaterial || mat
  const fy0 = plinth && bottomInset ? num(p.plinthH, 80) : Math.min(sideY0, yb)
  const allE = { all: p.edgeFacade }
  if (drawerMode) {
    const m = Math.max(1, Math.round(num(p.drawers, 3)))
    const fh = (H - fy0 - gap * m) / m
    const sg = num(p.slideGap, 13)
    const bd = Math.min(num(p.slideLen, 450), D - zi0 - 10)
    const bxa = xi0 + sg, bxb = xi1 - sg
    const bT = num(p.boxBottomT, 3), bMat = p.boxBottomMaterial || 'ХДФ'
    for (let i = 0; i < m; i++) {
      const y0 = fy0 + gap / 2 + i * (fh + gap)
      parts.push(mk('df' + i, 'Фасад ящика', 'фасад', [gap / 2, y0, D, W - gap / 2, y0 + fh, D + fT], 2, -1, 0, fMat, { edges: allE, t: fT }))
      // короб ящика: от низа проёма + 15 мм, высота = фасад − зазор сверху
      const by0 = Math.max(y0, yi0) + 15
      const bh = Math.max(60, fh - num(p.boxTopGap, 40))
      const zf = D - 2, z0 = zf - bd
      const k = 'dr' + i + '_'
      if (p.box === 'metal') {
        const red = num(p.metalReduce, 42)
        parts.push(mk(k + 'bot', 'Ящик: дно', 'ящик', [xi0 + red / 2, by0, z0, xi1 - red / 2, by0 + t, zf], 1, +1, 0, mat))
        parts.push(mk(k + 'back', 'Ящик: задняя', 'ящик', [xi0 + red / 2, by0 + t, z0, xi1 - red / 2, by0 + bh, z0 + t], 2, +1, 0, mat))
        hw.push({ name: `Металлобокс ${bd} мм (боковины)`, qty: 1 })
        continue
      }
      const grooveBot = p.box === 'ldsp_groove'
      const sy0 = grooveBot ? by0 : by0 + bT
      const bE = { '+y': eB }
      parts.push(mk(k + 'sL', 'Ящик: боковина', 'ящик', [bxa, sy0, z0, bxa + t, sy0 + bh, zf], 0, +1, 2, mat, { edges: bE }))
      parts.push(mk(k + 'sR', 'Ящик: боковина', 'ящик', [bxb - t, sy0, z0, bxb, sy0 + bh, zf], 0, -1, 2, mat, { edges: bE }))
      parts.push(mk(k + 'f', 'Ящик: передняя', 'ящик', [bxa + t, sy0, zf - t, bxb - t, sy0 + bh, zf], 2, -1, 0, mat, { edges: bE }))
      parts.push(mk(k + 'b', 'Ящик: задняя', 'ящик', [bxa + t, sy0, z0, bxb - t, sy0 + bh, z0 + t], 2, +1, 0, mat, { edges: bE }))
      if (grooveBot) {
        const go = 10, gd = 6, gw = bT + 1
        const yB = sy0 + go + (gw - bT) / 2
        parts.push(mk(k + 'bot', 'Ящик: дно', 'ящик', [bxa + t - gd + 1, yB, z0 + t - gd + 1, bxb - t + gd - 1, yB + bT, zf - t + gd - 1], 1, +1, 0, bMat, { t: bT }))
        for (const pr of parts.slice(-5, -1)) pr.grooves.push({ from: '-y', offset: go, width: gw, depth: gd, along: 'L' })
      } else {
        parts.push(mk(k + 'bot', 'Ящик: дно', 'ящик', [bxa, by0, z0, bxb, by0 + bT, zf], 1, +1, 0, bMat, { t: bT }))
      }
    }
    hw.push({ name: `Направляющие ${bd} мм, пара`, qty: m }, { name: 'Ручка', qty: m })
  } else {
    const n = Math.max(0, Math.round(num(p.doors, 0)))
    for (let i = 0; i < n; i++) {
      const x0 = (i * W) / n + gap / 2, x1 = ((i + 1) * W) / n - gap / 2
      parts.push(mk('door' + i, n > 1 ? (i === 0 ? 'Дверь левая' : i === n - 1 ? 'Дверь правая' : 'Дверь') : 'Дверь', 'фасад',
        [x0, fy0 + gap / 2, D, x1, H - gap / 2, D + fT], 2, -1, 1, fMat, { edges: allE, t: fT }))
    }
    if (n) {
      const dh = H - fy0
      const hinges = dh < 900 ? 2 : dh < 1600 ? 3 : dh < 2000 ? 4 : 5
      hw.push({ name: 'Петля накладная', qty: hinges * n }, { name: 'Ручка', qty: n })
    }
  }

  // проверки
  for (const pr of parts) {
    const b = pr.box
    if (b[3] - b[0] <= 0 || b[4] - b[1] <= 0 || b[5] - b[2] <= 0) warn.push(`«${pr.name}»: размер получился нулевым или отрицательным — проверьте параметры`)
  }
  return { parts, hw, warn }
}
