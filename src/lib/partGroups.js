// Группы деталей с общей текстурой — общие помощники (см. components/PartGroups.jsx)
export const PART_GROUPS_SQL_HINT = 'Группы деталей ещё не сохраняются: выполните migration_part_groups.sql в Supabase (SQL Editor) — один раз.'
export const groupsOf = details => [...new Set(details.map(d => (d.part_group || '').trim()).filter(Boolean))]
export const groupDir = (details, g) => (details.find(d => (d.part_group || '').trim() === g)?.part_group_dir === 'x' ? 'x' : 'y')
export const GROUP_COLORS = ['#E65100', '#6A1B9A', '#00838F', '#2E7D32', '#AD1457', '#283593', '#827717', '#4E342E']
export const groupColor = (groups, g) => GROUP_COLORS[Math.max(0, groups.indexOf(g)) % GROUP_COLORS.length]

