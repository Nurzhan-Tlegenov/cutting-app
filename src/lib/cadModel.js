// Конструктор мебели: проект = набор элементов сцены.
//   cabinet — параметрический корпус (детали считаются из параметров, см. cadCabinet.js);
//   panel   — свободная панель (плита, задаётся размерами и положением);
//   glass   — стекло / зеркало (как панель, но в раскрой плиты не идёт — в спецификацию, м²);
//   profile — погонный элемент: металлический профиль, труба, карниз (в спецификацию и в линейный раскрой хлыстов).
// У каждого элемента: положение pos {x, y, z} (мм, левый нижний задний угол) и поворот rotY (0/90/180/270°).
// Всё переводится в «записи» деталей (брусок + оси), а из них — в детали заказа с 3D-положением (как импорт из Базиса),
// поэтому дальше работают уже готовые раскрой, 3D-просмотр, редактор контура, бирки и ЧПУ.
import { cabinetParts, CAB_DEFAULTS } from './cadCabinet.js'
import { frameParts, FRAME_DEFAULTS } from './cadFrame.js'
import { projectDrillings } from './cadDrill.js'
import { linearCut, parseStocks } from './linearNest.js'

export const CAD_VERSION = 1
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d)
const r1 = v => Math.round(v * 10) / 10
const r2 = v => Math.round(v * 100) / 100
export const newId = () => Math.random().toString(36).slice(2, 9)

export const PROJECT_DEFAULTS = {
  rotatable: true,               // детали без текстуры можно вращать при раскрое
  joint: 'confirmat_dowel',      // крепёж на стыках плит (cadDrill.js)
  hardwareHoles: true,           // отверстия под петли, планки, полкодержатели, направляющие
  room: { on: false, W: 3500, D: 3000, H: 2700 },   // комната: стены слева, сзади, справа
  stockLen: 6000, linearKerf: 3, // хлыст погонного материала (по умолчанию) и пропил при линейном раскрое
  stocks: {},                    // свои хлысты материала: { [название]: '2000, 3000, 6000' }
  prices: {},                    // цена материала: { [название]: число } — за м², за метр или за штуку (по виду)
}

// крепёж фурнитуры — как пользователь собирает (запоминается за аккаунтом, копия — в проекте, чтобы заказ считался так же):
// mode none — на саморезы, без присадки; drill — сверлить отверстие d × depth (наколка, евровинт, впрессовка — что задаст пользователь)
export const MOUNT_DEFAULTS = {
  slide: { mode: 'none', d: 5, depth: 13 },       // направляющие ящиков
  plate: { mode: 'none', d: 5, depth: 13 },       // планки петель
  cup: { d: 35, depth: 12 },                      // чашка петли — сверлится всегда
  cupFix: { mode: 'none', d: 8, depth: 11.5 },    // крепёж чашки: саморезы или впрессовка (2 отв. рядом с чашкой)
  pin: { d: 5, depth: 12 },                       // полкодержатели — сверлятся всегда
  handle: { d: 5 },                               // ручки — сквозные
  rod: { mode: 'none', d: 4, depth: 12 },         // штангодержатели
}
const MOUNT_OF = { 'Направляющая': 'slide', 'Планка петли': 'plate', 'Петля (чашка)': 'cup', 'Петля (крепёж чашки)': 'cupFix', 'Полкодержатель': 'pin', 'Ручка': 'handle', 'Штангодержатель': 'rod' }
export const mountOf = mount => Object.fromEntries(Object.keys(MOUNT_DEFAULTS).map(k => [k, { ...MOUNT_DEFAULTS[k], ...(mount?.[k] || {}) }]))
/** отверстия фурнитуры -> с диаметром и глубиной по крепежу пользователя; «на саморезы» — без отверстий */
export function applyMount(holes, mount) {
  const M = mountOf(mount)
  const out = []
  for (const h of holes) {
    const g = MOUNT_OF[h.note]
    if (!g) { out.push(h); continue }
    const m = M[g]
    if (m.mode === 'none') continue
    out.push({ ...h, d: num(m.d, h.d), depth: g === 'handle' ? h.depth : num(m.depth, h.depth) })
  }
  return out
}

export function newProject(name = 'Новый проект') {
  return { v: CAD_VERSION, name, settings: { ...PROJECT_DEFAULTS }, items: [] }
}

