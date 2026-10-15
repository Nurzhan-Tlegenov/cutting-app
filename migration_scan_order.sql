-- Сканер бирки у сотрудника производства: детали заказа и его 3D-модель — функцией базы (в обход правил чтения таблиц,
-- с явной проверкой доступа). Выполнить один раз в Supabase → SQL Editor (можно повторно). После migration_staff_read_orders.sql.
-- Открыть может: хозяин заказа, мастер, владелец / начальник производства, любой активный сотрудник этого производства.

create or replace function public.scan_order(p_order uuid) returns json
language plpgsql security definer set search_path = public stable as $$
declare o record;
begin
  select * into o from orders where id = p_order;
  if not found then return null; end if;
  if not (is_admin() or o.user_id = auth.uid()
          or (o.status <> 'draft' and (is_my_production(o.production_id) or member_can(o.production_id, null)))) then return null; end if;
  return json_build_object(
    'details', coalesce((select json_agg(to_json(d) order by d.sort_order) from order_details d where d.order_id = p_order), '[]'::json),
    'model', (select m.data from order_models m where m.order_id = p_order));
end $$;
revoke all on function public.scan_order(uuid) from public, anon;
grant execute on function public.scan_order(uuid) to authenticated;
notify pgrst, 'reload schema';
