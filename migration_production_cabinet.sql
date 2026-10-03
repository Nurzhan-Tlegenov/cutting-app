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
      values (left(trim(p_name), 80), auth.uid(), left(trim(p_country), 60), left(trim(coalesce(p_phone, '')), 40), left(trim(coalesce(p_city, '')), 80), p_kerf, p_ml, p_mr, p_mt, p_mb,
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
