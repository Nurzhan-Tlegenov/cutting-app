// Онлайн-раскрой: поиск идёт, пока пользователь не нажмёт «Стоп», и каждое
// улучшение сразу уходит на экран (onProgress).
//
// Два пути:
//  • прямоугольные детали (основной алгоритм) — ОДИН непрерывный поиск:
//    генетический алгоритм работает без лимита времени, на «Стоп» выходит из
//    цикла и доводит лучший вариант до финала (интенсификация + стяжка);
//  • фигурные детали / NFP — там поиск внутри не умеет отдавать промежуточный
//    результат, поэтому идут раунды с растущим временем (3 → 6 → 10 → 15 → 20 → 30 с…),
//    на экран уходит результат раунда, если он лучше уже показанного.
//
// Обычный (не онлайн) режим тоже идёт через этот модуль: тот же поиск, но с
// лимитом времени из настроек, и промежуточные улучшения тоже видны.
import { runNesting, smallAtEdge, lastOffcutArea, repackLastForOffcut, sweepLast } from './nesting'
import { runBeamSaw } from './beamSawNesting'
import { readyOrderResult } from './readyOrder'
import { needsTrueShape, roughShapePolygons, placedRotation, buildHybridPlan } from './trueShapeNesting'
import { fillConcavities } from './fillConcavities'
import { gravityPolygons } from './gravity'
import { validateNesting } from './validateNesting'

const LIVE_BUDGET_SECONDS = 1e7 // «бесконечно» — до нажатия «Стоп»

// Черновик для фигурных деталей: раскладка по габаритам обычным прямоугольным
// раскроем без оптимизации (доли секунды), на экране — настоящие контуры
// внутри габаритов. Габариты не пересекаются и держат зазор реза — значит, и
// контуры тоже. Дальше точные раунды улучшают результат.
async function roughLayout(params) {
  try {
    const plain = params.details.map(d => ({ ...d, contour: null }))
    const res = await runNesting({ ...params, details: plain, optimizeSeconds: 0, algo: 'raster', cuttingMethod: 'nesting', probe: true,
      finishBudget: { maxMs: 100, composeMs: 0, relayout: 0 } })
    const polys = {}
    res.sheets.forEach(sh => sh.placed.forEach(p => {
      const d = params.details[p.detailIndex]
      if (!d?.contour) return
      if (!polys[p.detailIndex]) polys[p.detailIndex] = roughShapePolygons(d)
      // поворот — по фактическим размерам (флаг rotated не учитывает поворот при укладке «вдоль X/Y»)
      const rot = placedRotation(p, Number(d.width))
      const poly = polys[p.detailIndex][rot]
      if (!poly) return
      p.polygon = poly.map(([x, y]) => ({ x, y }))
      p.rotation = rot
    }))
    res.rough = true
    return res
  } catch { return null }
}
const ROUND_SECONDS = [3, 6, 10, 15, 20, 30]