export function newItem(type, extra = {}) {
  const base = { id: newId(), type, pos: { x: 0, y: 0, z: 0 }, rotY: 0 }
  if (type === 'cabinet') return { ...base, name: 'Корпус', ...extra, p: { ...CAB_DEFAULTS, ...(extra.p || {}) } }
  if (type === 'panel') return { ...base, name: 'Панель', p: { dx: 600, dy: 16, dz: 400, tAxis: 1, lAxis: 0, tSign: 1, material: 'ЛДСП Белый 16', edgeAll: '', edges: {}, grooves: [] }, ...extra }
  if (type === 'glass') return { ...base, name: 'Стекло', p: { dx: 600, dy: 4, dz: 400, tAxis: 1, lAxis: 0, tSign: 1, material: 'Стекло прозрачное 4 мм' }, ...extra }
  if (type === 'frame') return { ...base, name: 'Каркас металл', ...extra, p: { ...FRAME_DEFAULTS, ...(extra.p || {}) } }
  if (type === 'profile') return { ...base, name: 'Профиль', p: { axis: 0, len: 1000, a: 20, b: 20, material: 'Профиль 20×20 сталь' }, ...extra }
  return { ...base, ...extra }
}

const AX = ['x', 'y', 'z']
const unit = a => [a === 0 ? 1 : 0, a === 1 ? 1 : 0, a === 2 ? 1 : 0]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dirKey = v => { const i = v.findIndex(c => Math.abs(c) > 0.5); return (v[i] > 0 ? '+' : '-') + AX[i] }

// Записи деталей одного элемента — в его собственной системе (до поворота и сдвига)
export function itemRecords(it) {
  if (it.type === 'cabinet') return cabinetParts(it.p)
  if (it.type === 'frame') return frameParts(it.p)
  const p = it.p || {}
  if (it.type === 'panel' || it.type === 'glass') {
    const dx = num(p.dx, 600), dy = num(p.dy, 16), dz = num(p.dz, 400)
    const tAxis = num(p.tAxis, 1)
    let lAxis = num(p.lAxis, 0)
    if (lAxis === tAxis) lAxis = tAxis === 1 ? 0 : 1
    const edges = p.edgeAll ? { all: p.edgeAll } : { ...(p.edges || {}) }
    return {
      parts: [{
        key: 'p', name: it.name || (it.type === 'glass' ? 'Стекло' : 'Панель'), role: p.role || (it.type === 'glass' ? 'стекло' : 'панель'),
        kind: it.type === 'glass' ? 'glass' : 'sheet', box: [0, 0, 0, dx, dy, dz], tAxis, tSign: p.tSign === -1 ? -1 : 1, lAxis,
        material: p.material || '', edges: it.type === 'glass' ? {} : edges, grooves: p.grooves || [],
      }],
      holes: it.type === 'panel' ? (p.holes || []) : [],
      hw: it.type === 'glass' && p.mount && p.mount !== 'none' && num(p.mountQty, 0) > 0
        ? [{ name: p.mount === 'hinges' ? 'Петля для стеклянной двери' : 'Стеклодержатель', qty: num(p.mountQty, 0) }] : [],
      warn: [],
    }
  }
  if (it.type === 'profile') {
    const axis = num(p.axis, 0), len = num(p.len, 1000), a = num(p.a, 20), b = num(p.b, 20)
    const others = [0, 1, 2].filter(i => i !== axis)
    const size = [0, 0, 0]
    size[axis] = len; size[others[0]] = a; size[others[1]] = b
    return { parts: [{ key: 'p', name: it.name || 'Профиль', role: 'металл', kind: 'profile', box: [0, 0, 0, ...size], tAxis: others[1], tSign: 1, lAxis: axis, material: p.material || 'Профиль', edges: {}, grooves: [], section: `${a}×${b}`, len }], hw: [], warn: [] }
  }
  return { parts: [], hw: [], warn: [] }
}

