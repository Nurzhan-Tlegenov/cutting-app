/**
 * Точная укладка «как в тетрисе» — по реальным контурам, без растровой сетки.
 *
 * Растровая укладка (trueShapeNesting) работает на сетке ячеек ~7 мм и
 * закладывает зазор реза через ячейки, поэтому каждая пара деталей занимает
 * лишние 5–10 мм, а на листе, где рядом умещается 3 пары Г-образных деталей,
 * это стоит целой детали. Здесь деталь ставится с миллиметровой точностью:
 *
 *   1. деталь в каждом допустимом повороте (0/180 всегда, 90/270 — если
 *      вращение включено у детали) "роняется" сверху листа в разных
 *      столбцах (X-кандидаты: сетка + привязка к краям и вершинам уже
 *      уложенных деталей — так находятся пазы и ниши);
 *   2. съезжает к нулю по осям в порядке, заданном направлением укладки, до
 *      контакта с зазором ровно kerf между КОНТУРАМИ;
 *   3. из всех кандидатов выбирается тот, что меньше всего увеличивает
 *      занятый габарит листа (плотность), при равенстве — ближе к нулю.
 *
 * Порядок деталей перебирается (по убыванию площади/габарита + случайные
 * перестановки) до дедлайна; побеждает раскладка с меньшим числом листов,
 * при равенстве — где на последний лист ушло меньше материала (первые листы
 * забиты плотнее, остаток — одним крупным обрезком).
 */

import { makeEntry, slideEntry, entryClear, bboxOf, orderFor, simplifyPoly } from './gravity'

const SIMPLIFY_EPS = 1.0 // мм — допуск упрощения контуров для быстрой геометрии (погрешность учитывается в зазоре)

const GRID_STEP = 60   // мм, шаг сетки X-кандидатов
const BUCKET = 20      // мм, округление X-кандидатов (дубли не считаем)
const CELL = 20        // мм, ячейка растра «пустот» (только для оценки, не для самой укладки)
const TOP_PER_VARIANT = 3   // сколько лучших по габариту кандидатов каждого поворота проверяем на «запертые пустоты»
const TRAPPED_WEIGHT = 1.5  // штраф за запертую пустоту относительно занятого габарита

// Угловые вершины детали (поворот контура > 35°) — плавные дуги для привязки
// кандидатов не нужны, только реальные углы и края. Считается один раз.
function cornersOf(entry) {
  if (entry._corners) return entry._corners
  const p = entry.poly, n = p.length, out = []
  for (let i = 0; i < n; i++) {
    const a = p[(i + n - 1) % n], b = p[i], c = p[(i + 1) % n]
    const a1 = Math.atan2(b[1] - a[1], b[0] - a[0]), a2 = Math.atan2(c[1] - b[1], c[0] - b[0])
    let d = Math.abs(a2 - a1); if (d > Math.PI) d = 2 * Math.PI - d
    if (d > 0.61) out.push(b)
  }
  entry._corners = out.length ? out : p
  return entry._corners
}

// Упрощённый контур варианта (считается один раз).
function simplified(variant) {
  if (!variant._simple) variant._simple = simplifyPoly(variant.polygon, SIMPLIFY_EPS)
  return variant._simple
}

function polyArea(poly) {
  let a = 0
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length]
    a += x1 * y2 - x2 * y1
  }
  return Math.abs(a) / 2
}

function pointInPoly(px, py, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j]
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside
  }
  return inside
}

// Ячейки растра, занятые контуром (по центру ячейки).
function polyCells(poly, cols, rows) {
  const bb = bboxOf(poly)
  const c0 = Math.max(0, Math.floor(bb.minX / CELL)), c1 = Math.min(cols - 1, Math.floor(bb.maxX / CELL))
  const r0 = Math.max(0, Math.floor(bb.minY / CELL)), r1 = Math.min(rows - 1, Math.floor(bb.maxY / CELL))
  const out = []
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      if (pointInPoly((c + 0.5) * CELL, (r + 0.5) * CELL, poly)) out.push(r * cols + c)
    }
  }
  return out
}

// «Запертая» пустота: свободные ячейки, до которых уже нельзя добраться со
// стороны верха и правого края листа (детали ставятся, падая сверху, и
// съезжают к нулю — в замкнутый карман никто больше не попадёт). Именно такой
// карман остаётся, если Г-образную деталь положить в угол листа «пустой
// стороной» — её вогнутость оказывается закрыта краями листа.
function trappedArea(sheet, extraCells, topRow) {
  const { grid, cols } = sheet
  // выше topRow (габарит занятого + деталь) всё свободно и открыто — считаем
  // только нижнюю часть листа
  const rows = Math.min(sheet.rows, topRow + 2)
  const occ = grid.slice(0, cols * rows)
  for (const i of extraCells) if (i < occ.length) occ[i] = 1
  const seen = new Uint8Array(cols * rows)
  const stack = []
  const push = i => { if (!occ[i] && !seen[i]) { seen[i] = 1; stack.push(i) } }
  for (let c = 0; c < cols; c++) push((rows - 1) * cols + c)
  for (let r = 0; r < rows; r++) push(r * cols + cols - 1)
  while (stack.length) {
    const i = stack.pop()
    const c = i % cols, r = (i - c) / cols
    if (c > 0) push(i - 1)
    if (c < cols - 1) push(i + 1)
    if (r > 0) push(i - cols)
    if (r < rows - 1) push(i + cols)
  }
  let free = 0
  for (let i = 0; i < occ.length; i++) if (!occ[i] && !seen[i]) free++
  return free * CELL * CELL
}

// Самый большой свободный прямоугольник на растре листа (площадь, мм²) —
// это и есть «деловой обрезок»: чем он больше, тем лучше. Классический
// алгоритм по гистограммам за один проход.
function largestFreeRect(grid, cols, rows) {
  const h = new Int32Array(cols)
  let best = 0
  const stack = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) h[c] = grid[r * cols + c] ? 0 : h[c] + 1
    stack.length = 0
    for (let c = 0; c <= cols; c++) {
      const cur = c === cols ? 0 : h[c]
      let start = c
      while (stack.length && stack[stack.length - 1][1] >= cur) {
        const [sc, sh] = stack.pop()
        const area = sh * (c - sc)
        if (area > best) best = area
        start = sc
      }
      stack.push([start, cur])
    }
  }
  return best * CELL * CELL
}
function sheetOffcut(sheet) { return largestFreeRect(sheet.grid, sheet.cols, sheet.rows) }

function candidateXs(sheet, bw, usableX, kerf, step = GRID_STEP, bucket = BUCKET) {
  const maxX = usableX - bw
  const set = new Set()
  const add = v => { if (v >= -1e-9 && v <= maxX + 1e-9) set.add(Math.round(Math.max(0, Math.min(maxX, v)) / bucket) * bucket) }
  for (let x = 0; x <= maxX; x += step) add(x)
  add(0); add(maxX)
  for (const o of sheet.entries) {
    add(o.bb.maxX + kerf); add(o.bb.minX - kerf - bw)
    add(o.bb.minX); add(o.bb.maxX - bw)
    for (const [vx] of cornersOf(o)) { add(vx + kerf); add(vx - kerf - bw) }
  }
  return [...set].sort((a, b) => a - b)
}

