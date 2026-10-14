// Проверка импорта «Астра Конструктор Мебели» (.add) на образцах: node tests/astra/check.mjs [--update]
// Для каждого файла в этой папке разбор сравнивается с сохранённым итогом (<файл>.json): детали, присадка, пазы,
// выемки, метки. После правки импорта — прогнать: всё, что работало, должно работать. --update — записать итоги заново
// (только когда изменение итогов ожидаемое).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAstra } from '../../src/lib/astraAdd.js'

const dir = path.dirname(fileURLToPath(import.meta.url))
const update = process.argv.includes('--update')
const r1 = v => Math.round(v * 10) / 10

function summary(res) {
  return {
    items: res.items.map(it => {
      const c = it.contour
      return {
        des: c.meta?.des || '', name: it.name, size: `${it.w}x${it.h}x${it.thickness}`, qty: it.qty, material: it.material,
        edges: Object.entries(it.edges || {}).filter(([, v]) => v).map(([k]) => k).join(','),
        drillings: (c.drillings || []).length,
        grooves: (c.grooves || []).map(g => `${g.face} ${g.dir} ${r1(g.length)}x${r1(g.width)}x${r1(g.depth)}`),
        holes: (c.holes || []).map(h => `${h.type}${h.face ? ' ' + h.face : ''} ${r1(h.hw || h.d || 0)}x${r1(h.hh || h.d || 0)}${h.depth ? ' d' + r1(h.depth) : ''}`),
        edgeGrooves: (c.edgeGrooves || []).map(g => `${g.kind || 'groove'} ${g.edgeSide} ${r1(g.gapLow)}/${r1(g.gapHigh)} f${r1(g.fromFace)} ${r1(g.width)}x${r1(g.depth)}${g.r ? ' R' + r1(g.r) : ''}`),
      }
    }),
    marks: (res.pockets?.marks || []).map(m => `${m.obj}: ${m.miss ? 'не попала' : m.hits.map(h => `${h.part} — ${h.text}`).join('; ')}`),
    candidates: (res.pockets?.candidates || []).map(c => `${c.obj}: ${c.hits.map(h => `${h.part} — ${h.text}`).join('; ')}`),
  }
}

let bad = 0
for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.add')).sort()) {
  const file = path.join(dir, f), want = file.replace(/\.add$/, '.json')
  let got
  try { got = summary(parseAstra(new Uint8Array(fs.readFileSync(file)))) } catch (e) { got = { error: e.message } }
  const text = JSON.stringify(got, null, 1)
  if (update || !fs.existsSync(want)) { fs.writeFileSync(want, text + '\n'); console.log(`${f}: итог записан`); continue }
  const prev = fs.readFileSync(want, 'utf8').trim()
  if (prev === text) { console.log(`${f}: ✓`); continue }
  bad++
  console.log(`${f}: ✗ отличается от сохранённого итога`)
  const a = prev.split('\n'), b = text.split('\n')
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) { console.log(`  было: ${a[i] ?? ''}\n  стало: ${b[i] ?? ''}`); if (--i < -100) break }
}
process.exit(bad ? 1 : 0)
