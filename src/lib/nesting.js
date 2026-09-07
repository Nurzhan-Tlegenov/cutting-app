/**
 * Нестинг — Maximal Rectangles, multi-strategy поиск
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
 * ПОЧЕМУ MULTI-STRATEGY:
 *   Один порядок деталей + одна эвристика выбора места — это самый
 *   слабый вариант MaxRects, результат сильно зависит от того, в каком
 *   порядке детали подавались на укладку. Здесь прогоняется несколько
 *   вариантов порядка (по площади/периметру/стороне) и обеих эвристик
 *   размещения (BSSF — Best Short Side Fit, BAF — Best Area Fit),
 *   и выбирается результат с наименьшим числом листов, при равенстве —
 *   с наибольшим % использования материала. Это по-прежнему не полный
 *   перебор (для реального заказа это заняло бы часы), но заметно ближе
 *   к тому, что делают взрослые раскрой-программы, чем один жадный проход.
 *
 * ЗАЩИТА МЕЛКИХ ДЕТАЛЕЙ ОТ КРАЯ ЛИСТА (для фрезера):
 *   Мелкие/узкие детали держатся на столе хуже крупных — при резке фрезером
 *   риск сдвига у детали, расположенной у самого края используемой зоны
 *   листа, выше (меньше материала, который её ещё удерживает к концу прохода).
 *   Поэтому такие детали при прочих равных предпочтительно укладываются
 *   ближе к центру, окружённые другими деталями/обрезками со всех сторон.
 *   Это не жёсткий запрет — если другого места физически нет, деталь всё
 *   равно встанет к краю; но среди вынужденных вариантов у края алгоритм
 *   предпочитает тот, что ближе к началу координат (0,0) — так проще
 *   ориентироваться оператору и предсказуемее для дальнейшей резки.
 *
 *   Порог(и) и включение/выключение этой логики задаёт ПОЛЬЗОВАТЕЛЬ
 *   в настройках раскроя (параметры листа), а не алгоритм — сюда всегда
 *   приходят готовые значения. Доступны два независимых критерия
 *   "мелкой" детали — по площади и по меньшей стороне; деталь считается
 *   мелкой, если сработал хотя бы один из включённых (0 = критерий выключен).
 */

// Насколько сильно "давить" мелкие детали внутрь листа.
// Должен доминировать над обычным скором размещения (тот обычно в пределах
// сотен тысяч при координатах листа ~2700x1800), но не быть абсолютным.
const BORDER_PENALTY = 2000000
// Среди вариантов у края — небольшой тай-брейк в пользу того, что ближе к (0,0).
// Должен быть заметно меньше BORDER_PENALTY, чтобы не перебивать сравнение
// по числу касаний границы, а только выбирать между равными по этому счёту.
const ORIGIN_TIEBREAK = 5
const EPS = 0.5 // мм, допуск на сравнение с границей (из-за kerf/округлений)

export function runNesting({
  details, sheetL, sheetW, marginT, marginR, marginB, marginL, kerf,
  direction = 'auto',
  smallPartsToCenter = false,   // галочка "мелкие детали в середину" из настроек раскроя
  smallPartsMaxArea = 0,        // порог площади (мм²), ниже которого деталь считается мелкой — 0 = критерий выключен
  smallPartsMaxSide = 0,        // порог меньшей стороны (мм) — 0 = критерий выключен
}) {
  // sheetL=2750=Y, sheetW=1830=X
  const usableX = sheetW - marginL - marginR  // горизонталь = 1830 - отступы
  const usableY = sheetL - marginT - marginB  // вертикаль   = 2750 - отступы

  const basePieces = buildPieces(details, kerf, direction)

  // Классификация "мелкая деталь" — по исходным размерам без kerf (чтобы
  // граница не гуляла в зависимости от толщины пропила). Работает только
  // если пользователь включил галочку; деталь мелкая, если сработал хотя
  // бы один из двух порогов (0 у порога = этот критерий не участвует).
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
  const scoringModes = ['bssf', 'baf']

  let best = null
  for (const sortFn of sortStrategies) {
    for (const mode of scoringModes) {
      const sheets = packAttempt(basePieces, sortFn, mode, direction, usableX, usableY)
      const stat = evaluate(sheets, usableX, usableY)
      if (!best || better(stat, best.stat)) best = { sheets, stat }
    }
  }

  return { sheets: best.sheets, usableX, usableY, sheetL, sheetW, marginT, marginR, marginB, marginL, kerf }
}

