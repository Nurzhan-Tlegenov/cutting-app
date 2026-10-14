// Чтение проекта «Астра Конструктор Мебели» (.add) прямо в браузере.
// Берём панели (листовой материал): размеры, контур с вырезами и вырубками,
// кромку, пазы и присадку, а также всю модель для 3D-просмотра.
//
// Формат (восстановлен по файлу версии 320):
//   Файл — составной OLE2 с одним потоком Contents. В потоке — объекты,
//   записанные архивом MFC (CArchive), без подписей полей и длин:
//     строка 'dbvr', u32 версия, миниатюра JPEG (счётчик + байты),
//     CDocProp, CRoom, список материалов CMaterial, список крепежа CGeomFix*,
//     дерево изделий CArticle (детали CPartPanel / CPartBent / CPartArt, вложенные изделия),
//     дальше — чертежи CDraft (не читаем).
//   Указатель на объект: u16 тег. 0 — пусто; 0xFFFF — новый класс (u16 версия,
//   u16 длина имени, имя) и сразу объект; 0x8000|n — объект уже известного класса n;
//   иначе — ссылка на уже прочитанный объект n. Классы и объекты нумеруются
//   подряд с единицы. Строка: ff fe ff, длина, UTF-16.
//   Панель: контур в плоскости XY (обход по часовой), толщина — по Z от 0 до −T,
//   система координат детали (начало и три оси) — в мировых, Z мира — вверх.
//   Присадки как отверстий в файле нет: на торцах деталей стоит крепёж
//   (CFurniture: расстояние от начала или конца стороны, тип крепежа).
//   Отверстия получаем так же, как сама Астра: по параметрам крепежа, в торце
//   своей детали и в пласти той детали, к которой этот торец прилегает.
//   Правила сверены с XML-экспортом самой Астры по четырём проектам:
//     шкант        — в торец b[6], в пласть ответной e[0] − b[6];
//     конфирмат,   — если торец прилегает к пласти: ответная насквозь, в торец длина
//     саморез        винта − толщина ответной + 2; иначе (стык торец в торец) по b[6] в каждый торец;
//     минификс     — шток в торец, эксцентрик в своей пласти на b[6] от края, Ø5 в ответной;
//     полкодерж.   — эксцентрик в своей пласти, штифт в ответной на e[3] от пласти полки;
//     петля        — чашка и два самореза в двери, два отверстия планки на боковине в e[5] от её кромки.
//   Детали считаются состыкованными только при плотном прилегании (зазор до 0,1 мм).
//   Покупное изделие (CPartArt) — список сеток CGeomMesh. Грани бывают треугольные (вид 4)
//   и четырёхугольные (вид 7, как GL_QUADS); за плоскими гранями CFacePlane идёт второй список
//   граней CFace и короткий служебный хвост. Раньше читались только треугольники без хвоста —
//   файл с заглушкой из четырёхугольников (заглушки навеса) обрывался с ошибкой.
import { cfbStream, isCfb } from './cfb.js'
import { buildItem, groupItems, applyP, applyV, inverse, pointInPoly } from './basisB3d.js'

// Объект-метка выемки: в Астре выемок нет, конструктор ставит объект (панель, тело или покупное изделие)
// с названием латиницей «viemka…» / «vyemka…» и вдвигает его в деталь. Сам объект — не деталь.
const MARK = /^(viemka|vyemka|vjemka|vemka)/i
const isMark = p => MARK.test(String(p?.name || '').replace(/[\s_.-]+/g, ''))

const r1 = v => Math.round(v * 10) / 10
const r2 = v => Math.round(v * 100) / 100
const utf16 = new TextDecoder('utf-16le')
const cp1251 = (() => { try { return new TextDecoder('windows-1251') } catch { return new TextDecoder() } })()

class Stop extends Error {}

// ---------- Архив MFC ----------

class Ar {
  constructor(u8) {
    this.u8 = u8
    this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
    this.p = 0
    this.map = [null]
  }
  need(n) { if (this.p + n > this.u8.length) throw new Stop('неожиданный конец файла') }
  u8v() { this.need(1); return this.u8[this.p++] }
  u16() { this.need(2); const v = this.dv.getUint16(this.p, true); this.p += 2; return v }
  u32() { this.need(4); const v = this.dv.getUint32(this.p, true); this.p += 4; return v }
  i32() { this.need(4); const v = this.dv.getInt32(this.p, true); this.p += 4; return v }
  f32() { this.need(4); const v = this.dv.getFloat32(this.p, true); this.p += 4; return v }
  f64() { this.need(8); const v = this.dv.getFloat64(this.p, true); this.p += 8; return v }
  dd(n) { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = this.f64(); return a }
  skip(n) { this.need(n); this.p += n }
  count() { const n = this.u16(); return n === 0xffff ? this.u32() : n }
  str() {
    const u = this.u8
    if (u[this.p] === 0xff && u[this.p + 1] === 0xfe && u[this.p + 2] === 0xff) {
      this.p += 3
      let n = this.u8v()
      if (n === 0xff) { n = this.u16(); if (n === 0xffff) n = this.u32() }
      this.need(2 * n)
      const s = utf16.decode(u.subarray(this.p, this.p + 2 * n)); this.p += 2 * n
      return s
    }
    let n = this.u8v()
    if (n === 0xff) { n = this.u16(); if (n === 0xffff) n = this.u32() }
    this.need(n)
    const s = cp1251.decode(u.subarray(this.p, this.p + n)); this.p += n
    return s
  }
  obj(expect) {
    const at = this.p
    let t = this.u16(), big = false
    if (t === 0x7fff) { t = this.u32(); big = true }
    if (t === 0) return null
    let cls
    if (!big && t === 0xffff) {
      this.u16()                                 // версия класса
      const n = this.u16()
      this.need(n)
      cls = String.fromCharCode(...this.u8.subarray(this.p, this.p + n)); this.p += n
      this.map.push({ cls })
    } else if (big ? t >= 0x80000000 : t & 0x8000) {
      const i = big ? t - 0x80000000 : t & 0x7fff
      const c = this.map[i]
      if (!c || !c.cls) throw new Stop(`неверный тег класса @${at}`)
      cls = c.cls
    } else {
      const o = this.map[t]
      if (!o || o.cls) throw new Stop(`неверная ссылка на объект @${at}`)
      return o
    }
    if (expect && cls !== expect) throw new Stop(`ожидался ${expect}, а в файле ${cls} @${at}`)
    const h = H[cls]
    if (!h) throw new Stop(`неизвестный объект ${cls}`)
    const o = { _: cls, _i: this.map.length }
    this.map.push(o)
    h(this, o)
    return o
  }
  list(expect) { const n = this.count(); const a = []; for (let i = 0; i < n; i++) a.push(this.obj(expect)); return a }
}

