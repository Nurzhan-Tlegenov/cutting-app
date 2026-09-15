/**
 * Геометрическое ядро No-Fit-Polygon — точная (не растровая) укладка по
 * реальному контуру детали. Реализация с нуля по опубликованному подходу
 * (декомпозиция на выпуклые части + сумма Минковского на каждой паре
 * выпуклых кусков) — без каких-либо внешних библиотек и без лицензионных
 * рисков (сам алгоритм — открытая вычислительная геометрия, не чей-то код).
 *
 * ПОЧЕМУ ЭТО ВООБЩЕ НУЖНО (в отличие от растровой укладки в trueShapeNesting.js):
 *   Растровый подход сэмплирует кандидатные позиции по границам свободных
 *   участков сетки — этого достаточно для простых вогнутостей, но не находит
 *   позиции, где выступ одной детали заходит в вырез другой на смещении, не
 *   привязанном ни к какой границе уже уложенных деталей (типичный случай —
 *   две одинаковые Г-детали, интерлокнутые через поворот на 180°). NFP даёт
 *   ТОЧНЫЕ позиции касания — не сэмплы, а сами точки контакта контуров.
 *
 * ОГРАНИЧЕНИЯ ЭТОЙ РЕАЛИЗАЦИИ (сознательно, для первой версии):
 *   - decomposeConvex режет через ближайшую валидную диагональ (не
 *     Хертель-Мельхорн) — корректно, но не минимальное число кусков;
 *     для реальных деталей это не критично по времени.
 *   - Полигоны считаются простыми (без самопересечений и без дыр внутри
 *     самого внешнего контура) — вырезы/пазы как отдельные дыры в НЕ входят
 *     в этот модуль, они остаются вне укладки (как и в trueShapeNesting.js).
 */

const EPS = 1e-9

function cross(o, a, b) { return (a[0]-o[0])*(b[1]-o[1]) - (a[1]-o[1])*(b[0]-o[0]) }
export function signedArea(poly) {
  let s = 0
  for (let i = 0; i < poly.length; i++) {
    const [x1,y1] = poly[i], [x2,y2] = poly[(i+1)%poly.length]
    s += x1*y2 - x2*y1
  }
  return s/2
}
export function ensureCCW(poly) { return signedArea(poly) < 0 ? poly.slice().reverse() : poly.slice() }

export function pointInPoly(pt, poly) {
  let inside = false
  for (let i=0,j=poly.length-1;i<poly.length;j=i++) {
    const [xi,yi]=poly[i], [xj,yj]=poly[j]
    const hit = ((yi>pt[1])!==(yj>pt[1])) && (pt[0] < (xj-xi)*(pt[1]-yi)/(yj-yi)+xi)
    if (hit) inside = !inside
  }
  return inside
}

function segsIntersect(p1,p2,p3,p4) {
  function o(a,b,c){ const v=cross(a,b,c); return v>EPS?1:(v<-EPS?2:0) }
  const o1=o(p1,p2,p3), o2=o(p1,p2,p4), o3=o(p3,p4,p1), o4=o(p3,p4,p2)
  return o1!==o2 && o3!==o4
}

export function segIntersectionPoint(p1,p2,p3,p4) {
  const x1=p1[0],y1=p1[1],x2=p2[0],y2=p2[1],x3=p3[0],y3=p3[1],x4=p4[0],y4=p4[1]
  const d = (x1-x2)*(y3-y4) - (y1-y2)*(x3-x4)
  if (Math.abs(d) < EPS) return null
  const t = ((x1-x3)*(y3-y4) - (y1-y3)*(x3-x4)) / d
  const u = ((x1-x3)*(y1-y2) - (y1-y3)*(x1-x2)) / d
  if (t < -1e-7 || t > 1+1e-7 || u < -1e-7 || u > 1+1e-7) return null
  return [x1 + t*(x2-x1), y1 + t*(y2-y1)]
}

