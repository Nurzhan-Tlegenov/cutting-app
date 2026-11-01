-- «Остановить запуск»: заказ пустили по постам, но работа по нему ещё не началась — маршрут снимается,
-- заказ остаётся принятым («в работе», не пущен по постам). Дальше его можно снова пустить, отменить принятие
-- или объединить с другим заказом в один раскрой. Выполнить один раз в Supabase → SQL Editor.
--
-- Нельзя, если хоть один пост уже выполнен или по заказу сканировали детали. Пост, пропущенный сам
-- (нет кромки / присадки), и «Принять» сотрудником (увидел заказ) — не мешают.

create or replace function public.stop_order_stages(p_order uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare n int; pr uuid;
begin
  select o.production_id into pr from orders o where o.id = p_order and o.status = 'inwork';
  if pr is null or not (is_admin() or exists (select 1 from productions where id = pr and owner_id = auth.uid()) or is_my_production(pr)) then
    raise exception 'not allowed';
  end if;
  if exists (select 1 from order_stages where order_id = p_order and status = 'done') then raise exception 'stage done'; end if;
  begin
    if exists (select 1 from stage_scans x join order_stages s on s.id = x.stage_id where s.order_id = p_order and x.n > 0) then raise exception 'parts scanned'; end if;
  exception when undefined_table then null;
  end;
  delete from order_stages where order_id = p_order;
  get diagnostics n = row_count;
  begin
    insert into stage_events (order_id, kind, user_id) values (p_order, 'stopped', auth.uid());
  exception when undefined_table then null;
  end;
  return n;
end $$;
revoke all on function public.stop_order_stages(uuid) from public, anon;
grant execute on function public.stop_order_stages(uuid) to authenticated;
notify pgrst, 'reload schema';
