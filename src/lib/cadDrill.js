// Конструктор: присадка по правилам.
// 1) Стыки плит находятся сами по геометрии: торец одной детали упирается в пласть другой (боковина ↔ дно, крышка,
//    стойка, неподвижная полка, царга; боковины ящика ↔ передняя/задняя) — на стык ставится крепёж по схеме проекта:
//    конфирмат (сквозное Ø7 в пласть + Ø5 в торец) и/или шкант (Ø8 в пласть + Ø8 в торец).
// 2) Отверстия от фурнитуры корпуса (чашки петель, планки петель, полкодержатели) приходят готовыми точками из корпуса.
// Все отверстия считаются в координатах сцены, а затем переводятся в присадку детали в формате бланка заказа
// (как у импорта из Базиса) — дальше их видно в редакторе контура, в 3D, на картах раскроя и в программах ЧПУ.

export const JOINTS = [
  ['confirmat_dowel', 'Конфирмат + шкант'],
  ['confirmat', 'Конфирмат'],
  ['minifix_dowel', 'Минификс + шкант'],
  ['minifix', 'Минификс'],
  ['dowel', 'Шканты (на клей)'],
  ['none', 'Без присадки (уголки, стяжки, саморезы)'],
]
// минификс (эксцентрик Ø15): штифт Ø5 в пласть A (не насквозь), канал Ø8 в торец B до эксцентрика, эксцентрик Ø15 в скрытую пласть B
export const MINIFIX = { cam: 15, camDepth: 12.5, camFrom: 24, bolt: 5, boltDepth: 11, channel: 8 }
const NO_JOINT_ROLES = new Set(['фасад', 'задняя', 'опора', 'стекло', 'металл'])
const EPS = 0.2
const r1 = v => Math.round(v * 10) / 10
const AXV = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
const axisOf = v => v.findIndex(c => Math.abs(c) > 0.5)
const dirVec = key => { const a = 'xyz'.indexOf(key[1]); const v = [0, 0, 0]; v[a] = key[0] === '-' ? -1 : 1; return v }
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

const frame = m => ({ ex: [m[0], m[3], m[6]], ey: [m[1], m[4], m[7]], ez: [m[2], m[5], m[8]], o: [m[9], m[10], m[11]] })

// позиции крепежа вдоль стыка длиной len: ea мм от начала, eb — от конца (симметрично — равны), между ними — шаг не больше step
function spots(len, ea = 50, eb = ea, step = 600) {
  if (len < 70) return []
  if (len < ea + eb + 40) return [len / 2]
  const a = ea, b = len - eb
  const n = Math.max(1, Math.ceil((b - a) / Math.max(50, step)))
  return Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n)
}

// схема крепежа -> правила. Готовые — по названию; свои — 'u:<id>' из списка схем пользователя:
// { name, fast: 'confirmat' | 'minifix' | 'dowel' | 'none', dowel: шканты рядом, end, endB (несимметрично), step, shift (шкант от крепежа), dowelMin }
const BUILTIN = {
  confirmat_dowel: { fast: 'confirmat', dowel: true }, confirmat: { fast: 'confirmat' },
  minifix_dowel: { fast: 'minifix', dowel: true }, minifix: { fast: 'minifix' }, dowel: { fast: 'dowel' }, none: { fast: 'none' },
}
export function schemeRules(id, customs = {}) {
  const c = String(id || '').startsWith('u:') ? customs?.[String(id).slice(2)] : BUILTIN[id]
  const r = { fast: 'confirmat', dowel: false, end: 50, endB: null, step: 600, shift: 32, dowelMin: 200, ...(c || BUILTIN.confirmat_dowel) }
  r.endB = r.endB == null || r.endB === '' ? r.end : Number(r.endB)
  return r
}
/** все стыки плит: торец B упирается в пласть A */
function findJoins(parts) {
  const cand = parts.filter(sp => sp.kind === 'sheet' && !NO_JOINT_ROLES.has(sp.role) && sp.place.T >= 10)
  const out = []
  for (const A of cand) {
    const k = axisOf(frame(A.place.m).ez), a = A.place.aabb
    for (const B of cand) {
      if (B === A) continue
      const b = B.place.aabb
      const kb = axisOf(frame(B.place.m).ez)
      if (kb === k) continue
      let side = 0
      if (Math.abs(b[k] - a[k + 3]) <= EPS) side = +1
      else if (Math.abs(b[k + 3] - a[k]) <= EPS) side = -1
      if (!side) continue
      const m = 3 - k - kb
      const o0 = Math.max(a[kb], b[kb]), o1 = Math.min(a[kb + 3], b[kb + 3])
      const m0 = Math.max(a[m], b[m]), m1 = Math.min(a[m + 3], b[m + 3])
      if (o1 - o0 < 6 || m1 - m0 < 40) continue
      out.push({ A, B, k, kb, side, m, o0, o1, m0, m1 })
    }
  }
  return out
}
const pairKey = (A, B) => `${A.key}|${B.key}`
/** какая схема у стыка: своя у стыка (item.jointPair) -> у детали A -> у детали B -> проекта */
export function jointSchemeOf(A, B, scheme0) {
  const own = A.item === B.item ? (A.jointPair?.[pairKey(A, B)] || A.jointPair?.[pairKey(B, A)]) : null
  return own || A.joint || B.joint || scheme0
}
/** стыки одной детали (для карточки детали): [{ key, other, len, scheme, own }] */
export function partJoints(parts, pid, scheme0 = 'confirmat_dowel') {
  return findJoins(parts).filter(j => j.A.pid === pid || j.B.pid === pid).map(j => {
    const other = j.A.pid === pid ? j.B : j.A
    const own = j.A.item === j.B.item ? (j.A.jointPair?.[pairKey(j.A, j.B)] || j.A.jointPair?.[pairKey(j.B, j.A)]) : null
    return { key: pairKey(j.A, j.B), other, len: Math.round(j.m1 - j.m0), scheme: jointSchemeOf(j.A, j.B, scheme0), own: own || null, sameItem: j.A.item === j.B.item }
  })
}