function isValidDiagonal(poly, i, j) {
  const n = poly.length
  const a = poly[i], b = poly[j]
  for (let k=0;k<n;k++){
    const c = poly[k], d = poly[(k+1)%n]
    if (k===i || k===j || (k+1)%n===i || (k+1)%n===j) continue
    if (segsIntersect(a,b,c,d)) return false
  }
  const mid = [(a[0]+b[0])/2, (a[1]+b[1])/2]
  return pointInPoly(mid, poly)
}

function isReflex(poly, i) {
  const n = poly.length
  const prev = poly[(i-1+n)%n], cur = poly[i], next = poly[(i+1)%n]
  return cross(prev, cur, next) < -EPS
}

// Декомпозиция простого CCW-полигона на выпуклые части: находим reflex-
// вершину, режем через ближайшую валидную диагональ, рекурсия на обеих
// половинах. Корректно для любого простого полигона (в т.ч. с дугами,
// сэмплированными в мелкие отрезки).
export function decomposeConvex(inputPoly, depth = 0) {
  const poly = ensureCCW(inputPoly)
  const n = poly.length
  if (n < 3) return []
  if (depth > 60) return [poly]
  let reflexIdx = -1
  for (let i=0;i<n;i++) if (isReflex(poly,i)) { reflexIdx = i; break }
  if (reflexIdx === -1) return [poly]

  let bestJ = -1, bestDist = Infinity
  for (let j=0;j<n;j++){
    if (j===reflexIdx || j===(reflexIdx+1)%n || j===(reflexIdx-1+n)%n) continue
    if (!isValidDiagonal(poly, reflexIdx, j)) continue
    const d = Math.hypot(poly[j][0]-poly[reflexIdx][0], poly[j][1]-poly[reflexIdx][1])
    if (d < bestDist) { bestDist = d; bestJ = j }
  }
  if (bestJ === -1) return [poly]

  const i = reflexIdx, j = bestJ
  const partA = [], partB = []
  let k = i
  while (true) { partA.push(poly[k]); if (k===j) break; k=(k+1)%n }
  k = j
  while (true) { partB.push(poly[k]); if (k===i) break; k=(k+1)%n }
  return [...decomposeConvex(partA, depth+1), ...decomposeConvex(partB, depth+1)]
}

// Сумма Минковского двух выпуклых CCW-полигонов (merge-by-angle, O(n+m)).
export function minkowskiSumConvex(A, B) {
  A = ensureCCW(A); B = ensureCCW(B)
  const na=A.length, nb=B.length
  const startA = A.reduce((best,p,idx)=> (p[1]<A[best][1]||(p[1]===A[best][1]&&p[0]<A[best][0]))?idx:best, 0)
  const startB = B.reduce((best,p,idx)=> (p[1]<B[best][1]||(p[1]===B[best][1]&&p[0]<B[best][0]))?idx:best, 0)
  const result = []
  let ia=startA, ib=startB, ca=0, cb=0
  const angle = (p,q)=> Math.atan2(q[1]-p[1], q[0]-p[0])
  while (ca < na || cb < nb) {
    result.push([A[ia][0]+B[ib][0], A[ia][1]+B[ib][1]])
    const angA = ca < na ? angle(A[ia], A[(ia+1)%na]) : Infinity
    const angB = cb < nb ? angle(B[ib], B[(ib+1)%nb]) : Infinity
    if (ca >= na) { ib=(ib+1)%nb; cb++ }
    else if (cb >= nb) { ia=(ia+1)%na; ca++ }
    else if (angA < angB - EPS) { ia=(ia+1)%na; ca++ }
    else if (angB < angA - EPS) { ib=(ib+1)%nb; cb++ }
    else { ia=(ia+1)%na; ca++; ib=(ib+1)%nb; cb++ }
  }
  return result
}

export function reflectPoly(poly) { return poly.map(([x,y])=>[-x,-y]) }

// Маленький выпуклый многоугольник, приближающий круг радиуса r — для
// раздутия контура на kerf/2 через сумму Минковского (аналитическое
// раздутие вместо растровой дилатации ячеек).
function regularPolygon(sides, r) {
  const pts = []
  for (let i=0;i<sides;i++){
    const a = (i/sides) * Math.PI * 2
    pts.push([r*Math.cos(a), r*Math.sin(a)])
  }
  return pts
}