// Вырезы фигурных деталей. Гибрид и черновик кладут одиночную фигурную деталь
// (Г-образная боковина с вырезом под цоколь) по габариту — вырез пустой.
// Дозаполняем его и другие пустоты прямоугольными деталями с последних листов
// (см. fillConcavities). Берём, только если раскладка не хуже и проверка не
// нашла новых ошибок. Пример 261010_Timur_k1, лист 4: вырезы боковин пустовали.
// final — итог (дозаполняем всегда и проверяем раскладку); промежуточные улучшения — не чаще раза в секунду,
// без тяжёлой проверки: геометрия дозаполнения точная, а проверка всего заказа на каждом шаге подвешивала телефон
let lastFillAt = 0
// Закономерный «съём» последнего листа по НАСТОЯЩИМ деталям (после развёртки гибрида): каждая деталь — прямоугольник
// своего габарита (контур внутри, зазор — рез), сцепленные пары разбираются. Внутри гибридного поиска пара — один
// жёсткий блок, и там съём часто не проходит, а по отдельным деталям — проходит (261010_Timur_k1: 5 из 10 итогов с 12
// листами перекладываются в 11 за <1 с). Поворот — как разрешено у детали; контур поворачивается вместе с ней.
// См. sweepLast в nesting.js
const SWEEP_MODES = ['bssf', 'baf', 'blsf', 'bl', 'cp', 'g-bssf', 'g-baf', 'g-blsf']
function sweepExpanded(sheets, params, usableX, usableY, kerf, budgetMs) {
  if ((params.cuttingMethod || 'nesting') !== 'nesting' || !sheets || sheets.length < 2) return sheets
  if (sheets.some(sh => sh.stock === 'offcut')) return sheets
  const byId = new Map()
  const isRectPoly = p => {
    if (!Array.isArray(p.polygon) || p.polygon.length < 3) return true
    if (p.polygon.length !== 4) return false
    const xs = new Set(p.polygon.map(q => Math.round(q.x * 10))), ys = new Set(p.polygon.map(q => Math.round(q.y * 10)))
    return xs.size === 2 && ys.size === 2
  }
  const prep = sheets.map((sh, si) => ({ ...sh, placed: sh.placed.map((p, i) => {
    const id = `s${si}_${i}`
    byId.set(id, p)
    const d = params.details[p.detailIndex]
    return { ...p, id, rotatable: !!d?.rotatable, kf: kerf }
  }) }))
  const out = sweepLast(prep, SWEEP_MODES, params.direction || 'auto', usableX + kerf, usableY + kerf, budgetMs)
  if (out === prep) return sheets
  return out.map(sh => ({ ...sh, placed: sh.placed.map(q => {
    const o = byId.get(q.id)
    if (!o) return q
    const turned = !!q.rotated   // поворот при укладке — относительно исходного положения детали
    const res = { ...o, x: q.x, y: q.y, w: q.w, h: q.h, origX: q.origX, origY: q.origY, rotated: turned ? !o.rotated : o.rotated, rotation: q.rotation,
      edgeTop: q.edgeTop, edgeRight: q.edgeRight, edgeBottom: q.edgeBottom, edgeLeft: q.edgeLeft }
    // контур поворачивается на 90° вместе с деталью (та же формула, что rotate90 в trueShapeNesting: [y, w − x])
    if (turned && Array.isArray(o.polygon)) res.polygon = isRectPoly(o) ? [{ x: 0, y: 0 }, { x: q.origX, y: 0 }, { x: q.origX, y: q.origY }, { x: 0, y: q.origY }] : o.polygon.map(v => ({ x: v.y, y: o.origX - v.x }))
    return res
  }) }))
}
function withFilled(res, params, final = true) {
  try {
    if (!res?.sheets?.length || (params.cuttingMethod || 'nesting') === 'guillotine') return res
    // промежуточный показ: на небольших заказах — каждый раз (иначе на экране то с пустыми вырезами, то без),
    // на больших — не чаще раза в секунду
    const small = params.details.reduce((t, d) => t + (Number(d.qty) || 0), 0) <= 300
    if (!final && !small) { const now = Date.now(); if (now - lastFillAt < 1000) return res; lastFillAt = now }
    const usableX = res.usableX ?? (params.sheetW - params.marginL - params.marginR)
    const usableY = res.usableY ?? (params.sheetL - params.marginT - params.marginB)
    const kerf = params.kerf || 0
    let sheets = fillConcavities({ sheets: res.sheets, details: params.details, kerf, usableX, usableY })
    if (!sheets) {
      // вырезов не дозаполнили — но закономерный съём последнего листа по настоящим деталям всё равно пробуем
      const swept = sweepExpanded(res.sheets, params, usableX, usableY, kerf, final ? 1500 : 0)
      if (swept === res.sheets) return res
      if (final) {
        const chk = sh => validateNesting({ sheets: sh, details: params.details, usableX, usableY, kerf }).errors.length
        if (chk(swept) > chk(res.sheets)) return res
      }
      return { ...res, sheets: swept, filled: true, rawSheets: res.rawSheets || res.sheets }
    }
    // Детали ушли в вырезы — на листах, откуда их забрали, остались дыры. Стягиваем такие листы к нулю (по настоящим
    // контурам, зазор — рез; порядок осей — по направлению укладки), если мелких у края от этого не больше
    // (261018_002 авто: на последнем листе после дозаполнения висели детали над пустотой)
    const idsOf = sh => sh.placed.map(p => p.id).join(',')
    const before = new Set(res.sheets.map(idsOf))
    sheets = sheets.map(sh => {
      if (sh.stock === 'offcut' || before.has(idsOf(sh))) return sh
      const ux = sh.usableX ?? usableX, uy = sh.usableY ?? usableY
      const placed = gravityPolygons(sh.placed, params.direction || 'auto', kerf)
      if (placed === sh.placed) return sh
      if (smallAtEdge([{ placed }], ux, uy, true) > smallAtEdge([sh], ux, uy, true)) return sh
      return { ...sh, placed }
    })
    // Последний лист потерял детали — перекладываем его под наибольший цельный обрезок (блоками: деталь с вырезом
    // вместе с тем, что в нём лежит), иначе дыры и рваный верх остаются (261018_002 вдоль X: дыра на месте 373×310)
    const li = sheets.length - 1, lastSh = sheets[li]
    if (lastSh && lastSh.stock !== 'offcut' && !before.has(idsOf(lastSh)) && (params.cuttingMethod || 'nesting') === 'nesting') {
      const ux = (lastSh.usableX ?? usableX) + kerf, uy = (lastSh.usableY ?? usableY) + kerf
      const rp = repackLastForOffcut(lastSh, { direction: params.direction || 'auto', usableX: ux, usableY: uy, budgetMs: final ? 400 : 150 })
      if (rp && smallAtEdge([rp], ux - kerf, uy - kerf, true) <= smallAtEdge([lastSh], ux - kerf, uy - kerf, true)) {
        sheets = sheets.slice(); sheets[li] = rp
      }
    }
    sheets = sweepExpanded(sheets, params, usableX, usableY, kerf, final ? 1500 : 0)
    if (liveBetter(liveScore(res.sheets, usableX, usableY), liveScore(sheets, usableX, usableY))) return res
    if (final) {
      const chk = sh => validateNesting({ sheets: sh, details: params.details, usableX, usableY, kerf }).errors.length
      if (chk(sheets) > chk(res.sheets)) return res
    }
    // rawSheets — раскладка ДО дозаполнения. Соседним потокам (мигрант) уходит именно она: гибридный поиск
    // считает фигурную деталь прямоугольником-габаритом, и деталь, положенная в её вырез, для него — наложение.
    // Стяжка такой раскладки протаскивала мелкие детали сквозь боковину (261010_Timur_k1, лист 2).
    return { ...res, sheets, filled: true, rawSheets: res.rawSheets || res.sheets }
  } catch (e) {
    console.warn('Дозаполнение вырезов не удалось:', e)
    return res
  }
}

