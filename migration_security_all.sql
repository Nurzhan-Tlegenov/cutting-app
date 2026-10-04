-- ВСЁ СРАЗУ: ссылки на 3D, страница «Пользователи» и регистрация по запросу, защита профилей, доступ только к своим данным, кабинет производства.
-- Выполнить в Supabase → SQL Editor целиком, один раз (можно повторно). Собрано из файлов migration_*.sql ниже по порядку.

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

-- ═══════════ migration_production_cabinet.sql ═══════════
-- Кабинет производства: пользователь регистрирует своё производство, оформленные на него заказы
-- приходят заявками, производство их принимает. Администратор видит статистику.
-- Выполнять ПОСЛЕ migration_access_lockdown.sql (в migration_security_all.sql всё уже по порядку). Можно повторно.

create table if not exists public.productions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kerf_width numeric, margin_left numeric, margin_right numeric, margin_top numeric, margin_bottom numeric
);
alter table public.productions add column if not exists owner_id uuid references auth.users(id) on delete set null;
alter table public.productions add column if not exists phone text;
alter table public.productions add column if not exists city text;
alter table public.productions add column if not exists country text;
alter table public.productions add column if not exists created_at timestamptz default now();
-- Статус производства: 'pending' (ждёт подтверждения администратора) → 'approved' | 'rejected'.
-- Пока регистрация закрыта («только по запросу»), новое производство регистрируется как 'pending':
-- его видит только владелец и администратор, в списке у заказчиков его нет, заявки на него не идут.
-- Когда регистрация открыта для всех — производство подтверждается сразу.
-- Производства, которые уже есть в базе на момент первого запуска, считаются подтверждёнными.
do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'productions' and column_name = 'status') then
    alter table public.productions add column status text not null default 'approved';
    alter table public.productions alter column status set default 'pending';
  end if;
end $$;
-- В старой таблице productions рез и отступы могли быть обязательными (NOT NULL): при регистрации производства
-- их ещё нет, поэтому обязательность снимаем со всех колонок, кроме id и названия.
do $$
declare c record;
begin
  for c in select column_name from information_schema.columns
           where table_schema = 'public' and table_name = 'productions' and is_nullable = 'NO' and column_default is null
             and column_name not in ('id', 'name', 'status') loop
    execute format('alter table public.productions alter column %I drop not null', c.column_name);
  end loop;
end $$;
create unique index if not exists productions_owner_uq on public.productions (owner_id) where owner_id is not null;
alter table public.orders add column if not exists production_id uuid;
alter table public.orders add column if not exists submitted_at timestamptz;
alter table public.orders add column if not exists accepted_at timestamptz;
alter table public.productions enable row level security;

create or replace function public.is_admin() returns boolean
language sql security definer set search_path = public stable as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin')
$$;
create or replace function public.is_my_production(p_id uuid) returns boolean
language sql security definer set search_path = public stable as $$
  select p_id is not null and exists (select 1 from productions where id = p_id and owner_id = auth.uid() and status = 'approved')
$$;
grant execute on function public.is_admin(), public.is_my_production(uuid) to authenticated, anon;

-- Зарегистрировать (или обновить) своё производство. Рез и отступы — параметры станка (можно не указывать).
drop function if exists public.register_production(text, text, text, numeric, numeric, numeric, numeric, numeric);
create or replace function public.register_production(p_name text, p_phone text default '', p_city text default '',
  p_kerf numeric default null, p_ml numeric default null, p_mr numeric default null, p_mt numeric default null, p_mb numeric default null,
  p_country text default '')
