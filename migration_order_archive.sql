alter table public.orders add column if not exists done_at timestamptz;
alter table public.orders add column if not exists archived_at timestamptz;
alter table public.orders add column if not exists archived_by uuid;
alter table public.orders add column if not exists archived_sheets int;

create table if not exists public.order_history (
  order_id uuid primary key,
  user_id uuid,
  production_id uuid,
  order_number text,
  order_name text,
  material_name text,
  client_name text,
  client_phone text,
  created_at timestamptz,
  submitted_at timestamptz,
  accepted_at timestamptz,
  done_at timestamptz,
  archived_at timestamptz,
  deleted_at timestamptz default now(),
  sheets int,
  parts numeric,
  total numeric,
  currency text,
  stats jsonb
);
alter table public.order_history enable row level security;

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

create or replace function public.archive_order(p_order uuid) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare o record; t timestamptz := now();
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into o from orders where id = p_order;
  if not found or not (o.user_id = auth.uid() or is_admin() or is_my_production(o.production_id)) then raise exception 'not allowed'; end if;
  if o.status <> 'done' then raise exception 'not done'; end if;
  if o.archived_at is not null then return o.archived_at; end if;
  update orders set archived_at = t, archived_by = auth.uid(),
    archived_sheets = case when nesting_result is null then archived_sheets else order_sheet_count(nesting_result) end, nesting_result = null
  where id = p_order;
  delete from order_models where order_id = p_order;
  delete from model_shares where order_id = p_order;
  delete from sim_shares where order_id = p_order;
  return t;
end $$;
revoke all on function public.archive_order(uuid) from public;
grant execute on function public.archive_order(uuid) to authenticated;

create or replace function public.restore_order(p_order uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare o record;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into o from orders where id = p_order;
  if not found or not (o.user_id = auth.uid() or is_admin() or is_my_production(o.production_id)) then raise exception 'not allowed'; end if;
  update orders set archived_at = null, archived_by = null where id = p_order;
  return true;
end $$;
revoke all on function public.restore_order(uuid) from public;
grant execute on function public.restore_order(uuid) to authenticated;

create or replace function public.purge_archived_orders() returns int
language plpgsql security definer set search_path = public as $$
declare n int := 0;
begin
  if auth.uid() is null then return 0; end if;
  create temp table if not exists _purge (id uuid) on commit drop;
  truncate _purge;
  insert into _purge
    select o.id from orders o
    where o.archived_at is not null and o.archived_at < now() - interval '3 months'
      and not exists (select 1 from profiles p where p.role = 'admin' and (p.id = o.user_id or p.id = o.archived_by));
  insert into order_history (order_id, user_id, production_id, order_number, order_name, material_name, client_name, client_phone,
      created_at, submitted_at, accepted_at, done_at, archived_at, sheets, parts, total, currency, stats)
    select o.id, o.user_id, o.production_id, o.order_number, o.order_name, o.material_name, c.full_name, c.phone,
      o.created_at, o.submitted_at, o.accepted_at, o.done_at, o.archived_at,
      coalesce(o.archived_sheets, order_sheet_count(o.nesting_result)),
      (select coalesce(sum(d.qty), 0) from order_details d where d.order_id = o.id),
      (q.quote->>'total')::numeric, q.quote->>'currency', q.stats
    from orders o
      join _purge x on x.id = o.id
      left join profiles c on c.id = o.user_id
      left join order_quotes q on q.order_id = o.id and q.production_id = o.production_id
  on conflict (order_id) do nothing;
  delete from order_details where order_id in (select id from _purge);
  delete from orders where id in (select id from _purge);
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.purge_archived_orders() from public;
grant execute on function public.purge_archived_orders() to authenticated;

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
    select h.order_id, h.production_id, h.order_number, h.order_name, h.material_name, 'done',
      h.created_at, h.submitted_at, h.accepted_at, h.done_at, h.archived_at, true,
      h.sheets, h.parts, h.client_name, h.client_phone, h.total, h.currency, h.stats
    from order_history h
    where h.production_id is not null) x);
end $$;
revoke all on function public.admin_production_orders() from public;
grant execute on function public.admin_production_orders() to authenticated;

notify pgrst, 'reload schema';
