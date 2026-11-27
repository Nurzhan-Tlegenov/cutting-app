/**
 * Торцевой сверлильно-присадочный станок PMSK PT2-28 (β): G-код .nc — одна программа на деталь, вся обработка торцов.
 * Образцы: родной постпроцессор Базиса «PMSK 2» и Horizontal Drill (newwoodart). Спецификация — claude/pmsk-edge-drill-spec.md.
 *
 *   M601          ← сторона 1…4 (подсказка оператору: какой торец поставить к упору)
 *   T1            ← шпиндель (в нём сверло или фреза — задаёт пользователь)
 *   G00 Z8.000    ← высота от НИЖНЕЙ пласти
 *   G00 X144.000  ← позиция вдоль торца
 *   G01 Y28.000   ← вглубь детали
 *   G00 Y-5.00    ← безопасный отскок (в Базисе 0 — сверло царапает торец при переезде)
 *   M00           ← пауза: оператор поворачивает деталь к следующему торцу
 *   …  G00 X0.000  M30
 *
 * Станок: деталь перед оператором, упор и шпиндели сзади. Положение по X станок находит сам (измеряет деталь), X — слева
 * направо. Деталь всегда лицевой пластью (биркой) вверх, только поворачивается в плоскости.
 * Стороны (вид сверху, бирка читается прямо): 1 — левая, 2 — верхняя, 3 — правая, 4 — нижняя — по часовой.
 * Торец повёрнут назад, к шпинделю, — X от его левого (для оператора) конца, т. е. по часовой вдоль контура детали.
 *
 * Шпиндели — не сверлильная группа: в T1 / T2 стоит сверло или фреза.
 *   отверстие — сверлом своего Ø; нет такого — фрезой меньшего Ø: от центра винтом вниз, потом кольцами наружу;
 *   паз и выемка в торце — фрезой не шире паза: вход наклоном вдоль торца, строчки по высоте, чистовой обход;
 *   глубже «за проход» — в несколько проходов по глубине (Y). Подачи F — только если заданы.
 * Плоскость X–Z (торец) — дуги отрезками G01 X Z: так проходит на любой стойке.
 */
export const isPmsk = post => post?.d6Fmt === 'pmsk'
// edge — «С учётом кромки» (по умолчанию включено): программа по готовой детали — после раскроя деталь кромят, потом
// сверлят торцы; координаты вдоль торца — от края кромки, длины торцев и глубины — с кромкой. Выключено — по размеру
// детали из заказа (кто сверлит торцы до кромления)
export const PMSK_DEFAULT = () => ({ retract: -5, endX0: true, ccw: false, feed: '', plunge: '', seg: 0.5, edge: true })
/** шпиндели станка: { name, kind: 'drill' | 'mill', d, step — глубина за проход, len — рабочая длина } */
export const pmskTools = post => {
  const p = post?.pmsk || {}
  const list = Array.isArray(p.tools) ? p.tools : [{ name: 'T1', kind: 'drill', d: p.t1 ?? 8 }, { name: 'T2', kind: 'drill', d: p.t2 ?? 5 }]
  return list.map(t => ({ name: String(t.name || '').trim(), kind: t.kind === 'mill' ? 'mill' : 'drill', d: n0(t.d), step: n0(t.step), len: n0(t.len) }))
    .filter(t => t.name && t.d > 0)
}
export const pmskOf = post => ({ ...PMSK_DEFAULT(), ...(post?.pmsk || {}), tools: pmskTools(post) })
/** торец станка (Face 1 — Y макс, 2 — Y 0, 3 — X макс, 4 — X 0, при положении детали без поворота) -> номер стороны */
export const PMSK_SIDE = { 4: 1, 1: 2, 3: 3, 2: 4 }

function n0(v) { const x = Number(String(v ?? '').replace(',', '.')); return isFinite(x) ? x : 0 }
const fx = (v, k) => { const r = Math.round(n0(v) * 10 ** k) / 10 ** k; return (Object.is(r, -0) ? 0 : r).toFixed(k) }
const f3 = v => fx(v, 3)
const r1 = v => Math.round(n0(v) * 10) / 10
const EPS = 0.05

