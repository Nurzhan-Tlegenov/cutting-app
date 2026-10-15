alter table public.orders add column if not exists prod_archived_at timestamptz;

create or replace function public.production_archive_order(p_order uuid, p_on boolean default true) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare o record; t timestamptz;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into o from orders where id = p_order;
  if not found or not (is_admin() or is_my_production(o.production_id)) then raise exception 'not allowed'; end if;
  if p_on and o.status <> 'done' then raise exception 'not done'; end if;
  t := case when p_on then coalesce(o.prod_archived_at, now()) else null end;
  update orders set prod_archived_at = t where id = p_order;
  return t;
end $$;
revoke all on function public.production_archive_order(uuid, boolean) from public;
grant execute on function public.production_archive_order(uuid, boolean) to authenticated;

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
      (select c.full_name from profiles c where c.id = o.user_id) as client_name
    from orders o
      join productions p on p.id = o.production_id
      left join order_quotes q on q.order_id = o.id and q.production_id = o.production_id
    where p.owner_id = auth.uid() and p.status = 'approved' and o.status <> 'draft'
    union all
    select h.order_id, h.order_number, h.order_name, coalesce(h.status, 'done'),
      h.created_at, h.submitted_at, h.accepted_at, h.done_at, h.archived_at, true,
      h.sheets, h.parts, h.total, h.currency, h.stats, h.client_name
    from order_history h
      join productions p on p.id = h.production_id
    where p.owner_id = auth.uid() and p.status = 'approved') x);
end $$;
revoke all on function public.production_stats() from public;
grant execute on function public.production_stats() to authenticated;

create or replace function public.archive_order(p_order uuid) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare o record; t timestamptz := now();
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into o from orders where id = p_order;
  if not found or not (o.user_id = auth.uid() or is_admin()) then raise exception 'not allowed'; end if;
  if o.status not in ('done', 'draft') then raise exception 'not done'; end if;
  if o.archived_at is not null then return o.archived_at; end if;
  update orders set archived_at = t, archived_by = auth.uid(),
    archived_sheets = case when nesting_result is null then archived_sheets else order_sheet_count(nesting_result) end, nesting_result = null
  where id = p_order;
  delete from order_models where order_id = p_order;
  delete from model_shares where order_id = p_order;
  delete from sim_shares where order_id = p_order;
  return t;
end $$;

create or replace function public.restore_order(p_order uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare o record;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into o from orders where id = p_order;
  if not found or not (o.user_id = auth.uid() or is_admin()) then raise exception 'not allowed'; end if;
  update orders set archived_at = null, archived_by = null where id = p_order;
  return true;
end $$;

create or replace function public.delete_order(p_order uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare o record;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into o from orders where id = p_order;
  if not found then return false; end if;
  if not (o.user_id = auth.uid() or is_admin()) then raise exception 'not allowed'; end if;
  delete from orders where id = p_order;
  return true;
end $$;

notify pgrst, 'reload schema';
