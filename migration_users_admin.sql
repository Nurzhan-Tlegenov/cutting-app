-- Страница «Пользователи» для администратора и регистрация по запросу.
-- Выполнить один раз в Supabase → SQL Editor (можно целиком, можно повторно).
--
-- app_config.signup_open — открыта ли свободная регистрация.
-- signup_requests — заявки на регистрацию (по номеру телефона). Когда регистрация закрыта,
--   зарегистрироваться может только тот, чья заявка одобрена. Проверяет это сама база
--   (триггер на auth.users), а не только экран входа — обойти через приложение нельзя.
-- Администратор — пользователь с profiles.role = 'admin'. Назначить себя (один раз, подставьте свой номер, только цифры):
--   update public.profiles set role = 'admin' where regexp_replace(phone, '\D', '', 'g') = '77000000000';

create table if not exists public.app_config (key text primary key, value jsonb not null);
insert into public.app_config (key, value) values ('signup_open', 'true'::jsonb) on conflict (key) do nothing;
alter table public.app_config enable row level security;

create table if not exists public.signup_requests (
  id uuid primary key default gen_random_uuid(),
  phone text not null,
  digits text not null unique,
  full_name text,
  comment text,
  status text not null default 'new' check (status in ('new', 'approved', 'rejected')),
  created_at timestamptz default now()
);
alter table public.signup_requests enable row level security;
-- политик нет: обе таблицы читаются и меняются только через функции ниже

-- номер -> только цифры; 8 701… и +7 701… — один и тот же номер
create or replace function public.norm_phone(p text) returns text
language sql immutable as $$
  select case when length(d) = 11 and left(d, 1) = '8' then '7' || substr(d, 2) else d end
  from (select regexp_replace(coalesce(p, ''), '\D', '', 'g') as d) t
$$;

create or replace function public.is_admin() returns boolean
language sql security definer set search_path = public stable as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin')
$$;

create or replace function public.signup_open() returns boolean
language sql security definer set search_path = public stable as $$
  select coalesce((select (value)::text = 'true' from app_config where key = 'signup_open'), true)
$$;

-- Заявка с экрана входа. -> 'open' (регистрация открыта) | 'new' | 'approved' | 'rejected'
create or replace function public.request_signup(p_name text, p_phone text, p_comment text default '')
returns text language plpgsql security definer set search_path = public as $$
declare d text := norm_phone(p_phone); st text;
begin
  if signup_open() then return 'open'; end if;
  if length(d) < 10 or length(d) > 15 then raise exception 'bad phone'; end if;
  select status into st from signup_requests where digits = d;
  if found then
    update signup_requests set full_name = coalesce(nullif(trim(p_name), ''), full_name), comment = coalesce(nullif(trim(p_comment), ''), comment) where digits = d and status = 'new';
    return st;
  end if;
  insert into signup_requests (phone, digits, full_name, comment) values (left(trim(p_phone), 40), d, left(trim(coalesce(p_name, '')), 120), left(trim(coalesce(p_comment, '')), 500));
  return 'new';
end $$;

-- Сама проверка: при закрытой регистрации новый пользователь создаётся только по одобренной заявке
create or replace function public.check_signup_allowed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if signup_open() then return new; end if;
  if exists (select 1 from signup_requests where status = 'approved' and digits = norm_phone(split_part(coalesce(new.email, ''), '@', 1))) then return new; end if;
  raise exception 'signup_closed';
end $$;
drop trigger if exists check_signup_allowed on auth.users;
create trigger check_signup_allowed before insert on auth.users for each row execute function public.check_signup_allowed();

-- ── только для администратора ──
create or replace function public.admin_users() returns json
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'not admin'; end if;
  return (select coalesce(json_agg(x order by x.created_at desc), '[]'::json) from (
    select u.id, u.email, u.created_at, u.last_sign_in_at, p.full_name, p.phone, p.whatsapp, coalesce(p.role, 'client') as role,
      (select count(*) from orders o where o.user_id = u.id) as orders,
      (select max(o.created_at) from orders o where o.user_id = u.id) as last_order_at
    from auth.users u left join profiles p on p.id = u.id) x);
end $$;

create or replace function public.admin_requests() returns json
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'not admin'; end if;
  return (select coalesce(json_agg(x order by x.created_at desc), '[]'::json) from (
    select r.*, exists (select 1 from auth.users u where norm_phone(split_part(u.email, '@', 1)) = r.digits) as registered from signup_requests r) x);
end $$;

create or replace function public.admin_set_signup(p_open boolean) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'not admin'; end if;
  insert into app_config (key, value) values ('signup_open', to_jsonb(p_open)) on conflict (key) do update set value = excluded.value;
  return p_open;
end $$;

-- p_status: 'approved' | 'rejected' | 'new' | 'delete'
create or replace function public.admin_set_request(p_id uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'not admin'; end if;
  if p_status = 'delete' then delete from signup_requests where id = p_id;
  else update signup_requests set status = p_status where id = p_id; end if;
end $$;

-- разрешить регистрацию номеру без заявки
create or replace function public.admin_allow_phone(p_phone text, p_name text default '') returns void
language plpgsql security definer set search_path = public as $$
declare d text := norm_phone(p_phone);
begin
  if not is_admin() then raise exception 'not admin'; end if;
  if length(d) < 10 then raise exception 'bad phone'; end if;
  insert into signup_requests (phone, digits, full_name, status) values (trim(p_phone), d, nullif(trim(p_name), ''), 'approved')
    on conflict (digits) do update set status = 'approved';
end $$;

create or replace function public.admin_set_role(p_user uuid, p_role text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'not admin'; end if;
  if p_role not in ('client', 'operator', 'admin') then raise exception 'bad role'; end if;
  if p_user = auth.uid() and p_role <> 'admin' then raise exception 'self'; end if;   -- нельзя снять администратора с самого себя
  update profiles set role = p_role where id = p_user;
end $$;

revoke all on function public.request_signup(text, text, text), public.signup_open(), public.is_admin(), public.admin_users(), public.admin_requests(), public.admin_set_signup(boolean), public.admin_set_request(uuid, text), public.admin_allow_phone(text, text), public.admin_set_role(uuid, text) from public;
grant execute on function public.signup_open(), public.request_signup(text, text, text) to anon, authenticated;
grant execute on function public.is_admin(), public.admin_users(), public.admin_requests(), public.admin_set_signup(boolean), public.admin_set_request(uuid, text), public.admin_allow_phone(text, text), public.admin_set_role(uuid, text) to authenticated;
