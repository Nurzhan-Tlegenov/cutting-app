// Объёмная фрезеровка фасада для 3D: по профилю фрезы и траектории (из Базиса)
// строим рельеф лицевой пласти. Пласть — сетка, глубина в каждой точке — самая
// глубокая из обработок (выемка, V-паз, скругление кромки…).
// Координаты редактора: X — ширина (0..W), Y — длина (0..L), мм.

const EPS = 0.05

function inPoly(pt, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j]
    if ((a[1] > pt[1]) !== (b[1] > pt[1]) && pt[0] < (b[0] - a[0]) * (pt[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside
  }
  return inside
}

/** Глубина профиля фрезы на смещении u от траектории (profile — замкнутая ломаная [u, глубина]) */
export function profileDepth(profile, u) {
  let best = 0
  const n = profile.length
  for (let i = 0; i < n; i++) {
    const p = profile[i], q = profile[(i + 1) % n]
    if ((p[0] - u) * (q[0] - u) > 0) continue
    if (Math.abs(p[0] - q[0]) < 1e-9) { if (Math.abs(p[0] - u) < 1e-6) best = Math.max(best, p[1], q[1]); continue }
    best = Math.max(best, p[1] + (q[1] - p[1]) * (u - p[0]) / (q[0] - p[0]))
  }
  return best
}

// Обработки детали, которые можно показать объёмно
function carveItems(decor) {
  return (decor || []).filter(d => (d.kind === 'pocket' ? d.polys?.length && d.depth > 0 : d.profile?.length > 2 && d.path?.length > 1))
}

/**
 * Рельеф пласти. -> null, если показывать нечего, иначе
 * { xs, ys, depth (ys.length × xs.length, по строкам), maxD, face: 'front' | 'back' }
 */
export function buildRelief(decor, W, L, T) {
  const all = carveItems(decor)
  if (!all.length) return null
  // рельеф строим на той пласти, где обработки больше
  const nFront = all.filter(d => d.face !== 'back').length
  const face = nFront >= all.length - nFront ? 'front' : 'back'
  const items = all.filter(d => (d.face !== 'back') === (face === 'front'))

  const xs = [0, W], ys = [0, L]
  let aligned = true
  const fns = []
  for (const d of items) {
    if (d.kind === 'pocket') {
      for (const poly of d.polys) {
        poly.forEach((p, i) => {
          const q = poly[(i + 1) % poly.length]
          if (Math.abs(p[0] - q[0]) > EPS && Math.abs(p[1] - q[1]) > EPS) aligned = false
          xs.push(p[0]); ys.push(p[1])
        })
        fns.push(pt => (inPoly(pt, poly) ? d.depth : 0))
      }
      continue
    }
    const us = [...new Set(d.profile.map(p => p[0]))]
    const uMin = Math.min(...us), uMax = Math.max(...us)
    const segs = []
    const n = d.path.length
    for (let i = 0; i < (d.closed ? n : n - 1); i++) {
      const a = d.path[i], b = d.path[(i + 1) % n]
      const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy)
      if (len < 0.01) continue
      const nx = -dy / len, ny = dx / len                       // левая нормаль
      segs.push({ a, dx, dy, len2: len * len, nx, ny })
      if (Math.abs(dx) < EPS) { us.forEach(u => xs.push(a[0] + nx * u)); ys.push(a[1], b[1]) }
      else if (Math.abs(dy) < EPS) { us.forEach(u => ys.push(a[1] + ny * u)); xs.push(a[0], b[0]) }
      else aligned = false
    }
    fns.push(pt => {
      let best = 0
      for (const s of segs) {
        const px = pt[0] - s.a[0], py = pt[1] - s.a[1]
        let t = (px * s.dx + py * s.dy) / s.len2
        const clamped = t < 0 || t > 1
        if (clamped && !d.closed) continue
        t = Math.max(0, Math.min(1, t))
        const cx = px - s.dx * t, cy = py - s.dy * t
        const dist = Math.hypot(cx, cy)
        const u = (s.dx * py - s.dy * px) >= 0 ? dist : -dist   // слева от хода — плюс
        if (u < uMin - 1e-6 || u > uMax + 1e-6) continue
        best = Math.max(best, profileDepth(d.profile, u))
      }
      return best
    })
  }

  const uniq = (arr, max) => {
    const s = arr.map(v => Math.max(0, Math.min(max, v))).sort((a, b) => a - b)
    return s.filter((v, i) => i === 0 || v - s[i - 1] > EPS)
  }
  let gx, gy
  if (aligned) {
    gx = uniq(xs, W); gy = uniq(ys, L)
    // длинные пустые участки не дробим, но слишком густую сетку прореживать не нужно — она точная
    if (gx.length * gy.length > 40000) aligned = false
  }
  if (!aligned) {
    const step = Math.max(2.5, Math.min(8, Math.max(W, L) / 110))
    gx = uniq(Array.from({ length: Math.ceil(W / step) + 1 }, (_, i) => i * step).concat([W]), W)
    gy = uniq(Array.from({ length: Math.ceil(L / step) + 1 }, (_, i) => i * step).concat([L]), L)
  }
  const cap = Math.max(0.5, T - 0.8)                              // не прорезать насквозь
  const depth = new Float32Array(gx.length * gy.length)
  let maxD = 0
  for (let j = 0; j < gy.length; j++) {
    for (let i = 0; i < gx.length; i++) {
      let dd = 0
      const pt = [gx[i], gy[j]]
      for (const f of fns) dd = Math.max(dd, f(pt))
      dd = Math.min(cap, dd)
      depth[j * gx.length + i] = dd
      if (dd > maxD) maxD = dd
    }
  }
  if (maxD < 0.05) return null
  return { xs: gx, ys: gy, depth, maxD, face }
}

/** Типы фрез из импортированных деталей — для каталога в профиле пользователя */
export function millsFromItems(items) {
  const map = new Map()
  for (const it of items || []) {
    let c = it.contour
    if (typeof c === 'string') { try { c = JSON.parse(c) } catch { c = null } }
    for (const d of c?.decor || []) {
      const key = `${d.kind}|${d.name}|${d.sign}`
      if (map.has(key)) continue
      const us = (d.profile || []).map(p => p[0])
      map.set(key, {
        key, kind: d.kind, name: d.name || '', sign: d.sign || '', depth: d.depth,
        width: us.length ? Math.round((Math.max(...us) - Math.min(...us)) * 10) / 10 : null,
        profile: d.profile || null,
      })
    }
  }
  return [...map.values()]
}
export function mergeMills(existing, add) {
  const map = new Map((existing || []).map(m => [m.key, m]))
  for (const m of add || []) map.set(m.key, { ...map.get(m.key), ...m })
  return [...map.values()]
}
