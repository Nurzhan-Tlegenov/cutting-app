// β Пильный центр (KDT и подобные): раскрой только сквозными резами, по уровням.
//   1-й уровень — лист режется на полосы (по умолчанию полосы идут вдоль длинной стороны Y);
//   2-й — полоса поперёк на заготовки; 3-й — заготовка снова поперёк (поворот на 90°) … не глубже «уровней резов».
// Правила (все значения — из настроек производства, src/lib/beamSaw.js):
//   • полосу задаёт самая большая деталь, в неё добираются детали той же ширины или уже — «от большого к малому»;
//   • остаток для захвата: после любого реза кусок, который держат прижимы, — либо 0 (деталь ровно по заготовке),
//     либо не меньше порога (полоса 600 → деталь не больше 582, если 18 вместе с пропилом);
//   • торцовка в начале заготовки на уровнях 2, 3, …; 1-й уровень — обрезка листа (отступы);
//   • узкие детали пилятся с запасом (narrowCut) и помечаются «подрезать до …»;
//   • порядок полос: от большой к малой или «большая → малая к середине → большая у края».
// Результат — в том же формате, что у runNesting (листы с placed), поэтому карты, линии реза, PDF и бирки
// работают как у форматника. Дерево резов каждого листа — sheet.beamTree (для программы станка).
import { beamSettings, maxLevels, trimAt } from './beamSaw'

// версия алгоритма пильного центра — пишется в результат (beamVersion), меняется с каждой доработкой
export const BEAM_SAW_VERSION = 'β0.1'

const EPS = 0.5
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
const pause = () => new Promise(r => setTimeout(r, 0))

// ── детали ────────────────────────────────────────────────────────────────
// id `${индекс детали}_${номер}` — как в nesting.js: по нему карта находит детали заказа
function buildPieces(details, kerf, s) {
  const out = []
  details.forEach((d, di) => {
    const L0 = Number(d.length) || 0, W0 = Number(d.width) || 0
    // узкая деталь: сторона уже порога пилится шириной narrowCut, потом подрезается
    const nar = v => (s.narrowMin > 0 && v > 0 && v <= s.narrowMin && s.narrowCut > v ? s.narrowCut : v)
    const L = nar(L0), W = nar(W0)
    const trimTo = L !== L0 || W !== W0 ? { length: L0, width: W0 } : null
    for (let q = 0; q < (Number(d.qty) || 0); q++) {
      out.push({
        id: `${di}_${q}`, detailIndex: di,
        pw: W + kerf, ph: L + kerf, origX: W, origY: L,
        rotatable: !!d.rotatable,
        label: (d.display_name || d.name || '') + (trimTo ? ` ✂${trimTo.width !== W ? trimTo.width : trimTo.length}` : ''),
        prefix: d.prefix, trimTo,
        edgeTop: d.edge_top, edgeRight: d.edge_right, edgeBottom: d.edge_bottom, edgeLeft: d.edge_left,
      })
    }
  })
  return out
}

function toPlaced(p, x, y, rot, lvl) {
  return {
    id: p.id, detailIndex: p.detailIndex, label: p.label, prefix: p.prefix,
    x, y, w: rot ? p.ph : p.pw, h: rot ? p.pw : p.ph,
    origX: rot ? p.origY : p.origX, origY: rot ? p.origX : p.origY,
    rotated: rot, rotation: rot ? 90 : 0,
    isSmall: false, edgeOkMax: 0, edgeMin: 0, kf: 0,
    rotatable: p.rotatable,
    edgeTop: rot ? p.edgeLeft : p.edgeTop,
    edgeRight: rot ? p.edgeTop : p.edgeRight,
    edgeBottom: rot ? p.edgeRight : p.edgeBottom,
    edgeLeft: rot ? p.edgeBottom : p.edgeLeft,
    ...(p.trimTo ? { trimTo: p.trimTo } : {}),
    beamLevel: lvl,
  }
}