// То же по Y — для боковой подачи (деталь заезжает в проём сбоку).
function candidateYs(sheet, bh, usableY, kerf, step = GRID_STEP, bucket = BUCKET) {
  const maxY = usableY - bh
  const set = new Set()
  const add = v => { if (v >= -1e-9 && v <= maxY + 1e-9) set.add(Math.round(Math.max(0, Math.min(maxY, v)) / bucket) * bucket) }
  for (let y = 0; y <= maxY; y += step) add(y)
  add(0); add(maxY)
  for (const o of sheet.entries) {
    add(o.bb.maxY + kerf); add(o.bb.minY - kerf - bh)
    add(o.bb.minY); add(o.bb.maxY - bh)
    for (const [, vy] of cornersOf(o)) { add(vy + kerf); add(vy - kerf - bh) }
  }
  return [...set].sort((a, b) => a - b)
}

// Лучшее место для детали на листе или null.
// Два способа подачи: сверху (деталь падает в столбец, затем съезжает к нулю)
// и справа (заезжает в горизонтальные проёмы, недоступные сверху).
// dense=true — частая сетка стартов (для итоговой проверки «не влезает ли ещё что-то»).
function tryInsert(sheet, inst, usableX, usableY, kerf, direction, dense = false, deterministic = false, stable = false) {
  const step = dense ? 20 : GRID_STEP, bucket = dense ? 5 : BUCKET
  const dropOrder = orderFor(direction)[0]
  // Привязка к стороне: для along_y / along_x «занятый габарит» меряется как
  // полоса от выбранной стороны на всю длину листа (envX*usableY / envY*usableX),
  // а не как площадь прямоугольника envX*envY. Сам критерий (минимум габарита,
  // штраф за запертые пустоты, вложение в пазы) остаётся тем же — меняется
  // только точка отсчёта. auto — без изменений.
  const alongY = direction === 'along_y', alongX = direction === 'along_x'
  const envMeasure = (ex, ey) => alongY ? ex * usableY + ey : alongX ? ey * usableX + ex : ex * ey
  const anchorTie = bb => alongY ? 10 * bb.minX + bb.minY : alongX ? 10 * bb.minY + bb.minX : bb.minX + bb.minY
  const sideOrder = dropOrder.slice().reverse()
  const shortlist = []
  const settle = (e, order) => {
    for (let pass = 0; pass < 8; pass++) {
      let moved = false
      for (const axis of order) moved = slideEntry(e, sheet.entries, axis, kerf) || moved
      if (!moved) break
    }
  }
  for (const variant of inst.variants) {
    const lb = bboxOf(variant.polygon)
    const bw = lb.maxX - lb.minX, bh = lb.maxY - lb.minY
    if (bw > usableX + 1e-6 || bh > usableY + 1e-6) continue
    const found = []
    const consider = (tx, ty, order) => {
      // Дешёвая проверка по габаритам ДО построения контура: если старт целиком
      // внутри габарита уложенной детали (с запасом kerf), он заведомо занят.
      const sx0 = tx + lb.minX, sy0 = ty + lb.minY, sx1 = tx + lb.maxX, sy1 = ty + lb.maxY
      for (const o of sheet.entries) {
        if (o.bb.minX - kerf <= sx0 && o.bb.maxX + kerf >= sx1 && o.bb.minY - kerf <= sy0 && o.bb.maxY + kerf >= sy1) return
      }
      const sp = simplified(variant)
      const e = makeEntry(sp.poly.map(p => [p[0] + tx, p[1] + ty]), sp.pad)
      if (!entryClear(e, sheet.entries, kerf)) return
      settle(e, order)
      if (e.bb.minX < -0.01 || e.bb.minY < -0.01 || e.bb.maxX > usableX + 0.01 || e.bb.maxY > usableY + 0.01) return
      if (!entryClear(e, sheet.entries, kerf)) return
      const envX = Math.max(sheet.envX, e.bb.maxX), envY = Math.max(sheet.envY, e.bb.maxY)
      const env = envMeasure(envX, envY)
      found.push({ variant, entry: e, tx: tx + e.dx, ty: ty + e.dy, env, key: env * 1000 + anchorTie(e.bb) })
    }
    for (const x0 of candidateXs(sheet, bw, usableX, kerf, step, bucket)) consider(x0 - lb.minX, usableY - lb.maxY, dropOrder)
    if (sheet.entries.length) {
      for (const y0 of candidateYs(sheet, bh, usableY, kerf, step, bucket)) consider(usableX - lb.maxX, y0 - lb.minY, sideOrder)
    }
    found.sort((a, b) => a.key - b.key)
    // одинаковые итоговые позиции (разные старты сошлись в одну точку) не дублируем
    const uniq = []
    for (const f of found) {
      if (!uniq.some(u => Math.abs(u.entry.bb.minX - f.entry.bb.minX) < 0.5 && Math.abs(u.entry.bb.minY - f.entry.bb.minY) < 0.5)) uniq.push(f)
      if (uniq.length >= TOP_PER_VARIANT) break
    }
    shortlist.push(...uniq)
  }
  if (!shortlist.length) return null

  // Итоговый выбор — среди лучших по габариту кандидатов ВСЕХ поворотов:
  // занятый габарит + штраф за запертую пустоту. Так при равном габарите
  // деталь встаёт тем поворотом, который заполняет угол листа своим телом, а
  // вогнутость оставляет открытой для следующих деталей.
  let best = null, bestCost = Infinity
  const minEnv = Math.min(...shortlist.map(c => c.env))
  for (const c of shortlist) {
    if (c.env > minEnv * 1.15) continue // заметно больший габарит — пустоты не спасут
    const topRow = Math.min(sheet.rows - 1, Math.ceil(Math.max(sheet.envY, c.entry.bb.maxY) / CELL))
    const trapped = trappedArea(sheet, polyCells(c.entry.poly, sheet.cols, sheet.rows), topRow)
    const cost = c.env + TRAPPED_WEIGHT * trapped + anchorTie(c.entry.bb) * 1e-3
    c.cost = cost
    if (cost < bestCost) { bestCost = cost; best = c }
  }
  // Почти равноценные варианты (разница < 0,3%, например поворот детали-пары
  // на 0° или 90° в пустом углу) выбираем случайно: так разные попытки поиска
  // порядка приходят к разным раскладкам, а не к одной и той же.
  // Для сборки пары (deterministic) «запертые пустоты» не штрафуем: внутри пары
  // они неизбежны, а нужна именно минимальная плотная упаковка двух деталей.
  if (deterministic) return shortlist.slice().sort((x, y) => x.env - y.env || anchorTie(x.entry.bb) - anchorTie(y.entry.bb))[0]
  const near = shortlist.filter(c => c.cost != null && c.cost <= bestCost * 1.003)
  // stable=true — берём ЛУЧШИЙ (первый по cost), без монетки между
  // "почти равноценными": для структурных (заведомо детерминированных)
  // порядков в packExact иначе один и тот же порядок деталей на практике
  // давал разную раскладку от запуска к запуску — см. комментарий у
  // packOrder. В отличие от deterministic (для сборки пары) здесь остаётся
  // полная формула cost (габарит + штраф за запертую пустоту) — меняется
  // только последний шаг (не кидаем монетку), а не сама оценка.
  if (near.length > 1 && !stable) best = near[Math.floor(Math.random() * near.length)]
  return best
}

