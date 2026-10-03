/**
 * Нестинг — две конкурирующие "семьи" алгоритмов + multi-strategy поиск + компакция
 *
 * МЕБЕЛЬНЫЙ СТАНДАРТ:
 *   Лист 2750×1830: 2750=Y (вертикаль), 1830=X (горизонталь)
 *   Деталь length×width: length=X (горизонталь), width=Y (вертикаль)
 *   Деталь 400×700: 400 по X, 700 по Y → узкая и высокая
 *
 *   В алгоритме: p.w = X-размер (горизонталь), p.h = Y-размер (вертикаль)
 *   Лист: usableX = sheetL(2750) - отступы по X? НЕТ:
 *     sheetL=2750=Y → usableY = sheetL - marginT - marginB
 *     sheetW=1830=X → usableX = sheetW - marginL - marginR
 *
 * ДВЕ СЕМЬИ АЛГОРИТМОВ РАЗМЕЩЕНИЯ:
 *   Все детали в проекте — прямоугольники (это не нестинг произвольных фигур,
 *   а классическая rectangle bin packing задача). Для неё существуют два
 *   классических подхода — они конкурируют между собой на равных условиях
 *   (тот же multi-strategy поиск + генетический алгоритм), и на выходе выбирается тот,
 *   что дал лучший результат именно для конкретного набора деталей:
 *
 *   1. MaxRects ('bssf'/'baf') — список свободных прямоугольников может
 *      перекрываться, после каждой вставки разбивается на 4 максимальных
 *      прямоугольника-остатка. Гибче геометрически, но сильнее фрагментирует
 *      свободное место на узкие бесполезные полосы (отсюда prune+merge).
 *
 *   2. Guillotine ('g-bssf'/'g-baf') — после вставки остаток режется РОВНО
 *      ОДНИМ разрезом на 2 прямоугольника (Split Shorter Leftover Axis,
 *      как в Jukka Jylänki, "A Thousand Ways to Pack the Bin", 2010 —
 *      открытая, свободно доступная работа по именно этой задаче, есть
 *      референсная реализация на GitHub, MIT-лицензия). Меньше фрагментации,
 *      значительно дешевле по вычислениям на одну попытку — при том же
 *      бюджете времени успевает исследовать на порядок больше вариантов
 *      порядка деталей через генетический алгоритм, что на практике часто даёт
 *      более чистый и предсказуемый остаток на последнем листе.
 *
 *   (Для сравнения: SVGnest/Deepnest решают более общую задачу — нестинг
 *   ПРОИЗВОЛЬНЫХ фигур через No-Fit-Polygon + генетический алгоритм. Для
 *   чисто прямоугольных деталей это избыточно сложно, плюс лицензия AGPL
 *   плохо совместима с коммерческим SaaS без раскрытия исходников.)
 *
 * ЦЕЛЬ ОПТИМИЗАЦИИ — ФРОНТ-ЗАГРУЗКА:
 *   Важно не среднее % использования по всем листам, а чтобы ПЕРВЫЕ листы
 *   были забиты максимально плотно, а на ПОСЛЕДНИЙ уходило только то, что
 *   реально больше никуда не влезает (в идеале — уходило вообще ничего лишнего,
 *   а свободный остаток на последнем листе был одним крупным деловым обрезком,
 *   а не рассеянными по листу огрызками). Для этого после каждой попытки
 *   укладки выполняется КОМПАКЦИЯ: детали с последних листов пытаются
 *   переехать на более ранние листы, если там реально есть куда. Это может
 *   схлопнуть количество используемых листов и/или заметно уплотнить хвост.
 *
 * ПОЧЕМУ MULTI-STRATEGY (и почему это не мгновенно):
 *   Один порядок деталей + одна эвристика выбора места — самый слабый
 *   вариант packing-алгоритма, результат сильно зависит от порядка подачи
 *   деталей. Здесь прогоняется несколько структурных порядков (по площади/
 *   периметру/стороне) и все 4 комбинации семья×эвристика (MaxRects/Guillotine
 *   × BSSF/BAF), а также набор случайных перестановок порядка — и для каждой
 *   попытки выполняется компакция. Выбирается результат с наименьшим числом
 *   листов, при равенстве — с наименьшим остатком на последнем листе. Время
 *   расчёта сознательно принесено в жертву плотности — это не "мгновенный"
 *   алгоритм.
 *
 * ЗАЩИТА МЕЛКИХ ДЕТАЛЕЙ ОТ КРАЯ ЛИСТА (для фрезера):
 *   Мелкие/узкие детали держатся на столе хуже крупных — риск сдвига при
 *   резке фрезером выше у детали, расположенной у самого края используемой
 *   зоны листа (меньше материала, который её ещё удерживает к концу прохода).
 *   Такие детали при прочих равных предпочтительно укладываются ближе
 *   к центру. Не жёсткий запрет — если места без касания края физически нет,
 *   деталь встанет к краю, но среди вынужденных вариантов у края алгоритм
 *   предпочитает тот, что ближе к началу координат (0,0).
 *
 *   Порог(и) и включение/выключение задаёт ПОЛЬЗОВАТЕЛЬ в настройках
 *   раскроя, а не алгоритм. Порог площади задаётся как сторона квадрата
 *   в мм (интуитивнее, чем абстрактные см²/мм²): "мельче квадрата 400×400"
 *   означает area <= 400*400. Деталь считается мелкой, если сработал хотя бы
 *   один из двух независимых критериев — по площади-через-квадрат или
 *   по меньшей стороне (0 = критерий выключен).
 */

import { needsTrueShape, packTrueShape } from './trueShapeNesting'
import { packNFP } from './nfpNesting'
import { gravityRects } from './gravity'

const BORDER_PENALTY = 2000000
// Мелкая деталь ближе SMALL_EDGE_MIN к краю через отход (см. smallEdgeSides) —
// штраф за каждую такую сторону при выборе места; перекрывает любые выгоды плотности
const SMALL_NEAR_PENALTY = 1e13
const ORIGIN_TIEBREAK = 5
const EPS = 0.5 // мм, допуск на сравнение с границей (из-за kerf/округлений)

// Суммарная длина касания прямоугольной детали (x,y,w,h) со стенами листа
// и уже уложенными деталями — критерий «собрать пазл». Kerf уже включён в
// p.w/p.h, поэтому два соседних прямоугольника касаются тогда, когда грани
// совпадают с точностью tol ≈ 1 мм (запас на плавающую точку).
function computeContactLength(x, y, w, h, placed, usableX, usableY, tol = 1.0) {
  let contact = 0
  const right = x + w, top = y + h
  const ov = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))
  if (x <= tol)               contact += h   // левая стена листа
  if (y <= tol)               contact += w   // нижняя стена листа
  if (right >= usableX - tol) contact += h   // правая стена листа
  if (top   >= usableY - tol) contact += w   // верхняя стена листа
  for (const p of placed) {
    const pr = p.x + p.w, pt = p.y + p.h
    if (Math.abs(pr - x)      <= tol) contact += ov(y, top, p.y, pt)   // сосед слева
    if (Math.abs(p.x - right) <= tol) contact += ov(y, top, p.y, pt)   // сосед справа
    if (Math.abs(pt - y)      <= tol) contact += ov(x, right, p.x, pr) // сосед снизу
    if (Math.abs(p.y - top)   <= tol) contact += ov(x, right, p.x, pr) // сосед сверху
  }
  return contact
}

// Сколько попыток компакции гонять подряд — каждая новая попытка может
// высвободить место, которого не было на предыдущей, поэтому есть смысл
// повторить несколько раз, но не бесконечно.
const MAX_COMPACT_PASSES = 3