returns uuid language plpgsql security definer set search_path = public as $$
declare pid uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if length(trim(coalesce(p_name, ''))) < 2 then raise exception 'bad name'; end if;
  if length(trim(coalesce(p_country, ''))) < 2 then raise exception 'bad country'; end if;       -- страна обязательна
  select id into pid from productions where owner_id = auth.uid();
  if pid is null then
    insert into productions (name, owner_id, country, phone, city, kerf_width, margin_left, margin_right, margin_top, margin_bottom, status)
      values (left(trim(p_name), 80), auth.uid(), left(trim(p_country), 60), left(trim(coalesce(p_phone, '')), 40), left(trim(coalesce(p_city, '')), 80), coalesce(p_kerf, 4), coalesce(p_ml, 10), coalesce(p_mr, 10), coalesce(p_mt, 10), coalesce(p_mb, 10),    -- станок не указан — обычные значения, их можно поменять в кабинете
        case when is_admin() or signup_open() then 'approved' else 'pending' end)
      returning id into pid;
  else
    update productions set name = left(trim(p_name), 80), country = left(trim(p_country), 60), phone = left(trim(coalesce(p_phone, '')), 40), city = left(trim(coalesce(p_city, '')), 80),
      kerf_width = coalesce(p_kerf, kerf_width), margin_left = coalesce(p_ml, margin_left), margin_right = coalesce(p_mr, margin_right),
      margin_top = coalesce(p_mt, margin_top), margin_bottom = coalesce(p_mb, margin_bottom),
      status = case when status = 'rejected' then (case when is_admin() or signup_open() then 'approved' else 'pending' end) else status end   -- отклонённую заявку можно подать заново
      where id = pid;
  end if;
  -- статус «Производство» в профиле — только у подтверждённого (администратор остаётся администратором)
  if exists (select 1 from productions where id = pid and status = 'approved') then
    update profiles set role = 'operator' where id = auth.uid() and role = 'client';
  end if;
  return pid;
end $$;

-- Заявки моего производства (оформленные на него заказы) + кто заказчик
create or replace function public.production_orders() returns json
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  return (select coalesce(json_agg(x order by x.submitted_at desc nulls last), '[]'::json) from (
    select o.id, o.order_number, o.order_name, o.material_name, o.status, o.submitted_at, o.accepted_at, o.created_at,
      o.user_id = auth.uid() as own,
      c.full_name as client_name, c.phone as client_phone, c.whatsapp as client_whatsapp,
      (select coalesce(sum(d.qty), 0) from order_details d where d.order_id = o.id) as parts
    from orders o join productions p on p.id = o.production_id left join profiles c on c.id = o.user_id
    where p.owner_id = auth.uid() and p.status = 'approved' and o.status <> 'draft') x);
end $$;

-- Заказчик одного заказа — для производства, которому заказ оформлен, и для администратора
create or replace function public.order_client(p_order uuid) returns json
language sql security definer set search_path = public stable as $$
  select json_build_object('full_name', c.full_name, 'phone', c.phone, 'whatsapp', c.whatsapp, 'production', (select name from productions where id = o.production_id))
  from orders o left join profiles c on c.id = o.user_id
  where o.id = p_order and (is_admin() or (o.status <> 'draft' and is_my_production(o.production_id)) or o.user_id = auth.uid())
$$;

-- Статус заявки меняет производство (или администратор): принять в работу, обсудить, исполнен
create or replace function public.production_set_status(p_order uuid, p_status text) returns text
language plpgsql security definer set search_path = public as $$
declare o record;
begin
  if p_status not in ('new', 'discussion', 'inwork', 'done') then raise exception 'bad status'; end if;
  select * into o from orders where id = p_order;
  if not found or o.status = 'draft' or not (is_admin() or is_my_production(o.production_id)) then raise exception 'not allowed'; end if;
  update orders set status = p_status, accepted_at = case when p_status in ('inwork', 'done') then coalesce(accepted_at, now()) else accepted_at end where id = p_order;
  return p_status;
end $$;

-- ── права ──
-- производства: список видят все вошедшие (выбор в раскрое); свою запись правит владелец; всё — администратор
drop policy if exists "productions: читать" on public.productions;
drop policy if exists "productions: менять — админ" on public.productions;
drop policy if exists "productions: владелец правит" on public.productions;
create policy "productions: читать" on public.productions for select to authenticated using (status = 'approved' or owner_id = auth.uid() or public.is_admin());
create policy "productions: менять — админ" on public.productions for all using (public.is_admin()) with check (public.is_admin());
create policy "productions: владелец правит" on public.productions for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- заказы: производство ВИДИТ оформленные на него заказы (менять может только статус — через функцию выше)
drop policy if exists "orders: производство читает оформленные" on public.orders;
create policy "orders: производство читает оформленные" on public.orders for select
  using (status <> 'draft' and public.is_my_production(production_id));

