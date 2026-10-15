-- Производство может ПЕРЕКРОИТЬ оформленный на него заказ: сохранить свой вариант карт раскроя.
-- Остальное в заказе (детали, параметры листа) производство по-прежнему не меняет.
-- Выполнять после migration_production_cabinet.sql (или migration_security_all.sql). Можно повторно.
create or replace function public.production_save_nesting(p_order uuid, p_value text) returns void
language plpgsql security definer set search_path = public as $$
declare o record;
begin
  select * into o from orders where id = p_order;
  if not found or not (is_admin() or o.user_id = auth.uid() or (o.status <> 'draft' and is_my_production(o.production_id))) then
    raise exception 'not allowed';
  end if;
  update orders set nesting_result = p_value where id = p_order;
end $$;
revoke all on function public.production_save_nesting(uuid, text) from public;
grant execute on function public.production_save_nesting(uuid, text) to authenticated;
notify pgrst, 'reload schema';
