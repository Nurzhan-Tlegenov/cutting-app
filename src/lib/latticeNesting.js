// Решётка для одинаковых фигурных деталей (фрезер, укладка по контуру).
//
// Много одинаковых трапеций / стрелок / Г-деталей укладываются плотнее всего закономерно: в ряд «ёлочкой»
// (0° и 180° попеременно — косые стороны соседей друг к другу), ряды — друг на друга, каждый следующий ряд
// придвинут к предыдущему вплотную по контуру. Общий поиск (растр, точная укладка по раундам) такую сцепку
// на всём листе находит не всегда: 26102913 — 16 трапеций 1036,5×550 на листе 2750×1830 легли по габаритам,
// 7 на лист, 3 листа; ёлочкой входит 9 на лист — 2 листа.
//
// Здесь перебираются: поворот (0° / 90°, если текстура позволяет), сосед в ряду — такой же или повёрнутый на 180°,
// следующий ряд — тот же или начинающийся со второго, ряды вдоль листа или поперёк. Зазор между контурами — не
// меньше пропила (считается с запасом: по полосе высотой в пропил). Берётся вариант, где на лист входит больше;
// результат сравнивается с общим поиском — остаётся лучший (liveNesting.js).
import { parsePolygonFromDetail } from './trueShapeNesting'

const rot90 = (poly, w) => poly.map(([x, y]) => [y, w - x])

// варианты поворота — как у укладки по контуру (trueShapeNesting.buildPieceKind): 0° и 180° всегда, 90° и 270° — если можно
function variantsOf(detail) {
  const { polygon, w, h, custom } = parsePolygonFromDetail(detail)
  if (!custom || polygon.length < 3) return null
  const p90 = rot90(polygon, w), p180 = rot90(p90, h)
  const out = { 0: { angle: 0, poly: polygon, bw: w, bh: h }, 180: { angle: 180, poly: p180, bw: w, bh: h } }
  if (detail.rotatable) {
    out[90] = { angle: 90, poly: p90, bw: h, bh: w }
    out[270] = { angle: 270, poly: rot90(p180, w), bw: h, bh: w }
  }
  return out
}

// Крайние X контура по горизонтальным полосам: R[i] / L[i] — правый / левый край в полосе [y−g, y+g], y = y0 + i·step
function extents(poly, y0, n, step, g) {
  const R = new Float64Array(n).fill(-Infinity), L = new Float64Array(n).fill(Infinity)
  for (let k = 0; k < poly.length; k++) {
    const [ax, ay] = poly[k], [bx, by] = poly[(k + 1) % poly.length]
    const lo = Math.min(ay, by), hi = Math.max(ay, by)
    const i0 = Math.max(0, Math.ceil((lo - g - y0) / step)), i1 = Math.min(n - 1, Math.floor((hi + g - y0) / step))
    for (let i = i0; i <= i1; i++) {
      const y = y0 + i * step
      const a = Math.max(lo, y - g), b = Math.min(hi, y + g)
      if (a > b) continue
      let xa, xb
      if (hi - lo < 1e-9) { xa = ax; xb = bx } else {
        xa = ax + (bx - ax) * ((a - ay) / (by - ay)); xb = ax + (bx - ax) * ((b - ay) / (by - ay))
      }
      const mx = Math.max(xa, xb), mn = Math.min(xa, xb)
      if (mx > R[i]) R[i] = mx
      if (mn < L[i]) L[i] = mn
    }
  }
  return { R, L }
}
// на сколько сдвинуть Q вправо от P (оба со своим началом в 0), чтобы между ними был зазор g; dy — сдвиг Q вверх
function sepX(P, Q, dy, g, step = 1) {
  const ys = [...P.map(p => p[1]), ...Q.map(p => p[1] + dy)]
  const y0 = Math.min(...ys) - g, y1 = Math.max(...ys) + g
  const n = Math.ceil((y1 - y0) / step) + 1
  // полосы перекрываются (шаг выборки): острые углы между строками выборки не теряются
  const a = extents(P, y0, n, step, g + step)
  const b = extents(Q.map(([x, y]) => [x, y + dy]), y0, n, step, step)
  let d = -Infinity
  for (let i = 0; i < n; i++) if (a.R[i] > -Infinity && b.L[i] < Infinity) d = Math.max(d, a.R[i] - b.L[i] + g)
  return d === -Infinity ? 0 : d
}
const swap = P => P.map(([x, y]) => [y, x])