export async function runNesting({
  details, sheetL, sheetW, marginT, marginR, marginB, marginL, kerf,
  direction = 'auto',
  smallPartsToCenter = false,     // галочка "мелкие детали в середину" из настроек раскроя
  smallPartsMaxSquareSide = 0,    // сторона квадрата (мм); деталь мелкая, если её площадь <= side*side. 0 = критерий выключен
  smallPartsMaxSide = 0,          // порог меньшей стороны детали (мм). 0 = критерий выключен
  smallPartsEdgeGap = 0,          // «у края» — ближе этого к краю листа (мм); 0 — по умолчанию SMALL_EDGE_MIN
  smallPartsEndSide = null,       // «торцом к краю можно»: сторона не длиннее этого (мм); null — как smallPartsMaxSide, 0 — нельзя
  optimizeSeconds = 12,           // сколько секунд гонять поиск плотной укладки — из настроек раскроя
  cuttingMethod = 'nesting',      // 'nesting' (фрезер, ЧПУ — свободная укладка) | 'guillotine' (форматно-раскроечный станок — только сквозные резы)
  algo = 'raster',                // 'raster' (основной, проверенный) | 'nfp' (экспериментальный, точный по контуру — ТОЛЬКО для фрезера, см. ниже)
  onProgress = null,              // онлайн-раскрой: вызывается при каждом улучшении ({ sheets, iter }) — не чаще раза в ~300 мс
  shouldStop = null,              // онлайн-раскрой: () => true — пользователь нажал «Стоп», поиск заканчивается и результат доводится до финала
  takeMigrant = null,             // параллельный поиск («острова»): () => { ids, mode } — лучший вариант соседнего потока, вливается в популяцию
  onStats = null,                 // хронология раскроя: «пульс» поиска раз в ~1 с (итерации, поколение, режимы в популяции, разнообразие)
}) {
  const realX = sheetW - marginL - marginR  // рабочая зона: горизонталь = 1830 - отступы
  const realY = sheetL - marginT - marginB  // вертикаль   = 2750 - отступы
  // Габарит детали здесь включает рез справа и сверху (p.w = ширина + kerf). У
  // края рабочей зоны этот рез не нужен — за ним уже отступ листа. Поэтому
  // укладываем в зону, расширенную на kerf: деталь встаёт вплотную к краю зоны,
  // а не на kerf раньше. Пример 260921_001: 900 + 6,5 + 900 = 1806,5 ≤ 1810 —
  // две детали 900 мм встают в ряд, а раньше требовалось 1813 и шла одна.
  const usableX = realX + (Number(kerf) || 0)
  const usableY = realY + (Number(kerf) || 0)

  // ВАЖНО: NFP умеет укладывать только свободно (для фрезера) — понятия
  // "сквозной рез" там нет вообще. Раньше эта проверка стояла ДО проверки
  // cuttingMethod, из-за чего NFP включался всегда, даже для форматно-
  // раскроечного станка — тот молча укладывал как для фрезера, без единого
  // сквозного реза. Теперь NFP физически недостижим для guillotine, каким
  // бы ни был algo.
  if (algo === 'nfp' && cuttingMethod !== 'guillotine') {
    return await packNFP({ details, sheetL, sheetW, marginT, marginR, marginB, marginL, kerf, optimizeSeconds, direction })
  }

  // ЧПУ-фрезер режет по любому контуру — если среди деталей есть хоть одна
  // с реально нарисованным (не прямоугольным) внешним контуром, укладка
  // обязана идти по этому контуру, а не по его прямоугольнику: это и есть
  // алгоритм нестинга для фрезера, а не отдельный опциональный режим.
  // Форматно-раскроечный станок (guillotine) сюда не попадает ни при каких
  // контурах — там физически обязателен прямоугольный сквозной рез.
  if (cuttingMethod !== 'guillotine' && needsTrueShape(details)) {
    return await packTrueShape({
      details, sheetL, sheetW, marginT, marginR, marginB, marginL, kerf, optimizeSeconds,
      smallPartsToCenter, smallPartsMaxSquareSide, smallPartsMaxSide, direction,
    })
  }

  const smallPartsMaxArea = smallPartsMaxSquareSide > 0 ? smallPartsMaxSquareSide * smallPartsMaxSquareSide : 0

  const basePieces = buildPieces(details, kerf, direction)
  const pieceById = new Map(basePieces.map(p => [p.id, p]))
  // Раскладка соседа годится, только если в ней ровно наши детали (по id), по одной
  const validLayout = sheets => {
    const seen = new Set()
    for (const sh of sheets) {
      if (!sh || !Array.isArray(sh.placed) || !Array.isArray(sh.freeRects)) return false
      for (const p of sh.placed) { if (!pieceById.has(p.id) || seen.has(p.id)) return false; seen.add(p.id) }
    }
    return seen.size === basePieces.length
  }

  // Стяжка к нулю листа с зазором ровно kerf (не меняет входные листы)
  const gravityAll = list => list.map(sheet => {
    const placed = gravityRects(sheet.placed, direction)
    if (placed === sheet.placed) return sheet
    // Стяжка двигает всё, кроме мелких деталей — соседи могут «уехать» и
    // открыть мелкую деталь краю листа. Такую стяжку не применяем.
    if (smallAtEdge([{ placed }], usableX, usableY) > smallAtEdge([sheet], usableX, usableY)) return sheet
    const next = { ...sheet, placed, freeRects: [{ x: 0, y: 0, w: usableX, h: usableY }] }
    placed.forEach(pp => { split(next, pp); prune(next) })
    updateFreeBounds(next)
    return next
  })

  basePieces.forEach(p => {
    const area = p.origX * p.origY
    const minSide = Math.min(p.origX, p.origY)
    p.isSmall = smallPartsToCenter && (
      (smallPartsMaxArea > 0 && area <= smallPartsMaxArea) ||
      (smallPartsMaxSide > 0 && minSide <= smallPartsMaxSide)
    )
    // Узкой деталью можно встать к краю листа только КОРОТКОЙ стороной (торцом
    // 90 мм у детали 400×90): длинные стороны тогда поджаты соседями. Сторона
    // «короткая», если она не длиннее порога «Узкая сторона до» (+ рез).
    const endSide = smallPartsEndSide == null ? smallPartsMaxSide : Number(smallPartsEndSide) || 0
    p.edgeOkMax = p.isSmall && endSide > 0 ? endSide + (Number(kerf) || 0) + 0.5 : 0
    // свой порог «у края» (задаёт пользователь) и рез — для проверки по реальной рабочей зоне вне укладки
    p.edgeMin = Number(smallPartsEdgeGap) > 0 ? Number(smallPartsEdgeGap) : 0
    p.kf = Number(kerf) || 0
  })

  const sortStrategies = [
    (a, b) => (b.pw * b.ph) - (a.pw * a.ph),                 // по убыванию площади
    (a, b) => (b.pw + b.ph) - (a.pw + a.ph),                 // по убыванию периметра
    (a, b) => Math.max(b.pw, b.ph) - Math.max(a.pw, a.ph),   // по убыванию максимальной стороны
    (a, b) => Math.min(a.pw, a.ph) - Math.min(b.pw, b.ph),   // по возрастанию минимальной стороны
  ]
  // ВЫБОР СТАНКА — это не просто предпочтение по скорости/плотности, а вопрос
  // физической реализуемости. На форматно-раскроечном станке (пиле) каждый рез
  // обязан идти НАСКВОЗЬ через весь лист/полосу — MaxRects-раскладка этого не
  // гарантирует и может быть физически нерезаемой на таком станке. Поэтому для
  // 'guillotine' семья MaxRects жёстко исключается из конкурса, а не просто
  // проигрывает по плотности. Для 'nesting' (ЧПУ-фрезер) такого ограничения нет —
  // фреза режет по любому контуру, обе семьи конкурируют на равных.
  const scoringModes = cuttingMethod === 'guillotine'
    ? ['g-bssf', 'g-baf', 'g-blsf', 'g-bl']
    : ['bssf', 'baf', 'blsf', 'bl', 'cp', 'g-bssf', 'g-baf', 'g-blsf']
  const RANDOM_ATTEMPTS = 80 // случайные перестановки порядка (каждая — со всеми режимами), дальше работает генетический поиск
  const RANDOM_PHASE_MS = 3000
  // Большой заказ (сотни деталей, десятки листов): переупаковка всего заказа
  // дорогая (0,1–0,2 с), а лишний лист снимается дожимом последнего листа —
  // популяция меньше, дожиму больше времени
  const BIG_ORDER = basePieces.length > 300

  let best = null
  let bestOrder = null
  // ─── Онлайн-показ: промежуточный лучший результат уходит на экран уже со
  // стяжкой к нулю листа (как финальный), чтобы пользователь видел реальное
  // сжатие укладки, а не сырую раскладку перед стяжкой.
  let iter = 0, dirty = false, lastReport = 0
  // ─── Хронология: «пульс» поиска для разбора, где он буксует ───────────────
  const runStart = Date.now()
  let lastStats = 0, statsIter = 0, gen = 0, phase = 'start', migrantsIn = 0
  let population = null   // объявлены здесь, чтобы «пульс» видел текущую популяцию
  let evaluated = null
  const maybeStats = (force = false) => {
    if (!onStats) return
    const now = Date.now()
    if (!force && now - lastStats < 1000) return
    const dt = Math.max(1, now - (lastStats || runStart))
    const modes = {}
    const distinct = new Set()
    if (evaluated) evaluated.forEach(e => {
      modes[e.mode] = (modes[e.mode] || 0) + 1
      distinct.add(e.stat.sheetCount + ':' + Math.round(e.stat.lastSheetArea / 1000))
    })
    onStats({
      t: now - runStart, phase, iter, gen,
      ips: Math.round((iter - statsIter) * 1000 / dt), // вариантов в секунду
      best: best ? { count: best.stat.sheetCount, last: Math.round(best.stat.lastSheetArea), util: +best.stat.utilization.toFixed(4), mode: best.mode } : null,
      popBest: evaluated ? { count: evaluated[0].stat.sheetCount, last: Math.round(evaluated[0].stat.lastSheetArea) } : null,
      modes, diversity: distinct.size, pop: evaluated ? evaluated.length : 0, migrantsIn,
    })
    lastStats = now; statsIter = iter
  }
  const stopNow = () => !!(shouldStop && shouldStop())
  const maybeReport = (force = false) => {
    if (!onProgress || !best || (!dirty && !force)) return
    const now = Date.now()
    if (!force && now - lastReport < 300) return
    lastReport = now; dirty = false
    const sheets = cuttingMethod !== 'guillotine' ? wideNarrowWideAll(gravityAll(best.sheets), usableX, usableY) : best.sheets
    // genome — порядок деталей + режим: по нему соседние потоки воспроизводят вариант у себя
    const genome = best.order ? { ids: best.order.map(p => p.id), mode: best.mode } : null
    onProgress({ sheets, iter, genome })
  }
  const bestPerMode = {}     // лучший порядок ОТДЕЛЬНО по каждому режиму — не только глобальный лидер
  const bestStatPerMode = {}

  const packAndEval = (order, mode) => {
    let sheets = packAttempt(order, mode, direction, usableX, usableY)
    sheets = compactUntilStable(sheets, direction, usableX, usableY)
    const stat = evaluate(sheets, usableX, usableY)
    return { sheets, stat }
  }

  const tryAttempt = (order, mode) => {
    const result = packAndEval(order, mode)
    iter++
    if (!best || better(result.stat, best.stat)) { best = { ...result, order, mode }; bestOrder = { order, mode }; dirty = true }
    if (iter === 1) maybeReport(true) // первая картинка — сразу после первой попытки, а не после всех структурных
    if (!bestStatPerMode[mode] || better(result.stat, bestStatPerMode[mode])) {
      bestStatPerMode[mode] = result.stat
      bestPerMode[mode] = order
    }
  }

  for (const sortFn of sortStrategies) {
    const sorted = basePieces.slice().sort(sortFn)
    for (const mode of scoringModes) tryAttempt(sorted, mode)
  }
  // Большой заказ из повторяющихся деталей — сначала раскрой «шаблонами»
  // (ЛП + генерация столбцов, см. colgenPack): на 1175 деталях 119 листов за
  // ~15 с, генетическому поиску на это нужно ~10 минут. Дальше дожим работает
  // уже от этого решения.
  let pool = null, pooledBest = null, poolSolvedAt = Date.now(), poolSizeAtSolve = 0
  if (BIG_ORDER && cuttingMethod !== 'guillotine' && !stopNow()) {
    const kinds = new Set(basePieces.map(p => p.detailIndex)).size
    if (kinds <= 150 && basePieces.length / kinds >= 3) {
      try {
        const cgMs = basePieces.length > 600 ? 15000 : 8000
        const cg = await colgenPack(basePieces, scoringModes.filter(m => !m.startsWith('g-')), direction, usableX, usableY, cgMs, Math.random, stopNow)
        pool = cg.pool
        if (cg && validLayout(cg.sheets)) {
          const st = evaluate(cg.sheets, usableX, usableY)
          if (better(st, best.stat)) { best = { ...best, sheets: cg.sheets, stat: st }; dirty = true; maybeReport(true) }
        }
      } catch (e) { console.warn('Раскрой шаблонами не удался:', e) }
    }
  }
  // Случайные перестановки — не дольше RANDOM_PHASE_MS: на 1175 деталях одна
  // укладка ~0,14 с, и 80×8 попыток съедали первые ~90 с (а случайный порядок
  // почти никогда не лучше сортировок и генетического поиска)
  const randomStart = Date.now()
  for (let i = 0; i < RANDOM_ATTEMPTS; i++) {
    const shuffled = shuffle(basePieces.slice())
    for (const mode of scoringModes) tryAttempt(shuffled, mode)
    if (i % 20 === 0 || BIG_ORDER) { maybeReport(); maybeStats(); await new Promise(r => setTimeout(r, 0)) }
    if (stopNow() || Date.now() - randomStart > RANDOM_PHASE_MS) break
  }
  maybeReport(true)
  phase = 'ga'

  // Генетический алгоритм поверх ЕДИНОЙ популяции особей "порядок + режим".
  // Раньше время бюджета делилось ПОРОВНУ между 4 режимами (MaxRects/Guillotine
  // × BSSF/BAF), даже если для конкретного заказа один из них явно проигрывал —
  // ¾ бюджета уходило впустую на заведомо более слабые ветки. Теперь режим —
  // это тоже "ген" каждой особи: наследуется от одного из родителей при
  // скрещивании, изредка мутирует (шанс сменить семью целиком). Турнирный
  // отбор естественным образом вытесняет из популяции слабую семью и отдаёт
  // ей всё меньше "места" — эволюция сама перераспределяет вычислительный
  // бюджет в пользу того, что реально выигрывает для ЭТОГО набора деталей,
  // а не тратит его поровну вслепую.
  const HILL_CLIMB_BUDGET_MS = Math.max(0, Number(optimizeSeconds) || 0) * 1000 // из настроек раскроя, 0 = без доп. оптимизации
  const YIELD_EVERY_GEN = 2 // раз в столько поколений отдаём управление браузеру
  const SQUEEZE_PER_GEN = 700 // попыток дожима последнего листа на поколение
  let sqCur = null, sqBase = null  // текущее состояние дожима и от какого лучшего оно пошло
  let lastGain = Date.now()         // когда последний раз улучшился лучший вариант

  const POP_SIZE = BIG_ORDER ? 16 : 40
  const ELITE_COUNT = BIG_ORDER ? 2 : 4
  const TOURNAMENT_SIZE = 4
  const MUTATION_RATE = 0.35
  const MODE_MUTATION_RATE = 0.1 // шанс сменить семью целиком при мутации — поддерживает разнообразие семей в популяции

  // Начальная популяция: лучший порядок для КАЖДОГО режима (из структурной/
  // случайной фазы) плюс случайные особи со случайным режимом — сразу
  // представлены все семьи, дальше отбор решает, кому остаться.
  population = scoringModes.map(mode => ({ order: (bestPerMode[mode] || shuffle(basePieces.slice())).slice(), mode }))
  while (population.length < POP_SIZE) {
    population.push({ order: shuffle(basePieces.slice()), mode: scoringModes[Math.floor(Math.random() * scoringModes.length)] })
  }

  evaluated = population.map(ind => ({ ...ind, ...packAndEval(ind.order, ind.mode) }))
  evaluated.sort((a, b) => better(a.stat, b.stat) ? -1 : 1)
  if (better(evaluated[0].stat, best.stat)) { best = evaluated[0]; dirty = true }

  const startTime = Date.now()
  // Онлайн-режим (shouldStop задан): бюджет времени задаёт вызывающий
  // (обычно «бесконечный»), поиск идёт до нажатия «Стоп»
  while (Date.now() - startTime < HILL_CLIMB_BUDGET_MS && !stopNow()) {
    gen++
    const genStart = Date.now()
    // Элитизм: лучшие особи переходят в следующее поколение без изменений (вместе со своим режимом).
    const nextGen = evaluated.slice(0, ELITE_COUNT).map(e => ({ order: e.order, mode: e.mode }))
    while (nextGen.length < POP_SIZE) {
      const parentA = tournamentSelect(evaluated, TOURNAMENT_SIZE)
      const parentB = tournamentSelect(evaluated, TOURNAMENT_SIZE)
      let childOrder = orderCrossover(parentA.order, parentB.order)
      if (Math.random() < MUTATION_RATE) childOrder = perturbOrder(childOrder, false)
      // Режим наследуется от одного из родителей — от более удачного чуть чаще, чем 50/50.
      let childMode = better(parentA.stat, parentB.stat)
        ? (Math.random() < 0.7 ? parentA.mode : parentB.mode)
        : (Math.random() < 0.7 ? parentB.mode : parentA.mode)
      if (Math.random() < MODE_MUTATION_RATE) childMode = scoringModes[Math.floor(Math.random() * scoringModes.length)]
      nextGen.push({ order: childOrder, mode: childMode })
    }
    // Мигрант из соседнего потока — заменяет худшую особь нового поколения
    let migSheets = null
    if (takeMigrant) {
      const m = takeMigrant()
      if (m && Array.isArray(m.ids) && m.ids.length === basePieces.length && scoringModes.includes(m.mode)) {
        const order = m.ids.map(id => pieceById.get(id)).filter(Boolean)
        if (order.length === basePieces.length) { nextGen[nextGen.length - 1] = { order, mode: m.mode }; migrantsIn++ }
      }
      // Вместе с порядком приходит и сама раскладка соседа — уже дожатая и
      // «починенная» (эту работу порядком не передать). Раньше потоки получали
      // только порядок и всё время дожимали свой, худший вариант.
      if (m && Array.isArray(m.sheets) && validLayout(m.sheets)) migSheets = m.sheets
    }
    evaluated = nextGen.map(ind => ({ ...ind, ...packAndEval(ind.order, ind.mode) }))
    iter += evaluated.length
    evaluated.sort((a, b) => better(a.stat, b.stat) ? -1 : 1)
    if (better(evaluated[0].stat, best.stat)) { best = evaluated[0]; dirty = true }
    if (migSheets) {
      const st = evaluate(migSheets, usableX, usableY)
      // Раскладку соседа берём, если она лучше; продолжаем дожимать уже её.
      // dirty не ставим — это не наша находка, обратно её слать незачем.
      if (better(st, best.stat)) { best = { ...best, sheets: migSheets, stat: st }; sqBase = best; sqCur = migSheets; lastGain = Date.now() }
    }
    // Дожим последнего листа у лучшего варианта (см. squeezeLast) — дёшево:
    // укладываются только два листа, а не весь заказ
    // Состояние дожима живёт между поколениями и может «гулять» по плато;
    // в лучший вариант попадает только настоящее улучшение. Если генетический
    // поиск нашёл новый лучший — дожим продолжает уже с него.
    if (best.sheets.length >= 2) {
      if (sqBase !== best) { sqCur = best.sheets; sqBase = best; lastGain = Date.now() }
      // Поиск встал (нет улучшений > 3 с) — почти всё время отдаём дожиму,
      // а раз в ~5 с без толку возвращаем «гуляющее» состояние к лучшему
      const stalled = Date.now() - lastGain > 2000
      if (stalled && Date.now() - lastGain > 8000 && Math.random() < 0.05) sqCur = best.sheets
      // «мелкие — в центр» не выполнено — сначала чиним это (важнее последнего листа)
      if (best.stat.smallEdge > 0) {
        // сначала дешёвая перестановка в рядах (мелкую — внутрь, соседа — к краю)
        // (для пилы — нет: перестановка в ряду может сломать сквозные резы)
        const swapped = cuttingMethod === 'guillotine' ? best.sheets : stripPermuteAll(rowSwapAll(best.sheets, usableX, usableY), usableX, usableY)
        if (swapped !== best.sheets) {
          const st = evaluate(swapped, usableX, usableY)
          if (better(st, best.stat)) { best = { ...best, sheets: swapped, stat: st }; sqBase = best; sqCur = swapped; dirty = true; lastGain = Date.now() }
        }
      }
      if (best.stat.smallEdge > 0) {
        const fixed = repairSmall(best.sheets, scoringModes, direction, usableX, usableY, stalled ? 60 : 15)
        if (fixed !== best.sheets) {
          const st = evaluate(fixed, usableX, usableY)
          if (better(st, best.stat)) { best = { ...best, sheets: fixed, stat: st }; sqBase = best; sqCur = fixed; dirty = true; lastGain = Date.now() }
        }
      }
      // Время дожиму — не меньше, чем ушло на поколение (на застое — вчетверо
      // больше). На больших заказах (800 деталей, 75 листов) поколение идёт
      // ~1 с, а 700 попыток дожима — доли секунды: лишний лист снимается именно
      // дожимом (260906_009: 76 → 75 л. только на 750-й с), а ему доставалось ~30% времени.
      const genMs = Date.now() - genStart
      const sqDeadline = Date.now() + (BIG_ORDER
        ? Math.min(15000, genMs * (stalled ? 6 : 2))
        : Math.min(8000, genMs * (stalled ? 4 : 1)))
      sqCur = squeezeLast(sqCur, scoringModes, direction, usableX, usableY, stalled ? SQUEEZE_PER_GEN * 2 : SQUEEZE_PER_GEN, true, sqDeadline,
        pool ? res => res.forEach(sh => pool.add(stripEdgeSmall(sh, usableX, usableY))) : null)
      const stat = evaluate(sqCur, usableX, usableY)
      if (better(stat, best.stat)) { best = { ...best, sheets: sqCur, stat }; sqBase = best; dirty = true; lastGain = Date.now() }
    }
    // Пул шаблонов: листы каждой новой лучшей раскладки — в пул; раз в ~6 с
    // (если пул пополнился) — ЛП по пулу и целое решение. Перекомбинация лучших
    // листов разных раскладок часто даёт лист меньше, чем дожим одной раскладки.
    if (pool) {
      if (pooledBest !== best.sheets) { pooledBest = best.sheets; best.sheets.forEach(sh => pool.add(stripEdgeSmall(sh, usableX, usableY))) }
      if (Date.now() - poolSolvedAt > 6000 && pool.size > poolSizeAtSolve) {
        poolSolvedAt = Date.now(); poolSizeAtSolve = pool.size
        try {
          const sol = pool.solve(300)
          if (sol && validLayout(sol)) {
            const st = evaluate(sol, usableX, usableY)
            if (better(st, best.stat)) { best = { ...best, sheets: sol, stat: st }; sqBase = best; sqCur = sol; dirty = true; lastGain = Date.now() }
          }
        } catch (e) { console.warn('ЛП по пулу шаблонов не удалась:', e) }
      }
    }
    // Отдаём управление браузеру, чтобы страница не "подвисала" на весь расчёт.
    if (gen % YIELD_EVERY_GEN === 0) { maybeReport(); maybeStats(); await new Promise(r => setTimeout(r, 0)) }
  }

  // Финальная "интенсификация": компакция выше по коду всегда обходит детали
  // листа в одном и том же порядке (как они туда легли), из-за чего может
  // упускать перестановки, которые нашлись бы при другом порядке обхода.
  // Здесь пробуем много раз со случайным порядком обхода поверх УЖЕ лучшего
  // найденного решения — дёшево (компакция сама по себе быстрая операция),
  // но может дожать последний лист чуть плотнее.
  phase = 'final'
  maybeStats(true)
  best.sheets = await intensifyCompaction(best.sheets, direction, usableX, usableY)

  // Финальная стяжка к нулю листа с зазором ровно kerf между деталями.
  // Для форматно-раскроечного станка не применяется: там раскладка обязана
  // оставаться набором сквозных резов, а сдвиг отдельной детали их ломает.
  // узкие детали — от края: переукладка каждого листа (тот же состав, тот же лист)
  if (cuttingMethod !== 'guillotine') best.sheets = best.sheets.map((sh, i, all) => relayoutForEdges(sh, scoringModes.filter(m => !m.startsWith('g-')), direction, usableX, usableY, BIG_ORDER ? 40 : 300, i === all.length - 1))
  if (cuttingMethod !== 'guillotine') best.sheets = wideNarrowWideAll(gravityAll(best.sheets), usableX, usableY)
  // стяжка могла открыть новые случаи «мелкая у края, сосед того же размера внутри»
  if (cuttingMethod !== 'guillotine') best.sheets = stripPermuteAll(rowSwapAll(best.sheets, usableX, usableY), usableX, usableY)
  // Страховка: признаки «мелкая» и её пороги — заново из исходных деталей (по id),
  // чтобы ни один шаг укладки не мог их потерять (на них держатся проверка и подсветка)
  best.sheets = best.sheets.map(sh => ({
    ...sh,
    placed: sh.placed.map(p => {
      const src = pieceById.get(p.id)
      return src ? { ...p, isSmall: src.isSmall, edgeOkMax: src.edgeOkMax || 0, edgeMin: src.edgeMin || 0, kf: src.kf || 0 } : p
    }),
  }))

  return { sheets: best.sheets, usableX: realX, usableY: realY, sheetL, sheetW, marginT, marginR, marginB, marginL, kerf }
}