// поворот вокруг вертикали на 0/90/180/270°: (x, z) -> (x', z')
function rotYMat(deg) {
  const k = ((Math.round(num(deg, 0) / 90) % 4) + 4) % 4
  const c = [1, 0, -1, 0][k], s = [0, 1, 0, -1][k]
  return [c, 0, s, 0, 1, 0, -s, 0, c]     // по строкам
}
const mulMV = (M, v) => [M[0] * v[0] + M[1] * v[1] + M[2] * v[2], M[3] * v[0] + M[4] * v[1] + M[5] * v[2], M[6] * v[0] + M[7] * v[1] + M[8] * v[2]]

/**
 * Запись -> размещённая деталь: W, L, T (ширина по X редактора, длина по Y, толщина),
 * матрица 3D (12 чисел: поворот по строкам + сдвиг, как meta.inst у импорта из Базиса),
 * мировой брусок (aabb) и какая сторона детали в редакторе смотрит куда.
 */
export function placeRecord(rec, it) {
  const b = rec.box
  const size = [b[3] - b[0], b[4] - b[1], b[5] - b[2]]
  const ez = unit(rec.tAxis).map(c => c * (rec.tSign === -1 ? -1 : 1))
  const ey = unit(rec.lAxis)
  const ex = cross(ey, ez)
  const xAxis = ex.findIndex(c => Math.abs(c) > 0.5)
  const W = size[xAxis], L = size[rec.lAxis], T = size[rec.tAxis]
  // начало детали: по каждой оси — минимум, если ось детали смотрит в плюс, иначе максимум
  const org = [0, 1, 2].map(i => {
    const v = ex[i] + ey[i] + ez[i]
    return v < 0 ? b[i + 3] : b[i]
  })
  const R = rotYMat(it?.rotY)
  const pos = [num(it?.pos?.x), num(it?.pos?.y), num(it?.pos?.z)]
  const wx = mulMV(R, ex), wy = mulMV(R, ey), wz = mulMV(R, ez)
  const o = mulMV(R, org).map((v, i) => v + pos[i])
  const m = [wx[0], wy[0], wz[0], wx[1], wy[1], wz[1], wx[2], wy[2], wz[2], r2(o[0]), r2(o[1]), r2(o[2])].map(v => (Object.is(v, -0) ? 0 : v))
  // мировой брусок
  const c0 = mulMV(R, [b[0], b[1], b[2]]), c1 = mulMV(R, [b[3], b[4], b[5]])
  const aabb = [0, 1, 2].map(i => Math.min(c0[i], c1[i]) + pos[i]).concat([0, 1, 2].map(i => Math.max(c0[i], c1[i]) + pos[i]))
  // стороны редактора -> направление в системе элемента
  const sideDir = { left: dirKey(ex.map(c => -c)), right: dirKey(ex), bottom: dirKey(ey.map(c => -c)), top: dirKey(ey) }
  return { W: r1(W), L: r1(L), T: r1(T), m, aabb: aabb.map(r1), sideDir }
}

/** Весь проект -> плоский список деталей сцены (для 3D и спецификации) */
export function projectParts(project) {
  const out = [], hw = [], warn = [], holes = [], openings = []
  ;(project?.items || []).forEach((it, ii) => {
    const r = itemRecords(it)
    r.parts.forEach(rec => {
      const sp = { ...rec, item: it, ii, pid: `${it.id}:${rec.key}`, place: placeRecord(rec, it) }
      // анимация (дверь — поворот на петлях, ящик — выезд): в координаты сцены
      if (rec.anim) {
        const Rr = rotYMat(it.rotY), ps = [num(it.pos?.x), num(it.pos?.y), num(it.pos?.z)]
        const a = rec.anim
        sp.anim = { ...a, id: `${it.id}:${a.id}`, ...(a.p ? { p: mulMV(Rr, a.p).map((v, i) => v + ps[i]) } : {}), ...(a.axis ? { axis: mulMV(Rr, a.axis) } : {}), ...(a.dir ? { dir: mulMV(Rr, a.dir) } : {}) }
      }
      // правка детали в редакторе контура (фигурный контур, вырезы, своя присадка, кромка) — пока размер детали тот же;
      // размер поменялся — контур сбрасывается до прямоугольника с предупреждением (как в бланке заказа)
      const ov = it.ov?.[rec.key]
      if (ov) {
        if (Math.abs(num(ov.W) - sp.place.W) < 0.05 && Math.abs(num(ov.L) - sp.place.L) < 0.05) sp.ov = ov
        else { sp.ovStale = true; warn.push(`${it.name}: «${rec.name}» — размер изменился (${ov.L}×${ov.W} → ${sp.place.L}×${sp.place.W}), фигурный контур и вырезы сброшены до прямоугольника`) }
      }
      out.push(sp)
    })
    r.hw.forEach(h => hw.push({ ...h, item: it.name }))
    r.warn.forEach(w => warn.push(`${it.name}: ${w}`))
    // отверстия фурнитуры элемента -> в координаты сцены
    const R = rotYMat(it.rotY), pos = [num(it.pos?.x), num(it.pos?.y), num(it.pos?.z)]
    for (const o of r.openings || []) {
      const b = o.box, c0 = mulMV(R, [b[0], b[1], b[2]]), c1 = mulMV(R, [b[3], b[4], b[5]])
      openings.push({ ...o, item: it.id, aabb: [0, 1, 2].map(i => Math.min(c0[i], c1[i]) + pos[i]).concat([0, 1, 2].map(i => Math.max(c0[i], c1[i]) + pos[i])) })
    }
    for (const h of r.holes || []) {
      const a = 'xyz'.indexOf(h.n[1]), n = [0, 0, 0]; n[a] = h.n[0] === '-' ? -1 : 1
      holes.push({ ...h, item: it.id, p: mulMV(R, h.p).map((v, i) => r2(v + pos[i])), n: mulMV(R, n).map(v => Math.round(v)) })
    }
  })
  return { parts: out, hw, warn, holes, openings }
}

