-- Объединённый раскрой на стороне производства (та же бета «Объединённый раскрой»). Выполнить один раз в Supabase → SQL Editor
-- (после migration_merge_nesting.sql).
--
-- Производство объединяет пришедшие к нему заказы разных заказчиков в один раскрой: объединение — черновик производства
-- (orders.merge_of), заказы-источники помечаются merged_into. В итоги производства идёт только объединение
-- (источники — в stats_excluded). Статус объединения «в работе» / «исполнен» переходит на заказы-источники —
-- заказчик видит, что его заказ в работе и исполнен.

-- пометить заказы-источники (их строки производство само менять не может — это заказы клиентов)
create or replace function public.production_merge_mark(p_merged uuid, p_orders uuid[]) returns int
language plpgsql security definer set search_path = public as $$
declare pr uuid; n int;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select production_id into pr from orders where id = p_merged and user_id = auth.uid() and merge_of is not null;
  if pr is null then raise exception 'not allowed'; end if;
  if not (is_admin() or exists (select 1 from productions where id = pr and owner_id = auth.uid())) then raise exception 'not allowed'; end if;
  update orders set merged_into = p_merged
    where id = any(p_orders) and production_id = pr and status <> 'draft' and status <> 'done';
  get diagnostics n = row_count;
  begin
    insert into stats_excluded (order_id, production_id, excluded_by)
      select id, pr, auth.uid() from orders where id = any(p_orders) and merged_into = p_merged
      on conflict (order_id) do nothing;
  exception when undefined_table then null;      -- итогов производства ещё нет в базе
  end;
  return n;
end $$;
revoke all on function public.production_merge_mark(uuid, uuid[]) from public, anon;
grant execute on function public.production_merge_mark(uuid, uuid[]) to authenticated;

-- статус объединения переходит на заказы-источники (черновики клиента — не трогаем)
create or replace function public.merge_status_follow() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.merge_of is not null and new.status is distinct from old.status then
    if new.status in ('inwork', 'done') then
      update orders set status = new.status,
        accepted_at = case when new.status = 'inwork' then coalesce(accepted_at, now()) else accepted_at end,
        done_at = case when new.status = 'done' then now() else done_at end
      where merged_into = new.id and status <> 'draft' and status <> new.status;
    elsif new.status = 'new' and old.status = 'inwork' then        -- производство отменило принятие объединения
      update orders set status = 'new' where merged_into = new.id and status = 'inwork';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists merge_status_follow on public.orders;
create trigger merge_status_follow after update of status on public.orders
  for each row execute function public.merge_status_follow();

-- объединение удалили, пока оно черновик, — заказы снова отдельные (и снова в итогах)
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
  end if;
  return old;
end $$;
drop trigger if exists merge_on_delete on public.orders;
create trigger merge_on_delete before delete on public.orders
  for each row execute function public.merge_on_delete();

notify pgrst, 'reload schema';
