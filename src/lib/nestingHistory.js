import { NESTING_VERSION } from './version'
import { liveScore } from './liveNesting'

function polyAreaMm(pts) {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length]
    a += p.x * q.y - q.x * p.y
  }
  return Math.abs(a) / 2
}
const partAreaMm = p => (Array.isArray(p.polygon) && p.polygon.length > 2 ? polyAreaMm(p.polygon) : (p.origX || 0) * (p.origY || 0))

// ─── Хронология раскроя ─────────────────────────────────────────────────────
// Пишется только пока идёт расчёт и живёт до «Оформить». Два назначения:
//  1) пользователь листает, как укладка уплотнялась по времени;
//  2) экспорт для разработчика: по нему видно, где поиск буксует (давно нет
//     улучшений, популяция выродилась, какой режим/поток даёт результат) и
//     есть ли ошибки укладки (пересечения, выход за лист, потерянные детали)
//     — разбирается скриптом scripts/analyze-nesting-history.mjs.
const HIST_MAX_EVENTS = 400    // снимков раскладки (при переполнении прореживаются старые)
const HIST_MAX_STATS = 6000    // строк «пульса» (≈ 25 мин при 4 потоках)

export function newHistory(cfg, islands, params) {
  return {
    startedAt: Date.now(), stoppedAt: 0, islands,
    config: { dir: cfg.dir, small: cfg.small, sq: cfg.sq, side: cfg.side, edge: cfg.edge, end: cfg.end, live: cfg.live, secs: cfg.secs },
    params: {
      sheetL: params.sheetL, sheetW: params.sheetW, kerf: params.kerf,
      marginT: params.marginT, marginR: params.marginR, marginB: params.marginB, marginL: params.marginL,
      cuttingMethod: params.cuttingMethod, algo: params.algo,
      offcuts: params.offcuts || null,
    },
    events: [],        // улучшения лучшего результата (что видел пользователь) + финал
    islandEvents: [],  // улучшения внутри каждого потока (в т.ч. не ставшие общим лучшим)
    stats: [],         // «пульс» поиска по потокам
    thinned: 0,
  }
}
function scoreOf(sheets, usableX, usableY) {
  const sc = liveScore(sheets, usableX, usableY)
  const sheetArea = (usableX || 1) * (usableY || 1)
  // у листа-обрезка своя площадь
  const cap = sh => (sh.usableX ?? usableX ?? 1) * (sh.usableY ?? usableY ?? 1)
  let total = 0, capAll = 0
  sheets.forEach(sh => { capAll += cap(sh); sh.placed.forEach(p => { total += partAreaMm(p) }) })
  const lastCap = sheets.length ? cap(sheets[sheets.length - 1]) : sheetArea
  const offcuts = sheets.filter(sh => sh.stock === 'offcut').length
  return { count: sc.count, offcuts, last: Math.round(sc.last), util: +(total / (capAll || 1)).toFixed(4), lastFill: +(sc.last / lastCap).toFixed(4) }
}
export function recordEvent(hist, res, island, kind) {
  const t = Date.now() - hist.startedAt
  // via — чем найден: черновик / гибрид (пары → прямоугольники) / точная укладка по контурам / прямоугольный поиск
  const via = res.rough ? 'rough' : res.hybrid ? 'hybrid' : res.round !== undefined ? 'exact' : 'rect'
  hist.events.push({ t, kind, island, via, iter: res.iter || 0, mode: res.genome?.mode || null, ...scoreOf(res.sheets, res.usableX, res.usableY), sheets: res.sheets })
  if (hist.events.length > HIST_MAX_EVENTS) {
    // прореживаем старшую половину через один (первый и последние снимки остаются)
    const half = Math.floor(hist.events.length / 2)
    hist.events = hist.events.filter((e, i) => i === 0 || i >= half || i % 2 === 0)
    hist.thinned++
  }
}
export function recordIsland(hist, res, island, global) {
  const t = Date.now() - hist.startedAt
  const sc = liveScore(res.sheets, res.usableX, res.usableY)
  hist.islandEvents.push({ t, island, global, iter: res.iter || 0, mode: res.genome?.mode || null, count: sc.count, last: Math.round(sc.last) })
  if (hist.islandEvents.length > HIST_MAX_STATS) hist.islandEvents.splice(0, hist.islandEvents.length - HIST_MAX_STATS)
}
export function recordStats(hist, st, island) {
  hist.stats.push({ island, ...st, at: Date.now() - hist.startedAt })
  if (hist.stats.length > HIST_MAX_STATS) hist.stats.splice(0, hist.stats.length - HIST_MAX_STATS)
}

// Экспорт для разработчика: компактный JSON (детали на листах — массивами
// [detailIndex, x, y, w, h, rotation]; контуры фигурных деталей — один раз в словаре)
export function buildHistoryExport(hist, { order, details, cfgIdx }) {
  const r1 = v => Math.round(v * 10) / 10
  const shapes = {}
  const packSheets = sheets => sheets.map(sh => sh.placed.map(p => {
    const rot = p.rotation ?? (p.rotated ? 90 : 0)
    if (Array.isArray(p.polygon) && p.polygon.length > 2) {
      const key = `${p.detailIndex}|${rot}`
      if (!shapes[key]) shapes[key] = p.polygon.map(pt => [r1(pt.x), r1(pt.y)])
    }
    return [p.detailIndex, r1(p.x), r1(p.y), r1(p.w), r1(p.h), rot]
  }))
  return {
    format: 'raskroy-nesting-history', formatVersion: 1,
    algoVersion: NESTING_VERSION, exportedAt: new Date().toISOString(),
    order: { number: order?.order_number || '', configuration: cfgIdx + 1 },
    device: {
      cores: (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || null,
      ua: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    },
    islands: hist.islands, config: hist.config, params: hist.params,
    durationMs: (hist.stoppedAt || Date.now()) - hist.startedAt, thinned: hist.thinned,
    details: details.map((d, i) => ({
      i, name: d.display_name || d.name, prefix: d.prefix || '', length: Number(d.length), width: Number(d.width),
      qty: Number(d.qty) || 1, rotatable: !!d.rotatable, contour: !!d.contour,
    })),
    placedFormat: '[detailIndex, x, y, w, h, rotation] — мм, Y вверх от низа рабочей зоны, w/h с учётом реза',
    shapes,
    events: hist.events.map(({ sheets, ...e }) => ({ ...e, sheets: packSheets(sheets) })),
    islandEvents: hist.islandEvents,
    stats: hist.stats,
  }
}