const V = s => s.obj('CVertex').v
const fixBase = (s, o) => { o.type = s.u32(); s.u32(); o.b = s.dd(8); s.skip(2); o.s = [s.str(), s.str(), s.str()] }
const edt = (s, o) => { s.skip(4); o.end = s.obj('CGeomPartend') }
const FACE_N = { 4: 3, 7: 4 }
const face = (s, o) => {
  const mode = s.u32(), n = FACE_N[mode]
  if (!n) throw new Stop(`неизвестный вид грани ${mode}`)
  o.i = []; for (let k = 0; k < n; k++) o.i.push(s.u32())
}

function partBase(s, o) {
  o.pos = s.str(); o.name = s.str(); o.flags = s.u32()
  o.dim = s.obj('CDimOverall')
  o.el = s.obj('CGeomContourPart').el
  o.cs = s.obj('CGeomCoordSys')
  s.obj('CGeomSize'); s.obj('CGeomSize')
  o.holes = s.list('CGeomContourHole')
}
function panel(s, o) {
  partBase(s, o)
  o.grain = s.u32()                               // 1 — у детали есть направление текстуры (на раскрое не поворачивать)
  o.ang = s.obj('CAngled')
  o.mats = s.list()
  s.obj()                                         // вспомогательная «монтажная» деталь (у съёмной полки), нам не нужна
  s.obj('CPositionObject')
  s.skip(2 + 3); s.str(); s.str()
  s.u32()
  s.list(); s.list()
  o.mortises = s.list()
  s.list()
  s.obj()                                         // монтаж ящика или фасада
  if (o._ === 'CPartMontage') s.skip(16)
}
function montage(s, o) {
  s.str(); V(s); s.u32()
  if (o._ === 'CMontageBox') s.f64()
}

