-- Маршрут заказа по постам — только нужные операции. Выполнить один раз в Supabase → SQL Editor (можно повторно).
-- После migration_posts.sql и migration_stage_parts.sql.
--
-- 1) Посты «по галочке» (сборка, установка, упаковка, доставка — то, чего не видно в свойствах деталей): заказ идёт
--    на такой пост, только если производство отметило его в заказе (orders.stage_ops = {"<id поста>": true}).
--    Какой пост «по галочке» — настройка поста (rule.onDemand); не задано — по названию поста или «без списка деталей».
-- 2) Посты кромления / присадки, для которых у заказа нет деталей, приложение пропускает само (stage_auto_skip):
--    нет кромки — кромление пропущено, нет присадки — присадка пропущена; нечего делать — заказ сразу исполнен.

alter table public.orders add column if not exists stage_ops jsonb not null default '{}'::jsonb;

-- пост «по галочке в заказе»
create or replace function public.post_on_demand(p_rule jsonb, p_name text) returns boolean
language sql immutable as $$
  select coalesce((p_rule ->> 'onDemand')::boolean,
    coalesce(p_name, '') ~* '(сборк|установ|монтаж|упаков|достав|отгруз)' or coalesce(p_rule ->> 'list', '') = 'none')
$$;

-- запуск маршрута: посты «по галочке» без отметки в заказе — сразу пропущены; первый оставшийся — в очередь
create or replace function public.start_stages(p_order uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare o record; n int; first uuid;
begin
  select * into o from orders where id = p_order;
  if not found or o.production_id is null then return 0; end if;
  if exists (select 1 from order_stages where order_id = p_order) then return 0; end if;
  insert into order_stages (order_id, post_id, name, sort, status, done_at)
    select p_order, p.id, p.name, row_number() over (order by p.sort, p.created_at),
      case when post_on_demand(p.rule, p.name) and not coalesce((o.stage_ops ->> p.id::text)::boolean, false) then 'skipped' else 'waiting' end,
      case when post_on_demand(p.rule, p.name) and not coalesce((o.stage_ops ->> p.id::text)::boolean, false) then now() end
    from production_posts p
    where p.production_id = o.production_id and p.active;
  get diagnostics n = row_count;
  if n > 0 then
    select id into first from order_stages where order_id = p_order and status = 'waiting' order by sort limit 1;
    if first is not null then update order_stages set status = 'queued', queued_at = now() where id = first;
    else perform advance_stage(p_order); end if;   -- все посты пропущены — исполнен
  end if;
  return n;
end $$;

-- галочка операции в заказе (владелец или начальник производства). Маршрут уже идёт — пост включается или пропускается
create or replace function public.set_order_op(p_order uuid, p_post uuid, p_on boolean) returns void
language plpgsql security definer set search_path = public as $$
declare o record; s order_stages; act order_stages;
begin
  select * into o from orders where id = p_order;
  if not found or not (is_admin() or is_my_production(o.production_id)) then raise exception 'not allowed'; end if;
  update orders set stage_ops = coalesce(stage_ops, '{}'::jsonb) || jsonb_build_object(p_post::text, p_on) where id = p_order;
  select * into s from order_stages where order_id = p_order and post_id = p_post order by sort limit 1;
  if s.id is null or o.status <> 'inwork' then return; end if;
  select * into act from order_stages where order_id = p_order and status in ('queued', 'accepted') order by sort limit 1;
  if p_on and s.status = 'skipped' then
    if act.id is not null and act.sort > s.sort then return; end if;   -- пост уже позади — не возвращаем
    update order_stages set status = 'waiting', done_at = null, done_by = null where id = s.id;
    if act.id is null then perform advance_stage(p_order); end if;
  elsif not p_on and s.status in ('waiting', 'queued', 'accepted') then
    update order_stages set status = 'skipped', done_at = now(), done_by = auth.uid() where id = s.id;
    if s.status in ('queued', 'accepted') then perform advance_stage(p_order); end if;
  end if;
end $$;

-- пропуск постов без деталей для заказа (кромление без кромки, присадка без присадки) — решает приложение по деталям.
-- Пропускается только пост, на котором ещё ничего не отсканировано и который не принят.
create or replace function public.stage_auto_skip(p_order uuid, p_posts uuid[]) returns integer
language plpgsql security definer set search_path = public as $$
declare o record; n int := 0; was_active boolean := false;
begin
  select * into o from orders where id = p_order;
  if not found or o.status <> 'inwork' or not (is_admin() or is_my_production(o.production_id) or member_can(o.production_id, null)) then return 0; end if;
  select exists (select 1 from order_stages s where s.order_id = p_order and s.post_id = any(p_posts) and s.status = 'queued'
                   and not exists (select 1 from stage_scans x where x.stage_id = s.id)) into was_active;
  update order_stages s set status = 'skipped', done_at = now()
    where s.order_id = p_order and s.post_id = any(p_posts) and s.status in ('waiting', 'queued')
      and not exists (select 1 from stage_scans x where x.stage_id = s.id);
  get diagnostics n = row_count;
  if was_active and not exists (select 1 from order_stages where order_id = p_order and status in ('queued', 'accepted')) then
    perform advance_stage(p_order);
  end if;
  return n;
end $$;

-- галочки заказа и посты «по галочке» производства — для карточки заказа
create or replace function public.order_ops_of(p_order uuid) returns json
language plpgsql security definer set search_path = public stable as $$
declare o record;
begin
  select * into o from orders where id = p_order;
  if not found or not (is_admin() or is_my_production(o.production_id) or is_order_worker(p_order) or member_can(o.production_id, null)) then return null; end if;
  return json_build_object('ops', coalesce(o.stage_ops, '{}'::jsonb),
    'posts', coalesce((select json_agg(json_build_object('id', p.id, 'name', p.name) order by p.sort, p.created_at)
      from production_posts p where p.production_id = o.production_id and p.active and post_on_demand(p.rule, p.name)), '[]'::json));
end $$;

revoke all on function public.set_order_op(uuid, uuid, boolean), public.stage_auto_skip(uuid, uuid[]), public.order_ops_of(uuid) from public, anon;
grant execute on function public.set_order_op(uuid, uuid, boolean), public.stage_auto_skip(uuid, uuid[]), public.order_ops_of(uuid) to authenticated;
notify pgrst, 'reload schema';
