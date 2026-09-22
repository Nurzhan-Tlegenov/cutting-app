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
function placeOne(variants, placed, usableX, usableY, scoreMode = 'auto') {
  let best = null, bestScore = Infinity
  for (const v of variants) {
    const bb0 = bboxOf(v.polygon)
    const minX = -bb0.minX, maxX = usableX - bb0.maxX
    const minY = -bb0.minY, maxY = usableY - bb0.maxY
    if (maxX < minX - 1e-6 || maxY < minY - 1e-6) continue

    const movingPartsReflected = v.parts.map(p => reflectPoly(p))
    const candidates = [[minX, minY], [minX, maxY], [maxX, minY]]
    const nfpList = placed.map(p => nfpFromParts(p.absParts, movingPartsReflected))
    for (const nfp of nfpList) for (const pt of nfp.points) candidates.push(pt)
    for (let i = 0; i < nfpList.length; i++) {
      for (let j = i + 1; j < nfpList.length; j++) {
        for (const pt of nfpPairwiseIntersections(nfpList[i].edges, nfpList[j].edges)) candidates.push(pt)
      }
    }
    const xLines = new Set([minX, maxX]), yLines = new Set([minY, maxY])
    placed.forEach(p => { xLines.add(p.bb.minX); xLines.add(p.bb.maxX); yLines.add(p.bb.minY); yLines.add(p.bb.maxY) })
    for (const nfp of nfpList) {
      for (const pt of edgesAgainstAlignmentLines(nfp.edges, [...xLines], [...yLines])) candidates.push(pt)
    }

    // Габариты кусков движущейся детали в её ЛОКАЛЬНОЙ системе (сдвигаем на
    // (ox,oy) при проверке кандидата) — чтобы для каждой пары (кусок
    // движущейся, кусок соседа) сначала отсечь по bbox и только потом делать
    // дорогой точный тест пересечения (тот же эффект, что и в nfpFromParts).
    const partBB = v.parts.map(bboxOf)
    for (const [ox, oy] of candidates) {
      if (ox < minX - 1e-6 || ox > maxX + 1e-6 || oy < minY - 1e-6 || oy > maxY + 1e-6) continue
      let bad = false, absParts = null
      for (const p of placed) {
        if (p.bb.minX > ox + partBB.reduce((m,b)=>Math.max(m,b.maxX),-Infinity) || p.bb.maxX < ox + partBB.reduce((m,b)=>Math.min(m,b.minX),Infinity) ||
            p.bb.minY > oy + partBB.reduce((m,b)=>Math.max(m,b.maxY),-Infinity) || p.bb.maxY < oy + partBB.reduce((m,b)=>Math.min(m,b.minY),Infinity)) continue
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
      // buildPairSubs): 'auto' минимизирует площадь габарита и почти всегда
      // находит только одну из двух (у них площадь габарита практически
      // одинаковая — 704x1036 против 1038x704 — так что вторая, с виду ничуть
      // не хуже, просто никогда не побеждает в сравнении по площади и даже не
      // пробуется отдельно).
      const score = scoreMode === 'tall' ? envMaxX * 1e6 + envMaxY
        : scoreMode === 'wide' ? envMaxY * 1e6 + envMaxX
        : envMaxX * envMaxY + oy * 0.001 + ox * 0.0001
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
function buildPairSubs(inst) {
  const v0 = inst.variants[0]
  const bb0 = bboxOf(v0.polygon)
  const firstPoly = translate(v0.polygon, -bb0.minX, -bb0.minY)
  const firstParts = v0.parts.map(p => translate(p, -bb0.minX, -bb0.minY))
  const firstPlaced = { bb: bboxOf(firstPoly), absParts: firstParts }
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
      const res = placeOne([v], [firstPlaced], BIG, BIG, mode)
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
function buildCompositeVariants(baseSubs, W0, H0, rotatable) {
  const mk = (subs, w, h, angle) => ({ angle, w, h, polygon: [[0,0],[w,0],[w,h],[0,h]], subs, parts: subs.flatMap(s=>s.parts) })
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

function buildPairInstances(inst, count, nextIdStart) {
  const candidates = buildPairSubs(inst)
  if (!candidates.length) return []
  const rotatable = inst.variants.length > 2
  const instances = []
  for (let k = 0; k < count; k++) {
    const cand = candidates[k % candidates.length] // чередуем найденные способы сцепки — разнообразие для генетики
    instances.push({
      id: nextIdStart + k, detailIndex: inst.detailIndex, isComposite: true, src: inst,
      label: inst.label, prefix: inst.prefix,
      edgeTop: inst.edgeTop, edgeRight: inst.edgeRight, edgeBottom: inst.edgeBottom, edgeLeft: inst.edgeLeft,
      variants: buildCompositeVariants(cand.subs, cand.W, cand.H, rotatable),
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

function attemptPack(order, usableX, usableY) {
  const sheets = [[]]
  for (let idx = 0; idx < order.length; idx++) {
    const inst = order[idx]
    let done = false
    for (const sheet of sheets) {
      if (sheet.length === 0) continue // пустой лист — обрабатываем отдельно ниже, с оглядкой на следующую деталь
      const res = placeOne(inst.variants, sheet, usableX, usableY)
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
        const res = placeOne([v], [], usableX, usableY)
        if (!res) continue
        let lookaheadScore = 0
        if (nextInst) {
          const res2 = placeOne(nextInst.variants, [{ inst, ...res }], usableX, usableY)
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
async function sweepForwardNFP(sheets, usableX, usableY, deadline) {
  let result = sheets.map(s => s.slice())
  for (let round = 0; round < 6 && Date.now() < deadline; round++) {
    let moved = false
    for (let i = 0; i < result.length - 1 && Date.now() < deadline; i++) {
      for (let j = result.length - 1; j > i; j--) {
        const from = result[j]
        for (let k = from.length - 1; k >= 0 && Date.now() < deadline; k--) {
          const inst = from[k].inst
          const res = placeOne(inst.variants, result[i], usableX, usableY)
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

export async function packNFP({
  details, sheetL, sheetW, marginT, marginR, marginB, marginL, kerf,
  optimizeSeconds = 15,
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
      const pairs = buildPairInstances(singleInst, pairCount, instances.length)
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

  const seedOrder = instances.slice().sort((a,b)=>(b.w*b.h)-(a.w*a.h))
  let best = attemptPack(seedOrder, usableX, usableY)
  let bestStat = scoreSheets(best)

  if (budgetMs > 0 && instances.length > 1) {
    const POP_SIZE = instances.length > 40 ? 8 : 14
    const ELITE_COUNT = 2, TOURNAMENT_SIZE = 3, MUTATION_RATE = 0.4
    let population = [
      seedOrder,
      instances.slice().sort((a,b)=>Math.max(b.w,b.h)-Math.max(a.w,a.h)),
      instances.slice().sort((a,b)=>Math.min(a.w,a.h)-Math.min(b.w,b.h)),
      instances.slice().sort((a,b)=>(a.w*a.h)-(b.w*b.h)), // сначала мелкие
      interleaveByAreaBand(instances), // чередование крупных и мелких — мелкие успевают занять то, что крупные ещё не "забронировали"
    ]
    while (population.length < POP_SIZE) population.push(shuffle(instances))

    let evaluated = []
    for (const order of population) {
      if (Date.now()-startTime > budgetMs) break
      const sheets = attemptPack(order, usableX, usableY)
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
          const sheets = attemptPack(order, usableX, usableY)
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
    const swept = await sweepForwardNFP(best, usableX, usableY, startTime + budgetMs)
    const sweptStat = scoreSheets(swept)
    if (better(sweptStat, bestStat)) { best = swept; bestStat = sweptStat }
  }

  return {
    sheets: best.map((sheet, i) => ({
      index: i,
      freeRects: [],
      placed: sheet.map(p => {
        // Поворот кромки вслед за поворотом детали (той же логикой, что и в
        // растровом алгоритме, trueShapeNesting.js) — раньше здесь кромка
        // всегда отдавалась "как есть", без учёта угла поворота детали;
        // для деталей со сцепкой (внутри пары обе копии повёрнуты по-разному)
        // это стало бы заметной ошибкой, поэтому чиним для всех сразу.
        const times = ((p.angle % 360) + 360) % 360 / 90
        let top = p.inst.edgeTop, right = p.inst.edgeRight, bottom = p.inst.edgeBottom, left = p.inst.edgeLeft
        for (let i = 0; i < times; i++) {
          const nTop = left, nRight = top, nBottom = right, nLeft = bottom
          top = nTop; right = nRight; bottom = nBottom; left = nLeft
        }
        return {
          detailIndex: p.inst.detailIndex, label: p.inst.label, prefix: p.inst.prefix,
          x: p.x, y: p.y, w: p.bb.maxX-p.bb.minX, h: p.bb.maxY-p.bb.minY,
          origX: p.bb.maxX-p.bb.minX, origY: p.bb.maxY-p.bb.minY,
          rotated: p.angle===90||p.angle===270, rotation: p.angle,
          edgeTop: top, edgeRight: right, edgeBottom: bottom, edgeLeft: left,
          polygon: p.polygon.map(([x,y])=>({x: x-p.x, y: y-p.y})),
        }
      }),
    })),
    usableX, usableY, sheetL, sheetW, marginT, marginR, marginB, marginL, kerf,
  }
}