/** Присадка всего проекта: стыки по схеме крепежа + отверстия фурнитуры -> { map: pid -> присадка детали, holes } */
export function projectDrill(project, pp = projectParts(project)) {
  const st = { ...PROJECT_DEFAULTS, ...(project?.settings || {}) }
  return projectDrillings(pp.parts, st.joint, st.hardwareHoles === false ? [] : applyMount(pp.holes, st.mount))
}

// кромка записи по сторонам редактора
export function editorEdges(rec, place) {
  const e = { top: null, right: null, bottom: null, left: null }
  const all = rec.edges?.all
  for (const s of Object.keys(e)) {
    const v = all || rec.edges?.[place.sideDir[s]]
    if (v) e[s] = String(v)
  }
  return e
}
const AUTO_GROOVE = 'Паз под заднюю стенку'   // пазы корпуса пересчитываются сами, в правке детали — только свои
// пазы записи -> пазы детали в формате бланка (вдоль длины — вертикальный, со смещением от стороны)
function editorGrooves(rec, place) {
  const out = []
  for (const g of rec.grooves || []) {
    const side = Object.keys(place.sideDir).find(s => place.sideDir[s] === g.from)
    if (!side) continue
    const alongL = g.along !== 'W'
    out.push({
      dir: alongL ? 'vertical' : 'horizontal',
      length: alongL ? place.L : place.W, width: num(g.width, 4), depth: num(g.depth, 8),
      sides: alongL ? ['top', 'bottom', side] : ['left', 'right', side],
      offsets: { [side]: num(g.offset, 16) }, face: g.face || 'front', note: g.note || AUTO_GROOVE, auto: true,
    })
  }
  return out
}

/** Деталь сцены -> строка заказа (как из импорта): размеры, кромка, пазы и 3D-положение в contour.meta */
export function partToDetail(sp, pos, drill = []) {
  const { place } = sp
  const W = place.W, L = place.L, T = place.T
  const meta = {
    src: 'cad', file: 'cad', ids: [sp.pid], des: '', pos: String(pos || ''), name: sp.name,
    product: sp.item?.name || '', productDes: '', productPos: '', path: [sp.role].filter(Boolean),
    material: sp.material, materialCode: '', thickness: T, texDir: 0, flipped: false, turned: false,
    local: { x0: 0, y0: 0, dx: W, dy: L }, inst: [place.m], anims: [null], role: sp.role,
  }
  const ov = sp.ov
  const contour = {
    vertices: ov?.vertices?.length > 2 ? ov.vertices : sp.shape?.length > 2 ? sp.shape : [{ x: 0, y: 0, r: 0 }, { x: W, y: 0, r: 0 }, { x: W, y: L, r: 0 }, { x: 0, y: L, r: 0 }],
    holes: ov?.holes || [], grooves: [...editorGrooves(sp, place), ...(ov?.grooves || [])], drillings: [...drill, ...(ov?.drillings || [])], layout: [], meta,
  }
  return { name: sp.name, w: L, h: W, qty: 1, edges: ov?.edges || editorEdges(sp, place), material: sp.material, thickness: T, contour, rotatable: true }
}