// Гибрид для фигурных деталей: сцепленные пары → прямоугольники их габарита,
// весь заказ — быстрым прямоугольным поиском (непрерывно в онлайн-режиме, с
// обменом между потоками), результат разворачивается в настоящие контуры.
// См. buildHybridPlan в trueShapeNesting.js.
const HYBRID_PLANS = new Map()
// У вогнутой детали несколько форм сцепленной пары («стоя», «лёжа»). Какая
// лучше ляжет на лист, заранее не сказать — пробуем каждое сочетание быстрым
// раскроем без оптимизации (доли секунды) и берём лучшее по liveBetter.
// Сколько пар собирать, тоже заранее не сказать: лучшая раскладка бывает смешанной — часть деталей парами,
// часть поодиночке (261011_002: 10 деталей с вырезом — 3 пары + 4 одиночных дают тот же последний лист, что и
// россыпь, но с парами; «все 5 пар» — последний лист больше). Пробуем и меньшее число пар.
async function chooseHybridPlan(params, meta) {
  const base = buildHybridPlan(params)
  if (!base) return null
  let combos = [{ c: {}, lim: null }]
  for (const [kind, n] of base.pairShapes || []) {
    if (n < 2) continue
    const next = []
    for (const x of combos) for (let i = 0; i < Math.min(n, 3); i++) next.push({ ...x, c: { ...x.c, [kind]: i } })
    combos = next.slice(0, 9)
  }
  // число пар: все, на одну меньше, ~половина, ~треть (для каждой детали с парами; сочетаний — не больше 16)
  for (const [di, n] of base.pairCounts || []) {
    if (n < 2) continue
    const opts = [...new Set([n - 1, Math.ceil(n * 0.6), Math.ceil(n / 2), Math.ceil(n / 3)])].filter(k => k >= 1 && k < n)
    const next = combos.slice()
    for (const x of combos) for (const k of opts) next.push({ ...x, lim: { ...(x.lim || {}), [di]: k } })
    combos = next.slice(0, 16)
  }
  if (combos.length < 2) return base
  let best = null, bestScore = null
  for (const { c, lim } of combos) {
    const plan = Object.values(c).some(Boolean) || lim ? buildHybridPlan(params, c, lim) : base
    if (!plan) continue
    try {
      // быстрая проба: доводка итога короткая (обрезок последнего листа — 0,1 с, без перекомпоновки и «узкие — от края») —
      // сравниваются число листов и последний лист; полная доводка на каждое из 16 сочетаний отнимала секунды до первой картинки
      const r = await runNesting({ ...params, details: plan.hybridDetails, algo: 'raster', cuttingMethod: 'nesting', optimizeSeconds: 0, onProgress: null, shouldStop: null, takeMigrant: null, onStats: null, probe: true,
        finishBudget: { maxMs: 100, composeMs: 0, relayout: 0 } })
      const sc = liveScore(plan.expand({ ...meta, ...r }).sheets, meta.usableX, meta.usableY)
      if (liveBetter(sc, bestScore)) { best = plan; bestScore = sc }
    } catch { /* пробуем следующее сочетание */ }
  }
  return best || base
}
// Готовая раскладка (seed) в терминах гибридных деталей: настоящие номера деталей → гибридные. Детали из
// сцепленных пар так не переводятся — тогда продолжить с раскладки нельзя, поиск идёт с нуля.
function seedToHybrid(m, singles) {
  if (!m?.seed) return m
  const hi = new Map()
  singles.forEach((di, h) => { if (di !== undefined) hi.set(di, h) })
  const cnt = {}
  let ok = true
  const sheets = m.sheets.map(sh => ({ freeRects: [], placed: sh.placed.map(p => {
    const h = hi.get(p.detailIndex)
    if (h === undefined) { ok = false; return p }
    const q = cnt[h] = (cnt[h] || 0) + 1
    const out = { ...p, detailIndex: h, id: `${h}_${q - 1}` }
    delete out.polygon
    return out
  }) }))
  return ok ? { ...m, sheets, ids: sheets.flatMap(sh => sh.placed.map(p => p.id)) } : null
}
async function runHybrid(params, meta, { live, shouldStop, onProgress, takeMigrant, onStats, t0 }) {
  try {
    const key = JSON.stringify([params.details.map(d => [d.width, d.length, d.qty, d.rotatable, d.contour]), params.kerf, params.sheetL, params.sheetW, params.marginT, params.marginR, params.marginB, params.marginL])
    let plan = HYBRID_PLANS.get(key)
    if (!plan) {
      plan = await chooseHybridPlan(params, meta)
      HYBRID_PLANS.clear()
      HYBRID_PLANS.set(key, plan)
    }
    if (!plan) return null
    // последний показанный вариант: «Стоп» возвращает раскладку, ровно ту же, что на экране (runNesting отдаёт тот же
    // массив листов, что последним ушёл в onProgress) — без повторной развёртки и дозаполнения вырезов
    let lastRaw = null, lastOut = null
    const res = await runNesting({
      ...params, details: plan.hybridDetails, algo: 'raster', cuttingMethod: 'nesting',
      optimizeSeconds: live ? LIVE_BUDGET_SECONDS : params.optimizeSeconds,
      // «Продолжить»: готовая раскладка — сразу стартовый лучший вариант поиска (в гибридных деталях)
      seed: Array.isArray(params.seed) ? (seedToHybrid({ seed: true, sheets: params.seed }, plan.singles)?.sheets || null) : null,
      shouldStop, takeMigrant: takeMigrant ? () => seedToHybrid(takeMigrant(), plan.singles) : null,
      onStats: onStats ? st => onStats({ ...st, hybrid: true, t: Date.now() - t0 }) : null,
      onProgress: onProgress ? ({ sheets, searchSheets, iter, genome, seeded }) => {
        let out = withFilled(plan.expand({ ...meta, sheets }), params, false)
        // соседним потокам — раскладка самого поиска (без доводки показа и без дозаполнения вырезов)
        if (searchSheets && searchSheets !== sheets) out = { ...out, rawSheets: plan.expand({ ...meta, sheets: searchSheets }).sheets }
        lastRaw = sheets; lastOut = out
        onProgress({ ...out, iter, genome, hybrid: true, ...(seeded ? { seeded } : {}) })
      } : null,
    })
    if (lastRaw && res.sheets === lastRaw) {
      // «Стоп»: показанное — итог; плюс закономерный съём последнего листа по настоящим деталям (≤1,5 с)
      const kerf = Number(params.kerf) || 0
      const sw = sweepExpanded(lastOut.sheets, params, meta.usableX, meta.usableY, kerf, 1500)
      if (sw !== lastOut.sheets) {
        const chk = sh => validateNesting({ sheets: sh, details: params.details, usableX: meta.usableX, usableY: meta.usableY, kerf }).errors.length
        if (chk(sw) <= chk(lastOut.sheets)) return { ...lastOut, sheets: sw, filled: true, rawSheets: lastOut.rawSheets || lastRaw, hybrid: true }
      }
      return { ...lastOut, hybrid: true }
    }
    return { ...withFilled(plan.expand(res), params), hybrid: true }
  } catch (e) {
    console.warn('Гибрид не удался:', e)
    return null
  }
}

