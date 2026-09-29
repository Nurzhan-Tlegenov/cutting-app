#!/usr/bin/env node
// Разбор хронологии раскроя (файл «⬇ Экспорт истории» со страницы раскроя).
//
//   node scripts/analyze-nesting-history.mjs <файл_history.json> [--events]
//
// Что показывает:
//   • сводка: сколько считали, сколько потоков/ядер, итог;
//   • когда шли улучшения и где поиск встал (пауза без улучшений, когда
//     набрано 90/99% итогового выигрыша — всё после этого потрачено зря);
//   • потоки: сколько вариантов в секунду, чьи улучшения стали общими, сколько
//     получили мигрантов;
//   • режимы укладки: какие дают улучшения, во что выродилась популяция;
//   • разнообразие популяции: если долго 1–2 разных результата — поиск
//     зациклился (все особи одинаковые, скрещивание ничего нового не даёт);
//   • ошибки укладки в КАЖДОМ снимке: пересечения, выход за лист, потерянные
//     или лишние детали, запрещённый поворот.
import { readFileSync } from 'node:fs'

const file = process.argv[2]
if (!file) { console.error('Укажите файл: node scripts/analyze-nesting-history.mjs history.json'); process.exit(1) }
const showEvents = process.argv.includes('--events')
const H = JSON.parse(readFileSync(file, 'utf8'))
if (H.format !== 'raskroy-nesting-history') { console.error('Это не файл хронологии раскроя'); process.exit(1) }

const sec = ms => (ms / 1000).toFixed(1) + ' с'
const pct = v => (v * 100).toFixed(1) + '%'
const p = H.params
const usableX = p.sheetW - p.marginL - p.marginR
const usableY = p.sheetL - p.marginT - p.marginB
const kerf = p.kerf
const line = t => console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 60 - t.length)))

// ─── Сводка ────────────────────────────────────────────────────────────────
line('Сводка')
const totalQty = H.details.reduce((a, d) => a + d.qty, 0)
const partsArea = H.details.reduce((a, d) => a + (d.length + kerf) * (d.width + kerf) * d.qty, 0)
const lb = partsArea / (usableX * usableY)
console.log(`Заказ ${H.order.number} · конфигурация ${H.order.configuration} · алгоритм v${H.algoVersion}`)
console.log(`Станок: ${p.cuttingMethod} · укладка: ${H.config.dir} · мелкие в центр: ${H.config.small ? 'да' : 'нет'} · режим: ${H.config.live ? 'до «Стоп»' : H.config.secs + ' с'}`)
console.log(`Деталей: ${totalQty} (${H.details.length} видов, с контуром: ${H.details.filter(d => d.contour).length}) · лист ${p.sheetL}×${p.sheetW}, рез ${kerf}`)
console.log(`Нижняя граница по площади: ${lb.toFixed(2)} листа → минимум ${Math.ceil(lb)} л.`)
console.log(`Считали ${sec(H.durationMs)} · потоков ${H.islands} · ядер ${H.device.cores ?? '?'}`)
const ev = H.events
const fin = ev[ev.length - 1]
const first = ev[0]
if (!fin) { console.log('Нет ни одного результата.'); process.exit(0) }
console.log(`Первый результат: ${sec(first.t)} → ${first.count} л., на последнем ${pct(first.lastFill)}`)
console.log(`Итог: ${fin.count} л., загрузка ${pct(fin.util)}, на последнем ${pct(fin.lastFill)}${fin.count > Math.ceil(lb) ? `  (на ${fin.count - Math.ceil(lb)} л. больше нижней границы)` : '  (= нижней границе по листам)'}`)
if (H.thinned) console.log(`Снимки прореживались ${H.thinned} раз(а) — старые улучшения показаны не все`)