// stable=true — без монетки между "почти равноценными" позициями (см.
// tryInsert). Три СТРУКТУРНЫХ порядка (по площади/плотности/стороне) в
// packExact ниже задуманы как воспроизводимые, детерминированные попытки —
// но пока tryInsert сам решал между близкими позициями случайно, они на
// практике каждый раз давали немного другую раскладку. Именно из-за этого
// одна и та же деталь то укладывалась в 1 лист, то в 2 — притом что
// "структурный" порядок деталей был одним и тем же. Со stable=true эти три
// попытки воспроизводимы: если такой порядок способен дать 1 лист — он даст
// его КАЖДЫЙ раз, а не через раз. Случайность остаётся только там, где она
// осмысленна — в последующем переборе (shuffle/promote/perturb ниже).
async function packOrder(order, usableX, usableY, kerf, direction, deadline, stable = false, seedSheets = null) {
  const sheets = seedSheets ? seedSheets.slice() : []
  let counter = 0
  // Одинаковые детали (одна позиция заказа), которые уже не влезли на лист в его
  // текущем состоянии, повторно на нём не пробуем — результат будет тем же.
  const noFit = new Set()
  for (const inst of order) {
    if (Date.now() > deadline) return null
    let placed = false
    for (const sheet of sheets) {
      if (usableX * usableY - sheet.used < inst.polyArea) continue // по площади заведомо не влезает
      const key = sheet.uid + ':' + sheet.ver + ':' + (inst.kind ?? inst.detailIndex)
      if (noFit.has(key)) continue
      const r = tryInsert(sheet, inst, usableX, usableY, kerf, direction, false, false, stable)
      if (r) { commit(sheet, inst, r); placed = true; break }
      noFit.add(key)
    }
    if (!placed) {
      const sheet = newSheet(usableX, usableY)
      const r = tryInsert(sheet, inst, usableX, usableY, kerf, direction, false, false, stable)
      if (!r) return null // деталь не влезает даже на пустой лист
      commit(sheet, inst, r)
      sheets.push(sheet)
    }
    if (++counter % 2 === 0) await new Promise(res => setTimeout(res, 0))
  }
  return sheets
}

let SHEET_UID = 0

// ─── Усадка листа («песок») ────────────────────────────────────────────────
// slideEntry в tryInsert сдвигает к контактам только НОВУЮ деталь — соседи,
// уложенные раньше, больше не двигаются. Из-за этого между уже стоящими
// деталями годами остаются зазоры, которые могли бы закрыться, если их
// стянуть заново все вместе — как насыпанный песок оседает при встряске и
// освобождает место досыпать ещё. compactSheet делает именно это: стягивает
// ВСЕ детали листа к выбранному углу (пробуем все 4 угла — не только (0,0),
// как раньше) и возвращает выигрышный вариант — с которого дальше пробуем
// довставить деталь со следующего листа.
function compactSheet(sheet, kerf, usableX, usableY) {
  const orders = [['y', 'x'], ['x', 'y']]
  const corners = [[false, false], [true, false], [false, true], [true, true]]
  const origPoly = sheet.entries.map(e => e.poly)
  let bestPoly = null, bestEnv = Infinity
  for (const [flipX, flipY] of corners) {
    for (const order of orders) {
      // Каждая попытка — с чистого листа (из исходных позиций), сдвиг считаем
      // напрямую по опорной вершине контура, а не через накопленный e.dx/e.dy
      // (он не переживает смену системы координат при отражении в угол).
      sheet.entries.forEach((e, i) => { e.poly = origPoly[i]; e.dx = 0; e.dy = 0 })
      const tf = ([x, y]) => [flipX ? usableX - x : x, flipY ? usableY - y : y]
      for (const e of sheet.entries) { e.poly = e.poly.map(tf); e.bb = bboxOf(e.poly) }
      for (let pass = 0; pass < 30; pass++) {
        let moved = false
        for (const axis of order) {
          const idxs = sheet.entries.map((_, i) => i).sort((a, b) =>
            axis === 'x' ? sheet.entries[a].bb.minX - sheet.entries[b].bb.minX : sheet.entries[a].bb.minY - sheet.entries[b].bb.minY)
          for (const i of idxs) if (slideEntry(sheet.entries[i], sheet.entries, axis, kerf)) moved = true
        }
        if (!moved) break
      }
      for (const e of sheet.entries) { e.poly = e.poly.map(tf); e.bb = bboxOf(e.poly) }
      const envX = Math.max(...sheet.entries.map(e => e.bb.maxX)), envY = Math.max(...sheet.entries.map(e => e.bb.maxY))
      const env = envX * envY
      if (env < bestEnv - 1) { bestEnv = env; bestPoly = sheet.entries.map(e => e.poly) }
    }
  }
  sheet.entries.forEach((e, i) => { e.poly = origPoly[i]; e.dx = 0; e.dy = 0; e.bb = bboxOf(e.poly) })
  if (!bestPoly) return false
  let changed = false
  sheet.entries.forEach((e, i) => {
    const before = origPoly[i][0], after = bestPoly[i][0]
    const ddx = after[0] - before[0], ddy = after[1] - before[1]
    if (Math.abs(ddx) > 0.01 || Math.abs(ddy) > 0.01) changed = true
    e.poly = bestPoly[i]; e.bb = bboxOf(e.poly)
    sheet.meta[i].x += ddx; sheet.meta[i].y += ddy
  })
  if (!changed) return false
  sheet.grid.fill(0)
  for (const e of sheet.entries) for (const c of polyCells(e.poly, sheet.cols, sheet.rows)) sheet.grid[c] = 1
  sheet.envX = Math.max(...sheet.entries.map(e => e.bb.maxX))
  sheet.envY = Math.max(...sheet.entries.map(e => e.bb.maxY))
  return true
}

// Стягиваем лист и, пока получается, довставляем в освободившееся место
// детали со следующих листов — до тех пор, пока что-то помещается.
async function settleAndPull(sheets, ctx, deadline) {
  const { usableX, usableY, kerf, direction } = ctx
  let result = sheets.slice()
  for (let i = 0; i < result.length - 1 && Date.now() < deadline; i++) {
    let progress = true
    while (progress && Date.now() < deadline) {
      progress = false
      compactSheet(result[i], kerf, usableX, usableY)
      for (let j = i + 1; j < result.length; j++) {
        const from = result[j]
        for (let k = 0; k < from.meta.length; k++) {
          if (Date.now() > deadline) break
          const inst = from.meta[k].inst
          if (usableX * usableY - result[i].used < inst.polyArea) continue
          const r = tryInsert(result[i], inst, usableX, usableY, kerf, direction, true)
          if (!r) continue
          commit(result[i], inst, r)
          result[j] = sheetWithout(from, new Set([k]), usableX, usableY)
          progress = true
          break
        }
        if (progress) break
      }
    }
  }
  result = result.filter(sh => sh.entries.length)
  return result
}

