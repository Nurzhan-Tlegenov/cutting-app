-- Рабочие места производства: сотрудники, приглашения по ссылке, назначение заказов.
-- Выполнить один раз в Supabase → SQL Editor (можно повторно). После migration_limits.sql.
--
-- Сотрудник — обычный аккаунт приложения (может быть и клиентом), привязанный к производству. Полномочия (perms):
--   all    — начальник производства: видит все заказы и может всё, что владелец (кроме настроек производства
--            и сотрудников)
--   status — принимать заказ, менять статусы, возвращать на доработку (в назначенных ему заказах)
--   cnc    — выпускать управляющие программы (G-код, XML присадки)
--   labels — бирки
--   prices — видеть цены, стоимость и итоги
-- Обычный сотрудник (без all) видит только заказы, назначенные ему; дальше (этап 3) — и заказы с его операциями.

alter table public.orders add column if not exists done_at timestamptz;
alter table public.orders add column if not exists prod_archived_at timestamptz;

create table if not exists public.production_members (
  production_id uuid not null references public.productions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text,                                   -- как сотрудника называть на производстве (имя, должность)
  perms jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_at timestamptz default now(),
  primary key (production_id, user_id)
);
create table if not exists public.production_invites (
  code text primary key,
  production_id uuid not null references public.productions(id) on delete cascade,
  name text,
  phone text,
  perms jsonb not null default '{}'::jsonb,
  created_at timestamptz default now(),
  expires_at timestamptz default now() + interval '14 days',
  used_by uuid references auth.users(id) on delete set null,
  used_at timestamptz
);
create table if not exists public.order_workers (
  order_id uuid not null references public.orders(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  assigned_at timestamptz default now(),
  primary key (order_id, user_id)
);
alter table public.production_members enable row level security;   -- только через функции ниже
alter table public.production_invites enable row level security;
alter table public.order_workers enable row level security;

-- ── права ──
-- сотрудник производства с полномочием (p_perm null — любой активный сотрудник); all — все полномочия
create or replace function public.member_can(p_prod uuid, p_perm text) returns boolean
language sql security definer set search_path = public stable as $$
  select p_prod is not null and exists (
    select 1 from production_members m join productions p on p.id = m.production_id
    where m.production_id = p_prod and m.user_id = auth.uid() and m.active and p.status = 'approved'
      and (p_perm is null or m.perms ->> 'all' = 'true' or m.perms ->> p_perm = 'true'))
$$;
-- «моё производство»: владелец или начальник производства (all) — все проверки производства идут через эту функцию
create or replace function public.is_my_production(p_id uuid) returns boolean
language sql security definer set search_path = public stable as $$
  select p_id is not null and (
    exists (select 1 from productions where id = p_id and owner_id = auth.uid() and status = 'approved')
    or exists (select 1 from production_members m join productions p on p.id = m.production_id
               where m.production_id = p_id and m.user_id = auth.uid() and m.active and p.status = 'approved' and m.perms ->> 'all' = 'true'))
$$;
grant execute on function public.is_my_production(uuid) to authenticated, anon;
-- заказ назначен мне (я активный сотрудник его производства)
create or replace function public.is_order_worker(p_order uuid) returns boolean
language sql security definer set search_path = public stable as $$
  select exists (select 1 from order_workers w join orders o on o.id = w.order_id
                 where w.order_id = p_order and w.user_id = auth.uid() and o.status <> 'draft' and member_can(o.production_id, null))
$$;
-- могу ли я работать с заказом с этим полномочием: владелец/начальник — всегда; сотрудник — если заказ назначен и есть полномочие
create or replace function public.can_work_order(p_order uuid, p_perm text) returns boolean
language sql security definer set search_path = public stable as $$
  select exists (select 1 from orders o where o.id = p_order and o.status <> 'draft'
                 and (is_my_production(o.production_id) or (is_order_worker(o.id) and member_can(o.production_id, p_perm))))
$$;
grant execute on function public.member_can(uuid, text), public.is_order_worker(uuid), public.can_work_order(uuid, text) to authenticated;

-- сотрудник читает назначенные ему заказы (детали и 3D-модель — следом: они читаются «у кого виден заказ»)
drop policy if exists "orders: сотрудник читает назначенные" on public.orders;
create policy "orders: сотрудник читает назначенные" on public.orders for select using (public.is_order_worker(id));

-- статус заказа: владелец, начальник, сотрудник с полномочием status (в назначенном заказе)
create or replace function public.production_set_status(p_order uuid, p_status text) returns text
language plpgsql security definer set search_path = public as $$
declare o record;
begin
  if p_status not in ('new', 'discussion', 'inwork', 'done') then raise exception 'bad status'; end if;
  select * into o from orders where id = p_order;
  if not found or o.status = 'draft' or not (is_admin() or can_work_order(p_order, 'status')) then raise exception 'not allowed'; end if;
  update orders set status = p_status,
    accepted_at = case when p_status in ('inwork', 'done') then coalesce(accepted_at, now()) else accepted_at end,
    done_at = case when p_status = 'done' then coalesce(done_at, now()) else null end,
    -- исполненный заказ уходит из списков производства (остаётся в «Итогах»); свой заказ производства — остаётся
    prod_archived_at = case when p_status = 'done' and o.user_id is distinct from auth.uid() then coalesce(prod_archived_at, now()) else prod_archived_at end
  where id = p_order;
  return p_status;
end $$;

-- пометки «G-код создан» / «файлы сохранены»: и сотрудник с полномочием cnc
create or replace function public.production_mark(p_order uuid, p_what text) returns void
language plpgsql security definer set search_path = public as $$
declare o record;
begin
  if p_what not in ('gcode', 'files') then raise exception 'bad mark'; end if;
  select * into o from orders where id = p_order;
  if not found or not (is_admin() or o.user_id = auth.uid() or can_work_order(p_order, 'cnc')) then raise exception 'not allowed'; end if;
  if p_what = 'gcode' then update orders set gcode_at = now(), files_saved_at = null where id = p_order;
  else update orders set files_saved_at = now(), gcode_at = coalesce(gcode_at, now()) where id = p_order; end if;
end $$;

-- список заказов кабинета производства: владелец и начальник — все заказы производства, сотрудник — назначенные ему.
-- mine — заказ назначен мне; production_id — чей заказ (у сотрудника может быть несколько производств)
create or replace function public.production_orders() returns json
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  return (select coalesce(json_agg(x order by x.submitted_at desc nulls last), '[]'::json) from (
    select o.id, o.order_number, o.order_name, o.material_name, o.status, o.submitted_at, o.accepted_at, o.created_at,
      o.gcode_at, o.files_saved_at, o.material_kind, o.production_id,
      order_sheet_count(o.nesting_result) as sheets,
      o.user_id = auth.uid() as own,
      exists (select 1 from order_workers w where w.order_id = o.id and w.user_id = auth.uid()) as mine,
      uc.c->>'full_name' as client_name, uc.c->>'phone' as client_phone, uc.c->>'whatsapp' as client_whatsapp,
      (select coalesce(sum(d.qty), 0) from order_details d where d.order_id = o.id) as parts
    from orders o join productions p on p.id = o.production_id
      left join lateral (select user_contact(o.user_id) as c) uc on true
    where p.status = 'approved' and o.status <> 'draft'
      and (p.owner_id = auth.uid() or is_my_production(p.id) or is_order_worker(o.id))) x);
end $$;

-- ── мои рабочие места: где я сотрудник ──
create or replace function public.my_workplaces() returns json
language sql security definer set search_path = public stable as $$
  select coalesce(json_agg(json_build_object('production_id', p.id, 'production_name', p.name, 'city', p.city, 'country', p.country,
    'name', m.name, 'perms', m.perms, 'owner_name', (select user_contact(p.owner_id) ->> 'full_name')) order by p.name), '[]'::json)
  from production_members m join productions p on p.id = m.production_id
  where m.user_id = auth.uid() and m.active and p.status = 'approved'
$$;

-- ── приглашение по ссылке ──
-- владелец создаёт приглашение: имя, телефон (если регистрация закрыта — по нему сотрудник сможет зарегистрироваться), полномочия
create or replace function public.create_invite(p_name text, p_phone text, p_perms jsonb) returns text
language plpgsql security definer set search_path = public as $$
declare pr uuid; c text; d text := norm_phone(p_phone);
begin
  select id into pr from productions where owner_id = auth.uid() and status = 'approved';
  if pr is null then raise exception 'no production'; end if;
  c := lower(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
  insert into production_invites (code, production_id, name, phone, perms) values (c, pr, nullif(trim(p_name), ''), nullif(trim(p_phone), ''), coalesce(p_perms, '{}'::jsonb));
  if length(d) >= 10 then
    insert into signup_requests (phone, digits, full_name, status, comment) values (trim(p_phone), d, nullif(trim(p_name), ''), 'approved', 'сотрудник производства')
      on conflict (digits) do update set status = 'approved';
  end if;
  return c;
end $$;

-- что за приглашение (страница по ссылке): производство, кому, действует ли
create or replace function public.invite_info(p_code text) returns json
language sql security definer set search_path = public stable as $$
  select json_build_object('production_name', p.name, 'city', p.city, 'name', i.name, 'perms', i.perms,
    'valid', i.used_by is null and i.expires_at > now() and p.status = 'approved',
    'used', i.used_by is not null, 'mine', i.used_by = auth.uid(), 'owner', p.owner_id = auth.uid())
  from production_invites i join productions p on p.id = i.production_id where i.code = lower(trim(p_code))
$$;

-- принять приглашение: я становлюсь сотрудником производства
create or replace function public.accept_invite(p_code text) returns uuid
language plpgsql security definer set search_path = public as $$
declare i record; nm text;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into i from production_invites where code = lower(trim(p_code));
  if not found then raise exception 'invite: not found'; end if;
  if i.used_by is not null and i.used_by <> auth.uid() then raise exception 'invite: used'; end if;
  if i.expires_at < now() then raise exception 'invite: expired'; end if;
  if exists (select 1 from productions where id = i.production_id and owner_id = auth.uid()) then raise exception 'invite: own production'; end if;
  nm := coalesce(i.name, (select user_contact(auth.uid()) ->> 'full_name'));
  insert into production_members (production_id, user_id, name, perms, active) values (i.production_id, auth.uid(), nm, i.perms, true)
    on conflict (production_id, user_id) do update set perms = excluded.perms, active = true, name = coalesce(excluded.name, production_members.name);
  update production_invites set used_by = auth.uid(), used_at = now() where code = i.code;
  return i.production_id;
end $$;

-- ── управление сотрудниками (владелец производства) ──
create or replace function public.production_members_list() returns json
language plpgsql security definer set search_path = public stable as $$
declare pr uuid;
begin
  select id into pr from productions where owner_id = auth.uid();
  if pr is null then
    select production_id into pr from production_members where user_id = auth.uid() and active and perms ->> 'all' = 'true' limit 1;
  end if;
  if pr is null then return json_build_object('members', '[]'::json, 'invites', '[]'::json); end if;
  return json_build_object(
    'members', coalesce((select json_agg(json_build_object('user_id', m.user_id, 'name', m.name, 'perms', m.perms, 'active', m.active, 'created_at', m.created_at,
        'full_name', user_contact(m.user_id) ->> 'full_name', 'phone', user_contact(m.user_id) ->> 'phone',
        'orders', (select count(*) from order_workers w join orders o on o.id = w.order_id where w.user_id = m.user_id and o.production_id = pr and o.status <> 'done'))
      order by m.created_at) from production_members m where m.production_id = pr), '[]'::json),
    'invites', coalesce((select json_agg(json_build_object('code', i.code, 'name', i.name, 'phone', i.phone, 'perms', i.perms, 'created_at', i.created_at, 'expires_at', i.expires_at) order by i.created_at desc)
      from production_invites i where i.production_id = pr and i.used_by is null and i.expires_at > now()), '[]'::json));
end $$;

create or replace function public.set_member(p_user uuid, p_name text, p_perms jsonb, p_active boolean) returns void
language plpgsql security definer set search_path = public as $$
declare pr uuid;
begin
  select id into pr from productions where owner_id = auth.uid();
  if pr is null then raise exception 'not allowed'; end if;
  update production_members set name = coalesce(nullif(trim(p_name), ''), name), perms = coalesce(p_perms, perms), active = coalesce(p_active, active)
  where production_id = pr and user_id = p_user;
end $$;

create or replace function public.remove_member(p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare pr uuid;
begin
  select id into pr from productions where owner_id = auth.uid();
  if pr is null then raise exception 'not allowed'; end if;
  delete from order_workers w using orders o where o.id = w.order_id and o.production_id = pr and w.user_id = p_user;
  delete from production_members where production_id = pr and user_id = p_user;
end $$;

create or replace function public.cancel_invite(p_code text) returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from production_invites i using productions p where p.id = i.production_id and p.owner_id = auth.uid() and i.code = p_code;
end $$;

-- ── назначение заказов сотрудникам (владелец или начальник) ──
create or replace function public.assign_order(p_order uuid, p_user uuid, p_on boolean) returns void
language plpgsql security definer set search_path = public as $$
declare o record;
begin
  select * into o from orders where id = p_order;
  if not found or o.status = 'draft' or not (is_admin() or is_my_production(o.production_id)) then raise exception 'not allowed'; end if;
  if p_on then
    if not exists (select 1 from production_members where production_id = o.production_id and user_id = p_user and active) then raise exception 'not a member'; end if;
    insert into order_workers (order_id, user_id) values (p_order, p_user) on conflict do nothing;
  else
    delete from order_workers where order_id = p_order and user_id = p_user;
  end if;
end $$;

create or replace function public.order_workers_of(p_order uuid) returns json
language plpgsql security definer set search_path = public stable as $$
declare o record;
begin
  select * into o from orders where id = p_order;
  if not found or not (is_admin() or is_my_production(o.production_id) or is_order_worker(p_order)) then return '[]'::json; end if;
  return coalesce((select json_agg(json_build_object('user_id', w.user_id, 'name', coalesce(m.name, user_contact(w.user_id) ->> 'full_name')))
    from order_workers w left join production_members m on m.user_id = w.user_id and m.production_id = o.production_id where w.order_id = p_order), '[]'::json);
end $$;

-- мои полномочия в заказе (для экрана заказа): владелец/начальник — все; сотрудник — свои; иначе null
create or replace function public.my_order_perms(p_order uuid) returns json
language plpgsql security definer set search_path = public stable as $$
declare o record; m record;
begin
  select * into o from orders where id = p_order;
  if not found then return null; end if;
  if is_admin() or exists (select 1 from productions where id = o.production_id and owner_id = auth.uid()) then
    return json_build_object('all', true, 'status', true, 'cnc', true, 'labels', true, 'prices', true, 'owner', true);
  end if;
  select * into m from production_members where production_id = o.production_id and user_id = auth.uid() and active;
  if not found then return null; end if;
  if m.perms ->> 'all' = 'true' then return m.perms::jsonb || '{"status":true,"cnc":true,"labels":true}'::jsonb; end if;
  if not is_order_worker(p_order) then return null; end if;
  return m.perms;
end $$;

revoke all on function public.my_workplaces(), public.create_invite(text, text, jsonb), public.invite_info(text), public.accept_invite(text),
  public.production_members_list(), public.set_member(uuid, text, jsonb, boolean), public.remove_member(uuid), public.cancel_invite(text),
  public.assign_order(uuid, uuid, boolean), public.order_workers_of(uuid), public.my_order_perms(uuid) from public, anon;
grant execute on function public.my_workplaces(), public.create_invite(text, text, jsonb), public.invite_info(text), public.accept_invite(text),
  public.production_members_list(), public.set_member(uuid, text, jsonb, boolean), public.remove_member(uuid), public.cancel_invite(text),
  public.assign_order(uuid, uuid, boolean), public.order_workers_of(uuid), public.my_order_perms(uuid) to authenticated;
notify pgrst, 'reload schema';
