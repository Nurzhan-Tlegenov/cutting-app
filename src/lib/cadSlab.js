import * as THREE from 'three'
import { partEdges } from './cadModel.js'

// ── деталь со скруглёнными кромками (как в программах визуализации): радиус — только на кромленых сторонах и не больше
// толщины кромки; торцы без кромки — острые. Размеры — по брусу в сцене; ta — ось толщины, r — { '+x': радиус, … } ──
// bands — { '+x': толщина кромки, … }: если задано, кромка — отдельная группа граней (своим материалом): торец целиком
// и полоска толщиной кромки на пластях у кромленого торца; группа 0 — пласти и торцы без кромки, 1 — кромка
export function roundedSlab(size, ta, r, N = 4, bands = null) {
  const [ua, va] = [0, 1, 2].filter(a => a !== ta)
  const hu = size[ua] / 2, hv = size[va] / 2, ht = size[ta] / 2
  const ax = ['x', 'y', 'z']
  const sides = [[1, 0, '+' + ax[ua]], [0, 1, '+' + ax[va]], [-1, 0, '-' + ax[ua]], [0, -1, '-' + ax[va]]].map(([nu, nv, k]) => ({ nu, nv, k, r: Math.max(0, Math.min(Number(r[k]) || 0, ht * 0.9, hu * 0.9, hv * 0.9)), b: Number(bands?.[k]) || 0 }))
  // профиль торца: сверху дуга, вниз по торцу, снизу дуга — out (наружу от линии торца), z, нормаль (наружу, вверх)
  const prof = rr => {
    const out = []
    for (let k = 0; k <= N; k++) { const a = (k / N) * Math.PI / 2; out.push([-rr + rr * Math.sin(a), ht - rr + rr * Math.cos(a), Math.sin(a), Math.cos(a)]) }
    for (let k = 0; k <= N; k++) { const a = Math.PI / 2 + (k / N) * Math.PI / 2; out.push([-rr + rr * Math.sin(a), -ht + rr + rr * Math.cos(a), Math.sin(a), Math.cos(a)]) }
    return out
  }
  const P = sides.map(sd => prof(sd.r))
  const corner = i => { const a = sides[i], b = sides[(i + 1) % 4]; return [a.nu * hu + b.nu * hu, a.nv * hv + b.nv * hv] }   // угол между стороной i и i+1
  const buf = [{ pos: [], nor: [], uv: [] }, { pos: [], nor: [], uv: [] }]
  let pos, nor, uv
  const toGroup = gi => { ({ pos, nor, uv } = buf[gi]) }
  toGroup(0)
  const V = (u, v, z, n) => {
    const p3 = [0, 0, 0]; p3[ua] = u; p3[va] = v; p3[ta] = z; pos.push(...p3)
    const n3 = [0, 0, 0]; n3[ua] = n[0]; n3[va] = n[1]; n3[ta] = n[2]; nor.push(...n3)
    // развёртка текстуры — как у пласти бруса в сцене (те же оси, что при расчёте повтора декора)
    const tu = ta === 0 ? 2 : 0, tv = ta === 2 ? 1 : ta === 0 ? 1 : 2
    uv.push((p3[tu] + size[tu] / 2) / size[tu], (p3[tv] + size[tv] / 2) / size[tv])
  }
  const tri = (a, b, c) => { V(...a); V(...b); V(...c) }
  // точка профиля j стороны i у угла c (c — соседняя сторона)
  const at = (i, c, j) => {
    const A = sides[i], B = sides[c], pa = P[i][j], pb = P[c][j]
    const cc = c === (i + 1) % 4 ? corner(i) : corner(c)
    return [cc[0] + A.nu * pa[0] + B.nu * pb[0], cc[1] + A.nv * pa[0] + B.nv * pb[0], pa[1], [A.nu * pa[2], A.nv * pa[2], pa[3]]]
  }
  const J = P[0].length
  for (let i = 0; i < 4; i++) {
    const prev = (i + 3) % 4, next = (i + 1) % 4
    toGroup(sides[i].b > 0 ? 1 : 0)
    for (let j = 0; j + 1 < J; j++) {
      const a = at(i, prev, j), b = at(i, next, j), c = at(i, next, j + 1), d = at(i, prev, j + 1)
      tri(a, d, c); tri(a, c, b)
    }
    // шов в углу между сторонами i и next (если радиусы разные — закрывает щель)
    toGroup(sides[i].b > 0 || sides[next].b > 0 ? 1 : 0)
    if (Math.abs(sides[i].r - sides[next].r) > 1e-6) for (let j = 0; j + 1 < J; j++) {
      const a = at(i, next, j), b = at(next, i, j), c = at(next, i, j + 1), d = at(i, next, j + 1)
      const n = [sides[i].nu + sides[next].nu, sides[i].nv + sides[next].nv, 0]
      tri([...a.slice(0, 3), n], [...d.slice(0, 3), n], [...c.slice(0, 3), n]); tri([...a.slice(0, 3), n], [...c.slice(0, 3), n], [...b.slice(0, 3), n])
    }
  }
  // пласти: сетка 3×3 — середина (материал) и полоски толщиной кромки у кромленых торцов (кромка)
  const e = i => (sides[i].b > 0 ? Math.max(sides[i].r, Math.min(sides[i].b, (i % 2 ? hv : hu) * 0.45)) : sides[i].r)
  const us = [-hu + sides[2].r, -hu + e(2), hu - e(0), hu - sides[0].r], vs = [-hv + sides[3].r, -hv + e(3), hv - e(1), hv - sides[1].r]
  for (const [z, top] of [[ht, true], [-ht, false]]) {
    const n = [0, 0, top ? 1 : -1]
    for (let iu = 0; iu < 3; iu++) for (let iv = 0; iv < 3; iv++) {
      const band = (iu === 0 && sides[2].b > 0) || (iu === 2 && sides[0].b > 0) || (iv === 0 && sides[3].b > 0) || (iv === 2 && sides[1].b > 0)
      if (us[iu + 1] - us[iu] < 1e-9 || vs[iv + 1] - vs[iv] < 1e-9) continue
      toGroup(band ? 1 : 0)
      const q = [[us[iu], vs[iv], z, n], [us[iu + 1], vs[iv], z, n], [us[iu + 1], vs[iv + 1], z, n], [us[iu], vs[iv + 1], z, n]]
      tri(q[0], q[1], q[2]); tri(q[0], q[2], q[3])
    }
  }
  const g = new THREE.BufferGeometry()
  const n0 = buf[0].pos.length / 3, n1 = buf[1].pos.length / 3
  g.setAttribute('position', new THREE.Float32BufferAttribute([...buf[0].pos, ...buf[1].pos], 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute([...buf[0].nor, ...buf[1].nor], 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute([...buf[0].uv, ...buf[1].uv], 2))
  g.addGroup(0, n0, 0); if (n1) g.addGroup(n0, n1, 1)
  // обход граней — наружу (проверка по нормали первого треугольника каждой тройки; при развёрнутом базисе — переворачиваем)
  const p3 = g.attributes.position.array, n3 = g.attributes.normal.array
  for (let k = 0; k < p3.length; k += 9) {
    const e1 = [p3[k + 3] - p3[k], p3[k + 4] - p3[k + 1], p3[k + 5] - p3[k + 2]], e2 = [p3[k + 6] - p3[k], p3[k + 7] - p3[k + 1], p3[k + 8] - p3[k + 2]]
    const cx = e1[1] * e2[2] - e1[2] * e2[1], cy = e1[2] * e2[0] - e1[0] * e2[2], cz = e1[0] * e2[1] - e1[1] * e2[0]
    const dn = cx * (n3[k] + n3[k + 3] + n3[k + 6]) + cy * (n3[k + 1] + n3[k + 4] + n3[k + 7]) + cz * (n3[k + 2] + n3[k + 5] + n3[k + 8])
    if (dn < 0) for (let c = 0; c < 3; c++) { const t = p3[k + 3 + c]; p3[k + 3 + c] = p3[k + 6 + c]; p3[k + 6 + c] = t; const tn = n3[k + 3 + c]; n3[k + 3 + c] = n3[k + 6 + c]; n3[k + 6 + c] = tn }
  }
  return g
}
/** радиусы скругления торцов детали в сцене: { '+x': r, … } — по кромке (толщина кромки ограничивает радиус) */
export function slabRadii(sp, R) {
  const out = {}
  if (!(R > 0) || !sp.place?.sideDir) return out
  let ed
  try { ed = partEdges(sp) } catch { return out }
  for (const [side, dir] of Object.entries(sp.place.sideDir)) {
    const v = ed?.[side]
    if (!v) continue
    const th = parseFloat(String(v).replace(',', '.'))
    out[dir] = Math.min(R, th > 0 ? th : R)
  }
  return out
}


/** толщина кромки по сторонам детали в сцене: { '+x': 0.4, … } (кромка без числа — 1 мм) */
export function slabBands(sp) {
  const out = {}
  if (!sp.place?.sideDir) return out
  let ed
  try { ed = partEdges(sp) } catch { return out }
  for (const [side, dir] of Object.entries(sp.place.sideDir)) {
    const v = ed?.[side]
    if (!v) continue
    const th = parseFloat(String(v).replace(',', '.'))
    out[dir] = th > 0 ? th : 1
  }
  return out
}
