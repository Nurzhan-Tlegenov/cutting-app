// Самонастройка раскроечного постпроцессора по чужой управляющей программе.
// Берём готовую УП станка (из другой программы раскроя) и «срисовываем» служебные команды:
//   • начало программы — всё до первой смены инструмента;
//   • смена инструмента — строки вокруг M6 между последним движением по XY прежнего инструмента
//     и первым движением нового; номер инструмента → {T}, обороты → {S};
//   • конец программы — всё после последнего движения по XY.
// Движения (G0/G1/G2/G3 с X или Y) и холостые подъёмы по Z наша программа строит сама, поэтому в команды не попадают.
// Комментарии и номера строк (N10, N20…) отбрасываются: они у каждой программы свои.

const strip = s => s
  .replace(/\([^)]*\)/g, ' ')            // (комментарий)
  .replace(/;.*$/, '')                    // ; комментарий до конца строки
  .replace(/^\s*\/?\s*N\d+\s*/i, '')      // номер строки
  .replace(/\s+/g, ' ').trim()

const isXY = s => /^(?:G0?[0-3](?:\D|$)|X|Y)/i.test(s) && /[XY]\s*-?[\d.]/i.test(s) && !/G53|G28|G30/i.test(s)
const isMotion = s => /(?:^|\s)G0?[0-3](?=\D|$)/i.test(s) || /^[XYZ]/i.test(s)
// холостой подъём/опускание по Z в координатах детали — его ставит наша программа сама
const isZOnly = s => /^(?:G0?[01]\s+)?(?:F[\d.]+\s+)?Z\s*-?[\d.]+(?:\s+F[\d.]+)?$/i.test(s)
const isToolChange = s => /(?:^|\s)M0?6(?=\D|$)/i.test(s)
const toolNo = s => { const m = /T\s*0*(\d+)/i.exec(s); return m ? Number(m[1]) : null }
const rpmOf = s => { const m = /(?:^|\s)S\s*(\d+(?:\.\d+)?)/i.exec(s); return m ? Math.round(Number(m[1])) : null }
const norm = s => s.toUpperCase().replace(/\s+/g, '')
// подготовка к смене (если смена в программе одна): что обычно стоит перед M6
const isPrep = s => /^(?:M0?5|M0?9|G53|G28|G30|G91\s*G28|G49|G40|T\s*\d+)(?=\D|$)/i.test(s) && !isZOnly(s)