function newSheet(usableX, usableY) {
  const cols = Math.max(1, Math.ceil(usableX / CELL)), rows = Math.max(1, Math.ceil(usableY / CELL))
  return { entries: [], meta: [], envX: 0, envY: 0, used: 0, ver: 0, uid: ++SHEET_UID, cols, rows, grid: new Uint8Array(cols * rows) }
}

function commit(sheet, inst, r) {
  for (const i of polyCells(r.entry.poly, sheet.cols, sheet.rows)) sheet.grid[i] = 1
  sheet.entries.push(r.entry)
  const matArea = r.variant.matArea ?? polyArea(r.variant.polygon)
  sheet.meta.push({ inst, variant: r.variant, x: r.tx, y: r.ty, area: matArea })
  sheet.envX = Math.max(sheet.envX, r.entry.bb.maxX)
  sheet.envY = Math.max(sheet.envY, r.entry.bb.maxY)
  sheet.used += matArea
  sheet.ver++
}

function stat(sheets) {
  const last = sheets[sheets.length - 1]
  return {
    count: sheets.length,
    used: sheets.map(sh => sh.used),
    lastUsed: last ? last.used : 0,
    lastEnv: last ? last.envX * last.envY : 0,
  }
}
// Лучше — меньше листов. При равном числе листов — «фронтальная загрузка»:
// первый лист заполнен больше, при равенстве — второй и т.д. (лексикографически
// по занятой площади). Так лист набивается до предела, прежде чем начинается
// следующий, а остаток — один крупный обрезок на последнем листе.
export function exactBetter(a, b) {
  if (!b) return true
  if (a.count !== b.count) return a.count < b.count
  if (a.used && b.used) {
    for (let i = 0; i < a.count; i++) {
      const tol = Math.max(1, b.used[i] * 1e-4)
      if (Math.abs(a.used[i] - b.used[i]) > tol) return a.used[i] > b.used[i]
    }
    return true
  }
  const tol = Math.max(1, b.lastUsed * 1e-4)
  if (Math.abs(a.lastUsed - b.lastUsed) > tol) return a.lastUsed < b.lastUsed
  return a.lastEnv <= b.lastEnv + 1
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}
// Мутация «дожать первый лист»: деталь с более позднего листа переносится
// ближе к началу порядка — тогда она первой претендует на место на ранних
// листах, а вместо неё туда встаёт то, что раньше их занимало впустую.
function promote(order, laterIds) {
  const a = order.slice()
  const cand = a.map((x, i) => i).filter(i => laterIds.has(a[i].id))
  if (!cand.length) return perturb(order)
  const from = cand[Math.floor(Math.random() * cand.length)]
  const [piece] = a.splice(from, 1)
  const to = Math.floor(Math.random() * Math.max(1, Math.ceil(a.length * 0.6)))
  a.splice(to, 0, piece)
  return a
}
function perturb(order) {
  const a = order.slice()
  const swaps = 1 + Math.floor(Math.random() * 3)
  for (let s = 0; s < swaps; s++) {
    const i = Math.floor(Math.random() * a.length), j = Math.floor(Math.random() * a.length);
    [a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// Лист без указанных деталей (остальные остаются на своих местах).
function sheetWithout(sheet, removeIdx, usableX, usableY) {
  const next = newSheet(usableX, usableY)
  sheet.entries.forEach((e, i) => {
    if (removeIdx.has(i)) return
    const m = sheet.meta[i]
    next.entries.push(e); next.meta.push(m)
    next.envX = Math.max(next.envX, e.bb.maxX); next.envY = Math.max(next.envY, e.bb.maxY)
    next.used += m.area
    for (const c of polyCells(e.poly, next.cols, next.rows)) next.grid[c] = 1
  })
  return next
}

// «Разрушить и пересобрать» (ruin & recreate): у листа убираем несколько
// соседних деталей и заново укладываем их ВМЕСТЕ с деталями из пула (те, что
// пока лежат на следующих листах) — в случайном порядке, в любом повороте.
// Если лист вместил не меньше материала, чем раньше, перестановка принимается.
// Так первый лист «дожимается»: пустоты, в которые не влезала ещё одна деталь,
// собираются перестановкой соседей, а не остаются как есть.
async function fillSheet(sheet, pool, ctx, deadline) {
  const { usableX, usableY, kerf, direction } = ctx
  let iter = 0
  while (pool.length && Date.now() < deadline) {
    iter++
    const n = sheet.entries.length
    const k = Math.min(n, 1 + Math.floor(Math.random() * 5))
    // Центр «разрушения» — чаще в пустоте (там и не хватает материала до
    // полного листа), иногда в случайной точке.
    let cx = Math.random() * usableX, cy = Math.random() * usableY
    if (Math.random() < 0.7) {
      const free = []
      for (let i = 0; i < sheet.grid.length; i++) if (!sheet.grid[i]) free.push(i)
      if (free.length) {
        const c = free[Math.floor(Math.random() * free.length)]
        cx = (c % sheet.cols + 0.5) * CELL; cy = (Math.floor(c / sheet.cols) + 0.5) * CELL
      }
    }
    const order = sheet.entries.map((e, i) => ({ i, d: Math.hypot((e.bb.minX + e.bb.maxX) / 2 - cx, (e.bb.minY + e.bb.maxY) / 2 - cy) }))
      .sort((a, b) => a.d - b.d).slice(0, k).map(o => o.i)
    const removeIdx = new Set(order)
    const removed = order.map(i => sheet.meta[i].inst)
    const trial = sheetWithout(sheet, removeIdx, usableX, usableY)
    // Из пула пробуем не всё сразу (дорого), а несколько деталей разных
    // позиций заказа — крупные чаще; остальные ждут своей очереди.
    const seenKinds = new Set()
    const pick = pool.map(inst => ({ inst, w: inst.polyArea * (0.4 + Math.random()) }))
      .sort((a, b) => b.w - a.w)
      .filter(o => { const kd = o.inst.kind ?? o.inst.detailIndex; if (seenKinds.has(kd)) return false; seenKinds.add(kd); return true })
      .slice(0, 4).map(o => o.inst)
    const pickSet = new Set(pick)
    const cand = removed.concat(pick)
      .map(inst => ({ inst, w: inst.polyArea * (0.6 + 0.8 * Math.random()) }))
      .sort((a, b) => b.w - a.w).map(o => o.inst)
    const failed = []
    for (const inst of cand) {
      if (Date.now() > deadline || usableX * usableY - trial.used < inst.polyArea) { failed.push(inst); continue }
      const r = tryInsert(trial, inst, usableX, usableY, kerf, direction)
      if (r) commit(trial, inst, r); else failed.push(inst)
    }
    if (trial.used >= sheet.used - 1e-6) { sheet = trial; pool = pool.filter(x => !pickSet.has(x)).concat(failed) }
    if (iter % 2 === 0) await new Promise(res => setTimeout(res, 0))
  }
  return { sheet, pool }
}

// Последовательная укладка списка деталей (первый подходящий лист).
async function packSequential(list, ctx) {
  const { usableX, usableY, kerf, direction } = ctx
  const sheets = []
  for (const inst of list) {
    let placed = false
    for (const sheet of sheets) {
      if (usableX * usableY - sheet.used < inst.polyArea) continue
      const r = tryInsert(sheet, inst, usableX, usableY, kerf, direction)
      if (r) { commit(sheet, inst, r); placed = true; break }
    }
    if (!placed) {
      const sheet = newSheet(usableX, usableY)
      const r = tryInsert(sheet, inst, usableX, usableY, kerf, direction)
      if (!r) return null
      commit(sheet, inst, r)
      sheets.push(sheet)
    }
  }
  return sheets
}

// Дожимаем листы по очереди: первый до предела, остаток переукладывается на
// следующие, затем второй и т.д. Время делится между листами.
async function improveSheets(sheets, ctx, deadline) {
  let result = sheets.slice()
  for (let ti = 0; ti < result.length - 1 && Date.now() < deadline; ti++) {
    const pool = []
    for (let j = ti + 1; j < result.length; j++) result[j].meta.forEach(m => pool.push(m.inst))
    const sheetsLeft = result.length - 1 - ti
    const slice = Date.now() + (deadline - Date.now()) * (sheetsLeft > 1 ? 0.5 : 1)
    const { sheet, pool: rest } = await fillSheet(result[ti], pool, ctx, slice)
    const tail = rest.length ? await packSequential(rest.slice().sort((a, b) => b.polyArea - a.polyArea), ctx) : []
    if (tail === null) return sheets // страховка: остаток не уложился — возвращаем исходное
    result = result.slice(0, ti).concat([sheet], tail)
  }
  return result
}

// Итоговая проверка: ни одна деталь с последующих листов не должна
// помещаться на более ранний лист. Каждая такая деталь пробуется в каждом
// повороте с частой сеткой стартов (сверху и справа); если помещается —
// переезжает вперёд. Одинаковые детали (одна позиция заказа) на одном и том же
// состоянии листа не пробуются повторно.
async function sweepForward(sheets, ctx, deadline) {
  const { usableX, usableY, kerf, direction } = ctx
  let result = sheets.slice()
  for (let round = 0; round < 6 && Date.now() < deadline; round++) {
    let moved = false
    const ver = result.map(() => 0)
    const tried = new Set()
    for (let i = 0; i < result.length - 1 && Date.now() < deadline; i++) {
      for (let j = result.length - 1; j > i; j--) {
        const from = result[j]
        const removeIdx = new Set()
        for (let k = 0; k < from.meta.length; k++) {
          const inst = from.meta[k].inst
          const key = i + ':' + ver[i] + ':' + (inst.kind ?? inst.detailIndex)
          if (tried.has(key)) continue
          if (Date.now() > deadline) break
          if (usableX * usableY - result[i].used < inst.polyArea) { tried.add(key); continue }
          const r = tryInsert(result[i], inst, usableX, usableY, kerf, direction, true)
          if (r) { commit(result[i], inst, r); ver[i]++; removeIdx.add(k); moved = true } else tried.add(key)
        }
        if (removeIdx.size) result[j] = sheetWithout(from, removeIdx, usableX, usableY)
      }
    }
    result = result.filter(sh => sh.entries.length)
    if (!moved) break
  }
  return result
}

// Оптимизация обрезка: у последнего листа убираем несколько деталей (чаще —
// самых дальних от нуля, они и «съедают» обрезок) и укладываем заново; если
// все встали и свободный прямоугольник вырос (или не уменьшился при меньшем
// габарите) — перестановка принимается. Материала не добавляем и не убираем.
async function polishLast(sheet, ctx, deadline) {
  const { usableX, usableY, kerf, direction } = ctx
  const score = sh => ({ off: sheetOffcut(sh), env: sh.envX * sh.envY })
  const better = (a, b) => (Math.abs(a.off - b.off) > CELL * CELL ? a.off > b.off : a.env <= b.env)
  let cur = sheet, curS = score(cur)
  let best = cur, bestS = curS
  let iter = 0
  while (Date.now() < deadline && cur.entries.length > 1) {
    iter++
    const n = cur.entries.length
    const k = Math.min(n, 1 + Math.floor(Math.random() * 4))
    const ranked = cur.entries.map((e, i) => ({ i, d: e.bb.maxX + e.bb.maxY + Math.random() * 400 })).sort((a, b) => b.d - a.d)
    const seed = cur.entries[ranked[Math.floor(Math.random() * Math.min(4, n))].i]
    const cx = (seed.bb.minX + seed.bb.maxX) / 2, cy = (seed.bb.minY + seed.bb.maxY) / 2
    const idxs = cur.entries.map((e, i) => ({ i, d: Math.hypot((e.bb.minX + e.bb.maxX) / 2 - cx, (e.bb.minY + e.bb.maxY) / 2 - cy) }))
      .sort((a, b) => a.d - b.d).slice(0, k).map(o => o.i)
    const removed = idxs.map(i => cur.meta[i].inst)
      .map(inst => ({ inst, w: inst.polyArea * (0.6 + 0.8 * Math.random()) })).sort((a, b) => b.w - a.w).map(o => o.inst)
    const trial = sheetWithout(cur, new Set(idxs), usableX, usableY)
    let ok = true
    for (const inst of removed) {
      const r = tryInsert(trial, inst, usableX, usableY, kerf, direction)
      if (!r) { ok = false; break }
      commit(trial, inst, r)
    }
    if (ok) {
      const sc = score(trial)
      if (better(sc, curS)) {
        cur = trial; curS = sc
        if (Math.abs(sc.off - bestS.off) > 1 ? sc.off > bestS.off : sc.env < bestS.env) { best = trial; bestS = sc }
      }
    }
    if (iter % 2 === 0) await new Promise(res => setTimeout(res, 0))
  }
  return best
}

// ─── Парные детали ────────────────────────────────────────────────────────
// Две одинаковые вогнутые детали (Г, Т, ступенька) часто вкладываются друг в
// друга в идеальный прямоугольник: у Г-образных деталей с равными плечами
// пара даёт ровно прямоугольник. Но с резом kerf это вложение НЕ получается
// «пошаговой» укладкой у нуля листа: плечо и вырез одной ширины, и зазор реза
// требует, чтобы первая деталь стояла чуть выше пола (на kerf). Поэтому пара
// собирается ОТДЕЛЬНО — первая деталь смещена на kerf от угла, вторая
// заезжает в её вырез — и дальше укладывается как единый прямоугольник.
// Парой считаем только почти идеальное вложение (заполнение ≥ 97% габарита):
// иначе пустоты внутри пары не смогут занять другие детали.
// Порог снижен с 0.97 до 0.95: габарит пары включает зазор реза kerf по краю, и
// реальная пара Z-образных деталей 700×700 (мебельный реальный случай) даёт
// 0.962–0.970 — при 0.97 пара не собиралась, и 2 детали не помещались на лист.
const PAIR_MIN_DENSITY = 0.95

function buildPair(inst, kerf, usableX, usableY, dir = 'auto', deterministic = false) {
  const A = inst.variants[0]
  const areaA = polyArea(A.polygon)
  const sheet = newSheet(usableX, usableY)
  const spA = simplified(A)
  const eA = makeEntry(spA.poly.map(p => [p[0] + kerf, p[1] + kerf]), spA.pad)
  commit(sheet, inst, { entry: eA, variant: A, tx: kerf, ty: kerf })
  const r = tryInsert(sheet, inst, usableX, usableY, kerf, dir, true, deterministic)
  if (!r) return null
  const minX = Math.min(eA.bb.minX, r.entry.bb.minX), minY = Math.min(eA.bb.minY, r.entry.bb.minY)
  const maxX = Math.max(eA.bb.maxX, r.entry.bb.maxX), maxY = Math.max(eA.bb.maxY, r.entry.bb.maxY)
  const W = maxX - minX, H = maxY - minY
  if (W > usableX + 1e-6 || H > usableY + 1e-6) return null
  const density = (2 * areaA) / (W * H)
  return {
    density, W, H, matArea: 2 * areaA,
    parts: [
      { variant: A, ox: kerf - minX, oy: kerf - minY },
      { variant: r.variant, ox: r.tx - minX, oy: r.ty - minY },
    ],
  }
}

// ─── Раскладка сеткой для одинаковых пар ──────────────────────────────────
// tryInsert (жадная вставка по одной детали, см. ниже) даже с ЗАДАННЫМ
// порядком и заданным составом пар не гарантирует, что они лягут ЧИСТЫМИ
// колонками — она смотрит только на текущий лист по одной детали за раз, без
// взгляда на итоговую сетку. А задача при одинаковых деталях — классическая
// упаковка прямоугольников по сетке: N колонок «стоя» + M колонок «лёжа»,
// сколько именно — считается напрямую делением, без перебора. Так же (судя
// по геометрии) поступает эталонный раскрой конкурента — потому и уходит
// 3 секунды, а не 13: там не перебор, а арифметика.
function planGridTiling(tallWH, wideWH, kerf, usableX, usableY, need) {
  let best = null
  const maxTall = tallWH ? Math.floor((usableX + kerf) / (tallWH.w + kerf)) : 0
  for (let nt = 0; nt <= maxTall; nt++) {
    if (nt === 0 && !wideWH) continue
    const usedW = nt * (tallWH.w + kerf)
    const rowsTall = tallWH ? Math.floor((usableY + kerf) / (tallWH.h + kerf)) : 0
    const tallCap = nt * rowsTall
    let nw = 0, rowsWide = 0, wideCap = 0
    if (wideWH) {
      const remaining = usableX - usedW
      nw = Math.max(0, Math.floor((remaining + kerf) / (wideWH.w + kerf)))
      rowsWide = Math.floor((usableY + kerf) / (wideWH.h + kerf))
      wideCap = nw * rowsWide
    }
    const cap = tallCap + wideCap
    if (cap <= 0) continue
    const waste = cap - Math.min(cap, need)
    // Предпочитаем план, который закрывает нужное количество (или максимум,
    // если целиком не влезает) с наименьшим остатком вместимости впустую —
    // компактнее, оставляет больше места другим деталям на этом же листе.
    if (!best || Math.min(cap, need) > Math.min(best.cap, need) ||
        (Math.min(cap, need) === Math.min(best.cap, need) && waste < best.waste)) {
      best = { nt, rowsTall, nw, rowsWide, cap, waste }
    }
  }
  return best
}

function placeGridTiling(sheet, pairInstances, kerf, tallWH, wideWH, plan) {
  let idx = 0
  const place = (shape, x, y) => {
    if (idx >= pairInstances.length) return
    const inst = pairInstances[idx++]
    const variant = inst.variants.find(v => v.w === shape.w && v.h === shape.h) || inst.variants[0]
    const sp = simplified(variant)
    const entry = makeEntry(sp.poly.map(p => [p[0] + x, p[1] + y]), sp.pad)
    commit(sheet, inst, { entry, variant, tx: x, ty: y })
  }
  for (let c = 0; c < plan.nt && idx < pairInstances.length; c++) {
    const x = c * (tallWH.w + kerf)
    for (let r = 0; r < plan.rowsTall && idx < pairInstances.length; r++) place(tallWH, x, r * (tallWH.h + kerf))
  }
  const wideX0 = plan.nt * (tallWH ? tallWH.w + kerf : 0)
  for (let c = 0; c < plan.nw && idx < pairInstances.length; c++) {
    const x = wideX0 + c * (wideWH.w + kerf)
    for (let r = 0; r < plan.rowsWide && idx < pairInstances.length; r++) place(wideWH, x, r * (wideWH.h + kerf))
  }
}

// Строит один лист, заполненный сеткой пар (сколько влезло — остальные пары
// возвращаются в pool нетронутыми, для обычной укладки следующим листом).
function buildGridTilingSheet(pairInstances, kerf, usableX, usableY) {
  if (pairInstances.length < 2) return null
  const shapes = pairInstances[0].variants.filter(v => v.angle === 0)
  const tallWH = shapes.find(v => v.h > v.w)
  const wideWH = shapes.find(v => v.w > v.h)
  if (!tallWH && !wideWH) return null
  const plan = planGridTiling(tallWH, wideWH, kerf, usableX, usableY, pairInstances.length)
  if (!plan || plan.cap < 2) return null
  const sheet = newSheet(usableX, usableY)
  placeGridTiling(sheet, pairInstances, kerf, tallWH, wideWH, plan)
  return sheet
}

// После сетки пар (buildGridTilingSheet) наверху листа остаётся прямая
// прямоугольная полоса — если есть ДРУГОЙ вид детали, много одинаковых
// экземпляров, они почти всегда близки к прямоугольнику по форме (даже с
// небольшим вырезом/фаской) — их выгоднее сразу разложить туда сеткой
// рядов/колонок, а не отдавать жадному перебору по одной детали, который
// эту полосу заполняет заметно менее эффективно (см. реальный пример: 9 из
// 10 деталей влезали жадно, десятая уходила на второй лист, хотя места
// в полосе было в разы больше, чем нужно).
function fillStripWithSingles(sheet, group, kerf, usableX, usableY) {
  if (!group.length) return 0
  const v0 = group[0].variants[0]
  const bb0 = bboxOf(v0.polygon)
  const w = bb0.maxX - bb0.minX, h = bb0.maxY - bb0.minY
  const y0 = sheet.envY > 0 ? sheet.envY + kerf : 0
  const rows = Math.floor((usableY - y0 + kerf) / (h + kerf))
  const cols = Math.floor((usableX + kerf) / (w + kerf))
  if (rows < 1 || cols < 1) return 0
  const sp = simplified(v0)
  let idx = 0
  for (let r = 0; r < rows && idx < group.length; r++) {
    for (let c = 0; c < cols && idx < group.length; c++) {
      const x = c * (w + kerf), y = y0 + r * (h + kerf)
      const tx = x - bb0.minX, ty = y - bb0.minY
      const entry = makeEntry(sp.poly.map(p => [p[0] + tx, p[1] + ty]), sp.pad)
      commit(sheet, group[idx], { entry, variant: v0, tx, ty })
      idx++
    }
  }
  return idx
}

// Заменяет пары одинаковых вогнутых деталей составными «деталями-парами».
function tileIntoPairs(instances, kerf, usableX, usableY) {
  const byDetail = new Map()
  for (const inst of instances) {
    if (!byDetail.has(inst.detailIndex)) byDetail.set(inst.detailIndex, [])
    byDetail.get(inst.detailIndex).push(inst)
  }
  const out = []
  let nextId = instances.reduce((m, i) => Math.max(m, i.id), 0) + 1
  for (const group of byDetail.values()) {
    const first = group[0]
    const v0 = first.variants[0]
    const concave = polyArea(v0.polygon) < 0.97 * v0.w * v0.h
    // Две одинаковые вогнутые детали вкладываются друг в друга НЕ одним способом:
    // сдвиг вдоль Y (пара «стоит», ~704×1036) и сдвиг вдоль X (пара «лежит»,
    // ~1038×704). Раньше собиралась только одна ориентация (auto), и при
    // выключенном вращении «лежачих» пар не было вообще — лист нельзя было
    // заполнить (5 «стоячих» пар в ширину 1820 мм не входят, а «лежачая» —
    // входит рядом с двумя «стоячими»). Собираем обе, пакер выбирает сам.
    const pairs = []
    if (group.length >= 2 && concave && !first.isSmall) {
      // Выбор между «почти равноценными» кандидатами внутри tryInsert случайный
      // (нужен поиску порядка), а для пары нужны ОБЕ ориентации стабильно —
      // поэтому несколько детерминированных попыток и несколько случайных.
      const dirs = ['auto', 'along_y', 'along_x']
      for (let attempt = 0; attempt < 12 && pairs.length < 2; attempt++) {
        const p = buildPair(first, kerf, usableX, usableY, dirs[attempt % 3], attempt < 3)
        if (!p || p.density < PAIR_MIN_DENSITY) continue
        if (pairs.some(q => Math.abs(q.W - p.W) < 2 && Math.abs(q.H - p.H) < 2)) continue
        pairs.push(p)
      }
    }
    if (!pairs.length) { out.push(...group); continue }
    const rotatable = first.variants.length > 2
    const rect = (w, h) => [[0, 0], [w, 0], [w, h], [0, h]]
    const variants = []
    for (const pair of pairs) {
      variants.push({ angle: 0, w: pair.W, h: pair.H, polygon: rect(pair.W, pair.H), matArea: pair.matArea, parts: pair.parts, W: pair.W })
      // 90° — только если у детали включено вращение (и пара так помещается)
      if (rotatable && pair.H <= usableX && pair.W <= usableY) {
        variants.push({ angle: 90, w: pair.H, h: pair.W, polygon: rect(pair.H, pair.W), matArea: pair.matArea, parts: pair.parts, W: pair.W })
      }
    }
    const pair = pairs[0]
    const n = Math.floor(group.length / 2)
    for (let k = 0; k < n; k++) {
      out.push({
        id: nextId++, detailIndex: first.detailIndex, kind: 'pair' + first.detailIndex, isComposite: true,
        src: first, parts: pair.parts, W: pair.W, H: pair.H, matArea: pair.matArea,
        variants, area: pair.W * pair.H, cellSize: first.cellSize, isSmall: false,
        label: first.label, prefix: first.prefix,
      })
    }
    if (group.length % 2) out.push(group[group.length - 1])
  }
  return out
}

/**
 * Разворачивает размещение «детали-пары» в две настоящие детали (для
 * обычных деталей возвращает их же). Результат: [{ inst, variant, x, y }].
 */
export function expandPlacement(m) {
  const inst = m.inst
  if (!inst.isComposite) return [m]
  const ang = m.variant.angle // 0 или 90
  // Разные ориентации пары («стоит»/«лежит») хранят свои parts и W в варианте.
  const parts = m.variant.parts || inst.parts, W = m.variant.W ?? inst.W
  return parts.map(part => {
    let pts = part.variant.polygon.map(([px, py]) => [px + part.ox, py + part.oy])
    if (ang === 90) pts = pts.map(([x, y]) => [y, W - x])
    const bb = bboxOf(pts)
    const v = inst.src.variants.find(vv => vv.angle === (part.variant.angle + ang) % 360)
    const vb = bboxOf(v.polygon)
    return { inst: inst.src, variant: v, x: m.x + bb.minX - vb.minX, y: m.y + bb.minY - vb.minY }
  })
}

/**
 * Возвращает { sheets, stat } или null, если не успели уложить все детали.
 * sheets[i].meta[k] = { inst, variant, x, y } (x,y — сдвиг локального контура).
 */
export async function packExact({ instances, kerf, usableX, usableY, direction, deadline }) {
  const t0 = Date.now()
  const T = Math.max(1, deadline - t0)
  const searchDeadline = t0 + T * 0.3 // остальное — «дожим» листов
  instances = tileIntoPairs(instances, kerf, usableX, usableY)
  instances.forEach(i => { i.polyArea = i.matArea ?? polyArea(i.variants[0].polygon) })
  // «Плотность» детали = площадь контура / площадь габарита. Сплошные
  // прямоугольники укладываются почти без потерь, вогнутые (Г, Т, дуги) —
  // всегда оставляют пустоты. Чтобы ПЕРВЫЕ листы были забиты максимально,
  // сплошные детали идут первыми, а вогнутые — в хвост, на последний лист,
  // где потери уже не важны.
  instances.forEach(i => { i.solid = i.polyArea / Math.max(1, i.variants[0].w * i.variants[0].h) })
  const bySolidThenArea = (a, b) => (Math.abs(b.solid - a.solid) > 0.02 ? b.solid - a.solid : b.area - a.area)
  const orders = [
    instances.slice().sort((a, b) => b.area - a.area),
    instances.slice().sort(bySolidThenArea),
    instances.slice().sort((a, b) => Math.max(b.variants[0].w, b.variants[0].h) - Math.max(a.variants[0].w, a.variants[0].h)),
  ]
  // Сцепка (см. tileIntoPairs) на каждую конкретную укладку динамически
  // выбирает ориентацию "стоя"/"лёжа" (обе — варианты одной composite-
  // детали) — жадный перебор решает это по ходу дела, без взгляда вперёд, и
  // может не попасть в то сочетание, которое реально закрывает лист (по
  // эталонному раскрою конкурента — 2 "стоя" + 3 "лёжа" на 5 пар). Явно
  // перебираем ВСЕ сочетания (сколько пар идёт первой, "нестандартной"
  // ориентацией variants[1]/[0]) — для типичного числа одинаковых пар (3-8)
  // это considerablyдёшево (десяток детерминированных попыток), а раньше
  // такое сочетание могло найтись только случайно, если повезёт.
  const pairGroups = new Map()
  instances.forEach(inst => { if (inst.isComposite) { if (!pairGroups.has(inst.kind)) pairGroups.set(inst.kind, []); pairGroups.get(inst.kind).push(inst) } })
  for (const group of pairGroups.values()) {
    if (group.length < 2 || group[0].variants.length < 2) continue
    const rest = instances.filter(i => !group.includes(i))
    for (let k = 1; k < group.length; k++) {
      // первые k инстансов пары — только "вторая" ориентация (variants[1]),
      // остальные — только "первая" (variants[0]); порядок площадей сверху
      // (крупное вперёд) как в основных структурных попытках.
      const forced = group.map((inst, idx) => ({
        ...inst, variants: idx < k ? [inst.variants[1] ?? inst.variants[0]] : [inst.variants[0]],
      }))
      // Крупные детали — вперёд (см. общую философию сортировки orders выше):
      // сцепки такого типа обычно самые крупные, поэтому идут первыми.
      orders.push(forced.concat(rest.slice().sort((a, b) => b.area - a.area)))
    }
  }
  let best = null, bestStat = null, bestOrder = null
  let seededOrders = [] // [{ order, seedSheets }] — гарантированные кандидаты с сеткой пар
  for (const group of pairGroups.values()) {
    if (group.length < 2) continue
    const sheet = buildGridTilingSheet(group, kerf, usableX, usableY)
    if (!sheet) continue
    const placedIds = new Set(sheet.meta.map(m => m.inst.id))
    // Полоса, оставшаяся сверху над сеткой пар — сразу же сеткой докладываем
    // туда другие детали (не участвовавшие в сцепке: одиночные, другого
    // вида), группами по detailIndex, от крупных к мелким.
    const remaining = instances.filter(i => !placedIds.has(i.id))
    const byType = new Map()
    for (const inst of remaining) { if (!byType.has(inst.detailIndex)) byType.set(inst.detailIndex, []); byType.get(inst.detailIndex).push(inst) }
    const typeGroups = [...byType.values()].sort((a, b) => (b[0].variants[0].w * b[0].variants[0].h) - (a[0].variants[0].w * a[0].variants[0].h))
    for (const g of typeGroups) {
      const n = fillStripWithSingles(sheet, g, kerf, usableX, usableY)
      if (n > 0) g.splice(0, n)
    }
    const rest = typeGroups.flat()
    seededOrders.push({
      order: rest.slice().sort((a, b) => b.area - a.area),
      seedSheets: [sheet],
    })
  }
  // Кандидат «с плотным первым листом»: на 1 лист больше, чем у лучшего, но
  // первый лист забит сильнее (например, сплошные прямоугольники вперёд) —
  // после «дожима» такой вариант часто выигрывает у лучшего по числу листов.
  let front = null, frontStat = null, frontOrder = null
  let laterIds = new Set()
  const consider = async (order, dl, stable = false, seedSheets = null) => {
    const sheets = await packOrder(order, usableX, usableY, kerf, direction, dl, stable, seedSheets)
    if (!sheets) return
    const st = stat(sheets)
    if (exactBetter(st, bestStat)) {
      best = sheets; bestStat = st; bestOrder = order
      laterIds = new Set(sheets.slice(1).flatMap(sh => sh.meta.map(m => m.inst.id)))
    }
    if (st.count > 1 && (!frontStat || st.used[0] > frontStat.used[0] + 1)) { front = sheets; frontStat = st; frontOrder = order }
  }
  // Первые (структурные) порядки — обязаны дойти до конца: без них точной
  // укладки нет вовсе, поэтому им отводится весь бюджет, а не его половина.
  // stable=true — без монетки между "почти равноценными" позициями (см.
  // комментарий у packOrder): раз порядок деталей детерминирован, вся
  // раскладка тоже обязана быть воспроизводимой, а не зависеть от Math.random.
  // Сеточные кандидаты — первыми: если раскладка сеткой сама по себе
  // закрывает лист, дальше можно вообще не искать структурный порядок.
  for (const so of seededOrders) { if (Date.now() < deadline) await consider(so.order, deadline, true, so.seedSheets) }
  for (const o of orders) { if (Date.now() < deadline) await consider(o, deadline, true) }
  let guard = 0
  // Если всё уложено на один лист, порядок дальше не ищем — оставшееся время
  // уходит на сборку одного делового обрезка (см. polishLast ниже).
  while (Date.now() < searchDeadline && bestOrder && instances.length > 1 && guard++ < 500 && bestStat.count > 1) {
    const r = Math.random()
    const base = (frontOrder && Math.random() < 0.3) ? frontOrder : bestOrder
    await consider(r < 0.1 ? shuffle(instances.slice()) : r < 0.6 ? promote(base, laterIds) : perturb(base), searchDeadline)
  }
  if (!best) return null
  // Дожим: каждый лист по очереди набивается до предела перестановкой соседей
  // и деталями со следующих листов. Дожимаются два кандидата: лучший по числу
  // листов и «с плотным первым листом» (если он заметно плотнее).
  if (best.length > 1 && Date.now() < deadline) {
    const ctx = { usableX, usableY, kerf, direction }
    const copy = sheets => sheets.map(sh => sheetWithout(sh, new Set(), usableX, usableY))
    const list = [best]
    if (front && front !== best && frontStat.count <= bestStat.count + 1 && frontStat.used[0] > bestStat.used[0] + usableX * usableY * 0.03) list.push(front)
    const improveEnd = deadline - T * 0.15 // последние 15% времени — итоговая сверка
    const tStart = Date.now()
    let winner = { sheets: best, st: bestStat }
    for (let ci = 0; ci < list.length; ci++) {
      const share = tStart + (improveEnd - tStart) * (ci + 1) / list.length
      let improved = await improveSheets(copy(list[ci]), ctx, share)
      improved = await sweepForward(improved, ctx, Math.min(deadline, share + (deadline - improveEnd) / list.length))
      const st = stat(improved)
      if (exactBetter(st, winner.st)) winner = { sheets: improved, st }
    }
    best = winner.sheets; bestStat = winner.st
    // «Усадка + довставка»: стягиваем каждый лист по-настоящему (все детали,
    // не только последнюю) и пробуем довставить в освободившееся место
    // детали со следующих листов — пока помещается. Отдельно от improveSheets:
    // там перебор случайный и по грубой оценке (trapped area на сетке), здесь —
    // точная стяжка контуров, как в вашем примере с песком.
    if (Date.now() < deadline) {
      const settled = await settleAndPull(copy(best), ctx, deadline)
      const st = stat(settled)
      if (exactBetter(st, bestStat)) { best = settled; bestStat = st }
    }
  }
  // Оптимизация обрезка на последнем листе — до конца таймера.
  if (Date.now() < deadline) {
    const ctx = { usableX, usableY, kerf, direction }
    const lastIdx = best.length - 1
    const start = sheetWithout(best[lastIdx], new Set(), usableX, usableY)
    const polished = await polishLast(start, ctx, deadline)
    const cand = best.slice(0, lastIdx).concat([polished])
    const st = stat(cand)
    if (exactBetter(st, bestStat)) { best = cand; bestStat = st }
  }
  return { sheets: best, stat: bestStat }
}
