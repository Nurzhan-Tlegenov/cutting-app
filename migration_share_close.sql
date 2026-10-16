-- Ссылка на 3D-модель: видна и закрывается на любом этапе — у заказчика и у производства этого заказа;
-- закрывается сама, как только 3D-модель заказа удалена (заказ удалён, в архиве, модель стёрта).
-- Выполнить один раз в Supabase → SQL Editor (можно повторно).

-- у каких из этих заказов открыта ссылка (свои заказы, заказы своего производства, мастер — все)
create or replace function public.order_shares(p_orders uuid[]) returns table(order_id uuid, code text)
language sql stable security definer set search_path = public as $$
  select s.order_id, coalesce(s.code, s.token::text)
  from model_shares s join orders o on o.id = s.order_id
  where s.order_id = any(p_orders)
    and (o.user_id = auth.uid() or s.user_id = auth.uid() or is_admin() or is_my_production(o.production_id))
$$;
revoke all on function public.order_shares(uuid[]) from public;
grant execute on function public.order_shares(uuid[]) to authenticated;

-- закрыть ссылку: заказчик, производство этого заказа, тот, кто её создал, или мастер
create or replace function public.close_order_share(p_order uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare o record;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into o from orders where id = p_order;
  if found and not (o.user_id = auth.uid() or is_admin() or is_my_production(o.production_id)
      or exists (select 1 from model_shares s where s.order_id = p_order and s.user_id = auth.uid())) then
    raise exception 'not allowed';
  end if;
  delete from model_shares where order_id = p_order;
  return true;
end $$;
revoke all on function public.close_order_share(uuid) from public;
grant execute on function public.close_order_share(uuid) to authenticated;

-- 3D-модель удалили — ссылка закрывается сама
create or replace function public.order_model_gone() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from model_shares where order_id = old.order_id;
  return old;
end $$;
drop trigger if exists order_model_gone on public.order_models;
create trigger order_model_gone after delete on public.order_models for each row execute function public.order_model_gone();

notify pgrst, 'reload schema';