// Раздутые (на kerf/2) выпуклые части полигона. ВАЖНО: раздуваем ВЕСЬ
// контур целиком (offsetPolygon), а декомпозицию на выпуклые части делаем
// ПОСЛЕ раздутия — не наоборот. Раздутие каждого куска декомпозиции по
// отдельности (как было в первой версии) даёт ложный "нарост" ровно на
// внутреннем разрезе декомпозиции (это не настоящая граница детали, просто
// техническая линия разреза) — это ловилось как ложное пересечение там, где
// его в реальности нет, и заметно портило точность самых плотных вложений.
function offsetPolygon(polyCCW, delta) {
  if (delta <= 0) return polyCCW
  const n = polyCCW.length
  const normal = (a, b) => {
    const dx = b[0]-a[0], dy = b[1]-a[1], len = Math.hypot(dx,dy) || 1
    return [dy/len, -dx/len] // для CCW-полигона это внешняя нормаль
  }
  const out = []
  for (let i=0;i<n;i++){
    const prev = polyCCW[(i-1+n)%n], cur = polyCCW[i], next = polyCCW[(i+1)%n]
    const n1 = normal(prev, cur), n2 = normal(cur, next)
    // Смещённые прямые (не отрезки) для двух рёбер, сходящихся в cur
    const a1 = [prev[0]+n1[0]*delta, prev[1]+n1[1]*delta]
    const b1 = [cur[0]+n1[0]*delta, cur[1]+n1[1]*delta]
    const a2 = [cur[0]+n2[0]*delta, cur[1]+n2[1]*delta]
    const b2 = [next[0]+n2[0]*delta, next[1]+n2[1]*delta]
    // Почти коллинеарные соседние рёбра (типично для мелко сэмплированных
    // дуг) — пересечение прямых неустойчиво, просто сдвигаем вершину по
    // средней нормали, без пересечения линий.
    const cosAngle = n1[0]*n2[0] + n1[1]*n2[1]
    if (cosAngle > 1 - 1e-6) {
      const avg = [(n1[0]+n2[0])/2, (n1[1]+n2[1])/2]
      const l = Math.hypot(avg[0],avg[1]) || 1
      out.push([cur[0] + avg[0]/l*delta, cur[1] + avg[1]/l*delta])
      continue
    }
    const d = (b1[0]-a1[0])*(b2[1]-a2[1]) - (b1[1]-a1[1])*(b2[0]-a2[0])
    if (Math.abs(d) < 1e-9) { out.push([cur[0]+n1[0]*delta, cur[1]+n1[1]*delta]); continue }
    const t = ((a2[0]-a1[0])*(b2[1]-a2[1]) - (a2[1]-a1[1])*(b2[0]-a2[0])) / d
    out.push([a1[0] + t*(b1[0]-a1[0]), a1[1] + t*(b1[1]-a1[1])])
  }
  return out
}

export function dilatedConvexParts(rawPolyCCW, halfKerf) {
  const offset = halfKerf > 0 ? offsetPolygon(ensureCCW(rawPolyCCW), halfKerf) : rawPolyCCW
  return decomposeConvex(offset)
}

// NFP из УЖЕ раздутых выпуклых частей (посчитаны один раз на форму+поворот,
// переиспользуются во всех попытках размещения — декомпозиция дорогая,
// делать её на каждый вызов нельзя).
// sPartsAbs — абсолютные (уже сдвинутые на место) части уже уложенной детали.
// mPartsLocal — части ДВИЖУЩЕЙСЯ детали в её локальной системе (0,0 — точка
// привязки), уже ОТРАЖЁННЫЕ (reflectPoly) — так требует формула NFP(A,B)=A⊕(-B).
export function nfpFromParts(sPartsAbs, mPartsLocalReflected) {
  const points = []
  const edgesBySubpair = []
  for (const s of sPartsAbs) for (const m of mPartsLocalReflected) {
    const mk = ensureCCW(minkowskiSumConvex(s, m))
    for (const p of mk) points.push(p)
    const edges = []
    for (let i=0;i<mk.length;i++) edges.push([mk[i], mk[(i+1)%mk.length]])
    edgesBySubpair.push(edges)
  }
  // пересечения РАЗНЫХ суб-NFP между собой — вершины истинной внешней
  // границы объединения, которых нет среди "родных" вершин ни одного куска
  for (let i=0;i<edgesBySubpair.length;i++){
    for (let j=i+1;j<edgesBySubpair.length;j++){
      for (const [a1,a2] of edgesBySubpair[i]) for (const [b1,b2] of edgesBySubpair[j]) {
        const p = segIntersectionPoint(a1,a2,b1,b2)
        if (p) points.push(p)
      }
    }
  }
  return { points, edges: edgesBySubpair.flat() }
}

