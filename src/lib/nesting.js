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

const BORDER_PENALTY = 2000000
const ORIGIN_TIEBREAK = 5
const EPS = 0.5 // мм, допуск на сравнение с границей (из-за kerf/округлений)

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
  optimizeSeconds = 12,           // сколько секунд гонять поиск плотной укладки — из настроек раскроя
}) {
  const usableX = sheetW - marginL - marginR  // горизонталь = 1830 - отступы
  const usableY = sheetL - marginT - marginB  // вертикаль   = 2750 - отступы

  const smallPartsMaxArea = smallPartsMaxSquareSide > 0 ? smallPartsMaxSquareSide * smallPartsMaxSquareSide : 0

  const basePieces = buildPieces(details, kerf, direction)

  basePieces.forEach(p => {
    const area = p.origX * p.origY
    const minSide = Math.min(p.origX, p.origY)
    p.isSmall = smallPartsToCenter && (
      (smallPartsMaxArea > 0 && area <= smallPartsMaxArea) ||
      (smallPartsMaxSide > 0 && minSide <= smallPartsMaxSide)
    )
  })

  const sortStrategies = [
    (a, b) => (b.pw * b.ph) - (a.pw * a.ph),                 // по убыванию площади
    (a, b) => (b.pw + b.ph) - (a.pw + a.ph),                 // по убыванию периметра
    (a, b) => Math.max(b.pw, b.ph) - Math.max(a.pw, a.ph),   // по убыванию максимальной стороны
    (a, b) => Math.min(a.pw, a.ph) - Math.min(b.pw, b.ph),   // по возрастанию минимальной стороны
  ]
  const scoringModes = ['bssf', 'baf', 'g-bssf', 'g-baf'] // MaxRects×{BSSF,BAF} и Guillotine×{BSSF,BAF}
  const RANDOM_ATTEMPTS = 150 // случайные перестановки порядка — время не критично, важна плотность

  let best = null
  let bestOrder = null
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
    if (!best || better(result.stat, best.stat)) { best = result; bestOrder = { order, mode } }
    if (!bestStatPerMode[mode] || better(result.stat, bestStatPerMode[mode])) {
      bestStatPerMode[mode] = result.stat
      bestPerMode[mode] = order
    }
  }

  for (const sortFn of sortStrategies) {
    const sorted = basePieces.slice().sort(sortFn)
    for (const mode of scoringModes) tryAttempt(sorted, mode)
  }
  for (let i = 0; i < RANDOM_ATTEMPTS; i++) {
    const shuffled = shuffle(basePieces.slice())
    for (const mode of scoringModes) tryAttempt(shuffled, mode)
    if (i % 20 === 0) await new Promise(r => setTimeout(r, 0))
  }

  // Генетический алгоритм поверх популяции вариантов порядка деталей.
  // В отличие от одиночного hill climbing (одна "цепочка" с точечными
  // мутациями), здесь целая популяция решений эволюционирует поколение
  // за поколением: турнирный отбор выбирает более удачных "родителей",
  // order crossover комбинирует их порядок деталей в потомка (наследуя
  // фрагменты структуры от обоих родителей, а не просто перемешивая),
  // и небольшая мутация поддерживает разнообразие популяции. Такой подход
  // обычно исследует пространство решений эффективнее одной случайно
  // блуждающей цепочки и меньше подвержен застреванию в локальном плато.
  //
  // ВАЖНО: бюджет времени делится ПОРОВНУ между всеми 4 режимами (MaxRects/Guillotine
  // × BSSF/BAF), а не достаётся целиком тому, кто случайно выиграл короткую
  // начальную фазу. Guillotine на короткой дистанции не обязательно лучше MaxRects —
  // его реальное преимущество (на порядок дешевле каждая попытка → на порядок больше
  // поколений за то же время) проявляется только на ДЛИННОЙ дистанции.
  //
  // Бюджет по ВРЕМЕНИ, а не по фиксированному числу поколений: на маленьком заказе
  // (мало деталей) каждая особь дешевле оценить — успеет отработать намного
  // больше поколений за то же время.
  const HILL_CLIMB_BUDGET_MS = Math.max(0, Number(optimizeSeconds) || 0) * 1000 // из настроек раскроя, 0 = без доп. оптимизации
  const YIELD_EVERY_GEN = 2 // раз в столько поколений отдаём управление браузеру
  const BUDGET_PER_MODE_MS = HILL_CLIMB_BUDGET_MS / scoringModes.length

  const POP_SIZE = 16
  const ELITE_COUNT = 2
  const TOURNAMENT_SIZE = 3
  const MUTATION_RATE = 0.35

  for (const mode of scoringModes) {
    // Начальная популяция: лучший порядок, уже найденный для ЭТОГО режима на
    // структурной/случайной фазе, плюс случайные перестановки для разнообразия.
    const seedOrder = bestPerMode[mode] || shuffle(basePieces.slice())
    let population = [seedOrder.slice()]
    while (population.length < POP_SIZE) population.push(shuffle(basePieces.slice()))

    let evaluated = population.map(order => ({ order, ...packAndEval(order, mode) }))
    evaluated.sort((a, b) => better(a.stat, b.stat) ? -1 : 1)
    if (better(evaluated[0].stat, best.stat)) best = evaluated[0]

    const startTime = Date.now()
    let gen = 0
    while (Date.now() - startTime < BUDGET_PER_MODE_MS) {
      gen++
      // Элитизм: лучшие особи переходят в следующее поколение без изменений.
      const nextOrders = evaluated.slice(0, ELITE_COUNT).map(e => e.order)
      while (nextOrders.length < POP_SIZE) {
        const parentA = tournamentSelect(evaluated, TOURNAMENT_SIZE)
        const parentB = tournamentSelect(evaluated, TOURNAMENT_SIZE)
        let child = orderCrossover(parentA.order, parentB.order)
        if (Math.random() < MUTATION_RATE) child = perturbOrder(child, false)
        nextOrders.push(child)
      }
      evaluated = nextOrders.map(order => ({ order, ...packAndEval(order, mode) }))
      evaluated.sort((a, b) => better(a.stat, b.stat) ? -1 : 1)
      if (better(evaluated[0].stat, best.stat)) best = evaluated[0]
      // Отдаём управление браузеру, чтобы страница не "подвисала" на весь расчёт.
      if (gen % YIELD_EVERY_GEN === 0) await new Promise(r => setTimeout(r, 0))
    }
  }

  return { sheets: best.sheets, usableX, usableY, sheetL, sheetW, marginT, marginR, marginB, marginL, kerf }
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
        rotatable: d.rotatable,
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
    if (!p.rotatable) return
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
  ;[p.edgeTop, p.edgeRight, p.edgeBottom, p.edgeLeft] = [p.edgeLeft, p.edgeTop, p.edgeRight, p.edgeBottom]
}

