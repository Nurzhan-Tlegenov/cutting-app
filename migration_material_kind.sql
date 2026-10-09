-- Два типа материала у производства и количество листов в заявке.
-- Выполнить один раз в Supabase -> SQL Editor (можно повторно). После migration_production_marks.sql.
--
-- 1) У производства — отдельные рез и отступы для ХДФ / ДВП (тонкий материал, режется на пиле).
-- 2) У заказа — тип материала: 'hdf' — ХДФ / ДВП (только пила), пусто — обычная плита (ЛДСП, МДФ).
-- 3) В списке заявок производства — количество листов по сохранённому раскрою и тип материала.

alter table public.productions add column if not exists hdf_kerf_width numeric;
alter table public.productions add column if not exists hdf_margin_left numeric;
alter table public.productions add column if not exists hdf_margin_right numeric;
alter table public.productions add column if not exists hdf_margin_top numeric;
alter table public.productions add column if not exists hdf_margin_bottom numeric;

alter table public.orders add column if not exists material_kind text;

-- сколько листов в сохранённом раскрое заказа (один материал или несколько); если раскроя нет или он не читается — 0
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

create or replace function public.production_orders() returns json
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  return (select coalesce(json_agg(x order by x.submitted_at desc nulls last), '[]'::json) from (
    select o.id, o.order_number, o.order_name, o.material_name, o.status, o.submitted_at, o.accepted_at, o.created_at,
      o.gcode_at, o.files_saved_at, o.material_kind,
      order_sheet_count(o.nesting_result) as sheets,
      o.user_id = auth.uid() as own,
      c.full_name as client_name, c.phone as client_phone, c.whatsapp as client_whatsapp,
      (select coalesce(sum(d.qty), 0) from order_details d where d.order_id = o.id) as parts
    from orders o join productions p on p.id = o.production_id left join profiles c on c.id = o.user_id
    where p.owner_id = auth.uid() and p.status = 'approved' and o.status <> 'draft') x);
end $$;
notify pgrst, 'reload schema';
