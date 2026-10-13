// Самонастройка раскроечного постпроцессора по чужой управляющей программе.
// Берём готовую УП станка (из другой программы раскроя) и «срисовываем» служебные команды:
//   • начало программы — всё до первой смены инструмента;
//   • смена инструмента — служебные строки вокруг M6: после последнего рабочего хода прежнего инструмента
//     и до первого переезда к работе нового; номер инструмента → {T}, обороты → {S};
//   • конец программы — всё после последнего рабочего хода.
// Если в программе смена инструмента бывает двух видов (например, фрезерный шпиндель M03 и присадочная голова M13),
// виды разделяются: тот, после которого фреза режет по XY, — шпиндель; тот, после которого только сверлят, — голова.
// Перемещения и холостые подъёмы по Z наша программа строит сама, поэтому в команды не попадают.
// Комментарии и номера строк (N10, N20…) отбрасываются: они у каждой программы свои.

const strip = s => s
  .replace(/\([^)]*\)/g, ' ')            // (комментарий)
  .replace(/;.*$/, '')                    // ; комментарий до конца строки
  .replace(/^\s*\/?\s*N\d+\s*/i, '')      // номер строки
  .replace(/\s+/g, ' ').trim()

const word = (s, ch) => { const m = new RegExp(`${ch}\\s*(-?\\d*\\.?\\d+)`, 'i').exec(s); return m ? Number(m[1]) : null }
const gcodes = s => [...s.matchAll(/G\s*(\d+(?:\.\d+)?)/gi)].map(m => Number(m[1]))
const isToolChange = s => /(?:^|\s)M0?6(?=\D|$)/i.test(s)
const toolNo = s => { const m = /T\s*0*(\d+)/i.exec(s); return m ? Number(m[1]) : null }
const rpmOf = s => { const m = /(?:^|\s)S\s*(\d+(?:\.\d+)?)/i.exec(s); return m ? Math.round(Number(m[1])) : null }
const norm = s => s.toUpperCase().replace(/\s+/g, '')
const SPIN_ON = /(?:^|\s)(?:M0?[34]|M1[34])(?=\D|$)|S\{S\}/i
// подготовка к смене (если смена в программе одна): что обычно стоит перед M6
const isPrep = s => /^(?:M0?5|M0?9|G53|G28|G30|G91\s*G28|G49|G40|T\s*\d+)(?=\D|$)/i.test(s)

/**
 * Каждая строка — вид: 'cmd' служебная, 'm6' смена инструмента, 'rapidxy' холостой переезд по XY, 'rapidz' холостой по Z,
 * 'cut' рабочий ход по XY (фреза режет), 'plunge' рабочий ход только по Z (сверление, врезание).
 */
function classify(lines) {
  let x = null, y = null, mode = 0
  return lines.map(s => {
    if (isToolChange(s)) return 'm6'
    const gs = gcodes(s)
    if (gs.some(g => g === 53 || g === 28 || g === 30 || g === 43 || g === 44 || g === 49)) return 'cmd'   // машинные координаты, корректор длины
    for (const g of gs) if (g >= 0 && g <= 3) mode = g
    const nx = word(s, 'X'), ny = word(s, 'Y'), nz = word(s, 'Z')
    const motion = (gs.some(g => g >= 0 && g <= 3) || /^[XYZ]/i.test(s)) && (nx != null || ny != null || nz != null)
    if (!motion) return 'cmd'
    const xy = (nx != null && (x == null || Math.abs(nx - x) > 1e-6)) || (ny != null && (y == null || Math.abs(ny - y) > 1e-6))
    if (nx != null) x = nx
    if (ny != null) y = ny
    if (mode === 0) return xy ? 'rapidxy' : 'rapidz'
    return xy ? 'cut' : 'plunge'
  })
}

/** Разобрать текст программы.
 *  -> { ok, cmdStart, cmdToolStart, cmdToolEnd, cmdEnd, head: { cmdHeadStart, cmdHeadEnd, tools: [T] } | null,
 *       tools, spindleTools, arcs, park, report[], warnings[] } */