// Разбор каждого класса: поля идут подряд, порядок восстановлен по файлу
const H = {
  CDocProp(s, o) { o.s = [s.str(), s.str(), s.str(), s.str()] },
  CRoom(s, o) { o.d = s.dd(9) },
  CGeomColor(s, o) { o.c = [s.f32(), s.f32(), s.f32(), s.f32()] },
  CPriceMat(s) { s.dd(3) },
  CMaterial(s, o) {
    o.type = s.u32()                              // 0 — листовой, 2 — кромка, 9 — цвет
    o.s = [s.str(), s.str(), s.str(), s.str()]    // [группа, название, файл текстуры, ...]
    s.skip(21)
    o.col = []; for (let i = 0; i < 5; i++) o.col.push(s.obj('CGeomColor'))
    o.d = s.dd(3); o.u = [s.u32(), s.u32(), s.u32()]
    s.list('CPriceMat')
  },
  CGeomFixShkant(s, o) { fixBase(s, o); o.e = s.dd(1) },
  CGeomFixConf(s, o) { fixBase(s, o); o.e = s.dd(2); s.skip(3) },
  CGeomFixHenge(s, o) { fixBase(s, o); o.e = s.dd(7); s.skip(1); o.across = s.u8v() === 1; s.skip(3); o.e2 = s.dd(2) },   // across — отверстия планки в ряд поперёк кромки
  CGeomHole(s, o) { o.d = s.dd(2) },
  CGeomFixBore(s, o) { fixBase(s, o); o.holes = s.list('CGeomHole') },
  CGeomFixMini(s, o) { fixBase(s, o); o.e = s.dd(5); s.skip(1) },
  CGeomFixRaf(s, o) { fixBase(s, o); o.e = s.dd(4); s.skip(1) },
  CVertex(s, o) { o.v = s.dd(3) },
  CVector(s, o) { o.v = s.dd(3) },
  CGeomSize(s, o) { o.v = s.dd(3) },
  CGeomLine(s, o) { o.a = V(s); o.b = V(s) },
  CGeomCoordSys(s, o) { o.o = V(s); o.ax = [s.obj('CVector').v, s.obj('CVector').v, s.obj('CVector').v] },
  CGeomContour(s, o) { o.l = s.list() },
  CFurniture(s, o) { o.pos = s.f64(); o.mode = s.u32(); o.u = s.u32(); o.fix = s.obj(); o.d = s.f64() },
  CGeomPartend(s, o) {
    o.tpl = s.str(); s.f64()                      // шаблон торца («Default» или файл из «Шаблоны торцов»)
    o.prof = s.obj('CGeomContour')?.l || []       // профиль торца поперёк толщины: x < 0 — вглубь детали, y — по толщине
    s.obj('CGeomCoordSys'); s.obj('CGeomSize'); s.obj('CGeomSize'); s.dd(4)
    o.edge = s.obj()                              // материал кромки на этом торце (или пусто)
    s.skip(2)
    o.furn = s.list('CFurniture')
  },
  CGeomLineEdt(s, o) { o.a = V(s); o.b = V(s); edt(s, o) },
  CGeomDugaEdt(s, o) { edt(s, o); o.a = V(s); o.b = V(s); o.c = V(s); o.sag = s.f64(); o.r = s.f64() },
  CBaseSizes(s) { s.dd(s.u32()) },
  // угловая вырубка: [снятый угол, внутренний угол, начало дуги, конец дуги, центр]
  CGeomRcut(s, o) {
    o.a = V(s); o.b = V(s); edt(s, o)
    o.pts = [V(s), V(s), V(s), V(s), V(s)]; o.whr = s.dd(3)
    for (let k = 0; k < 2; k++) { V(s); V(s); V(s); s.f64() }
    s.obj('CBaseSizes')
  },
  // П-образная вырубка на стороне
  CGeomUcut(s, o) {
    o.a = V(s); o.b = V(s); edt(s, o)
    s.skip(8); o.d = s.dd(6)
    o.pts = []; for (let i = 0; i < 12; i++) o.pts.push(V(s))
    s.obj('CBaseSizes')
  },
  CGeomContourPart(s, o) { o.el = s.list() },
  CDimOverall(s, o) { o.d = s.dd(7); s.skip(3); o.t = s.f64(); s.f64() },
  CTypeContourRectRounded(s, o) { s.u32(); o.d = s.dd(3) },
  CTypeContourCircle(s, o) { o.r = s.f64() },
  CGeomContourHole(s, o) {
    o.el = s.list(); o.cs = s.obj('CGeomCoordSys'); s.obj('CGeomSize'); s.obj('CGeomSize'); s.skip(2); s.dd(2)
    s.obj('CAngled'); o.type = s.obj()
  },
  CAngled(s, o) { o.d = s.dd(2) },
  CPositionObject(s) { s.dd(3); s.skip(24) },
  CMortiseParams(s, o) { o.u = [s.u32(), s.u32()]; o.d = s.dd(5); s.i32() },
  CLine2D(s) { s.dd(4) },
  CMortise(s, o) {
    o.par = s.obj('CMortiseParams'); s.obj('CAngled'); s.f64()
    o.segs = []
    const n = s.count()
    for (let i = 0; i < n; i++) { const el = s.obj('CGeomContourPart').el; s.obj('CGeomCoordSys'); s.obj('CGeomSize'); s.obj('CGeomSize'); o.segs.push(el) }
    s.list('CLine2D')
  },
  CMontageBox: montage,
  CMontageFasad: montage,
  CPartPanel: panel,
  CPartMontage: panel,
  CPartBent(s, o) {
    partBase(s, o)
    s.skip(4); s.dd(2); s.skip(2)
    o.mats = s.list()
    s.skip(6)
    s.obj('CPositionObject')
    s.skip(2 + 3); s.str(); s.str(); s.skip(8)
  },
  // покупное изделие сеткой треугольников (ножка, ручка): вершины уже в мировых координатах
  // грань: вид примитива как в OpenGL (4 — треугольник, 7 — четырёхугольник) и номера вершин;
  // у плоской грани ещё по байту на ребро и число в конце
  CFace(s, o) { face(s, o) },
  CFacePlane(s, o) { face(s, o); s.skip(o.i.length); s.f64() },
  // сетка: вершины, нормали, плоские грани, остальные грани, служебный список чисел, 2 байта
  CGeomMesh(s, o) {
    o.v = s.list('CVertex').map(q => q.v); s.skip(2); s.list('CVector')
    const fs = [...s.list('CFacePlane'), ...s.list('CFace')].filter(Boolean)
    o.f = fs.flatMap(q => q.i.length === 4 ? [[q.i[0], q.i[1], q.i[2]], [q.i[0], q.i[2], q.i[3]]] : [q.i])
    s.skip(4 * s.count()); s.skip(2)
  },
  CPartArt(s, o) {
    o.pos = s.str(); o.name = s.str()
    o.mesh = s.list('CGeomMesh')
    s.skip(8)
    o.mats = s.list()
    s.skip(6)
    s.obj('CPositionObject')
    s.skip(2 + 3); s.str(); s.str(); s.skip(8)
  },
  CArticle(s, o) {
    o.name = s.str(); s.str(); s.u32()
    const n = s.u32(); s.skip(8 * n)
    o.parts = s.list()
    const k = s.u32(); s.skip(4 * k)
    o.subs = s.list('CArticle')
    s.f64(); s.obj('CGeomCoordSys'); s.skip(3); s.u32()
    o.extra = s.obj()
    s.obj('CPositionObject')
  },
}

// ---------- Геометрия ----------

const near2 = (a, b) => Math.abs(a[0] - b[0]) < 0.01 && Math.abs(a[1] - b[1]) < 0.01
const P2 = v => [v[0], v[1]]
const arc = (a, b, c) => {
  const cr = (a[0] - c[0]) * (b[1] - c[1]) - (a[1] - c[1]) * (b[0] - c[0])
  return { t: 'A', c, a, b, ccw: cr > 0 }
}

// Элемент контура Астры -> отрезки и дуги
function expand(e) {
  const a = P2(e.a), b = P2(e.b)
  if (e._ === 'CGeomLineEdt') return [{ t: 'L', a, b }]
  if (e._ === 'CGeomDugaEdt') return [{ t: 'A', c: P2(e.c), a, b, ccw: e.sag > 0 }]
  const out = []
  const line = (p, q) => { if (!near2(p, q)) out.push({ t: 'L', a: p, b: q }) }
  if (e._ === 'CGeomRcut') {
    const [, inner, s0, s1, c] = e.pts.map(P2)
    if (near2(s0, s1)) { line(a, inner); line(inner, b) }
    else { line(a, s0); out.push(arc(s0, s1, c)); line(s1, b) }
    return out
  }
  if (e._ === 'CGeomUcut') {
    const p = e.pts.map(P2)
    const k1 = p[6], k2 = p[7]
    if (near2(p[8], p[9])) { line(a, k1) } else { line(a, p[8]); out.push(arc(p[8], p[9], [p[8][0] + p[9][0] - k1[0], p[8][1] + p[9][1] - k1[1]])) }
    const from = near2(p[8], p[9]) ? k1 : p[9]
    if (near2(p[10], p[11])) { line(from, k2); line(k2, b) }
    else { line(from, p[10]); out.push(arc(p[10], p[11], [p[10][0] + p[11][0] - k2[0], p[10][1] + p[11][1] - k2[1]])); line(p[11], b) }
    return out
  }
  return [{ t: 'L', a, b }]
}