// ─── Дожим последнего листа ─────────────────────────────────────────────────
// Генетический поиск перебирает ПОРЯДОК всех деталей заказа и улучшает
// последний лист лишь косвенно — поэтому результат от запуска к запуску
// гуляет (260906_009: 18% в удачный раз, 21–26% обычно). Дожим работает прямо
// с раскладкой: берём один из заполненных листов и последний, детали обоих
// заново укладываем в два листа так, чтобы первый был забит до предела, а на
// последний ушло как можно меньше. Число листов и детали не меняются —
// последний лист только худеет (или исчезает совсем).
function placedToPiece(p) {
  return {
    id: p.id, detailIndex: p.detailIndex, pw: p.w, ph: p.h, origX: p.origX, origY: p.origY, rot0: p.rotation ?? (p.rotated ? 90 : 0),
    rotatable: p.rotatable, label: p.label, prefix: p.prefix, isSmall: p.isSmall, edgeOkMax: p.edgeOkMax || 0, edgeMin: p.edgeMin || 0, kf: p.kf || 0,
    edgeTop: p.edgeTop, edgeRight: p.edgeRight, edgeBottom: p.edgeBottom, edgeLeft: p.edgeLeft,
  }
}
const sheetArea = sh => sh.placed.reduce((a, p) => a + p.w * p.h, 0)
function squeezeLast(sheets, modes, direction, usableX, usableY, attempts, allowEqual = false, deadline = 0, onAccept = null) {
  let cur = sheets
  let improved = false
  // не меньше attempts попыток, а если задан deadline — и дальше, до него
  for (let a = 0; (a < attempts || (a % 25 !== 0 || Date.now() < deadline)) && cur.length >= 2; a++) {
    const n = cur.length - 1
    // 1 или 2 заполненных листа + последний. Чаще берём листы, где свободнее
    // (туда проще «впихнуть» детали с последнего).
    const rk = Math.random()
    const k = Math.min(n, rk < 0.4 ? 1 : rk < 0.8 ? 2 : 3)
    const pick = () => {
      let j = Math.floor(Math.random() * n)
      if (Math.random() < 0.5) {
        const j2 = Math.floor(Math.random() * n)
        if (sheetArea(cur[j2]) < sheetArea(cur[j])) j = j2
      }
      return j
    }
    const idx = [pick()]
    for (let g = 0; idx.length < k && g < 12; g++) { const j = pick(); if (!idx.includes(j)) idx.push(j) }
    const pool = idx.flatMap(j => cur[j].placed).concat(cur[n].placed).map(placedToPiece)
    const r = Math.random()
    const order = r < 0.3 ? pool.sort((x, y) => y.pw * y.ph - x.pw * x.ph)
      : r < 0.75 ? perturbOrder(pool.sort((x, y) => y.pw * y.ph - x.pw * x.ph), Math.random() < 0.5)
      : shuffle(pool)
    const mode = modes[Math.floor(Math.random() * modes.length)]
    const res = packAttempt(order, mode, direction, usableX, usableY)
    if (res.length > idx.length + 1) continue
    // «Мелкие — в центр»: перекладка не должна добавлять мелких деталей у края
    const oldSheets = idx.map(j => cur[j]).concat([cur[n]])
    if (smallAtEdge(res, usableX, usableY) > smallAtEdge(oldSheets, usableX, usableY)) continue
    // Самый лёгкий из новых листов — последний, остальные встают на места взятых
    res.sort((x, y) => sheetArea(y) - sheetArea(x))
    const newLast = res.length === idx.length + 1 ? sheetArea(res[res.length - 1]) : 0
    // allowEqual — «боковой» ход: последний лист не меньше, но состав
    // заполненных листов другой — это открывает новые возможности следующим
    // попыткам (иначе дожим застревает на плато)
    if (newLast < sheetArea(cur[n]) - 1 || (allowEqual && res.length === idx.length + 1 && newLast <= sheetArea(cur[n]) + 1)) {
      const next = cur.slice()
      idx.forEach((j, t) => { next[j] = { ...res[t], index: cur[j].index } })
      if (res.length === idx.length + 1) next[n] = { ...res[res.length - 1], index: cur[n].index }
      else next.splice(n, 1)
      cur = next
      improved = true
      onAccept?.(res)
    }
  }
  return improved ? cur : sheets
}

// ─── Перестановка в ряду: мелкую деталь — внутрь, соседа — к краю ───────────
// Частый случай: у края листа стоит узкая полоса, а рядом с ней — деталь того
// же размера по другой оси (ряд одинаковой высоты/ширины). Поменять их местами
// — и мелкая уже не у края. Перекладка листа целиком (repairSmall) находит это
// лишь случайно. Здесь ряд деталей одинаковой высоты (или ширины), стоящих
// вплотную, переставляется: мелкая встаёт на каждое место в ряду, берётся
// вариант, где у края меньше всего мелких. Ряд занимает ту же площадь, что и
// раньше, поэтому свободные места листа (freeRects) не меняются.
function rowSwapRepair(sheet, usableX, usableY) {
  if (!sheet.placed.some(p => p.isSmall)) return sheet
  const placed = sheet.placed.map(p => ({ ...p }))
  const viol = () => {
    let n = 0
    for (const p of placed) if (p.isSmall && smallEdgeSides(p, placed, usableX, usableY) > 0) n++
    return n
  }
  let cur = viol()
  if (!cur) return sheet
  let changed = false
  for (let iter = 0; iter < 30 && cur > 0; iter++) {
    let moved = false
    for (const S of placed) {
      if (!S.isSmall || smallEdgeSides(S, placed, usableX, usableY) === 0) continue
      for (const axis of ['x', 'y']) {
        const pos = q => (axis === 'x' ? q.x : q.y)
        const len = q => (axis === 'x' ? q.w : q.h)
        const set = (q, v) => { if (axis === 'x') q.x = v; else q.y = v }
        const same = q => (axis === 'x'
          ? Math.abs(q.y - S.y) < 0.5 && Math.abs(q.h - S.h) < 0.5
          : Math.abs(q.x - S.x) < 0.5 && Math.abs(q.w - S.w) < 0.5)
        const run = [S]
        for (let edge = pos(S); ;) {
          const q = placed.find(o => !run.includes(o) && same(o) && Math.abs(pos(o) + len(o) - edge) < 0.5)
          if (!q) break
          run.unshift(q); edge = pos(q)
        }
        for (let end = pos(S) + len(S); ;) {
          const q = placed.find(o => !run.includes(o) && same(o) && Math.abs(pos(o) - end) < 0.5)
          if (!q) break
          run.push(q); end = pos(q) + len(q)
        }
        if (run.length < 2) continue
        const start = pos(run[0])
        const saved = run.map(pos)
        const others = run.filter(q => q !== S)
        let bestOrder = null, bestV = cur
        for (let i = 0; i <= others.length; i++) {
          const order = others.slice(0, i).concat([S], others.slice(i))
          let c = start
          order.forEach(q => { set(q, c); c += len(q) })
          const v = viol()
          if (v < bestV) { bestV = v; bestOrder = order }
        }
        if (bestOrder) {
          let c = start
          bestOrder.forEach(q => { set(q, c); c += len(q) })
          cur = bestV; moved = changed = true
          break
        }
        run.forEach((q, k) => set(q, saved[k]))
      }
      if (moved) break
      // Сосед вплотную, но другого размера (мелкая полоса у края, рядом деталь
      // крупнее): меняем их местами вдоль оси — крупная встаёт к краю (своим
      // краем туда, где был край мелкой), мелкая — на место крупной. Каждая
      // сохраняет свою вторую координату. Берём, если обе влезают, ни с кем не
      // пересекаются и мелких у края стало меньше.
      const overlapsOthers = (q, skip) => placed.some(o => o !== q && !skip.includes(o) &&
        o.x < q.x + q.w - 0.01 && q.x < o.x + o.w - 0.01 && o.y < q.y + q.h - 0.01 && q.y < o.y + o.h - 0.01)
      for (const B of placed) {
        if (B === S) continue
        let done = false
        for (const axis of ['x', 'y']) {
          const P = q => (axis === 'x' ? q.x : q.y), L = q => (axis === 'x' ? q.w : q.h)
          const setP = (q, v) => { if (axis === 'x') q.x = v; else q.y = v }
          // перекрываются ли по другой оси (иначе это не соседи в ряду)
          const o1 = axis === 'x' ? Math.min(S.y + S.h, B.y + B.h) - Math.max(S.y, B.y) : Math.min(S.x + S.w, B.x + B.w) - Math.max(S.x, B.x)
          if (o1 <= 0.5) continue
          const touchLeft = Math.abs(P(B) + L(B) - P(S)) < 0.5   // B перед S
          const touchRight = Math.abs(P(S) + L(S) - P(B)) < 0.5  // B после S
          if (!touchLeft && !touchRight) continue
          const sv = [S.x, S.y, B.x, B.y]
          const lo = Math.min(P(S), P(B)), hi = Math.max(P(S) + L(S), P(B) + L(B))
          if (touchLeft) { setP(S, lo); setP(B, hi - L(B)) } else { setP(B, lo); setP(S, hi - L(S)) }
          const lim = axis === 'x' ? usableX : usableY
          const ok = P(S) >= -0.01 && P(B) >= -0.01 && P(S) + L(S) <= lim + 0.01 && P(B) + L(B) <= lim + 0.01 &&
            !overlapsOthers(S, [B]) && !overlapsOthers(B, [S]) &&
            !(S.x < B.x + B.w - 0.01 && B.x < S.x + S.w - 0.01 && S.y < B.y + B.h - 0.01 && B.y < S.y + S.h - 0.01)
          const v = ok ? viol() : Infinity
          if (v < cur) { cur = v; moved = changed = true; done = true; break }
          S.x = sv[0]; S.y = sv[1]; B.x = sv[2]; B.y = sv[3]
        }
        if (done) break
      }
      if (moved) break
    }
    if (!moved) break
  }
  if (!changed) return sheet
  // свободные места заново: перестановка соседей разного размера меняет занятую площадь
  const next = { ...sheet, placed, family: 'maxrects', freeRects: [{ x: 0, y: 0, w: usableX, h: usableY }] }
  placed.forEach(pp => { split(next, pp); prune(next) })
  updateFreeBounds(next)
  return next
}
const rowSwapAll = (sheets, usableX, usableY) => {
  let changed = false
  const out = sheets.map(sh => { const r = rowSwapRepair(sh, usableX, usableY); if (r !== sh) changed = true; return r })
  return changed ? out : sheets
}