function polyArea(pts) {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length]
    a += p.x * q.y - q.x * p.y
  }
  return Math.abs(a) / 2
}
const partArea = p => (Array.isArray(p.polygon) && p.polygon.length > 2 ? polyArea(p.polygon) : (p.origX || 0) * (p.origY || 0))

// Лучше — меньше листов; при равенстве — меньше материала на последнем листе
// Лучше — меньше листов; затем меньше мелких деталей у края листа («мелкие —
// в центр», жёсткое требование); затем меньше материала на последнем листе.
// usableX/usableY берутся из самого результата (res.usableX) или передаются.
// При равенстве всего этого — меньше «занятый угол» (env): сумма по листам
// площади прямоугольника от нуля листа до дальней детали. Остальное — цельный
// деловой остаток. Пример 260921_001: 10 листов — минимум (на лист входят
// только 2 детали 1200×900), и раньше улучшения раскладки (сцепленные пары,
// большой свободный остаток) не показывались вовсе — появлялись только после «Стоп».
function envelope(sheets) {
  let env = 0
  for (const sh of sheets) {
    let mx = 0, my = 0
    for (const p of sh.placed) { if (p.x + p.w > mx) mx = p.x + p.w; if (p.y + p.h > my) my = p.y + p.h }
    env += mx * my
  }
  return env
}
// direction (необязательно) — направление укладки: тогда в счёт идёт и цельный обрезок последнего листа
// (вдоль Y — справа, вдоль X — сверху, авто — бóльшая полоса; см. lastOffcutArea)
// offFirst — фрезер: при равных листах и мелких у края решает цельный обрезок последнего листа (а не площадь деталей
// на нём): пользователю нужен большой неразорванный остаток. Пила и пильный центр — как раньше
export function liveScore(sheets, usableX, usableY, direction = null, offFirst = false) {
  if (!sheets?.length) return { count: Infinity, edge: Infinity, last: Infinity, env: Infinity, off: -Infinity, offFirst }
  let edge = 0
  if (usableX && usableY) edge = smallAtEdge(sheets, usableX, usableY, true)
  const lastSh = sheets[sheets.length - 1]
  let off = null
  if (direction && usableX && usableY) {
    const k = Number(lastSh.placed[0]?.kf) || 0   // габарит детали включает рез — зона тоже (как в укладке)
    off = lastOffcutArea(lastSh, direction, (lastSh.usableX ?? usableX) + k, (lastSh.usableY ?? usableY) + k)
  }
  return { count: sheets.length, edge, last: lastSh.placed.reduce((a, p) => a + partArea(p), 0), env: envelope(sheets), off, offFirst: !!(offFirst && off != null) }
}
export function liveBetter(a, b) {
  if (!b) return true
  if (a.count !== b.count) return a.count < b.count
  if ((a.edge || 0) !== (b.edge || 0)) return (a.edge || 0) < (b.edge || 0)
  if (a.offFirst && b.offFirst && Math.abs(a.off - b.off) > 1e4) return a.off > b.off
  if (Math.abs(a.last - b.last) > 1) return a.last < b.last
  // последний лист тот же — больше ли цельный обрезок на нём (от 0,01 м²)
  if (a.off != null && b.off != null && Math.abs(a.off - b.off) > 1e4) return a.off > b.off
  // последний лист тот же — компактнее ли раскладка (на 1% и больше)
  return a.env != null && b.env != null && a.env < b.env * 0.99
}

function isRasterPath(p) {
  const cm = p.cuttingMethod || 'nesting'
  if (p.algo === 'nfp' && cm !== 'guillotine') return false
  if (cm !== 'guillotine' && needsTrueShape(p.details)) return false
  return true
}

