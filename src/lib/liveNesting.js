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
import { runNesting } from './nesting'
import { needsTrueShape } from './trueShapeNesting'

const LIVE_BUDGET_SECONDS = 1e7 // «бесконечно» — до нажатия «Стоп»
const ROUND_SECONDS = [3, 6, 10, 15, 20, 30]

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
export function liveScore(sheets) {
  if (!sheets?.length) return { count: Infinity, last: Infinity }
  return { count: sheets.length, last: sheets[sheets.length - 1].placed.reduce((a, p) => a + partArea(p), 0) }
}
export function liveBetter(a, b) {
  if (!b) return true
  if (a.count !== b.count) return a.count < b.count
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
export async function runLiveNesting(params, { live = false, shouldStop = () => false, onProgress = null, takeMigrant = null, onStats = null } = {}) {
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

  // Фигурные детали / NFP: обычный режим — один расчёт как раньше
  const t0 = Date.now()
  if (!live) {
    const res = await runNesting(params)
    const sc = liveScore(res.sheets)
    onStats?.({ t: Date.now() - t0, phase: 'shape', round: 1, roundSeconds: params.optimizeSeconds, best: { count: sc.count, last: Math.round(sc.last) }, improved: true })
    return res
  }

  // Онлайн — раунды до «Стоп»
  let best = null, bestScore = null, round = 0
  while (!shouldStop()) {
    const secs = ROUND_SECONDS[Math.min(round, ROUND_SECONDS.length - 1)]
    const res = await runNesting({ ...params, optimizeSeconds: secs })
    round++
    const sc = liveScore(res.sheets)
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
