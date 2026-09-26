/**
 * True-shape нестинг через No-Fit-Polygon — экспериментальная замена
 * растровому подходу в trueShapeNesting.js для деталей со сложным контуром.
 * Генетика (популяция/турнир/order crossover/элитизм/мутация) — ТА ЖЕ
 * логика, что уже проверена в trueShapeNesting.js и nesting.js, здесь
 * просто другой "декодер" особи: вместо растровой укладки — NFP-укладка.
 *
 * СТАТУС: экспериментальный модуль для параллельного тестирования на
 * реальных заказах — НЕ подключён по умолчанию в runNesting(). Проверено на
 * эталонных DXF от Solid Edge 2D Nesting (сравнение результата, не кода).
 * Перед тем как сделать основным алгоритмом — прогнать на десятках реальных
 * заказов и сравнить оба результата.
 */
import { parsePolygonFromDetail } from './trueShapeNesting'
import {
  ensureCCW, reflectPoly, dilatedConvexParts, nfpFromParts,
  nfpPairwiseIntersections, edgesAgainstAlignmentLines,
  polygonsOverlapRobust, bboxOf, translate,
} from './nfpGeometry'

function rotate90(polygon, w) { return polygon.map(([x, y]) => [y, w - x]) }
function polygonArea(poly) { let a=0; for (let i=0;i<poly.length;i++){const q=poly[(i+1)%poly.length]; a+=poly[i][0]*q[1]-q[0]*poly[i][1]} return Math.abs(a)/2 }

// Один вариант поворота детали: полигон для экспорта/рендера (БЕЗ раздутия
// на kerf — как и раньше, в DXF идёт чистый контур детали) + раздутые на
// kerf/2 выпуклые части (для построения NFP и проверки пересечений).
function buildVariant(polyCCW, w, h, angle, halfKerf) {
  return {
    angle, w, h,
    polygon: polyCCW,                                  // для экспорта/рендера (без kerf)
    parts: dilatedConvexParts(polyCCW, halfKerf),       // для NFP/коллизий (с kerf)
  }
}

function buildPieceVariants(detail, kerf) {
  const { polygon, w, h } = parsePolygonFromDetail(detail)
  const halfKerf = kerf / 2
  const poly0 = ensureCCW(polygon)
  const poly90 = ensureCCW(rotate90(poly0, w))
  const poly180 = ensureCCW(rotate90(poly90, h))
  const variants = [
    buildVariant(poly0, w, h, 0, halfKerf),
    buildVariant(poly180, w, h, 180, halfKerf),
  ]
  if (detail.rotatable) {
    const poly270 = ensureCCW(rotate90(poly180, w))
    variants.push(buildVariant(poly90, h, w, 90, halfKerf))
    variants.push(buildVariant(poly270, h, w, 270, halfKerf))
  }
  return variants
}

// Размещение одной детали (перебор всех вариантов поворота) среди уже
// уложенных на листе — кандидаты из NFP против каждого соседа + пересечения
// NFP пар соседей друг с другом + точки на рёбрах NFP, выровненные по
// краям соседей и границам листа.
// ─── Длина реального касания — правильный критерий для "пазла" ────────────
// Раньше выбирали позицию с минимальным ОБЩИМ ГАБАРИТОМ листа — это часто
// подвигает деталь ближе к углу, но не обязательно прижимает её гранью к
// соседям со всех сторон, откуда и брались широкие промежутки. Правильный
// критерий (как это, судя по всему, делает эталонный раскрой конкурента,
// где везде расстояние ровно 4мм = ширине реза) — максимум суммарной длины
// границы, которая легла ВПЛОТНУЮ (в пределах допуска, привязанного к
// резу) к уже стоящим деталям или краю листа. Деталь, забившаяся гранью в
// нишу соседа, выигрывает у детали, просто задвинутой в угол.
function edgesOfPoly(poly) {
  const es = []
  for (let i = 0; i < poly.length; i++) es.push([poly[i], poly[(i + 1) % poly.length]])
  return es
}
// Расстояние от точки до отрезка — то, что реально нужно для касания по
// КРИВОЙ границе: старая версия (segTouchLen, ниже) требовала, чтобы два
// отрезка были почти ПАРАЛЛЕЛЬНЫ — это работает для прямых сторон, но
// у изогнутого стыка (S-образный вырез) каждая маленькая хорда после
// сэмплирования дуги идёт под своим небольшим углом, и параллельность почти
// никогда не совпадает даже там, где детали реально соприкасаются по всей
// длине кривой (проверено: на паре с гарантированным касанием 4мм по всей
// длине кривой стыка старая формула насчитывала контакт в 10 раз меньше
// реального). Правильный критерий — БЛИЗОСТЬ, а не направление.
function pointToSegDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay
  const len2 = dx * dx + dy * dy
  let t = len2 > 1e-12 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0
  t = Math.max(0, Math.min(1, t))
  const cx = ax + t * dx, cy = ay + t * dy
  return Math.hypot(px - cx, py - cy)
}
// tol должен пропускать ровно ширину реза (деталь на расстоянии kerf от
// соседа — это КАСАНИЕ вплотную с учётом реза, не зазор) — иначе ни одна
// настоящая, правильно расставленная пара не засчиталась бы как контакт.
function contactLength(movingEdges, movingBB, neighborEdgesList, boundaryEdges, tol) {
  let total = 0
  for (const [a, b] of movingEdges) {
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2
    const elen = Math.hypot(b[0] - a[0], b[1] - a[1])
    let minD = Infinity
    for (const [c, d] of boundaryEdges) {
      const dd = pointToSegDist(mx, my, c[0], c[1], d[0], d[1])
      if (dd < minD) minD = dd
    }
    if (minD > tol) {
      for (const { edges, bb } of neighborEdgesList) {
        if (mx < bb.minX - tol || mx > bb.maxX + tol || my < bb.minY - tol || my > bb.maxY + tol) continue
        for (const [c, d] of edges) {
          const dd = pointToSegDist(mx, my, c[0], c[1], d[0], d[1])
          if (dd < minD) minD = dd
        }
        if (minD <= tol) break
      }
    }
    if (minD <= tol) total += elen
  }
  return total
}

