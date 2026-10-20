// Группы деталей с общей текстурой (part_group) в раскроях, где сам алгоритм групп не знает (фрезер, форматник со
// складом обрезков): на входе группа заменяется ОДНИМ блоком-деталью (ширина/длина — по сумме и максимуму, без поворота,
// без контура), алгоритм укладки не меняется, а на выходе блок разворачивается обратно на детали группы: подряд,
// в порядке списка, с зазором реза между ними. Пильный центр и форматник без склада знают группы сами (beamSawNesting).
// part_group_dir: 'y' — друг над другом (вдоль длины), 'x' — рядом (вдоль ширины).
import { roughShapePolygons } from './trueShapeNesting'

export function groupBlocks(params) {
  const det = params.details || []
  const groups = new Map()
  det.forEach((d, i) => { const g = typeof d.part_group === 'string' ? d.part_group.trim() : ''; if (g) { if (!groups.has(g)) groups.set(g, []); groups.get(g).push(i) } })
  for (const [g, idx] of [...groups]) if (idx.reduce((a, i) => a + (Number(det[i].qty) || 0), 0) < 2) groups.delete(g)   // одна деталь — не блок
  if (!groups.size) return null
  const kerf = Number(params.kerf) || 0
  const inGroup = new Set([...groups.values()].flat())
  const details = [], back = []                 // back[i2] = { i } — обычная деталь, { block } — блок группы
  const toNew = new Map()                       // исходный индекс -> новый (обычные детали)
  det.forEach((d, i) => { if (!inGroup.has(i)) { toNew.set(i, details.length); back.push({ i }); details.push(d) } })
  const blockOf = new Map()                     // имя группы -> блок
  for (const [g, idx] of groups) {
    const members = []
    idx.forEach(i => { for (let q = 0; q < (Number(det[i].qty) || 0); q++) members.push({ i, q, width: Number(det[i].width) || 0, length: Number(det[i].length) || 0 }) })
    const stack = det[idx[0]].part_group_dir === 'x' ? 'x' : 'y'
    const width = stack === 'x' ? members.reduce((a, m) => a + m.width, 0) + kerf * (members.length - 1) : Math.max(...members.map(m => m.width))
    const length = stack === 'y' ? members.reduce((a, m) => a + m.length, 0) + kerf * (members.length - 1) : Math.max(...members.map(m => m.length))
    const block = { group: g, stack, members, width, length, i2: details.length }
    blockOf.set(g, block); back.push({ block })
    details.push({ ...det[idx[0]], id: null, name: `⧉ ${g}`, display_name: `⧉ ${g}`, width, length, qty: 1, rotatable: false, contour: null, _raw: undefined, _cut: undefined,
      part_group: null, part_group_dir: null, edge_top: null, edge_right: null, edge_bottom: null, edge_left: null })
  }
  const polys = {}
  const polyOf = i => { const d = det[i]; if (!d?.contour) return null; if (!polys[i]) { try { polys[i] = roughShapePolygons(d) } catch { polys[i] = {} } } const p = polys[i]?.[0]; return p ? p.map(([x, y]) => ({ x, y })) : null }
  // блок на листе -> детали группы: подряд вдоль stack от угла блока; деталь уже блока — у той же стороны
  const expandPlaced = p => {
    const b = back[p.detailIndex]?.block
    if (!b) return [{ ...p, detailIndex: back[p.detailIndex]?.i ?? p.detailIndex, id: `${back[p.detailIndex]?.i ?? p.detailIndex}_${String(p.id || '').split('_')[1] || 0}` }]
    const rot = !!p.rotated || (p.rotation || 0) % 180 === 90
    const out = []
    let pos = 0
    b.members.forEach(m => {
      const ww = rot ? m.length : m.width, hh = rot ? m.width : m.length     // габарит детали на листе (без реза)
      const alongX = (b.stack === 'x') !== rot                               // детали идут по X листа
      const x = alongX ? p.x + pos : p.x, y = alongX ? p.y : p.y + pos
      const d = det[m.i], poly = rot ? null : polyOf(m.i)
      out.push({
        ...p, id: `${m.i}_${m.q}`, detailIndex: m.i, label: `${d.display_name || d.name || ''} ⧉${b.group}`, prefix: d.prefix,
        x, y, w: ww + kerf, h: hh + kerf, origX: ww, origY: hh, rotated: rot, rotation: rot ? 90 : 0, rotatable: false,
        edgeTop: rot ? d.edge_left : d.edge_top, edgeRight: rot ? d.edge_top : d.edge_right, edgeBottom: rot ? d.edge_right : d.edge_bottom, edgeLeft: rot ? d.edge_bottom : d.edge_left,
        ...(poly ? { polygon: poly } : {}), group: b.group,
      })
      if (out.at(-1).polygon == null) delete out.at(-1).polygon
      pos += (alongX ? ww : hh) + kerf
    })
    return out
  }
  const fixIds = sheets => {
    // у обычных деталей id = `${индекс}_${номер}`: номера — заново по порядку, чтобы не повторялись
    const cnt = new Map()
    return sheets.map(sh => ({ ...sh, placed: sh.placed.map(p => { if (p.group) return p; const q = cnt.get(p.detailIndex) || 0; cnt.set(p.detailIndex, q + 1); return { ...p, id: `${p.detailIndex}_${q}` } }) }))
  }
  const expand = res => {
    if (!res?.sheets) return res
    const sheets = fixIds(res.sheets.map(sh => ({ ...sh, placed: (sh.placed || []).flatMap(expandPlaced) })))
    // соседним потокам уходит раскладка поиска (rawSheets) — с блоками, как в их параметрах, а не развёрнутая
    return { ...res, sheets, rawSheets: res.rawSheets || res.sheets, groupsExpanded: true }
  }
  // «Продолжить»: исходная раскладка на экране — с деталями групп; собираем их обратно в блоки (если группа целиком на
  // листе и лежит блоком), иначе детали группы из исходной раскладки убираются — поиск уложит блок заново
  const compactSeed = seed => {
    if (!seed?.sheets) return seed
    const sheets = seed.sheets.map(sh => {
      const placed = [], byG = new Map()
      for (const p of sh.placed || []) {
        const d = det[p.detailIndex]
        const g = d && typeof d.part_group === 'string' ? d.part_group.trim() : ''
        if (g && blockOf.has(g)) { if (!byG.has(g)) byG.set(g, []); byG.get(g).push(p) } else if (toNew.has(p.detailIndex)) placed.push({ ...p, detailIndex: toNew.get(p.detailIndex) })
      }
      for (const [g, ps] of byG) {
        const b = blockOf.get(g)
        if (ps.length !== b.members.length) continue
        const x0 = Math.min(...ps.map(p => p.x)), y0 = Math.min(...ps.map(p => p.y))
        const x1 = Math.max(...ps.map(p => p.x + p.w)), y1 = Math.max(...ps.map(p => p.y + p.h))
        const w = x1 - x0, h = y1 - y0, W = b.width + kerf, H = b.length + kerf
        const rot = Math.abs(w - H) < 1 && Math.abs(h - W) < 1 && !(Math.abs(w - W) < 1 && Math.abs(h - H) < 1)
        if (!(Math.abs(w - (rot ? H : W)) < 1 && Math.abs(h - (rot ? W : H)) < 1)) continue
        placed.push({ ...ps[0], id: `${b.i2}_0`, detailIndex: b.i2, x: x0, y: y0, w, h, origX: rot ? b.length : b.width, origY: rot ? b.width : b.length, rotated: rot, rotation: rot ? 90 : 0, label: `⧉ ${g}`, group: undefined, polygon: undefined })
      }
      return { ...sh, placed }
    })
    return { ...seed, sheets }
  }
  return { params: { ...params, details, seed: compactSeed(params.seed) }, expand }
}