const polyOf = elems => {
  const out = []
  for (const e of elems) {
    if (e.t === 'L') { out.push(e.a); continue }
    const r = Math.hypot(e.a[0] - e.c[0], e.a[1] - e.c[1])
    const a0 = Math.atan2(e.a[1] - e.c[1], e.a[0] - e.c[0])
    let a1 = Math.atan2(e.b[1] - e.c[1], e.b[0] - e.c[0])
    if (e.ccw) { while (a1 <= a0 + 1e-9) a1 += 2 * Math.PI } else { while (a1 >= a0 - 1e-9) a1 -= 2 * Math.PI }
    const n = Math.max(3, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 12)))
    for (let i = 0; i < n; i++) { const t = a0 + (a1 - a0) * i / n; out.push([e.c[0] + r * Math.cos(t), e.c[1] + r * Math.sin(t)]) }
  }
  return out
}

// Мир Астры (Z вверх) -> мир просмотра (Y вверх): (x, y, z) -> (x, z, −y)
const up = v => [v[0], v[2], -v[1]]
// Матрица детали: p' = R·p + t, где p — в системе панели с толщиной от 0 до T
function matrixOf(cs, T) {
  const [X, Y, Z] = cs.ax.map(up), o = up(cs.o)
  return [
    X[0], Y[0], Z[0], X[1], Y[1], Z[1], X[2], Y[2], Z[2],
    o[0] - T * Z[0], o[1] - T * Z[1], o[2] - T * Z[2],
  ]
}

