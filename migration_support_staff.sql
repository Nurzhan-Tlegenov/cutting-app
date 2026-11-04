-- Роль «Поддержка» (этап 2 техподдержки, claude/support-spec.md).
-- Мастер-аккаунт выдаёт её любому зарегистрированному пользователю. Хранится ОТДЕЛЬНО (support_staff), а не в profiles.role:
-- роль пользователя остаётся client / operator, свои заказы он видит как обычно.
-- Безопасность: к таблице — только через функции ниже (security definer + проверка is_admin() / is_support());
-- никаких новых правил на orders, order_details, profiles, app_messages.
-- Выполнить в Supabase → SQL Editor целиком (можно повторно).

create table if not exists public.support_staff (
  user_id uuid primary key references auth.users(id) on delete cascade,
  added_by uuid references auth.users(id) on delete set null,
  added_at timestamptz not null default now(),
  active boolean not null default true
);
alter table public.support_staff enable row level security;   -- правил нет: читать и менять — только функциями
revoke all on public.support_staff from anon, authenticated;

-- сотрудник поддержки (действующий) или мастер-аккаунт
create or replace function public.is_support() returns boolean
language sql security definer set search_path = public stable as $$
  select auth.uid() is not null and (
    exists (select 1 from profiles where id = auth.uid() and role = 'admin')
    or exists (select 1 from support_staff where user_id = auth.uid() and active))
$$;

-- мастер: список сотрудников поддержки. -> [{ user_id, full_name, phone, country, city, active, added_at }]
create or replace function public.admin_support_staff() returns json
language plpgsql security definer set search_path = public stable as $$
begin
  if not is_admin() then raise exception 'not admin'; end if;
  return (select coalesce(json_agg(x order by x.active desc, x.added_at), '[]'::json) from (
    select s.user_id, p.full_name, p.phone, p.country, p.city, s.active, s.added_at
    from support_staff s left join profiles p on p.id = s.user_id) x);
end $$;

-- мастер: выдать / снять роль. Снятие не удаляет строку — остаётся история (кто был в поддержке)
create or replace function public.admin_set_support(p_user uuid, p_on boolean) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'not admin'; end if;
  if not exists (select 1 from auth.users where id = p_user) then raise exception 'no user'; end if;
  insert into support_staff (user_id, added_by, active) values (p_user, auth.uid(), coalesce(p_on, false))
    on conflict (user_id) do update set active = coalesce(p_on, false),
      added_by = case when p_on and not support_staff.active then auth.uid() else support_staff.added_by end,
      added_at = case when p_on and not support_staff.active then now() else support_staff.added_at end;
  return coalesce(p_on, false);
end $$;

-- команда поддержки (для сотрудников и мастера): только имена — кому передать карточку, кто в общем чате
-- -> [{ user_id, full_name, master }]
create or replace function public.support_team() returns json
language plpgsql security definer set search_path = public stable as $$
begin
  if not is_support() then raise exception 'not support'; end if;
  return (select coalesce(json_agg(x order by x.master desc, x.full_name), '[]'::json) from (
    select p.id as user_id, coalesce(nullif(trim(p.full_name), ''), 'Мастер-аккаунт') as full_name, true as master
      from profiles p where p.role = 'admin'
    union all
    select s.user_id, coalesce(nullif(trim(p.full_name), ''), 'Сотрудник'), false
      from support_staff s left join profiles p on p.id = s.user_id
      where s.active and coalesce(p.role, '') <> 'admin') x);
end $$;

revoke all on function public.is_support(), public.admin_support_staff(), public.admin_set_support(uuid, boolean),
  public.support_team() from public, anon, authenticated;
grant execute on function public.is_support(), public.admin_support_staff(), public.admin_set_support(uuid, boolean),
  public.support_team() to authenticated;

notify pgrst, 'reload schema';

-- Проверка (выполнить отдельно): у support_staff не должно быть ни одного правила, у orders / order_details / profiles /
-- app_messages — те же, что были до этой миграции (эта миграция их не трогает).
-- select tablename, policyname, cmd, roles, qual from pg_policies
--   where tablename in ('support_staff', 'orders', 'order_details', 'profiles', 'app_messages') order by 1, 2;