// ─── Улучшения во времени ────────────────────────────────────────────────
line('Улучшения во времени')
const imp = ev.filter(e => e.kind !== 'final')
const gain = e => (first.count - e.count) * 1e9 + (first.last - e.last) // «сколько выиграли» от первого результата
const totalGain = gain(imp[imp.length - 1] || first)
const reach = frac => { const g = totalGain * frac; const e = imp.find(x => gain(x) >= g); return e ? e.t : 0 }
const lastImp = imp[imp.length - 1]
console.log(`Улучшений общего результата: ${imp.length}`)
if (totalGain > 0) console.log(`90% выигрыша — к ${sec(reach(0.9))}, 99% — к ${sec(reach(0.99))}, последнее улучшение — ${sec(lastImp.t)}`)
const idle = H.durationMs - (lastImp?.t || 0)
console.log(`После последнего улучшения поиск шёл ещё ${sec(idle)}${idle > H.durationMs * 0.5 && H.durationMs > 20000 ? '  ⚠ больше половины времени без пользы' : ''}`)
let gaps = []
for (let i = 1; i < imp.length; i++) gaps.push({ from: imp[i - 1].t, to: imp[i].t, d: imp[i].t - imp[i - 1].t })
gaps.sort((a, b) => b.d - a.d)
if (gaps.length) console.log('Самые длинные паузы между улучшениями: ' + gaps.slice(0, 3).map(g => `${sec(g.d)} (${sec(g.from)}→${sec(g.to)})`).join(', '))
const sheetDrops = imp.filter((e, i) => i > 0 && e.count < imp[i - 1].count)
if (sheetDrops.length) console.log('Минус лист: ' + sheetDrops.map(e => `${sec(e.t)} → ${e.count} л.`).join(', '))
if (showEvents) imp.forEach(e => console.log(`  ${sec(e.t).padStart(8)}  ${e.count} л.  посл. ${pct(e.lastFill).padStart(6)}  загр. ${pct(e.util)}  поток ${e.island + 1}  ${e.mode || ''}`))

// ─── Потоки ────────────────────────────────────────────────────────────────
line('Потоки')
const byIsland = {}
H.stats.forEach(s => { (byIsland[s.island] ||= []).push(s) })
const ie = H.islandEvents || []
Object.keys(byIsland).sort((a, b) => a - b).forEach(k => {
  const st = byIsland[k].filter(s => s.ips != null)
  const ips = st.length ? Math.round(st.reduce((a, s) => a + s.ips, 0) / st.length) : 0
  const lastSt = byIsland[k][byIsland[k].length - 1]
  const own = ie.filter(e => e.island === +k)
  const wins = own.filter(e => e.global).length
  const shape = byIsland[k].filter(s => s.phase === 'shape')
  if (shape.length) {
    console.log(`Поток ${+k + 1}: раундов ${shape.length}, улучшили общий результат ${shape.filter(s => s.improved).length}` +
      ` · раунды: ${shape.map(s => `${s.roundSeconds}с→${s.result ? s.result.count + 'л/' + Math.round(s.result.last / 1e4) / 100 + 'м²' : '—'}${s.improved ? '✓' : ''}`).join(' ')}`)
  } else {
    console.log(`Поток ${+k + 1}: ~${ips} вар./с, всего ${lastSt.iter} вар., поколений ${lastSt.gen}, своих улучшений ${own.length}, из них общих ${wins}, мигрантов принято ${lastSt.migrantsIn ?? 0}`)
  }
})
const ipsDrop = Object.values(byIsland).map(list => {
  const st = list.filter(s => s.ips != null && s.phase === 'ga')
  if (st.length < 6) return null
  const a = st.slice(0, 3).reduce((x, s) => x + s.ips, 0) / 3, b = st.slice(-3).reduce((x, s) => x + s.ips, 0) / 3
  return a > 0 ? b / a : null
}).filter(v => v != null)
if (ipsDrop.length && Math.min(...ipsDrop) < 0.6) console.log(`⚠ Скорость перебора упала к концу до ${pct(Math.min(...ipsDrop))} от начальной — телефон мог сбросить частоту (нагрев/энергосбережение)`)

// ─── Режимы укладки ───────────────────────────────────────────────────────
line('Режимы укладки')
const modeWins = {}
imp.forEach(e => { if (e.mode) modeWins[e.mode] = (modeWins[e.mode] || 0) + 1 })
console.log('Дали общие улучшения: ' + (Object.entries(modeWins).sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m} ×${n}`).join(', ') || '—'))
const lastPop = {}
Object.values(byIsland).forEach(list => {
  const s = [...list].reverse().find(x => x.modes && Object.keys(x.modes).length)
  if (s) Object.entries(s.modes).forEach(([m, n]) => { lastPop[m] = (lastPop[m] || 0) + n })
})
if (Object.keys(lastPop).length) console.log('Популяции к концу: ' + Object.entries(lastPop).sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m} ${n}`).join(', '))

