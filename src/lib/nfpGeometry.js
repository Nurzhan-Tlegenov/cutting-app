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


// Упрощение контура (Дуглас—Пекер) перед декомпозицией на выпуклые части.
// Дуги/скругления приходят сэмплированными в десятки почти коллинеарных
// точек — почти каждая такая точка формально «reflex» (даже на долю градуса)
// и decomposeConvex режет по НЕЙ отдельную диагональ. На детали 700×700 с
// одним скруглением это давало 54 вершины -> 51 треугольник вместо
// нескольких настоящих выпуклых кусков, а NFP считается попарно между
// частями ДВУХ деталей — 51×51 сумм Минковского на одно размещение, умноженное
// на число уже уложенных соседей и особей популяции. Это и вызывало зависание.
// eps подобран как компромисс: заметно меньше kerf/2 (не влияет на точность
// стыковки), но достаточно, чтобы схлопнуть тесселяцию дуг.
function simplifyForDecomp(poly, eps) {
  const n = poly.length
  if (n <= 6 || eps <= 0) return poly
  const distSeg = (p, a, b) => {
    const dx = b[0]-a[0], dy = b[1]-a[1], len2 = dx*dx+dy*dy
    if (len2 < 1e-12) return Math.hypot(p[0]-a[0], p[1]-a[1])
    let t = ((p[0]-a[0])*dx + (p[1]-a[1])*dy) / len2
    t = Math.max(0, Math.min(1, t))
    return Math.hypot(p[0]-(a[0]+t*dx), p[1]-(a[1]+t*dy))
  }
  const keep = new Uint8Array(n)
  let i0 = 0, i1 = 0
  for (let i = 1; i < n; i++) { if (poly[i][0] < poly[i0][0]) i0 = i; if (poly[i][0] > poly[i1][0]) i1 = i }
  if (i0 === i1) return poly
  keep[i0] = 1; keep[i1] = 1
  const rec = (s, e) => {
    let idx = -1, md = eps
    for (let k = (s + 1) % n; k !== e; k = (k + 1) % n) {
      const d = distSeg(poly[k], poly[s], poly[e])
      if (d > md) { md = d; idx = k }
    }
    if (idx >= 0) { keep[idx] = 1; rec(s, idx); rec(idx, e) }
  }
  rec(i0, i1); rec(i1, i0)
  const out = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(poly[i])
  return out.length >= 3 ? out : poly
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

function polyIsConvex(poly) {
  const n = poly.length
  let sign = 0
  for (let i = 0; i < n; i++) {
    const c = cross(poly[i], poly[(i + 1) % n], poly[(i + 2) % n])
    if (Math.abs(c) < 1e-7) continue
    const s = c > 0 ? 1 : -1
    if (sign === 0) sign = s
    else if (s !== sign) return false
  }
  return true
}

// Общее ребро a[i]->a[i+1] / b[j]->b[j+1] (одна и та же диагональ разреза,
// пройденная в разных направлениях в двух половинах декомпозиции).
function findSharedEdge(a, b) {
  for (let i = 0; i < a.length; i++) {
    const a1 = a[i], a2 = a[(i + 1) % a.length]
    for (let j = 0; j < b.length; j++) {
      const b1 = b[j], b2 = b[(j + 1) % b.length]
      if (Math.hypot(a1[0] - b2[0], a1[1] - b2[1]) < 1e-6 && Math.hypot(a2[0] - b1[0], a2[1] - b1[1]) < 1e-6) return [i, j]
    }
  }
  return null
}

function mergeAlongEdge(a, b, i, j) {
  const na = a.length, nb = b.length
  const merged = []
  let k = (i + 1) % na
  while (true) { merged.push(a[k]); if (k === i) break; k = (k + 1) % na }
  let m = (j + 2) % nb
  while (m !== j) { merged.push(b[m]); m = (m + 1) % nb }
  return merged
}

// "Разрезать по ближайшей диагонали" (decomposeConvex) режет мелко
// сэмплированные дуги на десятки вырожденных треугольников — это резко
// раздувает число кусков и, вместе с ним, стоимость NFP (растёт как
// произведение числа кусков двух деталей). Здесь эти куски СКЛЕИВАЮТСЯ
// обратно там, где их объединение остаётся выпуклым — то есть где разрез
// был технический (внутри плавной дуги), а не по-настоящему нужен (по
// вогнутому углу детали). На реальной детали 700×700 (700 точек контура)
// это сокращает число кусков с ~29 до нескольких, без потери точности:
// объединение выпукло ⇒ ни одна вершина не "спрятана" внутри.
function mergeConvexParts(parts) {
  let list = parts.slice()
  let merged = true
  while (merged) {
    merged = false
    outer:
    for (let i = 0; i < list.length; i++) {
      for (let j = 0; j < list.length; j++) {
        if (i === j) continue
        const edge = findSharedEdge(list[i], list[j])
        if (!edge) continue
        const cand = mergeAlongEdge(list[i], list[j], edge[0], edge[1])
        if (cand.length < 3 || !polyIsConvex(cand)) continue
        const next = list.filter((_, k) => k !== i && k !== j)
        next.push(cand)
        list = next
        merged = true
        break outer
      }
    }
  }
  return list
}

export function decomposeConvex(inputPoly, depth = 0, simplifyEps = 0) {
  const poly = depth === 0 ? simplifyForDecomp(ensureCCW(inputPoly), simplifyEps) : ensureCCW(inputPoly)
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
  const raw = [...decomposeConvex(partA, depth+1), ...decomposeConvex(partB, depth+1)]
  return depth === 0 ? mergeConvexParts(raw) : raw
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

// Плавная кривая (дуга/скругление), сэмплированная в полилинию, режется
// эвристикой decomposeConvex через БЛИЖАЙШУЮ по расстоянию диагональ — на
// мелко сэмплированной дуге ближайшая вершина почти всегда следующая по
// контуру точка, и вместо нескольких крупных выпуклых кусков получаются
// десятки вырожденных треугольников (реальный случай: 54 точки -> 51 кусок).
// Число попарных сумм Минковского при построении NFP растёт как произведение
// числа кусков двух деталей — с 51×51 это и давало зависание на десятки
// секунд/минуты. Настоящее решение — переписать саму эвристику декомпозиции
// (например, метод Хертель-Мельхорн вместо "ближайшая диагональ"), это
// отдельная задача. Пока — прагматичный шаг: если после дилатации на kerf/2
// кусков всё равно много, огрубляем контур чуть сильнее (в пределах доли
// halfKerf — контур не сдвигается больше этой доли, слипания деталей не
// возникает) и пробуем декомпозировать заново, пока не станет приемлемо
// быстро или запас на упрощение не кончится.
const NFP_MAX_PARTS = 14
export function dilatedConvexParts(rawPolyCCW, halfKerf) {
  const offset = halfKerf > 0 ? offsetPolygon(ensureCCW(rawPolyCCW), halfKerf) : rawPolyCCW
  if (halfKerf <= 0) return decomposeConvex(offset, 0, 0)
  const steps = [0.1, 0.2, 0.3, 0.4, 0.5]
  let parts = decomposeConvex(offset, 0, Math.min(0.5, halfKerf * steps[0]))
  for (let i = 1; i < steps.length && parts.length > NFP_MAX_PARTS; i++) {
    parts = decomposeConvex(offset, 0, Math.min(0.5, halfKerf * steps[i]))
  }
  return parts
}

// NFP из УЖЕ раздутых выпуклых частей (посчитаны один раз на форму+поворот,
// переиспользуются во всех попытках размещения — декомпозиция дорогая,
// делать её на каждый вызов нельзя).
// sPartsAbs — абсолютные (уже сдвинутые на место) части уже уложенной детали.
// mPartsLocal — части ДВИЖУЩЕЙСЯ детали в её локальной системе (0,0 — точка
// привязки), уже ОТРАЖЁННЫЕ (reflectPoly) — так требует формула NFP(A,B)=A⊕(-B).
function bboxFromPoints(pts) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const [x, y] of pts) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y }
  return { minX, maxX, minY, maxY }
}
function bboxesOverlap(a, b, eps = 1e-6) {
  return a.minX <= b.maxX + eps && b.minX <= a.maxX + eps && a.minY <= b.maxY + eps && b.minY <= a.maxY + eps
}