const hex = c => '#' + c.slice(0, 3).map(v => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0')).join('')
const fixName = f => (f.s[2] || f.s[0] || '').trim()

// Контуры детали в системе панели: внешний и вырезы
function loopsOf(part) {
  const loops = [{ src: part.el, outer: true }]
  for (const h of part.holes || []) {
    const o = h.cs.o, X = h.cs.ax[0], Y = h.cs.ax[1]
    const tf = v => [o[0] + v[0] * X[0] + v[1] * Y[0], o[1] + v[0] * X[1] + v[1] * Y[1], 0]
    loops.push({ src: h.el.map(e => ({ ...e, a: tf(e.a), b: tf(e.b), ...(e.c ? { c: tf(e.c) } : {}), ...(e.pts ? { pts: e.pts.map(tf) } : {}) })), outer: false, hole: h, tf })
  }
  return loops
}

// Пазы в торце: прямоугольные выемки профиля торца. В профиле y — высота от пласти z = 0 (у нас она внизу,
// в файле это Z = −T), x — вглубь детали со знаком минус. Сверено по шаблону «Паз от лицевой.xml»: параметры
// [0, 10, 3.8, 3.5] — глубина 10, 3.8 от пласти Z = 0 файла, ширина 3.5 — дают выемку y 8.7…12.2 на x = −10 при T = 16.
function edgeNotches(e, T) {
  const out = []
  for (const l of e.end?.prof || []) {
    if (!l.a || !l.b) continue
    const x = l.a[0]
    if (Math.abs(l.b[0] - x) > 0.01 || x > -0.05) continue
    const z0 = Math.max(0, Math.min(l.a[1], l.b[1])), z1 = Math.min(T, Math.max(l.a[1], l.b[1]))
    if (z1 - z0 > 0.2 && z1 - z0 < T - 0.2) out.push({ z0, z1, depth: -x })
  }
  return out
}

// Отверстия от крепежа на торцах одной детали — в мировых координатах.
// Крепёж стоит на стороне контура: pos — от начала (mode 1) или от конца (mode 2) стороны.
function furnitureHoles(part, T, M, out, plates, faceAt) {
  for (const lp of loopsOf(part)) {
    for (const e of lp.src) {
      const furn = e.end?.furn
      if (!furn?.length || e._ !== 'CGeomLineEdt') continue
      const a = P2(e.a), b = P2(e.b)
      const len = Math.hypot(b[0] - a[0], b[1] - a[1])
      if (len < 0.5) continue
      const dir = [(b[0] - a[0]) / len, (b[1] - a[1]) / len]
      // контуры обходятся по часовой: материал внешнего контура — справа, у выреза — слева
      const nin = lp.outer ? [dir[1], -dir[0]] : [-dir[1], dir[0]]
      for (const f of furn) {
        const fx = f.fix
        if (!fx || !fx.b) continue
        const at = f.mode === 2 ? [b[0] - dir[0] * f.pos, b[1] - dir[1] * f.pos] : [a[0] + dir[0] * f.pos, a[1] + dir[1] * f.pos]
        const name = fixName(fx)
        const push = (p, d, dia, depth, extra) => {
          if (!(dia > 0) || !(depth > 0)) return
          out.push({ P: applyP(M, p), D: applyV(M, d), r: dia / 2, depth, name, from: part, ...extra })
        }
        const mid = T / 2
        const endIn = (dia, depth) => push([at[0], at[1], mid], [nin[0], nin[1], 0], dia, depth, { only: 'edge' })
        const mate = (dia, depth, z = mid) => push([at[0], at[1], z], [-nin[0], -nin[1], 0], dia, depth, { only: 'face' })
        // пласть: u = 1 — та, что в файле на Z = −T (у нас z = 0), u = 2 — на Z = 0 (у нас z = T)
        const faceZ = f.u === 1 ? 0 : T, faceD = f.u === 1 ? 1 : -1
        const own = (inset, dia, depth, along = 0) => push([at[0] + nin[0] * inset + dir[0] * along, at[1] + nin[1] * inset + dir[1] * along, faceZ], [0, 0, faceD], dia, depth, { only: 'face' })
        const [, , , , , dMate, dEnd] = fx.b
        switch (fx._) {
          case 'CGeomFixShkant':          // шкант: в торец и в пласть ответной детали (fx.e[0] — общая глубина сверления)
            endIn(dMate, dEnd); mate(dMate, fx.e[0] - dEnd); break
          case 'CGeomFixConf': {          // конфирмат, саморез, соединитель
            // торец прилегает к пласти: ответная деталь — насквозь, в торец — длина винта минус её толщина, плюс 2 мм запаса
            const Tm = faceAt(applyP(M, [at[0], at[1], mid]), applyV(M, [-nin[0], -nin[1], 0]))
            if (Tm) { endIn(fx.e[0], fx.e[1] - Tm + 2); mate(dMate, Tm) }
            else {
              // пласти рядом нет (стык торец в торец или пусто): в каждый торец — на свою глубину
              endIn(fx.e[0], dEnd)
              push([at[0], at[1], mid], [-nin[0], -nin[1], 0], fx.e[0], dEnd, { only: 'edge', entry: true })
            }
            break
          }
          case 'CGeomFixMini':            // минификс: шток в ответную деталь, эксцентрик в пласти своей
            endIn(fx.e[0], dEnd); mate(dMate, fx.e[3])
            if (f.u === 1 || f.u === 2) own(dEnd, fx.e[1], fx.e[2])
            break
          case 'CGeomFixRaf':             // полкодержатель, стяжка: эксцентрик в своей пласти, штифт в ответной
            // штифт стоит не по середине толщины, а на fx.e[3] от той пласти, где эксцентрик
            if (f.u === 1 || f.u === 2) { mate(dMate, fx.e[1], f.u === 1 ? fx.e[3] : T - fx.e[3]); own(dEnd, fx.e[0], fx.e[2]) }
            else mate(dMate, fx.e[1])
            break
          case 'CGeomFixHenge':           // петля: чашка в двери, ответная планка — на боковине
            if (f.u === 1 || f.u === 2) {
              own(dEnd, fx.e[0], fx.e[2])                                    // чашка
              for (const k of [-0.5, 0.5]) own(dEnd + fx.e[3], dMate, fx.e[1], fx.e[4] * k)      // два самореза чашки
              plates.push({
                P: applyP(M, [at[0], at[1], faceZ]), N: applyV(M, [0, 0, -faceD]),      // точка на внутренней пласти двери и направление внутрь корпуса
                E: applyV(M, [-nin[0], -nin[1], 0]), A: applyV(M, [dir[0], dir[1], 0]),   // к торцу двери (к боковине) и вдоль торца
                back: fx.e[5], step: fx.e[6], across: !!fx.across, dia: fx.e2[0], depth: fx.e2[1], name,
              })
            }
            break
          case 'CGeomFixBore': {          // просто отверстия (крепление фурнитуры к панели)
            const h = fx.holes?.[0]?.d
            if (!h) break
            const z = [[T, 1], [0, -1]]
            // глубина 0 — сквозное отверстие в ответной панели
            for (const [zz, dz] of (f.u === 2 ? [z[0]] : f.u === 1 ? [z[1]] : z)) push([at[0] + nin[0] * f.d, at[1] + nin[1] * f.d, zz], [0, 0, dz], h[0], h[1] > 0 ? h[1] : 22, { only: 'face' })
            break
          }
          default:
        }
      }
    }
  }
}

// ---------- Выемки по объектам-меткам ----------

// Метка -> точки тела в мировых координатах просмотра и (у панели / тела Астры) точный контур с матрицей
function markSolid(p) {
  if (p._ === 'CPartArt') {
    const pts = []
    for (const m of p.mesh || []) for (const q of m.v || []) pts.push(up(q))
    return pts.length ? { pts } : null
  }
  const T = p.dim?.t
  if (!(T > 0)) return null
  const M = matrixOf(p.cs, T)
  const elems = (p.el || []).flatMap(expand)
  const poly = polyOf(elems)
  if (poly.length < 3) return null
  const pts = []
  for (const z of [0, T]) for (const q of poly) pts.push(applyP(M, [q[0], q[1], z]))
  return { pts, elems, M }
}

// выпуклая оболочка точек на плоскости (для покупного изделия — форма выемки в плане)
function hull(ps) {
  const a = [...ps].sort((p, q) => p[0] - q[0] || p[1] - q[1])
  const cr = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0])
  const lo = [], hi = []
  for (const p of a) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 1e-9) lo.pop(); lo.push(p) }
  for (const p of [...a].reverse()) { while (hi.length >= 2 && cr(hi[hi.length - 2], hi[hi.length - 1], p) <= 1e-9) hi.pop(); hi.push(p) }
  return lo.slice(0, -1).concat(hi.slice(0, -1))
}