// погонный элемент / стекло / опора -> «деталь окружения» 3D-модели (scene.extras)
function partToExtra(sp) {
  const { W, L, T, m } = sp.place
  return { outline: [[0, 0], [W, 0], [W, L], [0, L]], holes: [], t: T, m, name: sp.name, material: sp.material, b: [sp.item?.name, sp.role].filter(Boolean).join(' / ') }
}

/** Группы плитных материалов: [{ key, material, thickness, parts: [детали сцены] }] */
export function sheetGroups(project) {
  const { parts } = projectParts(project)
  const map = new Map()
  for (const sp of parts) {
    if (sp.kind !== 'sheet') continue
    const k = `${sp.material}|${sp.place.T}`
    if (!map.has(k)) map.set(k, { key: k, material: sp.material, thickness: sp.place.T, parts: [] })
    map.get(k).parts.push(sp)
  }
  return [...map.values()].sort((a, b) => b.parts.length - a.parts.length)
}

/**
 * Проект -> данные для бланка заказа по одному материалу:
 * { items, material, thickness, orderName, scene } — scene: остальные детали (другие материалы, стекло, металл) для 3D.
 */
export function exportForOrder(project, groupKey) {
  const groups = sheetGroups(project)
  const g = groups.find(x => x.key === groupKey) || groups[0]
  if (!g) return null
  const rot = project.settings?.rotatable !== false
  const pp = projectParts(project)
  const { map } = projectDrill(project, pp)
  const items = g.parts.map((sp, i) => ({ ...partToDetail(sp, i + 1, map.get(sp.pid) || []), rotatable: rot }))
  const others = groups.filter(x => x !== g).flatMap(x => x.parts).map((sp, i) => partToDetail(sp, i + 1, map.get(sp.pid) || []))
  const { parts } = pp
  const extras = parts.filter(sp => sp.kind !== 'sheet' && !sp.vis).map(partToExtra)
  return { items, material: g.material, thickness: g.thickness, orderName: project.name || '', scene: { parts: others, extras, hardware: [], meshes: [] }, linear: linearJobs(project, parts) }
}

/** Погонные материалы проекта -> задания линейного раскроя для заказа (orders.linear) */
export function linearJobs(project, parts = projectParts(project).parts) {
  const st = { ...PROJECT_DEFAULTS, ...(project?.settings || {}) }
  const byMat = new Map()
  for (const sp of parts) {
    if (sp.kind !== 'profile') continue
    if (!byMat.has(sp.material)) byMat.set(sp.material, new Map())
    const name = [sp.item?.name, sp.name].filter(Boolean).join(' · ')
    const k = `${sp.place.L}|${name}`
    const m = byMat.get(sp.material)
    m.set(k, (m.get(k) || 0) + 1)
  }
  return [...byMat.entries()].map(([material, m]) => ({
    name: `${project.name || ''} · ${material}`, material, kerf: num(st.linearKerf, 3), trim: 0,
    stocks: stocksOf(st, material).map(s => ({ len: s.len, qty: '' })),
    pieces: [...m.entries()].map(([k, qty], i) => { const [len, name] = k.split('|'); return { id: 'p' + i, len: Number(len), qty, name } }),
  }))
}

/** Все детали проекта как детали формы (для 3D-просмотра всей модели) */
export function exportAll(project) {
  const pp = projectParts(project)
  const { parts } = pp
  const { map } = projectDrill(project, pp)
  const sheets = parts.filter(sp => sp.kind === 'sheet').map((sp, i) => partToDetail(sp, i + 1, map.get(sp.pid) || []))
  const extras = parts.filter(sp => sp.kind !== 'sheet' && !sp.vis).map(partToExtra)
  return { details: sheets, scene: { parts: [], extras, hardware: [], meshes: [] } }
}

