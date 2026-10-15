-- Производство возвращает заказ заказчику на доработку: заказ снова становится черновиком,
-- заказчик может его править и оформить заново. Причина возврата видна заказчику.
-- Выполнить один раз в Supabase → SQL Editor. Повторный запуск безопасен.
alter table public.orders add column if not exists return_note text;
alter table public.orders add column if not exists returned_at timestamptz;

create or replace function public.production_return_order(p_order uuid, p_note text default '') returns text
language plpgsql security definer set search_path = public as $$
declare o record;
begin
  select * into o from orders where id = p_order;
  if not found or o.status = 'draft' or not (is_admin() or is_my_production(o.production_id)) then raise exception 'not allowed'; end if;
  update orders set status = 'draft', return_note = nullif(trim(coalesce(p_note, '')), ''), returned_at = now() where id = p_order;
  return 'draft';
end $$;

revoke all on function public.production_return_order(uuid, text) from public;
grant execute on function public.production_return_order(uuid, text) to authenticated;
notify pgrst, 'reload schema';