// Где каждая метка входит в панели: Map(панель -> { face: [выемки на пласти], edge: [выемки в торце] }), used — сколько меток сработало.
//   касается пласти (z = 0 или z = T) — выемка на пласти, глубина — сколько вошла; обеих — сквозной вырез;
//   внутри толщины и выходит на торец — выемка в торце (как паз в торце: длина вдоль торца, высота, глубина).
function markPockets(marks, solid) {
  const res = new Map()
  let used = 0
  const tol = 0.3
  for (const mk of marks) {
    const ms = markSolid(mk)
    if (!ms) continue
    let hit = false
    for (const sp of solid) {
      const q = ms.pts.map(P => applyP(sp.Mi, P))
      const xs = q.map(v => v[0]), ys = q.map(v => v[1]), zs = q.map(v => v[2])
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys), z0 = Math.min(...zs), z1 = Math.max(...zs)
      const za = Math.max(z0, 0), zb = Math.min(z1, sp.T)
      if (zb - za < 0.2) continue
      const pxs = sp.poly.map(v => v[0]), pys = sp.poly.map(v => v[1])
      const px0 = Math.min(...pxs), px1 = Math.max(...pxs), py0 = Math.min(...pys), py1 = Math.max(...pys)
      const ox0 = Math.max(x0, px0), ox1 = Math.min(x1, px1), oy0 = Math.max(y0, py0), oy1 = Math.min(y1, py1)
      if (ox1 - ox0 < 0.2 || oy1 - oy0 < 0.2) continue
      if (!pointInPoly([(ox0 + ox1) / 2, (oy0 + oy1) / 2], sp.poly)) continue
      const slot = res.get(sp.part) || { face: [], edge: [] }
      const top = z1 >= sp.T - tol, bottom = z0 <= tol
      if (top || bottom) {
        // форма в плане: у панели / тела — точный контур (если лежит параллельно пласти), иначе выпуклая оболочка
        let elems
        if (ms.elems && Math.abs(applyV(sp.Mi, applyV(ms.M, [0, 0, 1]))[2]) > 0.99) {
          const map = v => { const w = applyP(sp.Mi, applyP(ms.M, [v[0], v[1], 0])); return [w[0], w[1]] }
          const o = map([0, 0]), ux = map([1, 0]), uy = map([0, 1])
          const flipArc = (ux[0] - o[0]) * (uy[1] - o[1]) - (ux[1] - o[1]) * (uy[0] - o[0]) < 0
          elems = ms.elems.map(e => (e.t === 'A' ? { ...e, a: map(e.a), b: map(e.b), c: map(e.c), ccw: flipArc ? !e.ccw : e.ccw } : { ...e, a: map(e.a), b: map(e.b) }))
        } else {
          const h = hull(q.map(v => [v[0], v[1]]))
          elems = h.map((v, i) => ({ t: 'L', a: v, b: h[(i + 1) % h.length] }))
        }
        slot.face.push({ elems, depth: zb - za, top, through: top && bottom, name: 'Выемка' })
      } else {
        // внутри толщины: на какой торец выходит (габарит панели)
        const sides = [
          [x0 <= px0 + tol, () => ({ a: [px0, oy0], b: [px0, oy1], depth: ox1 - px0 })],
          [x1 >= px1 - tol, () => ({ a: [px1, oy0], b: [px1, oy1], depth: px1 - ox0 })],
          [y0 <= py0 + tol, () => ({ a: [ox0, py0], b: [ox1, py0], depth: oy1 - py0 })],
          [y1 >= py1 - tol, () => ({ a: [ox0, py1], b: [ox1, py1], depth: py1 - oy0 })],
        ].filter(s => s[0])
        if (sides.length !== 1) continue                   // спрятана в толще или задевает два торца — не выемка
        const e = sides[0][1]()
        slot.edge.push({ ...e, z0: za, z1: zb, name: 'Выемка в торце' })
      }
      res.set(sp.part, slot)
      hit = true
    }
    if (hit) used++
  }
  res.used = used
  return res
}

// ---------- Файл -> детали ----------

export function isAstraFile(u8) { return isCfb(u8) }