/**
 * params — как у runNesting; live — до «Стоп» (иначе лимит optimizeSeconds);
 * shouldStop() — нажат ли «Стоп»; onProgress(res) — промежуточный результат
 * в том же формате, что и итог runNesting (+ iter, round).
 */
async function runCore(params, { live = false, shouldStop = () => false, onProgress = null, takeMigrant = null, onStats = null, island = 0, islands = 1 } = {}) {
  // счёт вариантов — как у страницы (обрезок последнего листа по направлению укладки), иначе поток возвращал «Стопом»
  // не тот вариант, что страница считает лучшим
  const offFirst = (params.cuttingMethod || 'nesting') === 'nesting'
  const scoreOf = (sheets, ux, uy) => liveScore(sheets, ux, uy, params.direction, offFirst)
  const meta = {
    usableX: params.sheetW - params.marginL - params.marginR,
    usableY: params.sheetL - params.marginT - params.marginB,
    sheetL: params.sheetL, sheetW: params.sheetW,
    marginT: params.marginT, marginR: params.marginR, marginB: params.marginB, marginL: params.marginL,
    kerf: params.kerf,
  }

  if (isRasterPath(params)) {
    return await runNesting({
      ...params,
      optimizeSeconds: live ? LIVE_BUDGET_SECONDS : params.optimizeSeconds,
      shouldStop, takeMigrant, onStats,
      onProgress: onProgress ? ({ sheets, searchSheets, iter, genome, seeded }) => onProgress({ ...meta, sheets, ...(searchSheets && searchSheets !== sheets ? { rawSheets: searchSheets } : {}), iter, genome, ...(seeded ? { seeded } : {}) }) : null,
    })
  }

  // Фигурные детали / NFP. Первый точный раунд идёт секунды (на телефоне —
  // до 10 с) — сначала сразу показываем черновик (см. roughLayout).
  const t0 = Date.now()
  let rough = null
  if (Array.isArray(params.seed) && params.seed.length) {
    // «Продолжить»: исходная раскладка — первый лучший вариант, хуже него не покажем
    rough = { ...meta, sheets: params.seed.map((sh, i) => ({ ...sh, index: i, placed: sh.placed.map(p => ({ ...p })) })), seeded: true }
  } else if (onProgress) rough = withFilled(await roughLayout(params), params)
  if (rough && onProgress) {
    const sc = scoreOf(rough.sheets, meta.usableX, meta.usableY)
    onStats?.({ t: Date.now() - t0, phase: 'rough', result: { count: sc.count, last: Math.round(sc.last) }, improved: true })
    onProgress({ ...rough, iter: 0, round: 0 })
  }
  // Роли потоков для фигурных деталей: чётные — точная укладка по контурам
  // раундами, остальные — гибрид (пары → прямоугольники, быстрый непрерывный
  // поиск). Один поток — чередует. Лучший результат выбирает страница.
  const hybridAllowed = params.algo !== 'nfp' // экспериментальный NFP сравниваем в чистом виде
  // Точной укладкой по контурам раундами занимается только поток 0 (он же переходит на гибрид, если гибрид выигрывает),
  // остальные — сразу гибрид: раньше половина потоков первые ~35 с считала раунды точной укладки, а на заказах с
  // Г-образными деталями почти всегда выигрывает гибрид (261010_Timur_k1: 11 листов перестали находиться за 5 мин)
  const hybridRole = hybridAllowed && islands > 1 && (islands >= 3 ? island !== 0 : island % 2 === 1)
  if (hybridRole) {
    const r = await runHybrid(params, meta, { live, shouldStop, onProgress, takeMigrant, onStats, t0 })
    if (r) return rough && liveBetter(scoreOf(rough.sheets, meta.usableX, meta.usableY), scoreOf(r.sheets, meta.usableX, meta.usableY)) ? rough : r
  }
  if (!live) {
    let res = withFilled(await runNesting(params), params)
    if (islands <= 1 && hybridAllowed) {
      // один поток: дополнительно гибрид с тем же временем — берём лучший
      const hy = await runHybrid(params, meta, { live: false, shouldStop, onProgress: null, takeMigrant: null, onStats, t0 })
      if (hy && liveBetter(scoreOf(hy.sheets, meta.usableX, meta.usableY), scoreOf(res.sheets, meta.usableX, meta.usableY))) res = hy
    }
    const sc = scoreOf(res.sheets, meta.usableX, meta.usableY)
    onStats?.({ t: Date.now() - t0, phase: 'shape', round: 1, roundSeconds: params.optimizeSeconds, best: { count: sc.count, last: Math.round(sc.last) }, improved: true })
    // итог не хуже уже показанного черновика
    if (rough && liveBetter(scoreOf(rough.sheets, meta.usableX, meta.usableY), sc)) return rough
    return res
  }

  // Онлайн — раунды до «Стоп». Раунды чередуются: точная укладка по контурам / гибрид. Гибридные раунды
  // стартуют от лучшей раскладки соседних потоков (мигрант). Если после первой пары раундов лучший результат гибрида
  // лучше лучшего результата точной укладки — поток переходит на непрерывный гибридный поиск (как нечётные потоки):
  // раньше половина ядер телефона до самого «Стоп» считала то, что заведомо проигрывало
  // (261010_Timur_k1: все улучшения — от гибрида, 11 листов нашлись только на 72-й с).
  let best = rough, bestScore = rough ? scoreOf(rough.sheets, meta.usableX, meta.usableY) : null, round = 0
  let shapeBest = null, hybridBest = null     // лучший счёт каждого пути
  const take = (res, tag) => {
    const sc = scoreOf(res.sheets, meta.usableX, meta.usableY)
    if (tag === 'hybrid') { if (liveBetter(sc, hybridBest)) hybridBest = sc } else if (liveBetter(sc, shapeBest)) shapeBest = sc
    const improved = liveBetter(sc, bestScore)
    if (improved) { best = res; bestScore = sc }
    return { sc, improved }
  }
  while (!shouldStop()) {
    if (hybridAllowed && round >= 2 && hybridBest && shapeBest && liveBetter(hybridBest, shapeBest)) {
      // непрерывный гибрид до «Стоп» — каждое улучшение сразу на экран
      const r = await runHybrid(params, meta, {
        live: true, shouldStop, takeMigrant, onStats, t0,
        onProgress: onProgress ? res => { const { improved } = take(res, 'hybrid'); if (improved) onProgress({ ...res, iter: round, round }) } : null,
      })
      if (r) { const { improved } = take(r, 'hybrid'); if (improved && onProgress) onProgress({ ...r, iter: round, round }) }
      break
    }
    const secs = ROUND_SECONDS[Math.min(round, ROUND_SECONDS.length - 1)]
    const useHybrid = hybridAllowed && round % 2 === 1
    const res = (useHybrid && await runHybrid({ ...params, optimizeSeconds: secs }, meta, { live: false, shouldStop, onProgress: null, takeMigrant: islands > 1 ? takeMigrant : null, onStats: null, t0 }))
      || withFilled(await runNesting({ ...params, optimizeSeconds: secs }), params)
    round++
    const { sc, improved } = take(res, res.hybrid ? 'hybrid' : 'shape')
    // «Пульс» по раундам: что дал каждый раунд, даже если он не лучше
    onStats?.({ t: Date.now() - t0, phase: 'shape', round, roundSeconds: secs, result: { count: sc.count, last: Math.round(sc.last) }, improved })
    if (improved && onProgress) onProgress({ ...res, iter: round, round })
  }
  return best || await runNesting({ ...params, optimizeSeconds: 0 })
}

