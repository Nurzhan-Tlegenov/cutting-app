-- Исправление: «permission denied for table profiles» при сохранении страны/города в профиле.
-- У вошедших пользователей (роль authenticated) пропало право на таблицу profiles.
-- Возвращаем его. Защита остаётся: политики RLS пускают только к своему профилю (админ — ко всем),
-- триггер protect_profiles не даёт сменить себе роль, удалять профили может только администратор.
-- Выполнить один раз в Supabase → SQL Editor (можно повторно).

grant select, insert, update, delete on table public.profiles to authenticated;
alter table public.profiles enable row level security;

notify pgrst, 'reload schema';

-- Проверка: должно показать SELECT, INSERT, UPDATE, DELETE у authenticated
select grantee, string_agg(privilege_type, ', ' order by privilege_type) as rights
from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'profiles' and grantee in ('anon', 'authenticated')
group by grantee;