// ── Линейный раскрой погонных материалов (профиль, труба, карниз) — см. linearNest.js ──
/** lengths — отрезки (мм), stock — длина хлыста или список «2000, 3000, 6000», kerf — пропил */
export function linearNest(lengths, stock = 6000, kerf = 3) {
  const stocks = typeof stock === 'number' ? [{ len: stock, qty: null }] : parseStocks(stock)
  const r = linearCut({ pieces: lengths.map(len => ({ len, qty: 1 })), stocks, kerf })
  return { ...r, bars: r.bars.map(b => ({ ...b, cuts: b.cuts.map(c => c.len) })), tooLong: r.unplaced.flatMap(u => Array(u.qty).fill(u.len)) }
}
export const stocksOf = (settings, material) => {
  const st = { ...PROJECT_DEFAULTS, ...(settings || {}) }
  const own = parseStocks(st.stocks?.[material])
  return own.length ? own : [{ len: num(st.stockLen, 6000), qty: null }]
}

/**
 * Спецификация проекта: плита (м², деталей), стекло (м²), погонные (метры, хлысты), фурнитура (шт), кромка (м).
 * Цены — из project.settings.prices по названию материала.
 */
export function projectSpec(project) {
  const st = { ...PROJECT_DEFAULTS, ...(project?.settings || {}) }
  const price = name => num(st.prices?.[name], 0)
  const pp0 = projectParts(project)
  const { parts, hw, warn } = pp0
  const rows = new Map()
  const row = (kind, name, unitName) => {
    const k = kind + '|' + name
    if (!rows.has(k)) rows.set(k, { kind, name, unit: unitName, qty: 0, count: 0, lengths: [] })
    return rows.get(k)
  }
  for (const sp of parts) {
    const { W, L } = sp.place
    if (sp.kind === 'sheet' || sp.kind === 'glass') {
      const r = row(sp.kind, sp.material, 'м²'); r.qty += (W * L) / 1e6; r.count++
      const all = sp.edges?.all
      if (sp.kind === 'sheet') for (const s of ['top', 'right', 'bottom', 'left']) {
        const e = sp.ov?.edges ? sp.ov.edges[s] : all || sp.edges?.[sp.place.sideDir[s]]
        if (!e) continue
        const er = row('edge', `Кромка ${e}`, 'м'); er.qty += (s === 'top' || s === 'bottom' ? W : L) / 1000
      }
    } else if (sp.kind === 'profile') {
      const r = row('profile', sp.material, 'м'); r.qty += L / 1000; r.count++; r.lengths.push(L)
    } else if (sp.kind === 'hw' && sp.role === 'опора') { /* ножки — в фурнитуре */ }
  }
  for (const h of hw) { const r = row('hw', h.name, 'шт'); r.qty += h.qty; r.count += h.qty }
  // крепёж на стыках (по присадке): конфирматы и шканты — штук
  const { holes: dh } = projectDrill(project, pp0)
  const conf = dh.filter(h => h.note === 'Конфирмат' && h.d === 7).length
  const dow = dh.filter(h => h.note === 'Шкант').length / 2
  if (conf) { const r = row('hw', 'Конфирмат 7×50', 'шт'); r.qty += conf; r.count += conf }
  if (dow) { const r = row('hw', 'Шкант 8×30', 'шт'); r.qty += Math.round(dow); r.count += Math.round(dow) }
  const list = [...rows.values()].map(r => {
    const out = { ...r, qty: r.unit === 'шт' ? r.qty : Math.round(r.qty * 1000) / 1000 }
    if (r.kind === 'profile') {
      const stocks = stocksOf(st, r.name)
      out.nest = linearCut({ pieces: r.lengths.map(len => ({ len, qty: 1 })), stocks, kerf: st.linearKerf })
      out.bars = out.nest.bars.length
      out.stockText = stocks.map(s => s.len).join(', ')
      out.buyM = out.nest.total / 1000            // метров хлыстов к закупке
    }
    const pr = price(r.name)
    // погонный: цена за метр хлыста (хлысты разной длины), остальное — за единицу
    out.price = pr
    out.sum = pr ? Math.round(pr * (r.kind === 'profile' ? out.buyM : out.qty) * 100) / 100 : 0
    return out
  })
  const order = { sheet: 0, glass: 1, profile: 2, edge: 3, hw: 4 }
  list.sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name, 'ru'))
  return { rows: list, total: Math.round(list.reduce((s, r) => s + r.sum, 0) * 100) / 100, warn, partsCount: parts.filter(p => p.kind === 'sheet').length }
}