// ── укладка одной заготовки (региона) ──────────────────────────────────────
// Регион уровня L: заготовка A × B, режется резами поперёк оси укладки (axis): по оси axis длина A, поперёк — B.
// Слот — кусок толщиной a по оси axis на всю длину B. Деталь ровно по B — готова на этом уровне;
// короче — слот режется дальше (уровень L+1, ось меняется — поворот на 90°).
// Размеры — с пропилом (как в nesting.js): деталь pw = ширина + рез, заготовка = своя длина + рез.
function makeCtx(pieces, s, kerf, opts) {
  return {
    s, kerf, maxL: maxLevels(s),
    grip: s.grip + (s.gripWithKerf ? 0 : kerf),     // остаток с пропилом: 0 или не меньше этого
    used: new Set(), order: pieces, orient: opts.orient, rnd: opts.rnd || null,
    edge: opts.edge || { x: 0, y: 0 },               // обрезка листа у дальнего края по оси
  }
}
// Остаток в конце заготовки. На 1-м и 2-м уровнях заготовка доходит до края листа — остаток там вместе с обрезкой листа
// (кусок у прижимов = остаток + обрезка). С 3-го уровня заготовка кончается резом — только сам остаток.
const extraAt = (ctx, axis, L) => (L <= 2 ? ctx.edge[axis] : 0)
const remOk = (ctx, r, extra = 0) => r < EPS || r + extra >= ctx.grip - 1e-6

// варианты детали в регионе: { rot, a (по оси укладки), b (поперёк) }
function orients(p, axis) {
  const o = [{ rot: false, a: axis === 'x' ? p.pw : p.ph, b: axis === 'x' ? p.ph : p.pw }]
  if (p.rotatable && Math.abs(p.pw - p.ph) > EPS) o.push({ rot: true, a: axis === 'x' ? p.ph : p.pw, b: axis === 'x' ? p.pw : p.ph })
  return o
}

// Подходит ли деталь в слот региона: поместится, остаток после неё по оси — 0 или ≥ захвата,
// а если она короче B — нужен ещё уровень и в нём тоже соблюдается захват.
function fits(ctx, axis, o, freeA, B, L) {
  if (o.a > freeA + 1e-6 || o.b > B + 1e-6) return false
  if (!remOk(ctx, freeA - o.a, extraAt(ctx, axis, L))) return false
  if (B - o.b < EPS) return true
  if (L + 1 > ctx.maxL) return false
  const t = trimAt(ctx.s, L + 1), ax2 = axis === 'x' ? 'y' : 'x'
  return o.b + t <= B + 1e-6 && remOk(ctx, B - t - o.b, extraAt(ctx, ax2, L + 1))
}

// Выбор следующей детали: первая по приоритету, которая подходит. Ориентация: ровно по B — лучше всего;
// иначе по правилу варианта (длинной стороной вдоль полосы или плотнее по B).
function pick(ctx, axis, freeA, B, L, onlyExact = false) {
  for (const p of ctx.order) {
    if (ctx.used.has(p.id)) continue
    let best = null, bestK = Infinity
    for (const o of orients(p, axis)) {
      if (!fits(ctx, axis, o, freeA, B, L)) continue
      const exact = B - o.b < EPS
      if (onlyExact && !exact) continue
      const k = exact ? -1e9 : ctx.orient === 'long' && L === 1 ? -o.b : (B - o.b)
      if (k < bestK) { bestK = k; best = o }
    }
    if (best) return { p, ...best }
  }
  return null
}

// Укладка региона. first — деталь, с которой слот начат уровнем выше (она обязана встать первой).
function fillRegion(ctx, axis, A, B, L, first = null) {
  const t = trimAt(ctx.s, L)
  const node = { axis, A, B, level: L, trim: t, slots: [] }
  let used = t
  const take = c => {
    ctx.used.add(c.p.id)
    const exact = B - c.b < EPS
    const slot = { a: c.a, piece: exact ? { p: c.p, rot: c.rot } : null, child: null }
    if (!exact) slot.child = fillRegion(ctx, axis === 'x' ? 'y' : 'x', B, c.a, L + 1, { p: c.p, rot: c.rot, a: c.b, b: c.a })
    node.slots.push(slot)
    used += c.a
  }
  if (first) {
    // в дочернем регионе первая деталь: по оси укладки её длина first.a, поперёк — ровно толщина слота
    ctx.used.delete(first.p.id)
    const c = { p: first.p, rot: first.rot, a: first.a, b: first.b }
    ctx.used.add(c.p.id)
    node.slots.push({ a: c.a, piece: { p: c.p, rot: c.rot }, child: null })
    used += c.a
  }
  // сначала детали ровно по заготовке (та же ширина полосы — без лишнего реза), потом остальные по приоритету
  for (;;) {
    const c = pick(ctx, axis, A - used, B, L, true) || pick(ctx, axis, A - used, B, L)
    if (!c) break
    take(c)
  }
  node.used = used
  return node
}

