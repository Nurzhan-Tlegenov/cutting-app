-- Группы деталей с общей текстурой (фасады одного шкафа): детали группы режутся из одной полосы подряд, без поворота.
-- part_group — имя группы («Ф1»), part_group_dir — как детали идут друг за другом: 'y' — друг над другом (вдоль длины,
-- по умолчанию), 'x' — рядом (вдоль ширины). Выполнить один раз в Supabase -> SQL Editor (можно повторно).
alter table public.order_details add column if not exists part_group text;
alter table public.order_details add column if not exists part_group_dir text;
alter table public.order_details add column if not exists part_group_pos text;
notify pgrst, 'reload schema';
