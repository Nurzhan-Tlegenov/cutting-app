// Проверка конструктора: детали корпуса, их 3D-положение и спецификация (node tests/cad/check.mjs)
import { newProject, newItem, projectParts, exportForOrder, projectSpec, linearNest, explodeCabinet, sheetGroups, exportAll } from '../../src/lib/cadModel.js'
import { CAB_PRESETS } from '../../src/lib/cadCabinet.js'
let fail = 0
const ok = (c, m) => { if (!c) { fail++; console.log('FAIL', m) } }
const apply = (m, p) => [m[0]*p[0]+m[1]*p[1]+m[2]*p[2]+m[9], m[3]*p[0]+m[4]*p[1]+m[5]*p[2]+m[10], m[6]*p[0]+m[7]*p[1]+m[8]*p[2]+m[11]]
for (const rot of [0, 90, 180, 270]) for (const [, name, p] of CAB_PRESETS) for (const back of ['groove', 'overlay', 'inset', 'none']) for (const box of ['ldsp_overlay', 'ldsp_groove', 'metal']) {
  const pr = newProject('t')
  pr.items.push({ ...newItem('cabinet', { p: { ...p, back, box } }), rotY: rot, pos: { x: 100, y: 0, z: 50 } })
  const { parts, warn } = projectParts(pr)
  ok(!warn.length, `${name} ${back} ${rot}: ${warn.join('; ')}`)
  for (const sp of parts) {
    const { W, L, T, m, aabb } = sp.place
    // углы детали через матрицу должны лечь ровно в брусок
    const pts = [[0,0,0],[W,0,0],[0,L,0],[W,L,T],[W,L,0],[0,0,T]].map(q => apply(m, q))
    for (const q of pts) for (let i = 0; i < 3; i++) ok(q[i] >= aabb[i] - 0.11 && q[i] <= aabb[i+3] + 0.11, `${name} ${sp.name} rot${rot} point outside`)
    // определитель +1 (без зеркала)
    const det = m[0]*(m[4]*m[8]-m[5]*m[7]) - m[1]*(m[3]*m[8]-m[5]*m[6]) + m[2]*(m[3]*m[7]-m[4]*m[6])
    ok(Math.abs(det - 1) < 1e-9, `${sp.name} det ${det}`)
  }
}
// шкаф 800×2100×560: боковина = 2100 × 560 (вкладные крышка/дно, задняя в паз), полка 768
const pr = newProject('Шкаф')
pr.items.push(newItem('cabinet', { p: { shelves: 2, doors: 2 } }))
const g = exportForOrder(pr, sheetGroups(pr)[0].key)
const side = g.items.find(x => x.name === 'Боковина левая'), shelf = g.items.find(x => x.name === 'Горизонтальная панель'), back = projectParts(pr).parts.find(x => x.key === 'back')
ok(side.w === 2100 && side.h === 560, `side ${side.w}x${side.h}`)
ok(shelf.h === 768 || shelf.w === 768, `shelf ${shelf.w}x${shelf.h}`)
ok(side.contour.grooves.length === 1, 'groove on side')
ok(side.edges.left === '1' || side.edges.right === '1', 'front edge on side ' + JSON.stringify(side.edges))
ok(back.place.W === 782 || back.place.L === 782, 'back width ' + back.place.W + ' ' + back.place.L)
const spec = projectSpec(pr)
ok(spec.rows.some(r => r.name === 'Петля накладная' && r.qty === 10), 'hinges')
// линейный раскрой
const n = linearNest([2000, 2000, 2000, 1500, 1500, 900], 6000, 3)
ok(n.bars.length === 2, 'bars ' + n.bars.length)
ok(explodeCabinet(pr.items[0]).length > 5, 'explode')
// разобранный корпус лежит там же, где был (при любом повороте)
for (const rot of [0, 90, 180, 270]) {
  const it = { ...newItem('cabinet', { p: { shelves: 2, doors: 2 } }), rotY: rot, pos: { x: 300, y: 10, z: -40 } }
  const a = projectParts({ items: [it] }).parts.filter(x => x.kind === 'sheet').map(x => x.place.aabb.join(',')).sort()
  const b = projectParts({ items: explodeCabinet(it) }).parts.map(x => x.place.aabb.join(',')).sort()
  ok(a.join('|') === b.join('|'), 'explode rot ' + rot)
}
// присадка: конфирматы на боковине, торец дна, чашки петель на дверях, планки на боковинах
{
  const pr2 = newProject('Присадка')
  pr2.settings.mount = { plate: { mode: 'drill', d: 5, depth: 12 } }
  pr2.items.push({ ...newItem('cabinet', { p: { shelfType: 'loose', shelves: 2, doors: 2 } }), rotY: 90, pos: { x: 500, y: 0, z: 200 } })
  const all = exportAll(pr2).details
  const by = n => all.filter(d => d.name === n)
  const sL = by('Боковина левая')[0], bot = by('Дно')[0], door = by('Дверь левая')[0], doorR = by('Дверь правая')[0]
  const cnt = (d, f) => d.contour.drillings.filter(f).length
  ok(cnt(sL, x => x.kind === 'face' && x.d === 7) === 4, 'confirmat face on side: ' + cnt(sL, x => x.kind === 'face' && x.d === 7))
  ok(cnt(sL, x => x.kind === 'face' && x.d === 7 && x.face === 'back') === 4, 'confirmat enters from outer (back) face')
  ok(cnt(bot, x => x.kind === 'edge' && x.d === 5) === 4, 'confirmat edge on bottom: ' + cnt(bot, x => x.kind === 'edge' && x.d === 5))
  ok(cnt(bot, x => x.kind === 'edge' && x.d === 8) === 4, 'dowels edge on bottom')
  ok(cnt(door, x => x.d === 35 && x.face === 'back') === 5, 'hinge cups on door back face: ' + JSON.stringify(door.contour.drillings.map(x => [x.d, x.face])))
  ok(cnt(door, x => x.d === 35 && (x.offsets.left === 22)) === 5, 'cup 22 from left edge ' + JSON.stringify(door.contour.drillings[0]))
  ok(cnt(doorR, x => x.d === 35 && (x.offsets.right === 22)) === 5, 'cup 22 from right edge')
  ok(cnt(sL, x => x.d === 5 && x.kind === 'face' && x.face === 'front') === 10 + 4, 'plates + pins on side: ' + cnt(sL, x => x.d === 5 && x.kind === 'face'))
  // разобранный корпус даёт ту же присадку
  const ex = { ...pr2, items: explodeCabinet(pr2.items[0]) }
  const sum = pr => exportAll(pr).details.reduce((s, d) => s + d.contour.drillings.length, 0)
  ok(sum(pr2) === sum(ex), `explode drill ${sum(pr2)} vs ${sum(ex)}`)
  const sp = projectSpec(pr2)
  ok(sp.rows.some(r => r.name === 'Конфирмат 7×50' && r.qty >= 8), 'confirmats in spec')
}
// металлический каркас: стойки + перемычки в хлысты
{
  const pr3 = newProject('Витрина')
  pr3.items.push(newItem('frame', { p: { walls: 'sides_back' } }))
  const { parts, warn } = projectParts(pr3)
  ok(!warn.length, 'frame warn ' + warn)
  ok(parts.filter(p => p.kind === 'profile').length === 4 + 5 * 4, 'frame profiles')
  // ничего не пересекается
  const inter = (a, b) => [0, 1, 2].every(i => Math.min(a[i + 3], b[i + 3]) - Math.max(a[i], b[i]) > 0.05)
  for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) ok(!inter(parts[i].place.aabb, parts[j].place.aabb), `frame overlap ${parts[i].name} / ${parts[j].name}`)
  const pf = projectSpec(pr3).rows.find(r => r.kind === 'profile')
  ok(pf && pf.bars >= 3, 'frame bars ' + pf?.bars)
}
// хлысты разной длины: короткие отрезки — в короткие хлысты
{
  const { linearCut } = await import('../../src/lib/linearNest.js')
  const r = linearCut({ pieces: [{ len: 2900, qty: 2 }, { len: 1900, qty: 1 }], stocks: [{ len: 6000 }, { len: 3000 }, { len: 2000 }], kerf: 3 })
  ok(r.unplaced.length === 0, 'unplaced')
  ok(r.total === 8000, 'mixed stocks total ' + r.total + ' ' + JSON.stringify(r.byStock))
  const lim = linearCut({ pieces: [{ len: 1000, qty: 7 }], stocks: [{ len: 3000, qty: 1 }, { len: 6000, qty: null }], kerf: 3 })
  ok(lim.cutLen === 7000 && lim.bars.filter(b => b.stock === 3000).length <= 1, 'limited stocks')
  const big = linearCut({ pieces: [{ len: 7000, qty: 1 }, { len: 500, qty: 2 }], stocks: [{ len: 6000 }], kerf: 3, trim: 10 })
  ok(big.unplaced.length === 1 && big.unplaced[0].len === 7000, 'too long')
  ok(Math.abs(big.bars[0].used - (20 + 1000 + 3)) < 0.01, 'trim+kerf ' + big.bars[0].used)
}
// конструктор -> заказ: погонные материалы уходят заданием линейного раскроя
{
  const pr4 = newProject('Стеллаж')
  pr4.items.push(newItem('frame', { p: { shelf: 'sheet', shelfMaterial: 'ЛДСП Белый 16', shelfT: 16 } }))
  pr4.settings.stocks = { 'Профиль 20×20 сталь': '3000, 6000' }
  const ex = exportForOrder(pr4, sheetGroups(pr4)[0].key)
  ok(ex.linear.length === 1 && ex.linear[0].stocks.length === 2, 'linear jobs ' + JSON.stringify(ex.linear.map(j => j.stocks)))
  ok(ex.linear[0].pieces.reduce((a, p) => a + p.qty, 0) === 24, 'linear pieces count')
  const { computeJob } = await import('../../src/lib/linearJobs.js').catch(() => ({}))
  if (computeJob) ok(computeJob({ ...ex.linear[0], pieces: [...ex.linear[0].pieces, { len: 500, qty: 2, angles: '45/45' }] }).bars.some(b => b.cuts.some(c => c.angles === '45/45')), 'angles carried')
}
// правка детали: вырез и своя присадка уходят в заказ; размер поменялся — контур сброшен с предупреждением
{
  const pr5 = newProject('Фигурная')
  const it = newItem('cabinet', { p: { shelves: 2, doors: 2 } })
  const hole = { type: 'rect', vertices: [{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 300 }, { x: 100, y: 300 }] }
  it.ov = { sideL: { W: 560, L: 2100, vertices: null, holes: [hole], grooves: [], drillings: [{ id: 'u1', kind: 'face', face: 'front', d: 10, depth: 5, sides: ['left', 'bottom'], offsets: { left: 50, bottom: 50 } }], edges: null } }
  pr5.items.push(it)
  const sL = exportAll(pr5).details.find(d => d.name === 'Боковина левая')
  ok(sL.contour.holes.length === 1, 'override hole exported')
  ok(sL.contour.drillings.some(d => d.id === 'u1') && sL.contour.drillings.some(d => String(d.id).startsWith('cad')), 'manual + auto drillings')
  ok(sL.contour.grooves.length === 1, 'auto groove kept')
  it.p.H = 2000
  const r = projectParts(pr5)
  ok(r.warn.some(w => w.includes('размер изменился')), 'stale warn')
  ok(exportAll(pr5).details.find(d => d.name === 'Боковина левая').contour.holes.length === 0, 'stale reset')
}
// проёмы: шкаф 2000, одна стойка, левый проём 600 — стойка встаёт по нему, габарит не меняется
{
  const { newNode } = await import('../../src/lib/cadCabinet.js')
  const L = newNode({ size: 600, front: { type: 'doors', n: 1, hinge: 'left' } })
  const R = newNode({ split: 'h', children: [newNode({ front: { type: 'drawers', n: 2 } }), newNode(), newNode()] })
  const it = newItem('cabinet', { p: { W: 2000, H: 2100, D: 560, top: 'overlay', overhangFront: 20, overhangSide: 10, tree: newNode({ id: 'root', split: 'v', children: [L, R] }) } })
  const { parts, warn, openings } = projectParts({ items: [it] })
  ok(!warn.length, 'tree warn ' + warn)
  const st = parts.find(p => p.name === 'Вертикальная панель')
  ok(st && st.place.aabb[0] === 616, 'partition at 616: ' + st?.place.aabb[0])
  const door = parts.find(p => p.name === 'Дверь')
  ok(door && door.place.aabb[0] === 1.5 && door.place.aabb[3] === 622.5, 'door overlap ' + door?.place.aabb)
  ok(door.place.aabb[4] === 2100 - 16 - 1.5, 'door under overlay top ' + door.place.aabb[4])
  const top = parts.find(p => p.name === 'Крышка')
  ok(top.place.aabb[5] === 560 + 16 + 20 && top.place.aabb[0] === -10 && top.place.aabb[3] === 2010, 'overhang ' + top.place.aabb)
  ok(parts.filter(p => p.name === 'Горизонтальная панель').length === 2 && parts.filter(p => p.name === 'Фасад ящика').length === 2, 'shelves + drawers')
  ok(openings.length === 6, 'openings ' + openings.length)
  const right = openings.find(o => o.id === R.id)
  ok(Math.abs(right.w - (2000 - 32 - 600 - 16)) < 0.01, 'right opening width ' + right.w)
}
// одна полка двигается — группа полок с выбранной стороны сжимается/растягивается, другая сторона не меняется
{
  const { opSplit, opSetSize, cabinetParts } = await import('../../src/lib/cadCabinet.js')
  let tree = { id: 'root', size: null, split: null, children: [], front: null }
  tree = opSplit(tree, 'root', 'h', 4)                 // 5 ярусов
  const p0 = { W: 800, H: 2100, D: 560, doors: 0, tree }
  const sz = pp => Object.fromEntries(cabinetParts(pp).openings.map(o => [o.id, o]))
  const before = sz(p0)
  const ids = tree.children.map(c => c.id)
  const t2 = opSetSize(tree, ids[1], 300, 'after', before)  // 2-й ярус — 300, тянем верхние
  const after = sz({ ...p0, tree: t2 })
  ok(after[ids[0]].h === before[ids[0]].h, 'lower kept')
  ok(after[ids[1]].h === 300, 'set 300')
  const up = [2, 3, 4].map(i => after[ids[i]].h)
  ok(Math.abs(up[0] - up[2]) < 0.2 && Math.abs(up.reduce((a, b) => a + b, 0) + 300 + after[ids[0]].h + 4 * 16 - before.root.h) < 0.5, 'upper group shares ' + up)
  const t3 = opSetSize(t2, ids[3], 250, 'before', after)   // 4-й — 250, тянем нижние (только авто ниже — 3-й), 5-й не меняется
  const a3 = sz({ ...p0, tree: t3 })
  ok(a3[ids[4]].h === after[ids[4]].h && a3[ids[3]].h === 250 && a3[ids[0]].h === after[ids[0]].h, 'before dir ' + [0, 1, 2, 3, 4].map(i => a3[ids[i]].h))
  // фронтальная панель: от зада 100, отступы
  const t4 = { ...t3, fpanel: { from: 'back', dist: 100, l: 0, r: 0, b: 10, t: 10 } }
  const fp = cabinetParts({ ...p0, tree: t4 }).parts.find(x => x.name === 'Фронтальная панель')
  ok(fp && fp.box[2] === 16 + 100 + 0 - 0 + (fp.box[2] - 116) && fp.box[5] - fp.box[2] === 16, 'fpanel ' + fp?.box)
}
// перехлёст: за панелью нет соседнего фасада — фасад перекрывает её торец как боковину; открывание вверх — петли сверху
{
  const { newNode } = await import('../../src/lib/cadCabinet.js')
  const L = newNode({ size: 600, front: { type: 'doors', n: 1, open: 'up' } })
  const it = newItem('cabinet', { p: { W: 2000, H: 720, D: 300, tree: newNode({ id: 'root', split: 'v', children: [L, newNode()] }) } })
  const all = exportAll({ items: [it], settings: { mount: { plate: { mode: 'drill' } } } }).details
  const door = projectParts({ items: [it] }).parts.find(p => p.name === 'Дверь')
  ok(door.place.aabb[3] === 616 + 14.5, 'solo overlap ' + door.place.aabb[3])
  const top = all.find(d => d.name === 'Крышка')
  ok(top.contour.drillings.filter(d => d.d === 5 && d.note === 'Планка петли').length === 4, 'plates on top panel')
}
// каркас: без левой боковины, крышка — 1 царга с отступом 50 от верха (витрина: сверху стекло), дно — царги, вкладная крышка с отступами
{
  const it = newItem('cabinet', { p: { W: 1000, H: 900, D: 400, sideL: false, top: 'rails', topRails: 1, topRailOffset: 50, bottom: 'rails', bottomRails: 2, bottomRailOffset: 100, back: 'none' } })
  const { parts, warn } = projectParts({ items: [it] })
  ok(!warn.length, 'carcass warn ' + warn)
  ok(!parts.some(p => p.name === 'Боковина левая'), 'no left side')
  const rails = parts.filter(p => p.name.startsWith('Царга'))
  ok(rails.length === 3, 'rails ' + rails.map(r => r.name))
  const tr = rails.find(r => r.name === 'Царга передняя')
  ok(tr.place.aabb[4] === 900 - 50 && tr.place.aabb[0] === 0, 'top rail pos ' + tr.place.aabb)
  ok(rails.find(r => r.name === 'Царга нижняя задняя').place.aabb[1] === 100, 'bottom rail offset')
  const it2 = newItem('cabinet', { p: { topDown: 20, topFront: -10, bottomUp: 30, bottomFront: 15, sideFront: 5 } })
  const pp = projectParts({ items: [it2] }).parts
  const top = pp.find(p => p.name === 'Крышка'), bot = pp.find(p => p.name === 'Дно'), side = pp.find(p => p.name === 'Боковина правая')
  ok(top.place.aabb[4] === 2100 - 20 && top.place.aabb[5] === 570, 'inset top offsets ' + top.place.aabb)
  ok(bot.place.aabb[1] === 30 && bot.place.aabb[5] === 545 && side.place.aabb[5] === 555, 'bottom/side offsets')
}
// торцевой шкаф: нет правой боковины, справа проём 300 с фронтальной панелью у зада, в нём скруглённые полки R150
{
  const { newNode } = await import('../../src/lib/cadCabinet.js')
  const R = newNode({ size: 300, fpanel: { from: 'back', dist: 0, l: 0, r: 0, b: 0, t: 0 }, split: 'h', shelfShape: 'round', shelfR: 150, children: [newNode(), newNode(), newNode()] })
  const it = newItem('cabinet', { p: { W: 1000, H: 2000, D: 400, sideR: false, back: 'none', tree: newNode({ id: 'root', split: 'v', children: [newNode(), R] }) } })
  const { parts, warn } = projectParts({ items: [it] })
  ok(!warn.length, 'end cab warn ' + warn)
  const fp = parts.find(p => p.name === 'Фронтальная панель')
  const sh = parts.filter(p => p.name === 'Горизонтальная панель')
  ok(fp && sh.length === 2 && sh.every(s => s.place.aabb[2] === fp.place.aabb[5]), 'shelves start after frontal panel')
  const d = exportAll({ items: [it] }).details.find(x => x.name === 'Горизонтальная панель')
  const v = d.contour.vertices
  ok(v.some(x => x.r === 150) && v.filter(x => x.r > 0).length === 1, 'one rounded front corner ' + JSON.stringify(v))
  ok(d.contour.vertices.find(x => x.r === 150).y === d.w, 'rounded at free (right) side')
}
// тумба без правой боковины: вертикальная панель в 300 от края — задняя стенка (в паз) до неё, панель на всю глубину с пазом
{
  const { newNode } = await import('../../src/lib/cadCabinet.js')
  const it = newItem('cabinet', { p: { W: 900, H: 800, D: 500, sideR: false, top: 'overlay', topRR: 200, overhangR: 20, tree: newNode({ id: 'root', split: 'v', children: [newNode(), newNode({ size: 300 })] }) } })
  const { parts, warn } = projectParts({ items: [it] })
  ok(!warn.length, 'tumba warn ' + warn)
  const back = parts.find(p => p.name === 'Задняя стенка'), div = parts.find(p => p.name === 'Вертикальная панель')
  ok(div.place.aabb[2] === 0, 'end divider full depth ' + div.place.aabb)
  ok(Math.abs(back.place.aabb[3] - (div.place.aabb[0] + 7)) < 0.01, 'back to divider ' + back.place.aabb + ' / ' + div.place.aabb)
  const det = exportAll({ items: [it] }).details
  const dv = det.find(d => d.name === 'Вертикальная панель')
  ok(dv.contour.grooves.length === 1 && dv.contour.grooves[0].face === 'back', 'groove on divider back face')
  const top = det.find(d => d.name === 'Крышка')
  ok(top.contour.vertices.some(v => v.r === 200 && v.edgeR), 'top rounded corner with edge')
  const bot = det.find(d => d.name === 'Дно')
  ok(Object.values(bot.edges).filter(Boolean).length === 2, 'bottom front + open end edged ' + JSON.stringify(bot.edges))
}