// ─── Разнообразие популяции (зацикливание) ───────────────────────────────
line('Зацикливание поиска')
let anyStuck = false
Object.keys(byIsland).sort((a, b) => a - b).forEach(k => {
  const st = byIsland[k].filter(s => s.phase === 'ga' && s.diversity != null)
  if (!st.length) return
  let run = 0, maxRun = 0, runStart = 0, maxStart = 0
  for (let i = 0; i < st.length; i++) {
    if (st[i].diversity <= 2) { if (!run) runStart = st[i].at; run = st[i].at - runStart + 1000; if (run > maxRun) { maxRun = run; maxStart = runStart } } else run = 0
  }
  const avg = st.reduce((a, s) => a + s.diversity, 0) / st.length
  const msg = `Поток ${+k + 1}: разных результатов в популяции в среднем ${avg.toFixed(1)} из ${st[0].pop}`
  if (maxRun > 10000) { anyStuck = true; console.log(msg + `  ⚠ вырождение ${sec(maxRun)} подряд с ${sec(maxStart)} — все особи одинаковые`) }
  else console.log(msg)
})
if (!anyStuck) console.log('Долгих вырождений популяции не найдено.')

// ─── Ошибки укладки в снимках ────────────────────────────────────────────
line('Ошибки укладки (каждый снимок)')
const qty = H.details.map(d => d.qty)
let errSnapshots = 0
ev.forEach((e, ei) => {
  const errs = []
  const cnt = new Array(H.details.length).fill(0)
  e.sheets.forEach((parts, si) => {
    parts.forEach(([di, x, y, w, h, rot]) => {
      cnt[di]++
      if (x < -0.5 || y < -0.5 || x + w - kerf > usableX + 0.5 || y + h - kerf > usableY + 0.5) errs.push(`лист ${si + 1}: ${H.details[di]?.name} за краем (${x},${y})`)
      if (!H.details[di]?.rotatable && rot % 180 !== 0 && !H.details[di]?.contour) errs.push(`лист ${si + 1}: ${H.details[di]?.name} повёрнута, хотя вращать нельзя`)
    })
    // пересечения — только прямоугольные детали (у фигурных габариты могут перекрываться законно)
    for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
      const a = parts[i], b = parts[j]
      if (H.shapes[`${a[0]}|${a[5]}`] || H.shapes[`${b[0]}|${b[5]}`]) continue
      if (a[1] < b[1] + b[3] - 0.5 && b[1] < a[1] + a[3] - 0.5 && a[2] < b[2] + b[4] - 0.5 && b[2] < a[2] + a[4] - 0.5)
        errs.push(`лист ${si + 1}: пересекаются ${H.details[a[0]]?.name} и ${H.details[b[0]]?.name}`)
    }
    if (!parts.length) errs.push(`лист ${si + 1} пустой`)
  })
  cnt.forEach((c, di) => { if (c !== qty[di]) errs.push(`${H.details[di].name}: на листах ${c} из ${qty[di]}`) })
  if (errs.length) {
    errSnapshots++
    console.log(`Снимок ${ei + 1} (${e.kind === 'final' ? 'итог' : sec(e.t)}): ${errs.length} ошиб.`)
    errs.slice(0, 5).forEach(t => console.log('   · ' + t))
    if (errs.length > 5) console.log(`   … ещё ${errs.length - 5}`)
  }
})
if (!errSnapshots) console.log(`Во всех ${ev.length} снимках ошибок нет.`)

// ─── Выводы ────────────────────────────────────────────────────────────────
line('На что смотреть')
const tips = []
if (totalGain > 0 && reach(0.99) < H.durationMs * 0.3 && H.durationMs > 30000) tips.push(`Итог почти достигнут к ${sec(reach(0.99))} — дальше нужен другой тип поиска (перестройка отдельных листов), а не больше времени`)
if (anyStuck) tips.push('Популяция вырождается — поднять мутацию/перезапуск при застое')
if (fin.count > Math.ceil(lb)) tips.push(`До нижней границы ${fin.count - Math.ceil(lb)} л. — есть смысл дожимать листы по одному`)
if (errSnapshots) tips.push('Есть снимки с ошибками укладки — разобрать их в первую очередь')
if (!tips.length) tips.push('Явных проблем не видно')
tips.forEach(t => console.log('• ' + t))