// ─── Обрезки ──────────────────────────────────────────────────────────────────
// params.offcuts = { margin, items: [{ length, width, qty }] } — остатки листов
// со склада. Раскрой сначала заполняет их (крупные — первыми), и только то, что
// не вошло, раскладывается на целые листы. Лист-обрезок в результате — обычный
// лист со своими размерами: sheetL/sheetW/usableX/usableY/отступы + stock: 'offcut'.

export function offcutInstances(offcuts) {
  const items = Array.isArray(offcuts?.items) ? offcuts.items : []
  const margin = Math.max(0, Number(offcuts?.margin) || 0)
  const out = []
  items.forEach((it, ii) => {
    const L = Number(it.length) || 0, W = Number(it.width) || 0, q = Math.max(0, Math.floor(Number(it.qty) || 0))
    if (L <= 2 * margin || W <= 2 * margin) return
    for (let k = 0; k < q; k++) out.push({ length: L, width: W, margin, item: ii })
  })
  return out.sort((a, b) => b.length * b.width - a.length * a.width)
}


export async function fillOffcuts(params, offs, shaped, budget) {
  const kerf = Number(params.kerf) || 0
  const remaining = params.details.map(d => Math.max(0, Number(d.qty) || 0))
  const sheets = []
  for (let k = 0; k < offs.length; k++) {
    const off = offs[k], m = off.margin
    const ux = off.width - 2 * m, uy = off.length - 2 * m
    const idx = [], det = []
    params.details.forEach((d, di) => {
      if (!remaining[di]) return
      const w = Number(d.width) + kerf, l = Number(d.length) + kerf
      const fits = (w <= ux && l <= uy) || (d.rotatable && l <= ux && w <= uy)
      if (!fits) return
      idx.push(di); det.push({ ...d, qty: remaining[di], contour: null })
    })
    if (!det.length) continue
    let res
    try {
      res = await runNesting({
        ...params, details: det, sheetL: off.length, sheetW: off.width,
        marginT: m, marginR: m, marginB: m, marginL: m,
        optimizeSeconds: budget, algo: 'raster', direction: 'auto',
        onProgress: null, shouldStop: null, takeMigrant: null, onStats: null,
      })
    } catch { continue }
    // берём самый заполненный лист — его и режем из обрезка
    let best = null, bestA = 0
    for (const sh of res.sheets || []) {
      const a = sh.placed.reduce((s, p) => s + (p.origX || 0) * (p.origY || 0), 0)
      if (a > bestA) { best = sh; bestA = a }
    }
    if (!best) continue
    const polys = {}
    const placed = best.placed.map(p => {
      const di = idx[p.detailIndex]
      const q = { ...p, detailIndex: di, id: `off${k}_${p.id}` }
      delete q.polygon
      const d = params.details[di]
      if (shaped && d?.contour) {
        if (!polys[di]) polys[di] = roughShapePolygons(d)
        const rot = placedRotation(q, Number(d.width))
        const poly = polys[di][rot]
        if (poly) { q.polygon = poly.map(([x, y]) => ({ x, y })); q.rotation = rot }
      }
      remaining[di]--
      return q
    })
    sheets.push({
      ...best, index: k, placed,
      stock: 'offcut', offcutItem: off.item,
      sheetL: off.length, sheetW: off.width, usableX: ux, usableY: uy,
      marginT: m, marginR: m, marginB: m, marginL: m,
    })
  }
  return { sheets, remaining }
}

