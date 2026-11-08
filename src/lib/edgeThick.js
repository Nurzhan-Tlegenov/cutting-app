const num = v => Number(v) || 0

// ─── Толщина кромки из названия: в «Видах кромки» не задана (обычно импорт из Excel) — берём из названия кромки.
// 0,4 / 0.4 / 04 → 0,5 мм; 0,8 / 0.8 / 1 → 1 мм; 2 → 2 мм. Сначала дробное число (≤ 3), потом «04» / «08», потом целое 1–3.
export function thickFromName(name) {
  const s = String(name || '')
  if (!s) return 0
  const toks = [...s.matchAll(/(?<![\d.,])(\d+(?:[.,]\d+)?)(?![\d])/g)].map(m => m[1])
  const map = v => (v <= 0 ? 0 : v <= 0.6 ? 0.5 : v <= 1.5 ? 1 : Math.round(v))
  const dec = toks.find(t => /[.,]/.test(t) && num(t.replace(',', '.')) > 0 && num(t.replace(',', '.')) <= 3)
  if (dec) return map(num(dec.replace(',', '.')))
  const lead0 = toks.find(t => /^0\d$/.test(t))
  if (lead0) return map(num(lead0) / 10)
  const int = toks.find(t => /^[123]$/.test(t))
  return int ? map(num(int)) : 0
}