function placeOne(variants, placed, usableX, usableY, kerf, scoreMode = 'auto', direction = 'auto', nfpCache = null) {
  let best = null, bestScore = Infinity
  // Готовим один раз на вызов (не на каждого кандидата): рёбра листа и рёбра
  // уже стоящих деталей — нужны для метрики длины касания ниже.
  const tol = kerf * 1.2 // чуть больше реза — плавающая точка не обязана попасть ровно в 4.000
  // Какие стороны листа считаются "стеной", к которой деталь должна
  // прилипать. Все режимы растут от угла (0,0): нижняя стена (y=0) +
  // левая стена (x=0). Раньше along_y ошибочно тянуло к верхней стене,
  // along_x — к правой и левой одновременно, из-за чего детали
  // расползались по листу вместо стопок от нуля. Направление (столбцы/
  // ряды) задаёт вторичный критерий в оценке кандидатов ниже, а не стены.
  const wallEdges = [[[0, 0], [usableX, 0]], [[0, usableY], [0, 0]]]
  const boundaryEdges = wallEdges
  const neighborEdgesList = placed.map(p => ({ edges: edgesOfPoly(p.polygon), bb: p.bb }))
  for (const v of variants) {
    const bb0 = bboxOf(v.polygon)
    const minX = -bb0.minX, maxX = usableX - bb0.maxX
    const minY = -bb0.minY, maxY = usableY - bb0.maxY
    if (maxX < minX - 1e-6 || maxY < minY - 1e-6) continue

    const movingEdgesLocal = edgesOfPoly(v.polygon)
    const movingPartsReflected = v.parts.map(p => reflectPoly(p))
    const candidates = [[minX, minY], [minX, maxY], [maxX, minY]]
    if(process.env.DBGT2){var __tnfp=Date.now()}
    // NFP зависит только от ФОРМ (соседа и вставляемой детали), не от того,
    // где именно сосед стоит на листе — контакт между двумя копиями одной и
    // той же детали (а таких соседей обычно много) считаем ОДИН раз в
    // локальных координатах и просто сдвигаем на позицию каждого конкретного
    // соседа, вместо того чтобы каждый раз пересчитывать заново. Раньше это
    // было главной причиной, по которой "встряска" успевала всего 10-20
    // попыток за 30 секунд — теперь одинаковых соседей это не касается.
    const nfpList = placed.map(p => {
      if (!nfpCache) return nfpFromParts(p.absParts, movingPartsReflected)
      const neighborVariant = p.inst.variants.find(vv => vv.angle === p.angle) || p.inst.variants[0]
      let inner = nfpCache.get(neighborVariant)
      if (!inner) { inner = new Map(); nfpCache.set(neighborVariant, inner) }
      let local = inner.get(v)
      if (!local) { local = nfpFromParts(neighborVariant.parts, movingPartsReflected); inner.set(v, local) }
      return {
        points: local.points.map(([x, y]) => [x + p.x, y + p.y]),
        edges: local.edges.map(([a, b]) => [[a[0] + p.x, a[1] + p.y], [b[0] + p.x, b[1] + p.y]]),
      }
    })
    if(process.env.DBGT2)console.log('  nfpList(cached)', Date.now()-__tnfp,'ms')
    if(process.env.DBGT2){var __ta=Date.now()}
    for (const nfp of nfpList) for (const pt of nfp.points) candidates.push(pt)
    for (let i = 0; i < nfpList.length; i++) {
      for (let j = i + 1; j < nfpList.length; j++) {
        for (const pt of nfpPairwiseIntersections(nfpList[i].edges, nfpList[j].edges)) candidates.push(pt)
      }
    }
    if(process.env.DBGT2)console.log('  pairwise', Date.now()-__ta,'ms cands',candidates.length,'neighbors',placed.length)
    if(process.env.DBGT2){var __tb=Date.now()}
    const xLines = new Set([minX, maxX]), yLines = new Set([minY, maxY])
    placed.forEach(p => { xLines.add(p.bb.minX); xLines.add(p.bb.maxX); yLines.add(p.bb.minY); yLines.add(p.bb.maxY) })
    for (const nfp of nfpList) {
      for (const pt of edgesAgainstAlignmentLines(nfp.edges, [...xLines], [...yLines])) candidates.push(pt)
    }
    if(process.env.DBGT2){var __tc=Date.now()}

    // Габариты кусков движущейся детали в её ЛОКАЛЬНОЙ системе (сдвигаем на
    // (ox,oy) при проверке кандидата) — чтобы для каждой пары (кусок
    // движущейся, кусок соседа) сначала отсечь по bbox и только потом делать
    // дорогой точный тест пересечения (тот же эффект, что и в nfpFromParts).
    const partBB = v.parts.map(bboxOf)
    // Общий габарит кусков движущейся детали (для быстрой грубой отсечки
    // кандидат-сосед) — не зависит от конкретного кандидата (ox,oy), поэтому
    // считаем один раз, а не на каждой (кандидат × сосед) паре: раньше это
    // было спрятанной O(кандидаты × соседи × куски) стоимостью и оставалось
    // главным тормозом уже после того, как сам расчёт контакта стал дешёвым.
    const aggMaxX = Math.max(...partBB.map(b => b.maxX)), aggMinX = Math.min(...partBB.map(b => b.minX))
    const aggMaxY = Math.max(...partBB.map(b => b.maxY)), aggMinY = Math.min(...partBB.map(b => b.minY))
    for (const [ox, oy] of candidates) {
      if (ox < minX - 1e-6 || ox > maxX + 1e-6 || oy < minY - 1e-6 || oy > maxY + 1e-6) continue
      let bad = false, absParts = null
      for (const p of placed) {
        if (p.bb.minX > ox + aggMaxX || p.bb.maxX < ox + aggMinX ||
            p.bb.minY > oy + aggMaxY || p.bb.maxY < oy + aggMinY) continue
        if (!absParts) absParts = v.parts.map(part => translate(part, ox, oy))
        const pAbsBB = p.absPartsBB || (p.absPartsBB = p.absParts.map(bboxOf))
        outer:
        for (let ai = 0; ai < absParts.length; ai++) {
          const abb = { minX: partBB[ai].minX+ox, maxX: partBB[ai].maxX+ox, minY: partBB[ai].minY+oy, maxY: partBB[ai].maxY+oy }
          for (let bi = 0; bi < p.absParts.length; bi++) {
            const bbb = pAbsBB[bi]
            if (abb.minX > bbb.maxX || bbb.minX > abb.maxX || abb.minY > bbb.maxY || bbb.minY > abb.maxY) continue
            if (polygonsOverlapRobust(absParts[ai], p.absParts[bi])) { bad = true; break outer }
          }
        }
        if (bad) break
      }
      if (bad) continue
      if (!absParts) absParts = v.parts.map(part => translate(part, ox, oy))
      let envMaxX = ox + bb0.maxX, envMaxY = oy + bb0.maxY
      for (const p of placed) { envMaxX = Math.max(envMaxX, p.bb.maxX); envMaxY = Math.max(envMaxY, p.bb.maxY) }
      // 'tall'/'wide' — для поиска ОБЕИХ ориентаций сцепки пары (см.
      // buildPairSubs), там по-прежнему важен именно габарит, не касание.
      // 'auto' — ГЛАВНЫЙ критерий обычной укладки: раньше здесь тоже стоял
      // минимальный габарит листа, а он не то же самое, что "деталь плотно
      // прижата к соседям" — минимальный габарит просто подвигает деталь
      // ближе к углу, и между деталями оставались широкие промежутки именно
      // поэтому. Теперь среди кандидатов, выживших после проверки на
      // пересечение, выбираем тот, что даёт МАКСИМУМ суммарной длины
      // касания с соседями и краем листа (в пределах реза — соседняя деталь
      // на расстоянии ровно kerf засчитывается как касание) — это и есть
      // "деталь вписалась в нишу", а не просто "легла компактно".
      let score
      if (scoreMode === 'tall') score = envMaxX * 1e6 + envMaxY
      else if (scoreMode === 'wide') score = envMaxY * 1e6 + envMaxX
      else {
        const movedEdges = movingEdgesLocal.map(([a, b]) => [[a[0]+ox, a[1]+oy], [b[0]+ox, b[1]+oy]])
        const movedBB = { minX: ox+bb0.minX, maxX: ox+bb0.maxX, minY: oy+bb0.minY, maxY: oy+bb0.maxY }
        const contact = contactLength(movedEdges, movedBB, neighborEdgesList, boundaryEdges, tol)
        // Первичный критерий — максимум касания (больше = лучше, минус инвертирует).
        // Вторичный — позиция вдоль выбранной оси укладки:
        //   along_y (столбцы ↑): предпочитаем низкий y — стопка растёт снизу вверх;
        //   along_x (ряды →): предпочитаем низкий x — ряд заполняется слева направо;
        //   auto: минимум занятой площади листа (как раньше).
        // Масштаб 1e7 vs 1e3/1.0 гарантирует, что 1 мм контакта важнее
        // 10 000 мм смещения по вторичной оси.
        if (direction === 'along_y') {
          score = -contact * 1e7 + (oy + bb0.minY) * 1e3 + (ox + bb0.minX)
        } else if (direction === 'along_x') {
          score = -contact * 1e7 + (ox + bb0.minX) * 1e3 + (oy + bb0.minY)
        } else {
          score = -contact * 1e6 + envMaxX * envMaxY * 1e-3
        }
      }
      if (score < bestScore) {
        bestScore = score
        best = { angle: v.angle, x: ox, y: oy, polygon: translate(v.polygon, ox, oy), absParts, bb: bboxOf(translate(v.polygon, ox, oy)) }
      }
    }
  }
  return best
}
// ─── Сцепка одинаковых деталей в пару ──────────────────────────────────────
// Та же идея, что в exactPack.js (tileIntoPairs): две одинаковые вогнутые
// детали часто вкладываются друг в друга почти без зазора. Там это строилось
// по габаритам; здесь — через настоящий NFP-контакт (placeOne), поэтому
// сцепка получается по РЕАЛЬНОМУ контуру, а не по прямоугольнику. Генетике
// такая пара скармливается как ОДНА деталь (атомарный блок) — это даёт ей
// сразу готовый плотный строительный элемент вместо необходимости самой
// случайно нащупать взаимный разворот двух конкретных копий.
function rot90Poly(poly, w) { return poly.map(([x,y]) => [y, w-x]) }
function rot90Parts(parts, w) { return parts.map(p => rot90Poly(p, w)) }