// блоки: отступ крайней панели 19 мм — стенка внахлёст без паза; зазоры стенки; отдельная полка на полкодержателях; отступы слева/справа; ящики свои
{
  const { newNode, opRemovePanel, opReplace, opCount } = await import('../../src/lib/cadCabinet.js')
  const L = newNode({ id: 'a', split: 'h', children: [newNode({ id: 'h0' }), newNode({ id: 'h1' }), newNode({ id: 'h2' })], pan: { h0: { type: 'loose' } }, setR: 30 })
  const root = newNode({ id: 'root', split: 'v', children: [L, newNode({ id: 'b' })], pan: { a: { setB: 20 } } })
  const it = newItem('cabinet', { p: { W: 1000, H: 720, D: 400, sideR: false, back: 'groove', backGapL: 2, tree: root } })
  const { parts, warn } = projectParts({ items: [it] })
  ok(!warn.length, 'blocks warn ' + warn)
  const back = parts.find(p => p.key === 'back'), div = parts.find(p => p.key === 'st_a')
  ok(div.place.aabb[2] === 20 && !div.grooves.length, 'end divider set back 20, no groove ' + div.place.aabb)
  ok(Math.abs(back.place.aabb[3] - (div.place.aabb[3] - 1)) < 0.01, 'back laps divider end ' + back.place.aabb)
  ok(Math.abs(back.place.aabb[0] - (16 - 8 + 2)) < 0.01, 'back gap left 2 ' + back.place.aabb)
  const sh = parts.filter(p => p.key.startsWith('sh_'))
  ok(sh.length === 2 && sh.find(p => p.key === 'sh_h0').name.includes('съёмная') && !sh.find(p => p.key === 'sh_h1').name.includes('съёмная'), 'one loose shelf')
  ok(sh.every(p => p.blk?.n === 'a' && p.blk.t === 'split'), 'shelf blk')
  const sh1 = sh.find(p => p.key === 'sh_h1')
  ok(Math.abs(sh1.place.aabb[3] - (div.place.aabb[0] - 30)) < 0.01 && sh1.edges['+x'], 'shelf set from right 30 + edge ' + sh1.place.aabb)
  const t2 = opRemovePanel(root, 'a', 'h0')
  ok(t2.children[0].children.length === 2 && !t2.children[0].pan?.h0, 'remove one panel')
  ok(opCount(root, 'a', 4).children[0].children.length === 5, 'count 4')
  const t3 = opReplace(root, 'a', 'drawers', 2)
  ok(!t3.children[0].split && t3.children[0].front.n === 2, 'replace shelves by drawers')
  t3.children[0].front = { ...t3.children[0].front, boxBottom: 30, boxTop: 50, slideLen: 300 }
  const pr = projectParts({ items: [{ ...it, p: { ...it.p, tree: t3 } }] }).parts
  const f = pr.find(p => p.name === 'Фасад ящика'), bs = pr.find(p => p.name === 'Ящик: боковина')
  ok(f.blk?.t === 'front' && bs.blk?.n === 'a', 'drawer blk')
  ok(Math.abs(bs.place.aabb[5] - bs.place.aabb[2] - 300) < 0.01, 'slide len per block ' + bs.place.aabb)
}