/** Стыки и отверстия от них: [{ pid, p: [x,y,z] вход, n: [dx,dy,dz] внутрь детали, d, depth, note }] */
export function jointHoles(parts, scheme0 = 'confirmat_dowel', customs = {}) {
  const out = []
  const all = findJoins(parts)
  const byA = new Map()
  for (const j of all) { if (!byA.has(j.A)) byA.set(j.A, []); byA.get(j.A).push(j) }
  for (const [A, joins] of byA) {
    const k = joins[0].k
    const a = A.place.aabb
    const TA = a[k + 3] - a[k]
    // детали с двух сторон одной пласти напротив друг друга (полки по обе стороны стойки) — крепёж второй стороны
    // сдвигаем, чтобы сквозной конфирмат и шканты не попали в одно место
    const facing = j => joins.some(o => o.side !== j.side && o.kb === j.kb && Math.min(o.o1, j.o1) - Math.max(o.o0, j.o0) > 0 && Math.min(o.m1, j.m1) - Math.max(o.m0, j.m0) > 0)
    for (const { B, kb, side, m, o0, o1, m0, m1 } of joins) {
      // схема стыка: своя у стыка, у детали (например, столешница на минификсах — без сквозных отверстий), иначе — проекта
      const R = schemeRules(jointSchemeOf(A, B, scheme0), customs)
      if (R.fast === 'none') continue
      const shifted = side < 0 && facing({ kb, side, o0, o1, m0, m1 })
      const c = (o0 + o1) / 2                      // середина торца B
      const face = side > 0 ? a[k + 3] : a[k]       // общая плоскость стыка
      const outer = side > 0 ? a[k] : a[k + 3]      // наружная пласть A
      const into = AXV[k].map(v => v * side)        // от A в B
      const back = AXV[k].map(v => -v * side)
      const at = (kv, mv) => { const p = [0, 0, 0]; p[k] = kv; p[kb] = c; p[m] = mv; return p.map(r1) }
      const len = m1 - m0
      const sh = shifted ? 50 : 0
      const ss = spots(len, Number(R.end) + sh, Number(R.endB) + sh, Number(R.step))
      const conf = R.fast === 'confirmat'
      const mfx = R.fast === 'minifix'
      const dowelOnly = R.fast === 'dowel'
      const dow = dowelOnly || (R.dowel && len >= Number(R.dowelMin))
      const b = B.place.aabb, TB = b[kb + 3] - b[kb]
      ss.forEach((s, i) => {
        const mv = m0 + s
        if (conf) {
          out.push({ pid: A.pid, p: at(outer, mv), n: into, d: 7, depth: r1(TA), note: 'Конфирмат' })
          out.push({ pid: B.pid, p: at(face, mv), n: into, d: 5, depth: r1(Math.max(10, 50 - TA)), note: 'Конфирмат' })
        }
        if (mfx) {
          out.push({ pid: A.pid, p: at(face, mv), n: back, d: MINIFIX.bolt, depth: r1(Math.min(MINIFIX.boltDepth, TA - 3)), note: 'Минификс: штифт' })
          out.push({ pid: B.pid, p: at(face, mv), n: into, d: MINIFIX.channel, depth: MINIFIX.camFrom + 4, note: 'Минификс: канал' })
          // эксцентрик — в пласть B, что смотрит внутрь (к середине детали A): у левой боковины — внутренняя сторона и т. п.
          const inward = (a[kb] + a[kb + 3]) / 2 > (b[kb] + b[kb + 3]) / 2
          const pc = [0, 0, 0]; pc[k] = face + side * MINIFIX.camFrom; pc[kb] = inward ? b[kb + 3] : b[kb]; pc[m] = mv
          const nc = [0, 0, 0]; nc[kb] = inward ? -1 : 1
          out.push({ pid: B.pid, p: pc.map(r1), n: nc, d: MINIFIX.cam, depth: r1(Math.min(MINIFIX.camDepth, TB - 3)), note: 'Минификс: эксцентрик' })
        }
        if (dow) {
          // шкант — на 32 мм от конфирмата внутрь стыка (без конфирмата — на месте конфирмата)
          const shf = Number(R.shift) || 32
          const dm = dowelOnly ? mv : mv + (i === ss.length - 1 ? -shf : shf)
          if (dm < m0 + 20 || dm > m1 - 20) return
          out.push({ pid: A.pid, p: at(face, dm), n: back, d: 8, depth: r1(Math.min(12, TA - 4)), note: 'Шкант' })
          out.push({ pid: B.pid, p: at(face, dm), n: into, d: 8, depth: 20, note: 'Шкант' })
        }
      })
    }
  }
  return out
}