/** глубины проходов: 28 при 10 за проход -> [10, 20, 28] */
export function passes(depth, step) {
  if (!(step > 0) || depth <= step + 1e-6) return [depth]
  const n = Math.ceil(depth / step - 1e-6), out = []
  for (let i = 1; i <= n; i++) out.push(Math.min(depth, (depth * i) / n))
  return out
}

/**
 * fr — machineFrame детали без поворота (turn 0: X станка = ширина детали, Y = длина);
 * edge — отверстия в торец из drill6Xml: { face, X, Y, Z (от нижней пласти), depth, dia };
 * cuts — пазы и выемки в торце: { face, p0, p1 (концы на торце, координаты станка), zc — середина по высоте, h — высота
 * (ширина паза), r — скругление углов, depth, pocket }.
 * off — на сколько готовая деталь (с кромкой) выходит за деталь заказа с каждого края станка, мм:
 * { x0 — торец 4 (X 0), x1 — торец 3, y0 — торец 2 (Y 0), y1 — торец 1 }; действует при «С учётом кромки»
 * -> { text, warnings, sides: [номера сторон в программе] } ; text = null — обработки торцов нет
 */
export function pmskNc({ fr: fr0, edge, cuts = [], off = null }, post) {
  const k = pmskOf(post), warnings = [], warn = w => { if (!warnings.includes(w)) warnings.push(w) }
  const o = k.edge !== false && off ? { x0: n0(off.x0), x1: n0(off.x1), y0: n0(off.y0), y1: n0(off.y1) } : { x0: 0, x1: 0, y0: 0, y1: 0 }
  // готовая деталь: торцы длиннее на кромку соседних торцев, точки — от края кромки, глубина — от поверхности кромки
  const fr = { ...fr0, L: fr0.L + o.x0 + o.x1, Wm: fr0.Wm + o.y0 + o.y1 }
  const shift = (X, Y) => [n0(X) + o.x0, n0(Y) + o.y0]
  const faceOff = face => (face === 4 ? o.x0 : face === 3 ? o.x1 : face === 2 ? o.y0 : face === 1 ? o.y1 : 0)
  const drills = k.tools.filter(t => t.kind === 'drill'), mills = k.tools.filter(t => t.kind === 'mill').sort((a, b) => b.d - a.d)
  if (!k.tools.length) warn('у торцевого станка не заданы шпиндели (T1, T2…) — впишите сверла и фрезы в настройках постпроцессора')
  const lenOf = face => (face === 1 || face === 2 ? fr.L : fr.Wm)
  // X вдоль торца: по часовой вдоль контура (шпиндель сзади); ccw — страховка, если станок окажется зеркальным
  const along = (face, X, Y) => {
    const cw = face === 4 ? Y : face === 1 ? X : face === 3 ? fr.Wm - Y : fr.L - X
    return k.ccw ? lenOf(face) - cw : cw
  }
  const deep = (t, depth, what) => { if (t.len > 0 && depth > t.len + 1e-6) warn(`${what} глубиной ${r1(depth)} мм — длиннее рабочей длины ${t.name} (${r1(t.len)} мм), проверьте инструмент`) }
  const ops = new Map()                      // сторона -> [{ tool, x, z, run(out) }]
  const add = (face, op) => { const s = PMSK_SIDE[face]; if (!s) return; if (!ops.has(s)) ops.set(s, []); ops.get(s).push(op) }

  // ── отверстия
  for (const h of edge || []) {
    const dia = n0(h.dia), depth = n0(h.depth) + faceOff(h.face), x = along(h.face, ...shift(h.X, h.Y)), z = n0(h.Z)
    const dr = drills.find(t => Math.abs(t.d - dia) < EPS)
    if (dr) { deep(dr, depth, `отверстие Ø${r1(dia)}`); add(h.face, { tool: dr, x, z, kind: 0, depth, hole: true }); continue }
    const ml = mills.find(t => t.d < dia - EPS)
    if (ml) { deep(ml, depth, `отверстие Ø${r1(dia)}`); add(h.face, { tool: ml, x, z, kind: 1, depth, dia }); warn(`отверстие в торец Ø${r1(dia)} — фрезой ${ml.name} Ø${r1(ml.d)} (нет сверла этого Ø)`); continue }
    const same = mills.find(t => Math.abs(t.d - dia) < EPS)
    if (same) { deep(same, depth, `отверстие Ø${r1(dia)}`); add(h.face, { tool: same, x, z, kind: 0, depth, hole: true }); continue }
    warn(`отверстие в торец Ø${r1(dia)} — нет ни сверла этого Ø, ни фрезы меньше — в программу не попало`)
  }
  // ── пазы и выемки в торце
  for (const c of cuts || []) {
    const len = lenOf(c.face), u0 = along(c.face, ...shift(...c.p0)), u1 = along(c.face, ...shift(...c.p1)), cDepth = n0(c.depth) + faceOff(c.face)
    const ua = Math.min(u0, u1), ub = Math.max(u0, u1), h = n0(c.h), what = `${c.pocket ? 'выемка' : 'паз'} в торце ${r1(ub - ua)} × ${r1(h)} × ${r1(cDepth)}`
    const ml = mills.find(t => t.d <= h + EPS)
    if (!ml) { warn(`${what} — нет фрезы не шире ${r1(h)} мм — в программу не попал${c.pocket ? 'а' : ''}`); continue }
    deep(ml, cDepth, what)
    if (c.r > ml.d / 2 + EPS) warn(`${what}: скругление R${r1(c.r)} больше радиуса фрезы ${ml.name} — углы выйдут R${r1(ml.d / 2)}`)
    add(c.face, { tool: ml, x: ua, z: c.zc, kind: 2, depth: cDepth, ua, ub, za: c.zc - h / 2, zb: c.zc + h / 2, openA: ua <= EPS, openB: ub >= len - EPS })
  }
  const sides = [...ops.keys()].sort((a, b) => a - b)
  if (!sides.length) return { text: null, warnings, sides }

  const out = [], back = `G00 Y${fx(k.retract, 2)}`
  const F = n0(k.feed), FP = n0(k.plunge)
  let curF = null
  const feed = f => { if (!(f > 0) || f === curF) return ''; curF = f; return ` F${Math.round(f)}` }
  const seg = Math.max(0.1, n0(k.seg) || 0.5)

  // отверстие сверлом (или фрезой в размер): по проходам, между проходами — отскок за торец (стружка)
  const drillHole = (o, t) => {
    const ps = passes(o.depth, t.step)
    ps.forEach((y, i) => {
      if (i) out.push(`G00 Y${f3(ps[i - 1] - 0.5)}`)
      out.push(`G01 Y${f3(y)}${t.kind === 'mill' ? feed(FP) : ''}`)
      if (i < ps.length - 1) out.push(back)
    })
    out.push(back)
  }
  // отверстие больше фрезы: вход винтом по первому кольцу, на каждой глубине — кольца от центра наружу
  const millHole = (o, t) => {
    const rmax = (o.dia - t.d) / 2, st = Math.max(0.2, t.d * 0.45), n = Math.max(1, Math.ceil(rmax / st - 1e-6))
    const rings = Array.from({ length: n }, (_, i) => (rmax * (i + 1)) / n)
    const circle = (rho, y0, y1) => {
      const m = Math.max(12, Math.ceil((2 * Math.PI * rho) / seg))
      for (let j = 1; j <= m; j++) {
        const a = (2 * Math.PI * j) / m, y = y0 + ((y1 - y0) * j) / m
        out.push(`G01 X${f3(o.x + rho * Math.cos(a))} Z${f3(o.z + rho * Math.sin(a))}${y0 !== y1 ? ` Y${f3(y)}` : ''}`)
      }
    }
    let y = 0
    out.push(`G01 Y0.000${feed(FP)}`)
    for (const yk of passes(o.depth, t.step)) {
      out.push(`G01 X${f3(o.x + rings[0])}${feed(FP)}`)
      circle(rings[0], y, yk)                                   // винтом вниз
      out.push(`G01 X${f3(o.x + rings[0])}${feed(F)}`)
      circle(rings[0], yk, yk)
      for (const rho of rings.slice(1)) { out.push(`G01 X${f3(o.x + rho)} Z${f3(o.z)}`); circle(rho, yk, yk) }
      out.push(`G01 X${f3(o.x)} Z${f3(o.z)}`)                    // в центр — следующий проход
      y = yk
    }
    out.push(back)
  }
  // паз / выемка: прямоугольник на торце; открытый конец (паз до края детали) — фреза выходит за край
  const millRect = (o, t) => {
    const R = t.d / 2
    const u0 = o.openA ? o.ua - R - 1 : o.ua + R, u1 = o.openB ? o.ub + R + 1 : o.ub - R
    let z0 = o.za + R, z1 = o.zb - R
    if (z1 < z0) z0 = z1 = (o.za + o.zb) / 2
    const ua = Math.min(u0, u1), ub = Math.max(u0, u1, ua)
    const rows = Math.max(1, Math.ceil((z1 - z0) / Math.max(0.2, t.d * 0.6) - 1e-6) + 1)
    const zs = rows === 1 ? [z0] : Array.from({ length: rows }, (_, i) => z0 + ((z1 - z0) * i) / (rows - 1))
    let y = 0
    for (const yk of passes(o.depth, t.step)) {
      out.push(`G00 Z${f3(zs[0])}`, `G00 X${f3(ua)}`)
      out.push(`G01 Y${f3(y)}${feed(FP)}`)
      // вход наклоном вдоль торца (не прямо в торец): от начала строчки до конца, опускаясь на проход; короткая — прямо
      if (ub - ua > t.d) out.push(`G01 X${f3(ub)} Y${f3(yk)}${feed(FP)}`, `G01 X${f3(ua)}${feed(F)}`)
      else out.push(`G01 Y${f3(yk)}${feed(FP)}`)
      let at = ua
      zs.forEach((z, i) => {
        if (i) out.push(`G01 Z${f3(z)}${feed(F)}`)
        at = at === ua ? ub : ua
        out.push(`G01 X${f3(at)}${feed(F)}`)
      })
      // чистовой обход по краю: из конца последней строчки (верх) — к началу, вниз, вдоль низа, вверх, вдоль верха
      if (rows > 1) { if (at !== ua) out.push(`G01 X${f3(ua)}`); out.push(`G01 Z${f3(z0)}`, `G01 X${f3(ub)}`, `G01 Z${f3(z1)}`, `G01 X${f3(ua)}`) }
      out.push(back)
      y = yk
    }
  }

  sides.forEach((s, i) => {
    if (i) out.push('M00')
    out.push(`M60${s}`)
    const list = ops.get(s)
    // шпиндели по порядку из настроек; на шпинделе — сначала отверстия слева направо, потом пазы и выемки
    for (const t of k.tools) {
      const hs = list.filter(o => o.tool === t).sort((a, b) => (a.kind === 2) - (b.kind === 2) || a.x - b.x || a.z - b.z)
      if (!hs.length) continue
      out.push(t.name)
      let z = null
      for (const o of hs) {
        if (o.kind === 2) { millRect(o, t); z = null; continue }
        if (z == null || Math.abs(o.z - z) > 0.0005) { out.push(`G00 Z${f3(o.z)}`); z = o.z }
        out.push(`G00 X${f3(o.x)}`)
        if (o.kind === 1) { millHole(o, t); z = null; continue }
        drillHole(o, t)
      }
    }
  })
  if (k.endX0 !== false) out.push('G00 X0.000')
  out.push('M30', '')
  return { text: out.join('\r\n'), warnings, sides }
}