/**
 * params — как у runNesting (+ offcuts); live — до «Стоп» (иначе лимит optimizeSeconds);
 * shouldStop() — нажат ли «Стоп»; onProgress(res) — промежуточный результат
 * в том же формате, что и итог runNesting (+ iter, round). Листы-обрезки
 * (если есть) идут в начале res.sheets, их число — res.offcutSheets.
 */
// «Продолжить» (params.seed.sheets — листы, как на экране): раскладка уходит в поиск стартовым лучшим вариантом
// (runNesting.seed — на экране не мелькнёт раскладка хуже исходной) и первым «мигрантом» (порядок деталей + сама
// укладка). Номера деталей в листах — по details переданного params; id деталей выставляются заново по номеру
// и порядку (`${di}_${q}`, как у buildPieces) — ручные правки и переносы их не ломают.
function seedInto(params, opts, sheetsIn) {
  const sheets = (sheetsIn || []).filter(sh => sh?.placed?.length)
  if (!sheets.length) return { params: { ...params, seed: undefined }, opts }
  const cnt = new Map()
  const prepared = sheets.map(sh => ({ freeRects: [], placed: sh.placed.map(p => {
    const q = cnt.get(p.detailIndex) || 0
    cnt.set(p.detailIndex, q + 1)
    return { ...p, id: `${p.detailIndex}_${q}` }
  }) }))
  let seed = { ids: prepared.flatMap(sh => sh.placed.map(p => p.id)), mode: (params.cuttingMethod || 'nesting') === 'guillotine' ? 'g-baf' : 'baf', sheets: prepared, seed: true }
  const inner = opts.takeMigrant
  return {
    params: { ...params, seed: prepared },
    opts: { ...opts, takeMigrant: () => { if (seed) { const s = seed; seed = null; return s } return inner ? inner() : null } },
  }
}

// «По габаритам» (галочка в конфигурации раскроя): фигурные детали укладываются и режутся прямоугольником своего
// габарита — обычный прямоугольный раскрой, без укладки по контуру и без деталей в вырезах соседей. Деталь становится
// настоящим прямоугольником: контура (polygon) у неё нет, угловые и краевые вырезы не рисуются и не режутся (p.box,
// см. partHoles.placedHoles); внутренние вырезы, пазы и отверстия остаются.
const stripPolys = sheets => (sheets || []).map(sh => ({ ...sh, placed: (sh.placed || []).map(p => { const q = { ...p }; delete q.polygon; delete q.rotation; return q }) }))
function asBoxes(res) {
  if (!res?.sheets) return res
  const mark = list => (list || []).map(sh => ({ ...sh, placed: sh.placed.map(p => { const q = { ...p, box: true }; delete q.polygon; return q }) }))
  return { ...res, sheets: mark(res.sheets), ...(res.rawSheets ? { rawSheets: mark(res.rawSheets) } : {}), byBox: true }
}

export async function runLiveNesting(params, opts = {}) {
  if (params.beamSaw) return runBeamSaw(params, opts)   // β Пильный центр — свой алгоритм уровнями резов (island, onStats — для потоков и хронологии)
  // Пила (форматник): полосами, как пильный центр — ширину полосы задаёт деталь, полосы от большой к малой, внутри —
  // по готовности, на последнем листе один крупный обрезок. Свои рез и отступы заказа, без захвата, торцовки уровней,
  // предела уровней и автоматических обрезков. Склад обрезков (раскрой и на обрезки) полосы пока не умеют — там прежний
  // форматник с порядком по готовности (src/lib/readyOrder.js).
  if ((params.cuttingMethod || 'nesting') === 'guillotine' && !params.offcuts?.items?.length) {
    const dir = params.direction === 'along_x' ? 'x' : params.direction === 'along_y' ? 'y' : 'auto'
    const fs = { kerf: Number(params.kerf) || 0, trimLeft: Number(params.marginL) || 0, trimRight: Number(params.marginR) || 0, trimTop: Number(params.marginT) || 0, trimBottom: Number(params.marginB) || 0,
      levels: 20, levelTrims: [0], grip: 0, narrowMin: 0, direction: dir, stripOrder: 'desc', offcutMinL: 1e9, offcutMinW: 1e9, stairLast: true }
    const mark = res => (res ? { ...res, beamSaw: false, formatStrips: true, beamSettings: undefined } : res)
    const onProgress = opts.onProgress ? res => opts.onProgress(mark(res)) : null
    return mark(await runBeamSaw({ ...params, beamSaw: fs }, { ...opts, onProgress }))
  }
  if ((params.cuttingMethod || 'nesting') === 'guillotine') {
    const onProgress = opts.onProgress ? res => opts.onProgress(readyOrderResult(res)) : null
    return readyOrderResult(await runLiveNestingRaw(params, { ...opts, onProgress }))
  }
  if (!params.byBox) return runLiveNestingRaw(params, opts)
  const plain = { ...params, details: params.details.map(d => ({ ...d, contour: null })), algo: 'raster' }
  if (Array.isArray(plain.seed?.sheets)) plain.seed = { ...plain.seed, sheets: stripPolys(plain.seed.sheets) }
  const onProgress = opts.onProgress ? res => opts.onProgress(asBoxes(res)) : null
  return asBoxes(await runLiveNestingRaw(plain, { ...opts, onProgress }))
}

