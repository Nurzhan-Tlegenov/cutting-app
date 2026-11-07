-- Итоги производства для сотрудника — по отдельному праву «Итоги производства» (perms.stats). По умолчанию выключено,
-- даже у начальника производства (как «Цены»): владелец производства включает галочкой у сотрудника.
-- Суммы (стоимость заказов) — только если у сотрудника есть и «Цены» (perms.prices); без них итоги — без денег.
-- После migration_stats_test.sql и migration_workplaces.sql. Выполнить в Supabase → SQL Editor. Ничего не удаляет.
create or replace function public.production_stats_of(p_prod uuid) returns json
language plpgsql security definer set search_path = public as $$
declare own boolean; money boolean;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  own := exists (select 1 from productions where id = p_prod and owner_id = auth.uid() and status = 'approved');
  if not own and not exists (select 1 from production_members m join productions p on p.id = m.production_id
      where m.production_id = p_prod and m.user_id = auth.uid() and m.active and p.status = 'approved' and m.perms ->> 'stats' = 'true')
    then raise exception 'not allowed'; end if;
  money := own or exists (select 1 from production_members m where m.production_id = p_prod and m.user_id = auth.uid() and m.active and m.perms ->> 'prices' = 'true');
  return (select coalesce(json_agg(x order by x.submitted_at desc nulls last), '[]'::json) from (
    select o.id, o.order_number, o.order_name, o.status,
      o.created_at, o.submitted_at, o.accepted_at, o.done_at, o.prod_archived_at, false as deleted,
      coalesce(o.archived_sheets, order_sheet_count(o.nesting_result)) as sheets,
      (select coalesce(sum(d.qty), 0) from order_details d where d.order_id = o.id) as parts,
      case when money then (q.quote->>'total')::numeric end as total, case when money then q.quote->>'currency' end as currency, q.stats as stats,
      (select c.full_name from profiles c where c.id = o.user_id) as client_name,
      exists (select 1 from stats_excluded e where e.order_id = o.id) as excluded
    from orders o
      left join order_quotes q on q.order_id = o.id and q.production_id = o.production_id
    where o.production_id = p_prod and o.status <> 'draft'
    union all
    select h.order_id, h.order_number, h.order_name, coalesce(h.status, 'done'),
      h.created_at, h.submitted_at, h.accepted_at, h.done_at, h.archived_at, true,
      h.sheets, h.parts, case when money then h.total end, case when money then h.currency end, h.stats, h.client_name,
      exists (select 1 from stats_excluded e where e.order_id = h.order_id)
    from order_history h
    where h.production_id = p_prod) x);
end $$;
revoke all on function public.production_stats_of(uuid) from public, anon;
grant execute on function public.production_stats_of(uuid) to authenticated;
notify pgrst, 'reload schema';
