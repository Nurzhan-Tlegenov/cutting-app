-- Угол укладки форматно-раскроечного станка (Производство → Настройки → Параметры станка).
-- Выполнить один раз в Supabase → SQL Editor. Можно повторно.
alter table public.productions add column if not exists saw_corner text;
notify pgrst, 'reload schema';