// ─── Перестановка полос листа: мелкие — внутрь без перекладки ───────────────
// Плотная раскладка почти всегда режется на полосы (колонки/ряды, внутри —
// снова полосы). Если переставить полосы местами (и зеркально отразить), лист
// остаётся тем же по составу и плотности, детали не пересекаются, а мелкие
// уходят от края: полоса с мелкими — в середину, пустое место и полосы из
// крупных — к краям. Так можно сначала раскроить без правила «мелкие — в
// центр» (плотнее и быстрее), а потом довести мелкие до середины.
function buildCutTree(parts, x0, y0, x1, y1, depth = 0) {
  const node = { x0, y0, x1, y1, parts, kids: null, dir: null }
  if (parts.length <= 1 || depth > 12) return node
  for (const dir of ['v', 'h']) {
    const lo = p => (dir === 'v' ? p.x : p.y), hi = p => (dir === 'v' ? p.x + p.w : p.y + p.h)
    const a0 = dir === 'v' ? x0 : y0, a1 = dir === 'v' ? x1 : y1
    // разрезы: позиции, которые не пересекает ни одна деталь
    const cand = [...new Set(parts.flatMap(p => [lo(p), hi(p)]))].filter(c => c > a0 + 0.01 && c < a1 - 0.01).sort((a, b) => a - b)
    const cuts = cand.filter(c => parts.every(p => hi(p) <= c + 0.01 || lo(p) >= c - 0.01))
    if (!cuts.length) continue
    const bounds = [a0, ...cuts, a1]
    const kids = []
    for (let i = 0; i + 1 < bounds.length; i++) {
      const b0 = bounds[i], b1 = bounds[i + 1]
      const ps = parts.filter(p => lo(p) >= b0 - 0.01 && hi(p) <= b1 + 0.01)
      kids.push(dir === 'v' ? buildCutTree(ps, b0, y0, b1, y1, depth + 1) : buildCutTree(ps, x0, b0, x1, b1, depth + 1))
    }
    node.kids = kids; node.dir = dir
    return node
  }
  return node
}
// Сдвинуть поддерево на (dx, dy) и/или отразить внутри своего прямоугольника
function moveTree(node, dx, dy) {
  node.x0 += dx; node.x1 += dx; node.y0 += dy; node.y1 += dy
  if (node.kids) node.kids.forEach(k => moveTree(k, dx, dy))
  else node.parts.forEach(p => { p.x += dx; p.y += dy })
}
function layoutKids(node, order) {
  let c = node.dir === 'v' ? node.x0 : node.y0
  for (const k of order) {
    const len = node.dir === 'v' ? k.x1 - k.x0 : k.y1 - k.y0
    if (node.dir === 'v') moveTree(k, c - k.x0, 0); else moveTree(k, 0, c - k.y0)
    c += len
  }
  node.kids = order
}
function permutations(arr, limit = 120) {
  const out = []
  const rec = (rest, acc) => { if (out.length >= limit) return; if (!rest.length) { out.push(acc); return } rest.forEach((x, i) => rec(rest.slice(0, i).concat(rest.slice(i + 1)), acc.concat([x]))) }
  rec(arr, [])
  return out
}
// ─── Порядок полос для фрезера: широкая → узкая ← широкая ───────────────────
// На ЧПУ-фрезере лист держится вакуумом, и узкие полосы у края листа срывает.
// Поэтому полосы раскладки (колонки и ряды, на каждом уровне дерева резов)
// встают так: самые широкие — по краям, самые узкие — в середине. Состав листа
// и плотность не меняются (полосы только меняются местами), пустое место
// остаётся в конце — цельным остатком. Работает по обеим осям.
// Если включено «мелкие — в центр», перестановка не должна добавлять мелких у края.
function wideNarrowWide(sheet, usableX, usableY) {
  if (sheet.placed.length < 3) return sheet
  const placed = sheet.placed.map(p => ({ ...p }))
  const root = buildCutTree(placed, 0, 0, usableX, usableY)
  if (!root.kids) return sheet
  const hasSmall = placed.some(p => p.isSmall)
  const viol = () => { let n = 0; for (const p of placed) if (p.isSmall && smallEdgeSides(p, placed, usableX, usableY) > 0) n++; return n }
  let changed = false
  const visit = node => {
    if (!node.kids) return
    const thick = k => (node.dir === 'v' ? k.x1 - k.x0 : k.y1 - k.y0)
    const full = node.kids.filter(k => k.parts.length), empty = node.kids.filter(k => !k.parts.length)
    if (full.length >= 3) {
      const sorted = full.slice().sort((a, b) => thick(b) - thick(a))
      const left = [], right = []
      sorted.forEach((k, i) => { if (i % 2 === 0) left.push(k); else right.unshift(k) })
      const order = left.concat(right, empty)
      if (order.some((k, i) => k !== node.kids[i])) {
        const orig = node.kids.slice()
        const before = hasSmall ? viol() : 0
        layoutKids(node, order)
        if (hasSmall && viol() > before) layoutKids(node, orig)
        else changed = true
      }
    }
    node.kids.forEach(visit)
  }
  visit(root)
  if (!changed) return sheet
  const next = { ...sheet, placed, family: 'maxrects', freeRects: [{ x: 0, y: 0, w: usableX, h: usableY }] }
  placed.forEach(pp => { split(next, pp); prune(next) })
  updateFreeBounds(next)
  return next
}
const wideNarrowWideAll = (sheets, usableX, usableY) => sheets.map(sh => wideNarrowWide(sh, usableX, usableY))
// Насколько лист «узкими полосами к краю»: для каждой детали у края листа —
// длина её стороны вдоль края × насколько она тонкая поперёк (тоньше NARROW_T мм).
// 0 — у краёв только широкие детали. Меньше — лучше (для фрезера).
const NARROW_T = 300
function narrowEdgeScore(sheet, usableX, usableY) {
  let sc = 0
  for (const p of sheet.placed) {
    const tx = Math.max(0, 1 - p.w / NARROW_T), ty = Math.max(0, 1 - p.h / NARROW_T)
    // «у края» — и вплотную, и через полоску отхода до 80 мм (она деталь не держит)
    if (tx > 0 && (p.x < 80 || p.x + p.w > usableX - 80)) sc += p.h * tx
    if (ty > 0 && (p.y < 80 || p.y + p.h > usableY - 80)) sc += p.w * ty
  }
  return sc
}
// ─── Переукладка листа «узкие — не к краю» ──────────────────────────────────
// Те же детали того же листа раскладываются заново несколько раз (разный
// порядок и режимы); берётся раскладка, где у краёв меньше узких деталей
// (narrowEdgeScore после перестановки полос). Лист остаётся одним листом —
// плотность и число листов не меняются. Мелких у края не прибавляется, занятая
// часть листа не растёт (цельный остаток не дробится). Работает на любых
// заказах, в конце расчёта.
function relayoutForEdges(sheet, modes, direction, usableX, usableY, tries = 40, keepEnv = false) {
  if (sheet.placed.length < 3) return sheet
  const env = sh => { let mx = 0, my = 0; for (const p of sh.placed) { mx = Math.max(mx, p.x + p.w); my = Math.max(my, p.y + p.h) } return mx * my }
  let best = wideNarrowWide(sheet, usableX, usableY)
  let bestScore = narrowEdgeScore(best, usableX, usableY)
  if (bestScore < 1) return best
  const small0 = smallAtEdge([best], usableX, usableY), env0 = env(best) * 1.02
  const base = sheet.placed.map(placedToPiece)
  for (let t = 0; t < tries && bestScore >= 1; t++) {
    const r = Math.random()
    const sorted = base.slice().sort((x, y) => y.pw * y.ph - x.pw * x.ph)
    const order = t === 0 ? sorted
      : r < 0.35 ? base.slice().sort((x, y) => Math.min(y.pw, y.ph) - Math.min(x.pw, x.ph)) // широкие вперёд
      : r < 0.75 ? perturbOrder(sorted, Math.random() < 0.5)
      : shuffle(base.slice())
    const res = packAttempt(order, modes[t % modes.length], direction, usableX, usableY)
    if (res.length !== 1) continue
    const cand = wideNarrowWide(res[0], usableX, usableY)
    const sc = narrowEdgeScore(cand, usableX, usableY)
    if (sc >= bestScore - 1) continue
    if (smallAtEdge([cand], usableX, usableY) > small0 || (keepEnv && env(cand) > env0)) continue
    best = { ...cand, index: sheet.index }; bestScore = sc
  }
  return best
}
function stripPermuteRepair(sheet, usableX, usableY, rand = Math.random) {
  if (!sheet.placed.some(p => p.isSmall)) return sheet
  const placed = sheet.placed.map(p => ({ ...p }))
  const viol = () => { let n = 0; for (const p of placed) if (p.isSmall && smallEdgeSides(p, placed, usableX, usableY) > 0) n++; return n }
  let cur = viol()
  if (!cur) return sheet
  const root = buildCutTree(placed, 0, 0, usableX, usableY)
  const nodes = []
  const walk = n => { if (n.kids) { nodes.push(n); n.kids.forEach(walk) } }
  walk(root)
  if (!nodes.length) return sheet
  for (let pass = 0; pass < 3 && cur > 0; pass++) {
    let improved = false
    for (const node of nodes) {
      const orig = node.kids.slice()
      let perms = orig.length <= 5 ? permutations(orig) : null
      if (!perms) {
        perms = [orig.slice().reverse()]
        for (let r = 0; r < 40; r++) { const a = orig.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] } perms.push(a) }
      }
      let bestOrder = null
      for (const ord of perms) {
        layoutKids(node, ord)
        const v = viol()
        if (v < cur) { cur = v; bestOrder = ord }
      }
      layoutKids(node, bestOrder || orig)
      if (bestOrder) improved = true
      if (!cur) break
    }
    if (!improved) break
  }
  const next = { ...sheet, placed, family: 'maxrects', freeRects: [{ x: 0, y: 0, w: usableX, h: usableY }] }
  placed.forEach(pp => { split(next, pp); prune(next) })
  updateFreeBounds(next)
  return next
}
// Обмен одинаковыми по размеру блоками между листами: блок (полоса/группа)
// с мелкими у края на листе A меняется местами с таким же по размеру блоком
// без мелких на листе B, если там мелкие окажутся внутри. Листы сами по себе
// не перекладываются — состав и плотность те же, меняется только, где какая
// группа деталей стоит. Так мелкие «расходятся» по листам: на листе, где их
// целая сетка (400×400 ×12), часть уезжает внутрь других листов.
function blockSwapRepair(sheets, usableX, usableY, maxSwaps = 200) {
  const S = sheets.map(sh => ({ ...sh, placed: sh.placed.map(p => ({ ...p })) }))
  const violOf = list => { let n = 0; for (const p of list) if (p.isSmall && smallEdgeSides(p, list, usableX, usableY) > 0) n++; return n }
  const v = S.map(sh => violOf(sh.placed))
  let swaps = 0, changed = new Set()
  const key = n => Math.round((n.x1 - n.x0) * 2) + 'x' + Math.round((n.y1 - n.y0) * 2)
  for (let round = 0; round < 6 && swaps < maxSwaps; round++) {
    // все блоки всех листов
    const byKey = new Map()
    const trees = S.map((sh, si) => {
      const root = buildCutTree(sh.placed, 0, 0, usableX, usableY)
      const walk = n => {
        if (n !== root && n.parts.length) { const k = key(n); if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push({ si, n }) }
        if (n.kids) n.kids.forEach(walk)
      }
      walk(root)
      return root
    })
    let any = false
    for (let si = 0; si < S.length && swaps < maxSwaps; si++) {
      if (!v[si]) continue
      // блоки листа si, где есть мелкая у края
      const bad = []
      const walk = n => { if (n !== trees[si] && n.parts.some(p => p.isSmall && smallEdgeSides(p, S[si].placed, usableX, usableY) > 0)) bad.push(n); if (n.kids) n.kids.forEach(walk) }
      walk(trees[si])
      bad.sort((a, b) => (a.x1 - a.x0) * (a.y1 - a.y0) - (b.x1 - b.x0) * (b.y1 - b.y0)) // сначала мелкие блоки
      let done = false
      for (const X of bad) {
        const cands = byKey.get(key(X)) || []
        for (const { si: sj, n: Y } of cands) {
          if (sj === si || Y.parts.length === 0) continue
          if (Y.parts === X.parts) continue
          const dx = Y.x0 - X.x0, dy = Y.y0 - X.y0
          const xIds = new Set(X.parts.map(p => p.id)), yIds = new Set(Y.parts.map(p => p.id))
          const A2 = S[si].placed.filter(p => !xIds.has(p.id)).concat(Y.parts.map(p => ({ ...p, x: p.x - dx, y: p.y - dy })))
          const B2 = S[sj].placed.filter(p => !yIds.has(p.id)).concat(X.parts.map(p => ({ ...p, x: p.x + dx, y: p.y + dy })))
          const va = violOf(A2), vb = violOf(B2)
          if (va + vb < v[si] + v[sj]) {
            S[si].placed = A2; S[sj].placed = B2; v[si] = va; v[sj] = vb
            changed.add(si); changed.add(sj); swaps++; any = true; done = true
            break
          }
        }
        if (done) break
      }
    }
    if (!any) break
  }
  if (!changed.size) return sheets
  return S.map((sh, i) => {
    if (!changed.has(i)) return sheets[i]
    const next = { ...sh, family: 'maxrects', freeRects: [{ x: 0, y: 0, w: usableX, h: usableY }] }
    next.placed.forEach(pp => { split(next, pp); prune(next) })
    updateFreeBounds(next)
    return next
  })
}
// Починка «островами»: лист с мелкими у края + 1–2 соседних листа
// раскладываются заново — в каждом листе мелкие собираются в блок внутри,
// крупные вокруг (packBlockSheet), мелкие делятся между листами поровну.
// Берётся, если листов столько же, а мелких у края меньше.
function repairSmallBlocks(sheets, modes, direction, usableX, usableY, attempts, rand = Math.random) {
  let cur = sheets
  const violOf = sh => smallAtEdge([sh], usableX, usableY)
  for (let a = 0; a < attempts; a++) {
    const bad = []
    cur.forEach((sh, i) => { if (violOf(sh) > 0) bad.push(i) })
    if (!bad.length) break
    const idx = [bad[Math.floor(rand() * bad.length)]]
    const extra = rand() < 0.4 ? 1 : 2
    for (let g = 0; idx.length < 1 + extra && g < 20; g++) {
      const j = Math.floor(rand() * cur.length)
      if (!idx.includes(j)) idx.push(j)
    }
    const k = idx.length
    const before = idx.reduce((t, j) => t + violOf(cur[j]), 0)
    const pool = idx.flatMap(j => cur[j].placed).map(placedToPiece)
    const smalls = shuffle(pool.filter(p => p.isSmall)), bigs = pool.filter(p => !p.isSmall)
    let rest = bigs.sort((x, y) => y.pw * y.ph - x.pw * x.ph)
    if (rand() < 0.5) rest = perturbOrder(rest, rand() < 0.5)
    let smallLeft = smalls.slice()
    const out = []
    for (let i = 0; i < k; i++) {
      const share = Math.ceil(smallLeft.length / (k - i))
      const mySmalls = smallLeft.slice(0, share)
      const mode = modes[Math.floor(rand() * modes.length)]
      const sh = (mySmalls.length ? packBlockSheet : packOneSheet)(rest.concat(mySmalls), mode, direction, usableX, usableY, rand)
      const ids = new Set(sh.placed.map(p => p.id))
      rest = rest.filter(p => !ids.has(p.id))
      smallLeft = smallLeft.filter(p => !ids.has(p.id))
      out.push(sh)
    }
    if (rest.length || smallLeft.length) continue // не влезло в те же листы
    const after = out.reduce((t, sh) => t + violOf(sh), 0)
    if (after >= before) continue
    const next = cur.slice()
    idx.forEach((j, t) => { next[j] = { ...out[t], index: cur[j].index } })
    cur = next
  }
  return cur
}
const stripPermuteAll = (sheets, usableX, usableY) => {
  let changed = false
  const out = sheets.map(sh => {
    const before = smallAtEdge([sh], usableX, usableY)
    if (!before) return sh
    const r = stripPermuteRepair(sh, usableX, usableY)
    if (r !== sh && smallAtEdge([r], usableX, usableY) < before) { changed = true; return r }
    return sh
  })
  return changed ? out : sheets
}

// ─── Починка «мелкие у края» ────────────────────────────────────────────────
// Лист, где мелкая/узкая деталь стоит у края, вместе с ещё 0–2 листами
// раскладывается заново (мелкие — после крупных). Принимается, если мелких у
// края стало меньше, а листов не больше (последний лист при этом может стать
// полнее — требование важнее заполнения последнего листа, см. better()).
function repairSmall(sheets, modes, direction, usableX, usableY, attempts) {
  let cur = sheets
  let curStat = evaluate(cur, usableX, usableY)
  for (let a = 0; a < attempts && curStat.smallEdge > 0; a++) {
    const bad = []
    cur.forEach((sh, i) => { if (smallAtEdge([sh], usableX, usableY) > 0) bad.push(i) })
    if (!bad.length) break
    const idx = [bad[Math.floor(Math.random() * bad.length)]]
    const extra = Math.random() < 0.3 ? 0 : Math.random() < 0.7 ? 1 : 2
    for (let g = 0; idx.length < 1 + extra && g < 10 && cur.length > idx.length; g++) {
      const j = Math.floor(Math.random() * cur.length)
      if (!idx.includes(j)) idx.push(j)
    }
    const pool = idx.flatMap(j => cur[j].placed).map(placedToPiece)
    const r = Math.random()
    const order = r < 0.35 ? pool.sort((x, y) => y.pw * y.ph - x.pw * x.ph)
      : r < 0.75 ? perturbOrder(pool.sort((x, y) => y.pw * y.ph - x.pw * x.ph), Math.random() < 0.5)
      : shuffle(pool)
    const mode = modes[Math.floor(Math.random() * modes.length)]
    const res = packAttempt(order, mode, direction, usableX, usableY)
    if (res.length > idx.length) continue
    // тяжёлые листы — на места взятых по порядку, лёгкий — туда, где был самый лёгкий
    const taken = idx.slice().sort((x, y) => x - y)
    res.sort((x, y) => sheetArea(y) - sheetArea(x))
    const next = cur.slice()
    taken.forEach((j, t) => { next[j] = res[t] ? { ...res[t], index: cur[j].index } : null })
    // листы взаимозаменяемы: самый лёгкий — последним (он и есть «остаток»)
    const compact = next.filter(Boolean).sort((x, y) => sheetArea(y) - sheetArea(x)).map((sh, i) => ({ ...sh, index: i }))
    const st = evaluate(compact, usableX, usableY)
    if (better(st, curStat)) { cur = compact; curStat = st }
  }
  return cur
}

function cloneSheets(sheets) {
  return sheets.map(s => ({
    index: s.index, family: s.family,
    placed: s.placed.map(p => ({ ...p })),
    freeRects: s.freeRects.map(r => ({ ...r })),
    maxFreeW: s.maxFreeW, maxFreeH: s.maxFreeH,
  }))
}

async function intensifyCompaction(sheets, direction, usableX, usableY, attempts = 300) {
  let best = sheets
  let bestStat = evaluate(best, usableX, usableY)
  for (let i = 0; i < attempts; i++) {
    let candidate = cloneSheets(best)
    candidate.forEach(s => shuffle(s.placed))
    candidate = compactUntilStable(candidate, direction, usableX, usableY)
    const stat = evaluate(candidate, usableX, usableY)
    if (better(stat, bestStat)) { best = candidate; bestStat = stat }
    if (i % 30 === 0) await new Promise(r => setTimeout(r, 0))
  }
  return best
}