// Строго внутри выпуклого CCW-полигона (граница — НЕ внутри; нужна именно
// эта строгость, чтобы отличить "накрыт другим куском" от "лежит ровно на
// стыке двух кусков", который и есть настоящая граница объединения).
function pointStrictlyInsideConvex(pt, poly, eps) {
  const n = poly.length
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n]
    if ((b[0]-a[0])*(pt[1]-a[1]) - (b[1]-a[1])*(pt[0]-a[0]) < eps) return false
  }
  return true
}

// Параметр t∈(0,1) пересечения отрезка (p1,p2) с (p3,p4) на самом отрезке
// (p1,p2); null, если пересечения на обоих отрезках нет.
function segParamT(p1, p2, p3, p4) {
  const d1x = p2[0]-p1[0], d1y = p2[1]-p1[1], d2x = p4[0]-p3[0], d2y = p4[1]-p3[1]
  const denom = d1x*d2y - d1y*d2x
  if (Math.abs(denom) < 1e-12) return null
  const t = ((p3[0]-p1[0])*d2y - (p3[1]-p1[1])*d2x) / denom
  const u = ((p3[0]-p1[0])*d1y - (p3[1]-p1[1])*d1x) / denom
  if (t < -1e-9 || t > 1+1e-9 || u < -1e-9 || u > 1+1e-9) return null
  return Math.min(1, Math.max(0, t))
}

