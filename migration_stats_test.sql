-- Тестовые заказы — не в «Итогах» производства. Выполнить один раз в Supabase → SQL Editor (можно повторно).
-- После migration_production_stats.sql и migration_order_delete.sql.
--
-- Заказ, который прошёл от «Принять» до «Исполнен» быстрее 20 минут (тест: прогон по статусам и постам), производство
-- может пометить тестовым — тогда его сумма, листы и работы не попадают в итоги производства и в статистику мастера.
-- Пометка хранится по id заказа и переживает удаление заказа заказчиком (строка истории остаётся с тем же id).

create table if not exists public.stats_excluded (
  order_id uuid primary key,
  production_id uuid,
  excluded_by uuid,
  excluded_at timestamptz default now()
);
alter table public.stats_excluded enable row level security;   -- только через функции ниже

-- пометить / снять пометку «тестовый». Пометить можно только быстрый заказ (≤ 20 мин от принятия до исполнения);
-- мастер-аккаунт — любой. Снять пометку можно всегда.
create or replace function public.production_exclude_stats(p_order uuid, p_on boolean default true) returns boolean
language plpgsql security definer set search_path = public as $$
declare pr uuid; t0 timestamptz; t1 timestamptz; st text;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select o.production_id, coalesce(o.accepted_at, o.submitted_at), o.done_at, o.status into pr, t0, t1, st from orders o where o.id = p_order;
  if pr is null then
    select h.production_id, coalesce(h.accepted_at, h.submitted_at), h.done_at, coalesce(h.status, 'done') into pr, t0, t1, st from order_history h where h.order_id = p_order;
  end if;
  if pr is null then raise exception 'not found'; end if;
  if not (is_admin() or exists (select 1 from productions where id = pr and owner_id = auth.uid())) then raise exception 'not allowed'; end if;
  if not p_on then delete from stats_excluded where order_id = p_order; return false; end if;
  if not is_admin() and (st <> 'done' or t0 is null or t1 is null or t1 - t0 > interval '20 minutes') then raise exception 'not a fast order'; end if;
  insert into stats_excluded (order_id, production_id, excluded_by) values (p_order, pr, auth.uid()) on conflict (order_id) do nothing;
  return true;
end $$;
revoke all on function public.production_exclude_stats(uuid, boolean) from public, anon;
grant execute on function public.production_exclude_stats(uuid, boolean) to authenticated;

-- итоги производства: + excluded (тестовый — приложение не считает его в итогах)
create or replace function public.production_stats() returns json
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  return (select coalesce(json_agg(x order by x.submitted_at desc nulls last), '[]'::json) from (
    select o.id, o.order_number, o.order_name, o.status,
      o.created_at, o.submitted_at, o.accepted_at, o.done_at, o.prod_archived_at, false as deleted,
      coalesce(o.archived_sheets, order_sheet_count(o.nesting_result)) as sheets,
      (select coalesce(sum(d.qty), 0) from order_details d where d.order_id = o.id) as parts,
      (q.quote->>'total')::numeric as total, q.quote->>'currency' as currency, q.stats as stats,
      (select c.full_name from profiles c where c.id = o.user_id) as client_name,
      exists (select 1 from stats_excluded e where e.order_id = o.id) as excluded
    from orders o
      join productions p on p.id = o.production_id
      left join order_quotes q on q.order_id = o.id and q.production_id = o.production_id
    where p.owner_id = auth.uid() and p.status = 'approved' and o.status <> 'draft'
    union all
    select h.order_id, h.order_number, h.order_name, coalesce(h.status, 'done'),
      h.created_at, h.submitted_at, h.accepted_at, h.done_at, h.archived_at, true,
      h.sheets, h.parts, h.total, h.currency, h.stats, h.client_name,
      exists (select 1 from stats_excluded e where e.order_id = h.order_id)
    from order_history h
      join productions p on p.id = h.production_id
    where p.owner_id = auth.uid() and p.status = 'approved') x);
end $$;
revoke all on function public.production_stats() from public;
grant execute on function public.production_stats() to authenticated;

-- заказы всех производств (мастер): + excluded — тестовые в суммы не идут
create or replace function public.admin_production_orders() returns json
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'not admin'; end if;
  return (select coalesce(json_agg(x order by x.submitted_at desc nulls last), '[]'::json) from (
    select o.id, o.production_id, o.order_number, o.order_name, o.material_name, o.status,
      o.created_at, o.submitted_at, o.accepted_at, o.done_at, o.archived_at, false as deleted,
      coalesce(o.archived_sheets, order_sheet_count(o.nesting_result)) as sheets,
      (select coalesce(sum(d.qty), 0) from order_details d where d.order_id = o.id) as parts,
      c.full_name as client_name, c.phone as client_phone,
      (q.quote->>'total')::numeric as total, q.quote->>'currency' as currency, q.stats as stats,
      exists (select 1 from stats_excluded e where e.order_id = o.id) as excluded
    from orders o
      left join profiles c on c.id = o.user_id
      left join order_quotes q on q.order_id = o.id and q.production_id = o.production_id
    where o.production_id is not null and o.status <> 'draft'
    union all
    select h.order_id, h.production_id, h.order_number, h.order_name, h.material_name, coalesce(h.status, 'done'),
      h.created_at, h.submitted_at, h.accepted_at, h.done_at, h.archived_at, true,
      h.sheets, h.parts, h.client_name, h.client_phone, h.total, h.currency, h.stats,
      exists (select 1 from stats_excluded e where e.order_id = h.order_id)
    from order_history h
    where h.production_id is not null) x);
end $$;
revoke all on function public.admin_production_orders() from public;
grant execute on function public.admin_production_orders() to authenticated;

notify pgrst, 'reload schema';
