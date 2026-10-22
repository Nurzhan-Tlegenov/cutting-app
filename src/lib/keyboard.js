// Открыта ли экранная клавиатура.
// Раньше сравнивали visualViewport.height с window.innerHeight. На Android это работает (innerHeight не меняется),
// а на iPhone innerHeight сам уменьшается вместе с клавиатурой — отношение всегда ~1, и клавиатура «не видна»:
// не появлялась полоса «Далее →» и не пряталась нижняя навигация.
// Теперь сравниваем с полной высотой экрана: наибольшая из виденных высот (сбрасывается при повороте экрана)
// и высота документа (на iPhone она от клавиатуры не меняется).
let base = 0, baseW = 0

export function fullHeight() {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null
  if (!vv) return typeof window !== 'undefined' ? window.innerHeight : 0
  if (Math.abs(vv.width - baseW) > 1) { baseW = vv.width; base = 0 }          // поворот экрана — новая точка отсчёта
  base = Math.max(base, vv.height, window.innerHeight || 0, document.documentElement?.clientHeight || 0)
  return base
}

export function keyboardHeight() {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null
  if (!vv) return 0
  return Math.max(0, fullHeight() - vv.height)
}
