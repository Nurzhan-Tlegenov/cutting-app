-- «Расформировать объединение»: объединённый раскрой удаляется, заказы снова отдельные (каждый со своим раскроем,
-- как был). Выполнить один раз в Supabase → SQL Editor (после migration_merge_production.sql).
--
-- Можно, пока по объединению не началась работа: ни один пост не выполнен, детали не сканировали
-- (маршрут по постам, если объединение уже пустили, снимается). Исполненное объединение расформировать нельзя.
-- В истории и итогах производства от объединения ничего не остаётся — снова считаются сами заказы.

create or replace function public.dissolve_merged(p_merged uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare o record; n int;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into o from orders where id = p_merged;
  if not found or o.merge_of is null then raise exception 'not merged'; end if;
  if not (o.user_id = auth.uid() or is_admin()) then raise exception 'not allowed'; end if;
  if o.status = 'done' then raise exception 'merged done'; end if;
  if exists (select 1 from order_stages where order_id = p_merged and status = 'done') then raise exception 'stage done'; end if;
  begin
    if exists (select 1 from stage_scans x join order_stages s on s.id = x.stage_id where s.order_id = p_merged and x.n > 0) then raise exception 'parts scanned'; end if;
  exception when undefined_table then null;
  end;
  begin
    delete from stats_excluded where order_id in (select id from orders where merged_into = p_merged);
  exception when undefined_table then null;
  end;
  update orders set merged_into = null where merged_into = p_merged;
  get diagnostics n = row_count;
  delete from orders where id = p_merged;
  begin
    delete from order_history where order_id = p_merged;     -- объединения не было: в итогах — сами заказы
  exception when undefined_table then null;
  end;
  return n;
end $$;
revoke all on function public.dissolve_merged(uuid) from public, anon;
grant execute on function public.dissolve_merged(uuid) to authenticated;
notify pgrst, 'reload schema';
