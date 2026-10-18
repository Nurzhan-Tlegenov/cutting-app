// Полоса вдоль незамкнутой траектории (паз по траектории из Базиса и т. п.).
// path — ломаная [[x, y], …]; lo / hi — смещения краёв полосы от траектории по левой нормали
// (как профиль фрезы в Базисе: u < 0 — справа от хода, u > 0 — слева). Углы — со срезом (митра, не длиннее 4×).

const unit = (dx, dy) => { const l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l] }

/** Убрать совпадающие подряд точки */
export function cleanPath(path, eps = 0.01) {
  const out = []
  for (const p of path || []) if (!out.length || Math.hypot(p[0] - out[out.length - 1][0], p[1] - out[out.length - 1][1]) > eps) out.push([p[0], p[1]])
  return out
}

/** Полоса lo…hi вдоль ломаной -> многоугольник (левый край по ходу, правый — обратно) */
export function bandPolygon(path, lo, hi) {
  const P = cleanPath(path)
  if (P.length < 2) return null
  const n = P.length
  const nrm = i => { const t = unit(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]); return [-t[1], t[0]] }
  const miter = i => {
    if (i === 0) return nrm(0)
    if (i === n - 1) return nrm(n - 2)
    const a = nrm(i - 1), b = nrm(i)
    const m = unit(a[0] + b[0], a[1] + b[1]), c = m[0] * a[0] + m[1] * a[1]
    const k = 1 / Math.max(0.25, c)
    return [m[0] * k, m[1] * k]
  }
  const left = [], right = []
  for (let i = 0; i < n; i++) {
    const m = miter(i)
    left.push([P[i][0] + m[0] * hi, P[i][1] + m[1] * hi])
    right.push([P[i][0] + m[0] * lo, P[i][1] + m[1] * lo])
  }
  return [...left, ...right.reverse()]
}

/** Продлить конец траектории (end: 0 — начало, 1 — конец) по касательной на d мм */
export function extendEnd(path, end, d) {
  const P = cleanPath(path)
  if (P.length < 2 || !(d > 0)) return P
  if (end === 0) { const t = unit(P[0][0] - P[1][0], P[0][1] - P[1][1]); P[0] = [P[0][0] + t[0] * d, P[0][1] + t[1] * d] }
  else { const k = P.length - 1, t = unit(P[k][0] - P[k - 1][0], P[k][1] - P[k - 1][1]); P[k] = [P[k][0] + t[0] * d, P[k][1] + t[1] * d] }
  return P
}