// Пробуем несколько РАЗНЫХ (не совпадающих по итоговому габариту) способов
// сцепить деталь саму с собой — аналог along_y/along_x в exactPack.js:
// одна сцепка обычно выходит "высокой" (в столбец), другая "широкой".
function buildPairSubs(inst, kerf) {
  const v0 = inst.variants[0]
  const bb0 = bboxOf(v0.polygon)
  const firstPoly = translate(v0.polygon, -bb0.minX, -bb0.minY)
  const firstParts = v0.parts.map(p => translate(p, -bb0.minX, -bb0.minY))
  const firstPlaced = { bb: bboxOf(firstPoly), absParts: firstParts, polygon: firstPoly }

  // Область поиска контакта — не безграничная: с безграничной (например,
  // 1e7 мм) 3 угловых кандидата placeOne (запасной вариант "хоть где-то, но
  // без пересечения" для случая листа, где иначе некуда) сами оказываются на
  // расстоянии тысяч метров — формально не пересекаются ни с чем, значит
  // "проходят" по критерию, и при выборе минимальной ширины ('tall' режим)
  // именно такой уехавший кандидат может победить настоящий контакт. Пара не
  // может быть больше нескольких размеров самой детали.
  const span = Math.max(firstPlaced.bb.maxX, firstPlaced.bb.maxY)
  const BIG = span * 4
  const singleArea = firstPlaced.bb.maxX * firstPlaced.bb.maxY
  const out = []
  // 'wide' и 'tall' — две принципиально разные ориентации сцепки (см.
  // комментарий у scoreMode в placeOne); 'auto' — на случай, если для формы
  // почему-то находится третья, отличная от первых двух.
  for (const mode of ['tall', 'wide', 'auto']) {
    for (const v of inst.variants) {
      const res = placeOne([v], [firstPlaced], BIG, BIG, kerf, mode, 'auto')
      if (!res) continue
      const minX = Math.min(0, res.bb.minX), minY = Math.min(0, res.bb.minY)
      const maxX = Math.max(firstPlaced.bb.maxX, res.bb.maxX), maxY = Math.max(firstPlaced.bb.maxY, res.bb.maxY)
      const W = maxX - minX, H = maxY - minY
      if (W > span * 2.2 || H > span * 2.2) continue // не настоящий контакт — отбрасываем
      // Детали просто встали рядом, без вложения одна в другую (площадь
      // габарита пары ~= сумме двух отдельных габаритов) — это не сцепка,
      // а то же самое, что генетика и без подсказки легко находит сама.
      // Пропускаем: иначе такой "пустой" вариант чередуется с настоящим и
      // портит половину сцепленных деталей.
      if (W * H > singleArea * 1.85) continue
      if (out.some(o => Math.abs(o.W-W)<1 && Math.abs(o.H-H)<1)) continue
      const dx = -minX, dy = -minY
      out.push({
        W, H,
        subs: [
          { angle: v0.angle, polygon: translate(firstPoly, dx, dy), parts: firstParts.map(p => translate(p, dx, dy)) },
          { angle: v.angle, polygon: translate(res.polygon, dx, dy), parts: res.absParts.map(p => translate(p, dx, dy)) },
        ],
      })
    }
  }
  return out
}

// Варианты поворота ГОТОВОЙ пары целиком: 0°/180° — всегда (каждая из двух
// деталей внутри пары остаётся в разрешённом для неё положении 0/180, значит
// направление текстуры не нарушается); 90°/270° — только если сама деталь
// допускает вращение (тот же признак rotatable, что и у одиночной детали).
function buildCompositeVariants(baseSubs, W0, H0, rotatable, halfKerf) {
  // Для NFP-контакта с ДРУГИМИ деталями сцепке достаточно её внешнего
  // прямоугольника вместо полного объединения кусков обеих половин (11+11=22
  // куска) — сама пара внутри уже сцеплена заранее (buildPairSubs), а лишние
  // куски только умножают дороговизну NFP (расчёт растёт как quadrat от
  // числа кусков: 22×22 против 1×1) — на реальном заказе именно это съедало
  // почти весь бюджет времени на одну-единственную раскладку. exactPack.js
  // для пар делает то же самое (там это тоже просто прямоугольник).
  const mk = (subs, w, h, angle) => ({ angle, w, h, polygon: [[0,0],[w,0],[w,h],[0,h]], subs, parts: dilatedConvexParts(ensureCCW([[0,0],[w,0],[w,h],[0,h]]), halfKerf) })
  const rot = (subs, w) => subs.map(s => ({ angle: (s.angle+90)%360, polygon: rot90Poly(s.polygon, w), parts: rot90Parts(s.parts, w) }))
  const subs90 = rot(baseSubs, W0)
  const subs180 = rot(subs90, H0)
  const variants = [mk(baseSubs, W0, H0, 0), mk(subs180, W0, H0, 180)]
  if (rotatable) {
    variants.push(mk(subs90, H0, W0, 90))
    variants.push(mk(rot(subs180, W0), H0, W0, 270))
  }
  return variants
}

function buildPairInstances(inst, count, nextIdStart, halfKerf) {
  const candidates = buildPairSubs(inst, halfKerf * 2)
  if (!candidates.length) return []
  const rotatable = inst.variants.length > 2
  const instances = []
  for (let k = 0; k < count; k++) {
    const cand = candidates[k % candidates.length] // чередуем найденные способы сцепки — разнообразие для генетики
    instances.push({
      id: nextIdStart + k, detailIndex: inst.detailIndex, isComposite: true, src: inst,
      label: inst.label, prefix: inst.prefix,
      edgeTop: inst.edgeTop, edgeRight: inst.edgeRight, edgeBottom: inst.edgeBottom, edgeLeft: inst.edgeLeft,
      variants: buildCompositeVariants(cand.subs, cand.W, cand.H, rotatable, halfKerf),
      w: cand.W, h: cand.H,
    })
  }
  return instances
}

// Кладём результат placeOne в лист. Для сцепки — разворачиваем в ДВЕ реальные
// детали (у каждой свой угол поворота и, значит, свой разворот кромки) —
// дальше по коду (сортировка, генетика, вывод) они неотличимы от обычных
// одиночно уложенных деталей.
function commitInstance(sheet, inst, res) {
  if (!inst.isComposite) { sheet.push({ inst, ...res }); return }
  const variant = inst.variants.find(v => v.angle === res.angle)
  for (const sub of variant.subs) {
    const absPolygon = translate(sub.polygon, res.x, res.y)
    const absParts = sub.parts.map(p => translate(p, res.x, res.y))
    sheet.push({ inst: inst.src, angle: sub.angle, x: res.x, y: res.y, polygon: absPolygon, absParts, bb: bboxOf(absPolygon) })
  }
}