/** Разобрать текст программы. -> { ok, cmdStart, cmdToolStart, cmdToolEnd, cmdEnd, tools, arcs, park, report[], warnings[] } */
export function learnFromProgram(text) {
  const raw = String(text || '').split(/\r?\n/)
  const report = [], warnings = []
  let dropped = 0, numbered = 0
  const lines = []
  for (const r of raw) {
    if (!r.trim()) continue
    if (/^\s*\/?\s*N\d+/i.test(r)) numbered++
    const s = strip(r)
    if (!s) { dropped++; continue }
    lines.push(s)
  }
  if (!lines.length) return { ok: false, warnings: ['В файле нет команд G-кода.'], report }

  const changes = lines.map((s, i) => (isToolChange(s) ? i : -1)).filter(i => i >= 0)
  if (!changes.length) return { ok: false, warnings: ['В программе не найдена смена инструмента (M6). Начало и конец можно ввести вручную.'], report }

  const xy = lines.map((s, i) => (isXY(s) ? i : -1)).filter(i => i >= 0)
  if (!xy.length) return { ok: false, warnings: ['В программе нет перемещений по X/Y — это не похоже на управляющую программу раскроя.'], report }
  const lastXyBefore = i => { let k = -1; for (const j of xy) { if (j < i) k = j; else break } return k }
  const firstXyAfter = i => xy.find(j => j > i) ?? lines.length

  // блоки смены инструмента: [до M6 | M6 | после M6 до первого движения по XY]
  const blocks = changes.map((c, n) => {
    const from = n === 0 ? null : lastXyBefore(c) + 1
    const pre = n === 0 ? null : lines.slice(from, c).filter(s => !isZOnly(s))
    const to = firstXyAfter(c)
    const post = lines.slice(c + 1, to).filter(s => !isZOnly(s) || /G4[34]/i.test(s))
    const t = toolNo(lines[c]) ?? toolNo([...(pre || [])].reverse().find(s => toolNo(s) != null) || '') ?? toolNo(post.find(s => toolNo(s) != null) || '')
    const s = [lines[c], ...post].map(rpmOf).find(v => v != null) ?? null
    return { c, pre, m6: lines[c], post, t, s }
  })
  // шаблон: номер инструмента → {T}, корректор длины того же номера → {T}, обороты → {S}
  const tplLine = (line, t, s) => {
    let out = line
    if (t != null) {
      out = out.replace(new RegExp(`T\\s*0*${t}(?!\\d)`, 'gi'), 'T{T}')
      out = out.replace(new RegExp(`([HD])\\s*0*${t}(?!\\d)`, 'gi'), '$1{T}')
    }
    if (s != null) out = out.replace(new RegExp(`(^|\\s)S\\s*${s}(?:\\.0+)?(?![\\d.])`, 'gi'), '$1S{S}')
    return out
  }
  const tplBlock = (b, list) => list.map(l => tplLine(l, b.t, b.s))

  // подготовку к смене берём со второй смены (у первой она слита с началом программы)
  const ref = blocks.find(b => b.pre && b.pre.length) || null
  let preTpl = ref ? tplBlock(ref, ref.pre) : null
  const first = blocks[0]
  let startLines = lines.slice(0, first.c)
  if (preTpl) {
    // из конца «начала программы» убираем строки, совпадающие с подготовкой к смене
    const want = preTpl.map(norm)
    const tail = startLines.map(l => norm(tplLine(l, first.t, first.s)))
    let k = 0
    while (k < want.length && k < tail.length && tail[tail.length - 1 - k] === want[want.length - 1 - k]) k++
    if (k) startLines = startLines.slice(0, startLines.length - k)
    else {
      // не совпало — отрезаем хотя бы явную подготовку
      while (startLines.length && isPrep(startLines[startLines.length - 1])) startLines.pop()
    }
  } else {
    const prep = []
    while (startLines.length && isPrep(startLines[startLines.length - 1])) prep.unshift(startLines.pop())
    preTpl = tplBlock(first, prep)
  }
  startLines = startLines.filter(l => !isZOnly(l))

  // после M6: до включения шпинделя (M3/M4) — «начало смены», остальное — «конец смены»
  const postRef = blocks.find(b => b !== first && b.post.length) || first
  const postTpl = tplBlock(postRef, postRef.post)
  const spin = postTpl.findIndex(l => /(?:^|\s)M0?[34](?=\D|$)/i.test(l))
  const cut = spin >= 0 ? spin + 1 : postTpl.length
  const toolStart = [...preTpl, tplLine(first.m6, first.t, first.s), ...postTpl.slice(0, cut)]
  const toolEnd = postTpl.slice(cut)

  // конец программы: после последнего движения по XY. Если последнее движение — холостой переезд (G0) уже после
  // обработки (дальше нет рабочих ходов, до него — подъём или выключение шпинделя), это парковка шпинделя:
  // она остаётся в конце программы как есть, а своя парковка приложения отключается — чтобы порядок был как у станка
  let lastXy = xy[xy.length - 1]
  let park = null
  const prevXy = xy.length > 1 ? xy[xy.length - 2] : -1
  const lx = lines[lastXy]
  const between = lines.slice(prevXy + 1, lastXy)
  const after = lines.slice(lastXy + 1)
  if (/^G0?0(?=\D|$)/i.test(lx) && prevXy >= 0 && !between.some(isToolChange) && !after.some(l => /(?:^|\s)G0?[123](?=\D|$)/i.test(l))
    && between.some(l => isZOnly(l) || /G53|G28|G30|M0?5(?=\D|$)/i.test(l))) {
    const mx = /X\s*(-?[\d.]+)/i.exec(lx), my = /Y\s*(-?[\d.]+)/i.exec(lx)
    park = { x: mx ? Number(mx[1]) : null, y: my ? Number(my[1]) : null }
    lastXy = prevXy
  }
  const endLines = lines.slice(lastXy + 1).filter(l => !isZOnly(l))

  // что ещё видно по программе
  const tools = []
  for (const b of blocks) if (b.t != null && !tools.some(x => x.t === b.t && x.s === b.s)) tools.push({ t: b.t, s: b.s })
  const ij = lines.some(l => /(?:^|\s)G0?[23](?=\D|$)/i.test(l) && /[IJ]\s*-?[\d.]/i.test(l))
  const rArcs = lines.some(l => /(?:^|\s)G0?[23](?=\D|$)/i.test(l) && /R\s*-?[\d.]/i.test(l))
  const motions = lines.filter(isMotion).length

  report.push(`Строк с командами: ${lines.length}, из них перемещений: ${motions}.`)
  report.push(`Смен инструмента: ${changes.length}${tools.length ? ` — ${tools.map(x => `T${x.t}${x.s ? ` S${x.s}` : ''}`).join(', ')}` : ''}.`)
  if (dropped) report.push(`Комментарии отброшены (${dropped} строк) — у каждой программы они свои.`)
  if (numbered) report.push('В программе были номера строк (N…) — они убраны: наша программа их не ставит.')
  if (ij) report.push('Дуги в программе — G2/G3 с I, J: в «Основных» включится вывод дуг так же.')
  if (park) report.push(`Парковка в конце (${lx}) осталась в конце программы как у станка; своя парковка из «Основных» для этого станка отключится.`)
  if (rArcs) warnings.push('Дуги в программе заданы радиусом (R). Наша программа выводит дуги через I, J или отрезками — проверьте, что станок их принимает.')
  if (lines.some(l => /(?:^|\s)G20(?=\D|$)/.test(l))) warnings.push('Программа в дюймах (G20). Приложение считает в миллиметрах — G20 в начале программы заменён на G21.')
  if (!toolStart.some(l => /\{T\}/.test(l))) warnings.push('Номер инструмента в смене не распознан — проверьте строку смены и поставьте {T} вручную.')
  if (tools.some(x => x.s != null) && !toolStart.concat(toolEnd).some(l => /\{S\}/.test(l))) warnings.push('Обороты шпинделя не распознаны — поставьте {S} вручную.')
  if (blocks.length === 1) warnings.push('Смена инструмента в программе одна — граница между началом программы и сменой определена по типичным командам. Проверьте.')

  const fixUnits = l => l.replace(/(^|\s)G20(?=\D|$)/g, '$1G21')
  return {
    ok: true,
    cmdStart: startLines.map(fixUnits).join('\n'),
    cmdToolStart: toolStart.join('\n'),
    cmdToolEnd: toolEnd.join('\n'),
    cmdEnd: endLines.join('\n'),
    tools, arcs: ij ? 'ij' : null, park,
    report, warnings,
  }
}

/** Прочитать файл программы: UTF-8, а если там кракозябры — Windows-1251 (старые станки и программы). */
export async function readProgramFile(file) {
  const buf = await file.arrayBuffer()
  let text = new TextDecoder('utf-8').decode(buf)
  if (text.includes('�')) { try { text = new TextDecoder('windows-1251').decode(buf) } catch { /* остаётся как есть */ } }
  const ext = (/\.([a-z0-9]{1,6})$/i.exec(file.name || '') || [])[1] || ''
  return { text, ext }
}