// ряд вдоль X: последовательность вариантов seq (повторяется), сколько входит в ширину UX; → [{ v, x }]
function rowOf(seq, UX, g) {
  const out = [{ v: seq[0], x: 0 }]
  const memo = new Map()
  const sep = (a, b) => { const key = a.angle + '|' + b.angle; if (!memo.has(key)) memo.set(key, Math.max(0, sepX(a.poly, b.poly, 0, g))); return memo.get(key) }
  for (let i = 1; ; i++) {
    const b = seq[i % seq.length]
    // не только к соседу: острая деталь может дотянуться и до детали через одну
    let x = 0
    for (let j = Math.max(0, i - 4); j < i; j++) x = Math.max(x, out[j].x + sep(out[j].v, b))
    if (x + b.bw > UX + 1e-6) break
    out.push({ v: b, x })
    if (out.length > 400) break
  }
  return out
}
// на сколько поднять ряд B над рядом A: зазор g между любыми их деталями (по вертикальным полосам)
function sepRows(A, B, g) {
  let d = 0
  for (const a of A) for (const b of B) {
    // только соседи по X (иначе далеко и не мешают)
    if (b.x > a.x + a.v.bw + g || a.x > b.x + b.v.bw + g) continue
    const P = swap(a.v.poly.map(([x, y]) => [x + a.x, y])), Q = swap(b.v.poly.map(([x, y]) => [x + b.x, y]))
    d = Math.max(d, sepX(P, Q, 0, g))
  }
  return d
}

// раскладка одного листа UX×UY: перебор схем → лучшая [{ v, x, y }]
function bestSheet(V, UX, UY, g) {
  const bases = [V[0], V[90]].filter(Boolean)
  let best = null
  for (const a of bases) {
    const b = a.angle === 0 ? V[180] : V[270]
    for (const seq of [[a], [a, b], [b, a]]) {
      if (!seq.every(Boolean)) continue
      const r1 = rowOf(seq, UX, g)
      const r2 = seq.length > 1 ? rowOf([seq[1], seq[0]], UX, g) : r1
      for (const alt of seq.length > 1 ? [false, true] : [false]) {
        const rows = []
        let y = 0, prev = null
        for (let k = 0; k < 500; k++) {
          const row = alt && k % 2 ? r2 : r1
          if (prev) y += sepRows(prev.row, row, g)
          const top = y + Math.max(...row.map(c => c.v.bh))
          if (top > UY + 1e-6) break
          rows.push({ row, y }); prev = { row }
        }
        const cells = rows.flatMap(({ row, y: ry }) => row.map(c => ({ v: c.v, x: c.x, y: ry })))
        if (!best || cells.length > best.length) best = cells
      }
    }
  }
  return best || []
}

/**
 * Применимо: фрезер по контуру, в заказе один вид фигурной детали (≥ 3 шт.) и больше ничего.
 * → результат как у runNesting ({ sheets, usableX, usableY, … }) или null
 */
export function latticeNesting(params) {
  if ((params.cuttingMethod || 'nesting') === 'guillotine' || params.byBox || params.beamSaw) return null
  const ds = (params.details || []).map((d, i) => ({ d, i })).filter(x => (Number(x.d.qty) || 0) > 0)
  if (ds.length !== 1) return null
  const { d, i: di } = ds[0]
  const qty = Number(d.qty) || 0
  if (qty < 3 || qty > 5000) return null
  const V = variantsOf(d)
  if (!V) return null
  const g = Number(params.kerf) || 0
  const UX = params.sheetW - params.marginL - params.marginR, UY = params.sheetL - params.marginT - params.marginB
  if (!(UX > 0 && UY > 0)) return null
  // ряды вдоль X или вдоль Y (во втором случае задача решается для отражённых деталей на повёрнутом листе, а
  // ответ отражается обратно — детали остаются в своём настоящем виде, отражение не нужно)
  const mirror = v => ({ ...v, poly: swap(v.poly), bw: v.bh, bh: v.bw })
  const across = bestSheet(V, UX, UY, g)
  const VT = Object.fromEntries(Object.entries(V).map(([k, v]) => [k, mirror(v)]))
  const along = bestSheet(VT, UY, UX, g).map(c => ({ v: V[c.v.angle], x: c.y, y: c.x }))
  const cells = along.length > across.length ? along : across
  if (cells.length < 2) return null
  // что сначала: снизу вверх, слева направо — последний лист заполняется от угла, остаток одним куском
  cells.sort((a, b) => a.y - b.y || a.x - b.x)
  const per = cells.length
  const sheets = []
  for (let left = qty; left > 0; left -= per) {
    const n = Math.min(per, left)
    sheets.push({ freeRects: [], placed: cells.slice(0, n).map(c => ({
      detailIndex: di, label: d.display_name || d.name, prefix: d.prefix,
      x: c.x, y: c.y, w: c.v.bw + g, h: c.v.bh + g, origX: c.v.bw, origY: c.v.bh,
      rotated: c.v.angle === 90 || c.v.angle === 270, rotation: c.v.angle, rotatable: !!d.rotatable, isSmall: false,
      polygon: c.v.poly.map(([x, y]) => ({ x, y })),
    })) })
  }
  return { sheets, usableX: UX, usableY: UY, sheetL: params.sheetL, sheetW: params.sheetW,
    marginT: params.marginT, marginR: params.marginR, marginB: params.marginB, marginL: params.marginL, kerf: params.kerf, lattice: true, perSheet: per }
}