function buildPieces(details, kerf, direction) {
  const pieces = []
  details.forEach((d, di) => {
    for (let q = 0; q < d.qty; q++) {
      pieces.push({
        id: `${di}_${q}`,
        detailIndex: di,
        pw: d.width + kerf,   // X = width  (ширина, горизонталь)
        ph: d.length + kerf,  // Y = length (длина, вертикаль)
        origX: d.width,       // оригинальный X-размер
        origY: d.length,      // оригинальный Y-размер
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

  // Предпочтительная ориентация для вращаемых деталей
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
function packAttempt(basePieces, sortFn, mode, direction, usableX, usableY) {
  const pieces = basePieces.slice().sort(sortFn)
  const sheets = []
  for (const piece of pieces) {
    let placed = false
    for (const sheet of sheets) {
      const result = chooseSpot(sheet.freeRects, piece, direction, usableX, usableY, mode)
      if (result) { sheet.placed.push(result); split(sheet, result); prune(sheet); placed = true; break }
    }
    if (!placed) {
      const sheet = { index: sheets.length, placed: [], freeRects: [{ x: 0, y: 0, w: usableX, h: usableY }] }
      const result = chooseSpot(sheet.freeRects, piece, direction, usableX, usableY, mode)
      if (result) { sheet.placed.push(result); split(sheet, result); prune(sheet) }
      sheets.push(sheet)
    }
  }
  return sheets
}

function evaluate(sheets, usableX, usableY) {
  const used = sheets.reduce((s, sh) => s + sh.placed.reduce((a, p) => a + p.w * p.h, 0), 0)
  const total = sheets.length * usableX * usableY
  return { sheetCount: sheets.length, utilization: total ? used / total : 0 }
}

// Меньше листов — всегда лучше. При равном числе листов — выше % использования материала.
function better(a, b) {
  if (a.sheetCount !== b.sheetCount) return a.sheetCount < b.sheetCount
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
        // Вдоль Y: сначала заполняем по X (левее = лучше), потом по Y (выше = лучше)
        score = rect.x * 100000 + rect.y * 100 + short
      } else if (direction === 'along_x') {
        // Вдоль X: сначала заполняем по Y (выше = лучше), потом по X
        score = rect.y * 100000 + rect.x * 100 + short
      } else if (mode === 'baf') {
        // Best Area Fit: минимизировать оставшуюся пустую площадь в прямоугольнике
        score = leftoverArea
      } else {
        // Best Short Side Fit (по умолчанию)
        score = short * 1000 + long_
      }
      // Бонус за предпочтительную ориентацию
      if (direction === 'along_y' && o.ph >= o.pw) score -= 50
      if (direction === 'along_x' && o.pw >= o.ph) score -= 50

      // Мелкие детали — приоритет размещению подальше от края используемой зоны.
      if (piece.isSmall) {
        let borderTouch = 0
        if (rect.x <= EPS) borderTouch++
        if (rect.y <= EPS) borderTouch++
        if (Math.abs(rect.x + o.pw - usableX) <= EPS) borderTouch++
        if (Math.abs(rect.y + o.ph - usableY) <= EPS) borderTouch++
        score += borderTouch * BORDER_PENALTY
        // Если варианта без касания края нет — среди вынужденных вариантов
        // предпочесть тот, что ближе к началу координат (0,0).
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

function prune(sheet) {
  let r = sheet.freeRects.filter(r => r.w > 5 && r.h > 5)
  // Убираем прямоугольники, полностью вложенные в другие
  r = r.filter((a, i) =>
    !r.some((b, j) => j !== i && b.x <= a.x && b.y <= a.y && b.x + b.w >= a.x + a.w && b.y + b.h >= a.y + a.h))
  // Объединяем соседние прямоугольники, стоящие впритык и образующие один большой —
  // без этого список свободных мест быстро фрагментируется на мелкие обрезки,
  // и туда физически не влезает то, что влезло бы в объединённую полосу.
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
        // Горизонтальное слияние: одинаковые y и h, смежные по x
        if (Math.abs(a.y - b.y) < 0.01 && Math.abs(a.h - b.h) < 0.01) {
          if (Math.abs(a.x + a.w - b.x) < 0.01) { list[i] = { x: a.x, y: a.y, w: a.w + b.w, h: a.h }; list.splice(j, 1); merged = true; break outer }
          if (Math.abs(b.x + b.w - a.x) < 0.01) { list[i] = { x: b.x, y: a.y, w: a.w + b.w, h: a.h }; list.splice(j, 1); merged = true; break outer }
        }
        // Вертикальное слияние: одинаковые x и w, смежные по y
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