// Внешняя граница объединения нескольких выпуклых CCW-полигонов (может
// пересекаться/накладываться как угодно). Метод: режем каждое ребро в точках
// пересечения с ЛЮБЫМ другим ребром — получаем "арматуру" из мелких кусков
// рёбер; кусок ребра оставляем в границе, только если он НЕ накрыт ни одним
// ДРУГИМ полигоном (проверка — точка чуть в стороне от середины кусочка, по
// внешней нормали своего полигона, не лежит строго внутри другого куска).
// Оставшиеся кусочки соединяются в один замкнутый контур по общим концам.
// Заменяет прежний способ (собрать вообще все точки пересечения кусков как
// "кандидатов") — тот давал по 20000+ точек на деталь вместо десятков вершин
// настоящей границы, и именно это было причиной непрактичной медлительности
// на сложных контурах (комментарий было решено оставить как историю задачи).
export function unionBoundary(subPolys) {
  if (subPolys.length === 1) {
    const p = subPolys[0]
    return p.map((v, i) => [v, p[(i+1)%p.length]])
  }
  const bboxes = subPolys.map(bboxFromPoints)
  const rawEdges = [] // {a,b,owner}
  subPolys.forEach((poly, owner) => {
    for (let i = 0; i < poly.length; i++) rawEdges.push({ a: poly[i], b: poly[(i+1)%poly.length], owner })
  })
  // Bbox каждого ребра — один раз (было: пересчитывался на КАЖДОЙ паре рёбер,
  // O(edges²) лишних аллокаций; с ~1200 рёбрами на реальной детали это и
  // давало десятки-сотни мс на один вызов вместо ожидаемых единиц мс).
  const edgeBB = rawEdges.map(e => bboxFromPoints([e.a, e.b]))
  const segments = []
  for (let i = 0; i < rawEdges.length; i++) {
    const e = rawEdges[i], ebb = edgeBB[i]
    const ts = [0, 1]
    for (let j = 0; j < rawEdges.length; j++) {
      if (j === i) continue
      const f = rawEdges[j]
      if (!bboxesOverlap(ebb, edgeBB[j])) continue
      const t = segParamT(e.a, e.b, f.a, f.b)
      if (t !== null && t > 1e-7 && t < 1-1e-7) ts.push(t)
    }
    ts.sort((a,b)=>a-b)
    for (let k = 0; k < ts.length - 1; k++) {
      const t0 = ts[k], t1 = ts[k+1]
      if (t1 - t0 < 1e-7) continue
      const p0 = [e.a[0]+(e.b[0]-e.a[0])*t0, e.a[1]+(e.b[1]-e.a[1])*t0]
      const p1 = [e.a[0]+(e.b[0]-e.a[0])*t1, e.a[1]+(e.b[1]-e.a[1])*t1]
      segments.push({ p0, p1, owner: e.owner })
    }
  }
  const boundary = []
  for (const seg of segments) {
    const mid = [(seg.p0[0]+seg.p1[0])/2, (seg.p0[1]+seg.p1[1])/2]
    const dx = seg.p1[0]-seg.p0[0], dy = seg.p1[1]-seg.p0[1]
    const len = Math.hypot(dx,dy) || 1
    const nx = dy/len, ny = -dx/len // внешняя нормаль стороны CCW-полигона
    const eps = Math.max(len*0.01, 1e-3)
    const testPt = [mid[0]+nx*eps, mid[1]+ny*eps]
    let covered = false
    for (let k = 0; k < subPolys.length; k++) {
      if (k === seg.owner) continue
      const bk = bboxes[k]
      if (testPt[0] < bk.minX || testPt[0] > bk.maxX || testPt[1] < bk.minY || testPt[1] > bk.maxY) continue
      if (pointStrictlyInsideConvex(testPt, subPolys[k], 1e-7)) { covered = true; break }
    }
    if (!covered) boundary.push([seg.p0, seg.p1])
  }
  return boundary
}

