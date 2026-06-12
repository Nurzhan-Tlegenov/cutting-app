/**
 * Нестинг — Maximal Rectangles BSSF
 * Лист: sheetL=2750 (Y, вертикаль), sheetW=1830 (X, горизонталь)
 * Внутри алгоритма: usableW = X (1830), usableH = Y (2750)
 * «Вдоль длины» = полосы вдоль Y, ряды горизонтальные
 */

export function runNesting({ details, sheetL, sheetW, marginT, marginR, marginB, marginL, kerf, direction = 'auto' }) {
  // sheetL=2750=Y (высота), sheetW=1830=X (ширина)
  const usableW = sheetW - marginL - marginR  // X = 1830 - отступы
  const usableH = sheetL - marginT - marginB  // Y = 2750 - отступы

  const pieces = []
  details.forEach((d, di) => {
    for (let q = 0; q < d.qty; q++) {
      pieces.push({
        id: `${di}_${q}`,
        detailIndex: di,
        // w = X-размер детали, h = Y-размер детали
        w: d.width + kerf,   // ширина детали (X)
        h: d.length + kerf,  // длина детали (Y)
        originalW: d.width,
        originalH: d.length,
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

  // Начальная ориентация для вращаемых деталей по направлению
  pieces.forEach(p => {
    if (!p.rotatable) return
    if (direction === 'along_y') {
      // Вдоль Y — длинная сторона детали направлена по Y (вертикально)
      if (p.w > p.h) { // если сейчас длинная по X — разворачиваем
        ;[p.w, p.h] = [p.h, p.w]
        ;[p.originalW, p.originalH] = [p.originalH, p.originalW]
        ;[p.edgeTop, p.edgeRight, p.edgeBottom, p.edgeLeft] = [p.edgeRight, p.edgeBottom, p.edgeLeft, p.edgeTop]
      }
    } else if (direction === 'along_x') {
      // Вдоль X — длинная сторона по X (горизонтально)
      if (p.h > p.w) {
        ;[p.w, p.h] = [p.h, p.w]
        ;[p.originalW, p.originalH] = [p.originalH, p.originalW]
        ;[p.edgeTop, p.edgeRight, p.edgeBottom, p.edgeLeft] = [p.edgeLeft, p.edgeTop, p.edgeRight, p.edgeBottom]
      }
    }
  })

  // Сортируем по убыванию площади
  pieces.sort((a, b) => (b.w * b.h) - (a.w * a.h))

  const sheets = []
  for (const piece of pieces) {
    let placed = false
    for (const sheet of sheets) {
      const result = bssf(sheet.freeRects, piece, usableW, usableH, direction)
      if (result) {
        sheet.placed.push(result)
        splitFreeRects(sheet, result)
        pruneFreeRects(sheet)
        placed = true
        break
      }
    }
    if (!placed) {
      const sheet = {
        index: sheets.length,
        placed: [],
        freeRects: [{ x: 0, y: 0, w: usableW, h: usableH }]
      }
      const result = bssf(sheet.freeRects, piece, usableW, usableH, direction)
      if (result) {
        sheet.placed.push(result)
        splitFreeRects(sheet, result)
        pruneFreeRects(sheet)
      }
      sheets.push(sheet)
    }
  }

  return { sheets, usableW, usableH, sheetL, sheetW, marginT, marginR, marginB, marginL, kerf }
}

function bssf(freeRects, piece, usableW, usableH, direction) {
  let best = null
  let bestScore = Infinity

  // Ориентации: базовая всегда, повёрнутая только если rotatable
  const orientations = [{ w: piece.w, h: piece.h, rotated: false }]
  if (piece.rotatable && piece.w !== piece.h) {
    orientations.push({ w: piece.h, h: piece.w, rotated: true })
  }

  for (const rect of freeRects) {
    for (const ori of orientations) {
      if (ori.w > rect.w || ori.h > rect.h) continue

      const shortSide = Math.min(rect.w - ori.w, rect.h - ori.h)
      const longSide = Math.max(rect.w - ori.w, rect.h - ori.h)

      // Бонус за предпочтительную ориентацию
      let bonus = 0
      if (direction === 'along_y' && ori.h >= ori.w) bonus = -300  // поощряем длинную по Y
      if (direction === 'along_x' && ori.w >= ori.h) bonus = -300  // поощряем длинную по X

      const score = shortSide * 1000 + longSide + bonus
      if (score < bestScore) {
        bestScore = score
        const rot = ori.rotated
        best = {
          id: piece.id, detailIndex: piece.detailIndex,
          label: piece.label, prefix: piece.prefix,
          x: rect.x, y: rect.y, w: ori.w, h: ori.h,
          originalW: rot ? piece.originalH : piece.originalW,
          originalH: rot ? piece.originalW : piece.originalH,
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

function splitFreeRects(sheet, p) {
  const newRects = []
  for (const r of sheet.freeRects) {
    if (!intersects(r, p)) { newRects.push(r); continue }
    if (p.x > r.x) newRects.push({ x: r.x, y: r.y, w: p.x - r.x, h: r.h })
    if (p.x + p.w < r.x + r.w) newRects.push({ x: p.x + p.w, y: r.y, w: r.x + r.w - (p.x + p.w), h: r.h })
    if (p.y > r.y) newRects.push({ x: r.x, y: r.y, w: r.w, h: p.y - r.y })
    if (p.y + p.h < r.y + r.h) newRects.push({ x: r.x, y: p.y + p.h, w: r.w, h: r.y + r.h - (p.y + p.h) })
  }
  sheet.freeRects = newRects
}

function pruneFreeRects(sheet) {
  const rects = sheet.freeRects.filter(r => r.w > 5 && r.h > 5)
  sheet.freeRects = rects.filter((r, i) =>
    !rects.some((o, j) => j !== i && o.x <= r.x && o.y <= r.y && o.x + o.w >= r.x + r.w && o.y + o.h >= r.y + r.h)
  )
}

function intersects(a, b) {
  return b.x < a.x + a.w && b.x + b.w > a.x && b.y < a.y + a.h && b.y + b.h > a.y
}

export function computeOffcuts(sheet, usableW, usableH) {
  if (!sheet?.freeRects) return []
  return sheet.freeRects
    .filter(r => r.w >= 100 && r.h >= 100)
    .map(r => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h), area: r.w * r.h }))
    .sort((a, b) => b.area - a.area)
    .slice(0, 8)
}
