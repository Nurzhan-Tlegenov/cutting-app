-- Раскладка внутри группы деталей с общей текстурой: part_group_pos = «ряд.место» («1.1», «1.2», «2.1»).
-- Выполнить один раз в Supabase -> SQL Editor (можно повторно). После migration_part_groups.sql.
alter table public.order_details add column if not exists part_group_pos text;
notify pgrst, 'reload schema';
