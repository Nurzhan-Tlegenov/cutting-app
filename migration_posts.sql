-- Рабочие посты производства (техпроцесс): заказ идёт по постам как по канбану.
-- Выполнить один раз в Supabase → SQL Editor (можно повторно). После migration_workplaces.sql.
--
-- Пост (операция) — раскрой, кромление, присадка, упаковка, доставка… Производство само задаёт их порядок
-- и закрепляет за постом сотрудников (несколько; один сотрудник — на нескольких постах).
-- Заказ принят в работу → встаёт на первый пост. Сотрудник поста нажимает «Принять» (видно кто и когда),
-- «Выполнено» может нажать любой сотрудник поста → заказ сам переходит на следующий пост, сотрудники которого
-- видят его новым. После последнего поста заказ исполнен и уходит из производства. По каждому посту видно время.
-- Сотрудник видит заказы, стоящие сейчас на его постах.

create table if not exists public.production_posts (
  id uuid primary key default gen_random_uuid(),
  production_id uuid not null references public.productions(id) on delete cascade,
  name text not null,
  sort integer not null default 0,
  active boolean not null default true,
  created_at timestamptz default now()
);
create table if not exists public.post_members (
  post_id uuid not null references public.production_posts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  primary key (post_id, user_id)
);
-- этапы заказа: копия маршрута на момент запуска (переименование и порядок постов потом его не ломают)
create table if not exists public.order_stages (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  post_id uuid references public.production_posts(id) on delete set null,
  name text not null,
  sort integer not null,
  status text not null default 'waiting' check (status in ('waiting', 'queued', 'accepted', 'done', 'skipped')),
  queued_at timestamptz, accepted_at timestamptz, done_at timestamptz,
  accepted_by uuid references auth.users(id) on delete set null,
  done_by uuid references auth.users(id) on delete set null
);
create index if not exists order_stages_order on public.order_stages (order_id, sort);
create index if not exists order_stages_post on public.order_stages (post_id, status);
alter table public.production_posts enable row level security;   -- только через функции ниже
alter table public.post_members enable row level security;
alter table public.order_stages enable row level security;

-- я — сотрудник этого поста
create or replace function public.on_post(p_post uuid) returns boolean
language sql security definer set search_path = public stable as $$
  select exists (select 1 from post_members pm join production_posts p on p.id = pm.post_id
                 join production_members m on m.production_id = p.production_id and m.user_id = pm.user_id
                 where pm.post_id = p_post and pm.user_id = auth.uid() and m.active)
$$;
-- сотрудник видит заказ, если тот сейчас на его посту (или назначен ему напрямую — по-старому)
create or replace function public.is_order_worker(p_order uuid) returns boolean
language sql security definer set search_path = public stable as $$
  select exists (select 1 from order_stages s where s.order_id = p_order and s.status in ('queued', 'accepted') and on_post(s.post_id))
      or exists (select 1 from order_workers w join orders o on o.id = w.order_id
                 where w.order_id = p_order and w.user_id = auth.uid() and o.status <> 'draft' and member_can(o.production_id, null))
$$;

-- моё производство для управления постами: владелец или начальник
create or replace function public.my_prod_admin() returns uuid
language sql security definer set search_path = public stable as $$
  select coalesce((select id from productions where owner_id = auth.uid() and status = 'approved'),
    (select m.production_id from production_members m join productions p on p.id = m.production_id
     where m.user_id = auth.uid() and m.active and p.status = 'approved' and m.perms ->> 'all' = 'true' limit 1))
$$;

-- ── посты: список и настройка (владелец или начальник) ──
create or replace function public.posts_list() returns json
language sql security definer set search_path = public stable as $$
  select coalesce(json_agg(json_build_object('id', p.id, 'name', p.name, 'sort', p.sort, 'active', p.active,
    'members', coalesce((select json_agg(pm.user_id) from post_members pm where pm.post_id = p.id), '[]'::json),
    'queue', (select count(*) from order_stages s where s.post_id = p.id and s.status in ('queued', 'accepted'))) order by p.sort, p.created_at), '[]'::json)
  from production_posts p where p.production_id = my_prod_admin()
$$;