// Турнирный отбор: берём k случайных особей из популяции, побеждает лучшая
// по тому же критерию better(), что использует и весь остальной алгоритм.
function tournamentSelect(evaluated, k) {
  let winner = null
  for (let i = 0; i < k; i++) {
    const cand = evaluated[Math.floor(Math.random() * evaluated.length)]
    if (!winner || better(cand.stat, winner.stat)) winner = cand
  }
  return winner
}

// Order Crossover (OX) — стандартный метод скрещивания для представлений-перестановок
// (задачи типа TSP, cutting-stock). Берём случайный отрезок у родителя A как есть,
// остальные позиции заполняем генами родителя B по порядку, пропуская уже занятые id.
// Так ребёнок наследует и относительный порядок из A, и из B, а не просто их смесь.
function orderCrossover(parentA, parentB) {
  const n = parentA.length
  let i = Math.floor(Math.random() * n)
  let j = Math.floor(Math.random() * n)
  if (i > j) [i, j] = [j, i]

  const child = new Array(n).fill(null)
  const usedIds = new Set()
  for (let k = i; k <= j; k++) { child[k] = parentA[k]; usedIds.add(parentA[k].id) }

  const emptyPositions = []
  for (let k = 0; k < n; k++) {
    const pos = (j + 1 + k) % n
    if (pos < i || pos > j) emptyPositions.push(pos)
  }

  let ptr = 0
  for (let k = 0; k < n; k++) {
    const gene = parentB[(j + 1 + k) % n]
    if (!usedIds.has(gene.id)) {
      child[emptyPositions[ptr]] = gene
      usedIds.add(gene.id)
      ptr++
    }
  }
  return child
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

// Направленная пертурбация порядка — меняет местами несколько случайных пар,
// а не тасует всё заново. Так локальный поиск исследует окрестность уже
// хорошего решения, а не начинает каждый раз с чистого листа.
// strong=true — более резкая встряска (больше перестановок), когда обычная
// точечная пертурбация долго не даёт улучшений — сигнал, что мы застряли
// в локальном плато и нужен более крупный скачок, чтобы из него выбраться.
function perturbOrder(order, strong = false) {
  const arr = order.slice()
  const swaps = strong
    ? 8 + Math.floor(Math.random() * 15)   // сильная встряска: 8-22 перестановки
    : 1 + Math.floor(Math.random() * 5)    // обычная: 1-5 перестановок
  for (let s = 0; s < swaps; s++) {
    const i = Math.floor(Math.random() * arr.length)
    const j = Math.floor(Math.random() * arr.length)
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

function buildPieces(details, kerf, direction) {
  const pieces = []
  details.forEach((d, di) => {
    for (let q = 0; q < d.qty; q++) {
      pieces.push({
        id: `${di}_${q}`,
        detailIndex: di,
        pw: d.width + kerf,
        ph: d.length + kerf,
        origX: d.width,
        origY: d.length,
        rot0: 0,   // поворот относительно исходной детали, градусы (накапливается: предварительный + при укладке)
        rotatable: d.rotatable,
        freeTurn: !!d.freeTurn, // гибридная пара со второй сцепкой «на боку» — направление укладки её не поворачивает
        label: d.display_name || d.name,
        prefix: d.prefix,
        edgeTop: d.edge_top,
        edgeRight: d.edge_right,
        edgeBottom: d.edge_bottom,
        edgeLeft: d.edge_left,
      })
    }
  })

  pieces.forEach(p => {
    if (!p.rotatable || p.freeTurn) return
    if (direction === 'along_y') {
      if (p.pw > p.ph) rotatePiece(p)
    } else if (direction === 'along_x') {
      if (p.ph > p.pw) rotatePiece(p)
    }
  })

  return pieces
}

function rotatePiece(p) {
  ;[p.pw, p.ph] = [p.ph, p.pw]
  ;[p.origX, p.origY] = [p.origY, p.origX]
  p.rot0 = ((p.rot0 || 0) + 90) % 360
  ;[p.edgeTop, p.edgeRight, p.edgeBottom, p.edgeLeft] = [p.edgeLeft, p.edgeTop, p.edgeRight, p.edgeBottom]
}

// Один полный проход укладки: заданный порядок деталей + заданная эвристика выбора места.
// mode: 'bssf'/'baf' → семья MaxRects; 'g-bssf'/'g-baf' → семья Guillotine.
function packAttempt(sortedPieces, mode, direction, usableX, usableY) {
  const family = mode.startsWith('g-') ? 'guillotine' : 'maxrects'
  const scoreMode = mode.startsWith('g-') ? mode.slice(2) : mode

  const place = (sheet, piece) => {
    if (cannotFit(sheet, piece)) return false
    const result = family === 'guillotine'
      ? chooseSpotGuillotine(sheet.freeRects, piece, direction, usableX, usableY, scoreMode, sheet.placed)
      : chooseSpot(sheet.freeRects, piece, direction, usableX, usableY, scoreMode, sheet.placed)
    if (!result) return false
    sheet.placed.push(result)
    if (family === 'guillotine') { splitGuillotine(sheet, result); delete result._freeRectIdx }
    else { split(sheet, result); prune(sheet) }
    updateFreeBounds(sheet)
    return true
  }

  const sheets = []
  // «Мелкие — в центр»: мелкие детали ставятся ПОСЛЕ крупных (в том же
  // относительном порядке) — тогда видно, какие места уже прикрыты крупными
  // деталями от края листа, и мелкая встаёт между ними, а не к краю.
  if (sortedPieces.some(p => p.isSmall)) sortedPieces = sortedPieces.filter(p => !p.isSmall).concat(sortedPieces.filter(p => p.isSmall))
  for (const piece of sortedPieces) {
    let placed = false
    for (const sheet of sheets) { if (place(sheet, piece)) { placed = true; break } }
    if (!placed) {
      const sheet = { index: sheets.length, placed: [], freeRects: [{ x: 0, y: 0, w: usableX, h: usableY }], family }
      place(sheet, piece)
      sheets.push(sheet)
    }
  }
  return sheets
}

// Компакция: пытаемся перенести детали с последних листов на более ранние,
// если там реально есть место в уже посчитанных freeRects. Учитывает семью
// алгоритма целевого листа (у Guillotine и MaxRects разная структура
// freeRects и разный способ разбиения остатка после вставки).
function compactPass(sheets, direction, usableX, usableY) {
  for (let i = sheets.length - 1; i >= 1; i--) {
    const sheet = sheets[i]
    const remaining = []
    for (const piece of sheet.placed) {
      let moved = false
      const orientations = [{ w: piece.w, h: piece.h, flip: false }]
      if (piece.rotatable && piece.w !== piece.h) orientations.push({ w: piece.h, h: piece.w, flip: true })

      outer:
      for (let j = 0; j < i; j++) {
        const target = sheets[j]
        if (target.maxFreeW !== undefined && Math.min(piece.w, piece.h) > Math.max(target.maxFreeW, target.maxFreeH)) continue
        for (const o of orientations) {
          if (target.maxFreeW !== undefined && (o.w > target.maxFreeW || o.h > target.maxFreeH)) continue
          const makePlaced = () => o.flip
            ? { ...piece, x: 0, y: 0, w: o.w, h: o.h, rotated: !piece.rotated, rotation: ((piece.rotation ?? (piece.rotated ? 90 : 0)) + 90) % 360,
                edgeTop: piece.edgeLeft, edgeRight: piece.edgeTop, edgeBottom: piece.edgeRight, edgeLeft: piece.edgeBottom }
            : { ...piece, x: 0, y: 0 }

          if (target.family === 'guillotine') {
            const spot = fitFixedGuillotine(target.freeRects, o.w, o.h, usableX, usableY, piece.isSmall, direction)
            if (spot && piece.isSmall && smallEdgeSides({ x: spot.x, y: spot.y, w: o.w, h: o.h, edgeOkMax: piece.edgeOkMax, edgeMin: piece.edgeMin }, target.placed, usableX, usableY) > 0) continue
            if (spot) {
              const placed = { ...makePlaced(), x: spot.x, y: spot.y, _freeRectIdx: spot.idx }
              target.placed.push(placed); splitGuillotine(target, placed); delete placed._freeRectIdx
              updateFreeBounds(target)
              moved = true; break outer
            }
          } else {
            const spot = fitFixed(target.freeRects, o.w, o.h, usableX, usableY, piece.isSmall, direction)
            // мелкую деталь не переносим туда, где она окажется у края листа
            if (spot && piece.isSmall && smallEdgeSides({ x: spot.x, y: spot.y, w: o.w, h: o.h, edgeOkMax: piece.edgeOkMax, edgeMin: piece.edgeMin }, target.placed, usableX, usableY) > 0) continue
            if (spot) {
              const placed = { ...makePlaced(), x: spot.x, y: spot.y }
              target.placed.push(placed); split(target, placed); prune(target)
              updateFreeBounds(target)
              moved = true; break outer
            }
          }
        }
      }
      if (!moved) remaining.push(piece)
    }
    sheet.placed = remaining
  }
  return sheets.filter(s => s.placed.length > 0)
}

function compactUntilStable(sheets, direction, usableX, usableY) {
  for (let pass = 0; pass < MAX_COMPACT_PASSES; pass++) {
    const before = sheets.length
    sheets = compactPass(sheets, direction, usableX, usableY)
    if (sheets.length === before) break
  }
  return sheets
}

// Поиск места для уже готового (фиксированного) w×h — используется компакцией,
// где ориентация уже выбрана и повторно не перебирается.
function fitFixed(freeRects, w, h, usableX, usableY, isSmall, direction) {
  let best = null, bestScore = Infinity
  for (const rect of freeRects) {
    if (w > rect.w || h > rect.h) continue
    const score = scoreSpot(rect, w, h, direction, undefined, usableX, usableY, isSmall)
    if (score < bestScore) { bestScore = score; best = { x: rect.x, y: rect.y } }
  }
  return best
}

// ─── «Мелкие — в центр» ──────────────────────────────────────────────────────
// Мелкая или узкая деталь «у края», если от неё до края рабочей зоны меньше
// SMALL_EDGE_MIN мм и этот промежуток не прикрыт другой деталью (там отход).
// Раньше считалось только касание края — и алгоритм отодвигал деталь на
// 6–60 мм: формально «не у края», а на деле её держит тонкая полоска отхода
// (260906_009: 24 из 31 мелких/узких деталей в 6–60 мм от края).
// Деталь, между которой и краем стоит другая деталь, прикрыта — это нормально.
export const SMALL_EDGE_MIN = 150

// Сколько сторон мелкой детали p смотрят на край листа через отход.
// p.w/p.h — с резом (справа и сверху), x,y — от низа-лева рабочей зоны.
export function smallEdgeSides(p, placed, usableX, usableY, minGap = p.edgeMin || SMALL_EDGE_MIN) {
  const x0 = p.x, y0 = p.y, x1 = p.x + p.w, y1 = p.y + p.h
  const gL = x0, gB = y0, gR = usableX - x1, gT = usableY - y1
  // Быстрый выход: далеко от всех краёв (так почти у всех кандидатов места)
  if (gL >= minGap && gB >= minGap && gR >= minGap && gT >= minGap) return 0
  let n = 0, nLong = 0, hx = false, hy = false
  // side: 0 слева, 1 снизу, 2 справа, 3 сверху
  for (let side = 0; side < 4; side++) {
    const gap = side === 0 ? gL : side === 1 ? gB : side === 2 ? gR : gT
    if (gap >= minGap) continue
    const vert = side === 0 || side === 2          // сторона вертикальная — длина по Y
    const lo = vert ? y0 : x0, hi = vert ? y1 : x1
    // Прикрыта ли сторона: соседи между деталью и краем закрывают ≥ половины её длины
    let cov = 0
    if (gap > 1) {
      const iv = []
      for (let k = 0; k < placed.length; k++) {
        const q = placed[k]
        if (q === p) continue
        const between = side === 0 ? q.x + q.w <= x0 + 0.5
          : side === 1 ? q.y + q.h <= y0 + 0.5
          : side === 2 ? q.x >= x1 - 0.5
          : q.y >= y1 - 0.5
        if (!between) continue
        const a = Math.max(lo, vert ? q.y : q.x)
        const b = Math.min(hi, vert ? q.y + q.h : q.x + q.w)
        if (b > a) iv.push(a, b)
      }
      if (iv.length) {
        const pairs = []
        for (let k = 0; k < iv.length; k += 2) pairs.push([iv[k], iv[k + 1]])
        pairs.sort((u, v) => u[0] - v[0])
        let ce = -Infinity
        for (const [a, b] of pairs) { if (b <= ce) continue; cov += b - Math.max(a, ce); ce = b }
      }
    }
    if (cov < (hi - lo) * 0.5) {
      n++
      if (vert) hx = true; else hy = true
      // короткая сторона узкой детали у края — допустимо (см. edgeOkMax)
      if (!(p.edgeOkMax > 0 && hi - lo <= p.edgeOkMax)) nLong++
    }
  }
  // Угол листа (у края с двух соседних сторон) — всегда брак, даже торцами.
  // Длинная полоса, упёртая обоими торцами в противоположные края, — не угол.
  if (hx && hy) return n
  return nLong
}

// Сколько мелких деталей стоят у края листа (см. выше). Это не пожелание, а
// критерий качества: см. better() — сразу после числа листов.
// real — usableX/usableY настоящей рабочей зоны (снаружи укладки: экран,
// проверка, сравнение вариантов). Внутри runNesting зона расширена на рез
// (деталь с резом p.w встаёт вплотную к краю), поэтому снаружи к зоне
// прибавляется рез детали — иначе у правого/верхнего края зазор считался бы
// на ширину реза меньше настоящего.
export function smallAtEdge(sheets, usableX, usableY, real = false) {
  let n = 0
  for (const sh of sheets) for (const p of sh.placed) {
    // у листа-обрезка свои размеры рабочей зоны (sh.usableX/usableY)
    if (!p.isSmall) continue
    const k = real ? (p.kf || 0) : 0
    if (smallEdgeSides(p, sh.placed, (sh.usableX ?? usableX) + k, (sh.usableY ?? usableY) + k) > 0) n++
  }
  return n
}
// То же для одной детали — по настоящей рабочей зоне (см. smallAtEdge, real)
export function smallEdgeReal(p, placed, usableX, usableY) {
  const k = p.kf || 0
  return smallEdgeSides(p, placed, usableX + k, usableY + k)
}

function evaluate(sheets, usableX, usableY) {
  const used = sheets.reduce((s, sh) => s + sh.placed.reduce((a, p) => a + p.w * p.h, 0), 0)
  const total = sheets.length * usableX * usableY
  const lastSheet = sheets[sheets.length - 1]
  const lastUsed = lastSheet ? lastSheet.placed.reduce((a, p) => a + p.w * p.h, 0) : 0
  return {
    sheetCount: sheets.length,
    utilization: total ? used / total : 0,
    lastSheetArea: lastUsed,     // сколько площади реально занято на последнем листе
    lastSheetParts: lastSheet ? lastSheet.placed.length : 0,
    smallEdge: smallAtEdge(sheets, usableX, usableY), // мелкие детали у края листа (при «мелкие — в центр»)
  }
}

// Цель — не средний % по всем листам, а фронт-загрузка: первые листы забиты
// максимально плотно, а на последний уходит как можно МЕНЬШЕ (в идеале —
// компактный "деловой остаток", а не рассеянные по листу огрызки). Поэтому
// после числа листов сравниваем не среднее использование, а сколько площади
// реально осталось на последнем листе — меньше здесь означает, что бóльшая
// часть материала уже "утрамбована" в предыдущие листы.
function better(a, b) {
  if (a.sheetCount !== b.sheetCount) return a.sheetCount < b.sheetCount
  // «Мелкие — в центр» — жёсткое требование: вариант, где меньше мелких деталей
  // у края листа, лучше независимо от заполнения последнего листа
  if ((a.smallEdge || 0) !== (b.smallEdge || 0)) return (a.smallEdge || 0) < (b.smallEdge || 0)
  if (Math.abs(a.lastSheetArea - b.lastSheetArea) > 1) return a.lastSheetArea < b.lastSheetArea
  return a.utilization > b.utilization
}

// ─── ЕДИНАЯ оценка позиции (меньше = лучше) ────────────────────────────────
// Используется и при укладке, и при компакции, и в MaxRects, и в Guillotine.
//
//   auto     : score = fit (BSSF/BAF, как раньше)
//   along_y  : 1) anchor = rect.x (колонка) → 2) контакт (максимум) → 3) rect.y (позиция в колонке)
//   along_x  : 1) anchor = rect.y (ряд)     → 2) контакт (максимум) → 3) rect.x (позиция в ряду)
//
// contact=0 по умолчанию (компакция, fitFixed) — там направление уже
// обеспечивается anchor, контакт не пересчитывается для скорости.
function scoreSpot(rect, w, h, direction, mode, usableX, usableY, isSmall, contact = 0) {
  const short = Math.min(rect.w - w, rect.h - h)
  const long_ = Math.max(rect.w - w, rect.h - h)
  // Эвристики выбора места (гены «режима» в генетическом поиске):
  //   bssf — лучшая короткая сторона остатка, baf — лучшая площадь остатка,
  //   blsf — лучшая длинная сторона, bl — ниже-левее (Bottom-Left),
  //   cp  — максимум касания с соседями и краями листа (Contact Point)
  let fit
  if (mode === 'baf') fit = rect.w * rect.h - w * h
  else if (mode === 'blsf') fit = long_ * 100000 + short
  else if (mode === 'bl') fit = rect.y * 100000 + rect.x
  else if (mode === 'cp') fit = (2 * (usableX + usableY) - contact) * 100000 + short
  else fit = short * 1000 + long_

  const along = direction === 'along_y' || direction === 'along_x'
  const span = Math.max(usableX, usableY) + 1

  let score
  if (along) {
    const anchor = Math.round(direction === 'along_y' ? rect.x : rect.y) // колонка / ряд
    const other  = direction === 'along_y' ? rect.y : rect.x              // позиция внутри колонки/ряда
    // Теоретический максимум касания: 4 стены по периметру листа
    const maxContact = 2 * (usableX + usableY)
    const contactScore = maxContact - contact  // меньше = больше касания = лучше
    // Масштабы: anchor (колонка/ряд) >> contactScore >> other
    // гарантируют строгий лексикографический порядок приоритетов.
    score = anchor * (maxContact + 1) * (span + 1) + contactScore * (span + 1) + other
    const preferred = direction === 'along_y' ? h >= w : w >= h
    if (!preferred) score += 0.5
  } else {
    score = fit
  }

  if (isSmall) {
    let borderTouch = 0
    if (rect.x <= EPS) borderTouch++
    if (rect.y <= EPS) borderTouch++
    if (Math.abs(rect.x + w - usableX) <= EPS) borderTouch++
    if (Math.abs(rect.y + h - usableY) <= EPS) borderTouch++
    if (along) {
      // мелкие детали: край листа важнее привязки (не запрет, а сильный штраф).
      // Штраф больше любой оценки места при укладке «вдоль»: anchor·(maxContact+1)·(span+1) + … < (span+1)²·(maxContact+2).
      // (Раньше здесь стояла необъявленная переменная fitSpan — раскрой падал с ошибкой
      // «fitSpan is not defined», как только мелкая деталь пробовала место у края.)
      score += borderTouch * (span + 1) * (span + 1) * (2 * (usableX + usableY) + 2)
    } else {
      score += borderTouch * BORDER_PENALTY
      if (borderTouch > 0) score += (rect.x + rect.y) * ORIGIN_TIEBREAK
    }
  }
  return score
}

function makePlacedFrom(piece, rect, rot, pw, ph) {
  return {
    id: piece.id, detailIndex: piece.detailIndex,
    label: piece.label, prefix: piece.prefix,
    x: rect.x, y: rect.y,
    w: pw, h: ph,
    origX: rot ? piece.origY : piece.origX,
    origY: rot ? piece.origX : piece.origY,
    rotated: rot,
    rotation: ((piece.rot0 || 0) + (rot ? 90 : 0)) % 360,   // полный поворот от исходной детали — по нему рисуются присадка, пазы, вырезы
    isSmall: piece.isSmall,
    edgeOkMax: piece.edgeOkMax || 0,
    edgeMin: piece.edgeMin || 0,
    kf: piece.kf || 0,
    rotatable: piece.rotatable,
    edgeTop:    rot ? piece.edgeLeft   : piece.edgeTop,
    edgeRight:  rot ? piece.edgeTop    : piece.edgeRight,
    edgeBottom: rot ? piece.edgeRight  : piece.edgeBottom,
    edgeLeft:   rot ? piece.edgeBottom : piece.edgeLeft,
  }
}

// Быстрый отказ: деталь заведомо не влезает ни в один свободный прямоугольник
// листа (по максимальным размерам свободных мест). Экономит перебор уже
// забитых листов — на больших заказах это основная часть времени.
function cannotFit(sheet, piece) {
  const mw = sheet.maxFreeW, mh = sheet.maxFreeH
  if (mw === undefined) return false
  const a = piece.pw > mw || piece.ph > mh
  if (!a) return false
  if (!piece.rotatable || piece.pw === piece.ph) return true
  return piece.ph > mw || piece.pw > mh
}
function updateFreeBounds(sheet) {
  let mw = 0, mh = 0
  const fr = sheet.freeRects
  for (let i = 0; i < fr.length; i++) { if (fr[i].w > mw) mw = fr[i].w; if (fr[i].h > mh) mh = fr[i].h }
  sheet.maxFreeW = mw; sheet.maxFreeH = mh
}

function chooseSpot(freeRects, piece, direction, usableX, usableY, mode, placed = []) {
  let bestRect = null, bestRot = false, bestScore = Infinity
  const canRot = piece.rotatable && piece.pw !== piece.ph
  const needContact = direction === 'along_y' || direction === 'along_x' || mode === 'cp'

  for (let i = 0; i < freeRects.length; i++) {
    const rect = freeRects[i]
    for (let k = 0; k < (canRot ? 2 : 1); k++) {
      const pw = k ? piece.ph : piece.pw, ph = k ? piece.pw : piece.ph
      if (pw > rect.w || ph > rect.h) continue
      const contact = needContact
        ? computeContactLength(rect.x, rect.y, pw, ph, placed, usableX, usableY)
        : 0
      let score = scoreSpot(rect, pw, ph, direction, mode, usableX, usableY, piece.isSmall, contact)
      if (piece.isSmall) score += smallEdgeSides({ x: rect.x, y: rect.y, w: pw, h: ph, edgeOkMax: piece.edgeOkMax, edgeMin: piece.edgeMin }, placed, usableX, usableY) * SMALL_NEAR_PENALTY
      if (score < bestScore) { bestScore = score; bestRect = rect; bestRot = k === 1 }
    }
  }
  if (!bestRect) return null
  return makePlacedFrom(piece, bestRect, bestRot, bestRot ? piece.ph : piece.pw, bestRot ? piece.pw : piece.ph)
}

function split(sheet, p) {
  const out = []
  for (const r of sheet.freeRects) {
    if (!hits(r, p)) { out.push(r); continue }
    if (p.x > r.x)             out.push({ x: r.x,       y: r.y, w: p.x - r.x,                 h: r.h })
    if (p.x + p.w < r.x + r.w) out.push({ x: p.x + p.w, y: r.y, w: r.x + r.w - (p.x + p.w), h: r.h })
    if (p.y > r.y)             out.push({ x: r.x, y: r.y,        w: r.w, h: p.y - r.y })
    if (p.y + p.h < r.y + r.h) out.push({ x: r.x, y: p.y + p.h, w: r.w, h: r.y + r.h - (p.y + p.h) })
  }
  sheet.freeRects = out
}

// === Guillotine-семья (Jylänki, "A Thousand Ways to Pack the Bin", 2010) ===
// В отличие от MaxRects, свободные прямоугольники никогда не перекрываются —
// после вставки остаток режется РОВНО ОДНИМ разрезом на 2 части. Дешевле
// считать (нет merge/prune), меньше фрагментация на узкие полосы.

function chooseSpotGuillotine(freeRects, piece, direction, usableX, usableY, mode, placed = []) {
  let bestIdx = -1, bestRot = false, bestScore = Infinity
  const canRot = piece.rotatable && piece.pw !== piece.ph
  const needContact = direction === 'along_y' || direction === 'along_x' || mode === 'cp'

  for (let idx = 0; idx < freeRects.length; idx++) {
    const rect = freeRects[idx]
    for (let k = 0; k < (canRot ? 2 : 1); k++) {
      const pw = k ? piece.ph : piece.pw, ph = k ? piece.pw : piece.ph
      if (pw > rect.w || ph > rect.h) continue
      const contact = needContact
        ? computeContactLength(rect.x, rect.y, pw, ph, placed, usableX, usableY)
        : 0
      let score = scoreSpot(rect, pw, ph, direction, mode, usableX, usableY, piece.isSmall, contact)
      if (piece.isSmall) score += smallEdgeSides({ x: rect.x, y: rect.y, w: pw, h: ph, edgeOkMax: piece.edgeOkMax, edgeMin: piece.edgeMin }, placed, usableX, usableY) * SMALL_NEAR_PENALTY
      if (score < bestScore) { bestScore = score; bestIdx = idx; bestRot = k === 1 }
    }
  }
  if (bestIdx < 0) return null
  const best = makePlacedFrom(piece, freeRects[bestIdx], bestRot, bestRot ? piece.ph : piece.pw, bestRot ? piece.pw : piece.ph)
  best._freeRectIdx = bestIdx
  return best
}

// Split Shorter Leftover Axis (SLAS): режем остаток вдоль оси с МЕНЬШИМ
// запасом — так обе части остатка получаются пропорциональнее и реже
// вырождаются в бесполезные узкие полоски.
function splitGuillotine(sheet, p) {
  const idx = p._freeRectIdx
  const r = sheet.freeRects[idx]
  sheet.freeRects.splice(idx, 1)
  const rightW = r.w - p.w, bottomH = r.h - p.h
  if (rightW < bottomH) {
    if (rightW > 0.01) sheet.freeRects.push({ x: r.x + p.w, y: r.y, w: rightW, h: p.h })
    if (bottomH > 0.01) sheet.freeRects.push({ x: r.x, y: r.y + p.h, w: r.w, h: bottomH })
  } else {
    if (rightW > 0.01) sheet.freeRects.push({ x: r.x + p.w, y: r.y, w: rightW, h: r.h })
    if (bottomH > 0.01) sheet.freeRects.push({ x: r.x, y: r.y + p.h, w: p.w, h: bottomH })
  }
}

// Guillotine-аналог fitFixed (для компакции) — тоже возвращает индекс
// свободного прямоугольника, чтобы компакция могла вызвать splitGuillotine.
function fitFixedGuillotine(freeRects, w, h, usableX, usableY, isSmall, direction) {
  let best = null, bestScore = Infinity, bestIdx = -1
  freeRects.forEach((rect, idx) => {
    if (w > rect.w || h > rect.h) return
    const score = scoreSpot(rect, w, h, direction, undefined, usableX, usableY, isSmall)
    if (score < bestScore) { bestScore = score; best = { x: rect.x, y: rect.y }; bestIdx = idx }
  })
  if (!best) return null
  return { x: best.x, y: best.y, idx: bestIdx }
}

function prune(sheet) {
  let r = sheet.freeRects.filter(r => r.w > 5 && r.h > 5)
  r = r.filter((a, i) =>
    !r.some((b, j) => j !== i && b.x <= a.x && b.y <= a.y && b.x + b.w >= a.x + a.w && b.y + b.h >= a.y + a.h))
  sheet.freeRects = mergeAdjacent(r)
}

function mergeAdjacent(rects) {
  let list = rects.slice()
  let merged = true
  while (merged) {
    merged = false
    outer:
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j]
        if (Math.abs(a.y - b.y) < 0.01 && Math.abs(a.h - b.h) < 0.01) {
          if (Math.abs(a.x + a.w - b.x) < 0.01) { list[i] = { x: a.x, y: a.y, w: a.w + b.w, h: a.h }; list.splice(j, 1); merged = true; break outer }
          if (Math.abs(b.x + b.w - a.x) < 0.01) { list[i] = { x: b.x, y: a.y, w: a.w + b.w, h: a.h }; list.splice(j, 1); merged = true; break outer }
        }
        if (Math.abs(a.x - b.x) < 0.01 && Math.abs(a.w - b.w) < 0.01) {
          if (Math.abs(a.y + a.h - b.y) < 0.01) { list[i] = { x: a.x, y: a.y, w: a.w, h: a.h + b.h }; list.splice(j, 1); merged = true; break outer }
          if (Math.abs(b.y + b.h - a.y) < 0.01) { list[i] = { x: a.x, y: b.y, w: a.w, h: a.h + b.h }; list.splice(j, 1); merged = true; break outer }
        }
      }
    }
  }
  return list
}

