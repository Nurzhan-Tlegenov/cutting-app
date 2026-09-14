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
const TARGET_CELLS = 100000 // компромисс точность/скорость (было 60000, затем 160000 — на большом числе деталей это давало слишком дорогой перебор кандидатов)
const MAX_COMPACT_PASSES = 3

// Скругление угла (радиус на обычной точке контура) — превращаем в несколько
// точек дуги, а не отбрасываем радиус. Это работает одинаково корректно и для
// ВЫПУКЛОГО угла (скругление СРЕЗАЕТ материал), и для ВОГНУТОГО, "внутреннего"
// угла паза (скругление, наоборот, ДОБАВЛЯЕТ материал в паз) — направление
// получается автоматически из той же тангенциальной геометрии, что и в
// ContourEditor (buildPath/arcTo), без отдельного разбора "выпуклый/вогнутый".
// Именно вогнутый случай и был причиной реального пересечения деталей: если
// угол паза скруглён, но радиус игнорировался, туда легально ставили соседнюю
// деталь вплотную к ТЕОРЕТИЧЕСКОЙ острой точке, а настоящий (скруглённый)
// материал там на самом деле чуть выступает дальше в паз.
function roundCorner(prev, curr, next, r, segments = 16) {
  const dx0 = prev.x - curr.x, dy0 = prev.y - curr.y
  const dx1 = next.x - curr.x, dy1 = next.y - curr.y
  const d0 = Math.hypot(dx0, dy0), d1 = Math.hypot(dx1, dy1)
  if (r <= 0 || d0 === 0 || d1 === 0) return [[curr.x, curr.y]]
  const u0 = [dx0 / d0, dy0 / d0], u1 = [dx1 / d1, dy1 / d1]
  const dot = Math.max(-1, Math.min(1, u0[0] * u1[0] + u0[1] * u1[1]))
  const theta = Math.acos(dot)
  const half = theta / 2
  if (half < 1e-6 || half > Math.PI / 2 - 1e-9) return [[curr.x, curr.y]] // почти прямая или почти разворот — скругление не имеет смысла
  let tt = r / Math.tan(half)
  const maxT = Math.min(d0, d1)
  let rr = r
  if (tt > maxT) { tt = maxT; rr = tt * Math.tan(half) } // радиус физически не влезает между соседними вершинами — тот же принцип, что в ContourEditor (min(r,d0,d1))
  const centerDist = tt / Math.cos(half)
  const bx = u0[0] + u1[0], by = u0[1] + u1[1]
  const blen = Math.hypot(bx, by) || 1
  const bux = bx / blen, buy = by / blen
  const cx = curr.x + centerDist * bux, cy = curr.y + centerDist * buy
  const pIn = [curr.x + tt * u0[0], curr.y + tt * u0[1]]
  const pOut = [curr.x + tt * u1[0], curr.y + tt * u1[1]]
  let a0 = Math.atan2(pIn[1] - cy, pIn[0] - cx)
  let a1 = Math.atan2(pOut[1] - cy, pOut[0] - cx)
  let diff = a1 - a0
  while (diff > Math.PI) diff -= Math.PI * 2
  while (diff < -Math.PI) diff += Math.PI * 2
  const pts = []
  for (let i = 0; i <= segments; i++) {
    const a = a0 + diff * (i / segments)
    pts.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)])
  }
  return pts
}

// Явный fillet (дуга на стыке прямой и дуги через 3+ точек) — параметры уже
// посчитаны в ContourEditor и сохранены в самой вершине, просто сэмплируем.
function sampleFillet(v, segments = 16) {
  const ccw = !!v.fccw
  let a0 = v.fa0, a1 = v.fa1
  let diff = a1 - a0
  if (ccw) { while (diff > 0) diff -= Math.PI * 2 } else { while (diff < 0) diff += Math.PI * 2 }
  const pts = []
  for (let i = 0; i <= segments; i++) {
    const a = a0 + diff * (i / segments)
    pts.push([v.fcx + v.fr * Math.cos(a), v.fcy + v.fr * Math.sin(a)])
  }
  return pts
}

function circumcenter(a, b, c) {
  const D = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y))
  if (Math.abs(D) < 0.001) return null
  const ux = ((a.x * a.x + a.y * a.y) * (b.y - c.y) + (b.x * b.x + b.y * b.y) * (c.y - a.y) + (c.x * c.x + c.y * c.y) * (a.y - b.y)) / D
  const uy = ((a.x * a.x + a.y * a.y) * (c.x - b.x) + (b.x * b.x + b.y * b.y) * (a.x - c.x) + (c.x * c.x + c.y * c.y) * (b.x - a.x)) / D
  return { x: ux, y: uy }
}