function attemptPack(order, usableX, usableY, kerf, direction, seedSheet = null, nfpCache = null) {
  const sheets = seedSheet ? [seedSheet.slice(), []] : [[]]
  for (let idx = 0; idx < order.length; idx++) {
    const inst = order[idx]
    let done = false
    for (const sheet of sheets) {
      if (sheet.length === 0) continue // пустой лист — обрабатываем отдельно ниже, с оглядкой на следующую деталь
const res = placeOne(inst.variants, sheet, usableX, usableY, kerf, 'auto', direction, nfpCache)
      if (res) { commitInstance(sheet, inst, res); done = true; break }
    }
    if (!done) {
      // Первая деталь НА ПУСТОМ ЛИСТЕ (неважно, самый первый лист заказа или
      // очередной новый) — все повороты дают одинаковый счёт (не с чем
      // сравнивать), поэтому раньше брался первый попавшийся (угол 0°), а
      // нужный для плотного прилегания следующей детали разворот мог
      // оказаться именно ЗЕРКАЛЬНЫМ к нему (то же самое вложение, но с
      // направлением "за пределы листа" вместо "внутрь"). Пробуем все
      // варианты поворота первой детали и смотрим на ШАГ ВПЕРЁД — куда
      // встанет следующая деталь — вместо произвольного выбора без сравнения.
      const targetSheet = sheets.find(s => s.length === 0) || (sheets.push([]), sheets[sheets.length - 1])
      const nextInst = order[idx + 1]
      let bestFirst = null, bestLookaheadScore = Infinity
      for (const v of inst.variants) {
        const res = placeOne([v], [], usableX, usableY, kerf, 'auto', direction, nfpCache)
        if (!res) continue
        let lookaheadScore = 0
        if (nextInst) {
          const res2 = placeOne(nextInst.variants, [{ inst, ...res }], usableX, usableY, kerf, 'auto', direction, nfpCache)
          lookaheadScore = res2 ? (res2.bb.maxX * res2.bb.maxY) : Infinity
        }
        if (lookaheadScore < bestLookaheadScore) { bestLookaheadScore = lookaheadScore; bestFirst = res }
      }
      if (!bestFirst) return null
      commitInstance(targetSheet, inst, bestFirst)
    }
  }
  return sheets.filter(s => s.length > 0)
}

function scoreSheets(sheets) {
  const last = sheets[sheets.length - 1]
  const lastArea = last.reduce((s, p) => s + (p.bb.maxX - p.bb.minX) * (p.bb.maxY - p.bb.minY), 0)
  // При равном числе листов лучше та раскладка, где на ПОСЛЕДНЕМ листе
  // МЕНЬШЕ материала (ближе к тому, чтобы не понадобился вовсе) — поэтому
  // берём lastArea напрямую, без минуса; better() ниже выбирает меньший
  // ключ. Раньше здесь стоял минус — это меняло критерий на обратный
  // (предпочитало БОЛЬШИЙ остаток на последнем листе) и мешало генетике
  // сходиться к более плотным раскладкам.
  return [sheets.length, lastArea]
}
function better(a, b) { return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]) }

function shuffle(arr) {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]] }
  return a
}
// Чередование крупных/мелких деталей: сортируем по убыванию площади, потом
// берём по одной поочерёдно с двух концов (самая крупная, самая мелкая,
// следующая крупная, следующая мелкая, ...). Так мелкие детали пробуют
// занять место РЯДОМ с каждой крупной сразу же, а не только после того, как
// ВСЕ крупные уже заняли максимально плотный, но неудобной формы блок.
function interleaveByAreaBand(instances) {
  const sorted = instances.slice().sort((a,b)=>(b.w*b.h)-(a.w*a.h))
  const result = []
  let lo = 0, hi = sorted.length - 1
  while (lo <= hi) {
    result.push(sorted[lo++])
    if (lo <= hi) result.push(sorted[hi--])
  }
  return result
}
function tournamentSelect(pop, size) {
  let best = null
  for (let i=0;i<size;i++){ const c = pop[Math.floor(Math.random()*pop.length)]; if (!best || better(c.stat,best.stat)) best = c }
  return best
}
function orderCrossover(a, b) {
  const n = a.length
  const i = Math.floor(Math.random()*n), j = Math.floor(Math.random()*n)
  const lo = Math.min(i,j), hi = Math.max(i,j)
  const child = new Array(n).fill(null)
  for (let k=lo;k<=hi;k++) child[k]=a[k]
  const used = new Set(child.filter(Boolean).map(x=>x.id))
  let p = 0
  for (let k=0;k<n;k++){
    if (child[k]) continue
    while (used.has(b[p].id)) p++
    child[k]=b[p]; used.add(b[p].id)
  }
  return child
}
function perturbOrder(order) {
  const a = order.slice()
  const i = Math.floor(Math.random()*a.length), j = Math.floor(Math.random()*a.length)
  ;[a[i],a[j]]=[a[j],a[i]]
  return a
}

// «Сдвиг вперёд»: то же, что sweepForward в exactPack.js, но через настоящую
// NFP-притирку (placeOne), а не растровую сетку. ГА подбирает ПОРЯДОК
// деталей, но даже у хорошего порядка последний лист часто остаётся
// недобитым — потому что деталь, которая случайно ушла на следующий лист
// при жадной раскладке attemptPack, вообще-то помещалась бы и на предыдущий
// (просто раньше там для неё не нашлось повода попробовать). Здесь для
// каждой детали с поздних листов пробуем реальную NFP-позицию на каждом
// более раннем листе; если помещается — переносим. Повторяем по кругу, пока
// что-то переносится.
async function sweepForwardNFP(sheets, usableX, usableY, kerf, direction, deadline, nfpCache = null) {
  let result = sheets.map(s => s.slice())
  for (let round = 0; round < 6 && Date.now() < deadline; round++) {
    let moved = false
    for (let i = 0; i < result.length - 1 && Date.now() < deadline; i++) {
      for (let j = result.length - 1; j > i; j--) {
        const from = result[j]
        for (let k = from.length - 1; k >= 0 && Date.now() < deadline; k--) {
          const inst = from[k].inst
          const res = placeOne(inst.variants, result[i], usableX, usableY, kerf, 'auto', direction, nfpCache)
          if (res) {
            result[i] = result[i].concat([{ inst, ...res }])
            from.splice(k, 1)
            moved = true
          }
        }
      }
    }
    result = result.filter(s => s.length)
    if (!moved) break
  }
  return result
}

// «Встряска»: вынуть небольшую случайную группу уже уложенных деталей
// (с упором на последний лист — там обычно и есть проблема) и вставить их
// заново, в новом случайном порядке, через настоящий NFP-контакт — как
// песок, который при встряске даёт мелким кускам провалиться в щели между
// крупными. Оставляем результат, только если стало лучше (меньше листов,
// или столько же листов, но меньше материала на последнем).
async function shakeNFP(sheets, usableX, usableY, kerf, direction, deadline, nfpCache = null) {
  let best = sheets.map(s => s.slice())
  let bestStat = scoreSheets(best)
  let noImprove = 0
  while (Date.now() < deadline && noImprove < 300) {
    const flat = []
    best.forEach((sheet, si) => sheet.forEach(p => flat.push({ p, si })))
    if (flat.length < 4) break
    const lastSi = best.length - 1
    // Раньше вынимали случайные детали С ЛЮБОГО листа (с шансом 35% —
    // и с первого тоже). scoreSheets видит только число листов и остаток
    // материала на ПОСЛЕДНЕМ — она не замечает, что при этом первый,
    // уже хорошо уложенный лист, стал рыхлее (деталь воткнулась в первое
    // же место с высоким контактом ЛОКАЛЬНО, а не туда, где стояла раньше,
    // и могла заодно закрыть собой удобную нишу для будущей детали). Именно
    // так на реальном заказе появлялись отдельные "оторванные" детали
    // посреди пустого места. Теперь трогаем ТОЛЬКО последний лист — та же
    // логика избегания риска, что и в sweepForwardNFP (переносить только
    // вперёд, никогда не разбирать то, что уже хорошо стоит).
    const pool = shuffle(flat.filter(f => f.si === lastSi))
    const k = Math.min(pool.length, 3 + Math.floor(Math.random() * 5))
    const picked = pool.slice(0, k)
    if (picked.length < 2) continue
    // Ключ — сам объект размещения (p), а НЕ p.inst: у обеих половин бывшей
    // сцепленной пары p.inst — ОДНА и та же ссылка (это две одинаковые
    // детали одного вида), поэтому по p.inst нельзя отличить "вынуть эту
    // копию" от "вынуть и её, и вторую тоже" — ровно так раньше терялись
    // детали (вынимались обе, а возвращалась одна).
    const pickedSet = new Set(picked.map(f => f.p))
    let trial = best.map(sheet => sheet.filter(p => !pickedSet.has(p))).filter(s => s.length)
    if (!trial.length) trial = [[]]
    const order = shuffle(picked.map(f => f.p.inst))
    let ok = true
    for (const inst of order) {
      let placed = false
      for (const sheet of trial) {
  const res = placeOne(inst.variants, sheet, usableX, usableY, kerf, 'auto', direction, nfpCache)
        if (res) { sheet.push({ inst, ...res }); placed = true; break }
      }
      if (!placed) {
        const sheet = []
  const res = placeOne(inst.variants, sheet, usableX, usableY, kerf, 'auto', direction, nfpCache)
        if (!res) { ok = false; break }
        sheet.push({ inst, ...res })
        trial.push(sheet)
      }
    }
    if (!ok) { noImprove++; continue }
    // Проверка целостности — не должно случаться, но лишняя не помешает:
    // если вдруг число деталей не сошлось, такой вариант не принимаем.
    const trialCount = trial.reduce((n, s) => n + s.length, 0)
    const bestCount = best.reduce((n, s) => n + s.length, 0)
    if (trialCount !== bestCount) { noImprove++; continue }
    const trialStat = scoreSheets(trial)
    if (better(trialStat, bestStat)) { best = trial; bestStat = trialStat; noImprove = 0 }
    else noImprove++
  }
  if(process.env.DBGS)console.log('shake iters',__iters)
  return best
}

