// Раскладка листа для экрана ожидания: случайный раскрой гильотиной, порядок реза — от края к центру.
export const W = 200, H = 132, PAD = 6, GAP = 2.2
export const SHEET = { W, H }
// случайный раскрой листа на прямоугольники (гильотиной)
export function makeLayout(seed) {
  let s = seed >>> 0
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }
  const out = []
  const split = (x, y, w, h, depth) => {
    const big = w > 62 || h > 46
    if (depth < 5 && big && (depth < 2 || rnd() < 0.8)) {
      const k = 0.34 + rnd() * 0.32
      if (w / h > 1.25 || (w / h > 0.8 && rnd() < 0.5)) { split(x, y, w * k, h, depth + 1); split(x + w * k, y, w * (1 - k), h, depth + 1) }
      else { split(x, y, w, h * k, depth + 1); split(x, y + h * k, w, h * (1 - k), depth + 1) }
      return
    }
    out.push({ x: x + GAP / 2, y: y + GAP / 2, w: w - GAP, h: h - GAP })
  }
  split(PAD, PAD, W - PAD * 2, H - PAD * 2, 0)
  // порядок реза: сначала детали у края листа, по кругу, центральная — последней
  const cx = W / 2, cy = H / 2
  const edge = r => Math.min(r.x - PAD, r.y - PAD, W - PAD - r.x - r.w, H - PAD - r.y - r.h)
  const ang = r => Math.atan2(r.y + r.h / 2 - cy, r.x + r.w / 2 - cx)
  out.forEach(r => { r.ring = Math.round(edge(r) / 14); r.per = 2 * (r.w + r.h) })
  out.sort((a, b) => a.ring - b.ring || ang(a) - ang(b))
  // рез начинается с угла, обращённого к центру листа
  out.forEach(r => {
    const corners = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]]
    let st = 0, bd = Infinity
    corners.forEach(([px, py], i) => { const d = Math.hypot(px - cx, py - cy); if (d < bd) { bd = d; st = i } })
    r.pts = [...corners.slice(st), ...corners.slice(0, st)]
  })
  return out
}
export const pathOf = r => `M${r.pts.map(p => p.map(v => v.toFixed(1)).join(' ')).join(' L')} Z`
export function pointAt(r, d) {
  let left = Math.max(0, Math.min(r.per, d))
  for (let i = 0; i < 4; i++) {
    const a = r.pts[i], b = r.pts[(i + 1) % 4], l = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (left <= l || i === 3) { const t = l ? Math.min(1, left / l) : 0; return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] }
    left -= l
  }
  return r.pts[0]
}

