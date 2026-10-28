-- Пропуск постов кромления / присадки по галочке в настройке поста. Выполнить один раз в Supabase → SQL Editor
-- (можно повторно). После migration_stage_skip_guard.sql.
--
-- Что было: пост пропускался сам, только если в «Детали на посту» стояло «С кромкой» / «С присадкой». Пост с «Все детали»
-- или «Без списка деталей» не пропускался никогда — сотрудники жали «Пропустить пост» на каждом заказе.
-- Теперь у поста своя настройка «Пропускать пост» (rule.skipIf): «если в заказе нет кромки» / «если нет присадки» / «не
-- пропускать». Не задана — как раньше: по списку деталей, а если список «все» / «без списка» — по названию поста
-- (кромление → нет кромки, присадка / сверловка → нет присадки).
-- Защиты остаются: приложение должно видеть все детали заказа; кромление не пропускается, если в базе есть деталь с кромкой.

-- по какому признаку пост пропускается: 'edge' | 'drill' | null (не пропускается). Как skipKindOf в src/lib/stageParts.js
create or replace function public.post_skip_kind(p_rule jsonb, p_name text) returns text
language sql immutable as $$
  select case
    when p_rule ? 'skipIf' then case when p_rule ->> 'skipIf' in ('edge', 'drill') then p_rule ->> 'skipIf' end
    when coalesce(p_rule ->> 'list', '') in ('edge', 'drill') then p_rule ->> 'list'
    when coalesce(p_name, '') ~* '(присад|сверл|drill)' then 'drill'
    when coalesce(p_name, '') ~* '(кром|edge)' then 'edge'
  end
$$;

-- -> { skipped, reason } — reason: почему пропустить не удалось (показывается на карточке заказа)
create or replace function public.stage_auto_skip_v3(p_order uuid, p_posts uuid[], p_seen integer) returns json
language plpgsql security definer set search_path = public as $$
declare o record; n int := 0; was_active boolean := false; real_n int; edged boolean; ok uuid[];
begin
  select * into o from orders where id = p_order;
  if not found or o.status <> 'inwork' then return json_build_object('skipped', 0, 'reason', 'заказ не в работе'); end if;
  if not (is_admin() or is_my_production(o.production_id) or member_can(o.production_id, null)) then
    return json_build_object('skipped', 0, 'reason', 'нет прав');
  end if;
  select count(*) into real_n from order_details where order_id = p_order;
  if real_n = 0 or coalesce(p_seen, 0) <> real_n then
    return json_build_object('skipped', 0, 'reason', format('приложение видело %s деталей из %s', coalesce(p_seen, 0), real_n));
  end if;
  select exists (select 1 from order_details d where d.order_id = p_order and (
    coalesce(d.edge_left::text, '') not in ('', 'null', 'false') or coalesce(d.edge_right::text, '') not in ('', 'null', 'false')
    or coalesce(d.edge_top::text, '') not in ('', 'null', 'false') or coalesce(d.edge_bottom::text, '') not in ('', 'null', 'false'))) into edged;
  select array_agg(p.id) into ok from production_posts p
    where p.id = any(p_posts)
      and post_skip_kind(p.rule, p.name) is not null
      and not (post_skip_kind(p.rule, p.name) = 'edge' and edged);
  if ok is null then
    return json_build_object('skipped', 0, 'reason', case when edged then 'в заказе есть детали с кромкой' else 'у поста выключен пропуск' end);
  end if;
  select exists (select 1 from order_stages s where s.order_id = p_order and s.post_id = any(ok) and s.status = 'queued'
                   and not exists (select 1 from stage_scans x where x.stage_id = s.id)) into was_active;
  update order_stages s set status = 'skipped', done_at = now()
    where s.order_id = p_order and s.post_id = any(ok) and s.status in ('waiting', 'queued')
      and not exists (select 1 from stage_scans x where x.stage_id = s.id);
  get diagnostics n = row_count;
  if was_active and not exists (select 1 from order_stages where order_id = p_order and status in ('queued', 'accepted')) then
    perform advance_stage(p_order);
  end if;
  return json_build_object('skipped', n, 'reason', null);
end $$;
revoke all on function public.stage_auto_skip_v3(uuid, uuid[], integer) from public, anon;
grant execute on function public.stage_auto_skip_v3(uuid, uuid[], integer) to authenticated;
notify pgrst, 'reload schema';