function hits(a, b) {
  return b.x < a.x + a.w && b.x + b.w > a.x && b.y < a.y + a.h && b.y + b.h > a.y
}

export function computeOffcuts(sheet, usableX, usableY) {
  if (!sheet?.freeRects) return []
  return sheet.freeRects
    .filter(r => r.w >= 100 && r.h >= 100)
    .map(r => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h), area: r.w * r.h }))
    .sort((a, b) => b.area - a.area).slice(0, 8)
}

// ─── Деловой обрезок вручную — от точки, выбранной пользователем удержанием
// пальца на карте. Растим прямоугольник во все 4 стороны от точки, пока не
// упрёмся в деталь или в границу листа — это и есть сквозной рез, не
// пересекающий деталей. Несколько проходов нужны для сходимости, т.к.
// расширение одной стороны может открыть/закрыть ограничения для других.
// ─── Деловой обрезок вручную — от точки, выбранной пользователем удержанием
// пальца на карте. Это НЕ сквозной рез форматно-раскроечного станка (который
// резал бы через всю полосу листа) — прямоугольник растёт от самой точки
// свободно по X и по Y, независимо от того, по ширине или длине детали он
// получится. Сначала находим свободный "крест" ровно через точку (по её
// строке и по её столбцу), затем подрезаем углы, если в них всё же попала
// деталь, которая не пересекала сам крест.
export function computeOffcutAtPoint(px, py, placed, usableX, usableY) {
  const parts = (placed || []).map(p => ({ x: p.x, y: p.y, w: p.w, h: p.h }))
  if (parts.some(o => px >= o.x && px <= o.x + o.w && py >= o.y && py <= o.y + o.h)) return null

  // Свободный ход по X ровно на высоте точки (py)
  let x0 = 0, x1 = usableX
  parts.forEach(o => {
    if (o.y < py && o.y + o.h > py) {
      if (o.x + o.w <= px) x0 = Math.max(x0, o.x + o.w)
      if (o.x >= px) x1 = Math.min(x1, o.x)
    }
  })
  // Свободный ход по Y ровно на ширине точки (px)
  let y0 = 0, y1 = usableY
  parts.forEach(o => {
    if (o.x < px && o.x + o.w > px) {
      if (o.y + o.h <= py) y0 = Math.max(y0, o.y + o.h)
      if (o.y >= py) y1 = Math.min(y1, o.y)
    }
  })

  // Углы получившегося прямоугольника могли задеть деталь, которая сама не
  // пересекала ни строку, ни столбец точки — подрезаем с наименьшей потерей
  // площади, пока пересечений не останется
  for (let iter = 0; iter < 8; iter++) {
    let hit = null
    for (const o of parts) {
      if (x0 < o.x + o.w && x1 > o.x && y0 < o.y + o.h && y1 > o.y) { hit = o; break }
    }
    if (!hit) break
    const h = y1 - y0, w = x1 - x0
    const options = [
      { area: (hit.x - x0) * h, apply: () => { x1 = hit.x } },
      { area: (x1 - (hit.x + hit.w)) * h, apply: () => { x0 = hit.x + hit.w } },
      { area: w * (hit.y - y0), apply: () => { y1 = hit.y } },
      { area: w * (y1 - (hit.y + hit.h)), apply: () => { y0 = hit.y + hit.h } },
    ].filter(o => o.area > 0.01)
    if (!options.length) return null
    options.sort((a, b) => b.area - a.area)
    options[0].apply()
  }

  if (x1 - x0 < 5 || y1 - y0 < 5) return null
  return { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) }
}



