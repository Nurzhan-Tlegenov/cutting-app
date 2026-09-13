/**
 * True-shape нестинг — укладка ПО РЕАЛЬНОМУ КОНТУРУ детали, а не по её
 * прямоугольнику. Это не альтернативный "режим" — это и есть алгоритм
 * нестинга для фрезера (ЧПУ режет по любому контуру, значит и укладывать
 * нужно по контуру, чтобы деталь со сложным силуэтом могла войти в вогнутый
 * участок соседней детали). Для форматно-раскроечного станка (guillotine)
 * этот модуль не используется — там физически обязателен прямоугольный
 * сквозной рез, см. nesting.js.
 *
 * ПОДХОД — растровая маска, а не полноценный No-Fit-Polygon:
 *   Лист и каждая деталь переводятся в сетку ячеек (cellSize мм). Деталь —
 *   набор занятых ячеек (растеризация полигона контура). Для каждой позиции
 *   считается ПРИЛЕГАНИЕ — контакт с уже уложенными деталями и краем листа —
 *   и выбирается позиция с максимальным контактом (это и затягивает деталь
 *   в вогнутый паз соседней, а не просто в первую свободную клетку). Заметно
 *   проще честного NFP (как в SVGnest/Deepnest), но даёт настоящую укладку
 *   по силуэту без лицензионных проблем (AGPL) и без интеграции внешней
 *   библиотеки.
 *
 * ЗАЗОР ПИЛЫ/ФРЕЗЫ (kerf): закладывается не добавкой к прямоугольнику (как в
 * rectangle-алгоритме), а РАСШИРЕНИЕМ (дилатацией) занятых ячеек детали на
 * pad = ceil(kerf/cellSize) ячеек во все стороны — гарантирует зазор ровно
 * вдоль настоящей границы силуэта, а не только по двум сторонам прямоугольника.
 *
 * ПОВОРОТ: 0°/180° пробуются ВСЕГДА — они не меняют направление текстуры
 * (деталь просто переворачивается, длинная сторона остаётся вдоль Y).
 * 90°/270° меняют, какая сторона детали идёт вдоль текстуры листа — они
 * пробуются, только если у детали отключена текстура (rotatable=true,
 * тот же флаг, что и в rectangle-алгоритме). Присадка и кромка повёрнуты
 * согласованно для любого из 4 положений (см. src/lib/drillGeometry.js).
 *
 * КОМПАКЦИЯ: после укладки — несколько проходов "перекладки": деталь с
 * последнего листа пробует встать на более ранний лист (той же функцией
 * подбора места); если получилось — лист-источник пересобирается заново.
 * Опустевшие листы удаляются. Останавливаемся, когда за проход ничего не
 * переложилось, либо после MAX_COMPACT_PASSES проходов.
 *
 * МЕЛКИЕ ДЕТАЛИ — В ЦЕНТР: для детали, помеченной мелкой (те же настройки
 * пользователя, что и в rectangle-алгоритме — площадь через квадрат и/или
 * меньшая сторона), сначала ищем место, НЕ касающееся края используемой
 * зоны листа, и только если такого варианта вообще нет — разрешаем край.
 *
 * ЧТО ПОКА НЕ УЧТЕНО (сознательно, чтобы не тормозить и не множить риск):
 *   - "Вырезы"/holes у края детали (которые фактически меняют силуэт, а не
 *     только сверлят насквозь внутри) — в укладке участвует только внешний
 *     контур (vertices), они пока не вычитаются из силуэта.
 *   - Обрезки (авто/вручную) на true-shape листах считаются от прямоугольных
 *     габаритов детали, не от её точного контура.
 */

const MIN_CELL_MM = 4
const MAX_CELL_MM = 12
const TARGET_CELLS = 60000
const MAX_COMPACT_PASSES = 3