-- детали и 3D-модель: читать — у кого виден заказ; менять — только хозяин заказа и администратор
drop policy if exists "order_details: по заказу" on public.order_details;
drop policy if exists "order_details: читать по заказу" on public.order_details;
drop policy if exists "order_details: менять свои" on public.order_details;
create policy "order_details: читать по заказу" on public.order_details for select using (order_id in (select id from public.orders));
create policy "order_details: менять свои" on public.order_details for all
  using (order_id in (select id from public.orders where user_id = auth.uid() or public.is_admin()))
  with check (order_id in (select id from public.orders where user_id = auth.uid() or public.is_admin()));
do $$
begin
  if to_regclass('public.order_models') is not null then
    execute 'drop policy if exists "order_models: по заказу" on public.order_models';
    execute 'drop policy if exists "order_models: читать по заказу" on public.order_models';
    execute 'drop policy if exists "order_models: менять свои" on public.order_models';
    execute 'create policy "order_models: читать по заказу" on public.order_models for select using (order_id in (select id from public.orders))';
    execute 'create policy "order_models: менять свои" on public.order_models for all using (order_id in (select id from public.orders where user_id = auth.uid() or public.is_admin())) with check (order_id in (select id from public.orders where user_id = auth.uid() or public.is_admin()))';
  end if;
end $$;

-- ── администратор: пользователи со статистикой (заменяет прежнюю admin_users) ──
create or replace function public.admin_users() returns json
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'not admin'; end if;
  return (select coalesce(json_agg(x order by x.created_at desc), '[]'::json) from (
    select u.id, u.email, u.created_at, u.last_sign_in_at, p.full_name, p.phone, p.whatsapp, coalesce(p.role, 'client') as role,
      (select count(*) from orders o where o.user_id = u.id) as orders,
      (select count(*) from orders o where o.user_id = u.id and o.status <> 'draft') as submitted,
      (select max(o.created_at) from orders o where o.user_id = u.id) as last_order_at,
      pr.id as production_id, pr.name as production_name, pr.city as production_city, pr.country as production_country, pr.created_at as production_created_at, pr.phone as production_phone, pr.status as production_status,
      (select count(*) from orders o where o.production_id = pr.id and o.status <> 'draft') as received,
      (select count(*) from orders o where o.production_id = pr.id and o.status in ('inwork', 'done')) as accepted,
      (select count(*) from orders o where o.production_id = pr.id and o.status = 'done') as done
    from auth.users u left join profiles p on p.id = u.id left join productions pr on pr.owner_id = u.id) x);
end $$;

