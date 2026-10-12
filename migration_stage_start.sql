-- Пуск заказа по постам — отдельной кнопкой «Пустить в работу», а не принятием заказа.
-- Выполнить один раз в Supabase → SQL Editor (можно повторно). После migration_stage_ops.sql.
--
-- • «Принять» — только принять заказ (статус «в работе»); маршрут по постам не начинается.
-- • «Пустить в работу» (start_order_stages) — старт техпроцесса: заказ встаёт на первый пост.
-- • Раскрой, кромление, присадка — посты по умолчанию: галочки у них нет, заказ проходит их всегда
--   (кромление и присадка пропускаются, только если таких деталей в заказе нет).
--   Остальные посты (сборка, установка, упаковка и любые свои) — по галочке в заказе, если в настройке поста не сказано иначе.
-- • Вернуть на предыдущий пост может и сотрудник текущего поста (раньше — только владелец и начальник).

drop trigger if exists start_stages on public.orders;

create or replace function public.post_on_demand(p_rule jsonb, p_name text) returns boolean
language sql immutable as $$
  select case when coalesce(p_name, '') ~* '(раскр|распил|кром|присад|сверл)' then false
              else coalesce((p_rule ->> 'onDemand')::boolean, true) end
$$;

drop function if exists public.stage_back(uuid);
create or replace function public.stage_back(p_order uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare cur order_stages; prv order_stages;
begin
  select * into cur from order_stages where order_id = p_order and status in ('queued', 'accepted') order by sort limit 1;
  if not exists (select 1 from orders o where o.id = p_order and (is_admin() or is_my_production(o.production_id)))
     and not (cur.id is not null and on_post(cur.post_id)) then raise exception 'not allowed'; end if;
  select * into prv from order_stages where order_id = p_order and status = 'done' and (cur.id is null or sort < cur.sort) order by sort desc limit 1;
  if prv.id is null then return false; end if;
  if cur.id is not null then update order_stages set status = 'waiting', queued_at = null, accepted_at = null, accepted_by = null where id = cur.id; end if;
  update order_stages set status = 'queued', queued_at = now(), accepted_at = null, accepted_by = null, done_at = null, done_by = null where id = prv.id;
  return true;
end $$;
revoke all on function public.stage_back(uuid) from public, anon;
grant execute on function public.stage_back(uuid) to authenticated;
notify pgrst, 'reload schema';