/** Отверстие фурнитуры без детали (точка + направление) -> деталь, в пласть или торец которой оно входит */
export function attachHoles(parts, holes) {
  const out = []
  for (const h of holes) {
    const n = Array.isArray(h.n) ? h.n : dirVec(h.n)
    const ax = axisOf(n), sg = n[ax]
    const own = parts.filter(sp => sp.kind === 'sheet' && (!h.item || sp.item.id === h.item) && (!h.key || sp.key === h.key))
    const hit = own.find(sp => {
      const b = sp.place.aabb
      if (Math.abs((sg > 0 ? b[ax] : b[ax + 3]) - h.p[ax]) > EPS) return false
      return [0, 1, 2].every(i => i === ax || (h.p[i] >= b[i] - 0.01 && h.p[i] <= b[i + 3] + 0.01))
    })
    if (hit) out.push({ ...h, n, pid: hit.pid })
  }
  return out
}

function sideOffsets(X, Y, W, L) {
  const sides = [], offsets = {}
  if (X <= W / 2 + 1e-6) { sides.push('left'); offsets.left = r1(X) } else { sides.push('right'); offsets.right = r1(W - X) }
  if (Y <= L / 2 + 1e-6) { sides.push('bottom'); offsets.bottom = r1(Y) } else { sides.push('top'); offsets.top = r1(L - Y) }
  return { sides, offsets }
}
let seq = 0
const drillId = () => 'cad' + Date.now().toString(36) + (seq++).toString(36)

/** Отверстие в сцене -> присадка детали (формат бланка): пласть (face) или торец (edge) */
export function holeToDrilling(sp, h) {
  const { W, L, T, m } = sp.place
  const f = frame(m)
  const q = sub(h.p, f.o)
  const lx = dot(q, f.ex), ly = dot(q, f.ey), lz = dot(q, f.ez)
  const ln = [dot(h.n, f.ex), dot(h.n, f.ey), dot(h.n, f.ez)]
  const la = axisOf(ln)
  const depth = r1(Math.min(h.depth, la === 2 ? T : la === 0 ? W : L))
  const base = { id: drillId(), installed: true, d: r1(h.d), depth, row: false, rowStep: 32, rowCount: 2, note: h.note || '' }
  if (la === 2) {
    // в пласть: входит с лицевой (z = T, внутрь -z) или с обратной (z = 0, внутрь +z)
    const front = ln[2] < 0
    return { ...base, kind: 'face', face: front ? 'front' : 'back', ...sideOffsets(lx, ly, W, L), attachTo: [], rowDir: 'x' }
  }
  // в торец: сторона детали, через которую входит
  const edgeSide = la === 0 ? (ln[0] > 0 ? 'left' : 'right') : (ln[1] > 0 ? 'bottom' : 'top')
  return { ...base, kind: 'edge', edgeSide, alongFrom: 'start', offsetAlong: r1(la === 0 ? ly : lx), offsetFace: r1(T - lz) }
}

/** Вся присадка проекта: Map pid -> [присадка детали], и список отверстий сцены для показа в 3D */
export function projectDrillings(parts, scheme, extraHoles = [], customs = {}) {
  const all = [...jointHoles(parts, scheme, customs), ...attachHoles(parts, extraHoles)]
  const byPid = new Map(parts.map(sp => [sp.pid, sp]))
  const map = new Map()
  const seen = new Set()
  for (const h of all) {
    const sp = byPid.get(h.pid)
    if (!sp) continue
    const key = `${h.pid}|${h.p.map(v => Math.round(v)).join(',')}|${h.d}|${h.n.join(',')}`
    if (seen.has(key)) continue
    seen.add(key)
    if (!map.has(h.pid)) map.set(h.pid, [])
    map.get(h.pid).push(holeToDrilling(sp, h))
  }
  return { map, holes: all }
}