// ─── Один лист-шаблон ────────────────────────────────────────────────────────
function packOneSheet(order, mode, direction, usableX, usableY) {
  const family = mode.startsWith('g-') ? 'guillotine' : 'maxrects'
  const scoreMode = mode.startsWith('g-') ? mode.slice(2) : mode
  const sheet = { index: 0, placed: [], freeRects: [{ x: 0, y: 0, w: usableX, h: usableY }], family }
  // мелкие — после крупных (как в packAttempt): видно, где их прикроют от края
  if (order.some(p => p.isSmall)) order = order.filter(p => !p.isSmall).concat(order.filter(p => p.isSmall))
  for (const piece of order) {
    if (cannotFit(sheet, piece)) continue
    const r = family === 'guillotine'
      ? chooseSpotGuillotine(sheet.freeRects, piece, direction, usableX, usableY, scoreMode, sheet.placed)
      : chooseSpot(sheet.freeRects, piece, direction, usableX, usableY, scoreMode, sheet.placed)
    if (!r) continue
    sheet.placed.push(r)
    if (family === 'guillotine') { splitGuillotine(sheet, r); delete r._freeRectIdx } else { split(sheet, r); prune(sheet) }
    updateFreeBounds(sheet)
  }
  return stripEdgeSmall(sheet, usableX, usableY)
}

// Лист с «островом» мелких деталей: мелкие сначала плотно собираются в блок,
// блок ставится внутрь листа не ближе порога к краям, крупные раскладываются
// вокруг. Так мелкие гарантированно не у края — и лист остаётся плотным.
// Обычная укладка (мелкие — после крупных) оставляет им только щели у края, и
// шаблон теряет все мелкие (260906_009, 320 мелких из 1175: ЛП 123 листа против 117,7 без них).
function packBlockSheet(order, mode, direction, usableX, usableY, rand) {
  const smalls = order.filter(p => p.isSmall), bigs = order.filter(p => !p.isSmall)
  if (!smalls.length) return packOneSheet(order, mode, direction, usableX, usableY)
  const gap = smalls[0].edgeMin || SMALL_EDGE_MIN
  const innerW = usableX - 2 * gap, innerH = usableY - 2 * gap
  if (innerW < 100 || innerH < 100) return packOneSheet(order, mode, direction, usableX, usableY)
  // блок мелких: случайный размер «окна»
  const bwMax = innerW * (0.3 + 0.7 * rand()), bhMax = innerH * (0.15 + 0.85 * rand())
  const blk = { index: 0, placed: [], freeRects: [{ x: 0, y: 0, w: bwMax, h: bhMax }], family: 'maxrects' }
  for (const piece of smalls) {
    const q = { ...piece, isSmall: false } // внутри блока правило края не действует
    if (cannotFit(blk, q)) continue
    const r = chooseSpot(blk.freeRects, q, direction, bwMax, bhMax, mode.startsWith('g-') ? mode.slice(2) : mode, blk.placed)
    if (!r) continue
    blk.placed.push(r); split(blk, r); prune(blk); updateFreeBounds(blk)
  }
  if (!blk.placed.length) return packOneSheet(order, mode, direction, usableX, usableY)
  let bw = 0, bh = 0
  blk.placed.forEach(p => { bw = Math.max(bw, p.x + p.w); bh = Math.max(bh, p.y + p.h) })
  // положение блока: отступ слева/снизу — по размерам крупных деталей (полоса из
  // них), но не меньше порога; справа/сверху тоже должно остаться ≥ порога
  const dims = [...new Set(bigs.flatMap(p => [p.pw, p.ph]))].filter(v => v >= gap - 0.5)
  const pickOff = (lim, size) => {
    const c = dims.filter(v => v + size + gap <= lim + 0.5)
    if (c.length && rand() < 0.75) return c[Math.floor(rand() * c.length)]
    const lo = gap, hi = lim - size - gap
    return hi > lo ? lo + rand() * (hi - lo) : lo
  }
  const x0 = pickOff(usableX, bw), y0 = pickOff(usableY, bh)
  if (x0 + bw > usableX - gap + 0.5 || y0 + bh > usableY - gap + 0.5) return packOneSheet(order, mode, direction, usableX, usableY)
  const sheet = { index: 0, placed: [], freeRects: [{ x: 0, y: 0, w: usableX, h: usableY }], family: 'maxrects' }
  const smallById = new Map(smalls.map(p => [p.id, p]))
  for (const r of blk.placed) {
    const placed = { ...r, x: r.x + x0, y: r.y + y0, isSmall: true, edgeOkMax: smallById.get(r.id)?.edgeOkMax || 0, edgeMin: smallById.get(r.id)?.edgeMin || 0 }
    sheet.placed.push(placed); split(sheet, placed); prune(sheet)
  }
  updateFreeBounds(sheet)
  const scoreMode = mode.startsWith('g-') ? mode.slice(2) : mode
  for (const piece of bigs) {
    if (cannotFit(sheet, piece)) continue
    const r = chooseSpot(sheet.freeRects, piece, direction, usableX, usableY, scoreMode, sheet.placed)
    if (!r) continue
    sheet.placed.push(r); split(sheet, r); prune(sheet); updateFreeBounds(sheet)
  }
  return stripEdgeSmall(sheet, usableX, usableY)
}

// Без правила «мелкие — в центр»: самый плотный лист, потом мелкие — внутрь
// перестановкой полос (stripEdgeSmall → stripPermuteRepair), что не вышло — убирается
function packDenseThenFix(order, mode, direction, usableX, usableY) {
  // ВАЖНО: флаг «мелкая» возвращается по id детали. В v2.8 он возвращался по
  // временной метке, которая при укладке терялась, — мелкие оставались без
  // флага: правило для них не проверялось, на карте они не подсвечивались.
  const smallIds = new Set(order.filter(p => p.isSmall).map(p => p.id))
  const plain = order.map(p => (p.isSmall ? { ...p, isSmall: false } : p))
  const sh = packOneSheet(plain, mode, direction, usableX, usableY)
  sh.placed = sh.placed.map(p => (smallIds.has(p.id) ? { ...p, isSmall: true } : p))
  return stripEdgeSmall(sh, usableX, usableY)
}
function packPatternSheet(order, mode, direction, usableX, usableY, rand = Math.random) {
  if (order.some(p => p.isSmall)) {
    const r = rand()
    if (r < 0.7) return packDenseThenFix(order, mode, direction, usableX, usableY)
    if (r < 0.75) return packBlockSheet(order, mode, direction, usableX, usableY, rand)
  }
  return packOneSheet(order, mode, direction, usableX, usableY)
}

// ─── Раскрой «шаблонами» (последовательная коррекция ценности) ───────────────
// Для заказов с большим числом одинаковых деталей (сотни деталей, десятки видов)
// это классическая задача раскроя: выгоднее искать не порядок всех деталей, а
// хорошие «шаблоны» листа и повторять их. Лист строится так, чтобы максимизировать
// сумму «ценностей» деталей на нём; найденный шаблон повторяется, пока хватает
// деталей. После каждого полного решения ценность вида растёт, если его детали
// попадали на неплотные листы (их трудно уложить — пусть идут раньше и в лучшие
// шаблоны). Метод SVC (Мухачёва и др.).
export function svcPack(pieces, modes, direction, usableX, usableY, budgetMs, onSolution = null, rand = Math.random, onPattern = null) {
  const S = usableX * usableY
  const types = new Map()
  for (const p of pieces) {
    if (!types.has(p.detailIndex)) types.set(p.detailIndex, { list: [], area: p.pw * p.ph, y: p.pw * p.ph, n: 0, acc: 0 })
    types.get(p.detailIndex).list.push(p)
  }
  const T = [...types.entries()]
  const t0 = Date.now()
  let best = null, bestStat = null, it = 0
  const packOne = (order, mode) => packPatternSheet(order, mode, direction, usableX, usableY, rand)
  while (Date.now() - t0 < budgetMs) {
    it++
    const rem = new Map(T.map(([k, t]) => [k, t.list.slice()]))
    const sheets = []
    let left = pieces.length
    while (left > 0) {
      let bestSheet = null, bestVal = -1
      const tries = 12
      for (let tr = 0; tr < tries; tr++) {
        const noise = tr === 0 ? 0 : 0.6 * rand()
        const live = T.filter(([k]) => rem.get(k).length)
        live.sort((a, b) => b[1].y * (1 + noise * (rand() - 0.5)) - a[1].y * (1 + noise * (rand() - 0.5)))
        const order = []
        for (const [k, t] of live) {
          const r = rem.get(k)
          const cap = Math.min(r.length, Math.floor(S / t.area))
          for (let i = 0; i < cap; i++) order.push(r[r.length - 1 - i])
        }
        const sh = packOne(order, modes[Math.floor(rand() * modes.length)])
        let val = 0
        for (const p of sh.placed) val += types.get(p.detailIndex).y
        if (val > bestVal) { bestVal = val; bestSheet = sh }
      }
      if (!bestSheet || !bestSheet.placed.length) {
        // страховка: ни одна деталь не теряется — остаток обычной укладкой
        const restPieces = [...rem.values()].flat()
        packAttempt(restPieces, modes[0], direction, usableX, usableY).forEach(sh => sheets.push({ ...sh, index: sheets.length }))
        left = 0
        break
      }
      onPattern?.(bestSheet)
      // повтор шаблона, пока хватает деталей каждого вида
      const cnt = new Map()
      for (const p of bestSheet.placed) cnt.set(p.detailIndex, (cnt.get(p.detailIndex) || 0) + 1)
      let reps = Infinity
      for (const [k, c] of cnt) reps = Math.min(reps, Math.floor(rem.get(k).length / c))
      reps = Math.max(1, reps)
      for (let r = 0; r < reps; r++) {
        const placed = bestSheet.placed.map(p => {
          const inst = rem.get(p.detailIndex).pop()
          return { ...p, id: inst.id }
        })
        sheets.push({ index: sheets.length, family: bestSheet.family, placed, freeRects: bestSheet.freeRects.map(f => ({ ...f })), maxFreeW: bestSheet.maxFreeW, maxFreeH: bestSheet.maxFreeH })
        left -= placed.length
      }
    }
    // последний лист — самый лёгкий
    sheets.sort((a, b) => sheetArea(b) - sheetArea(a)).forEach((sh, i) => { sh.index = i })
    const stat = evaluate(sheets, usableX, usableY)
    if (!bestStat || better(stat, bestStat)) { best = sheets; bestStat = stat; onSolution?.(sheets, stat, it) }
    // коррекция ценностей: деталь на неплотном листе дорожает
    for (const sh of sheets) {
      const f = Math.max(0.05, sheetArea(sh) / S)
      for (const p of sh.placed) { const t = types.get(p.detailIndex); t.acc += t.area / f; t.n++ }
    }
    for (const [, t] of T) if (t.n) { t.y = (t.y * it + t.acc / t.n) / (it + 1); t.acc = 0; t.n = 0 }
  }
  return best
}

// Шаблон листа без мелких деталей у края: такие мелкие убираются из шаблона
// (уйдут в другие листы, где их прикроют). Убрать одну — может открыть другую,
// поэтому повторяем. freeRects пересобираются.
function stripEdgeSmall(sheet, usableX, usableY) {
  if (!sheet.placed.some(p => p.isSmall)) return sheet
  // сначала — перестановкой полос (детали остаются на листе)
  if (smallAtEdge([sheet], usableX, usableY) > 0) sheet = stripPermuteRepair(sheet, usableX, usableY)
  let placed = sheet.placed
  for (let g = 0; g < 20; g++) {
    const bad = placed.filter(p => p.isSmall && smallEdgeSides(p, placed, usableX, usableY) > 0)
    if (!bad.length) break
    placed = placed.filter(p => !bad.includes(p))
  }
  if (placed === sheet.placed || !placed.length) return sheet // одни мелкие — оставляем как есть
  const next = { ...sheet, placed, family: 'maxrects', freeRects: [{ x: 0, y: 0, w: usableX, h: usableY }] }
  placed.forEach(pp => { split(next, pp); prune(next) })
  updateFreeBounds(next)
  return next
}

// ─── ЛП «покрытие спроса шаблонами» (симплекс с большим M) ──────────────────
// min Σx_p  при  Σ_p a[t][p]·x_p ≥ d[t],  x ≥ 0. Строк — видов деталей (десятки),
// столбцов — шаблонов (сотни): плотная таблица маленькая. Возвращает x и
// двойственные цены π (ценность детали каждого вида в «листах»).
function lpCover(cols, d) {
  const R = d.length, m = cols.length, M = 1e5
  const W = m + 2 * R // x, surplus, artificial
  const T = Array.from({ length: R }, (_, i) => {
    const row = new Float64Array(W + 1)
    for (let j = 0; j < m; j++) row[j] = cols[j][i]
    row[m + i] = -1
    row[m + R + i] = 1
    row[W] = d[i]
    return row
  })
  const cost = j => (j < m ? 1 : j < m + R ? 0 : M)
  const basis = Array.from({ length: R }, (_, i) => m + R + i)
  for (let iter = 0; iter < 5000; iter++) {
    // приведённые стоимости
    let enter = -1, best = -1e-9
    for (let j = 0; j < W; j++) {
      let z = 0
      for (let i = 0; i < R; i++) z += cost(basis[i]) * T[i][j]
      const rc = cost(j) - z
      if (rc < best) { best = rc; enter = j }
    }
    if (enter < 0) break
    let leave = -1, ratio = Infinity
    for (let i = 0; i < R; i++) {
      const a = T[i][enter]
      if (a > 1e-9) { const q = T[i][W] / a; if (q < ratio - 1e-12) { ratio = q; leave = i } }
    }
    if (leave < 0) break // неограничена — не бывает
    const pr = T[leave], pv = pr[enter]
    for (let j = 0; j <= W; j++) pr[j] /= pv
    for (let i = 0; i < R; i++) {
      if (i === leave) continue
      const f = T[i][enter]
      if (Math.abs(f) < 1e-12) continue
      const row = T[i]
      for (let j = 0; j <= W; j++) row[j] -= f * pr[j]
    }
    basis[leave] = enter
  }
  const x = new Float64Array(m)
  basis.forEach((b, i) => { if (b < m) x[b] = T[i][W] })
  const pi = new Float64Array(R)
  for (let t = 0; t < R; t++) { let v = 0; for (let i = 0; i < R; i++) v += cost(basis[i]) * T[i][m + R + t]; pi[t] = v }
  let obj = 0; for (let j = 0; j < m; j++) obj += x[j]
  return { x, pi, obj }
}

