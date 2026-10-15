-- Детали на рабочем посту и сканирование бирок. Выполнить один раз в Supabase → SQL Editor (можно повторно).
-- После migration_posts.sql.
--
-- У поста — правило, какие детали заказа идут через него (production_posts.rule):
--   { list: 'all' | 'edge' | 'drill' | 'none', top, bottom, edge, grooves, mills — что учитывать для присадки }
--   например, присадка после фрезера: отверстия сверху не учитывать — в списке только детали с торцевыми отверстиями
--   и отверстиями снизу. Список строится в приложении по деталям заказа.
-- На посту сотрудник сканирует бирки — отмечается, сколько штук каждой детали прошло пост (stage_scans).
-- Сканирование нового заказа на посту — это и «Принять».

alter table public.production_posts add column if not exists rule jsonb;

create table if not exists public.stage_scans (
  stage_id uuid not null references public.order_stages(id) on delete cascade,
  detail_id uuid not null,                  -- строка order_details
  n integer not null default 0,             -- сколько штук прошло
  updated_at timestamptz default now(),
  updated_by uuid references auth.users(id) on delete set null,
  primary key (stage_id, detail_id)
);
alter table public.stage_scans enable row level security;   -- только через функции ниже

-- правило поста (владелец или начальник)
create or replace function public.save_post_rule(p_id uuid, p_rule jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if my_prod_admin() is null then raise exception 'not allowed'; end if;
  update production_posts set rule = p_rule where id = p_id and production_id = my_prod_admin();
end $$;

-- отметить детали: p_n — сколько штук этой детали прошло пост (0 — снять отметку)
create or replace function public.stage_scan(p_stage uuid, p_detail uuid, p_n integer) returns void
language plpgsql security definer set search_path = public as $$
declare s order_stages;
begin
  select * into s from order_stages where id = p_stage;
  if not found or not can_stage(s) then raise exception 'not allowed'; end if;
  if s.status not in ('queued', 'accepted') then raise exception 'stage: not active'; end if;
  if not exists (select 1 from order_details where id = p_detail and order_id = s.order_id) then raise exception 'scan: not this order'; end if;
  if s.status = 'queued' then   -- начали сканировать — значит, приняли
    update order_stages set status = 'accepted', accepted_at = now(), accepted_by = auth.uid() where id = p_stage;
  end if;
  insert into stage_scans (stage_id, detail_id, n, updated_at, updated_by) values (p_stage, p_detail, greatest(0, p_n), now(), auth.uid())
    on conflict (stage_id, detail_id) do update set n = excluded.n, updated_at = now(), updated_by = auth.uid();
end $$;

create or replace function public.stage_scans_of(p_stage uuid) returns json
language plpgsql security definer set search_path = public stable as $$
declare s order_stages;
begin
  select * into s from order_stages where id = p_stage;
  if not found or not can_stage(s) then return '[]'::json; end if;
  return coalesce((select json_agg(json_build_object('detail_id', detail_id, 'n', n)) from stage_scans where stage_id = p_stage and n > 0), '[]'::json);
end $$;

-- посты и очередь — теперь с правилом поста
create or replace function public.posts_list() returns json
language sql security definer set search_path = public stable as $$
  select coalesce(json_agg(json_build_object('id', p.id, 'name', p.name, 'sort', p.sort, 'active', p.active, 'rule', p.rule,
    'members', coalesce((select json_agg(pm.user_id) from post_members pm where pm.post_id = p.id), '[]'::json),
    'queue', (select count(*) from order_stages s where s.post_id = p.id and s.status in ('queued', 'accepted'))) order by p.sort, p.created_at), '[]'::json)
  from production_posts p where p.production_id = my_prod_admin()
$$;

create or replace function public.my_post_queue() returns json
language sql security definer set search_path = public stable as $$
  select coalesce(json_agg(json_build_object('stage_id', s.id, 'status', s.status, 'post_id', s.post_id, 'post_name', s.name,
      'rule', (select p.rule from production_posts p where p.id = s.post_id),
      'scanned', (select coalesce(sum(n), 0) from stage_scans x where x.stage_id = s.id),
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

-- маршрут заказа — с правилом поста и числом отсканированных деталей
create or replace function public.order_stages_of(p_order uuid) returns json
language plpgsql security definer set search_path = public stable as $$
declare o record;
begin
  select * into o from orders where id = p_order;
  if not found or not (is_admin() or o.user_id = auth.uid() or is_my_production(o.production_id) or is_order_worker(p_order)) then return '[]'::json; end if;
  return coalesce((select json_agg(json_build_object('id', s.id, 'post_id', s.post_id, 'name', s.name, 'sort', s.sort, 'status', s.status,
      'queued_at', s.queued_at, 'accepted_at', s.accepted_at, 'done_at', s.done_at,
      'rule', (select p.rule from production_posts p where p.id = s.post_id),
      'scanned', (select coalesce(sum(n), 0) from stage_scans x where x.stage_id = s.id),
      'accepted_by', (select coalesce(m.name, user_contact(s.accepted_by) ->> 'full_name') from production_members m where m.user_id = s.accepted_by and m.production_id = o.production_id),
      'done_by', (select coalesce(m.name, user_contact(s.done_by) ->> 'full_name') from production_members m where m.user_id = s.done_by and m.production_id = o.production_id),
      'mine', on_post(s.post_id)) order by s.sort)
    from order_stages s where s.order_id = p_order), '[]'::json);
end $$;

revoke all on function public.save_post_rule(uuid, jsonb), public.stage_scan(uuid, uuid, integer), public.stage_scans_of(uuid) from public, anon;
grant execute on function public.save_post_rule(uuid, jsonb), public.stage_scan(uuid, uuid, integer), public.stage_scans_of(uuid) to authenticated;
notify pgrst, 'reload schema';
