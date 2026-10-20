// Проверка импорта «К3-Мебель» (.mdb) на образцах: node tests/k3/check.mjs [--update]
// Для каждого файла в этой папке разбор сравнивается с сохранённым итогом (<файл>.json): детали, кромка, присадка, пазы.
// После правки импорта — прогнать: всё, что работало, должно работать. --update — записать итоги заново.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import MDBReader from 'mdb-reader'
import { parseK3 } from '../../src/lib/k3Mdb.js'

const dir = path.dirname(fileURLToPath(import.meta.url))
const update = process.argv.includes('--update')
const verbose = process.argv.includes('-v')
const r1 = v => Math.round(v * 10) / 10

function summary(res) {
  return {
    order: res.orderName,
    items: res.items.map(it => {
      const c = it.contour
      return {
        name: [it.prefix, it.name].filter(Boolean).join(' / '), size: `${it.w}x${it.h}x${it.thickness}`, qty: it.qty, material: it.material,
        tex: c.meta?.texDir, shaped: !!it.info?.shaped,
        edges: Object.entries(it.edges || {}).filter(([, v]) => v).map(([k, v]) => `${k}:${v}`).join(', '),
        edgeSegs: (c.vertices || []).filter(v => v.edge).map(v => `${v.type || 'line'}@${v.x},${v.y}:${v.edge}`),
        edgeInfo: Object.fromEntries(Object.entries(c.meta?.edges || {}).map(([k, v]) => [k, `${v.thick}/${v.trim ? 'trim' : 'no'}/${v.joint}`])),
        drillings: (c.drillings || []).map(d => d.kind === 'face'
          ? `${d.face} Ø${d.d}x${d.depth}${d.row ? ` x${d.rowCount}` : ''} [${d.sides?.join('+')}] ${JSON.stringify(d.offsets)} ${d.note || ''}`
          : `edge ${d.edgeSide} Ø${d.d}x${d.depth} @${d.offsetAlong} z${d.offsetFace} ${d.note || ''}`),
        grooves: (c.grooves || []).map(g => `${g.face} ${g.dir} ${r1(g.length)}x${r1(g.width)}x${r1(g.depth)}`),
        holes: (c.holes || []).map(h => `${h.type} ${r1(h.hw || h.d || 0)}x${r1(h.hh || h.d || 0)}`),
        warn: Object.fromEntries(Object.entries(it.warn || {}).filter(([, v]) => v)),
      }
    }),
    groups: res.groups.map(g => `${g.material} ${g.thickness}: ${g.count} поз., ${g.pieces} шт`),
    skipped: res.skipped,
  }
}

let bad = 0
for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.mdb')).sort()) {
  const file = path.join(dir, f), want = file.replace(/\.mdb$/, '.json')
  let got
  try { got = summary(parseK3(new Uint8Array(fs.readFileSync(file)), { MDBReader })) } catch (e) { got = { error: e.message, stack: e.stack } }
  const text = JSON.stringify(got, null, 1)
  if (verbose) console.log(text)
  if (update || !fs.existsSync(want)) { fs.writeFileSync(want, text + '\n'); console.log(`${f}: итог записан`); continue }
  const prev = fs.readFileSync(want, 'utf8').trim()
  if (prev === text) { console.log(`${f}: ✓`); continue }
  bad++
  console.log(`${f}: ОТЛИЧАЕТСЯ от ${path.basename(want)} (запустите с --update, если так и задумано)`)
}
process.exit(bad ? 1 : 0)
