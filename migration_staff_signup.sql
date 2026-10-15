-- Регистрация сотрудника по ссылке-приглашению производства — без одобрения мастер-аккаунта.
-- Выполнить один раз в Supabase → SQL Editor (можно повторно). После migration_workplaces.sql.
--
-- Как работает:
--   • сотрудник открывает ссылку /join/<код> и регистрируется прямо там; код приглашения уходит в данные аккаунта (invite);
--   • база пропускает такую регистрацию даже при закрытой регистрации (код действующий, не использован, не истёк);
--   • сразу после создания аккаунта он становится сотрудником производства (приглашение принято само);
--   • такой аккаунт — только сотрудник (staff_signups). Кабинет клиента у него открывается после одобрения мастера:
--     сотрудник жмёт «Стать клиентом» — у мастера появляется обычная заявка на регистрацию. Своё производство — как у всех,
--     через заявку производства и подтверждение мастера.

create table if not exists public.staff_signups (
  user_id uuid primary key references auth.users(id) on delete cascade,
  production_id uuid references public.productions(id) on delete set null,
  created_at timestamptz default now()
);
alter table public.staff_signups enable row level security;   -- только через функции ниже

-- действующее приглашение по коду
create or replace function public.invite_valid(p_code text) returns boolean
language sql security definer set search_path = public stable as $$
  select exists (select 1 from production_invites i join productions p on p.id = i.production_id
                 where i.code = lower(trim(coalesce(p_code, ''))) and i.used_by is null and i.expires_at > now() and p.status = 'approved')
$$;

-- проверка перед созданием аккаунта: открытая регистрация, одобренная заявка — или действующее приглашение производства
create or replace function public.check_signup_allowed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if signup_open() then return new; end if;
  if invite_valid(new.raw_user_meta_data ->> 'invite') then return new; end if;
  if exists (select 1 from signup_requests where status = 'approved' and digits = norm_phone(split_part(coalesce(new.email, ''), '@', 1))) then return new; end if;
  raise exception 'signup_closed';
end $$;
drop trigger if exists check_signup_allowed on auth.users;
create trigger check_signup_allowed before insert on auth.users for each row execute function public.check_signup_allowed();

-- после создания аккаунта по приглашению: сотрудник производства, приглашение принято
create or replace function public.handle_staff_signup() returns trigger
language plpgsql security definer set search_path = public as $$
declare i record; nm text;
begin
  if coalesce(new.raw_user_meta_data ->> 'invite', '') = '' then return new; end if;
  select * into i from production_invites where code = lower(trim(new.raw_user_meta_data ->> 'invite')) and used_by is null and expires_at > now();
  if not found then return new; end if;
  nm := coalesce(i.name, nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''));
  insert into production_members (production_id, user_id, name, perms, active) values (i.production_id, new.id, nm, i.perms, true)
    on conflict (production_id, user_id) do update set perms = excluded.perms, active = true;
  update production_invites set used_by = new.id, used_at = now() where code = i.code;
  insert into staff_signups (user_id, production_id) values (new.id, i.production_id) on conflict (user_id) do nothing;
  -- старые приглашения сами одобряли номер как заявку на регистрацию — сотруднику это больше не нужно
  delete from signup_requests where digits = norm_phone(split_part(coalesce(new.email, ''), '@', 1)) and comment = 'сотрудник производства';
  return new;
end $$;
drop trigger if exists handle_staff_signup on auth.users;
create trigger handle_staff_signup after insert on auth.users for each row execute function public.handle_staff_signup();