export function learnFromProgram(text) {
  const raw = String(text || '').split(/\r?\n/)
  const report = [], warnings = []
  let dropped = 0, numbered = 0
  const lines = [], notes = []        // notes[i] — комментарии в строке i и сразу после неё (там бывает диаметр инструмента)
  for (const r of raw) {
    if (!r.trim()) continue
    if (/^\s*\/?\s*N\d+/i.test(r)) numbered++
    const com = [...r.matchAll(/\(([^)]*)\)/g)].map(m => m[1]).concat((/;(.*)$/.exec(r) || [])[1] || []).join(' ')
    const s = strip(r)
    if (!s) { dropped++; if (com && lines.length) notes[lines.length - 1] = (notes[lines.length - 1] || '') + ' ' + com; continue }
    lines.push(s); notes.push(com)
  }
  if (!lines.length) return { ok: false, warnings: ['В файле нет команд G-кода.'], report }
  const kind = classify(lines)
  const changes = kind.map((k, i) => (k === 'm6' ? i : -1)).filter(i => i >= 0)
  if (!changes.length) return { ok: false, warnings: ['В программе не найдена смена инструмента (M6). Начало и конец можно ввести вручную.'], report }
  const work = kind.map((k, i) => (k === 'cut' || k === 'plunge' ? i : -1)).filter(i => i >= 0)
  if (!work.length) return { ok: false, warnings: ['В программе нет рабочих ходов — это не похоже на управляющую программу раскроя.'], report }
  const keep = i => kind[i] === 'cmd'

  // шаблон строки: номер инструмента → {T}, корректор того же номера → {T}, обороты → {S}
  const tplLine = (line, t, s) => {
    let out = line
    if (t != null) {
      out = out.replace(new RegExp(`T\\s*0*${t}(?!\\d)`, 'gi'), 'T{T}')
      out = out.replace(new RegExp(`([HD])\\s*0*${t}(?!\\d)`, 'gi'), '$1{T}')
    }
    if (s != null) out = out.replace(new RegExp(`(^|\\s)S\\s*${s}(?:\\.0+)?(?![\\d.])`, 'gi'), '$1S{S}')
    return out
  }

  // блоки смены: [подготовка | M6 | после M6 до первого переезда к работе]
  const blocks = changes.map((c, n) => {
    const next = changes[n + 1] ?? lines.length
    let prevWork = -1
    for (const w of work) { if (w < c) prevWork = w; else break }
    if (n > 0 && prevWork < changes[n - 1]) prevWork = changes[n - 1]      // прежний инструмент ничего не делал
    let pre = null
    if (n > 0) {
      pre = []
      let lastMotion = -1
      for (let i = prevWork + 1; i < c; i++) if (kind[i] !== 'cmd') lastMotion = i
      for (let i = prevWork + 1; i < c; i++) {
        if (keep(i)) pre.push(lines[i])
        else if (i === lastMotion && kind[i] === 'rapidxy') pre.push(lines[i])     // переезд в точку смены инструмента
      }
    }
    const post = []
    let i = c + 1
    for (; i < next && kind[i] !== 'rapidxy' && kind[i] !== 'cut' && kind[i] !== 'plunge'; i++) if (keep(i)) post.push(lines[i])
    const t = toolNo(lines[c]) ?? toolNo([...(pre || [])].reverse().find(l => toolNo(l) != null) || '') ?? toolNo(post.find(l => toolNo(l) != null) || '')
    const s = [lines[c], ...post].map(rpmOf).find(v => v != null) ?? null
    const mills = kind.slice(c, next).includes('cut')            // после этой смены фреза режет по XY
    const tPre = pre && pre.map(l => tplLine(l, t, s))
    const tM6 = tplLine(lines[c], t, s)
    const tPost = post.map(l => tplLine(l, t, s))
    return { c, n, pre, t, s, mills, tPre, tM6, tPost, key: norm([tM6, ...tPost].join('|')) }
  })

  // виды смены: по самой смене и тому, что после неё (включение шпинделя / головы)
  const groups = []
  for (const b of blocks) {
    let g = groups.find(x => x.key === b.key)
    if (!g) groups.push(g = { key: b.key, blocks: [] })
    g.blocks.push(b)
  }
  for (const g of groups) {
    g.mills = g.blocks.some(b => b.mills)
    g.tools = [...new Set(g.blocks.map(b => b.t).filter(v => v != null))]
    // подготовка к смене — самая частая среди смен этого вида, кроме первой в программе (у неё подготовка слита с началом)
    const pres = g.blocks.filter(b => b.tPre).map(b => b.tPre)
    const count = new Map()
    for (const p of pres) { const k = norm(p.join('|')); count.set(k, { p, n: (count.get(k)?.n || 0) + 1 }) }
    g.pre = [...count.values()].sort((a, b) => b.n - a.n)[0]?.p || null
    g.ref = g.blocks[0]
  }
  let spindle = groups[0], head = null
  if (groups.length > 1) {
    const millG = groups.filter(g => g.mills).sort((a, b) => b.blocks.length - a.blocks.length)
    const drillG = groups.filter(g => !g.mills).sort((a, b) => b.blocks.length - a.blocks.length)
    if (millG.length && drillG.length) {
      spindle = millG[0]; head = drillG[0]
      if (millG.length > 1 || drillG.length > 1) warnings.push(`Видов смены инструмента больше двух (${groups.length}). Взяты самые частые — проверьте команды.`)
    } else {
      // по рабочим ходам не понять — голова та, что включается не M3 / M4
      const m34 = g => /(?:^|\s)M0?[34](?=\D|$)/i.test(g.ref.tPost.join(' ') + ' ' + g.ref.tM6)
      spindle = groups.find(m34) || groups[0]
      head = groups.find(g => g !== spindle)
      warnings.push('Найдено несколько видов смены инструмента, но по программе не видно, какой из них фрезерный шпиндель. Проверьте, где шпиндель и где голова.')
    }
  }

  // начало программы: служебные строки до первой смены, без хвоста, совпадающего с подготовкой к смене
  const first = blocks[0]
  const firstG = groups.find(g => g.blocks.includes(first))
  let startLines = lines.slice(0, first.c).filter((l, i) => kind[i] === 'cmd' || kind[i] === 'rapidxy')
  let pre0 = firstG.pre
  if (pre0) {
    const want = pre0.map(norm)
    const tail = startLines.map(l => norm(tplLine(l, first.t, first.s)))
    let k = 0
    while (k < want.length && k < tail.length && tail[tail.length - 1 - k] === want[want.length - 1 - k]) k++
    startLines = startLines.slice(0, startLines.length - k)
  } else {
    const prep = []
    while (startLines.length && isPrep(startLines[startLines.length - 1])) prep.unshift(startLines.pop())
    pre0 = prep.map(l => tplLine(l, first.t, first.s))
    firstG.pre = pre0
  }
  startLines = startLines.filter(l => !/^G0?0\s/i.test(l) || !/[XY]/i.test(l))   // переезды из начала не нужны

  // команды вида: подготовка + M6 + после M6 до включения (шпинделя / головы) — «начало», остальное — «конец»
  const cmds = g => {
    const post = g.ref.tPost
    const on = post.findIndex(l => SPIN_ON.test(l))
    const cut = on >= 0 ? on + 1 : post.length
    return { start: [...(g.pre || []), g.ref.tM6, ...post.slice(0, cut)].join('\n'), end: post.slice(cut).join('\n') }
  }
  const sp = cmds(spindle), hd = head ? cmds(head) : null

  // конец программы: после последнего рабочего хода. Переезд там — парковка шпинделя: остаётся как у станка,
  // своя парковка приложения отключается, чтобы порядок команд был тот же
  const lastWork = work[work.length - 1]
  const endIdx = []
  for (let i = lastWork + 1; i < lines.length; i++) if (kind[i] === 'cmd' || kind[i] === 'rapidxy') endIdx.push(i)
  const parkLine = endIdx.find(i => kind[i] === 'rapidxy')
  const park = parkLine != null ? { line: lines[parkLine] } : null
  const endLines = endIdx.map(i => lines[i])

  // что ещё видно по программе
  const tools = []
  for (const b of blocks) if (b.t != null && !tools.some(x => x.t === b.t && x.s === b.s)) tools.push({ t: b.t, s: b.s })
  const ij = lines.some(l => /(?:^|\s)G0?[23](?=\D|$)/i.test(l) && /[IJ]\s*-?[\d.]/i.test(l))
  const rArcs = lines.some(l => /(?:^|\s)G0?[23](?=\D|$)/i.test(l) && /R\s*-?[\d.]/i.test(l))
  const onCode = g => (g.ref.tPost.concat(g.ref.tM6).join(' ').match(/(?:^|\s)(M0?[34]|M1[34])(?=\D|$)/i) || [])[1] || ''

  // ── инструменты и режимы: что делал каждый инструмент между сменами ──
  const learned = learnTools(lines, notes, kind, blocks, head ? new Set(head.tools) : new Set())
  for (const t of learned.tools) if (!(t.d > 0)) warnings.push(`Диаметр T${t.t} в программе не указан — впишите его в «Инструментах».`)

  report.push(`Строк с командами: ${lines.length}, рабочих ходов: ${work.length}.`)
  report.push(`Смен инструмента: ${changes.length}${tools.length ? ` — ${tools.map(x => `T${x.t}${x.s ? ` S${x.s}` : ''}`).join(', ')}` : ''}.`)
  if (head) {
    report.push(`Два вида смены инструмента. Шпиндель: ${spindle.tools.map(t => 'T' + t).join(', ') || '—'}${onCode(spindle) ? ` (${onCode(spindle)})` : ''}. Присадочная голова: ${head.tools.map(t => 'T' + t).join(', ') || '—'}${onCode(head) ? ` (${onCode(head)})` : ''}.`)
    report.push('У станка включится «Присадочная голова», её команды встанут в свой блок, а свёрла с этими номерами в базе инструментов будут отмечены «в присадочной голове».')
  }
  if (learned.tools.length) report.push(`Инструменты: ${learned.tools.map(t => `T${t.t} ${t.type === 'mill' ? 'фреза' : 'сверло'}${t.d ? ' Ø' + t.d : ''}${t.rpm ? ' S' + t.rpm : ''}${t.feed ? ' F' + t.feed : ''}${t.head ? ' (голова)' : ''}`).join('; ')}.`)
  if (learned.post.safeZ != null) report.push(`Высота безопасности Z${learned.post.safeZ}; Z считается ${learned.post.zRef === 'top' ? 'от верхней пласти' : 'от стола'}${learned.post.millOver != null ? `, заглубление фрезы в стол ${learned.post.millOver} мм` : ''}.`)
  if (learned.ops.angle) report.push(`Врезание фрезы под углом ~${learned.ops.angle}°${learned.ops.passes > 1 ? `, контур в ${learned.ops.passes} прохода` : ', контур в один проход на всю глубину'}.`)
  if (dropped) report.push(`Комментарии отброшены (${dropped} строк) — у каждой программы они свои.`)
  if (numbered) report.push('В программе были номера строк (N…) — они убраны: наша программа их не ставит.')
  if (ij) report.push('Дуги в программе — G2/G3 с I, J: в «Основных» включится вывод дуг так же.')
  if (park) report.push(`Парковка в конце (${park.line}) осталась в конце программы как у станка; своя парковка из «Основных» для этого станка отключится.`)
  if (rArcs) warnings.push('Дуги в программе заданы радиусом (R). Наша программа выводит дуги через I, J или отрезками — проверьте, что станок их принимает.')
  if (lines.some(l => /(?:^|\s)G20(?=\D|$)/.test(l))) warnings.push('Программа в дюймах (G20). Приложение считает в миллиметрах — G20 в начале программы заменён на G21.')
  if (!/\{T\}/.test(sp.start) || (hd && !/\{T\}/.test(hd.start))) warnings.push('Номер инструмента в смене не распознан — проверьте строку смены и поставьте {T} вручную.')
  if (tools.some(x => x.s != null) && !/\{S\}/.test(sp.start + sp.end)) warnings.push('Обороты шпинделя не распознаны — поставьте {S} вручную.')
  if (blocks.length === 1) warnings.push('Смена инструмента в программе одна — граница между началом программы и сменой определена по типичным командам. Проверьте.')

  const fixUnits = l => l.replace(/(^|\s)G20(?=\D|$)/g, '$1G21')
  return {
    ok: true,
    cmdStart: startLines.map(fixUnits).join('\n'),
    cmdToolStart: sp.start, cmdToolEnd: sp.end,
    cmdEnd: endLines.join('\n'),
    head: hd ? { cmdHeadStart: hd.start, cmdHeadEnd: hd.end, tools: head.tools } : null,
    tools, spindleTools: spindle.tools, arcs: ij ? 'ij' : null, park,
    learned,                         // { tools: [{ t, type, d, rpm, feed, inFeed, maxPass, head, cuts }], ops: { angle, entry }, post: { safeZ, zRef, millOver } }
    report, warnings,
  }
}