// ─── Раскладка сеткой для сцепленных пар (перенос приёма из exactPack.js) ──
// Раз сцепка теперь считается своим внешним прямоугольником (см.
// buildCompositeVariants выше), для НЕЁ САМОЙ верно то же, что и в
// exactPack.js: жадная вставка по одной детали не гарантирует чистые
// колонки, а прямая раскладка сеткой — гарантирует и мгновенна. Строим её
// явно и отдаём в attemptPack уже готовым первым листом, а всё остальное
// (мелкие детали, лишние пары) идёт через обычный NFP-перебор поверх неё —
// так внешняя граница блока пар остаётся точной (реальный контур деталей
// по краям), а сама сборка — быстрой и надёжной.
function planPairGrid(tallWH, wideWH, kerf, usableX, usableY, need) {
  const plans = []
  const maxTall = tallWH ? Math.floor((usableX + kerf) / (tallWH.w + kerf)) : 0
  for (let nt = 0; nt <= maxTall; nt++) {
    if (nt === 0 && !wideWH) continue
    const usedW = tallWH && nt > 0 ? nt * (tallWH.w + kerf) : 0
    const rowsTall = tallWH ? Math.floor((usableY + kerf) / (tallWH.h + kerf)) : 0
    const tallCap = nt * rowsTall
    let nw = 0, rowsWide = 0, wideCap = 0
    if (wideWH) {
      const remaining = usableX - usedW
      nw = Math.max(0, Math.floor((remaining + kerf) / (wideWH.w + kerf)))
      rowsWide = Math.floor((usableY + kerf) / (wideWH.h + kerf))
      wideCap = nw * rowsWide
    }
    const cap = tallCap + wideCap
    if (cap <= 0) continue
    plans.push({ nt, rowsTall, nw, rowsWide, cap, waste: cap - Math.min(cap, need) })
  }
  plans.sort((a, b) => Math.min(b.cap, need) - Math.min(a.cap, need) || a.waste - b.waste)
  return plans
}

function placePairGrid(pairInstances, kerf, tallWH, wideWH, plan) {
  const sheet = []
  let idx = 0
  const place = (shape, x, y) => {
    if (idx >= pairInstances.length) return
    const inst = pairInstances[idx++]
    const variant = inst.variants.find(v => v.w === shape.w && v.h === shape.h) || inst.variants[0]
    const polygon = translate(variant.polygon, x, y)
    const absParts = variant.parts.map(p => translate(p, x, y))
    commitInstance(sheet, inst, { angle: variant.angle, x, y, polygon, absParts, bb: bboxOf(polygon) })
  }
  for (let c = 0; c < plan.nt && idx < pairInstances.length; c++) {
    const x = c * (tallWH.w + kerf)
    for (let r = 0; r < plan.rowsTall && idx < pairInstances.length; r++) place(tallWH, x, r * (tallWH.h + kerf))
  }
  const wideX0 = plan.nt * (tallWH ? tallWH.w + kerf : 0)
  for (let c = 0; c < plan.nw && idx < pairInstances.length; c++) {
    const x = wideX0 + c * (wideWH.w + kerf)
    for (let r = 0; r < plan.rowsWide && idx < pairInstances.length; r++) place(wideWH, x, r * (wideWH.h + kerf))
  }
  return sheet
}

// Полоса, оставшаяся НАД сеткой пар одного вида — сеткой же докладываем туда
// ЛЮБОЙ другой вид деталей (не участвовавший в этой сетке вовсе — например,
// мелкие детали, пока сетка строилась для крупных). Без этого другой вид
// шёл через общий перебор вообще без подсказки и не использовал явно
// свободное место (та же проблема, что была в exactPack.js).
// Сколько деталей группы влезет сеткой в полосу над уже уложенным —
// без реальной укладки, только подсчёт (для сравнения анкоров выше).
function estimateStripFitNFP(sheet, group, kerf, usableX, usableY) {
  if (!group.length) return 0
  const envY = sheet.reduce((m, p) => Math.max(m, p.bb.maxY), 0)
  const bb0 = bboxOf(group[0].variants[0].polygon)
  const w = bb0.maxX - bb0.minX, h = bb0.maxY - bb0.minY
  const y0 = envY > 0 ? envY + kerf : 0
  const rows = Math.floor((usableY - y0 + kerf) / (h + kerf))
  const cols = Math.floor((usableX + kerf) / (w + kerf))
  if (rows < 1 || cols < 1) return 0
  return Math.min(group.length, rows * cols)
}

function fillStripWithSinglesNFP(sheet, group, kerf, usableX, usableY) {
  if (!group.length) return 0
  const envY = sheet.reduce((m, p) => Math.max(m, p.bb.maxY), 0)
  const v0 = group[0].variants[0]
  const bb0 = bboxOf(v0.polygon)
  const w = bb0.maxX - bb0.minX, h = bb0.maxY - bb0.minY
  const y0 = envY > 0 ? envY + kerf : 0
  const rows = Math.floor((usableY - y0 + kerf) / (h + kerf))
  const cols = Math.floor((usableX + kerf) / (w + kerf))
  if (rows < 1 || cols < 1) return 0
  let idx = 0
  for (let r = 0; r < rows && idx < group.length; r++) {
    for (let c = 0; c < cols && idx < group.length; c++) {
      const inst = group[idx]
      const x = c * (w + kerf), y = y0 + r * (h + kerf)
      const tx = x - bb0.minX, ty = y - bb0.minY
      const polygon = translate(v0.polygon, tx, ty)
      const absParts = v0.parts.map(p => translate(p, tx, ty))
      commitInstance(sheet, inst, { angle: v0.angle, x: tx, y: ty, polygon, absParts, bb: bboxOf(polygon) })
      idx++
    }
  }
  return idx
}