// Один полный проход укладки: заданный порядок деталей + заданная эвристика выбора места.
// mode: 'bssf'/'baf' → семья MaxRects; 'g-bssf'/'g-baf' → семья Guillotine.
function packAttempt(sortedPieces, mode, direction, usableX, usableY) {
  const family = mode.startsWith('g-') ? 'guillotine' : 'maxrects'
  const scoreMode = mode.includes('baf') ? 'baf' : 'bssf'

  const place = (sheet, piece) => {
    const result = family === 'guillotine'
      ? chooseSpotGuillotine(sheet.freeRects, piece, direction, usableX, usableY, scoreMode)
      : chooseSpot(sheet.freeRects, piece, direction, usableX, usableY, scoreMode)
    if (!result) return false
    sheet.placed.push(result)
    if (family === 'guillotine') { splitGuillotine(sheet, result); delete result._freeRectIdx }
    else { split(sheet, result); prune(sheet) }
    return true
  }

  const sheets = []
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
        for (const o of orientations) {
          const makePlaced = () => o.flip
            ? { ...piece, x: 0, y: 0, w: o.w, h: o.h, rotated: !piece.rotated,
                edgeTop: piece.edgeLeft, edgeRight: piece.edgeTop, edgeBottom: piece.edgeRight, edgeLeft: piece.edgeBottom }
            : { ...piece, x: 0, y: 0 }

          if (target.family === 'guillotine') {
            const spot = fitFixedGuillotine(target.freeRects, o.w, o.h, usableX, usableY, piece.isSmall)
            if (spot) {
              const placed = { ...makePlaced(), x: spot.x, y: spot.y, _freeRectIdx: spot.idx }
              target.placed.push(placed); splitGuillotine(target, placed); delete placed._freeRectIdx
              moved = true; break outer
            }
          } else {
            const spot = fitFixed(target.freeRects, o.w, o.h, usableX, usableY, piece.isSmall)
            if (spot) {
              const placed = { ...makePlaced(), x: spot.x, y: spot.y }
              target.placed.push(placed); split(target, placed); prune(target)
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
function fitFixed(freeRects, w, h, usableX, usableY, isSmall) {
  let best = null, bestScore = Infinity
  for (const rect of freeRects) {
    if (w > rect.w || h > rect.h) continue
    const short = Math.min(rect.w - w, rect.h - h)
    const long_ = Math.max(rect.w - w, rect.h - h)
    let score = short * 1000 + long_
    if (isSmall) {
      let borderTouch = 0
      if (rect.x <= EPS) borderTouch++
      if (rect.y <= EPS) borderTouch++
      if (Math.abs(rect.x + w - usableX) <= EPS) borderTouch++
      if (Math.abs(rect.y + h - usableY) <= EPS) borderTouch++
      score += borderTouch * BORDER_PENALTY
      if (borderTouch > 0) score += (rect.x + rect.y) * ORIGIN_TIEBREAK
    }
    if (score < bestScore) { bestScore = score; best = { x: rect.x, y: rect.y } }
  }
  return best
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
  if (Math.abs(a.lastSheetArea - b.lastSheetArea) > 1) return a.lastSheetArea < b.lastSheetArea
  return a.utilization > b.utilization
}

function chooseSpot(freeRects, piece, direction, usableX, usableY, mode) {
  let best = null, bestScore = Infinity
  const oris = [{ pw: piece.pw, ph: piece.ph, rotated: false }]
  if (piece.rotatable && piece.pw !== piece.ph)
    oris.push({ pw: piece.ph, ph: piece.pw, rotated: true })

  for (const rect of freeRects) {
    for (const o of oris) {
      if (o.pw > rect.w || o.ph > rect.h) continue
      const short = Math.min(rect.w - o.pw, rect.h - o.ph)
      const long_ = Math.max(rect.w - o.pw, rect.h - o.ph)
      const leftoverArea = rect.w * rect.h - o.pw * o.ph
      let score
      if (direction === 'along_y') {
        score = rect.x * 100000 + rect.y * 100 + short
      } else if (direction === 'along_x') {
        score = rect.y * 100000 + rect.x * 100 + short
      } else if (mode === 'baf') {
        score = leftoverArea
      } else {
        score = short * 1000 + long_
      }
      if (direction === 'along_y' && o.ph >= o.pw) score -= 50
      if (direction === 'along_x' && o.pw >= o.ph) score -= 50

      if (piece.isSmall) {
        let borderTouch = 0
        if (rect.x <= EPS) borderTouch++
        if (rect.y <= EPS) borderTouch++
        if (Math.abs(rect.x + o.pw - usableX) <= EPS) borderTouch++
        if (Math.abs(rect.y + o.ph - usableY) <= EPS) borderTouch++
        score += borderTouch * BORDER_PENALTY
        if (borderTouch > 0) score += (rect.x + rect.y) * ORIGIN_TIEBREAK
      }

      if (score < bestScore) {
        bestScore = score
        const rot = o.rotated
        best = {
          id: piece.id, detailIndex: piece.detailIndex,
          label: piece.label, prefix: piece.prefix,
          x: rect.x, y: rect.y,
          w: o.pw, h: o.ph,
          origX: rot ? piece.origY : piece.origX,
          origY: rot ? piece.origX : piece.origY,
          rotated: rot,
          isSmall: piece.isSmall,
          rotatable: piece.rotatable,
          edgeTop:    rot ? piece.edgeLeft   : piece.edgeTop,
          edgeRight:  rot ? piece.edgeTop    : piece.edgeRight,
          edgeBottom: rot ? piece.edgeRight  : piece.edgeBottom,
          edgeLeft:   rot ? piece.edgeBottom : piece.edgeLeft,
        }
      }
    }
  }
  return best
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

function chooseSpotGuillotine(freeRects, piece, direction, usableX, usableY, mode) {
  let best = null, bestScore = Infinity
  const oris = [{ pw: piece.pw, ph: piece.ph, rotated: false }]
  if (piece.rotatable && piece.pw !== piece.ph)
    oris.push({ pw: piece.ph, ph: piece.pw, rotated: true })

  freeRects.forEach((rect, idx) => {
    for (const o of oris) {
      if (o.pw > rect.w || o.ph > rect.h) continue
      const short = Math.min(rect.w - o.pw, rect.h - o.ph)
      const long_ = Math.max(rect.w - o.pw, rect.h - o.ph)
      const leftoverArea = rect.w * rect.h - o.pw * o.ph
      let score
      if (direction === 'along_y') {
        score = rect.x * 100000 + rect.y * 100 + short
      } else if (direction === 'along_x') {
        score = rect.y * 100000 + rect.x * 100 + short
      } else if (mode === 'baf') {
        score = leftoverArea
      } else {
        score = short * 1000 + long_
      }
      if (direction === 'along_y' && o.ph >= o.pw) score -= 50
      if (direction === 'along_x' && o.pw >= o.ph) score -= 50

      if (piece.isSmall) {
        let borderTouch = 0
        if (rect.x <= EPS) borderTouch++
        if (rect.y <= EPS) borderTouch++
        if (Math.abs(rect.x + o.pw - usableX) <= EPS) borderTouch++
        if (Math.abs(rect.y + o.ph - usableY) <= EPS) borderTouch++
        score += borderTouch * BORDER_PENALTY
        if (borderTouch > 0) score += (rect.x + rect.y) * ORIGIN_TIEBREAK
      }

      if (score < bestScore) {
        bestScore = score
        const rot = o.rotated
        best = {
          id: piece.id, detailIndex: piece.detailIndex,
          label: piece.label, prefix: piece.prefix,
          x: rect.x, y: rect.y,
          w: o.pw, h: o.ph,
          origX: rot ? piece.origY : piece.origX,
          origY: rot ? piece.origX : piece.origY,
          rotated: rot,
          isSmall: piece.isSmall,
          rotatable: piece.rotatable,
          edgeTop:    rot ? piece.edgeLeft   : piece.edgeTop,
          edgeRight:  rot ? piece.edgeTop    : piece.edgeRight,
          edgeBottom: rot ? piece.edgeRight  : piece.edgeBottom,
          edgeLeft:   rot ? piece.edgeBottom : piece.edgeLeft,
          _freeRectIdx: idx,
        }
      }
    }
  })
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
function fitFixedGuillotine(freeRects, w, h, usableX, usableY, isSmall) {
  let best = null, bestScore = Infinity, bestIdx = -1
  freeRects.forEach((rect, idx) => {
    if (w > rect.w || h > rect.h) return
    const short = Math.min(rect.w - w, rect.h - h)
    const long_ = Math.max(rect.w - w, rect.h - h)
    let score = short * 1000 + long_
    if (isSmall) {
      let borderTouch = 0
      if (rect.x <= EPS) borderTouch++
      if (rect.y <= EPS) borderTouch++
      if (Math.abs(rect.x + w - usableX) <= EPS) borderTouch++
      if (Math.abs(rect.y + h - usableY) <= EPS) borderTouch++
      score += borderTouch * BORDER_PENALTY
      if (borderTouch > 0) score += (rect.x + rect.y) * ORIGIN_TIEBREAK
    }
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
