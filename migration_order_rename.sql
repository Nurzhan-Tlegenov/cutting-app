-- Производство может переименовать заказ клиента (клиент назвал непонятно для производства).
-- Название одно на заказ — его видят и клиент, и производство; оно же — в PDF, программах станка и бирках.
-- Выполнить один раз в Supabase → SQL Editor (можно повторно).
create or replace function public.production_set_name(p_order uuid, p_name text) returns text
language plpgsql security definer set search_path = public as $$
declare o record; v text;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into o from orders where id = p_order;
  if not found or not (is_admin() or o.user_id = auth.uid() or is_my_production(o.production_id)) then raise exception 'not allowed'; end if;
  v := nullif(btrim(left(coalesce(p_name, ''), 120)), '');
  update orders set order_name = v where id = p_order;
  return v;
end $$;
revoke all on function public.production_set_name(uuid, text) from public;
grant execute on function public.production_set_name(uuid, text) to authenticated;
notify pgrst, 'reload schema';
