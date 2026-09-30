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
import { runNesting, smallAtEdge } from './nesting'
import { needsTrueShape, roughShapePolygons, isTurned, buildHybridPlan } from './trueShapeNesting'

const LIVE_BUDGET_SECONDS = 1e7 // «бесконечно» — до нажатия «Стоп»

// Черновик для фигурных деталей: раскладка по габаритам обычным прямоугольным
// раскроем без оптимизации (доли секунды), на экране — настоящие контуры
// внутри габаритов. Габариты не пересекаются и держат зазор реза — значит, и
// контуры тоже. Дальше точные раунды улучшают результат.
async function roughLayout(params) {
  try {
    const plain = params.details.map(d => ({ ...d, contour: null }))
    const res = await runNesting({ ...params, details: plain, optimizeSeconds: 0, algo: 'raster', cuttingMethod: 'nesting' })
    const polys = {}
    res.sheets.forEach(sh => sh.placed.forEach(p => {
      const d = params.details[p.detailIndex]
      if (!d?.contour) return
      if (!polys[p.detailIndex]) polys[p.detailIndex] = roughShapePolygons(d)
      // поворот — по фактическим размерам (флаг rotated не учитывает поворот при укладке «вдоль X/Y»)
      const r90 = isTurned(p, Number(d.width))
      const poly = polys[p.detailIndex][r90 ? 90 : 0]
      if (!poly) return
      p.polygon = poly.map(([x, y]) => ({ x, y }))
      p.rotation = r90 ? 90 : 0
    }))
    res.rough = true
    return res
  } catch { return null }
}
const ROUND_SECONDS = [3, 6, 10, 15, 20, 30]