// ─── Пул шаблонов + ЛП (генерация столбцов) → целое решение ─────────────────
// Для больших заказов с повторяющимися деталями. Шаблон — раскладка одного
// листа (сколько деталей каждого вида и где). Пул пополняется:
//  • «ценовыми» шаблонами (генерация столбцов): лист собирается так, чтобы
//    максимизировать сумму двойственных цен π деталей; пока такой лист «дороже»
//    одного листа — он улучшает ЛП;
//  • листами лучших раскладок генетического поиска и дожима — они плотнее всего
//    (260906_009 ×1175: шаблоны из истории дают ЛП 116,8 листа против 119 у одних
//    «ценовых»).
// Решение: ЛП min Σx при покрытии спроса; целое — последовательным округлением
// (остаток — снова ЛП), хвост — быстрым SVC. Мелкие у края из шаблонов убираются.
export function makePatternPool(pieces, modes, direction, usableX, usableY, rand = Math.random) {
  const S = usableX * usableY
  const kinds = [...new Set(pieces.map(p => p.detailIndex))]
  const kIdx = new Map(kinds.map((k, i) => [k, i]))
  const R = kinds.length
  const byKind = kinds.map(() => [])
  pieces.forEach(p => byKind[kIdx.get(p.detailIndex)].push(p))
  const d = byKind.map(l => l.length)
  const area = byKind.map(l => l[0].pw * l[0].ph)
  const packOne = (order, mode) => packPatternSheet(order, mode, direction, usableX, usableY, rand)
  const countOf = sh => { const c = new Array(R).fill(0); sh.placed.forEach(p => { const t = kIdx.get(p.detailIndex); if (t !== undefined) c[t]++ }); return c }
  const pats = [], seen = new Map()
  const addPat = sh => {
    if (!sh || !sh.placed.length) return false
    const c = countOf(sh); const key = c.join(',')
    // Полосы — «широкая → узкая ← широкая»; из двух раскладок одного состава
    // остаётся та, где у краёв листа меньше узких деталей (плотность та же)
    sh = wideNarrowWide(sh, usableX, usableY)
    const score = narrowEdgeScore(sh, usableX, usableY)
    const at = seen.get(key)
    if (at !== undefined) {
      if (score < pats[at].score - 1) { pats[at].sheet = { placed: sh.placed.map(p => ({ ...p })) }; pats[at].score = score }
      return false
    }
    seen.set(key, pats.length); pats.push({ c, score, sheet: { placed: sh.placed.map(p => ({ ...p })) } }); return true
  }
  // стартовые шаблоны: по одному виду (гарантируют допустимость ЛП)
  for (let t = 0; t < R; t++) addPat(packOne(byKind[t].slice(0, Math.min(d[t], Math.ceil(S / area[t]) + 2)), modes[0]))
  const genPatterns = (val, tries) => {
    const out = []
    for (let tr = 0; tr < tries; tr++) {
      const noise = tr === 0 ? 0 : 0.8 * rand()
      const byDensity = tr % 2 === 0
      const drop = tr > 0 && rand() < 0.35 ? 0.3 : 0 // иногда без части видов — другие сочетания
      const ord = kinds.map((_, t) => t).filter(t => val[t] > 1e-9 && !(drop && rand() < drop))
        .map(t => ({ t, k: (byDensity ? val[t] / area[t] : val[t]) * (1 + noise * (rand() - 0.5)) }))
        .sort((a, b) => b.k - a.k)
      // каждая третья попытка — как в генетическом поиске: несколько листов
      // обычной укладкой (мелкие встают внутрь следующих листов, прикрытые
      // крупными), шаблоны — все листы, кроме последнего (он недобор)
      const multi = tr % 3 === 2
      const order = []
      for (const { t } of ord) { const cap = Math.min(d[t], Math.floor((multi ? 3 : 1) * S / area[t])); for (let i = 0; i < cap; i++) order.push(byKind[t][i]) }
      const mode = modes[Math.floor(rand() * modes.length)]
      const shs = multi ? compactUntilStable(packAttempt(order, mode, direction, usableX, usableY), direction, usableX, usableY).slice(0, -1).map(sh => stripEdgeSmall(sh, usableX, usableY)) : [packOne(order, mode)]
      for (const sh of shs) {
        let v = 0; sh.placed.forEach(p => { v += val[kIdx.get(p.detailIndex)] })
        out.push({ sh, v })
      }
    }
    return out.sort((a, b) => b.v - a.v)
  }
  let lastLp = null

  // Генерация столбцов (с затравкой SVC)
  async function colgen(budgetMs, shouldStop = () => false) {
    const t0 = Date.now()
    genPatterns(area.map(a => a / S), 40).slice(0, 10).forEach(o => addPat(o.sh))
    svcPack(pieces, modes, direction, usableX, usableY, Math.min(3000, budgetMs * 0.2), null, rand, sh => addPat(sh))
    let fails = 0
    for (let round = 0; round < 2000 && Date.now() - t0 < budgetMs && !shouldStop(); round++) {
      lastLp = lpCover(pats.map(p => p.c), d)
      const cand = genPatterns(Array.from(lastLp.pi), 30 * (1 + fails))
      let added = 0
      for (const o of cand) { if (o.v > 1 + 1e-6 && addPat(o.sh)) { if (++added >= 4) break } }
      if (!added) { if (++fails > 5) break } else fails = 0
      if (round % 3 === 2) await new Promise(r => setTimeout(r, 0))
    }
  }

  // Целое решение из пула
  function solve(tailMs = 300) {
    const lp = lpCover(pats.map(p => p.c), d)
    lastLp = lp
    const order = Array.from(lp.x.keys()).filter(j => lp.x[j] > 1e-9).sort((a, b) => lp.x[b] - lp.x[a])
    // для последовательного округления — только «полезные» шаблоны: из решения ЛП и самые плотные
    const fillOf = p => p.c.reduce((a, v, t) => a + v * area[t], 0)
    const useful = new Set(order)
    pats.map((p, j) => [fillOf(p), j]).sort((a, b) => b[0] - a[0]).slice(0, 250).forEach(([, j]) => useful.add(j))
    let best = null, bestStat = null
    for (const theta of [-1, 1.01, 0.5]) {
      const rem = byKind.map(l => l.slice())
      const sheets = []
      const instantiate = pat => {
        const placed = []
        for (const p of pat.sheet.placed) {
          const l = rem[kIdx.get(p.detailIndex)]
          if (!l.length) continue
          placed.push({ ...p, id: l.pop().id })
        }
        if (!placed.length) return
        const sh = { index: sheets.length, family: 'maxrects', placed, freeRects: [{ x: 0, y: 0, w: usableX, h: usableY }] }
        placed.forEach(pp => { split(sh, pp); prune(sh) })
        updateFreeBounds(sh)
        sheets.push(sh)
      }
      for (const j of order) {
        const x = lp.x[j], fl = Math.floor(x + 1e-6)
        const n = theta > 0 && x - fl >= theta ? fl + 1 : fl
        for (let r = 0; r < n; r++) instantiate(pats[j])
      }
      if (theta < 0) {
        // остаток — снова ЛП по тем же шаблонам, берём шаблон с наибольшим x
        for (let g = 0; g < 60; g++) {
          const dr = rem.map(l => l.length)
          if (!dr.some(v => v > 0)) break
          const cols = [], map = []
          useful.forEach(j => { const p = pats[j]; if (p.c.some((v, t) => v > 0 && dr[t] > 0)) { cols.push(p.c.map((v, t) => Math.min(v, dr[t]))); map.push(j) } })
          if (!cols.length) break
          const r = lpCover(cols, dr)
          let bj = -1, bx = 0
          r.x.forEach((v, k) => { if (v > bx) { bx = v; bj = k } })
          if (bj < 0) break
          instantiate(pats[map[bj]])
        }
      }
      const left = rem.flat()
      if (left.length) {
        const tail = svcPack(left, modes, direction, usableX, usableY, tailMs, null, rand)
        if (tail) tail.forEach(sh => sheets.push(sh))
      }
      sheets.sort((a, b) => sheetArea(b) - sheetArea(a)).forEach((sh, i) => { sh.index = i })
      const st = evaluate(sheets, usableX, usableY)
      if (!bestStat || better(st, bestStat)) { best = sheets; bestStat = st }
    }
    return best
  }
  return { add: addPat, colgen, solve, get size() { return pats.length }, get lowerBound() { return lastLp ? lastLp.obj : Infinity } }
}

export async function colgenPack(pieces, modes, direction, usableX, usableY, budgetMs, rand = Math.random, shouldStop = () => false) {
  const pool = makePatternPool(pieces, modes, direction, usableX, usableY, rand)
  await pool.colgen(budgetMs * 0.8, shouldStop)
  const sheets = pool.solve(Math.max(150, Math.min(1500, budgetMs * 0.05)))
  return { sheets, lowerBound: pool.lowerBound, patterns: pool.size, pool }
}
export { buildPieces as _buildPieces }

// ─── Доводка: мелкие — внутрь, число листов не меняется ─────────────────────
// Для раскладки, найденной без учёта мелких (так ищется плотнее всего), — потом
// мелкие у края переставляются внутрь: перестановка с соседом, перекладка
// листа вместе с 0–2 другими (мелкие — после крупных). Листов больше не станет:
// перекладка принимается, только если листов не больше, а мелких у края меньше.
export async function fixSmallEdges(sheets, modes, direction, usableX, usableY, budgetMs, shouldStop = () => false) {
  const t0 = Date.now()
  let cur = rowSwapAll(sheets, usableX, usableY)
  let st = evaluate(cur, usableX, usableY)
  while (st.smallEdge > 0 && Date.now() - t0 < budgetMs && !shouldStop()) {
    const next = repairSmall(cur, modes, direction, usableX, usableY, 40)
    if (next !== cur) {
      const s2 = evaluate(next, usableX, usableY)
      if (s2.sheetCount <= st.sheetCount && s2.smallEdge < st.smallEdge) { cur = rowSwapAll(next, usableX, usableY); st = evaluate(cur, usableX, usableY) }
    }
    await new Promise(r => setTimeout(r, 0))
  }
  return cur
}
export { buildPieces as _buildPieces2 }

// ─── Починка «мелкие у края» окном ───────────────────────────────────────────
// Мелкая деталь у края + несколько ближайших соседей: их общий габарит («окно»,
// в которое не заходят другие детали) раскладывается заново — крупные первыми,
// мелкие последними, с запретом «у края». Остальной лист не трогается, листов
// не прибавляется. Так плотная раскладка без требования «мелкие в центр»
// доводится до требования, почти не теряя плотности: мелкая уходит вглубь, а к
// краю встаёт сосед покрупнее.
function windowRepairSheet(sheet, modes, direction, usableX, usableY, attempts, rand = Math.random) {
  let placed = sheet.placed
  const viol = list => list.reduce((n, p) => n + (p.isSmall && smallEdgeSides(p, list, usableX, usableY) > 0 ? 1 : 0), 0)
  let cur = viol(placed)
  if (!cur) return sheet
  let changed = false
  const inter = (a, b) => a.x < b.x + b.w - 0.01 && b.x < a.x + a.w - 0.01 && a.y < b.y + b.h - 0.01 && b.y < a.y + a.h - 0.01
  for (let a = 0; a < attempts && cur > 0; a++) {
    const bad = placed.filter(p => p.isSmall && smallEdgeSides(p, placed, usableX, usableY) > 0)
    const S = bad[Math.floor(rand() * bad.length)]
    const cx = S.x + S.w / 2, cy = S.y + S.h / 2
    const k = 2 + Math.floor(rand() * 7)
    const near = placed.filter(p => p !== S).map(p => ({ p, d: Math.hypot(p.x + p.w / 2 - cx, p.y + p.h / 2 - cy) }))
      .sort((u, v) => u.d - v.d).slice(0, k).map(o => o.p)
    let set = new Set([S, ...near])
    // окно — габарит набора; детали, задевающие окно, тоже в набор (до замыкания)
    let win = null
    for (let g = 0; g < 10; g++) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      set.forEach(p => { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x + p.w); y1 = Math.max(y1, p.y + p.h) })
      win = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
      const extra = placed.filter(p => !set.has(p) && inter(p, win))
      if (!extra.length) break
      extra.forEach(p => set.add(p))
      win = null
    }
    if (!win || set.size > 16) continue
    const outside = placed.filter(p => !set.has(p))
    const pool = [...set].map(placedToPiece)
    const bigs = pool.filter(p => !p.isSmall), smalls = pool.filter(p => p.isSmall)
    const r = rand()
    const sortA = list => list.sort((x, y) => y.pw * y.ph - x.pw * x.ph)
    const order = (r < 0.4 || bigs.length < 2 ? sortA(bigs) : r < 0.8 ? perturbOrder(sortA(bigs), rand() < 0.5) : shuffle(bigs))
      .concat(rand() < 0.5 ? sortA(smalls) : shuffle(smalls))
    const mode = modes[Math.floor(rand() * modes.length)]
    const scoreMode = mode.startsWith('g-') ? mode.slice(2) : mode
    const tmp = { placed: outside.slice(), freeRects: [{ ...win }], family: 'maxrects' }
    let ok = true
    for (const piece of order) {
      const res = chooseSpot(tmp.freeRects, piece, direction, usableX, usableY, scoreMode, tmp.placed)
      if (!res) { ok = false; break }
      tmp.placed.push(res); split(tmp, res); prune(tmp)
    }
    if (!ok) continue
    const v = viol(tmp.placed)
    if (v < cur) { placed = tmp.placed; cur = v; changed = true }
  }
  if (!changed) return sheet
  const next = { ...sheet, placed, family: 'maxrects', freeRects: [{ x: 0, y: 0, w: usableX, h: usableY }] }
  placed.forEach(pp => { split(next, pp); prune(next) })
  updateFreeBounds(next)
  return next
}
export function windowRepairAll(sheets, modes, direction, usableX, usableY, attemptsPerSheet = 40, rand = Math.random) {
  let changed = false
  const out = sheets.map(sh => {
    if (!sh.placed.some(p => p.isSmall)) return sh
    const r = windowRepairSheet(sh, modes, direction, usableX, usableY, attemptsPerSheet, rand)
    if (r !== sh) changed = true
    return r
  })
  return changed ? out : sheets
}

// ─── «Мелкие в центр — по возможности» ───────────────────────────────────────
// Раскладка ищется без требования (плотно, как без галочки), а потом мелкие,
// оказавшиеся у края, переставляются с соседями вглубь — сколько получится,
// не добавляя листов (перестановка в ряду, перекладка «окна» вокруг мелкой,
// перекладка листа). Оставшиеся у края подсвечиваются оранжевым.
// sheets — в координатах укладки с НАСТОЯЩЕЙ рабочей зоной (как в результате runNesting).
export function repairSmallSoft(sheets, { details, kerf, usableX, usableY, smallPartsMaxSquareSide = 0, smallPartsMaxSide = 0, smallPartsEdgeGap = 0, direction = 'auto', budgetMs = 300 }) {
  const k = Number(kerf) || 0
  const ux = usableX + k, uy = usableY + k // зона укладки (с резом у края, см. runNesting)
  const maxArea = smallPartsMaxSquareSide > 0 ? smallPartsMaxSquareSide * smallPartsMaxSquareSide : 0
  const isSmallDetail = details.map(d => {
    const W = Number(d.width) || 0, L = Number(d.length) || 0
    return (maxArea > 0 && W * L <= maxArea) || (smallPartsMaxSide > 0 && Math.min(W, L) <= smallPartsMaxSide)
  })
  const okMax = smallPartsMaxSide > 0 ? smallPartsMaxSide + k + 0.5 : 0
  const gap = Number(smallPartsEdgeGap) > 0 ? Number(smallPartsEdgeGap) : 0
  let cur = sheets.map(sh => {
    if (sh.stock === 'offcut') return sh // обрезки не трогаем
    const placed = sh.placed.map(p => {
      const small = !!isSmallDetail[p.detailIndex]
      return { ...p, isSmall: small, edgeOkMax: small ? okMax : 0, edgeMin: gap, kf: k }
    })
    const next = { ...sh, placed, family: 'maxrects', freeRects: [{ x: 0, y: 0, w: ux, h: uy }] }
    placed.forEach(pp => { split(next, pp); prune(next) })
    updateFreeBounds(next)
    return next
  })
  if (!isSmallDetail.some(Boolean) || budgetMs <= 0) return cur
  const modes = ['bssf', 'baf', 'blsf', 'bl', 'cp']
  const t0 = Date.now()
  let st = evaluate(cur, ux, uy)
  cur = rowSwapAll(cur, ux, uy)
  for (let pass = 0; Date.now() - t0 < budgetMs && evaluate(cur, ux, uy).smallEdge > 0; pass++) {
    cur = windowRepairAll(cur, modes, direction, ux, uy, 20)
    cur = rowSwapAll(cur, ux, uy)
    if (pass % 3 === 2) {
      // перекладка листа целиком (с 0–2 соседними) — листов не больше
      const r = repairSmall(cur, modes, direction, ux, uy, 20)
      const s2 = evaluate(r, ux, uy)
      if (s2.sheetCount <= st.sheetCount) cur = r
    }
  }
  return cur
}