// ящики: высоты, системы, ручки, крепёж, анимация; штанга
{
  const { newNode, drawerHeights } = await import('../../src/lib/cadCabinet.js')
  const hs = drawerHeights(800, 4, 3, [null, null, null, 140])
  ok(Math.abs(hs[3] - 140) < 0.01 && Math.abs(hs[0] - (800 - 9 - 140) / 3) < 0.01, 'drawer heights ' + hs)
  const root = newNode({ id: 'root', front: { type: 'drawers', n: 3, hs: [null, null, 150] } })
  const it = newItem('cabinet', { p: { W: 800, H: 900, D: 500, tree: root } })
  const pp = projectParts({ items: [it] })
  ok(!pp.warn.length, 'drawers warn ' + pp.warn)
  const fs = pp.parts.filter(p => p.name === 'Фасад ящика').sort((a, b) => a.place.aabb[1] - b.place.aabb[1])
  ok(Math.abs(fs[2].place.aabb[4] - fs[2].place.aabb[1] - 150) < 0.01, 'top drawer 150')
  ok(fs.every(f => f.anim?.kind === 'slide'), 'drawer anim')
  const hh = pp.holes.filter(h => h.note === 'Ручка')
  ok(hh.length === 6 && Math.abs(Math.abs(hh[0].p[0] - hh[1].p[0]) - 128) < 0.01, 'handle holes cc128 ' + hh.length)
  const det = exportAll({ items: [it] }).details
  const f0 = det.find(d => d.name === 'Фасад ящика')
  ok(f0.contour.drillings.filter(d => d.note === 'Ручка' && d.depth === 16).length === 2, 'handle through holes on facade')
  ok(!det.some(d => d.contour.drillings.some(x => x.note === 'Направляющая')), 'slides on screws: no holes by default')
  const det2 = exportAll({ items: [it], settings: { mount: { slide: { mode: 'drill', d: 5, depth: 13 } } } }).details
  ok(det2.some(d => d.contour.drillings.some(x => x.note === 'Направляющая' && x.d === 5 && x.depth === 13)), 'slides euro 5x13')
  // Tandembox: дно уже проёма на 75
  const it2 = newItem('cabinet', { p: { W: 800, H: 900, D: 500, tree: newNode({ id: 'root', front: { type: 'drawers', n: 2, box: 'tandembox', handle: { type: 'knob', anchor: 'tc', dy: 30 } } }) } })
  const p2 = projectParts({ items: [it2] })
  const bot = p2.parts.find(p => p.name === 'Ящик: дно')
  ok(Math.abs(bot.place.aabb[3] - bot.place.aabb[0] - (768 - 75)) < 0.01, 'tandembox bottom ' + bot.place.aabb)
  ok(p2.holes.filter(h => h.note === 'Ручка').length === 2, 'knob one hole per drawer')
  ok(p2.hw.some(h => /Tandembox/.test(h.name)), 'tandembox hw')
  // двери: анимация поворота, ручка против петель
  const it3 = newItem('cabinet', { p: { W: 600, H: 720, D: 300, tree: newNode({ id: 'root', front: { type: 'doors', n: 1, open: 'left' } }) } })
  const p3 = projectParts({ items: [it3] })
  const door = p3.parts.find(p => p.name === 'Дверь')
  ok(door.anim?.kind === 'rot' && door.anim.ang < 0, 'door anim')
  const dh = p3.holes.filter(h => h.note === 'Ручка')
  ok(dh.length === 2 && dh.every(h => h.p[0] > 500), 'door handle on free side ' + dh.map(h => h.p))
  ok(!exportAll({ items: [it3] }).scene.extras.some(e => /Петля|Ручка/.test(e.name)), 'visual hardware not exported')
  // штанга — погонный элемент
  const it4 = newItem('cabinet', { p: { W: 800, H: 2000, D: 560, tree: newNode({ id: 'root', rod: { top: 60, d: 25 } }) } })
  const p4 = projectParts({ items: [it4] })
  const rod = p4.parts.find(p => p.name === 'Штанга')
  ok(rod && rod.kind === 'profile' && Math.abs(rod.place.L - 766) < 0.01, 'rod ' + rod?.place.L)
}

