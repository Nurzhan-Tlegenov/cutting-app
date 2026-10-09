alter table public.orders add column if not exists done_at timestamptz;

create or replace function public.order_sheet_count(p text) returns int
language plpgsql immutable as $$
declare j jsonb; n int := 0; v jsonb;
begin
  if p is null or p = '' then return 0; end if;
  j := p::jsonb;
  if j->>'multi' = 'true' then
    for v in select value from jsonb_each(j->'byMat') loop
      if jsonb_typeof(v->'sheets') = 'array' then n := n + jsonb_array_length(v->'sheets'); end if;
    end loop;
  elsif jsonb_typeof(j->'sheets') = 'array' then
    n := jsonb_array_length(j->'sheets');
  end if;
  return n;
exception when others then
  return 0;
end $$;

create or replace function public.production_set_status(p_order uuid, p_status text) returns text
language plpgsql security definer set search_path = public as $$
declare o record;
begin
  if p_status not in ('new', 'discussion', 'inwork', 'done') then raise exception 'bad status'; end if;
  select * into o from orders where id = p_order;
  if not found or o.status = 'draft' or not (is_admin() or is_my_production(o.production_id)) then raise exception 'not allowed'; end if;
  update orders set status = p_status,
    accepted_at = case when p_status in ('inwork', 'done') then coalesce(accepted_at, now()) else accepted_at end,
    done_at = case when p_status = 'done' then coalesce(done_at, now()) else null end
  where id = p_order;
  return p_status;
end $$;

create or replace function public.admin_production_orders() returns json
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'not admin'; end if;
  return (select coalesce(json_agg(x order by x.submitted_at desc nulls last), '[]'::json) from (
    select o.id, o.production_id, o.order_number, o.order_name, o.material_name, o.status,
      o.created_at, o.submitted_at, o.accepted_at, o.done_at,
      order_sheet_count(o.nesting_result) as sheets,
      (select coalesce(sum(d.qty), 0) from order_details d where d.order_id = o.id) as parts,
      c.full_name as client_name, c.phone as client_phone,
      (q.quote->>'total')::numeric as total, q.quote->>'currency' as currency, q.stats as stats
    from orders o
      left join profiles c on c.id = o.user_id
      left join order_quotes q on q.order_id = o.id and q.production_id = o.production_id
    where o.production_id is not null and o.status <> 'draft') x);
end $$;
revoke all on function public.admin_production_orders() from public;
grant execute on function public.admin_production_orders() to authenticated;

notify pgrst, 'reload schema';