function buildPairGridSheet(pairInstances, kerf, usableX, usableY, leftoverComposites = []) {
  if (pairInstances.length < 2) return null
  const shapes = pairInstances[0].variants.filter(v => v.angle === 0)
  const tallWH = shapes.find(v => v.h > v.w)
  const wideWH = shapes.find(v => v.w > v.h)
  if (!tallWH && !wideWH) return null
  const plans = planPairGrid(tallWH, wideWH, kerf, usableX, usableY, pairInstances.length)
  if (!plans.length || plans[0].cap < 2) return null
  const plan = plans[0]
  const used = Math.min(plan.cap, pairInstances.length)
  const usedInstances = pairInstances.slice(0, used)
  const sheet = placePairGrid(usedInstances, kerf, tallWH, wideWH, plan)
  const gridUsedIds = new Set(usedInstances.map(i => i.id))
  // Ширина, занятая сеткой пар — то, что справа, отдаём под простую колонку
  // одиночных деталей (тот же вид, без сцепки — просто впритык друг к
  // другу). Не любая деталь имеет вторую тесную ориентацию сцепки (у этой,
  // например, только "лёжа" — "стоя" не сцепляется реально, только
  // соприкасается), но простое смыкание всё равно строит вторую колонку и
  // держит структуру листа — то же самое эффективно делает exactPack.js.
  const usedSingles = []
  let extraLooseSingle = null
  if (leftoverComposites.length) {
    const usedW = plan.nt > 0 && tallWH ? plan.nt * (tallWH.w + kerf) : 0
    const wideW = plan.nw > 0 && wideWH ? plan.nw * (wideWH.w + kerf) : 0
    const colX = usedW + wideW
    const s0 = leftoverComposites[0].src
    const bb0 = bboxOf(s0.variants[0].polygon)
    const w = bb0.maxX - bb0.minX, h = bb0.maxY - bb0.minY
    const rows = Math.floor((usableY + kerf) / (h + kerf))
    const cols = Math.floor((usableX - colX + kerf) / (w + kerf))
    const slots = []
    for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) slots.push([c, r])
    const place = (variant, c, r) => {
      const x = colX + c * (w + kerf), y = r * (h + kerf)
      const tx = x - bb0.minX, ty = y - bb0.minY
      const polygon = translate(variant.polygon, tx, ty)
      const absParts = variant.parts.map(p => translate(p, tx, ty))
      return { angle: variant.angle, x: tx, y: ty, polygon, absParts, bb: bboxOf(polygon) }
    }
    // Кладём целыми парами слотов, кроме, может быть, ПОСЛЕДНЕГО нечётного
    // слота — раньше он просто пропадал впустую (если слотов нечётное
    // число, последний вообще не использовался), хотя туда прекрасно
    // помещается ОДНА деталь. Кладём в него одну половину ещё одной сцепки,
    // а вторую её половину не бросаем сиротой — отдаём его обратно как
    // обычную одиночную деталь для дальнейшей укладки (общий перебор её
    // разместит уже без сцепки, но всё равно на этом же листе, если влезет).
    let parentIdx = 0
    for (let s = 0; s + 1 < slots.length && parentIdx < leftoverComposites.length; s += 2) {
      const parent = leftoverComposites[parentIdx++]
      const variant = parent.src.variants[0]
      for (const [c, r] of [slots[s], slots[s + 1]]) sheet.push({ inst: parent.src, ...place(variant, c, r) })
      usedSingles.push(parent)
    }
    if (slots.length % 2 === 1 && parentIdx < leftoverComposites.length) {
      const parent = leftoverComposites[parentIdx]
      const variant = parent.src.variants[0]
      const [c, r] = slots[slots.length - 1]
      sheet.push({ inst: parent.src, ...place(variant, c, r) })
      usedSingles.push(parent)
      extraLooseSingle = { ...parent.src, id: `${parent.id}-loose` }
    }
  }
  return { sheet, usedInstances: usedInstances.concat(usedSingles), extraLooseSingle }
}

// ─── Строгая укладка вдоль выбранной стороны (Вдоль Y / Вдоль X) ───────────
// Раньше направление было лишь слабой подсказкой внутри общего перебора —
// оно не гарантировало отсутствия разрывов вдоль оси. Здесь — по-настоящему
// строго: лист делится на столбцы (Y) или ряды (X); каждый заполняется
// ВПЛОТНУЮ, новая деталь ищет максимальный контакт (по прямой И по дуге,
// через настоящую NFP-геометрию, с проверкой обоих поворотов — 0° и 180°)
// ТОЛЬКО с уже стоящими деталями этого же столбца/ряда; новый столбец/ряд
// начинается, только когда текущий больше не может принять деталь.
function packColumnsAlongY(order, usableX, usableY, kerf, nfpCache) {
  const sheets = []
  let pool = order.slice()
  while (pool.length) {
    const sheet = []
    let colX = 0, colWidth = 0, colItems = []
    const remaining = []
    for (const inst of pool) {
      let done = false
      if (colX < usableX - 1e-6) {
        const availW = usableX - colX
        const localPlaced = colItems.map(p => ({
          inst: p.inst, angle: p.angle, x: p.x - colX, y: p.y,
          polygon: p.polygon.map(([x, y]) => [x - colX, y]),
          absParts: p.absParts.map(part => part.map(([x, y]) => [x - colX, y])),
          bb: { minX: p.bb.minX - colX, maxX: p.bb.maxX - colX, minY: p.bb.minY, maxY: p.bb.maxY },
        }))
        const res = placeOne(inst.variants, localPlaced, availW, usableY, kerf, 'auto', 'along_y', nfpCache)
        if (res) {
          const entry = {
            inst, angle: res.angle, x: res.x + colX, y: res.y,
            polygon: res.polygon.map(([x, y]) => [x + colX, y]),
            absParts: res.absParts.map(part => part.map(([x, y]) => [x + colX, y])),
            bb: { minX: res.bb.minX + colX, maxX: res.bb.maxX + colX, minY: res.bb.minY, maxY: res.bb.maxY },
          }
          commitInstance(sheet, inst, entry); colItems.push(entry)
          colWidth = Math.max(colWidth, entry.bb.maxX - colX)
          done = true
        }
      }
      if (!done) {
        const newColX = colX + colWidth + (colWidth > 0 ? kerf : 0)
        if (newColX < usableX - 1e-6) {
          const availW = usableX - newColX
          const res = placeOne(inst.variants, [], availW, usableY, kerf, 'auto', 'along_y', nfpCache)
          if (res) {
            const entry = {
              inst, angle: res.angle, x: res.x + newColX, y: res.y,
              polygon: res.polygon.map(([x, y]) => [x + newColX, y]),
              absParts: res.absParts.map(part => part.map(([x, y]) => [x + newColX, y])),
              bb: { minX: res.bb.minX + newColX, maxX: res.bb.maxX + newColX, minY: res.bb.minY, maxY: res.bb.maxY },
            }
            commitInstance(sheet, inst, entry)
            colX = newColX; colWidth = entry.bb.maxX - colX; colItems = [entry]
            done = true
          }
        }
      }
      if (!done) remaining.push(inst)
    }
    if (!sheet.length) { remaining.length = 0; break } // ни одна деталь не влезла — не должно случаться
    sheets.push(sheet)
    pool = remaining
  }
  return sheets
}

function packRowsAlongX(order, usableX, usableY, kerf, nfpCache) {
  const sheets = []
  let pool = order.slice()
  while (pool.length) {
    const sheet = []
    let rowY = 0, rowHeight = 0, rowItems = []
    const remaining = []
    for (const inst of pool) {
      let done = false
      if (rowY < usableY - 1e-6) {
        const availH = usableY - rowY
        const localPlaced = rowItems.map(p => ({
          inst: p.inst, angle: p.angle, x: p.x, y: p.y - rowY,
          polygon: p.polygon.map(([x, y]) => [x, y - rowY]),
          absParts: p.absParts.map(part => part.map(([x, y]) => [x, y - rowY])),
          bb: { minX: p.bb.minX, maxX: p.bb.maxX, minY: p.bb.minY - rowY, maxY: p.bb.maxY - rowY },
        }))
        const res = placeOne(inst.variants, localPlaced, usableX, availH, kerf, 'auto', 'along_x', nfpCache)
        if (res) {
          const entry = {
            inst, angle: res.angle, x: res.x, y: res.y + rowY,
            polygon: res.polygon.map(([x, y]) => [x, y + rowY]),
            absParts: res.absParts.map(part => part.map(([x, y]) => [x, y + rowY])),
            bb: { minX: res.bb.minX, maxX: res.bb.maxX, minY: res.bb.minY + rowY, maxY: res.bb.maxY + rowY },
          }
          commitInstance(sheet, inst, entry); rowItems.push(entry)
          rowHeight = Math.max(rowHeight, entry.bb.maxY - rowY)
          done = true
        }
      }
      if (!done) {
        const newRowY = rowY + rowHeight + (rowHeight > 0 ? kerf : 0)
        if (newRowY < usableY - 1e-6) {
          const availH = usableY - newRowY
          const res = placeOne(inst.variants, [], usableX, availH, kerf, 'auto', 'along_x', nfpCache)
          if (res) {
            const entry = {
              inst, angle: res.angle, x: res.x, y: res.y + newRowY,
              polygon: res.polygon.map(([x, y]) => [x, y + newRowY]),
              absParts: res.absParts.map(part => part.map(([x, y]) => [x, y + newRowY])),
              bb: { minX: res.bb.minX, maxX: res.bb.maxX, minY: res.bb.minY + newRowY, maxY: res.bb.maxY + newRowY },
            }
            commitInstance(sheet, inst, entry)
            rowY = newRowY; rowHeight = entry.bb.maxY - rowY; rowItems = [entry]
            done = true
          }
        }
      }
      if (!done) remaining.push(inst)
    }
    if (!sheet.length) { remaining.length = 0; break }
    sheets.push(sheet)
    pool = remaining
  }
  return sheets
}