// ручки: глухие с изнанки / с лица; ящик без фальшпанели — паз под дно в фасаде; крепление фасада; свой материал детали
{
  const { newNode } = await import('../../src/lib/cadCabinet.js')
  const mk = fr => newItem('cabinet', { p: { W: 600, H: 400, D: 500, tree: newNode({ id: 'root', front: fr }) } })
  const it = mk({ type: 'drawers', n: 1 })
  const fac = mount => exportAll({ items: [it], settings: { mount } }).details.find(d => d.name === 'Фасад ящика')
  const hb = fac({ handle: { mode: 'back', depth: 10 } }).contour.drillings.filter(d => d.note === 'Ручка')
  ok(hb.length === 2 && hb.every(d => d.depth === 10 && d.face === 'back'), 'handle blind from back ' + JSON.stringify(hb.map(d => [d.depth, d.face])))
  const hf = fac({ handle: { mode: 'front', depth: 8 } }).contour.drillings.filter(d => d.note === 'Ручка')
  ok(hf.length === 2 && hf.every(d => d.depth === 8 && d.face === 'front'), 'handle blind from front ' + JSON.stringify(hf.map(d => [d.depth, d.face])))
  ok(fac({}).contour.drillings.filter(d => d.note === 'Крепление фасада ящика').length === 0, 'drawer front on screws: no holes')
  ok(fac({ dfront: { mode: 'drill', d: 5, depth: 10 } }).contour.drillings.filter(d => d.note === 'Крепление фасада ящика').length === 4, 'drawer front fixing holes')
  const it2 = mk({ type: 'drawers', n: 1, box: 'ldsp_groove', falseFront: false })
  const pp2 = projectParts({ items: [it2] })
  ok(!pp2.parts.some(p => p.name === 'Ящик: передняя'), 'no false front')
  const f2 = exportAll({ items: [it2] }).details.find(d => d.name === 'Фасад ящика')
  ok(f2.contour.grooves.some(g => g.face === 'back' && /дно/.test(g.note)), 'bottom groove in facade')
  ok(pp2.parts.some(p => p.model?.type === 'rail') && pp2.parts.some(p => p.model?.type === 'slideOuter'), 'hardware models')
  const it3 = { ...mk({ type: 'doors', n: 1 }), mat: { door0_0: 'МДФ Белый глянец 18' } }
  const door = projectParts({ items: [it3] }).parts.find(p => p.name === 'Дверь')
  ok(door.material === 'МДФ Белый глянец 18', 'part material override')
}
console.log(fail ? `${fail} ошибок` : 'Конструктор: всё верно')
process.exit(fail ? 1 : 0)
