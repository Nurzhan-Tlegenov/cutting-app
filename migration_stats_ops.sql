-- Итоги производства по операциям (ProductionPage → «Итоги»): запись операций каждого заказа — листы по толщине,
-- кромка по плите и толщине, отверстия по диаметрам, пазы, выемки… и строки сметы (сколько и на какую сумму).
-- Модель и чертежи не храним — только запись. Запись остаётся и после удаления заказа заказчиком (order_history).
-- Раньше без прайс-листа запись в итоги не попадала (бралась только из сметы) — теперь берётся и из order_work_stats.
alter table public.order_history add column if not exists lines jsonb;

create or replace function public.orders_keep_history() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.production_id is not null and old.status <> 'draft' then
    insert into order_history (order_id, user_id, production_id, order_number, order_name, material_name, client_name, client_phone,
        created_at, submitted_at, accepted_at, done_at, archived_at, status, sheets, parts, total, currency, stats, lines)
      select old.id, old.user_id, old.production_id, old.order_number, old.order_name, old.material_name,
        (select c.full_name from profiles c where c.id = old.user_id), (select c.phone from profiles c where c.id = old.user_id),
        old.created_at, old.submitted_at, old.accepted_at, old.done_at, old.archived_at, old.status,
        coalesce(old.archived_sheets, order_sheet_count(old.nesting_result)),
        (select coalesce(sum(d.qty), 0) from order_details d where d.order_id = old.id),
        (select (q.quote->>'total')::numeric from order_quotes q where q.order_id = old.id and q.production_id = old.production_id),
        (select q.quote->>'currency' from order_quotes q where q.order_id = old.id and q.production_id = old.production_id),
        coalesce((select q.stats from order_quotes q where q.order_id = old.id and q.production_id = old.production_id),
          (select w.stats from order_work_stats w where w.order_id = old.id)),
        (select q.quote->'lines' from order_quotes q where q.order_id = old.id and q.production_id = old.production_id)
    on conflict (order_id) do nothing;
  end if;
  delete from order_details where order_id = old.id;
  return old;
end $$;


create or replace function public.production_stats() returns json
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  return (select coalesce(json_agg(x order by x.submitted_at desc nulls last), '[]'::json) from (
    select o.id, o.order_number, o.order_name, o.status,
      o.created_at, o.submitted_at, o.accepted_at, o.done_at, o.prod_archived_at, false as deleted,
      coalesce(o.archived_sheets, order_sheet_count(o.nesting_result)) as sheets,
      (select coalesce(sum(d.qty), 0) from order_details d where d.order_id = o.id) as parts,
      (q.quote->>'total')::numeric as total, q.quote->>'currency' as currency, coalesce(q.stats, w.stats) as stats, q.quote->'lines' as lines,
      (select c.full_name from profiles c where c.id = o.user_id) as client_name,
      exists (select 1 from stats_excluded e where e.order_id = o.id) as excluded
    from orders o
      join productions p on p.id = o.production_id
      left join order_quotes q on q.order_id = o.id and q.production_id = o.production_id
      left join order_work_stats w on w.order_id = o.id
    where p.owner_id = auth.uid() and p.status = 'approved' and o.status <> 'draft'
    union all
    select h.order_id, h.order_number, h.order_name, coalesce(h.status, 'done'),
      h.created_at, h.submitted_at, h.accepted_at, h.done_at, h.archived_at, true,
      h.sheets, h.parts, h.total, h.currency, h.stats, h.lines, h.client_name,
      exists (select 1 from stats_excluded e where e.order_id = h.order_id)
    from order_history h
      join productions p on p.id = h.production_id
    where p.owner_id = auth.uid() and p.status = 'approved') x);
end $$;
revoke all on function public.production_stats() from public;
grant execute on function public.production_stats() to authenticated;
notify pgrst, 'reload schema';