export function nfpPairwiseIntersections(edgesA, edgesB) {
  const pts = []
  for (const [a1,a2] of edgesA) for (const [b1,b2] of edgesB) {
    const p = segIntersectionPoint(a1,a2,b1,b2)
    if (p) pts.push(p)
  }
  return pts
}

// Точки НА рёбрах NFP, лежащие на линии x=const или y=const (выравнивание
// по краю уже уложенного соседа/границе листа) — ловит кандидаты, которые
// не являются ни вершиной NFP, ни пересечением двух NFP, а лежат посередине
// одного ребра ровно на линии выравнивания.
export function edgesAgainstAlignmentLines(edges, xLines, yLines) {
  const pts = []
  for (const [p1, p2] of edges) {
    for (const x of xLines) {
      if ((p1[0]-x)*(p2[0]-x) <= 1e-9 && Math.abs(p2[0]-p1[0]) > 1e-9) {
        const t = (x - p1[0]) / (p2[0] - p1[0])
        if (t >= -1e-6 && t <= 1+1e-6) pts.push([x, p1[1] + t*(p2[1]-p1[1])])
      }
    }
    for (const y of yLines) {
      if ((p1[1]-y)*(p2[1]-y) <= 1e-9 && Math.abs(p2[1]-p1[1]) > 1e-9) {
        const t = (y - p1[1]) / (p2[1] - p1[1])
        if (t >= -1e-6 && t <= 1+1e-6) pts.push([p1[0] + t*(p2[0]-p1[0]), y])
      }
    }
  }
  return pts
}

export function polygonsOverlapExact(polyA, polyB) {
  for (let i=0;i<polyA.length;i++){
    const a1=polyA[i], a2=polyA[(i+1)%polyA.length]
    for (let j=0;j<polyB.length;j++){
      const b1=polyB[j], b2=polyB[(j+1)%polyB.length]
      if (segsIntersect(a1,a2,b1,b2)) return true
    }
  }
  return pointInPoly(polyA[0], polyB) || pointInPoly(polyB[0], polyA)
}

function centroid(poly) {
  let cx=0, cy=0
  poly.forEach(([x,y])=>{cx+=x;cy+=y})
  return [cx/poly.length, cy/poly.length]
}

// ВАЖНО: допуск — фиксированное расстояние в мм к центроиду, НЕ доля
// размера детали. Доля размера для крупной детали (750мм × 1% = 7.5мм)
// была БОЛЬШЕ самого kerf (4мм) и маскировала реальные микро-пересечения —
// поймано и исправлено при разработке этого модуля.
function erodeAbs(poly, epsMM) {
  const [cx, cy] = centroid(poly)
  return poly.map(([x, y]) => {
    const dx = cx - x, dy = cy - y, d = Math.hypot(dx, dy) || 1
    const t = Math.min(epsMM / d, 0.4)
    return [x + dx*t, y + dy*t]
  })
}
export function polygonsOverlapRobust(polyA, polyB, epsMM = 0.15) {
  return polygonsOverlapExact(erodeAbs(polyA, epsMM), erodeAbs(polyB, epsMM))
}

export function bboxOf(poly) {
  const xs = poly.map(p=>p[0]), ys = poly.map(p=>p[1])
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
}
export function translate(poly, dx, dy) { return poly.map(([x,y]) => [x+dx, y+dy]) }