const mode = arr => { const m = new Map(); let best = null, bn = 0; for (const v of arr) { if (v == null || !isFinite(v)) continue; const n = (m.get(v) || 0) + 1; m.set(v, n); if (n > bn) { bn = n; best = v } } return best }
const r2 = v => Math.round(v * 100) / 100
// диаметр из комментария у смены: «diameter = 5.00», «D=6», «Ø6», «диаметр 8»
const diaOf = text => {
  const m = /(?:diam\w*|диаметр\w*|ø|⌀)\s*[=:]?\s*(\d+(?:[.,]\d+)?)/i.exec(text || '') || /(?:^|[\s;,(])D\s*=\s*(\d+(?:[.,]\d+)?)/i.exec(text || '')
  return m ? r2(Number(m[1].replace(',', '.'))) : null
}

/** Режимы каждого инструмента по его рабочим ходам: подачи, врезание, глубины; плюс высота безопасности и отсчёт Z. */
function learnTools(lines, notes, kind, blocks, headTs) {
  // модальные X, Y, Z, F после каждой строки
  let x = null, y = null, z = null, f = null
  const st = lines.map(l => {
    const px = x, py = y, pz = z
    const nx = word(l, 'X'), ny = word(l, 'Y'), nz = word(l, 'Z'), nf = word(l, 'F')
    if (nf != null) f = nf
    if (nx != null) x = nx
    if (ny != null) y = ny
    if (nz != null) z = nz
    return { px, py, pz, x, y, z, f, fx: nf }
  })
  const by = new Map()       // T -> сбор
  blocks.forEach((b, n) => {
    if (b.t == null) return
    const to = blocks[n + 1]?.c ?? lines.length
    const a = by.get(b.t) || { t: b.t, rpm: [], d: null, cuts: 0, plungeF: [], cutF: [], rampF: [], ramp: [], levels: [], minZ: Infinity }
    if (b.s != null) a.rpm.push(b.s)
    for (let i = b.c; i < Math.min(to, b.c + 4); i++) a.d = a.d ?? diaOf(notes[i])
    for (let i = b.c + 1; i < to; i++) {
      const k = kind[i], q = st[i]
      if (k === 'plunge' && q.pz != null && q.z < q.pz) { a.plungeF.push(q.fx); a.minZ = Math.min(a.minZ, q.z) }   // подача сверла — только заданная в его же строках (модальная могла остаться от прежнего инструмента)
      if (k === 'cut') {
        a.cuts++
        a.minZ = Math.min(a.minZ, q.z ?? Infinity)
        const dz = q.pz != null && q.z != null ? q.z - q.pz : 0
        if (Math.abs(dz) > 1e-6) {
          const dxy = Math.hypot((q.x ?? 0) - (q.px ?? 0), (q.y ?? 0) - (q.py ?? 0))
          if (dz < 0) { a.rampF.push(q.fx ?? q.f); if (dxy > 0.5) a.ramp.push(Math.atan(-dz / dxy) * 180 / Math.PI) }
        } else { a.cutF.push(q.fx ?? q.f); if (q.z != null) a.levels.push(r2(q.z)) }
      }
    }
    by.set(b.t, a)
  })
  const tools = [...by.values()].map(a => {
    const mill = a.cuts > 0
    const levels = [...new Set(a.levels)].sort((p, q) => q - p)
    const steps = levels.slice(1).map((v, i) => r2(levels[i] - v))
    return {
      t: a.t, type: mill ? 'mill' : 'drill', d: a.d, rpm: mode(a.rpm), head: !mill && headTs.has(a.t), cuts: a.cuts,
      feed: mill ? mode(a.cutF) : mode(a.plungeF.filter(v => v != null)),
      inFeed: mill ? mode(a.rampF) : null,
      // уровни контура: один — режет на всю глубину за проход; несколько — глубина за проход = шаг между ними
      maxPass: mill ? (levels.length > 1 ? mode(steps) : 100) : null,
      passes: mill ? Math.max(1, levels.length) : null,
      angle: a.ramp.length ? Math.max(1, Math.round(a.ramp.sort((p, q) => p - q)[a.ramp.length >> 1])) : null,
      minZ: isFinite(a.minZ) ? a.minZ : null,
    }
  }).sort((p, q) => (p.type === q.type ? p.t - q.t : p.type === 'mill' ? 1 : -1))
  // высота безопасности — самая частая высота холостых подъёмов
  const safeZ = mode(lines.map((l, i) => (kind[i] === 'rapidz' && st[i].z > 0 ? r2(st[i].z) : null)))
  // отсчёт Z: фреза режет до Z около 0 — ноль на столе; уходит глубоко в минус — ноль на верхней пласти
  const mills = tools.filter(t => t.type === 'mill' && t.minZ != null)
  const minZ = mills.length ? Math.min(...mills.map(t => t.minZ)) : null
  const zRef = minZ == null ? null : minZ < -2 ? 'top' : 'bottom'
  const main = [...mills].sort((p, q) => q.cuts - p.cuts)[0] || null
  return {
    tools,
    ops: { angle: main?.angle || null, entry: main?.angle ? 'ramp' : null, passes: main?.passes || 1, mainT: main?.t ?? null },
    post: { safeZ, zRef, millOver: zRef === 'bottom' && minZ != null ? r2(Math.max(0, -minZ)) : null },
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
