-- β Пильный центр: настройки производства (пропил, обрезка, уровни резов, повороты, захват, узкие детали, полосы, обрезки).
-- Выполнить один раз в Supabase -> SQL Editor (можно повторно). После migration_beta.sql.
alter table public.productions add column if not exists beam_saw_settings jsonb;
notify pgrst, 'reload schema';
