// Линейный раскрой погонных материалов: профиль, труба, карниз, плинтус, брус.
// Хлысты могут быть разной длины (2000, 3000, 6000…) и в ограниченном количестве (остатки на складе).
// Каждый следующий хлыст подбирается так: для каждой доступной длины хлыста находится лучший набор отрезков
// (рюкзак по длине с учётом пропила и торцовки), и берётся хлыст с наибольшим процентом использования.
// Так короткие хлысты идут под «хвосты», длинные — под длинные отрезки, а отходов меньше.

const num = (v, d = 0) => { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : d }
const r1 = v => Math.round(v * 10) / 10

/** «2000, 3000; 6000» -> [{ len, qty: null }] */
export function parseStocks(s) {
  return String(s ?? '').split(/[\s,;]+/).map(x => num(x, 0)).filter(x => x > 0).map(len => ({ len, qty: null }))
}

// Лучший набор отрезков в хлыст ёмкостью cap (целые 0,1 мм): types — [{ w, left }] -> { used, take: [кол-во по типам] }
function bestFill(types, cap) {
  const items = []
  types.forEach((t, ti) => {
    let c = Math.min(t.left, Math.floor(cap / t.w))
    for (let k = 1; c > 0; k *= 2) { const m = Math.min(k, c); items.push({ w: t.w * m, n: m, ti }); c -= m }
  })
  const from = new Int32Array(cap + 1).fill(-1)
  const reach = new Uint8Array(cap + 1)
  reach[0] = 1
  let best = 0
  for (let i = 0; i < items.length; i++) {
    const w = items[i].w
    for (let c = cap; c >= w; c--) {
      if (!reach[c] && reach[c - w]) { reach[c] = 1; from[c] = i; if (c > best) best = c }
    }
    if (best === cap) break
  }
  const take = types.map(() => 0)
  for (let c = best; c > 0;) { const it = items[from[c]]; take[it.ti] += it.n; c -= it.w }
  return { used: best, take }
}

/**
 * pieces — [{ len, qty, name }], stocks — [{ len, qty|null }], kerf — пропил, trim — торцовка с каждого конца хлыста.
 * -> { bars: [{ stock, cuts: [{ len, name }], used, rest }], unplaced: [{ len, name, qty }], byStock: [{ len, count }], total, cutLen, waste }
 */
export function linearCut({ pieces, stocks, kerf = 3, trim = 0 }) {
  const K = Math.max(0, num(kerf)), T = Math.max(0, num(trim))
  const st = (stocks || []).map(s => ({ len: num(s.len), left: s.qty == null || s.qty === '' ? Infinity : Math.max(0, Math.round(num(s.qty))) })).filter(s => s.len > 0)
  // одинаковые отрезки — одним типом (длина + название)
  const map = new Map()
  for (const p of pieces || []) {
    const len = num(p.len), q = Math.max(0, Math.round(num(p.qty, 1)))
    if (!(len > 0) || !q) continue
    const key = `${len}|${p.name || ''}`
    if (!map.has(key)) map.set(key, { len, name: p.name || '', left: 0 })
    map.get(key).left += q
  }
  const types = [...map.values()].sort((a, b) => b.len - a.len)
  // ёмкость: длина − торцовка с двух концов + один пропил (после последнего отрезка пропил не нужен)
  types.forEach(t => { t.w = Math.round((t.len + K) * 10) })
  const bars = [], unplaced = []
  const maxCap = s => Math.round((s.len - 2 * T + K) * 10)
  for (const t of types) {
    if (!st.some(s => maxCap(s) >= t.w)) { unplaced.push({ len: t.len, name: t.name, qty: t.left }); t.left = 0 }
  }
  let guard = 0
  while (types.some(t => t.left > 0) && guard++ < 10000) {
    let pick = null
    for (const s of st) {
      if (s.left <= 0) continue
      const cap = maxCap(s)
      if (cap <= 0) continue
      const live = types.filter(t => t.left > 0)
      const r = bestFill(live, cap)
      if (!r.used) continue
      const cutLen = live.reduce((a, t, i) => a + t.len * r.take[i], 0)
      const score = cutLen / s.len
      if (!pick || score > pick.score + 1e-9 || (Math.abs(score - pick.score) <= 1e-9 && s.len < pick.s.len)) pick = { s, r, live, score }
    }
    if (!pick) {          // хлысты кончились (ограниченное количество)
      for (const t of types) if (t.left > 0) { unplaced.push({ len: t.len, name: t.name, qty: t.left }); t.left = 0 }
      break
    }
    const cuts = []
    pick.live.forEach((t, i) => { for (let k = 0; k < pick.r.take[i]; k++) cuts.push({ len: t.len, name: t.name }); t.left -= pick.r.take[i] })
    cuts.sort((a, b) => b.len - a.len)
    const used = 2 * T + cuts.reduce((a, c) => a + c.len, 0) + K * Math.max(0, cuts.length - 1)
    bars.push({ stock: pick.s.len, cuts, used: r1(used), rest: r1(pick.s.len - used) })
    pick.s.left--
  }
  // одинаковые хлысты подряд — длинные сначала
  bars.sort((a, b) => b.stock - a.stock || b.used - a.used)
  const byLen = new Map()
  for (const b of bars) byLen.set(b.stock, (byLen.get(b.stock) || 0) + 1)
  const total = bars.reduce((a, b) => a + b.stock, 0)
  const cutLen = bars.reduce((a, b) => a + b.cuts.reduce((x, c) => x + c.len, 0), 0)
  return {
    bars, unplaced,
    byStock: [...byLen.entries()].map(([len, count]) => ({ len, count })).sort((a, b) => b.len - a.len),
    total: r1(total), cutLen: r1(cutLen), waste: total ? Math.round((1 - cutLen / total) * 1000) / 10 : 0,
  }
}

/** Одинаковые хлысты (та же длина и тот же набор отрезков) — группой «×N» для карты раскроя */
export function groupBars(bars) {
  const out = []
  for (const b of bars) {
    const key = b.stock + ':' + b.cuts.map(c => `${c.len}/${c.name}`).join(',')
    const last = out[out.length - 1]
    if (last && last.key === key) last.count++
    else out.push({ ...b, key, count: 1 })
  }
  return out
}