create or replace function public.save_post(p_id uuid, p_name text, p_active boolean) returns uuid
language plpgsql security definer set search_path = public as $$
declare pr uuid := my_prod_admin(); r uuid;
begin
  if pr is null then raise exception 'not allowed'; end if;
  if p_id is null then
    insert into production_posts (production_id, name, sort) values (pr, coalesce(nullif(trim(p_name), ''), 'Пост'),
      coalesce((select max(sort) + 1 from production_posts where production_id = pr), 0)) returning id into r;
    return r;
  end if;
  update production_posts set name = coalesce(nullif(trim(p_name), ''), name), active = coalesce(p_active, active) where id = p_id and production_id = pr;
  return p_id;
end $$;

create or replace function public.delete_post(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from production_posts where id = p_id and production_id = my_prod_admin();
end $$;

-- порядок постов: p_ids — все посты в нужном порядке
create or replace function public.order_posts(p_ids uuid[]) returns void
language plpgsql security definer set search_path = public as $$
declare pr uuid := my_prod_admin(); i int;
begin
  if pr is null then raise exception 'not allowed'; end if;
  for i in 1 .. coalesce(array_length(p_ids, 1), 0) loop
    update production_posts set sort = i where id = p_ids[i] and production_id = pr;
  end loop;
end $$;

-- сотрудники поста: p_users — все, кто закреплён (сотрудники этого производства)
create or replace function public.set_post_members(p_post uuid, p_users uuid[]) returns void
language plpgsql security definer set search_path = public as $$
declare pr uuid := my_prod_admin();
begin
  if pr is null or not exists (select 1 from production_posts where id = p_post and production_id = pr) then raise exception 'not allowed'; end if;
  delete from post_members where post_id = p_post;
  insert into post_members (post_id, user_id)
    select p_post, u from unnest(coalesce(p_users, '{}')) u where exists (select 1 from production_members where production_id = pr and user_id = u);
end $$;

-- ── маршрут заказа ──
-- запустить заказ по постам (сам — при принятии в работу; вручную — для заказов, принятых раньше)
create or replace function public.start_stages(p_order uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare o record; n int;
begin
  select * into o from orders where id = p_order;
  if not found or o.production_id is null then return 0; end if;
  if exists (select 1 from order_stages where order_id = p_order) then return 0; end if;
  insert into order_stages (order_id, post_id, name, sort)
    select p_order, p.id, p.name, row_number() over (order by p.sort, p.created_at) from production_posts p
    where p.production_id = o.production_id and p.active;
  get diagnostics n = row_count;
  if n > 0 then
    update order_stages set status = 'queued', queued_at = now() where order_id = p_order and sort = 1;
  end if;
  return n;
end $$;

create or replace function public.trg_start_stages() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'inwork' and coalesce(old.status, '') <> 'inwork' then perform start_stages(new.id); end if;
  return null;
end $$;
drop trigger if exists start_stages on public.orders;
create trigger start_stages after update of status on public.orders for each row execute function public.trg_start_stages();

-- заказ снова отправлен заказчику (возврат на доработку, «новый», «обсуждение») — маршрут сбрасывается
create or replace function public.trg_reset_stages() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status in ('draft', 'new', 'discussion') and old.status in ('inwork', 'done') then delete from order_stages where order_id = new.id; end if;
  return null;
end $$;
drop trigger if exists reset_stages on public.orders;
create trigger reset_stages after update of status on public.orders for each row execute function public.trg_reset_stages();

-- могу ли я двигать этап: сотрудник поста, владелец или начальник
create or replace function public.can_stage(s order_stages) returns boolean
language sql security definer set search_path = public stable as $$
  select is_admin() or on_post(s.post_id) or exists (select 1 from orders o where o.id = s.order_id and is_my_production(o.production_id))
$$;

-- следующий этап: встаёт в очередь; этапов больше нет — заказ исполнен и уходит из производства
create or replace function public.advance_stage(p_order uuid) returns void
language plpgsql security definer set search_path = public as $$
declare nx uuid;
begin
  select id into nx from order_stages where order_id = p_order and status = 'waiting' order by sort limit 1;
  if nx is not null then
    update order_stages set status = 'queued', queued_at = now() where id = nx;
  else
    update orders set status = 'done', done_at = coalesce(done_at, now()), accepted_at = coalesce(accepted_at, now()),
      prod_archived_at = case when user_id is distinct from (select owner_id from productions where id = production_id) then coalesce(prod_archived_at, now()) else prod_archived_at end
    where id = p_order and status <> 'done';
  end if;
end $$;

-- «Принять» на посту: фиксируется кто и когда
create or replace function public.stage_accept(p_stage uuid) returns void
language plpgsql security definer set search_path = public as $$
declare s order_stages;
begin
  select * into s from order_stages where id = p_stage;
  if not found or not can_stage(s) then raise exception 'not allowed'; end if;
  if s.status <> 'queued' then raise exception 'stage: not queued'; end if;
  update order_stages set status = 'accepted', accepted_at = now(), accepted_by = auth.uid() where id = p_stage;
end $$;

-- «Выполнено»: может любой сотрудник поста (не обязательно тот, кто принял)
create or replace function public.stage_done(p_stage uuid) returns void
language plpgsql security definer set search_path = public as $$
declare s order_stages;
begin
  select * into s from order_stages where id = p_stage;
  if not found or not can_stage(s) then raise exception 'not allowed'; end if;
  if s.status not in ('queued', 'accepted') then raise exception 'stage: not active'; end if;
  update order_stages set status = 'done', done_at = now(), done_by = auth.uid(),
    accepted_at = coalesce(accepted_at, now()), accepted_by = coalesce(accepted_by, auth.uid()) where id = p_stage;
  perform advance_stage(s.order_id);
end $$;

-- пропустить этап (у этого заказа операции нет — например, без кромки): владелец или начальник
create or replace function public.stage_skip(p_stage uuid) returns void
language plpgsql security definer set search_path = public as $$
declare s order_stages; active boolean;
begin
  select * into s from order_stages where id = p_stage;
  if not found or not exists (select 1 from orders o where o.id = s.order_id and (is_admin() or is_my_production(o.production_id))) then raise exception 'not allowed'; end if;
  if s.status not in ('waiting', 'queued', 'accepted') then return; end if;
  active := s.status in ('queued', 'accepted');
  update order_stages set status = 'skipped', done_at = now(), done_by = auth.uid() where id = p_stage;
  if active then perform advance_stage(s.order_id); end if;
end $$;

-- вернуть заказ на предыдущий пост (переделать): владелец или начальник
create or replace function public.stage_back(p_order uuid) returns void
language plpgsql security definer set search_path = public as $$
declare cur order_stages; prv order_stages;
begin
  if not exists (select 1 from orders o where o.id = p_order and (is_admin() or is_my_production(o.production_id))) then raise exception 'not allowed'; end if;
  select * into cur from order_stages where order_id = p_order and status in ('queued', 'accepted') order by sort limit 1;
  select * into prv from order_stages where order_id = p_order and status = 'done' and (cur.id is null or sort < cur.sort) order by sort desc limit 1;
  if prv.id is null then return; end if;
  if cur.id is not null then update order_stages set status = 'waiting', queued_at = null, accepted_at = null, accepted_by = null where id = cur.id; end if;
  update order_stages set status = 'queued', queued_at = now(), accepted_at = null, accepted_by = null, done_at = null, done_by = null where id = prv.id;
end $$;

-- маршрут заказа с временем и именами
create or replace function public.order_stages_of(p_order uuid) returns json
language plpgsql security definer set search_path = public stable as $$
declare o record;
begin
  select * into o from orders where id = p_order;
  if not found or not (is_admin() or o.user_id = auth.uid() or is_my_production(o.production_id) or is_order_worker(p_order)) then return '[]'::json; end if;
  return coalesce((select json_agg(json_build_object('id', s.id, 'post_id', s.post_id, 'name', s.name, 'sort', s.sort, 'status', s.status,
      'queued_at', s.queued_at, 'accepted_at', s.accepted_at, 'done_at', s.done_at,
      'accepted_by', (select coalesce(m.name, user_contact(s.accepted_by) ->> 'full_name') from production_members m where m.user_id = s.accepted_by and m.production_id = o.production_id),
      'done_by', (select coalesce(m.name, user_contact(s.done_by) ->> 'full_name') from production_members m where m.user_id = s.done_by and m.production_id = o.production_id),
      'mine', on_post(s.post_id)) order by s.sort)
    from order_stages s where s.order_id = p_order), '[]'::json);
end $$;

-- очередь моих постов: заказы, которые сейчас на моих постах (новые — ещё не приняты)
create or replace function public.my_post_queue() returns json
language sql security definer set search_path = public stable as $$
  select coalesce(json_agg(json_build_object('stage_id', s.id, 'status', s.status, 'post_id', s.post_id, 'post_name', s.name,
      'queued_at', s.queued_at, 'accepted_at', s.accepted_at,
      'accepted_by', (select coalesce(m.name, user_contact(s.accepted_by) ->> 'full_name') from production_members m where m.user_id = s.accepted_by and m.production_id = o.production_id),
      'accepted_me', s.accepted_by = auth.uid(),
      'order_id', o.id, 'order_number', o.order_number, 'order_name', o.order_name, 'material_name', o.material_name,
      'production_id', o.production_id, 'gcode_at', o.gcode_at, 'files_saved_at', o.files_saved_at,
      'sheets', order_sheet_count(o.nesting_result),
      'parts', (select coalesce(sum(d.qty), 0) from order_details d where d.order_id = o.id),
      'next_post', (select n.name from order_stages n where n.order_id = s.order_id and n.status = 'waiting' order by n.sort limit 1))
    order by s.status desc, s.queued_at), '[]'::json)
  from order_stages s join orders o on o.id = s.order_id
  where s.status in ('queued', 'accepted') and on_post(s.post_id)
$$;

-- где сейчас заказы производства (для списка владельца): заказ -> текущий пост
create or replace function public.production_stage_map() returns json
language sql security definer set search_path = public stable as $$
  select coalesce(json_object_agg(x.order_id, json_build_object('name', x.name, 'status', x.status, 'done', x.done, 'total', x.total)), '{}'::json) from (
    select s.order_id,
      (select c.name from order_stages c where c.order_id = s.order_id and c.status in ('queued', 'accepted') order by c.sort limit 1) as name,
      (select c.status from order_stages c where c.order_id = s.order_id and c.status in ('queued', 'accepted') order by c.sort limit 1) as status,
      count(*) filter (where s.status in ('done', 'skipped')) as done, count(*) as total
    from order_stages s join orders o on o.id = s.order_id
    where o.production_id = my_prod_admin() or is_order_worker(o.id)
    group by s.order_id) x
$$;

revoke all on function public.on_post(uuid), public.my_prod_admin(), public.can_stage(order_stages), public.advance_stage(uuid) from public, anon, authenticated;
revoke all on function public.posts_list(), public.save_post(uuid, text, boolean), public.delete_post(uuid), public.order_posts(uuid[]), public.set_post_members(uuid, uuid[]),
  public.start_stages(uuid), public.stage_accept(uuid), public.stage_done(uuid), public.stage_skip(uuid), public.stage_back(uuid),
  public.order_stages_of(uuid), public.my_post_queue(), public.production_stage_map() from public, anon;
grant execute on function public.posts_list(), public.save_post(uuid, text, boolean), public.delete_post(uuid), public.order_posts(uuid[]), public.set_post_members(uuid, uuid[]),
  public.stage_accept(uuid), public.stage_done(uuid), public.stage_skip(uuid), public.stage_back(uuid),
  public.order_stages_of(uuid), public.my_post_queue(), public.production_stage_map() to authenticated;
-- запустить вручную (заказ принят до появления постов): владелец или начальник
create or replace function public.start_order_stages(p_order uuid) returns integer
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from orders o where o.id = p_order and o.status = 'inwork' and (is_admin() or is_my_production(o.production_id))) then raise exception 'not allowed'; end if;
  return start_stages(p_order);
end $$;
revoke all on function public.start_order_stages(uuid) from public, anon;
grant execute on function public.start_order_stages(uuid) to authenticated;
notify pgrst, 'reload schema';