export function parseAstra(u8, opts = {}) {
  let data
  try { data = cfbStream(u8, 'Contents') } catch { throw new Error('Это не проект Астры (.add)') }
  const s = new Ar(data)
  let mats, root
  try {
    if (s.str() !== 'dbvr') throw new Stop('другая сигнатура')
    s.u32()
    s.skip(s.count())                             // миниатюра
    s.obj('CDocProp'); s.skip(2)
    s.obj('CRoom'); s.skip(8); s.skip(2)
    mats = s.list('CMaterial')
    s.list()                                      // справочник крепежа (нужен как объекты для ссылок)
    root = s.obj('CArticle')
  } catch (e) {
    if (e instanceof Stop || e instanceof RangeError) throw new Error(`Эта версия файла Астры пока не читается (${e.message}). Пришлите файл разработчику.`, { cause: e })
    throw e
  }
  const faceRule = opts.faceRule || 'holes'

  // --- обход дерева изделий ---
  const panels = [], bents = [], arts = []
  const walk = (art, path) => {
    const here = art === root ? [] : [...path, art.name.trim()]
    const take = p => {
      if (!p) return
      if (p._ === 'CPartBent') bents.push({ p, path: here })
      else if (p._ === 'CPartArt') arts.push(p)
      else panels.push({ p, path: here })
    }
    art.parts.forEach(take)
    take(art.extra)
    art.subs.forEach(a => walk(a, here))
  }
  walk(root, [])
  // объекты-метки выемок — не детали: убираем из списков
  const marks = []
  for (const list of [panels, bents]) for (let i = list.length - 1; i >= 0; i--) if (isMark(list[i].p)) { marks.push(list[i].p); list.splice(i, 1) }
  for (let i = arts.length - 1; i >= 0; i--) if (isMark(arts[i])) { marks.push(arts[i]); arts.splice(i, 1) }

  // --- отверстия от крепежа (в мировых координатах) ---
  const holes = [], plates = []
  const geo = new Map()
  for (const { p } of [...panels, ...bents]) {
    const T = p.dim.t
    if (T > 0) geo.set(p, { T, M: matrixOf(p.cs, T) })
  }
  // панели как тела: по ним ищем, к чьей пласти прилегает торец с крепежом
  const solid = []
  for (const { p } of panels) {
    const g = geo.get(p)
    if (!g || !p.mats?.[0]) continue
    solid.push({ ...g, Mi: inverse(g.M), poly: polyOf(p.el.flatMap(expand)), part: p })
  }
  const TOUCH = 0.1                                // Астра считает детали состыкованными только при плотном прилегании
  const faceAt = (P, D) => {
    for (const sp of solid) {
      const d = applyV(sp.Mi, D)
      if (Math.abs(d[2]) < 0.99) continue
      const q = applyP(sp.Mi, P)
      if (Math.abs(q[2] - (d[2] > 0 ? 0 : sp.T)) > TOUCH) continue
      if (pointInPoly(q, sp.poly)) return sp.T
    }
    return 0
  }
  for (const { p } of [...panels, ...bents]) {
    const g = geo.get(p)
    if (g) furnitureHoles(p, g.T, g.M, holes, plates, faceAt)
  }
  const markHits = markPockets(marks, solid)
  // ответные планки петель: ищем боковину, в которую упирается торец двери
  for (const pl of plates) {
    let best = null
    for (const sp of solid) {
      const q = applyP(sp.Mi, pl.P), e = applyV(sp.Mi, pl.E), n = applyV(sp.Mi, pl.N), al = applyV(sp.Mi, pl.A)
      if (Math.abs(e[2]) < 0.99 || Math.abs(n[2]) > 0.01) continue        // пласть боковины должна быть поперёк торца двери
      // внутренняя пласть боковины — та, что обращена к двери (навстречу E)
      const zf = e[2] > 0 ? 0 : sp.T
      const dist = (zf - q[2]) / e[2]                                      // от торца двери вдоль E до этой пласти: накладная дверь — меньше нуля
      if (dist < -40 || dist > 6) continue                                 // боковина под дверью (накладная) или сразу за её торцом (вкладная)
      // передняя кромка боковины: идём от двери вглубь корпуса до входа в контур
      const l = Math.hypot(n[0], n[1]) || 1
      const nn = [n[0] / l, n[1] / l]
      const inside = t => pointInPoly([q[0] + nn[0] * t, q[1] + nn[1] * t], sp.poly)
      let t0 = null
      for (let t = -30; t <= 60; t += 0.5) if (inside(t)) { t0 = t; break }
      if (t0 == null || t0 > 25) continue
      if (t0 > -30) { let lo = t0 - 0.5, hi = t0; for (let i = 0; i < 12; i++) { const m = (lo + hi) / 2; if (inside(m)) hi = m; else lo = m } t0 = hi }
      // накладная дверь закрывает торец боковины (dist <= 0) — такая боковина важнее соседней панели рядом с дверью
      const rank = dist <= 0.01 ? -dist : 1000 + dist
      if (!best || rank < best.rank) best = { sp, q, nn, al, zf, rank, t0, dz: e[2] > 0 ? 1 : -1 }
    }
    if (!best) {
      // «смежный» бок: панель параллельна двери и дверь накрывает её край — планка стоит на пласти этой панели
      for (const sp of solid) {
        const q = applyP(sp.Mi, pl.P), n = applyV(sp.Mi, pl.N), e = applyV(sp.Mi, pl.E), al = applyV(sp.Mi, pl.A)
        if (Math.abs(n[2]) < 0.99) continue
        const zf = n[2] > 0 ? 0 : sp.T                                     // пласть, обращённая к двери
        if (Math.abs(q[2] - zf) > 2) continue
        const inside = t => pointInPoly([q[0] + e[0] * t, q[1] + e[1] * t], sp.poly)
        if (!inside(0.5)) continue                                         // панель должна продолжаться за край двери
        let te = null
        for (let t = 0; t >= -60; t -= 0.5) if (!inside(t)) { te = t; break }
        if (te == null) continue
        let lo = te, hi = te + 0.5
        for (let i = 0; i < 12; i++) { const m = (lo + hi) / 2; if (inside(m)) hi = m; else lo = m }
        for (const k of [-0.5, 0.5]) {
          const back = pl.across ? pl.back + pl.step * (k + 0.5) : pl.back, side = pl.across ? 0 : pl.step * k
          const x = q[0] + e[0] * (hi + back) + al[0] * side, y = q[1] + e[1] * (hi + back) + al[1] * side
          holes.push({ P: applyP(sp.M, [x, y, zf]), D: applyV(sp.M, [0, 0, n[2] > 0 ? 1 : -1]), r: pl.dia / 2, depth: pl.depth, name: pl.name, only: 'face' })
        }
        break
      }
      continue
    }
    const { sp, q, nn, al, zf, dz, t0 } = best
    for (const k of [-0.5, 0.5]) {
      // обычно два отверстия вдоль кромки; у петель для узкого профиля — в ряд вглубь корпуса
      const back = pl.across ? pl.back + pl.step * (k + 0.5) : pl.back, side = pl.across ? 0 : pl.step * k
      const x = q[0] + nn[0] * (t0 + back) + al[0] * side, y = q[1] + nn[1] * (t0 + back) + al[1] * side
      holes.push({ P: applyP(sp.M, [x, y, zf]), D: applyV(sp.M, [0, 0, dz]), r: pl.dia / 2, depth: pl.depth, name: pl.name, only: 'face' })
    }
  }

  // --- панели -> детали ---
  const matName = m => (m?.s?.[1] || '').trim()
  const colors = {}
  for (const m of mats) if (m.type !== 2 && matName(m) && !colors[matName(m)]) colors[matName(m)] = hex(m.col[0].c)
  const makers = []
  for (const { p, path } of panels) {
    const g = geo.get(p)
    const mat = p.mats?.[0]
    if (!g || !mat || p._ === 'CPartMontage') continue
    makers.push(() => {
      const { T, M } = g
      const elems = [], butts = []
      const add = (src, pieces) => {
        const edge = src.end?.edge
        for (const e of pieces) {
          elems.push(e)
          if (edge && matName(edge)) butts.push({ e, name: matName(edge), info: { mat: matName(edge), sign: '', thick: edge.d?.[2] || null, width: edge.d?.[1] || null } })
        }
      }
      for (const lp of loopsOf(p)) {
        const ty = lp.hole?.type
        if (ty?._ === 'CTypeContourCircle' && ty.r > 0) {
          const c = lp.tf([ty.r, ty.r, 0])
          add(lp.src[0], [{ t: 'C', c: [c[0], c[1]], r: ty.r }])
        } else for (const e of lp.src) add(e, expand(e))
      }
      // пазы: прямоугольник на пласти; глубина — в параметрах
      const cutsRaw = []
      let warnCuts = 0
      for (const m of p.mortises || []) {
        for (const seg of m.segs) {
          const pts = seg.flatMap(e => [e.a, e.b])
          const xs = pts.map(q => q[0]), ys = pts.map(q => q[1])
          const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys)
          const rect = seg.length === 4 && seg.every(e => e._ === 'CGeomLineEdt' && (Math.abs(e.a[0] - e.b[0]) < 0.01 || Math.abs(e.a[1] - e.b[1]) < 0.01))
          const depth = m.par.d[4]
          if (!rect || !(depth > 0) || x1 - x0 < 0.5 || y1 - y0 < 0.5) { warnCuts++; continue }
          cutsRaw.push({ p: [x0, y0], q: [x1, y1], depth: Math.min(depth, T), top: Math.abs(pts[0][2]) < T / 2, name: 'Паз' })
        }
      }
      // пазы в торце (шаблон торца с выемкой в профиле)
      const edgeCutsRaw = []
      for (const lp of loopsOf(p)) {
        for (const e of lp.src) {
          const ns = edgeNotches(e, T)
          if (!ns.length) continue
          if (!lp.outer || e._ !== 'CGeomLineEdt') { warnCuts += ns.length; continue }   // торец выреза или фигурный участок — пока не умеем
          for (const n of ns) edgeCutsRaw.push({ a: P2(e.a), b: P2(e.b), ...n, name: 'Паз в торце' })
        }
      }
      const mh = markHits.get(p)
      if (mh) edgeCutsRaw.push(...mh.edge)
      const product = path[path.length - 1] || ''
      const pos = (p.pos || '').trim(), name = (p.name || '').trim()
      const material = matName(mat)
      return buildItem({
        T, elems, texDir: 1, M, butts, cutsRaw, edgeCutsRaw, pocketsRaw: mh?.face || [], decorRaw: [], warnCuts, tol: TOUCH, strict: true,
        name, prefix: product, material, rotatable: p.grain === 0, anim: null,
        meta: {
          src: 'astra',
          ids: [p._i],
          des: pos && product ? `${pos}(${product})` : pos,      // как в чертежах Астры: позиция(изделие)
          pos, name, product, productDes: '', productPos: '',
          path: path.slice(0, -1),
          material, materialCode: '',
        },
      }, holes, faceRule)
    })
  }
  const { items, groups, skipped } = groupItems(makers)

  // --- остальное для 3D: фурнитура, профили, техника, стены (детали не из листа) ---
  const extras = []
  for (const { p } of bents) {
    const g = geo.get(p)
    if (!g) continue
    const loops = loopsOf(p).map(lp => polyOf(lp.src.flatMap(expand)).map(q => [r1(q[0]), r1(q[1])])).filter(pl => pl.length > 2)
    if (!loops.length) continue
    const nm = (p.name || '').trim()
    const material = matName(p.mats?.[0])
    extras.push({
      t: r1(g.T), m: g.M.map((v, i) => (i < 9 ? Math.round(v * 1e6) / 1e6 : r2(v))),
      outline: loops[0], holes: loops.slice(1),
      name: p.flags === 0x20 ? 'Стена' : nm.startsWith('@@') ? 'Направляющая' : nm,
      material: p.flags === 0x20 ? 'стена' : material,
    })
  }

  // покупные изделия сеткой — как «фурнитура» (координаты — целые десятые мм)
  const meshes = {}, hardware = []
  const I = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]
  for (const a of arts) {
    const pos = []
    for (const m of a.mesh || []) for (const f of m.f) for (const i of f) { const q = m.v[i]; if (!q) continue; const w = up(q); pos.push(Math.round(w[0] * 10), Math.round(w[1] * 10), Math.round(w[2] * 10)) }
    if (pos.length < 9) continue
    meshes[a._i] = { name: (a.name || '').trim(), groups: [{ mat: matName(a.mats?.[0]), pos }] }
    hardware.push({ f: a._i, m: I })
  }

  const orderName = ''
  for (const it of items) { it.contour.meta.order = orderName; it.contour.meta.model = '' }
  const scene = {
    v: 1, order: orderName,
    // «FREE» в Астре — материал не назначен (вспомогательные плоскости под перфорацию): в общий вид не берём
    parts: items.filter(it => !/^free$/i.test(it.material)).map(it => ({ name: it.name, w: it.w, h: it.h, edges: it.edges, contour: it.contour })),
    extras, meshes, hardware, colors,
  }
  const marksUnused = marks.length - markHits.used
  return { orderName, scene, skipped, items, groups, marks: { found: marks.length, unused: marksUnused },
    ...(opts.debug ? { debug: { holes, plates, solid } } : {}) }
}

export async function readAstraFile(file, opts) {
  const res = parseAstra(new Uint8Array(await file.arrayBuffer()), opts)
  const title = file.name.replace(/\.[^.]+$/, '')
  res.orderName = title
  res.scene.order = title
  for (const it of res.items) { it.contour.meta.file = file.name; it.contour.meta.order = title }
  return res
}
