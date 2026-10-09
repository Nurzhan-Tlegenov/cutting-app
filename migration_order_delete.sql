alter table public.order_history add column if not exists status text;

create or replace function public.orders_keep_history() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.production_id is not null and old.status <> 'draft' then
    insert into order_history (order_id, user_id, production_id, order_number, order_name, material_name, client_name, client_phone,
        created_at, submitted_at, accepted_at, done_at, archived_at, status, sheets, parts, total, currency, stats)
      select old.id, old.user_id, old.production_id, old.order_number, old.order_name, old.material_name,
        (select c.full_name from profiles c where c.id = old.user_id), (select c.phone from profiles c where c.id = old.user_id),
        old.created_at, old.submitted_at, old.accepted_at, old.done_at, old.archived_at, old.status,
        coalesce(old.archived_sheets, order_sheet_count(old.nesting_result)),
        (select coalesce(sum(d.qty), 0) from order_details d where d.order_id = old.id),
        (select (q.quote->>'total')::numeric from order_quotes q where q.order_id = old.id and q.production_id = old.production_id),
        (select q.quote->>'currency' from order_quotes q where q.order_id = old.id and q.production_id = old.production_id),
        (select q.stats from order_quotes q where q.order_id = old.id and q.production_id = old.production_id)
    on conflict (order_id) do nothing;
  end if;
  delete from order_details where order_id = old.id;
  return old;
end $$;
drop trigger if exists orders_keep_history on public.orders;
create trigger orders_keep_history before delete on public.orders for each row execute function public.orders_keep_history();

create or replace function public.delete_order(p_order uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare o record;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into o from orders where id = p_order;
  if not found then return false; end if;
  if not (o.user_id = auth.uid() or is_admin() or (o.status = 'done' and is_my_production(o.production_id))) then raise exception 'not allowed'; end if;
  delete from orders where id = p_order;
  return true;
end $$;
revoke all on function public.delete_order(uuid) from public;
grant execute on function public.delete_order(uuid) to authenticated;

create or replace function public.archive_order(p_order uuid) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare o record; t timestamptz := now();
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into o from orders where id = p_order;
  if not found or not (o.user_id = auth.uid() or is_admin() or is_my_production(o.production_id)) then raise exception 'not allowed'; end if;
  if not (o.status = 'done' or (o.status = 'draft' and (o.user_id = auth.uid() or is_admin()))) then raise exception 'not done'; end if;
  if o.archived_at is not null then return o.archived_at; end if;
  update orders set archived_at = t, archived_by = auth.uid(),
    archived_sheets = case when nesting_result is null then archived_sheets else order_sheet_count(nesting_result) end, nesting_result = null
  where id = p_order;
  delete from order_models where order_id = p_order;
  delete from model_shares where order_id = p_order;
  delete from sim_shares where order_id = p_order;
  return t;
end $$;

create or replace function public.purge_archived_orders() returns int
language plpgsql security definer set search_path = public as $$
declare n int := 0;
begin
  if auth.uid() is null then return 0; end if;
  delete from orders o
  where o.archived_at is not null and o.archived_at < now() - interval '3 months'
    and not exists (select 1 from profiles p where p.role = 'admin' and (p.id = o.user_id or p.id = o.archived_by));
  get diagnostics n = row_count;
  return n;
end $$;

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
      (q.quote->>'total')::numeric as total, q.quote->>'currency' as currency, q.stats as stats
    from orders o
      left join profiles c on c.id = o.user_id
      left join order_quotes q on q.order_id = o.id and q.production_id = o.production_id
    where o.production_id is not null and o.status <> 'draft'
    union all
    select h.order_id, h.production_id, h.order_number, h.order_name, h.material_name, coalesce(h.status, 'done'),
      h.created_at, h.submitted_at, h.accepted_at, h.done_at, h.archived_at, true,
      h.sheets, h.parts, h.client_name, h.client_phone, h.total, h.currency, h.stats
    from order_history h
    where h.production_id is not null) x);
end $$;

notify pgrst, 'reload schema';