// Дуга через 3 точки (circumcircle) — та же логика направления обхода, что и
// drawArc3 в ContourEditor.jsx: идём от sp к ep так, чтобы пройти через mid.
function sampleArc3(sp, mid, ep, segments = 16) {
  const C = circumcenter(sp, mid, ep)
  if (!C) return [[sp.x, sp.y], [ep.x, ep.y]] // почти на одной прямой — сэмплировать нечего
  const R = Math.hypot(sp.x - C.x, sp.y - C.y)
  const sa = Math.atan2(sp.y - C.y, sp.x - C.x)
  const ma = Math.atan2(mid.y - C.y, mid.x - C.x)
  const ea = Math.atan2(ep.y - C.y, ep.x - C.x)
  let dma = ma - sa; while (dma < 0) dma += Math.PI * 2
  let dea = ea - sa; while (dea < 0) dea += Math.PI * 2
  const anticlockwise = dma > dea
  const sweepEnd = anticlockwise ? sa - (Math.PI * 2 - dea) : sa + dea
  const pts = []
  for (let i = 0; i <= segments; i++) {
    const a = sa + (sweepEnd - sa) * (i / segments)
    pts.push([C.x + R * Math.cos(a), C.y + R * Math.sin(a)])
  }
  return pts
}

// Внешний контур детали → плоский список точек полигона, С УЧЁТОМ радиусов
// скругления (roundCorner), явных fillet-дуг (sampleFillet) и свободных дуг
// через 3+ точки (sampleArc3, тип 'arc') — повторяет обход buildPath из
// ContourEditor.jsx, а не просто берёт сырые координаты вершин. Это важно:
// дуга через точки — не маленькое скругление угла, а часто заметный изгиб
// границы детали, и если брать вместо неё прямую (хорду), настоящий материал
// детали в этом месте оказывается ближе к соседней детали, чем показывает
// прямая — соседнюю деталь можно легально поставить туда, где на самом деле
// уже есть материал, и в реальности они пересекутся.
function verticesToPolygon(vertices) {
  const n = vertices.length
  const poly = []
  let i = 0
  while (i < n) {
    const curr = vertices[i]
    if (curr.type === 'arc') {
      const arcGroup = []
      let j = i
      while (j < n && vertices[j % n].type === 'arc') { arcGroup.push(vertices[j % n]); j++ }
      const sp = vertices[(i - 1 + n) % n]
      const ep = vertices[j % n]
      if (arcGroup.length === 1) {
        poly.push(...sampleArc3(sp, arcGroup[0], ep))
      } else {
        for (let k = 0; k + 1 < arcGroup.length; k++) {
          const s = k === 0 ? sp : arcGroup[k - 1]
          const e = k === arcGroup.length - 2 ? ep : arcGroup[k + 2]
          poly.push(...sampleArc3(s, arcGroup[k], e))
        }
      }
      i = j // индекс next-точки (не входящей в группу) обработается на следующей итерации как обычная точка
      continue
    }
    if (curr.type === 'fillet' && curr.fcx != null && curr.fcy != null && curr.fr != null) {
      poly.push(...sampleFillet(curr))
    } else if ((curr.r || 0) > 0 && (!curr.type || curr.type === 'point')) {
      const prev = vertices[(i - 1 + n) % n], next = vertices[(i + 1) % n]
      poly.push(...roundCorner(prev, curr, next, curr.r))
    } else {
      poly.push([Number(curr.x) || 0, Number(curr.y) || 0])
    }
    i++
  }
  return poly
}

export function parsePolygonFromDetail(d) {
  let contour = null
  try { contour = d.contour ? JSON.parse(d.contour) : null } catch { contour = null }
  const w = Number(d.width) || 0, h = Number(d.length) || 0
  if (!contour || !contour.vertices || contour.vertices.length <= 4) {
    return { polygon: [[0, 0], [w, 0], [w, h], [0, h]], w, h, custom: false }
  }
  const poly = verticesToPolygon(contour.vertices)
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
  // Для оценки прилегания (contactScore) достаточно ячеек НА ГРАНИЦЕ силуэта
  // (у которых хоть один из 4 соседей не входит в саму деталь) — внутренние
  // ячейки крупной детали никогда ни с чем не соприкасаются, перебирать их на
  // каждой из тысяч проверяемых позиций смысла нет и это на порядки дороже.
  const set = new Set(offsets.map(([dx, dy]) => dx + ',' + dy))
  const boundary = offsets.filter(([dx, dy]) =>
    !set.has((dx + 1) + ',' + dy) || !set.has((dx - 1) + ',' + dy) ||
    !set.has(dx + ',' + (dy + 1)) || !set.has(dx + ',' + (dy - 1))
  )
  const boundarySet = new Set(boundary.map(([dx, dy]) => dx + ',' + dy))
  return { angle, w, h, polygon, cols, rows, offsets, boundary, boundarySet, dilated: dilateOffsets(offsets, padCells) }
}

