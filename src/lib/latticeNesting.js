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
function sepX(P, Q, dy, g, step = 1, none = 0) {
  const ys = [...P.map(p => p[1]), ...Q.map(p => p[1] + dy)]
  const y0 = Math.min(...ys) - g, y1 = Math.max(...ys) + g
  const n = Math.ceil((y1 - y0) / step) + 1
  // полосы перекрываются (шаг выборки): острые углы между строками выборки не теряются
  const a = extents(P, y0, n, step, g + step)
  const b = extents(Q.map(([x, y]) => [x, y + dy]), y0, n, step, step)
  let d = -Infinity
  for (let i = 0; i < n; i++) if (a.R[i] > -Infinity && b.L[i] < Infinity) d = Math.max(d, a.R[i] - b.L[i] + g)
  return d === -Infinity ? none : d
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
const rowW = row => Math.max(...row.map(c => c.x + c.v.bw))
const rowH = row => Math.max(...row.map(c => c.v.bh))

// Профиль ряда по вертикальным столбцам x = x0 + i·s: top[i] / bot[i] — верх / низ деталей ряда в полосе [x−band, x+band]
function rowProfile(row, x0, n, s, band) {
  const top = new Float64Array(n).fill(-Infinity), bot = new Float64Array(n).fill(Infinity)
  for (const c of row) {
    // extents считает по горизонтальным полосам — отражаем деталь (x ↔ y)
    const { R, L } = extents(c.v.poly.map(([x, y]) => [y, x + c.x]), x0, n, s, band)
    for (let k = 0; k < n; k++) {
      if (R[k] > top[k]) top[k] = R[k]
      if (L[k] < bot[k]) bot[k] = L[k]
    }
  }
  // где в ряду есть деталь — дальше сравнивать незачем
  let i0 = 0, i1 = n
  while (i0 < n && top[i0] === -Infinity) i0++
  while (i1 > i0 && top[i1 - 1] === -Infinity) i1--
  return { top, bot, i0, i1 }
}
// на сколько поднять ряд B (сдвинут на k столбцов вправо) над рядом A: max(верх A − низ B) + g. Может быть и меньше
// нуля: гребёнка зубьями вниз над гребёнкой зубьями вверх — её габарит начинается ниже, а сама она в каждом столбце
// выше (261119_037). −Infinity — ряды нигде не встречаются.
function sepProf(A, B, k, g, cap = Infinity) {
  let d = -Infinity
  const c = cap - g
  for (let i = Math.max(A.i0, B.i0 + k), e = Math.min(A.i1, B.i1 + k); i < e; i++) {
    const v = A.top[i] - B.bot[i - k]
    if (v > d) { d = v; if (d > c) return Infinity }
  }
  return d === -Infinity ? d : d + g
}

// ряды A, B, A, B… друг над другом (S[i][k] — на сколько ряд вида k выше ряда вида i), каждый — вплотную ко всем
// уже уложенным; → { cells, span }
function stackRows(T, S, UY, g) {
  const ys = []
  let lo = 0, hi = 0
  for (let k = 0; k < 500; k++) {
    const t = k % 2
    let y = 0
    if (k) {
      y = -Infinity
      for (let j = Math.max(0, k - 6); j < k; j++) y = Math.max(y, ys[j] + S[j % 2][t])
      if (y === -Infinity) y = ys[k - 1] + T[(k - 1) % 2].h + g
      // ряд того же вида должен уйти выше предыдущего такого же — иначе схема не складывается
      if (k >= 2 && !(y > ys[k - 2] + 1e-6)) break
    }
    const nlo = Math.min(lo, y), nhi = Math.max(hi, y + T[t].h)
    if (nhi - nlo > UY + 1e-6) break
    ys.push(y); lo = nlo; hi = nhi
  }
  const cells = ys.flatMap((y, k) => T[k % 2].row.map(c => ({ v: c.v, x: c.x + T[k % 2].dx, y: y - lo })))
  return { cells, span: hi - lo }
}

// верх ряда — по полосе bandTop (с пропилом), низ — по bandBot; одни и те же ряды встречаются в нескольких схемах
const profCache = new WeakMap()
function prof(row, x0, n, s, bandTop, bandBot) {
  let m = profCache.get(row)
  if (!m) profCache.set(row, m = new Map())
  const key = [x0, n, s, bandTop, bandBot].join('|')
  if (!m.has(key)) {
    const T = rowProfile(row, x0, n, s, bandTop), B = bandBot === bandTop ? T : rowProfile(row, x0, n, s, bandBot)
    m.set(key, { top: T.top, bot: B.bot, i0: Math.min(T.i0, B.i0), i1: Math.max(T.i1, B.i1) })
  }
  return m.get(key)
}

// Ряд B над рядом A, со сдвигом соседних рядов по X (в пределах свободного места в ряду): так зубья гребёнок
// входят в пазы соседней (261119_037, «Стеллажи»: 1800×700, зубья 50 через 65 — сцепляются только со сдвигом
// ~197 мм, окно — пара миллиметров). Сначала грубо (столбцы и сдвиг через 1 мм, без запаса — окно не теряется),
// потом лучшие сдвиги — точно (столбцы через 0,25 мм, с запасом, как у пропила).
function shiftedPairs(A, B, UX, UY, g) {
  const pitch = row => row.length > 1 ? row[1].x : Infinity
  const tMax = Math.min(UX - rowW(B), pitch(B)), tMin = -Math.min(UX - rowW(A), pitch(A))
  const out = []
  const FS = 0.25, FB = g + FS
  const fine = (() => {
    const x0 = -FB - 1, n = Math.ceil((UX + 2 * FB + 2) / FS) + 1
    return { A: prof(A, x0, n, FS, FB, FS), B: prof(B, x0, n, FS, FB, FS) }
  })()
  // ряд со сдвигом t: при t ≥ 0 вправо уходит B, при t < 0 — A
  const evalT = t => {
    const ax = Math.max(0, -t), bx = Math.max(0, t)
    const ka = Math.round(ax / FS), kb = Math.round(bx / FS)
    const sAB = sepProf(fine.A, fine.B, kb - ka, g), sBA = sepProf(fine.B, fine.A, ka - kb, g)
    const S = [[fine.SAA, sAB], [sBA, fine.SBB]]
    return stackRows([{ row: A, dx: ka * FS, h: rowH(A) }, { row: B, dx: kb * FS, h: rowH(B) }], S, UY, g)
  }
  fine.SAA = sepProf(fine.A, fine.A, 0, g)
  fine.SBB = sepProf(fine.B, fine.B, 0, g)
  out.push(evalT(0))
  if (!(tMax - tMin > 1)) return out
  // грубо: столбцы через 1 мм, полоса пропила без запаса
  const x0 = -g - 2, n = Math.ceil(UX + 2 * g + 4) + 1
  const cA = prof(A, x0, n, 1, g, 0), cB = prof(B, x0, n, 1, g, 0)
  // шаг ряда (ряд A → B → A) при каждом сдвиге; заведомо худшие 8 лучших не досчитываются
  const cand = [], top8 = []
  for (let t = Math.ceil(tMin); t <= Math.floor(tMax); t++) {
    if (!t) continue
    const cap = top8.length < 8 ? Infinity : top8[7]
    const s1 = sepProf(cA, cB, t, g, cap)
    if (!Number.isFinite(s1)) continue
    const p = s1 + sepProf(cB, cA, -t, g, cap - s1)
    if (!Number.isFinite(p)) continue
    cand.push({ t, p })
    top8.push(p); top8.sort((a, b) => a - b); if (top8.length > 8) top8.pop()
  }
  cand.sort((a, b) => a.p - b.p)
  const picked = []
  for (const c of cand) {
    if (picked.length >= 4) break
    if (picked.some(q => Math.abs(q - c.t) < 3)) continue
    picked.push(c.t)
  }
  // точно: вокруг каждого кандидата ±1 мм через 0,25
  for (const t0 of picked) for (let k = -4; k <= 4; k++) {
    const t = Math.min(tMax, Math.max(tMin, t0 + k * FS))
    if (Math.abs(t) < 1e-9) continue
    out.push(evalT(t))
  }
  return out
}

// раскладка одного листа UX×UY: перебор схем → лучшая [{ v, x, y }]
function bestSheet(V, UX, UY, g) {
  const bases = [V[0], V[90]].filter(Boolean)
  let best = null
  const take = r => {
    if (!best || r.cells.length > best.cells.length || (r.cells.length === best.cells.length && r.span < best.span - 1e-6)) best = r
  }
  for (const a of bases) {
    const b = a.angle === 0 ? V[180] : V[270]
    for (const seq of [[a], [a, b], [b, a]]) {
      if (!seq.every(Boolean)) continue
      const r1 = rowOf(seq, UX, g)
      const r2 = seq.length > 1 ? rowOf([seq[1], seq[0]], UX, g) : r1
      for (const alt of seq.length > 1 ? [false, true] : [false]) shiftedPairs(r1, alt ? r2 : r1, UX, UY, g).forEach(take)
    }
  }
  return best ? best.cells : []
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