// Сшивает несвязный список отрезков границы в замкнутые контуры по общим
// концам (совпадение координат с допуском). Возвращает контуры от большего
// к меньшему по площади — для NFP нужен только внешний (первый), но на
// случай вырожденных данных отдаём все.
export function chainSegments(segs) {
  const key = ([x,y]) => Math.round(x*100)+','+Math.round(y*100)
  const byStart = new Map()
  segs.forEach((s, i) => { const k = key(s[0]); (byStart.get(k) || byStart.set(k, []).get(k)).push(i) })
  const used = new Array(segs.length).fill(false)
  const loops = []
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue
    const loop = [segs[i][0]]
    let cur = i, guard = 0
    while (guard++ < segs.length + 5) {
      used[cur] = true
      loop.push(segs[cur][1])
      const nextK = key(segs[cur][1])
      const cands = (byStart.get(nextK) || []).filter(j => !used[j])
      if (!cands.length) break
      cur = cands[0]
      if (cur === i) break
    }
    if (loop.length >= 4) loops.push(loop.slice(0, -1))
  }
  const area = pts => { let a=0; for (let i=0;i<pts.length;i++){const q=pts[(i+1)%pts.length]; a+=pts[i][0]*q[1]-q[0]*pts[i][1]} return Math.abs(a)/2 }
  loops.sort((a,b)=>area(b)-area(a))
  return loops
}

export function nfpFromParts(sPartsAbs, mPartsLocalReflected) {
  const subPolys = []
  for (const s of sPartsAbs) for (const m of mPartsLocalReflected) subPolys.push(ensureCCW(minkowskiSumConvex(s, m)))
  const boundarySegs = unionBoundary(subPolys)
  const loops = chainSegments(boundarySegs)
  const outer = loops[0] || subPolys[0] || []
  const edges = []
  for (let i = 0; i < outer.length; i++) edges.push([outer[i], outer[(i+1)%outer.length]])
  return { points: outer, edges }
}

export function nfpPairwiseIntersections(edgesA, edgesB) {
  const pts = []
  const bb = bboxFromPoints(edgesA.flat())
  const bb2 = bboxFromPoints(edgesB.flat())
  if (!bboxesOverlap(bb, bb2)) return pts
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
  // Дешёвая отбраковка по габаритам ДО точного (дорогого) теста пересечения:
  // при десятках выпуклых кусков на деталь большинство пар заведомо далеко
  // друг от друга (см. комментарий в nfpFromParts — тот же эффект).
  let aMinX=Infinity,aMaxX=-Infinity,aMinY=Infinity,aMaxY=-Infinity
  for (const [x,y] of polyA) { if(x<aMinX)aMinX=x; if(x>aMaxX)aMaxX=x; if(y<aMinY)aMinY=y; if(y>aMaxY)aMaxY=y }
  let bMinX=Infinity,bMaxX=-Infinity,bMinY=Infinity,bMaxY=-Infinity
  for (const [x,y] of polyB) { if(x<bMinX)bMinX=x; if(x>bMaxX)bMaxX=x; if(y<bMinY)bMinY=y; if(y>bMaxY)bMaxY=y }
  if (aMinX > bMaxX + epsMM || bMinX > aMaxX + epsMM || aMinY > bMaxY + epsMM || bMinY > aMaxY + epsMM) return false
  return polygonsOverlapExact(erodeAbs(polyA, epsMM), erodeAbs(polyB, epsMM))
}

export function bboxOf(poly) {
  const xs = poly.map(p=>p[0]), ys = poly.map(p=>p[1])
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
}
export function translate(poly, dx, dy) { return poly.map(([x,y]) => [x+dx, y+dy]) }
