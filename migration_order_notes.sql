-- Примечания заказа (выводятся в PDF карт раскроя):
--   order_note — примечание в бланке заказа (пишет хозяин заказа: клиент или производство);
--   prod_note  — примечание производства (пишет производство в заказе, у статистики), через функцию ниже.
alter table public.orders add column if not exists order_note text;
alter table public.orders add column if not exists prod_note text;

create or replace function public.production_set_note(p_order uuid, p_note text) returns text
language plpgsql security definer set search_path = public as $$
declare o record; v text;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into o from orders where id = p_order;
  if not found or not (is_admin() or o.user_id = auth.uid() or is_my_production(o.production_id)) then raise exception 'not allowed'; end if;
  v := nullif(btrim(left(coalesce(p_note, ''), 2000)), '');
  update orders set prod_note = v where id = p_order;
  return v;
end $$;
revoke all on function public.production_set_note(uuid, text) from public;
grant execute on function public.production_set_note(uuid, text) to authenticated;
