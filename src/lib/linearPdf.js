// PDF линейного раскроя: A4, на странице — сводка (хлысты по длинам, метраж, отход) и карты хлыстов
// (полоса хлыста с отрезками, подписи длин, список отрезков с названиями, остаток). Одинаковые хлысты — группой «× N».
// Страница рисуется на canvas и кладётся в PDF картинкой (как карты раскроя листов) — кириллица без шрифтов.
import { zlibSync, strToU8 } from 'fflate'
import { groupBars } from './linearNest'

let PW = 1654, PH = 2339, K = PW / 210
const mm = v => v * K
const INK = '#1F1F1D', MUTED = '#6B6A66', BRAND = '#009BDE'
const fmt = v => String(Math.round(v * 10) / 10).replace('.', ',')

function pdfFromCanvas(ctx, pages, ptW = 595.28, ptH = 841.89) {
  const chunks = [], offsets = []
  let size = 0
  const put = d => { const b = typeof d === 'string' ? strToU8(d) : d; chunks.push(b); size += b.length }
  const obj = (n, body, stream) => { offsets[n] = size; put(`${n} 0 obj\n${body}\n`); if (stream) { put('stream\n'); put(stream); put('\nendstream\n') } put('endobj\n') }
  put('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')
  const kids = []
  let n = 3
  for (const draw of pages) {
    draw()
    const px = ctx.getImageData(0, 0, PW, PH).data, rgb = new Uint8Array(PW * PH * 3)
    for (let a = 0, b = 0; a < px.length; a += 4, b += 3) { rgb[b] = px[a]; rgb[b + 1] = px[a + 1]; rgb[b + 2] = px[a + 2] }
    const img = zlibSync(rgb, { level: 6 }), content = `q ${ptW} 0 0 ${ptH} 0 0 cm /Im0 Do Q`
    const page = n, cont = n + 1, im = n + 2; n += 3
    kids.push(`${page} 0 R`)
    obj(page, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${ptW} ${ptH}] /Resources << /XObject << /Im0 ${im} 0 R >> >> /Contents ${cont} 0 R >>`)
    obj(cont, `<< /Length ${content.length} >>`, content)
    obj(im, `<< /Type /XObject /Subtype /Image /Width ${PW} /Height ${PH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${img.length} >>`, img)
  }
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>')
  obj(2, `<< /Type /Pages /Count ${kids.length} /Kids [${kids.join(' ')}] >>`)
  const xref = size
  put(`xref\n0 ${n}\n0000000000 65535 f \n`)
  for (let i = 1; i < n; i++) put(String(offsets[i]).padStart(10, '0') + ' 00000 n \n')
  put(`trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  const out = new Uint8Array(size)
  let o = 0
  for (const c of chunks) { out.set(c, o); o += c.length }
  return out
}

/** job — { name, material, kerf, trim }, res — результат linearCut -> Uint8Array PDF */
export function buildLinearPdf(job, res) {
  PW = 1654; PH = 2339; K = PW / 210
  const cv = document.createElement('canvas'); cv.width = PW; cv.height = PH
  const ctx = cv.getContext('2d')
  const groups = groupBars(res.bars)
  const maxLen = Math.max(1, ...res.bars.map(b => b.stock))
  const rowH = 30                                   // мм на группу хлыстов
  const first = 8, per = 9
  const chunks = [groups.slice(0, first)]
  for (let i = first; i < groups.length; i += per) chunks.push(groups.slice(i, i + per))
  const text = (s, x, y, size, opt = {}) => {
    ctx.font = `${opt.bold ? '600 ' : ''}${mm(size)}px Arial, Helvetica, sans-serif`
    ctx.fillStyle = opt.color || INK; ctx.textAlign = opt.align || 'left'; ctx.textBaseline = 'alphabetic'
    ctx.fillText(String(s), mm(x), mm(y))
  }
  const pages = chunks.map((list, pi) => () => {
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, PW, PH)
    text('RaskroyPro', 15, 14, 4.2, { bold: true, color: BRAND })
    text(`raskroypro.com · лист ${pi + 1} из ${chunks.length}`, 195, 14, 3, { color: MUTED, align: 'right' })
    let y = 26
    if (pi === 0) {
      text(`Линейный раскрой: ${job.name || ''}`, 15, y, 6, { bold: true }); y += 8
      text(`Материал: ${job.material || '—'} · пропил ${fmt(job.kerf ?? 0)} мм · торцовка ${fmt(job.trim ?? 0)} мм с конца`, 15, y, 3.6, { color: MUTED }); y += 7
      text(`Хлысты: ${res.byStock.map(b => `${b.len} мм × ${b.count}`).join(', ') || '—'}`, 15, y, 4.2, { bold: true }); y += 6
      text(`Закупить: ${fmt(res.total / 1000)} м · в отрезках: ${fmt(res.cutLen / 1000)} м · отход ${fmt(res.waste)}%`, 15, y, 3.8); y += 6
      if (res.unplaced.length) { text(`Не помещаются в хлыст: ${res.unplaced.map(u => `${u.len}×${u.qty}`).join(', ')}`, 15, y, 3.6, { color: '#B42318' }); y += 6 }
      y += 4
    }
    for (const g of list) {
      const w = 180 * (g.stock / maxLen)
      text(`${g.count > 1 ? g.count + ' × ' : ''}хлыст ${g.stock} мм`, 15, y, 3.8, { bold: true })
      text(`остаток ${fmt(g.rest)} мм`, 195, y, 3.4, { color: MUTED, align: 'right' })
      y += 2.5
      const x0 = 15
      ctx.strokeStyle = INK; ctx.lineWidth = 2; ctx.strokeRect(mm(x0), mm(y), mm(w), mm(9))
      let x = x0 + 180 * ((job.trim || 0) / maxLen)
      g.cuts.forEach((c, j) => {
        const cw = 180 * (c.len / maxLen)
        ctx.fillStyle = j % 2 ? '#C9D6E3' : '#DCE6F0'; ctx.fillRect(mm(x), mm(y), mm(cw), mm(9))
        ctx.strokeStyle = '#506070'; ctx.lineWidth = 1.5; ctx.strokeRect(mm(x), mm(y), mm(cw), mm(9))
        if (cw > 9) text(fmt(c.len), x + cw / 2, y + 6.2, 3.2, { align: 'center', bold: true })
        x += cw + 180 * ((job.kerf || 0) / maxLen)
      })
      y += 13
      // отрезки этого хлыста: длина × кол-во и названия
      const cnt = new Map()
      for (const c of g.cuts) { const k = `${c.len}|${c.name || ''}|${c.angles || ''}`; cnt.set(k, (cnt.get(k) || 0) + 1) }
      const line = [...cnt.entries()].map(([k, q]) => { const [l, nm, an] = k.split('|'); return `${fmt(Number(l))}${an ? ' ∠' + an : ''}${q > 1 ? ' × ' + q : ''}${nm ? ' — ' + nm : ''}` }).join(';   ')
      text(line.length > 150 ? line.slice(0, 147) + '…' : line, 15, y, 3.1, { color: MUTED })
      y += rowH - 15.5
    }
  })
  return pdfFromCanvas(ctx, pages)
}

async function shareFile(data, name) {
  const file = new File([data], name, { type: 'application/pdf' })
  let can
  try { can = !!navigator.share && !!navigator.canShare && navigator.canShare({ files: [file] }) } catch { can = false }
  const phone = window.matchMedia?.('(pointer: coarse)').matches
  if (can && phone) {
    try { await navigator.share({ files: [file], title: name }); return } catch (e) { if (e?.name === 'AbortError') return }
  }
  const url = URL.createObjectURL(file)
  const a = document.createElement('a'); a.href = url; a.download = name
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

const safeName = s => String(s || '').trim().replace(/[\\/:*?"<>|]+/g, '_')
export async function shareLinearPdf(job, res) {
  return shareFile(buildLinearPdf(job, res), safeName(`Линейный раскрой ${job.name || ''}`) + '.pdf')
}

/**
 * Бирки на отрезки: одна бирка — страница размером с бирку (как бирки деталей), по порядку хлыстов.
 * На бирке: длина крупно, углы реза, название отрезка, материал, заказ/раскрой, «хлыст N · отрезок k», номер из общего числа.
 */
export function buildLinearLabels(job, res, { w = 58, h = 40 } = {}) {
  PW = Math.round(w * 12); PH = Math.round(h * 12); K = 12
  const cv = document.createElement('canvas'); cv.width = PW; cv.height = PH
  const ctx = cv.getContext('2d')
  const list = []
  res.bars.forEach((b, bi) => b.cuts.forEach((c, ci) => list.push({ ...c, bar: bi + 1, k: ci + 1, stock: b.stock })))
  const fit = (s, maxW, size, bold) => {
    let sz = size
    do { ctx.font = `${bold ? '700 ' : ''}${mm(sz)}px Arial, Helvetica, sans-serif`; if (ctx.measureText(s).width <= mm(maxW)) break; sz -= 0.3 } while (sz > 1.6)
    return sz
  }
  const text = (s, x, y, size, opt = {}) => {
    const sz = fit(String(s), opt.maxW || w - 4, size, opt.bold)
    ctx.font = `${opt.bold ? '700 ' : ''}${mm(sz)}px Arial, Helvetica, sans-serif`
    ctx.fillStyle = opt.color || INK; ctx.textAlign = opt.align || 'left'; ctx.textBaseline = 'alphabetic'
    ctx.fillText(String(s), mm(x), mm(y))
  }
  const pages = list.map((c, i) => () => {
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, PW, PH)
    ctx.strokeStyle = INK; ctx.lineWidth = 3; ctx.strokeRect(mm(1), mm(1), mm(w - 2), mm(h - 2))
    text(job.name || '', 3, h * 0.17, h * 0.09, { bold: true })
    text(job.material || '', 3, h * 0.29, h * 0.075, { color: MUTED })
    text(`${fmt(c.len)} мм`, w / 2, h * 0.58, h * 0.24, { bold: true, align: 'center' })
    if (c.angles) text(`∠ ${c.angles}°`, w - 3, h * 0.29, h * 0.08, { bold: true, align: 'right', maxW: w / 3 })
    text(c.name || '', 3, h * 0.76, h * 0.09, { bold: true })
    text(`хлыст ${c.bar} (${c.stock}) · отрезок ${c.k}`, 3, h * 0.92, h * 0.07, { color: MUTED, maxW: w * 0.68 })
    text(`${i + 1}/${list.length}`, w - 3, h * 0.92, h * 0.07, { align: 'right', maxW: w * 0.3 })
  })
  return pdfFromCanvas(ctx, pages, (w / 25.4) * 72, (h / 25.4) * 72)
}
export async function shareLinearLabels(job, res, size) {
  return shareFile(buildLinearLabels(job, res, size), safeName(`Бирки отрезков ${job.name || ''}`) + '.pdf')
}