export async function packNFP({
  details, sheetL, sheetW, marginT, marginR, marginB, marginL, kerf,
  optimizeSeconds = 15, direction = 'auto',
}) {
  const usableX = sheetW - marginL - marginR
  const usableY = sheetL - marginT - marginB

  const instances = []
  const usableXForPairs = sheetW - marginL - marginR, usableYForPairs = sheetL - marginT - marginB
  details.forEach((d, di) => {
    const variants = buildPieceVariants(d, kerf)
    const v0bb = bboxOf(variants[0].polygon)
    const qty = Number(d.qty) || 1
    const singleInst = {
      id: -1, detailIndex: di, variants,
      label: d.display_name || d.name, prefix: d.prefix,
      edgeTop: d.edge_top, edgeRight: d.edge_right, edgeBottom: d.edge_bottom, edgeLeft: d.edge_left,
      w: v0bb.maxX-v0bb.minX, h: v0bb.maxY-v0bb.minY,
    }
    // Вогнутая деталь, которых в заказе больше одной — пробуем сцепить парами.
    const concave = polygonArea(variants[0].polygon) < 0.97 * singleInst.w * singleInst.h
    const pairCount = concave ? Math.floor(qty / 2) : 0
    if (pairCount > 0) {
      const pairs = buildPairInstances(singleInst, pairCount, instances.length, kerf / 2)
      if (pairs.length === pairCount) {
          instances.push(...pairs)
        for (let q = pairCount * 2; q < qty; q++) instances.push({ ...singleInst, id: instances.length })
        return
      }
      // Не удалось построить сцепку (например, для этой формы NFP не нашёл
      // контакта) — откатываемся на обычные одиночные детали, как раньше.
    }
    for (let q = 0; q < qty; q++) instances.push({ ...singleInst, id: instances.length })
  })

  const startTime = Date.now()
  const budgetMs = Math.max(0, Number(optimizeSeconds)||0) * 1000

  // «Вдоль Y» / «Вдоль X» — строгий режим (см. packColumnsAlongY/packRowsAlongX
  // выше): без этого раньше направление было лишь слабой подсказкой внутри
  // общего перебора и не гарантировало отсутствия разрывов вдоль оси. Здесь
  // решение полностью детерминированное — не нужны ни генетика, ни сетка пар
  // отдельно (сцепленные пары участвуют как есть, они уже настоящие плотные
  // блоки), ни встряска.
  const buildResult = sheets => ({
    sheets: sheets.map((sheet, i) => ({
      index: i,
      freeRects: [],
      placed: sheet.map(p => {
        const times = ((p.angle % 360) + 360) % 360 / 90
        let top = p.inst.edgeTop, right = p.inst.edgeRight, bottom = p.inst.edgeBottom, left = p.inst.edgeLeft
        for (let k = 0; k < times; k++) { const nTop = left, nRight = top, nBottom = right, nLeft = bottom; top = nTop; right = nRight; bottom = nBottom; left = nLeft }
        return {
          detailIndex: p.inst.detailIndex, label: p.inst.label, prefix: p.inst.prefix,
          x: p.x, y: p.y, w: p.bb.maxX - p.bb.minX, h: p.bb.maxY - p.bb.minY,
          origX: p.bb.maxX - p.bb.minX, origY: p.bb.maxY - p.bb.minY,
          rotated: p.angle === 90 || p.angle === 270, rotation: p.angle,
          edgeTop: top, edgeRight: right, edgeBottom: bottom, edgeLeft: left,
          polygon: p.polygon.map(([x, y]) => ({ x: x - p.x, y: y - p.y })),
        }
      }),
    })),
    usableX, usableY, sheetL, sheetW, marginT, marginR, marginB, marginL, kerf,
  })

  if (direction === 'along_y' || direction === 'along_x') {
    const order = instances.slice().sort((a, b) => (b.w * b.h) - (a.w * a.h))
    const nfpCache = new Map()
    const sheets = direction === 'along_y'
      ? packColumnsAlongY(order, usableX, usableY, kerf, nfpCache)
      : packRowsAlongX(order, usableX, usableY, kerf, nfpCache)
    return buildResult(sheets)
  }

  // «Авто» — растёт от угла (0,0), но заранее не знает, какая сторона листа
  // выгоднее: колонками вверх (Y) или рядами вбок (X) — для одного набора
  // деталей плотнее одно, для другого другое. Строгие Y/X-раскладчики выше
  // быстрые и детерминированные — считаем оба варианта сразу и берём тот,
  // что даёт меньше листов (при равенстве — меньше материала на последнем);
  // сравниваем их дальше и со свободным перебором (сетка пар + генетика +
  // встряска), который может расставить детали не только по строгой сетке
  // столбцов/рядов, но и по диагонали — победитель определяется по факту.
  let autoBest = null, autoBestStat = null
  {
    const orderForDir = instances.slice().sort((a, b) => (b.w * b.h) - (a.w * a.h))
    const cacheY = new Map(), cacheX = new Map()
    const sheetsY = packColumnsAlongY(orderForDir, usableX, usableY, kerf, cacheY)
    const statY = scoreSheets(sheetsY)
    autoBest = sheetsY; autoBestStat = statY
    const sheetsX = packRowsAlongX(orderForDir, usableX, usableY, kerf, cacheX)
    const statX = scoreSheets(sheetsX)
    if (better(statX, autoBestStat)) { autoBest = sheetsX; autoBestStat = statX }
  }

  // Сцепленные пары — сеткой, сразу как готовый первый лист (см. комментарий
  // у buildPairGridSheet выше); всё остальное укладывается поверх обычным
  // NFP-перебором, включая генетику.
  const pairGroupsByType = new Map()
  for (const inst of instances) {
    if (!inst.isComposite) continue
    if (!pairGroupsByType.has(inst.detailIndex)) pairGroupsByType.set(inst.detailIndex, [])
    pairGroupsByType.get(inst.detailIndex).push(inst)
  }
  let gridSeed = null, gridSeedTotal = -1
  for (const [detailIndex, group] of pairGroupsByType.entries()) {
    const plans = group.length >= 2 ? planPairGrid(
      group[0].variants.filter(v => v.angle === 0).find(v => v.h > v.w),
      group[0].variants.filter(v => v.angle === 0).find(v => v.w > v.h),
      kerf, usableX, usableY, group.length,
    ) : []
    const gridCap = plans.length ? Math.min(plans[0].cap, group.length) : 0
    const leftoverComposites = group.slice(gridCap)
    const built = buildPairGridSheet(group, kerf, usableX, usableY, leftoverComposites)
    if (!built) continue
    // Раньше сравнивали только по числу деталей В САМОЙ сетке — а выигрывать
    // должен тот вариант, что даёт больше деталей НА ЛИСТЕ ИТОГО, с учётом
    // остальных видов, докладываемых поверх (см. комментарий ниже). Иначе
    // в анкоре мог оказаться вид с меньшей выгодой от сцепки, а крупные
    // детали, которым сцепка даёт больше всего экономии места, доставались
    // бы простой сеткой поштучно — как раз это и находили на реальном заказе.
    const usedIds = new Set(built.usedInstances.map(i => i.id))
    const otherByType = new Map()
    for (const inst of instances) {
      if (usedIds.has(inst.id) || inst.detailIndex === detailIndex) continue
      if (!otherByType.has(inst.detailIndex)) otherByType.set(inst.detailIndex, [])
      otherByType.get(inst.detailIndex).push(inst)
    }
    const otherGroups = [...otherByType.values()].sort((a, b) => (b[0].w * b[0].h) - (a[0].w * a[0].h))
    let total = built.sheet.length
    for (const g of otherGroups) total += estimateStripFitNFP(built.sheet, g, kerf, usableX, usableY)
    if (total > gridSeedTotal) { gridSeedTotal = total; gridSeed = { ...built, detailIndex } }
  }
  // Виды деталей, для которых сетка НЕ строилась (проиграли по числу
  // размещённых штук, или не вогнутые вовсе — сцепка для них не пробовалась)
  // — докладываем сеткой же в оставшуюся полосу над победившей раскладкой,
  // от крупных к мелким, вместо того чтобы отдавать их без подсказки общему
  // перебору (см. fillStripWithSinglesNFP выше).
  if (gridSeed) {
    const usedIds = new Set(gridSeed.usedInstances.map(i => i.id))
    const otherByType = new Map()
    for (const inst of instances) {
      if (usedIds.has(inst.id) || inst.detailIndex === gridSeed.detailIndex) continue
      if (!otherByType.has(inst.detailIndex)) otherByType.set(inst.detailIndex, [])
      otherByType.get(inst.detailIndex).push(inst)
    }
    const otherGroups = [...otherByType.values()].sort((a, b) => (b[0].w * b[0].h) - (a[0].w * a[0].h))
    for (const g of otherGroups) {
      const n = fillStripWithSinglesNFP(gridSeed.sheet, g, kerf, usableX, usableY)
      if (n > 0) gridSeed.usedInstances = gridSeed.usedInstances.concat(g.slice(0, n))
    }
  }
  let seedSheet = null, seedRest = instances
  if (gridSeed) {
    const usedIds = new Set(gridSeed.usedInstances.map(i => i.id))
    seedRest = instances.filter(i => !usedIds.has(i.id))
    if (gridSeed.extraLooseSingle) seedRest = seedRest.concat([gridSeed.extraLooseSingle])
    seedSheet = gridSeed.sheet
  }

  const seedOrder = seedRest.slice().sort((a,b)=>(b.w*b.h)-(a.w*a.h))
  const nfpCache = new Map()
  const __t0=Date.now()
  let best = attemptPack(seedOrder, usableX, usableY, kerf, direction, seedSheet, nfpCache)
  if(process.env.DBGS)console.log('first attemptPack',Date.now()-__t0,'ms')
  let bestStat = scoreSheets(best)

  let __evalCount=0
  if (budgetMs > 0 && seedRest.length > 1) {
    const POP_SIZE = instances.length > 40 ? 8 : 14
    const ELITE_COUNT = 2, TOURNAMENT_SIZE = 3, MUTATION_RATE = 0.4
    // Отдельная подсказка для генетики: сначала все "стоячие" сцепки одного
    // вида, потом все "лежачие" — если у формы есть обе ориентации сцепки,
    // они образуют чистые колонки/ряды только когда однотипные идут подряд
    // (вперемешку жадная укладка не группирует их сама).
    const byOrientation = seedRest.slice().sort((a, b) => {
      const wa = a.variants[0], wb = b.variants[0]
      const oa = wa.w > wa.h ? 1 : 0, ob = wb.w > wb.h ? 1 : 0
      return oa - ob || (b.w*b.h) - (a.w*a.h)
    })
    let population = [
      seedOrder,
      byOrientation,
      seedRest.slice().sort((a,b)=>Math.max(b.w,b.h)-Math.max(a.w,a.h)),
      seedRest.slice().sort((a,b)=>Math.min(a.w,a.h)-Math.min(b.w,b.h)),
      seedRest.slice().sort((a,b)=>(a.w*a.h)-(b.w*b.h)), // сначала мелкие
      interleaveByAreaBand(seedRest), // чередование крупных и мелких — мелкие успевают занять то, что крупные ещё не "забронировали"
    ]
    while (population.length < POP_SIZE) population.push(shuffle(seedRest))

    let evaluated = []
    for (const order of population) {
      if (Date.now()-startTime > budgetMs) break
const sheets = attemptPack(order, usableX, usableY, kerf, direction, seedSheet, nfpCache)
      if (sheets) evaluated.push({ order, sheets, stat: scoreSheets(sheets) })
    }
    if (evaluated.length) {
      evaluated.sort((a,b)=> better(a.stat,b.stat)?-1:1)
      if (better(evaluated[0].stat, bestStat)) { best = evaluated[0].sheets; bestStat = evaluated[0].stat }
      while (Date.now()-startTime < budgetMs && evaluated.length >= 2) {
        const nextGen = evaluated.slice(0, ELITE_COUNT).map(e=>e.order)
        while (nextGen.length < POP_SIZE && Date.now()-startTime < budgetMs) {
          const pa = tournamentSelect(evaluated, TOURNAMENT_SIZE), pb = tournamentSelect(evaluated, TOURNAMENT_SIZE)
          let child = orderCrossover(pa.order, pb.order)
          if (Math.random() < MUTATION_RATE) child = perturbOrder(child)
          nextGen.push(child)
        }
        const nextEval = []
        for (const order of nextGen) {
          if (Date.now()-startTime > budgetMs) break
    const sheets = attemptPack(order, usableX, usableY, kerf, direction, seedSheet, nfpCache)
          if (sheets) nextEval.push({ order, sheets, stat: scoreSheets(sheets) })
        }
        if (!nextEval.length) break
        evaluated = nextEval
        evaluated.sort((a,b)=> better(a.stat,b.stat)?-1:1)
        if (better(evaluated[0].stat, bestStat)) { best = evaluated[0].sheets; bestStat = evaluated[0].stat }
      }
    }
  }

  // Дожим лучшей найденной раскладки — до конца бюджета времени.
  if (best.length > 1 && Date.now() - startTime < budgetMs) {
    const swept = await sweepForwardNFP(best, usableX, usableY, kerf, direction, startTime + budgetMs, nfpCache)
    const sweptStat = scoreSheets(swept)
    if (better(sweptStat, bestStat)) { best = swept; bestStat = sweptStat }
  }

  if(process.env.DBGS)console.log('time before shake', Date.now()-startTime,'ms of budget',budgetMs)
  // «Встряска» — то, чего не хватало сетке и генетике: обе строят раскладку
  // ОДИН РАЗ и не возвращаются к уже поставленным деталям. Настоящий эталон
  // (проверено на примерах конкурента) — это неровная, но плотная мозаика,
  // где детали цепляются друг за друга в разных, не повторяющихся местах
  // листа; такое находится только локальным поиском по УЖЕ готовой
  // раскладке: вынуть несколько деталей, попробовать вставить их заново в
  // другом порядке через настоящий NFP-контакт, оставить, если стало лучше
  // (меньше листов или меньше материала на последнем) — и повторять, пока
  // есть время. Работает на оставшемся бюджете после генетики и дожима.
  if (Date.now() - startTime < budgetMs) {
    const shaken = await shakeNFP(best, usableX, usableY, kerf, direction, startTime + budgetMs, nfpCache)
    const shakenStat = scoreSheets(shaken)
    if (better(shakenStat, bestStat)) { best = shaken; bestStat = shakenStat }
  }

  // Сравниваем итог свободного перебора со строгими Y/X, посчитанными в
  // начале (см. выше) — берём то, что реально плотнее, а не то, что
  // исторически шло первым.
  if (better(autoBestStat, bestStat)) { best = autoBest; bestStat = autoBestStat }

  return buildResult(best)
}