async function runLiveNestingRaw(params, opts = {}) {
  const offs = offcutInstances(params.offcuts)
  const seedSheets = Array.isArray(params.seed?.sheets) ? params.seed.sheets : null
  if (!offs.length) {
    ;({ params, opts } = seedInto(params, opts, seedSheets))
    return await runCore(params, opts)
  }
  params = { ...params, seed: undefined }

  const shaped = !isRasterPath(params)
  // Время на обрезок: больше 0,15 с заполнение не улучшает (замер на 260906_009:
  // 0,15 с — 93,9%, 1 с — 93,9%), а первая картинка из-за него появлялась на ~1 с позже
  const budget = Math.min(0.15, 1 / offs.length)
  // «Продолжить» с обрезками: листы-обрезки берём из раскладки на экране как есть (они должны совпадать с
  // обрезками со склада по размеру и отступу — иначе склад поменяли, и идёт обычный старт), остаток заказа
  // продолжает поиск с остальных листов экрана.
  let seedMain = null, filled = null
  if (seedSheets?.length) {
    const offSeed = seedSheets.filter(sh => sh?.stock === 'offcut'), mainSeed = seedSheets.filter(sh => sh?.stock !== 'offcut' && sh?.placed?.length)
    const free = offs.slice()
    const taken = []
    let ok = true
    for (const sh of offSeed) {
      const k = free.findIndex(o => Math.abs(o.length - Number(sh.sheetL)) < 0.01 && Math.abs(o.width - Number(sh.sheetW)) < 0.01 && Math.abs(o.margin - Number(sh.marginL)) < 0.01)
      if (k < 0) { ok = false; break }
      taken.push({ ...sh, index: taken.length, offcutItem: free[k].item, placed: (sh.placed || []).map(p => ({ ...p })) })
      free.splice(k, 1)
    }
    if (ok) {
      const remaining = params.details.map(d => Math.max(0, Number(d.qty) || 0))
      for (const sh of taken) for (const p of sh.placed) { if (!(remaining[p.detailIndex] > 0)) { ok = false; break } remaining[p.detailIndex]-- }
      if (ok) { filled = { sheets: taken, remaining }; seedMain = mainSeed }
    }
  }
  const { sheets: offSheets, remaining } = filled || await fillOffcuts(params, offs, shaped, budget)
  if (!offSheets.length) {
    ;({ params, opts } = seedInto(params, opts, seedMain))
    return await runCore(params, opts)
  }

  const meta = {
    usableX: params.sheetW - params.marginL - params.marginR,
    usableY: params.sheetL - params.marginT - params.marginB,
    sheetL: params.sheetL, sheetW: params.sheetW,
    marginT: params.marginT, marginR: params.marginR, marginB: params.marginB, marginL: params.marginL,
    kerf: params.kerf,
  }
  // Остаток заказа — отдельная задача: только недоложенные детали
  const subToOrig = [], subDetails = []
  params.details.forEach((d, di) => { if (remaining[di] > 0) { subToOrig.push(di); subDetails.push({ ...d, qty: remaining[di] }) } })
  const origToSub = new Map(subToOrig.map((o, s) => [o, s]))
  const nOff = offSheets.length
  // Потоки могли заполнить обрезки по-разному — обмениваться раскладкой можно
  // только при одинаковом остатке заказа
  const subKey = JSON.stringify(subToOrig.map((o, s) => [o, subDetails[s].qty]))

  const toFull = res => {
    if (!res) return res
    const full = list => (list || []).map(sh => ({ ...sh, placed: sh.placed.map(p => ({ ...p, detailIndex: subToOrig[p.detailIndex] })) }))
    const main = full(res.sheets)
    return {
      ...meta, ...res, sheets: [...offSheets, ...main], offcutSheets: nOff,
      rawSheets: res.rawSheets ? [...offSheets, ...full(res.rawSheets)] : undefined,
      genome: res.genome ? { ...res.genome, subKey, offcutSheets: nOff } : res.genome,
    }
  }

  if (!subDetails.length) {
    const res = toFull({ ...meta, sheets: [] })
    opts.onProgress?.({ ...res, iter: 0 })
    return res
  }
  const takeMigrant = opts.takeMigrant ? () => {
    const m = opts.takeMigrant()
    if (!m || m.subKey !== subKey) return null
    const n = m.offcutSheets || 0
    const sheets = Array.isArray(m.sheets)
      ? m.sheets.slice(n).map(sh => ({ ...sh, placed: sh.placed.map(p => ({ ...p, detailIndex: origToSub.get(p.detailIndex) ?? -1 })) }))
      : undefined
    return { ...m, sheets }
  } : null

  // остаток заказа продолжает с листов экрана (номера деталей → номера остатка)
  let subSeed = null
  if (seedMain) {
    subSeed = []
    for (const sh of seedMain) {
      const placed = []
      for (const p of sh.placed) { const s = origToSub.get(p.detailIndex); if (s === undefined) { subSeed = null; break } placed.push({ ...p, detailIndex: s }) }
      if (!subSeed) break
      subSeed.push({ placed })
    }
  }
  const seeded = seedInto({ ...params, details: subDetails }, { ...opts, takeMigrant }, subSeed)
  const res = await runCore(seeded.params, {
    ...seeded.opts,
    onProgress: opts.onProgress ? r => opts.onProgress(toFull(r)) : null,
  })
  return toFull(res)
}
