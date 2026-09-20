/**
 * Экспорт результата раскроя в DXF — простой текстовый DXF (совместимый с
 * R12, читается любым CAD-просмотрщиком), без внешних библиотек: DXF —
 * текстовый формат, для отрезков/текста достаточно написать группы кодов
 * руками.
 *
 * Один файл — ВСЕ листы заказа, разложенные в ряд по горизонтали с зазором
 * между ними (у DXF нет понятия "страница"), чтобы можно было визуально
 * сравнить укладку целиком, лист за листом, в одном чертеже.
 *
 * Слои — как в обычных экспортах раскроя (в т.ч. в вашем эталонном файле):
 * 'sheet' — контур листа, 'detal' — контур каждой детали (реальный полигон,
 * если он есть — с уже сэмплированными дугами/радиусами; иначе прямоугольник
 * по origX/origY), 'label' — подписи.
 */

const GAP_BETWEEN_SHEETS = 200 // мм, зазор между листами на чертеже

function line(x1, y1, x2, y2, layer) {
  return `0\nLINE\n8\n${layer}\n10\n${x1}\n20\n${y1}\n30\n0\n11\n${x2}\n21\n${y2}\n31\n0\n`
}

function text(x, y, s, layer, height) {
  // DXF-текст без явной кодировки для кириллицы у большинства просмотрщиков
  // превращается в кракозябры — по стандарту AutoCAD не-ASCII символы
  // кодируются как \U+XXXX (это понимает любой CAD, независимо от кодовой
  // страницы файла).
  const safe = String(s).replace(/[\r\n]/g, ' ').replace(/[^\x00-\x7F]/g, ch => `\\U+${ch.codePointAt(0).toString(16).padStart(4, '0').toUpperCase()}`)
  return `0\nTEXT\n8\n${layer}\n10\n${x}\n20\n${y}\n30\n0\n40\n${height}\n1\n${safe}\n`
}

function piecePolygonLocal(p) {
  if (Array.isArray(p.polygon) && p.polygon.length > 2) {
    return p.polygon.map(pt => [pt.x, pt.y])
  }
  const w = p.origX, h = p.origY
  return [[0, 0], [w, 0], [w, h], [0, h]]
}

export function buildNestingDxf(sheetsData, order) {
  const sheetW = Number(order.sheet_width) || 0
  const sheetL = Number(order.sheet_length) || 0
  const marginL = Number(order.margin_left) || 0
  const marginB = Number(order.margin_bottom) || 0

  let body = ''
  sheetsData.forEach((sheet, si) => {
    const offsetX = si * (sheetW + GAP_BETWEEN_SHEETS)

    // Контур листа целиком (не только рабочая зона — так виднее, где отступы)
    body += line(offsetX, 0, offsetX + sheetW, 0, 'sheet')
    body += line(offsetX + sheetW, 0, offsetX + sheetW, sheetL, 'sheet')
    body += line(offsetX + sheetW, sheetL, offsetX, sheetL, 'sheet')
    body += line(offsetX, sheetL, offsetX, 0, 'sheet')

    // Номер листа над ним
    body += text(offsetX, sheetL + 60, `Лист ${si + 1} (${sheet.placed.length} дет.)`, 'label', 50)

    sheet.placed.forEach(p => {
      const baseX = offsetX + marginL + p.x
      const baseY = marginB + p.y
      const poly = piecePolygonLocal(p)
      for (let i = 0; i < poly.length; i++) {
        const [x1, y1] = poly[i]
        const [x2, y2] = poly[(i + 1) % poly.length]
        body += line(baseX + x1, baseY + y1, baseX + x2, baseY + y2, 'detal')
      }
      const label = (p.prefix ? p.prefix + ' ' : '') + (p.label || '') + ` ${Math.round(p.origY)}x${Math.round(p.origX)}`
      body += text(baseX + poly[0][0] + 10, baseY + poly[0][1] + 10, label, 'Solid Edge 2D NestingPartName', 25)
    })
  })

  return `0\nSECTION\n2\nENTITIES\n${body}0\nENDSEC\n0\nEOF\n`
}
