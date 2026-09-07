/**
 * Нестинг — Maximal Rectangles BSSF
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
 * ЗАЩИТА МЕЛКИХ ДЕТАЛЕЙ ОТ КРАЯ ЛИСТА (для фрезера):
 *   Мелкие/узкие детали держатся на столе хуже крупных — при резке фрезером
 *   риск сдвига у детали, расположенной у самого края используемой зоны
 *   листа, выше (меньше материала, который её ещё удерживает к концу прохода).
 *   Поэтому такие детали при прочих равных предпочтительно укладываются
 *   ближе к центру, окружённые другими деталями/обрезками со всех сторон.
 *   Это не жёсткий запрет — если другого места физически нет, деталь всё
 *   равно встанет к краю, но при наличии выбора алгоритм предпочтёт центр.
 *
 *   Порог(и) и включение/выключение этой логики задаёт ПОЛЬЗОВАТЕЛЬ
 *   в настройках раскроя (параметры листа), а не алгоритм — сюда всегда
 *   приходят готовые значения. Доступны два независимых критерия
 *   "мелкой" детали — по площади и по меньшей стороне; деталь считается
 *   мелкой, если сработал хотя бы один из включённых (0 = критерий выключен).
 */

// Насколько сильно "давить" мелкие детали внутрь листа.
// Должен доминировать над обычным BSSF-скором (тот обычно в пределах
// сотен тысяч при координатах листа ~2700x1800), но не быть абсолютным.
const BORDER_PENALTY = 2000000
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
      // Длинная сторона вдоль Y → ph >= pw
      if (p.pw > p.ph) rotatePiece(p)
    } else if (direction === 'along_x') {
      // Длинная сторона вдоль X → pw >= ph
      if (p.ph > p.pw) rotatePiece(p)
    }
  })

  // Классификация "мелкая деталь" — по исходным размерам без kerf (чтобы
  // граница не гуляла в зависимости от толщины пропила). Работает только
  // если пользователь включил галочку; деталь мелкая, если сработал хотя
  // бы один из двух порогов (0 у порога = этот критерий не участвует).
  pieces.forEach(p => {
    const area = p.origX * p.origY
    const minSide = Math.min(p.origX, p.origY)
    p.isSmall = smallPartsToCenter && (
      (smallPartsMaxArea > 0 && area <= smallPartsMaxArea) ||
      (smallPartsMaxSide > 0 && minSide <= smallPartsMaxSide)
    )
  })

  pieces.sort((a, b) => (b.pw * b.ph) - (a.pw * a.ph))

  const sheets = []
  for (const piece of pieces) {
    let placed = false
    for (const sheet of sheets) {
      const result = bssf(sheet.freeRects, piece, direction, usableX, usableY)
      if (result) { sheet.placed.push(result); split(sheet, result); prune(sheet); placed = true; break }
    }
    if (!placed) {
      const sheet = { index: sheets.length, placed: [], freeRects: [{ x: 0, y: 0, w: usableX, h: usableY }] }
      const result = bssf(sheet.freeRects, piece, direction, usableX, usableY)
      if (result) { sheet.placed.push(result); split(sheet, result); prune(sheet) }
      sheets.push(sheet)
    }
  }

  return { sheets, usableX, usableY, sheetL, sheetW, marginT, marginR, marginB, marginL, kerf }
}

function rotatePiece(p) {
  ;[p.pw, p.ph] = [p.ph, p.pw]
  ;[p.origX, p.origY] = [p.origY, p.origX]
  ;[p.edgeTop, p.edgeRight, p.edgeBottom, p.edgeLeft] = [p.edgeLeft, p.edgeTop, p.edgeRight, p.edgeBottom]
}

function bssf(freeRects, piece, direction, usableX, usableY) {
  let best = null, bestScore = Infinity
  const oris = [{ pw: piece.pw, ph: piece.ph, rotated: false }]
  if (piece.rotatable && piece.pw !== piece.ph)
    oris.push({ pw: piece.ph, ph: piece.pw, rotated: true })

  for (const rect of freeRects) {
    for (const o of oris) {
      if (o.pw > rect.w || o.ph > rect.h) continue
      const short = Math.min(rect.w - o.pw, rect.h - o.ph)
      const long_ = Math.max(rect.w - o.pw, rect.h - o.ph)
      let score
      if (direction === 'along_y') {
        // Вдоль Y: сначала заполняем по X (левее = лучше), потом по Y (выше = лучше)
        score = rect.x * 100000 + rect.y * 100 + short
      } else if (direction === 'along_x') {
        // Вдоль X: сначала заполняем по Y (выше = лучше), потом по X
        score = rect.y * 100000 + rect.x * 100 + short
      } else {
        // Авто: Best Short Side Fit
        score = short * 1000 + long_
      }
      // Бонус за предпочтительную ориентацию
      if (direction === 'along_y' && o.ph >= o.pw) score -= 50
      if (direction === 'along_x' && o.pw >= o.ph) score -= 50

      // Штраф за касание внешней границы используемой зоны — только для мелких деталей.
      // Считаем отдельно по каждой из 4 сторон, чтобы угол (2 касания) штрафовался сильнее ребра (1 касание).
      if (piece.isSmall) {
        let borderTouch = 0
        if (rect.x <= EPS) borderTouch++
        if (rect.y <= EPS) borderTouch++
        if (Math.abs(rect.x + o.pw - usableX) <= EPS) borderTouch++
        if (Math.abs(rect.y + o.ph - usableY) <= EPS) borderTouch++
        score += borderTouch * BORDER_PENALTY
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
  const r = sheet.freeRects.filter(r => r.w > 5 && r.h > 5)
  sheet.freeRects = r.filter((a, i) =>
    !r.some((b, j) => j !== i && b.x <= a.x && b.y <= a.y && b.x + b.w >= a.x + a.w && b.y + b.h >= a.y + a.h))
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
