// Структура модели (изделия → блоки → детали) и перемещение блоков в 3D.
// Блок двигается вдоль одной оси (остальные две «закреплены») и упирается в соседние детали:
// зазор между деталями — 0, заехать деталью в деталь нельзя. Если детали уже входят друг в друга
// (ошибка в модели), их можно развести — обратно они уже не заедут.
// Здесь только расчёты — без three.js и без React.
import { contourOf } from './model3dEdit.js'

const EPS = 0.05
const r2 = v => Math.round(v * 100) / 100

/** Дерево блоков: узел { key, name, children, parts (детали прямо в блоке), pids (все детали внутри) } */
export function blockTree(parts) {
  const root = { key: '', name: '', children: [], parts: [], pids: [] }
  const nodes = new Map([['', root]])
  const up = key => { const i = key.lastIndexOf(' / '); return i < 0 ? '' : key.slice(0, i) }
  const node = key => {
    if (nodes.has(key)) return nodes.get(key)
    const n = { key, name: key.slice(up(key) ? up(key).length + 3 : 0), children: [], parts: [], pids: [] }
    node(up(key)).children.push(n)
    nodes.set(key, n)
    return n
  }
  for (const p of parts) {
    const key = p.block || ''
    node(key).parts.push(p)
    for (let k = key; ; k = up(k)) { nodes.get(k).pids.push(p.pid); if (!k) break }
  }
  const cmp = (a, b) => String(a).localeCompare(String(b), 'ru', { numeric: true })
  for (const n of nodes.values()) {
    n.children.sort((a, b) => cmp(a.name, b.name))
    n.parts.sort((a, b) => cmp(a.des || a.pos || '', b.des || b.pos || '') || cmp(a.name, b.name))
  }
  return root
}

/** Габарит детали в модели: { min: [x, y, z], max: [x, y, z] } */
export function partBox(p) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [x, y] of p.outline) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y }
  const m = p.m, min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [0, p.t]) {
    for (let k = 0; k < 3; k++) {
      const v = m[k * 3] * x + m[k * 3 + 1] * y + m[k * 3 + 2] * z + m[9 + k]
      if (v < min[k]) min[k] = v
      if (v > max[k]) max[k] = v
    }
  }
  return { min, max }
}

/**
 * Фурнитура модели по штукам: [{ pid, hi, block, near }]. block — блок из файла (если записан при импорте),
 * иначе near — ближайшая панель: фурнитура двигается вместе с ней.
 */
export function hardwareLinks(model) {
  const out = []
  let boxes = null
  let n = 0
  for (const hw of model.hardware || []) {
    let c = null
    for (const it of hw.inst) {
      const pid = 'h' + n++
      if (it.b != null) { out.push({ pid, hi: it.hi, block: it.b, near: null }); continue }
      if (!c) {                                   // середина формы фурнитуры (в её системе)
        const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
        for (const g of hw.groups) for (let k = 0; k < g.pos.length; k++) { const v = g.pos[k], a = k % 3; if (v < lo[a]) lo[a] = v; if (v > hi[a]) hi[a] = v }
        c = [0, 1, 2].map(a => (lo[a] + hi[a]) / 2)
      }
      if (!boxes) boxes = (model.parts || []).filter(p => p.outline?.length > 2).map(p => ({ pid: p.pid, ...partBox(p) }))
      const m = it.m
      const w = [0, 1, 2].map(k => m[k * 3] * c[0] + m[k * 3 + 1] * c[1] + m[k * 3 + 2] * c[2] + m[9 + k])
      let best = null, bd = Infinity
      for (const b of boxes) {
        let d = 0
        for (let k = 0; k < 3; k++) { const e = Math.max(b.min[k] - w[k], 0, w[k] - b.max[k]); d += e * e }
        if (d < bd) { bd = d; best = b.pid }
      }
      out.push({ pid, hi: it.hi, block: null, near: best })
    }
  }
  return out
}