function parsePolygonFromDetail(d) {
  let contour = null
  try { contour = d.contour ? JSON.parse(d.contour) : null } catch { contour = null }
  const w = Number(d.width) || 0, h = Number(d.length) || 0
  if (!contour || !contour.vertices || contour.vertices.length <= 4) {
    return { polygon: [[0, 0], [w, 0], [w, h], [0, h]], w, h, custom: false }
  }
  const poly = contour.vertices.map(v => [Number(v.x) || 0, Number(v.y) || 0])
  return { polygon: poly, w, h, custom: true }
}

// Есть ли среди деталей заказа хоть одна с реально нарисованным (не
// прямоугольным) внешним контуром — только тогда имеет смысл включать
// true-shape укладку вместо более быстрого/отточенного rectangle-алгоритма.
export function needsTrueShape(details) {
  return (details || []).some(d => {
    try {
      const c = d.contour ? JSON.parse(d.contour) : null
      return !!(c && c.vertices && c.vertices.length > 4)
    } catch { return false }
  })
}

// Один шаг поворота на 90° — те же формулы, что и в drillGeometry.js
// (rotatePointTimes), применённые сразу ко всем точкам полигона.
function rotate90(polygon, w) {
  return polygon.map(([x, y]) => [y, w - x])
}

function pointInPoly(px, py, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j]
    const cross = ((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)
    if (cross) inside = !inside
  }
  return inside
}

// Растеризация: занятые ячейки полигона (в его собственной локальной сетке,
// (0,0) — левый нижний угол). Проверяем центр каждой ячейки.
function rasterize(polygon, w, h, cellSize) {
  const cols = Math.max(1, Math.ceil(w / cellSize))
  const rows = Math.max(1, Math.ceil(h / cellSize))
  const offsets = []
  for (let ry = 0; ry < rows; ry++) {
    const cy = (ry + 0.5) * cellSize
    for (let rx = 0; rx < cols; rx++) {
      const cx = (rx + 0.5) * cellSize
      if (pointInPoly(cx, cy, polygon)) offsets.push([rx, ry])
    }
  }
  return { cols, rows, offsets }
}

// Расширяем занятые ячейки на pad во все стороны — это и есть зазор kerf
// вдоль настоящей границы силуэта (не только по двум сторонам прямоугольника).
function dilateOffsets(offsets, pad) {
  if (pad <= 0) return offsets
  const set = new Set()
  const out = []
  offsets.forEach(([dx, dy]) => {
    for (let yy = dy - pad; yy <= dy + pad; yy++) {
      for (let xx = dx - pad; xx <= dx + pad; xx++) {
        const key = xx + ',' + yy
        if (!set.has(key)) { set.add(key); out.push([xx, yy]) }
      }
    }
  })
  return out
}

function buildVariant(polygon, w, h, cellSize, padCells, angle) {
  const { cols, rows, offsets } = rasterize(polygon, w, h, cellSize)
  return { angle, w, h, polygon, cols, rows, offsets, dilated: dilateOffsets(offsets, padCells) }
}

// 0° и 180° — всегда (не трогают направление текстуры). 90° и 270° — только
// если у детали отключена текстура (rotatable=true).
function buildPieceKind(detail, cellSize, padCells) {
  const { polygon, w, h } = parsePolygonFromDetail(detail)
  const poly90 = rotate90(polygon, w)
  const poly180 = rotate90(poly90, h)
  const variants = [
    buildVariant(polygon, w, h, cellSize, padCells, 0),
    buildVariant(poly180, w, h, cellSize, padCells, 180),
  ]
  if (detail.rotatable) {
    const poly270 = rotate90(poly180, w)
    variants.push(buildVariant(poly90, h, w, cellSize, padCells, 90))
    variants.push(buildVariant(poly270, h, w, cellSize, padCells, 270))
  }
  return variants
}

function freeIntervals(occ, cols, gy) {
  const base = gy * cols
  const out = []
  let start = -1
  for (let x = 0; x < cols; x++) {
    const free = !occ[base + x]
    if (free && start === -1) start = x
    if (!free && start !== -1) { out.push({ start, end: x }); start = -1 }
  }
  if (start !== -1) out.push({ start, end: cols })
  return out
}