-- приглашение больше не одобряет номер как заявку клиента: регистрация идёт по самой ссылке
create or replace function public.create_invite(p_name text, p_phone text, p_perms jsonb) returns text
language plpgsql security definer set search_path = public as $$
declare pr uuid; c text;
begin
  select id into pr from productions where owner_id = auth.uid() and status = 'approved';
  if pr is null then raise exception 'no production'; end if;
  c := lower(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
  insert into production_invites (code, production_id, name, phone, perms) values (c, pr, nullif(trim(p_name), ''), nullif(trim(p_phone), ''), coalesce(p_perms, '{}'::jsonb));
  return c;
end $$;

-- страница приглашения: + production_id (открыть именно это производство после регистрации)
create or replace function public.invite_info(p_code text) returns json
language sql security definer set search_path = public stable as $$
  select json_build_object('production_id', p.id, 'production_name', p.name, 'city', p.city, 'name', i.name, 'perms', i.perms,
    'valid', i.used_by is null and i.expires_at > now() and p.status = 'approved',
    'used', i.used_by is not null, 'mine', i.used_by = auth.uid(), 'owner', p.owner_id = auth.uid())
  from production_invites i join productions p on p.id = i.production_id where i.code = lower(trim(p_code))
$$;

-- доступ к кабинету клиента: обычный аккаунт — да; сотрудник по приглашению — после одобрения мастера (или пока регистрация открыта)
create or replace function public.client_access_ok() returns boolean
language sql security definer set search_path = public stable as $$
  select auth.uid() is null
    or not exists (select 1 from staff_signups where user_id = auth.uid())
    or is_admin() or signup_open()
    or exists (select 1 from signup_requests r join auth.users u on norm_phone(split_part(u.email, '@', 1)) = r.digits
               where u.id = auth.uid() and r.status = 'approved')
$$;

-- состояние для приложения: { staff, ok, request: null | new | approved | rejected }
create or replace function public.client_access() returns json
language sql security definer set search_path = public stable as $$
  select json_build_object(
    'staff', exists (select 1 from staff_signups where user_id = auth.uid()),
    'ok', client_access_ok(),
    'request', (select r.status from signup_requests r join auth.users u on norm_phone(split_part(u.email, '@', 1)) = r.digits where u.id = auth.uid()))
$$;

-- сотрудник просит открыть ему кабинет клиента -> заявка у мастера (как заявка на регистрацию)
create or replace function public.request_client_access(p_comment text default '') returns text
language plpgsql security definer set search_path = public as $$
declare u record; d text; st text; nm text; prod text;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if client_access_ok() then return 'approved'; end if;
  select * into u from auth.users where id = auth.uid();
  d := norm_phone(split_part(u.email, '@', 1));
  nm := coalesce((select full_name from profiles where id = auth.uid()), u.raw_user_meta_data ->> 'full_name', '');
  select p.name into prod from staff_signups s join productions p on p.id = s.production_id where s.user_id = auth.uid();
  select status into st from signup_requests where digits = d;
  if st = 'rejected' then return 'rejected'; end if;
  insert into signup_requests (phone, digits, full_name, country, city, comment, status)
    values (coalesce((select phone from profiles where id = auth.uid()), d), d, left(nm, 120),
            (select country from profiles where id = auth.uid()), (select city from profiles where id = auth.uid()),
            left('Сотрудник производства' || coalesce(' «' || prod || '»', '') || ' просит кабинет клиента' || coalesce(nullif(' — ' || trim(p_comment), ' — '), ''), 500), 'new')
    on conflict (digits) do update set status = case when signup_requests.status = 'approved' then 'approved' else 'new' end, comment = excluded.comment;
  return 'new';
end $$;

-- новый заказ клиента — только при доступе к кабинету клиента (защита на стороне базы)
drop policy if exists "orders: создавать — с доступом клиента" on public.orders;
create policy "orders: создавать — с доступом клиента" on public.orders as restrictive for insert to authenticated with check (public.client_access_ok());

revoke all on function public.invite_valid(text), public.client_access_ok(), public.client_access(), public.request_client_access(text) from public, anon;
grant execute on function public.client_access_ok(), public.client_access(), public.request_client_access(text) to authenticated;
-- проверка кода и название производства нужны до входа (страница приглашения с регистрацией)
grant execute on function public.invite_valid(text) to anon, authenticated;
grant execute on function public.invite_info(text) to anon;
notify pgrst, 'reload schema';