// Гибрид для фигурных деталей: сцепленные пары → прямоугольники их габарита,
// весь заказ — быстрым прямоугольным поиском (непрерывно в онлайн-режиме, с
// обменом между потоками), результат разворачивается в настоящие контуры.
// См. buildHybridPlan в trueShapeNesting.js.
const HYBRID_PLANS = new Map()
async function runHybrid(params, meta, { live, shouldStop, onProgress, takeMigrant, onStats, t0 }) {
  try {
    const key = JSON.stringify([params.details.map(d => [d.width, d.length, d.qty, d.rotatable, d.contour]), params.kerf, params.sheetL, params.sheetW, params.marginT, params.marginR, params.marginB, params.marginL])
    let plan = HYBRID_PLANS.get(key)
    if (!plan) {
      plan = buildHybridPlan(params)
      HYBRID_PLANS.clear()
      HYBRID_PLANS.set(key, plan)
    }
    if (!plan) return null
    const res = await runNesting({
      ...params, details: plan.hybridDetails, algo: 'raster', cuttingMethod: 'nesting',
      optimizeSeconds: live ? LIVE_BUDGET_SECONDS : params.optimizeSeconds,
      shouldStop, takeMigrant,
      onStats: onStats ? st => onStats({ ...st, hybrid: true, t: Date.now() - t0 }) : null,
      onProgress: onProgress ? ({ sheets, iter, genome }) => onProgress({ ...plan.expand({ ...meta, sheets }), iter, genome, hybrid: true }) : null,
    })
    return { ...plan.expand(res), hybrid: true }
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
export function liveScore(sheets, usableX, usableY) {
  if (!sheets?.length) return { count: Infinity, edge: Infinity, last: Infinity }
  let edge = 0
  if (usableX && usableY) edge = smallAtEdge(sheets, usableX, usableY)
  return { count: sheets.length, edge, last: sheets[sheets.length - 1].placed.reduce((a, p) => a + partArea(p), 0) }
}
export function liveBetter(a, b) {
  if (!b) return true
  if (a.count !== b.count) return a.count < b.count
  if ((a.edge || 0) !== (b.edge || 0)) return (a.edge || 0) < (b.edge || 0)
  return a.last < b.last - 1
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
      onProgress: onProgress ? ({ sheets, iter, genome }) => onProgress({ ...meta, sheets, iter, genome }) : null,
    })
  }

  // Фигурные детали / NFP. Первый точный раунд идёт секунды (на телефоне —
  // до 10 с) — сначала сразу показываем черновик (см. roughLayout).
  const t0 = Date.now()
  let rough = null
  if (onProgress) {
    rough = await roughLayout(params)
    if (rough) {
      const sc = liveScore(rough.sheets, meta.usableX, meta.usableY)
      onStats?.({ t: Date.now() - t0, phase: 'rough', result: { count: sc.count, last: Math.round(sc.last) }, improved: true })
      onProgress({ ...rough, iter: 0, round: 0 })
    }
  }
  // Роли потоков для фигурных деталей: чётные — точная укладка по контурам
  // раундами, нечётные — гибрид (пары → прямоугольники, быстрый непрерывный
  // поиск). Один поток — чередует. Лучший результат выбирает страница.
  const hybridAllowed = params.algo !== 'nfp' // экспериментальный NFP сравниваем в чистом виде
  const hybridRole = hybridAllowed && islands > 1 && island % 2 === 1
  if (hybridRole) {
    const r = await runHybrid(params, meta, { live, shouldStop, onProgress, takeMigrant, onStats, t0 })
    if (r) return rough && liveBetter(liveScore(rough.sheets, meta.usableX, meta.usableY), liveScore(r.sheets, meta.usableX, meta.usableY)) ? rough : r
  }
  if (!live) {
    let res = await runNesting(params)
    if (islands <= 1 && hybridAllowed) {
      // один поток: дополнительно гибрид с тем же временем — берём лучший
      const hy = await runHybrid(params, meta, { live: false, shouldStop, onProgress: null, takeMigrant: null, onStats, t0 })
      if (hy && liveBetter(liveScore(hy.sheets, meta.usableX, meta.usableY), liveScore(res.sheets, meta.usableX, meta.usableY))) res = hy
    }
    const sc = liveScore(res.sheets, meta.usableX, meta.usableY)
    onStats?.({ t: Date.now() - t0, phase: 'shape', round: 1, roundSeconds: params.optimizeSeconds, best: { count: sc.count, last: Math.round(sc.last) }, improved: true })
    // итог не хуже уже показанного черновика
    if (rough && liveBetter(liveScore(rough.sheets, meta.usableX, meta.usableY), sc)) return rough
    return res
  }

  // Онлайн — раунды до «Стоп»
  let best = rough, bestScore = rough ? liveScore(rough.sheets, meta.usableX, meta.usableY) : null, round = 0
  while (!shouldStop()) {
    const secs = ROUND_SECONDS[Math.min(round, ROUND_SECONDS.length - 1)]
    // один поток — раунды чередуются: точная укладка / гибрид
    const useHybrid = hybridAllowed && islands <= 1 && round % 2 === 1
    const res = (useHybrid && await runHybrid({ ...params, optimizeSeconds: secs }, meta, { live: false, shouldStop, onProgress: null, takeMigrant: null, onStats: null, t0 }))
      || await runNesting({ ...params, optimizeSeconds: secs })
    round++
    const sc = liveScore(res.sheets, meta.usableX, meta.usableY)
    const improved = liveBetter(sc, bestScore)
    // «Пульс» по раундам: что дал каждый раунд, даже если он не лучше
    onStats?.({ t: Date.now() - t0, phase: 'shape', round, roundSeconds: secs, result: { count: sc.count, last: Math.round(sc.last) }, improved })
    if (improved) {
      best = res; bestScore = sc
      if (onProgress) onProgress({ ...res, iter: round, round })
    }
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
        const r90 = isTurned(q, Number(d.width))
        const poly = polys[di][r90 ? 90 : 0]
        if (poly) { q.polygon = poly.map(([x, y]) => ({ x, y })); q.rotation = r90 ? 90 : 0 }
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
export async function runLiveNesting(params, opts = {}) {
  const offs = offcutInstances(params.offcuts)
  if (!offs.length) return await runCore(params, opts)

  const shaped = !isRasterPath(params)
  // Время на обрезок: больше 0,15 с заполнение не улучшает (замер на 260906_009:
  // 0,15 с — 93,9%, 1 с — 93,9%), а первая картинка из-за него появлялась на ~1 с позже
  const budget = Math.min(0.15, 1 / offs.length)
  const { sheets: offSheets, remaining } = await fillOffcuts(params, offs, shaped, budget)
  if (!offSheets.length) return await runCore(params, opts)

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
    const main = (res.sheets || []).map(sh => ({ ...sh, placed: sh.placed.map(p => ({ ...p, detailIndex: subToOrig[p.detailIndex] })) }))
    return {
      ...meta, ...res, sheets: [...offSheets, ...main], offcutSheets: nOff,
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

  const res = await runCore({ ...params, details: subDetails }, {
    ...opts, takeMigrant,
    onProgress: opts.onProgress ? r => opts.onProgress(toFull(r)) : null,
  })
  return toFull(res)
}