/** Что поедет вместе с выбранными деталями: они сами и фурнитура их блоков */
export function movingSet(sel, parts, links) {
  const out = new Set(sel)
  const full = new Map()
  // фурнитура часто лежит во вложенном блоке без панелей (ручка, петля) — поднимаемся до блока с панелями
  const blockFull = b => {
    if (full.has(b)) return full.get(b)
    let res = false
    for (let k = b; ; k = k.includes(' / ') ? k.slice(0, k.lastIndexOf(' / ')) : '') {
      const inside = k ? parts.filter(p => p.block === k || String(p.block || '').startsWith(k + ' / ')) : parts
      if (inside.length) { res = inside.every(p => sel.has(p.pid)); break }
      if (!k) break
    }
    full.set(b, res)
    return res
  }
  for (const h of links) if (h.block != null ? blockFull(h.block) : sel.has(h.near)) out.add(h.pid)
  return out
}

/**
 * Запретные интервалы сдвига вдоль оси axis (0 — X, 1 — Y, 2 — Z): при сдвиге внутри интервала
 * движущееся тело входит в неподвижное. Тела, которые только касаются по другим осям, не мешают.
 */
export function sweepLimits(moving, fixed, axis) {
  const other = [0, 1, 2].filter(k => k !== axis)
  const out = []
  for (const m of moving) for (const s of fixed) {
    if (other.some(k => Math.min(m.max[k], s.max[k]) - Math.max(m.min[k], s.min[k]) <= EPS)) continue
    const lo = s.min[axis] - m.max[axis], hi = s.max[axis] - m.min[axis]
    if (hi - lo > 2 * EPS) out.push([lo, hi, s])
  }
  return out
}

/**
 * Сдвиг из cur в target с упором: в запретный интервал заехать нельзя, выехать из него — можно.
 * -> { t (куда можно доехать), stop (неподвижное тело, в которое упёрлись, или null) }
 */
export function clampMove(limits, cur, target) {
  let t = target, stop = null
  const fwd = target > cur
  for (const [lo, hi, s] of limits) {
    if (fwd) {
      // впереди — тело, которое начинается не раньше текущего положения
      if (lo >= cur - EPS && t > lo) { t = Math.max(lo, cur); stop = s }
    } else if (hi <= cur + EPS && t < hi) { t = Math.min(hi, cur); stop = s }
  }
  return { t, stop }
}

const shiftM = (m, d) => m.map((v, i) => (i >= 9 ? r2(v + d[i - 9]) : v))
const shiftAnim = (a, d) => (a ? { ...a, a: a.a.map((v, k) => r2(v + d[k])), b: a.b.map((v, k) => r2(v + d[k])) } : a)

/**
 * Сдвинуть объекты модели на вектор d (мм). mv: { parts: Set('di:ii'), ids: Set(ID панелей),
 * sceneParts: Set('si:ii'), extras: Set(xi), hardware: Set(hi) }. -> { details, scene }
 */
export function moveModel(details, scene, mv, d) {
  const moveMeta = (meta, hit) => {
    if (!meta?.inst?.some((_, ii) => hit(ii))) return null
    return {
      ...meta,
      inst: meta.inst.map((m, ii) => (hit(ii) ? shiftM(m, d) : m)),
      ...(meta.anims ? { anims: meta.anims.map((a, ii) => (hit(ii) ? shiftAnim(a, d) : a)) } : {}),
    }
  }
  const nextDetails = (details || []).map((row, di) => {
    const c = contourOf(row)
    const meta = moveMeta(c?.meta, ii => mv.parts.has(`${di}:${ii}`))
    if (!meta) return row
    const nc = { ...c, meta }
    return { ...row, contour: typeof row.contour === 'string' ? JSON.stringify(nc) : nc }
  })
  let nextScene = scene
  if (scene) {
    nextScene = {
      ...scene,
      parts: (scene.parts || []).map((sp, si) => {
        const c = contourOf(sp)
        const meta = moveMeta(c?.meta, ii => mv.sceneParts.has(`${si}:${ii}`) || (c.meta.ids?.[ii] != null && mv.ids.has(c.meta.ids[ii])))
        return meta ? { ...sp, contour: { ...c, meta } } : sp
      }),
      extras: (scene.extras || []).map((ex, xi) => (mv.extras.has(xi) ? { ...ex, m: shiftM(ex.m, d), ...(ex.anim ? { anim: shiftAnim(ex.anim, d) } : {}) } : ex)),
      hardware: (scene.hardware || []).map((hw, hi) => (mv.hardware.has(hi) ? { ...hw, m: shiftM(hw.m, d), ...(hw.anim ? { anim: shiftAnim(hw.anim, d) } : {}) } : hw)),
    }
  }
  return { details: nextDetails, scene: nextScene }
}
