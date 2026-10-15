-- Защита профилей: роль себе назначить нельзя, чужой профиль изменить или удалить нельзя.
-- Выполнить один раз в Supabase → SQL Editor (можно целиком, можно повторно).
--
-- Работает независимо от политик таблицы profiles (сейчас там «полный доступ»):
-- проверка стоит триггером на самой таблице.
--   • роль меняет только администратор (страница «Пользователи») или вы сами в SQL Editor;
--   • обычный пользователь правит только свой профиль (имя, телефон, WhatsApp), роль при этом не меняется;
--   • новый профиль всегда создаётся с ролью «клиент».
create or replace function public.is_admin() returns boolean
language sql security definer set search_path = public stable as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin')
$$;
grant execute on function public.is_admin() to authenticated, anon;

create or replace function public.protect_profiles() returns trigger
language plpgsql set search_path = public as $$
begin
  -- запросы не из приложения (SQL Editor, служебный ключ) и администратор — без ограничений
  if current_user not in ('anon', 'authenticated') or is_admin() then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op = 'INSERT' then
    if auth.uid() is not null and new.id <> auth.uid() then raise exception 'profile: not yours'; end if;
    new.role := 'client';
    return new;
  end if;
  if auth.uid() is null or old.id <> auth.uid() then raise exception 'profile: not yours'; end if;
  if tg_op = 'DELETE' then return old; end if;
  new.id := old.id;
  new.role := old.role;
  return new;
end $$;
drop trigger if exists protect_profiles on public.profiles;
create trigger protect_profiles before insert or update or delete on public.profiles
  for each row execute function public.protect_profiles();
