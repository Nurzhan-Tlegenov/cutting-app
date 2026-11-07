// Проверка конструктора: детали корпуса, их 3D-положение и спецификация (node tests/cad/check.mjs)
import { newProject, newItem, projectParts, exportForOrder, projectSpec, linearNest, explodeCabinet, sheetGroups } from '../../src/lib/cadModel.js'
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
console.log(fail ? `${fail} ошибок` : 'Конструктор: всё верно')
process.exit(fail ? 1 : 0)