// 0° и 180° — всегда (не трогают направление текстуры). 90° и 270° — только
// если у детали отключена текстура (rotatable=true).
function buildPieceKind(detail, cellSize, kerf) {
  const { polygon, w, h, custom } = parsePolygonFromDetail(detail)
  // Запас "+1 ячейка сверх керфа" нужен только для реально нарисованного
  // контура (там растеризация "по центру ячейки" у дуг/радиусов не идеальна
  // ровно на границе) — для обычного прямоугольника это лишнее и на грубой
  // сетке может съесть весь физический зазор между деталями (900+900мм на
  // листе 1830мм — запаса всего ~27мм, а "лишняя" ячейка на грубой сетке
  // может стоить 10-15мм с каждой стороны).
  const padCells = custom ? Math.max(1, Math.ceil(kerf / cellSize)) + 1 : Math.max(1, Math.ceil(kerf / cellSize))
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

// Оценка размещения: раньше здесь был "максимум контакта" — но контакт не то
// же самое, что компактность. Проверено на реальном случае: два одинаковых
// вогнутых силуэта, поставленные ВПЛОТНУЮ ДРУГ К ДРУГУ прямой стороной, дают
// БОЛЬШЕ контакта (полная сторона), чем деталь, задвинутая в паз соседней
// (контакт только по кромке паза) — хотя вложение экономит гораздо больше
// места. Поэтому главный критерий — МИНИМАЛЬНАЯ итоговая занятая площадь
// листа (габарит всех уложенных деталей после этого размещения), а контакт —
// только добавка при равной площади (не даёт метаться между позициями с
// одинаковым габаритом, но разным реальным прилеганием).
function contactScore(occ, cols, rows, gx, gy, boundaryOffsets, boundarySet) {
  let contact = 0
  for (const [dx, dy] of boundaryOffsets) {
    const cx = gx + dx, cy = gy + dy
    ;[[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([ox, oy]) => {
      const ndx = dx + ox, ndy = dy + oy
      if (boundarySet.has(ndx + ',' + ndy)) return // сосед — тоже часть этой же детали, не считаем
      const ncx = cx + ox, ncy = cy + oy
      if (ncx < 0 || ncy < 0 || ncx >= cols || ncy >= rows) return // край листа — не считаем контактом
      if (occ[ncy * cols + ncx]) contact++ // уже занято соседней деталью
    })
  }
  return contact
}

const MAX_CANDIDATES = 3000 // ограничение на число вариантов, которые реально оцениваем — держит расчёт быстрым (считаются ВСЕ попытки, не только удачные)

// avoidBorder=true — кандидаты, касающиеся края используемой зоны, вообще не
// рассматриваются (для мелких деталей: сначала пробуем без края, и только
// если ничего не нашлось — второй вызов с avoidBorder=false).
// envCols/envRows — текущий занятый габарит листа (в ячейках) ДО этого
// размещения; нужен, чтобы оценить, насколько каждая позиция его увеличит.
function tryPlace(occ, cols, rows, variants, avoidBorder, anchorXs, envCols, envRows) {
  let best = null, bestScore = -Infinity
  let evaluated = 0
  // Лимит кандидатов — от размера детали, не фиксированный: fits() стоит
  // O(число занятых ячеек детали), и для крупной сплошной детали (тысячи
  // ячеек) даже 1500 честных попыток — уже десятки миллионов операций.
  // Держим общий БЮДЖЕТ ОПЕРАЦИЙ примерно постоянным независимо от размера
  // детали, а не число попыток.
  const maxDilated = Math.max(1, ...variants.map(v => v.dilated.length))
  const localMax = Math.min(MAX_CANDIDATES, Math.max(300, Math.floor(20_000_000 / maxDilated)))
  let prevSignature = null
  for (let gy = 0; gy <= rows - 1 && evaluated < localMax; gy++) {
    const intervals = freeIntervals(occ, cols, gy)
    if (!intervals.length) { prevSignature = ''; continue }
    // Строка с ТОЙ ЖЕ структурой свободных участков, что и предыдущая, не
    // даёт ничего нового: кандидаты будут теми же самыми, а итоговый габарит
    // только больше (выше по листу) — заведомо не лучше. Пропускаем, не теряя
    // ни одной реальной возможности — переход между разными структурами (где
    // что-то заканчивается/начинается) НЕ пропускается, а именно там и
    // открываются узкие проходы для вложения контур-в-контур.
    const signature = intervals.map(iv => iv.start + '-' + iv.end).join(',')
    // Пропуск одинаковых строк ОПАСЕН для avoidBorder: близость к краю листа
    // зависит от АБСОЛЮТНОЙ строки (верх/низ), а не от формы свободного
    // участка — у двух рядов с одинаковой структурой (например, 0-й и 50-й)
    // разный статус "у края", и пропуская их как "одинаковые", мы никогда не
    // доходим до строк, где деталь уже не касается верхней/нижней границы.
    if (!avoidBorder && signature === prevSignature) continue
    prevSignature = signature
    for (const variant of variants) {
      if (gy + variant.rows > rows) continue
      for (const iv of intervals) {
        const fitsFullWidth = variant.cols <= iv.end - iv.start
        const candidatesX = new Set([iv.start])
        if (fitsFullWidth) {
          // Обычный случай: весь габарит детали помещается в этот участок —
          // как раньше, пробуем оба края и середину.
          const rightAligned = iv.end - variant.cols
          candidatesX.add(rightAligned)
          if (iv.end - iv.start > variant.cols) candidatesX.add(iv.start + Math.floor((iv.end - iv.start - variant.cols) / 2))
          if (anchorXs) {
            for (const ax of anchorXs) {
              if (ax >= iv.start && ax <= rightAligned) candidatesX.add(ax)
              const axLeft = ax - variant.cols
              if (axLeft >= iv.start && axLeft <= rightAligned) candidatesX.add(axLeft)
            }
          }
        }
        // Узкий участок (габарит детали шире, чем свободно ИМЕННО в этой
        // строке) — не пропускаем целиком (это и есть путь к вложению
        // контур-в-контур: узкая ножка детали может пройти тут, а более
        // широкая часть встанет выше/ниже, где просторнее), но и НЕ плодим
        // здесь много кандидатов — дорого на каждой строке, если детали
        // вокруг уже много: пробуем только левый край участка (iv.start,
        // уже добавлен выше) — этого достаточно, чтобы найти вложение, а
        // настоящую проверку (влезает ли ВСЯ деталь по всем её строкам)
        // всё равно делает fits() ниже.
        for (const gx of candidatesX) {
          if (evaluated >= localMax) break
          evaluated++ // считаем ЛЮБУЮ попытку, а не только удачную — иначе при большом числе неудачных кандидатов лимит вообще не срабатывает
          if (gx + variant.cols > cols) continue
          if (avoidBorder && touchesBorder(gx, gy, variant, cols, rows)) continue
          if (fits(occ, cols, rows, gx, gy, variant.dilated, variant.cols, variant.rows)) {
            const newCols = Math.max(envCols, gx + variant.cols)
            const newRows = Math.max(envRows, gy + variant.rows)
            const area = newCols * newRows
            const score = contactScore(occ, cols, rows, gx, gy, variant.boundary, variant.boundarySet)
            // Площадь — главный критерий (меньше — лучше); контакт — добавка
            // при равной площади; ниже и левее — финальный тай-брейк.
            const key = -area * 1e6 + score * 10 - (gy * cols + gx) * 0.001
            if (key > bestScore) { bestScore = key; best = { gx, gy, variant } }
          }
        }
      }
    }
  }
  return best
}

function placeInstance(occ, cols, rows, inst, anchorXs, envCols, envRows) {
  if (inst.isSmall) {
    const away = tryPlace(occ, cols, rows, inst.variants, true, anchorXs, envCols, envRows)
    if (away) return away
  }
  return tryPlace(occ, cols, rows, inst.variants, false, anchorXs, envCols, envRows)
}

const YIELD_EVERY_PIECES = 3 // как часто внутри одной попытки укладки отдаём управление браузеру — иначе таймер и спиннер "замирают"

function cloneOcc(occ) { return occ.slice() }

// ─── Просчёт ПАРЫ одинаковых деталей подряд — не по одной, а сразу вдвоём.
// Иначе первая из двух ставится в ЛЮБОМ повороте (для неё самой, в одиночку,
// все повороты выглядят одинаково хорошо — сравнивать пока не с чем), а
// именно от ЭТОГО произвольного выбора зависит, сможет ли вторая деталь той
// же формы лечь в её вырез. Проверено на реальном образце (эталонный DXF):
// деталь с вырезом входит в паз такой же детали, повёрнутой на 180°, ТОЛЬКО
// если первая стоит в конкретном повороте — при другом эта же пара пересекается.
// Перебираем все сочетания поворотов обеих деталей и берём то, что даёт
// наименьший общий габарит пары — это и есть выбор "какой стороной поставить
// первую", которого обычная поштучная укладка в принципе не делает.
function tryPlacePair(occ, cols, rows, instA, instB, anchorXs, envCols, envRows) {
  let best = null, bestArea = Infinity, bestScore = -Infinity
  for (const vA of instA.variants) {
    const placeA = tryPlace(occ, cols, rows, [vA], false, anchorXs, envCols, envRows)
    if (!placeA) continue
    const occ2 = cloneOcc(occ)
    markOccupied(occ2, cols, rows, placeA.gx, placeA.gy, placeA.variant.dilated)
    const envCols2 = Math.max(envCols, placeA.gx + placeA.variant.cols)
    const envRows2 = Math.max(envRows, placeA.gy + placeA.variant.rows)
    const anchorXs2 = anchorXs.concat([placeA.gx + placeA.variant.cols])
    vA.polygon.forEach(([vx]) => anchorXs2.push(placeA.gx + Math.round(vx / instA.cellSize)))
    for (const vB of instB.variants) {
      const placeB = tryPlace(occ2, cols, rows, [vB], false, anchorXs2, envCols2, envRows2)
      if (!placeB) continue
      const totalCols = Math.max(envCols2, placeB.gx + placeB.variant.cols)
      const totalRows = Math.max(envRows2, placeB.gy + placeB.variant.rows)
      const area = totalCols * totalRows
      if (area < bestArea) { bestArea = area; best = { placeA, placeB } }
    }
  }
  return best
}

async function attemptPack(pieceInstances, cols, rows, deadline) {
  const sheets = []
  let cur = null
  const openSheet = () => { cur = { index: sheets.length, occ: new Uint8Array(cols * rows), placed: [], envCols: 0, envRows: 0 }; sheets.push(cur) }
  openSheet()
  let n = 0
  let idx = 0
  while (idx < pieceInstances.length) {
    if (deadline && Date.now() > deadline) break // одна попытка сама по себе может быть слишком долгой на большом заказе — прерываем, а не игнорируем бюджет времени
    const inst = pieceInstances[idx]
    // Якоря — не только правый край габарита уже уложенных деталей, но и
    // координаты ВСЕХ их вершин (в клетках). Это важно для деталей с пазом:
    // новая деталь должна суметь встать так, чтобы её край совпал именно с
    // краем ВЫРЕЗА соседней (а это может быть любая вершина её контура, а
    // не только правая граница габарита) — иначе состыковать зубец в паз
    // просто негде "зацепиться" среди проверяемых позиций.
    const anchorXsRaw = []
    cur.placed.forEach(item => {
      const { gx, variant } = item.placement
      anchorXsRaw.push(gx + variant.cols)
      variant.polygon.forEach(([vx]) => anchorXsRaw.push(gx + Math.round(vx / inst.cellSize)))
    })
    const anchorXs = [...new Set(anchorXsRaw)] // одинаковые детали дают одни и те же смещения вершин — без дедупликации список раздувается и на каждой позиции перебирается заново

    // Следующая деталь той же формы — просчитываем ОБЕ сразу (см. tryPlacePair),
    // не только эту одну: именно связка "какой стороной ставим первую" решает,
    // войдёт ли вторая в её вырез. Только когда у детали больше 1 варианта
    // поворота — для симметричного прямоугольника (1 вариант) выбор не стоит.
    // Просчёт пары — только для ПЕРВЫХ двух деталей на листе (когда ещё не с
    // чем сравнивать: у первой детали в одиночку все повороты выглядят
    // одинаково хорошо, и именно это решает, войдёт ли вторая в её паз).
    // Дальше по листу уже есть за что "зацепиться" (anchorXs от соседей),
    // и парный перебор только замедляет расчёт, не давая сопоставимой пользы.
    const nextInst = pieceInstances[idx + 1]
    if (cur.placed.length === 0 && nextInst && nextInst.detailIndex === inst.detailIndex && inst.variants.length > 1) {
      const pair = tryPlacePair(cur.occ, cols, rows, inst, nextInst, anchorXs, cur.envCols, cur.envRows)
      if (pair) {
        markOccupied(cur.occ, cols, rows, pair.placeA.gx, pair.placeA.gy, pair.placeA.variant.dilated)
        cur.placed.push({ inst, placement: pair.placeA })
        cur.envCols = Math.max(cur.envCols, pair.placeA.gx + pair.placeA.variant.cols)
        cur.envRows = Math.max(cur.envRows, pair.placeA.gy + pair.placeA.variant.rows)
        markOccupied(cur.occ, cols, rows, pair.placeB.gx, pair.placeB.gy, pair.placeB.variant.dilated)
        cur.placed.push({ inst: nextInst, placement: pair.placeB })
        cur.envCols = Math.max(cur.envCols, pair.placeB.gx + pair.placeB.variant.cols)
        cur.envRows = Math.max(cur.envRows, pair.placeB.gy + pair.placeB.variant.rows)
        idx += 2
        n += 2
        if (n % YIELD_EVERY_PIECES === 0) await new Promise(r => setTimeout(r, 0))
        continue
      }
    }

    let placement = placeInstance(cur.occ, cols, rows, inst, anchorXs, cur.envCols, cur.envRows)
    if (!placement) {
      openSheet()
      placement = placeInstance(cur.occ, cols, rows, inst, [], 0, 0)
      if (!placement) { idx++; continue } // деталь физически больше листа — пропускаем, как и rectangle-алгоритм не обрабатывает этот случай отдельно
    }
    markOccupied(cur.occ, cols, rows, placement.gx, placement.gy, placement.variant.dilated)
    cur.placed.push({ inst, placement })
    cur.envCols = Math.max(cur.envCols, placement.gx + placement.variant.cols)
    cur.envRows = Math.max(cur.envRows, placement.gy + placement.variant.rows)
    idx++
    n++
    if (n % YIELD_EVERY_PIECES === 0) await new Promise(r => setTimeout(r, 0))
  }
  return sheets
}

function rebuildOccupancy(sheet, cols, rows) {
  sheet.occ = new Uint8Array(cols * rows)
  sheet.envCols = 0; sheet.envRows = 0
  sheet.placed.forEach(item => {
    markOccupied(sheet.occ, cols, rows, item.placement.gx, item.placement.gy, item.placement.variant.dilated)
    sheet.envCols = Math.max(sheet.envCols, item.placement.gx + item.placement.variant.cols)
    sheet.envRows = Math.max(sheet.envRows, item.placement.gy + item.placement.variant.rows)
  })
}

// ─── "Гравитация" — стягивает уже уложенные детали друг к другу и к началу
// координат. Конструктивная укладка (contact-score) находит ХОРОШУЮ позицию
// для каждой детали В МОМЕНТ её размещения, но не возвращается позже, чтобы
// подвинуть её ближе, если после неё встали другие детали. Без этого шага
// между одинаковыми деталями остаются немотивированные разрывы (деталь просто
// осталась там, где её поставили первой, хотя место рядом с соседом уже
// давно свободно). Два ОТДЕЛЬНЫХ прохода (влево, затем вниз), а не сдвиг по
// обеим осям сразу у каждой детали по очереди — иначе порядок обработки
// уводит детали по диагонали в стороны вместо аккуратного смыкания рядов.
function gravityAxis(sheet, cols, rows, axis) {
  let moved = false
  const order = sheet.placed.map((_, i) => i)
    .sort((a, b) => (axis === 'x' ? sheet.placed[a].placement.gx - sheet.placed[b].placement.gx
                                   : sheet.placed[a].placement.gy - sheet.placed[b].placement.gy))
  for (const idx of order) {
    const item = sheet.placed[idx]
    const variant = item.placement.variant
    const occ = new Uint8Array(cols * rows)
    sheet.placed.forEach((o, i) => { if (i !== idx) markOccupied(occ, cols, rows, o.placement.gx, o.placement.gy, o.placement.variant.dilated) })
    const { gx, gy } = item.placement
    if (axis === 'x') {
      let nx = gx
      while (nx > 0 && fits(occ, cols, rows, nx - 1, gy, variant.dilated, variant.cols, variant.rows)) nx--
      if (nx !== gx) { item.placement = { ...item.placement, gx: nx }; moved = true }
    } else {
      let ny = gy
      while (ny > 0 && fits(occ, cols, rows, gx, ny - 1, variant.dilated, variant.cols, variant.rows)) ny--
      if (ny !== gy) { item.placement = { ...item.placement, gy: ny }; moved = true }
    }
    markOccupied(occ, cols, rows, item.placement.gx, item.placement.gy, variant.dilated)
    sheet.occ = occ
  }
  return moved
}

async function gravityCompact(sheets, cols, rows, deadline) {
  for (const sheet of sheets) {
    for (let pass = 0; pass < 6; pass++) {
      if (Date.now() > deadline) return sheets
      const movedX = gravityAxis(sheet, cols, rows, 'x')
      await new Promise(r => setTimeout(r, 0))
      const movedY = gravityAxis(sheet, cols, rows, 'y')
      await new Promise(r => setTimeout(r, 0))
      if (!movedX && !movedY) break
    }
    rebuildOccupancy(sheet, cols, rows)
  }
  return sheets
}

// Компакция: пробуем переложить детали с ПОСЛЕДНИХ листов на более ранние,
// если там реально есть куда — может схлопнуть число листов и уплотнить хвост.
async function compactSheets(sheets, cols, rows, deadline) {
  for (let pass = 0; pass < MAX_COMPACT_PASSES; pass++) {
    if (Date.now() > deadline) break
    let moved = false
    let n = 0
    outer: for (let si = sheets.length - 1; si >= 1; si--) {
      const sheet = sheets[si]
      for (let pi = sheet.placed.length - 1; pi >= 0; pi--) {
        if (Date.now() > deadline) break outer
        const item = sheet.placed[pi]
        for (let ti = 0; ti < si; ti++) {
          const target = sheets[ti]
          const anchorXs = target.placed.map(p => p.placement.gx + p.placement.variant.cols)
          const placement = placeInstance(target.occ, cols, rows, item.inst, anchorXs, target.envCols, target.envRows)
          if (placement) {
            sheet.placed.splice(pi, 1)
            rebuildOccupancy(sheet, cols, rows)
            markOccupied(target.occ, cols, rows, placement.gx, placement.gy, placement.variant.dilated)
            target.placed.push({ inst: item.inst, placement })
            target.envCols = Math.max(target.envCols, placement.gx + placement.variant.cols)
            target.envRows = Math.max(target.envRows, placement.gy + placement.variant.rows)
            moved = true
            break
          }
        }
        n++
        if (n % YIELD_EVERY_PIECES === 0) await new Promise(r => setTimeout(r, 0))
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

// ─── Генетический алгоритм по порядку укладки — та же логика (турнирный
// отбор / order crossover / направленная мутация), что уже проверена в
// rectangle-алгоритме (src/lib/nesting.js), продублирована здесь напрямую:
// связывать модули ради нескольких небольших чистых функций не стоило —
// проще и безопаснее держать копию, не рискуя случайно задеть отточенный
// прямоугольный путь при развитии true-shape отдельно.
function shuffleTS(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}
function tournamentSelectTS(evaluated, k) {
  let winner = null
  for (let i = 0; i < k; i++) {
    const cand = evaluated[Math.floor(Math.random() * evaluated.length)]
    if (!winner || better(cand.stat, winner.stat)) winner = cand
  }
  return winner
}
function orderCrossoverTS(parentA, parentB) {
  const n = parentA.length
  let i = Math.floor(Math.random() * n), j = Math.floor(Math.random() * n)
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
    if (!usedIds.has(gene.id)) { child[emptyPositions[ptr]] = gene; usedIds.add(gene.id); ptr++ }
  }
  return child
}
function perturbOrderTS(order) {
  const arr = order.slice()
  const swaps = 1 + Math.floor(Math.random() * 5)
  for (let s = 0; s < swaps; s++) {
    const i = Math.floor(Math.random() * arr.length), j = Math.floor(Math.random() * arr.length)
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

// ─── Финальная проверка ПО ТОЧНОЙ геометрии (не по сетке) ─────────────────
// Сетка (даже мелкая) — это всегда приближение: ячейка проверяется по своему
// центру, и прямо на изгибе/дуге могут случайно допустить чуть большее
// касание, чем есть на самом деле. Поэтому после укладки по сетке — отдельно,
// точной математикой (пересечение отрезков + "точка внутри полигона")
// проверяем ВСЕ пары деталей на каждом листе. Если где-то всё же нашлось
// пересечение — это надёжная защита, а не догадка: деталь снимается с листа
// и переставляется заново (в худшем случае — на новый лист).
function segmentsIntersect(a1, a2, b1, b2) {
  const d = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
  const d1 = d(b1, b2, a1), d2 = d(b1, b2, a2), d3 = d(a1, a2, b1), d4 = d(a1, a2, b2)
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}
function pointInPolygonExact(pt, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1]
    const cross = ((yi > pt[1]) !== (yj > pt[1])) && (pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi)
    if (cross) inside = !inside
  }
  return inside
}
function polygonsOverlapExact(polyA, polyB) {
  for (let i = 0; i < polyA.length; i++) {
    const a1 = polyA[i], a2 = polyA[(i + 1) % polyA.length]
    for (let j = 0; j < polyB.length; j++) {
      const b1 = polyB[j], b2 = polyB[(j + 1) % polyB.length]
      if (segmentsIntersect(a1, a2, b1, b2)) return true
    }
  }
  return pointInPolygonExact(polyA[0], polyB) || pointInPolygonExact(polyB[0], polyA)
}
function absolutePolygon(item) {
  const p = item.placement
  return p.variant.polygon.map(([x, y]) => [p.gx * item.inst.cellSize + x, p.gy * item.inst.cellSize + y])
}

async function validateAndFixOverlaps(sheets, cols, rows) {
  const MAX_PASSES = 20 // с запасом — каждое исправление снимается и переставляется заново, изредка это создаёт новую коллизию, для которой нужен ещё один проход
  let remaining = 0
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let fixedAny = false
    for (let si = 0; si < sheets.length; si++) {
      const sheet = sheets[si]
      let restart = true
      while (restart) {
        restart = false
        outer: for (let i = 0; i < sheet.placed.length; i++) {
          const polyA = absolutePolygon(sheet.placed[i])
          for (let j = i + 1; j < sheet.placed.length; j++) {
            const polyB = absolutePolygon(sheet.placed[j])
            if (polygonsOverlapExact(polyA, polyB)) {
              // Снимаем ВТОРУЮ деталь пары и переставляем заново на уточнённой сетке
              const item = sheet.placed.splice(j, 1)[0]
              rebuildOccupancy(sheet, cols, rows)
              const anchorXs = sheet.placed.map(p => p.placement.gx + p.placement.variant.cols)
              let placement = placeInstance(sheet.occ, cols, rows, item.inst, anchorXs, sheet.envCols, sheet.envRows)
              let targetSheet = sheet
              if (!placement) {
                // Не нашлось места даже на этом листе заново — на новый лист, чтобы не потерять деталь
                targetSheet = { index: sheets.length, occ: new Uint8Array(cols * rows), placed: [], envCols: 0, envRows: 0 }
                sheets.push(targetSheet)
                placement = placeInstance(targetSheet.occ, cols, rows, item.inst, [], 0, 0)
              }
              if (placement) {
                markOccupied(targetSheet.occ, cols, rows, placement.gx, placement.gy, placement.variant.dilated)
                targetSheet.placed.push({ inst: item.inst, placement })
                targetSheet.envCols = Math.max(targetSheet.envCols, placement.gx + placement.variant.cols)
                targetSheet.envRows = Math.max(targetSheet.envRows, placement.gy + placement.variant.rows)
              }
              fixedAny = true
              restart = true // состав этого листа изменился — перепроверяем ЕГО ЖЕ заново, не переходя к следующему
              break outer
            }
          }
        }
      }
    }
    if (!fixedAny) { remaining = 0; break }
    await new Promise(r => setTimeout(r, 0))
    remaining = fixedAny ? 1 : 0
  }
  if (remaining) {
    // Не должно происходить, но если всё же осталось пересечение после MAX_PASSES —
    // явно сообщаем в консоль вместо того, чтобы молча отдать плохой раскрой.
    let stillBad = 0
    sheets.forEach(sheet => {
      for (let i = 0; i < sheet.placed.length; i++) {
        for (let j = i + 1; j < sheet.placed.length; j++) {
          if (polygonsOverlapExact(absolutePolygon(sheet.placed[i]), absolutePolygon(sheet.placed[j]))) stillBad++
        }
      }
    })
    if (stillBad) console.warn(`[trueShapeNesting] После ${MAX_PASSES} проходов исправления осталось пересечений: ${stillBad}`)
  }
  for (let si = sheets.length - 1; si >= 1; si--) {
    if (sheets[si].placed.length === 0) sheets.splice(si, 1)
  }
  sheets.forEach((s, i) => { s.index = i })
  return sheets
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
  const kindsByDetail = details.map(d => buildPieceKind(d, cellSize, kerf))
  const smallMaxArea = smallPartsMaxSquareSide > 0 ? smallPartsMaxSquareSide * smallPartsMaxSquareSide : 0

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
        id: instances.length, detailIndex: di, cellSize, isSmall,
        variants: kindsByDetail[di],
        label: d.display_name || d.name, prefix: d.prefix,
        edgeTop: d.edge_top, edgeRight: d.edge_right, edgeBottom: d.edge_bottom, edgeLeft: d.edge_left,
        area,
      })
    }
  })

  const totalInstances = instances.length
  const budgetMs = Math.max(0, Number(optimizeSeconds) || 0) * 1000
  const startTime = Date.now()

  // Базовый результат ВСЕГДА без дедлайна — обязан разместить все детали
  // целиком, это гарантированная основа, даже если бюджет = 0.
  const seedOrder = instances.slice().sort((a, b) => b.area - a.area)
  let best = await attemptPack(seedOrder, cols, rows, null)
  let bestScore = scoreSheets(best, cols, rows)

  // ─── Генетический алгоритм поверх ПОРЯДКА укладки деталей ─────────────────
  // Это тот же самый, уже проверенный на прямоугольном алгоритме приём
  // (популяция, турнирный отбор, order crossover, элитизм, мутация) — просто
  // "декодер" каждой особи здесь не rectangle packAttempt, а true-shape
  // attemptPack. Именно порядок ("какая деталь встаёт раньше остальных")
  // определяет, останется ли для следующей детали её вогнутость свободной —
  // жадный перебор нескольких шаблонов порядка (как было раньше) находит
  // заметно менее плотные решения, чем эволюционный поиск по этому же
  // пространству.
  //
  // Популяция и число поколений НАМНОГО меньше, чем в rectangle-алгоритме —
  // там "особь" это дешёвая операция с прямоугольниками, здесь одна попытка
  // укладки может стоить секунды (растеризация контуров, оценка контакта по
  // границе силуэта). Компакция между листами — дорогая для true-shape, и
  // внутри поколений не делается вообще (иначе одно поколение съедало бы
  // весь бюджет) — она нужна только один раз, в конце, поверх лучшей найденной особи.
  if (budgetMs > 0 && totalInstances > 1 && Date.now() - startTime < budgetMs) {
    const POP_SIZE = totalInstances > 40 ? 8 : 12
    const ELITE_COUNT = 2
    const TOURNAMENT_SIZE = 3
    const MUTATION_RATE = 0.4

    const evalOrder = async (order, deadline) => {
      const sheets = await attemptPack(order, cols, rows, deadline)
      const placedCount = sheets.reduce((a, s) => a + s.placed.length, 0)
      if (placedCount !== totalInstances) return null // не успела разместить все детали до дедлайна — не годится как особь
      return { order, sheets, stat: scoreSheets(sheets, cols, rows) }
    }

    let population = [
      seedOrder,
      instances.slice().sort((a, b) => Math.max(b.variants[0].w, b.variants[0].h) - Math.max(a.variants[0].w, a.variants[0].h)),
      instances.slice().sort((a, b) => Math.min(a.variants[0].w, a.variants[0].h) - Math.min(b.variants[0].w, b.variants[0].h)),
    ]
    while (population.length < POP_SIZE) population.push(shuffleTS(instances.slice()))

    let evaluated = []
    for (const order of population) {
      if (Date.now() - startTime > budgetMs) break
      const res = await evalOrder(order, startTime + budgetMs)
      if (res) evaluated.push(res)
    }
    if (evaluated.length) {
      evaluated.sort((a, b) => better(a.stat, b.stat) ? -1 : 1)
      if (better(evaluated[0].stat, bestScore)) { best = evaluated[0].sheets; bestScore = evaluated[0].stat }

      while (Date.now() - startTime < budgetMs && evaluated.length >= 2) {
        const nextGen = evaluated.slice(0, ELITE_COUNT).map(e => e.order)
        while (nextGen.length < POP_SIZE && Date.now() - startTime < budgetMs) {
          const parentA = tournamentSelectTS(evaluated, TOURNAMENT_SIZE)
          const parentB = tournamentSelectTS(evaluated, TOURNAMENT_SIZE)
          let child = orderCrossoverTS(parentA.order, parentB.order)
          if (Math.random() < MUTATION_RATE) child = perturbOrderTS(child)
          nextGen.push(child)
        }
        const nextEvaluated = []
        for (const order of nextGen) {
          if (Date.now() - startTime > budgetMs) break
          const res = await evalOrder(order, startTime + budgetMs)
          if (res) nextEvaluated.push(res)
        }
        if (!nextEvaluated.length) break
        evaluated = nextEvaluated
        evaluated.sort((a, b) => better(a.stat, b.stat) ? -1 : 1)
        if (better(evaluated[0].stat, bestScore)) { best = evaluated[0].sheets; bestScore = evaluated[0].stat }
        await new Promise(r => setTimeout(r, 0))
      }
    }
  }

  best = await gravityCompact(best, cols, rows, startTime + budgetMs + 1000)
  best = await compactSheets(best, cols, rows, startTime + budgetMs + 1500)
  best = await validateAndFixOverlaps(best, cols, rows)

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