function fits(occ, cols, rows, gx, gy, dilated, origCols, origRows) {
  if (gx < 0 || gy < 0 || gx + origCols > cols || gy + origRows > rows) return false
  for (const [dx, dy] of dilated) {
    const cx = gx + dx, cy = gy + dy
    if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) continue
    if (occ[cy * cols + cx]) return false
  }
  return true
}

function markOccupied(occ, cols, rows, gx, gy, dilated) {
  for (const [dx, dy] of dilated) {
    const cx = gx + dx, cy = gy + dy
    if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) continue
    occ[cy * cols + cx] = 1
  }
}

function touchesBorder(gx, gy, variant, cols, rows) {
  return gx === 0 || gy === 0 || gx + variant.cols >= cols || gy + variant.rows >= rows
}

// Оценка размещения: не просто "первая снизу-слева свободная позиция" (это
// НЕ затягивает деталь в вогнутый паз соседней — просто уедет правее по той
// же нижней строке), а "лучшая по прилеганию" — максимум касания с уже
// уложенными деталями и краем листа, при прочих равных — ниже и левее.
// Именно это заставляет деталь реально войти в вогнутость соседней.
function contactScore(occ, cols, rows, gx, gy, exactOffsets) {
  let contact = 0
  const set = new Set(exactOffsets.map(([dx, dy]) => dx + ',' + dy))
  for (const [dx, dy] of exactOffsets) {
    const cx = gx + dx, cy = gy + dy
    ;[[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([ox, oy]) => {
      const ndx = dx + ox, ndy = dy + oy
      if (set.has(ndx + ',' + ndy)) return // сосед — тоже часть этой же детали, не считаем
      const ncx = cx + ox, ncy = cy + oy
      if (ncx < 0 || ncy < 0 || ncx >= cols || ncy >= rows) { contact++; return } // край листа
      if (occ[ncy * cols + ncx]) contact++ // уже занято соседней деталью
    })
  }
  return contact
}

const MAX_CANDIDATES = 4000 // ограничение на число вариантов, которые реально оцениваем — держит расчёт быстрым

// avoidBorder=true — кандидаты, касающиеся края используемой зоны, вообще не
// рассматриваются (для мелких деталей: сначала пробуем без края, и только
// если ничего не нашлось — второй вызов с avoidBorder=false).
function tryPlace(occ, cols, rows, variants, avoidBorder) {
  let best = null, bestScore = -Infinity
  let evaluated = 0
  for (let gy = 0; gy <= rows - 1 && evaluated < MAX_CANDIDATES; gy++) {
    const intervals = freeIntervals(occ, cols, gy)
    if (!intervals.length) continue
    for (const variant of variants) {
      if (gy + variant.rows > rows) continue
      for (const iv of intervals) {
        const maxGx = Math.min(iv.end - variant.cols, cols - variant.cols)
        if (maxGx < iv.start) continue
        // Кандидаты — только "углы" свободного участка (его начало и конец),
        // а не КАЖДАЯ ячейка внутри интервала: это стандартный приём (как
        // углы свободных прямоугольников в MaxRects/Guillotine), который и
        // делает поиск быстрым, и не даёт ему "проскочить" мимо вогнутого паза.
        const candidatesX = new Set([iv.start, maxGx])
        for (const gx of candidatesX) {
          if (evaluated >= MAX_CANDIDATES) break
          if (avoidBorder && touchesBorder(gx, gy, variant, cols, rows)) continue
          if (fits(occ, cols, rows, gx, gy, variant.dilated, variant.cols, variant.rows)) {
            evaluated++
            const score = contactScore(occ, cols, rows, gx, gy, variant.offsets)
            // Прилегание — главный критерий (затягивает в паз); ниже и левее — тай-брейк
            const key = score * 1e6 - (gy * cols + gx)
            if (key > bestScore) { bestScore = key; best = { gx, gy, variant } }
          }
        }
      }
    }
  }
  return best
}

function placeInstance(occ, cols, rows, inst) {
  if (inst.isSmall) {
    const away = tryPlace(occ, cols, rows, inst.variants, true)
    if (away) return away
  }
  return tryPlace(occ, cols, rows, inst.variants, false)
}

function attemptPack(pieceInstances, cols, rows) {
  const sheets = []
  let cur = null
  const openSheet = () => { cur = { index: sheets.length, occ: new Uint8Array(cols * rows), placed: [] }; sheets.push(cur) }
  openSheet()
  for (const inst of pieceInstances) {
    let placement = placeInstance(cur.occ, cols, rows, inst)
    if (!placement) {
      openSheet()
      placement = placeInstance(cur.occ, cols, rows, inst)
      if (!placement) continue // деталь физически больше листа — пропускаем, как и rectangle-алгоритм не обрабатывает этот случай отдельно
    }
    markOccupied(cur.occ, cols, rows, placement.gx, placement.gy, placement.variant.dilated)
    cur.placed.push({ inst, placement })
  }
  return sheets
}

function rebuildOccupancy(sheet, cols, rows) {
  sheet.occ = new Uint8Array(cols * rows)
  sheet.placed.forEach(item => markOccupied(sheet.occ, cols, rows, item.placement.gx, item.placement.gy, item.placement.variant.dilated))
}

// Компакция: пробуем переложить детали с ПОСЛЕДНИХ листов на более ранние,
// если там реально есть куда — может схлопнуть число листов и уплотнить хвост.
function compactSheets(sheets, cols, rows) {
  for (let pass = 0; pass < MAX_COMPACT_PASSES; pass++) {
    let moved = false
    for (let si = sheets.length - 1; si >= 1; si--) {
      const sheet = sheets[si]
      for (let pi = sheet.placed.length - 1; pi >= 0; pi--) {
        const item = sheet.placed[pi]
        for (let ti = 0; ti < si; ti++) {
          const target = sheets[ti]
          const placement = placeInstance(target.occ, cols, rows, item.inst)
          if (placement) {
            sheet.placed.splice(pi, 1)
            rebuildOccupancy(sheet, cols, rows)
            markOccupied(target.occ, cols, rows, placement.gx, placement.gy, placement.variant.dilated)
            target.placed.push({ inst: item.inst, placement })
            moved = true
            break
          }
        }
      }
    }
    for (let si = sheets.length - 1; si >= 1; si--) {
      if (sheets[si].placed.length === 0) sheets.splice(si, 1)
    }
    sheets.forEach((s, i) => { s.index = i })
    if (!moved) break
  }
  return sheets
}

function scoreSheets(sheets, cols, rows) {
  if (!sheets.length) return { sheetCount: Infinity, lastFill: 0 }
  const last = sheets[sheets.length - 1]
  let filled = 0
  for (let i = 0; i < last.occ.length; i++) filled += last.occ[i]
  return { sheetCount: sheets.length, lastFill: filled / (cols * rows) }
}
function better(a, b) {
  if (a.sheetCount !== b.sheetCount) return a.sheetCount < b.sheetCount
  return a.lastFill > b.lastFill
}

export async function packTrueShape({
  details, sheetL, sheetW, marginT, marginR, marginB, marginL, kerf, optimizeSeconds = 12,
  smallPartsToCenter = false, smallPartsMaxSquareSide = 0, smallPartsMaxSide = 0,
}) {
  const usableX = sheetW - marginL - marginR
  const usableY = sheetL - marginT - marginB
  const cellSize = Math.min(MAX_CELL_MM, Math.max(MIN_CELL_MM, Math.sqrt((usableX * usableY) / TARGET_CELLS)))
  const cols = Math.max(1, Math.ceil(usableX / cellSize))
  const rows = Math.max(1, Math.ceil(usableY / cellSize))
  const padCells = kerf > 0 ? Math.max(1, Math.ceil(kerf / cellSize)) : 0
  const smallMaxArea = smallPartsMaxSquareSide > 0 ? smallPartsMaxSquareSide * smallPartsMaxSquareSide : 0

  const kindsByDetail = details.map(d => buildPieceKind(d, cellSize, padCells))

  const instances = []
  details.forEach((d, di) => {
    const v0 = kindsByDetail[di][0]
    const area = v0.w * v0.h, minSide = Math.min(v0.w, v0.h)
    const isSmall = smallPartsToCenter && (
      (smallMaxArea > 0 && area <= smallMaxArea) ||
      (smallPartsMaxSide > 0 && minSide <= smallPartsMaxSide)
    )
    for (let q = 0; q < (Number(d.qty) || 1); q++) {
      instances.push({
        detailIndex: di, cellSize, isSmall,
        variants: kindsByDetail[di],
        label: d.display_name || d.name, prefix: d.prefix,
        edgeTop: d.edge_top, edgeRight: d.edge_right, edgeBottom: d.edge_bottom, edgeLeft: d.edge_left,
        area,
      })
    }
  })

  const orderings = [
    instances.slice().sort((a, b) => b.area - a.area),
    instances.slice().sort((a, b) => Math.max(b.variants[0].w, b.variants[0].h) - Math.max(a.variants[0].w, a.variants[0].h)),
    instances.slice().sort((a, b) => Math.min(a.variants[0].w, a.variants[0].h) - Math.min(b.variants[0].w, b.variants[0].h)),
  ]

  let best = null, bestScore = null
  const budgetMs = Math.min(8000, Math.max(0, Number(optimizeSeconds) || 0) * 1000 + 800)
  const startTime = Date.now()
  for (const order of orderings) {
    const sheets = attemptPack(order, cols, rows)
    const score = scoreSheets(sheets, cols, rows)
    if (!best || better(score, bestScore)) { best = sheets; bestScore = score }
    if (Date.now() - startTime > budgetMs) break
    await new Promise(r => setTimeout(r, 0))
  }
  // Несколько случайных перестановок в оставшееся время бюджета — те же
  // структурные порядки не всегда лучшие для конкретного набора силуэтов.
  while (Date.now() - startTime < budgetMs) {
    const shuffled = instances.slice()
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
    }
    const sheets = attemptPack(shuffled, cols, rows)
    const score = scoreSheets(sheets, cols, rows)
    if (better(score, bestScore)) { best = sheets; bestScore = score }
    await new Promise(r => setTimeout(r, 0))
  }

  best = compactSheets(best, cols, rows)

  const resultSheets = best.map(s => ({
    index: s.index,
    freeRects: [], // для true-shape листов автообрезки (по прямоугольным freeRects) не считаются — см. ограничения выше
    placed: s.placed.map(({ inst, placement }) => {
      const v = placement.variant
      const times = v.angle / 90
      const rotated = v.angle === 90 || v.angle === 270
      const origX = v.w, origY = v.h
      let top = inst.edgeTop, right = inst.edgeRight, bottom = inst.edgeBottom, left = inst.edgeLeft
      for (let i = 0; i < times; i++) {
        const nTop = left, nRight = top, nBottom = right, nLeft = bottom
        top = nTop; right = nRight; bottom = nBottom; left = nLeft
      }
      return {
        detailIndex: inst.detailIndex, label: inst.label, prefix: inst.prefix,
        x: placement.gx * inst.cellSize, y: placement.gy * inst.cellSize,
        w: origX + kerf, h: origY + kerf,
        origX, origY, rotated, rotation: v.angle, rotatable: inst.variants.length > 2,
        isSmall: inst.isSmall,
        edgeTop: top, edgeRight: right, edgeBottom: bottom, edgeLeft: left,
        polygon: v.polygon.map(([x, y]) => ({ x, y })),
      }
    }),
  }))

  return { sheets: resultSheets, usableX, usableY, sheetL, sheetW, marginT, marginR, marginB, marginL, kerf }
}