/** «Разобрать» корпус на свободные панели: дальше каждую можно двигать и менять отдельно */
export function explodeCabinet(it) {
  const { parts, holes = [] } = itemRecords(it)
  const R = rotYMat(it.rotY)
  const sheets = parts.filter(r => r.kind === 'sheet' || r.kind === 'glass')
  // отверстия фурнитуры (петли, полкодержатели…) — к той панели, в которую входят, в её собственных координатах
  const own = new Map()
  for (const h of holes) {
    const ax = 'xyz'.indexOf(h.n[1]), plus = h.n[0] === '+'
    const r = sheets.find(r => Math.abs((plus ? r.box[ax] : r.box[ax + 3]) - h.p[ax]) <= 0.2 &&
      [0, 1, 2].every(i => i === ax || (h.p[i] >= r.box[i] - 0.01 && h.p[i] <= r.box[i + 3] + 0.01)))
    if (!r) continue
    if (!own.has(r)) own.set(r, [])
    const { key: _k, ...hh } = h   // eslint-disable-line no-unused-vars
    own.get(r).push({ ...hh, p: h.p.map((v, i) => r1(v - r.box[i])) })
  }
  return sheets.map(r => {
    const b = r.box
    const o = mulMV(R, [b[0], b[1], b[2]])
    return {
      id: newId(), type: r.kind === 'glass' ? 'glass' : 'panel', name: r.name, rotY: it.rotY || 0,
      pos: { x: r1(o[0] + num(it.pos?.x)), y: r1(o[1] + num(it.pos?.y)), z: r1(o[2] + num(it.pos?.z)) },
      p: { dx: r1(b[3] - b[0]), dy: r1(b[4] - b[1]), dz: r1(b[5] - b[2]), tAxis: r.tAxis, lAxis: r.lAxis, tSign: r.tSign, material: r.material, edgeAll: r.edges?.all || '', edges: r.edges?.all ? {} : { ...r.edges }, grooves: r.grooves || [], holes: own.get(r) || [], role: r.role, from: it.name },
      ...(it.ov?.[r.key] ? { ov: { p: it.ov[r.key] } } : {}),
    }
  })
}

/** Кромка детали сцены по сторонам редактора (с учётом правки) и её вершины контура — для подсветки кромки в 3D */
export const partEdges = sp => sp.ov?.edges || editorEdges(sp, sp.place)
export const partVerts = sp => {
  const { W, L } = sp.place
  return sp.ov?.vertices?.length > 2 ? sp.ov.vertices : sp.shape?.length > 2 ? sp.shape : [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: L }, { x: 0, y: L }]
}

/** Деталь фигурная (не прямоугольник) или с вырезами — тогда в 3D рисуется по контуру */
export const isFigured = sp => {
  const v = sp.ov?.vertices?.length > 2 ? sp.ov.vertices : sp.shape || []
  return (sp.ov?.holes || []).length > 0 || v.length > 4 || v.some(x => num(x.r) > 0 || x.type === 'arc' || x.arc || x.bulge)
}

/** Из черновика редактора контура -> правка детали (автоприсадка «cad…» и пазы корпуса не хранятся — они пересчитываются) */
export function overrideFromDraft(sp, draft) {
  const c = draft.contour || {}
  return {
    W: sp.place.W, L: sp.place.L,
    vertices: c.vertices || null, holes: c.holes || [], grooves: (c.grooves || []).filter(g => !g.auto && g.note !== AUTO_GROOVE),
    drillings: (c.drillings || []).filter(d => !String(d.id || '').startsWith('cad')),
    edges: draft.edges || null,
  }
}

/** Габарит всей сцены [x0,y0,z0,x1,y1,z1] */
export function sceneBox(parts) {
  if (!parts.length) return [0, 0, 0, 1000, 1000, 1000]
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  for (const p of parts) for (let i = 0; i < 3; i++) { b[i] = Math.min(b[i], p.place.aabb[i]); b[i + 3] = Math.max(b[i + 3], p.place.aabb[i + 3]) }
  return b
}
