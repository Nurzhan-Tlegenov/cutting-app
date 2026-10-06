// Разбор G-кода для симулятора: G0/G1 (прямые), G2/G3 (дуги через I, J), смена инструмента (T…), S, F.
// Z = 0 — стол. Строки с G53 (машинные координаты) считаются подъёмом на безопасную высоту.
// -> { moves: [{ x0,y0,z0, x1,y1,z1, rapid, tool, feed, line, t0, t1 }], time (сек), box, lines, tools: [T…] }

const word = (s, ch) => { const m = s.match(new RegExp(ch + '\\s*(-?\\d*\\.?\\d+)', 'i')); return m ? Number(m[1]) : null }

// zShift — если ноль Z в программе на верхней пласти листа: толщина материала (симулятор считает от стола)
export function parseGcode(text, { rapid = 20000, zShift = 0 } = {}) {
  const lines = String(text || '').split(/\r?\n/)
  const moves = []
  let x = 0, y = 0, z = null, zTop = 0, mode = 0, feed = 1000, tool = 0, t = 0
  const tools = []
  const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, zMin: Infinity, zMax: -Infinity }
  const push = (nx, ny, nz, rap, li) => {
    const len = Math.hypot(nx - x, ny - y, nz - (z ?? nz))
    if (len < 1e-9) { x = nx; y = ny; z = nz; return }
    const dt = len / Math.max(1, rap ? rapid : feed) * 60
    moves.push({ x0: x, y0: y, z0: z ?? nz, x1: nx, y1: ny, z1: nz, rapid: rap, tool, feed: rap ? rapid : feed, line: li, t0: t, t1: t + dt })
    t += dt; x = nx; y = ny; z = nz
    if (nx < box.x0) box.x0 = nx; if (nx > box.x1) box.x1 = nx; if (ny < box.y0) box.y0 = ny; if (ny > box.y1) box.y1 = ny
    if (nz < box.zMin) box.zMin = nz; if (nz > box.zMax) box.zMax = nz
  }
  lines.forEach((raw, li) => {
    const s = raw.replace(/\(.*?\)/g, '').replace(/;.*$/, '').trim().toUpperCase()
    if (!s) return
    const tw = word(s, 'T')
    if (tw != null && /M0?6\b|^T/.test(s)) { tool = tw; if (!tools.includes(tw)) tools.push(tw) }
    const fw = word(s, 'F'); if (fw != null) feed = fw
    const gs = [...s.matchAll(/G\s*(\d+(?:\.\d+)?)/g)].map(m => Number(m[1]))
    if (gs.includes(53)) { if (/Z/.test(s) && z != null) push(x, y, Math.max(zTop, z), true, li); return }
    for (const g of gs) if (g >= 0 && g <= 3) mode = g
    const nx = word(s, 'X'), ny = word(s, 'Y'), zw = word(s, 'Z'), nz = zw == null ? null : zw + zShift
    if (nx == null && ny == null && nz == null) return
    if (!gs.length && !/^[XYZ]/.test(s)) return
    const tx = nx ?? x, ty = ny ?? y, tz = nz ?? z ?? 0
    if (tz > zTop) zTop = tz
    if (mode === 2 || mode === 3) {
      const i = word(s, 'I') ?? 0, j = word(s, 'J') ?? 0
      const cx = x + i, cy = y + j, r = Math.hypot(i, j)
      let a0 = Math.atan2(y - cy, x - cx), a1 = Math.atan2(ty - cy, tx - cx)
      if (mode === 2) { if (a1 >= a0 - 1e-9) a1 -= 2 * Math.PI } else if (a1 <= a0 + 1e-9) a1 += 2 * Math.PI
      const n = Math.max(4, Math.ceil(Math.abs(a1 - a0) * r / 2)), zs = z ?? tz
      for (let k = 1; k <= n; k++) {
        const a = a0 + (a1 - a0) * k / n
        push(k === n ? tx : cx + r * Math.cos(a), k === n ? ty : cy + r * Math.sin(a), zs + (tz - zs) * k / n, false, li)
      }
      return
    }
    push(tx, ty, tz, mode === 0, li)
  })
  if (!isFinite(box.x0)) Object.assign(box, { x0: 0, y0: 0, x1: 0, y1: 0, zMin: 0, zMax: 0 })
  return { moves, time: t, box, lines, tools }
}

export const fmtTime = sec => { const s = Math.round(sec); return s >= 3600 ? `${Math.floor(s / 3600)} ч ${Math.floor(s % 3600 / 60)} мин` : s >= 60 ? `${Math.floor(s / 60)} мин ${s % 60} с` : `${s} с` }