-- Подтвердить или отклонить производство — только администратор. p_status: 'approved' | 'rejected' | 'pending'
create or replace function public.admin_set_production(p_id uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'not admin'; end if;
  if p_status not in ('approved', 'rejected', 'pending') then raise exception 'bad status'; end if;
  update productions set status = p_status where id = p_id;
  -- статус в профиле владельца: подтверждено — «Производство», иначе — снова «Клиент»
  if p_status = 'approved' then
    update profiles set role = 'operator' where role = 'client' and id = (select owner_id from productions where id = p_id);
  else
    update profiles set role = 'client' where role = 'operator' and id = (select owner_id from productions where id = p_id);
  end if;
end $$;
revoke all on function public.admin_set_production(uuid, text) from public;
grant execute on function public.admin_set_production(uuid, text) to authenticated;

-- владелец правит название, телефон, параметры станка — но не статус подтверждения и не владельца
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

revoke all on function public.register_production(text, text, text, numeric, numeric, numeric, numeric, numeric, text), public.production_orders(), public.order_client(uuid), public.production_set_status(uuid, text) from public;
grant execute on function public.register_production(text, text, text, numeric, numeric, numeric, numeric, numeric, text), public.production_orders(), public.order_client(uuid), public.production_set_status(uuid, text) to authenticated;

-- Статус «в обсуждении / принят / исполнен» ставит только производство или администратор —
-- заказчик не может сам «принять» свой заказ (иначе статистика ничего не значит).
create or replace function public.protect_order_status() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user in ('anon', 'authenticated') and new.status is distinct from old.status and new.status not in ('draft', 'new')
     and not (is_admin() or is_my_production(old.production_id)) then
    raise exception 'status: only production';
  end if;
  return new;
end $$;
drop trigger if exists protect_order_status on public.orders;
create trigger protect_order_status before update on public.orders for each row execute function public.protect_order_status();

-- обновить список функций и таблиц для приложения сразу, не дожидаясь автоматического обновления
notify pgrst, 'reload schema';

-- ═══════════ migration_share_code.sql ═══════════
-- Короткая ссылка на 3D-модель: /v/K7mP2xQa вместо длинного кода.
-- Выполнить один раз в Supabase → SQL Editor (можно повторно). Старые длинные ссылки продолжают работать.

-- 8 знаков без похожих символов (0/O, 1/l/I): подобрать перебором нереально
create or replace function public.gen_share_code() returns text
language sql volatile as $$
  select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789', 1 + get_byte(uuid_send(gen_random_uuid()), i) % 56, 1), '')
  from generate_series(0, 7) as i
$$;

alter table public.model_shares add column if not exists code text;
update public.model_shares set code = public.gen_share_code() where code is null;
alter table public.model_shares alter column code set default public.gen_share_code();
alter table public.model_shares alter column code set not null;
create unique index if not exists model_shares_code_uq on public.model_shares (code);

-- модель по короткому коду — то же, что shared_model по длинному
create or replace function public.shared_model_code(p_code text) returns json
language sql security definer set search_path = public as $$
  select public.shared_model(s.token) from model_shares s where s.code = p_code
$$;
revoke all on function public.shared_model_code(text) from public;
grant execute on function public.shared_model_code(text) to anon, authenticated;

notify pgrst, 'reload schema';

-- ═══ Производство сохраняет свой вариант раскроя (migration_production_nesting.sql) ═══
create or replace function public.production_save_nesting(p_order uuid, p_value text) returns void
language plpgsql security definer set search_path = public as $$
declare o record;
begin
  select * into o from orders where id = p_order;
  if not found or not (is_admin() or o.user_id = auth.uid() or (o.status <> 'draft' and is_my_production(o.production_id))) then
    raise exception 'not allowed';
  end if;
  update orders set nesting_result = p_value where id = p_order;
end $$;
revoke all on function public.production_save_nesting(uuid, text) from public;
grant execute on function public.production_save_nesting(uuid, text) to authenticated;
notify pgrst, 'reload schema';

-- ═══ Ссылка на симуляцию ЧПУ (migration_sim_shares.sql) ═══
-- 8 знаков без похожих символов (0/O, 1/l/I) — та же функция, что и у ссылок на 3D-модель
create or replace function public.gen_share_code() returns text
language sql volatile as $$
  select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789', 1 + get_byte(uuid_send(gen_random_uuid()), i) % 56, 1), '')
  from generate_series(0, 7) as i
$$;

create table if not exists public.sim_shares (
  code text primary key default public.gen_share_code(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  name text not null,
  data text not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create unique index if not exists sim_shares_uq on public.sim_shares (user_id, order_id, name);
alter table public.sim_shares enable row level security;
drop policy if exists "sim_shares: свои" on public.sim_shares;
create policy "sim_shares: свои" on public.sim_shares for all
  using (user_id = auth.uid() or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'))
  with check (user_id = auth.uid() and order_id in (select id from public.orders));

-- симуляция по коду — без входа; отдаёт только сам снимок
create or replace function public.shared_sim(p_code text) returns json
language sql security definer set search_path = public stable as $$
  select json_build_object('name', s.name, 'data', s.data) from sim_shares s where s.code = p_code
$$;
revoke all on function public.shared_sim(text) from public;
grant execute on function public.shared_sim(text) to anon, authenticated;

notify pgrst, 'reload schema';
