// Файл раскроя, присланный пользователем («Результат раскроя», «История раскроя», «Замечание по пильному центру»)
// -> «ленты» кадров для просмотра у мастер-аккаунта (components/NestingFileViewer.jsx)

// куски файла -> «ленты» кадров: [{ title, frames: [{ t, info, usableX, usableY, sheets: [{ usableX, usableY, placed: [{ x, y, w, h, rot, poly, di, label }] }] }], details }]
function fromHistory(h, title) {
  const p = h.params || {}
  const ux = (p.sheetW || 0) - (p.marginL || 0) - (p.marginR || 0), uy = (p.sheetL || 0) - (p.marginT || 0) - (p.marginB || 0)
  const names = (h.details || []).map(d => d.name)
  const frames = (h.events || []).map(e => ({
    t: e.t, kind: e.kind, via: e.via, mode: e.mode, island: e.island, iter: e.iter, count: e.count, util: e.util, last: e.last, lastFill: e.lastFill,
    sheets: (e.sheets || []).map(sh => ({
      usableX: ux, usableY: uy,
      placed: sh.map(([di, x, y, w, h2, rot]) => ({ di, x, y, w, h: h2, rot, poly: h.shapes?.[`${di}|${rot}`] || null, label: names[di] || `#${di}` })),
    })),
  }))
  return { title, frames, details: h.details || [], params: p, config: h.config, meta: h }
}
function fromResult(r, title, details = null) {
  const ux = r.usableX, uy = r.usableY
  const sheets = (r.sheets || []).map(sh => ({
    usableX: sh.usableX ?? ux, usableY: sh.usableY ?? uy, stock: sh.stock,
    placed: (sh.placed || []).map(pl => ({
      di: pl.detailIndex, x: pl.x, y: pl.y, w: pl.w, h: pl.h, rot: pl.rotation ?? (pl.rotated ? 90 : 0),
      poly: Array.isArray(pl.polygon) && pl.polygon.length > 2 ? pl.polygon.map(q => [q.x, q.y]) : null,
      label: [pl.prefix, pl.label].filter(Boolean).join(' ') || `#${pl.detailIndex}`,
    })),
  }))
  return { title, frames: [{ t: null, kind: 'result', sheets }], details: details || [], params: null }
}
export function parseNestingFile(text) {
  const d = typeof text === 'string' ? JSON.parse(text) : text
  if (d?.format === 'raskroy-nesting-history') return [fromHistory(d, `История · конфигурация ${d.order?.configuration || 1}`)]
  if (d?.kind === 'beam_saw_feedback') {
    const out = []
    ;(d.configs || []).forEach((c, i) => {
      if (c.result?.sheets) out.push(fromResult(c.result, `Конфигурация ${i + 1} · итог`, d.details))
      if (c.history) out.push(fromHistory(c.history, `Конфигурация ${i + 1} · история`))
    })
    return out
  }
  if (Array.isArray(d?.sheets) && (d.usableX || d.sheets[0]?.placed)) return [fromResult(d, 'Результат раскроя')]
  if (Array.isArray(d?.configs)) return d.configs.filter(c => c?.result?.sheets).map((c, i) => fromResult(c.result, `Конфигурация ${i + 1}`))
  return []
}
/** Похоже ли имя файла на файл раскроя (кнопка «Открыть раскрой» в сообщении) */
export const isNestingFileName = n => /\.json$/i.test(n || '') && /(nesting|history|beamsaw)/i.test(n || '')

