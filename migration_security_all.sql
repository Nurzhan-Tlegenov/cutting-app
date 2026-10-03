-- ВСЁ СРАЗУ: ссылки на 3D, страница «Пользователи» и регистрация по запросу, защита профилей, доступ только к своим данным.
-- Выполнить в Supabase → SQL Editor целиком, один раз (можно повторно). Собрано из четырёх файлов migration_*.sql ниже по порядку.

-- ═══════════ migration_model_shares.sql ═══════════
-- Ссылка на 3D-модель заказа для клиента (просмотр без входа в приложение).
-- Выполнить один раз в Supabase → SQL Editor (можно целиком).
--
-- model_shares: одна строка = одна открытая ссылка на заказ. Удалили строку — доступ закрыт.
-- shared_model(token): отдаёт по токену детали заказа и его 3D-модель; больше ничего
-- посторонний человек получить не может.
create table if not exists public.model_shares (
  token uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.orders(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz default now()
);
alter table public.model_shares enable row level security;
drop policy if exists "own shares" on public.model_shares;
create policy "own shares" on public.model_shares for all
  using (auth.uid() = user_id or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('operator', 'admin')))
  with check (auth.uid() = user_id);

create or replace function public.shared_model(p_token uuid)
returns json language plpgsql security definer set search_path = public as $$
declare
  s record;
  o record;
  res json;
  mdl text;
  tex json;
begin
  select * into s from model_shares where token = p_token;
  if not found then return null; end if;
  select * into o from orders where id = s.order_id;
  if not found then return null; end if;
  begin
    select m.data into mdl from order_models m where m.order_id = s.order_id;
  exception when undefined_table then mdl := null;
  end;
  begin
    select coalesce(json_agg(json_build_object('name', t.name, 'data', t.data, 'size_mm', t.size_mm, 'rot', t.rot)), '[]'::json)
      into tex from material_textures t where t.user_id = o.user_id;
  exception when undefined_table then tex := '[]'::json;
  end;
  select json_build_object(
    'title', coalesce(nullif(o.order_name, ''), o.order_number),
    'material_name', o.material_name,
    'material_thickness', o.material_thickness,
    'details', (select coalesce(json_agg(json_build_object(
        'name', d.name, 'length', d.length, 'width', d.width, 'qty', d.qty,
        'edge_top', d.edge_top, 'edge_right', d.edge_right, 'edge_bottom', d.edge_bottom, 'edge_left', d.edge_left,
        'contour', d.contour) order by d.sort_order), '[]'::json)
      from order_details d where d.order_id = s.order_id),
    'model', mdl,
    'textures', coalesce(tex, '[]'::json)
  ) into res;
  return res;
end $$;
revoke all on function public.shared_model(uuid) from public;
grant execute on function public.shared_model(uuid) to anon, authenticated;

-- ═══════════ migration_users_admin.sql ═══════════
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

-- ═══════════ migration_profiles_protect.sql ═══════════
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

-- ═══════════ migration_access_lockdown.sql ═══════════
-- Доступ к данным: каждый видит и меняет только своё, всё чужое — только администратор.
-- Выполнить один раз в Supabase → SQL Editor (целиком; можно повторно).
-- ПЕРЕД этим назначьте себя администратором (profiles.role = 'admin'), иначе чужие заказы
-- не увидит никто (в том числе вы) — до тех пор, пока администратор не будет назначен.
--
-- Что делает:
--   • включает защиту строк (RLS) на profiles, orders, order_details, order_models, model_shares, productions;
--   • убирает с них ВСЕ прежние политики (в том числе «полный доступ») и ставит новые;
--   • номер нового заказа выдаёт функция next_order_number — она видит номера всех пользователей,
--     поэтому номера не повторяются, хотя чужие заказы пользователю больше не видны.
-- Просмотр 3D по ссылке (shared_model) и страница «Пользователи» работают как раньше — через свои функции.

create or replace function public.is_admin() returns boolean
language sql security definer set search_path = public stable as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin')
$$;
grant execute on function public.is_admin() to authenticated, anon;

-- следующий номер заказа за день: p_prefix вида '261003_'
create or replace function public.next_order_number(p_prefix text) returns text
language plpgsql security definer set search_path = public as $$
declare last_no text; seq int;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if p_prefix !~ '^[0-9]{6}_$' then raise exception 'bad prefix'; end if;
  select order_number into last_no from orders where order_number like p_prefix || '%' order by order_number desc limit 1;
  seq := coalesce(nullif(regexp_replace(split_part(coalesce(last_no, ''), '_', 2), '\D', '', 'g'), '')::int, 0) + 1;
  return p_prefix || lpad(seq::text, 3, '0');
end $$;
revoke all on function public.next_order_number(text) from public;
grant execute on function public.next_order_number(text) to authenticated;

-- убрать все прежние политики с этих таблиц и включить защиту строк
do $$
declare t text; p record;
begin
  foreach t in array array['profiles', 'orders', 'order_details', 'order_models', 'model_shares', 'productions'] loop
    if to_regclass('public.' || t) is null then continue; end if;
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- профили: свой — видеть и править; все — только администратор
create policy "profiles: свой или админ — читать" on public.profiles for select using (id = auth.uid() or public.is_admin());
create policy "profiles: создать свой" on public.profiles for insert with check (id = auth.uid() or public.is_admin());
create policy "profiles: править свой или админ" on public.profiles for update using (id = auth.uid() or public.is_admin()) with check (id = auth.uid() or public.is_admin());
create policy "profiles: удалять — админ" on public.profiles for delete using (public.is_admin());

-- заказы: свои; все — администратор
create policy "orders: свои или админ" on public.orders for all
  using (user_id = auth.uid() or public.is_admin()) with check (user_id = auth.uid() or public.is_admin());

-- детали и 3D-модель — доступны тому, кому доступен сам заказ
create policy "order_details: по заказу" on public.order_details for all
  using (order_id in (select id from public.orders)) with check (order_id in (select id from public.orders));

do $$
begin
  if to_regclass('public.order_models') is not null then
    execute 'create policy "order_models: по заказу" on public.order_models for all using (order_id in (select id from public.orders)) with check (order_id in (select id from public.orders))';
  end if;
  if to_regclass('public.model_shares') is not null then
    execute 'create policy "model_shares: свои или админ" on public.model_shares for all using (user_id = auth.uid() or public.is_admin()) with check (user_id = auth.uid() and order_id in (select id from public.orders))';
  end if;
  -- производства: список читают все вошедшие (он нужен в раскрое), меняет администратор
  if to_regclass('public.productions') is not null then
    execute 'create policy "productions: читать" on public.productions for select to authenticated using (true)';
    execute 'create policy "productions: менять — админ" on public.productions for all using (public.is_admin()) with check (public.is_admin())';
  end if;
end $$;
