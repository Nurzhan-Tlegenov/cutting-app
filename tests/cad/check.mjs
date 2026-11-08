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
pr.items.push(newItem('cabinet'))
const g = exportForOrder(pr, sheetGroups(pr)[0].key)
const side = g.items.find(x => x.name === 'Боковина левая'), shelf = g.items.find(x => x.name === 'Полка'), back = projectParts(pr).parts.find(x => x.key === 'back')
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
  const it = { ...newItem('cabinet'), rotY: rot, pos: { x: 300, y: 10, z: -40 } }
  const a = projectParts({ items: [it] }).parts.filter(x => x.kind === 'sheet').map(x => x.place.aabb.join(',')).sort()
  const b = projectParts({ items: explodeCabinet(it) }).parts.map(x => x.place.aabb.join(',')).sort()
  ok(a.join('|') === b.join('|'), 'explode rot ' + rot)
}
// присадка: конфирматы на боковине, торец дна, чашки петель на дверях, планки на боковинах
{
  const pr2 = newProject('Присадка')
  pr2.items.push({ ...newItem('cabinet', { p: { shelfType: 'loose' } }), rotY: 90, pos: { x: 500, y: 0, z: 200 } })
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
console.log(fail ? `${fail} ошибок` : 'Конструктор: всё верно')
process.exit(fail ? 1 : 0)