// ── порядок слотов и координаты ────────────────────────────────────────────
function orderSlots(slots, mode) {
  const by = [...slots].sort((p, q) => q.a - p.a)
  if (mode !== 'wnw') return by
  // большая → малая к середине → большая у края: крупные по очереди к краям, мелкие сходятся в середину
  const left = [], right = []
  by.forEach((sl, i) => (i % 2 ? right : left).push(sl))
  return left.concat(right.reverse())
}

// Обход дерева: координаты деталей и линии/счёт резов. Порядок слотов меняется на 1-м и 2-м уровнях.
function layout(node, ox, oy, s, out) {
  if (node.level <= 2) node.slots = orderSlots(node.slots, s.stripOrder)
  let pos = node.trim
  if (node.trim > EPS) out.cuts++
  for (const sl of node.slots) {
    const x = node.axis === 'x' ? ox + pos : ox
    const y = node.axis === 'x' ? oy : oy + pos
    if (sl.piece) out.placed.push(toPlaced(sl.piece.p, x, y, sl.piece.rot, node.level))
    else layout(sl.child, x, y, s, out)
    pos += sl.a
    if (node.A - pos > EPS) out.cuts++      // рез после слота (последний по краю заготовки не нужен)
    out.maxLevel = Math.max(out.maxLevel, node.level)
  }
}

// Дерево для хранения: без ссылок на детали — только размеры и id
function plainTree(node) {
  return {
    axis: node.axis, len: +(node.A).toFixed(2), across: +(node.B).toFixed(2), level: node.level, trim: node.trim,
    slots: node.slots.map(sl => (sl.piece ? { a: +sl.a.toFixed(2), part: sl.piece.p.id, rot: sl.piece.rot } : { a: +sl.a.toFixed(2), child: plainTree(sl.child) })),
  }
}

// ── один полный проход: листы один за другим ───────────────────────────────
// axes — направления 1-го уровня, из которых выбирается для КАЖДОГО листа своё (в «Авто» — оба: как Asai,
// одни листы режутся вдоль, другие поперёк); берётся то, где на лист легло больше
const pieceArea = (ctx, ids) => { let a = 0; for (const p of ctx.order) if (ids.has(p.id)) a += p.pw * p.ph; return a }
function packAll(pieces, s, kerf, X, Y, axes, opts) {
  const ctx = makeCtx(pieces, s, kerf, { ...opts, edge: { x: Math.min(s.trimLeft, s.trimRight), y: Math.min(s.trimTop, s.trimBottom) } })
  const sheets = []
  let cuts = 0
  for (;;) {
    if (ctx.used.size >= pieces.length) break
    const before = ctx.used.size
    let root = null, axis = axes[0], bestUsed = null, bestA = -1
    for (const ax of axes) {
      const saved = new Set(ctx.used)
      const A = ax === 'x' ? X : Y, B = ax === 'x' ? Y : X
      const r = fillRegion(ctx, ax, A, B, 1)
      const got = new Set([...ctx.used].filter(id => !saved.has(id)))
      const area = pieceArea(ctx, got)
      if (area > bestA + 1) { bestA = area; root = r; axis = ax; bestUsed = ctx.used }
      ctx.used = saved
    }
    ctx.used = bestUsed
    if (ctx.used.size === before) break     // остальные детали не помещаются ни на какой лист
    const out = { placed: [], cuts: 0, maxLevel: 1 }
    layout(root, 0, 0, s, out)
    cuts += out.cuts
    sheets.push({ index: sheets.length, placed: out.placed, freeRects: [], family: 'guillotine', beamTree: plainTree(root), beamAxis: axis, beamCuts: out.cuts, beamLevels: out.maxLevel })
  }
  const unplaced = pieces.filter(p => !ctx.used.has(p.id)).map(p => p.id)
  return { sheets, cuts, unplaced }
}

