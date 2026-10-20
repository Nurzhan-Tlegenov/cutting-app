// Группы деталей с общей текстурой — общие помощники (см. components/PartGroups.jsx)
export const PART_GROUPS_SQL_HINT = 'Группы деталей ещё не сохраняются: выполните migration_part_groups.sql в Supabase (SQL Editor) — один раз.'
export const groupsOf = details => [...new Set(details.map(d => (d.part_group || '').trim()).filter(Boolean))]
export const groupDir = (details, g) => (details.find(d => (d.part_group || '').trim() === g)?.part_group_dir === 'x' ? 'x' : 'y')
export const GROUP_COLORS = ['#E65100', '#6A1B9A', '#00838F', '#2E7D32', '#AD1457', '#283593', '#827717', '#4E342E']
export const groupColor = (groups, g) => GROUP_COLORS[Math.max(0, groups.indexOf(g)) % GROUP_COLORS.length]


// ── Раскладка внутри группы ────────────────────────────────────────────────────────────────────────────────────────
// part_group_pos = «ряд.место» («1.1», «1.2», «2.1»): ряды — вдоль направления группы (↕ — ряды друг над другом,
// ряд 1 — верхний, как на фасаде шкафа; ↔ — ряды это колонки слева направо, место 1 — верхнее), в ряду детали рядом.
// Без позиции — деталь (каждый экземпляр) своим рядом после размеченных, в порядке списка. Экземпляры одной детали
// (qty > 1) идут подряд на её месте.
export const parsePos = s => { const m = /^\s*(\d+)(?:[.,:](\d+))?\s*$/.exec(String(s ?? '')); return m ? [+m[1], m[2] ? +m[2] : 1] : null }
/** Ряды группы для бланка: members [{ key, pos, ord }] -> [[member…]…] в порядке редактора (ряд 1 — первый) */
export function groupRows(members) {
  const list = members.map((m, k) => ({ ...m, lc: parsePos(m.pos), k }))
  const pos = list.filter(m => m.lc).sort((a, b) => a.lc[0] - b.lc[0] || a.lc[1] - b.lc[1] || a.ord - b.ord || a.k - b.k)
  const rows = []
  pos.forEach(m => { const last = rows[rows.length - 1]; if (last && last.line === m.lc[0]) last.items.push(m); else rows.push({ line: m.lc[0], items: [m] }) })
  list.filter(m => !m.lc).sort((a, b) => a.ord - b.ord || a.k - b.k).forEach(m => rows.push({ line: 0, items: [m] }))
  return rows.map(r => r.items)
}
/** Ряды в координатах листа (Y — вверх): вдоль Y порядок обратный ряду редактора (ряд 1 — выше всех) */
export function groupLinesOnSheet(members, stack) {
  const rows = groupRows(members)
  return stack === 'x' ? rows.map(r => r.slice().reverse()) : rows.slice().reverse()
}
