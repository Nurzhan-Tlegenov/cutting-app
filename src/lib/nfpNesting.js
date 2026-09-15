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
function placeOne(variants, placed, usableX, usableY) {
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

    for (const [ox, oy] of candidates) {
      if (ox < minX - 1e-6 || ox > maxX + 1e-6 || oy < minY - 1e-6 || oy > maxY + 1e-6) continue
      const absParts = v.parts.map(p => translate(p, ox, oy))
      let bad = false
      for (const p of placed) {
        outer:
        for (const a of absParts) for (const b of p.absParts) {
          if (polygonsOverlapRobust(a, b)) { bad = true; break outer }
        }
        if (bad) break
      }
      if (bad) continue
      let envMaxX = ox + bb0.maxX, envMaxY = oy + bb0.maxY
      for (const p of placed) { envMaxX = Math.max(envMaxX, p.bb.maxX); envMaxY = Math.max(envMaxY, p.bb.maxY) }
      const score = envMaxX * envMaxY + oy * 0.001 + ox * 0.0001
      if (score < bestScore) {
        bestScore = score
        best = { angle: v.angle, x: ox, y: oy, polygon: translate(v.polygon, ox, oy), absParts, bb: bboxOf(translate(v.polygon, ox, oy)) }
      }
    }
  }
  return best
}

function attemptPack(order, usableX, usableY) {
  const sheets = [[]]
  for (let idx = 0; idx < order.length; idx++) {
    const inst = order[idx]
    let done = false
    for (const sheet of sheets) {
      if (sheet.length === 0) continue // пустой лист — обрабатываем отдельно ниже, с оглядкой на следующую деталь
      const res = placeOne(inst.variants, sheet, usableX, usableY)
      if (res) { sheet.push({ inst, ...res }); done = true; break }
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
      targetSheet.push({ inst, ...bestFirst })
    }
  }
  return sheets.filter(s => s.length > 0)
}

function scoreSheets(sheets) {
  const last = sheets[sheets.length - 1]
  const lastArea = last.reduce((s, p) => s + (p.bb.maxX - p.bb.minX) * (p.bb.maxY - p.bb.minY), 0)
  return [sheets.length, -lastArea]
}
function better(a, b) { return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]) }

function shuffle(arr) {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]] }
  return a
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

export async function packNFP({
  details, sheetL, sheetW, marginT, marginR, marginB, marginL, kerf,
  optimizeSeconds = 15,
}) {
  const usableX = sheetW - marginL - marginR
  const usableY = sheetL - marginT - marginB

  const instances = []
  details.forEach((d, di) => {
    const variants = buildPieceVariants(d, kerf)
    const v0bb = bboxOf(variants[0].polygon)
    for (let q=0; q<(Number(d.qty)||1); q++) {
      instances.push({
        id: instances.length, detailIndex: di, variants,
        label: d.display_name || d.name, prefix: d.prefix,
        edgeTop: d.edge_top, edgeRight: d.edge_right, edgeBottom: d.edge_bottom, edgeLeft: d.edge_left,
        w: v0bb.maxX-v0bb.minX, h: v0bb.maxY-v0bb.minY,
      })
    }
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

  return {
    sheets: best.map((sheet, i) => ({
      index: i,
      freeRects: [],
      placed: sheet.map(p => ({
        detailIndex: p.inst.detailIndex, label: p.inst.label, prefix: p.inst.prefix,
        x: p.x, y: p.y, w: p.bb.maxX-p.bb.minX, h: p.bb.maxY-p.bb.minY,
        origX: p.bb.maxX-p.bb.minX, origY: p.bb.maxY-p.bb.minY,
        rotated: p.angle===90||p.angle===270, rotation: p.angle,
        edgeTop: p.inst.edgeTop, edgeRight: p.inst.edgeRight, edgeBottom: p.inst.edgeBottom, edgeLeft: p.inst.edgeLeft,
        polygon: p.polygon.map(([x,y])=>({x: x-p.x, y: y-p.y})),
      })),
    })),
    usableX, usableY, sheetL, sheetW, marginT, marginR, marginB, marginL, kerf,
  }
}