const areaOf = sh => sh.placed.reduce((a, p) => a + p.w * p.h, 0)
// лучше: меньше листов → меньше занято на последнем листе (остаток крупнее) → меньше резов
function better(a, b) {
  if (!b) return true
  if (a.unplaced.length !== b.unplaced.length) return a.unplaced.length < b.unplaced.length
  if (a.sheets.length !== b.sheets.length) return a.sheets.length < b.sheets.length
  const la = areaOf(a.sheets[a.sheets.length - 1] || { placed: [] }), lb = areaOf(b.sheets[b.sheets.length - 1] || { placed: [] })
  if (Math.abs(la - lb) > 1) return la < lb
  return a.cuts < b.cuts
}

// порядки деталей: «от большого к малому» в нескольких смыслах + случайные возмущения
const SORTS = [
  (p, q) => Math.max(q.pw, q.ph) - Math.max(p.pw, p.ph) || q.pw * q.ph - p.pw * p.ph,
  (p, q) => q.pw * q.ph - p.pw * p.ph,
  (p, q) => Math.min(q.pw, q.ph) - Math.min(p.pw, p.ph) || Math.max(q.pw, q.ph) - Math.max(p.pw, p.ph),
  (p, q) => q.pw - p.pw || q.ph - p.ph,
  (p, q) => q.ph - p.ph || q.pw - p.pw,
]
function perturb(list, rnd, strength) {
  const a = list.slice()
  const n = Math.max(1, Math.round(a.length * strength))
  for (let k = 0; k < n; k++) {
    const i = Math.floor(rnd() * a.length), j = Math.min(a.length - 1, i + 1 + Math.floor(rnd() * 3))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}
function rng(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296 } }

/**
 * Раскрой под пильный центр. params — как у runNesting + beamSaw (сырые настройки производства).
 * Отступы листа = обрезка листа, рез = пропил из настроек.
 */
export async function runBeamSaw(params, { live = false, shouldStop = () => false, onProgress = null } = {}) {
  const s = beamSettings(params.beamSaw)
  const kerf = s.kerf
  const sheetL = Number(params.sheetL) || 0, sheetW = Number(params.sheetW) || 0
  const marginL = s.trimLeft, marginR = s.trimRight, marginT = s.trimTop, marginB = s.trimBottom
  const realX = sheetW - marginL - marginR, realY = sheetL - marginT - marginB
  const X = realX + kerf, Y = realY + kerf
  const pieces = buildPieces(params.details || [], kerf, s)
  const meta = { usableX: realX, usableY: realY, sheetL, sheetW, marginT, marginR, marginB, marginL, kerf, beamSaw: true, beamVersion: BEAM_SAW_VERSION, beamSettings: s }
  const finish = r => ({ ...meta, sheets: r.sheets, unplaced: r.unplaced, beamCuts: r.cuts })

  // направление полос: y — вдоль длинной стороны листа (1-й уровень режет по X), x — наоборот, auto — оба
  // (есть детали с текстурой — только вдоль волокон, Y)
  const axes = s.direction === 'x' ? ['y'] : s.direction === 'y' || pieces.some(p => !p.rotatable) ? ['x'] : ['x', 'y']
  const budget = (live ? 3600 : Math.max(1, Number(params.optimizeSeconds) || 5)) * 1000
  const t0 = now()
  let best = null, lastShow = 0, iter = 0
  const consider = r => {
    if (!better(r, best)) return
    best = r
    if (onProgress && now() - lastShow > 300) { lastShow = now(); onProgress({ ...finish(best), iter }) }
  }
  // детерминированные варианты, потом случайные возмущения лучших порядков — до лимита времени или «Стоп»
  const orders = []
  for (const srt of SORTS) orders.push(pieces.slice().sort(srt))
  const axisSets = axes.length > 1 ? [axes, ['x'], ['y']] : [axes]
  for (const ax of axisSets) for (const ord of orders) for (const orient of ['long', 'fit']) { iter++; consider(packAll(ord, s, kerf, X, Y, ax, { orient })) }
  const rnd = rng(pieces.length * 7919 + 17)
  let tick = now()
  while (now() - t0 < budget && !shouldStop()) {
    iter++
    const base = orders[Math.floor(rnd() * orders.length)]
    const ord = perturb(base, rnd, 0.02 + rnd() * 0.15)
    const ax = axisSets[Math.floor(rnd() * axisSets.length)]
    consider(packAll(ord, s, kerf, X, Y, ax, { orient: rnd() < 0.5 ? 'long' : 'fit' }))
    if (now() - tick > 40) { tick = now(); await pause() }
  }
  return finish(best)
}
