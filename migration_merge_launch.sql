-- Объединённый раскрой: «Пустить в работу» — объединение распадается на свои заказы.
-- Выполнить один раз в Supabase → SQL Editor (после migration_merge_dissolve.sql). Можно повторно.
--
-- Объединение нужно только для общего раскроя (карты, ЧПУ, бирки, смета). Когда его пускают в работу:
--   • заказы, из которых оно собрано, сами встают в работу — каждый по своему маршруту постов;
--   • если объединение уже шло по постам, заказы получают те же отметки постов (что выполнено — выполнено);
--   • у заказов остаётся ссылка на общий раскрой (orders.merge_cut), «в объединении» они больше не числятся;
--   • само объединение из работы уходит (orders.merge_done_at) — остаётся только как общий раскрой;
--   • в итогах производства снова считаются сами заказы, а не объединение.

alter table public.orders add column if not exists merge_cut uuid;          -- заказ: общий раскрой (объединение), из которого режется
alter table public.orders add column if not exists merge_done_at timestamptz; -- объединение: распалось на заказы, пущенные в работу

create or replace function public.merge_launch(p_merged uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare o record; s record; n int := 0; q uuid; had boolean;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into o from orders where id = p_merged;
  if not found or o.merge_of is null then raise exception 'not merged'; end if;
  if not (is_admin() or is_my_production(o.production_id)) then raise exception 'not allowed'; end if;
  if o.merge_done_at is not null then return 0; end if;
  if o.status <> 'inwork' then raise exception 'not inwork'; end if;
  had := exists (select 1 from order_stages where order_id = p_merged);

  for s in select id from orders where merged_into = p_merged loop
    update orders set status = 'inwork', production_id = o.production_id,
        submitted_at = coalesce(submitted_at, now()), accepted_at = coalesce(accepted_at, now()),
        merged_into = null, merge_cut = p_merged
      where id = s.id;
    perform start_stages(s.id);
    if had then
      -- объединение уже шло по постам: те же отметки — у заказа
      update order_stages set status = 'waiting', queued_at = null where order_id = s.id and status = 'queued';
      update order_stages d set status = m.status, queued_at = m.queued_at, accepted_at = m.accepted_at,
          accepted_by = m.accepted_by, done_at = m.done_at, done_by = m.done_by
        from order_stages m
        where m.order_id = p_merged and d.order_id = s.id and d.post_id = m.post_id and m.status <> 'waiting';
      if not exists (select 1 from order_stages where order_id = s.id and status in ('queued', 'accepted')) then
        select id into q from order_stages where order_id = s.id and status = 'waiting' order by sort limit 1;
        if q is not null then update order_stages set status = 'queued', queued_at = now() where id = q;
        elsif exists (select 1 from order_stages where order_id = s.id) then perform advance_stage(s.id); end if;
      end if;
    end if;
    n := n + 1;
  end loop;

  -- маршрут самого объединения больше не нужен
  begin
    delete from order_stages where order_id = p_merged;
  exception when others then
    update order_stages set status = 'skipped', done_at = coalesce(done_at, now()) where order_id = p_merged and status <> 'done';
  end;
  update orders set merge_done_at = now() where id = p_merged;

  -- итоги производства: снова сами заказы
  begin
    delete from stats_excluded where order_id in (select id from orders where merge_cut = p_merged);
    insert into stats_excluded (order_id, production_id, excluded_by) values (p_merged, o.production_id, auth.uid())
      on conflict (order_id) do nothing;
  exception when undefined_table then null;
  end;
  return n;
end $$;
revoke all on function public.merge_launch(uuid) from public, anon;
grant execute on function public.merge_launch(uuid) to authenticated;

-- «Пустить в работу» объединения = распасться на заказы (число < 0 — сколько заказов пущено)
create or replace function public.start_order_stages(p_order uuid) returns integer
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from orders o where o.id = p_order and o.status = 'inwork' and (is_admin() or is_my_production(o.production_id))) then raise exception 'not allowed'; end if;
  if exists (select 1 from orders where id = p_order and merge_of is not null and merge_done_at is null) then return -merge_launch(p_order); end if;
  return start_stages(p_order);
end $$;
revoke all on function public.start_order_stages(uuid) from public, anon;
grant execute on function public.start_order_stages(uuid) to authenticated;

-- объединение удалили — ссылка на общий раскрой у заказов снимается
create or replace function public.merge_on_delete() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.merge_of is not null then
    if coalesce(old.status, 'draft') = 'draft' then
      begin
        delete from stats_excluded where order_id in (select id from orders where merged_into = old.id);
      exception when undefined_table then null;
      end;
    end if;
    update orders set merged_into = null where merged_into = old.id;
    update orders set merge_cut = null where merge_cut = old.id;
  end if;
  return old;
end $$;

notify pgrst, 'reload schema';
