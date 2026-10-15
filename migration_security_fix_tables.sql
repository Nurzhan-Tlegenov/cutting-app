-- Аудит, исправление по проверке базы (check_security.sql). Выполнить один раз в Supabase → SQL Editor (можно повторно).
--
-- 1. Таблица public.users — приложение её не использует (её нет в коде и миграциях), а политика «Users can insert»
--    позволяла писать в неё любому с публичным ключом. Данные НЕ удаляются: таблица просто закрывается для всех,
--    кроме вас в SQL Editor.
-- 2. productions — вместо неизвестных политик pr_sel / pr_mod ставятся политики приложения:
--    читать — подтверждённые производства, своё и всё для администратора; менять — владелец своё
--    (статус подтверждения и владельца он поменять не может — это держит триггер protect_production); всё — администратор.

do $$
declare p record;
begin
  if to_regclass('public.users') is not null then
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'users' loop
      execute format('drop policy %I on public.users', p.policyname);
    end loop;
    alter table public.users enable row level security;
    revoke all on table public.users from anon, authenticated;
  end if;
end $$;

drop policy if exists pr_sel on public.productions;
drop policy if exists pr_mod on public.productions;
drop policy if exists "productions: читать" on public.productions;
drop policy if exists "productions: владелец правит" on public.productions;
drop policy if exists "productions: менять — админ" on public.productions;
alter table public.productions enable row level security;
create policy "productions: читать" on public.productions for select to authenticated
  using (status = 'approved' or owner_id = auth.uid() or public.is_admin());
create policy "productions: владелец правит" on public.productions for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "productions: менять — админ" on public.productions for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- триггер, не дающий владельцу подтвердить своё производство самому (если его ещё нет)
create or replace function public.protect_production() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user in ('anon', 'authenticated') and not is_admin() then
    new.status := old.status; new.owner_id := old.owner_id; new.id := old.id;
  end if;
  return new;
end $$;
drop trigger if exists protect_production on public.productions;
create trigger protect_production before update on public.productions for each row execute function public.protect_production();

notify pgrst, 'reload schema';
