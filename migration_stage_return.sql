-- Вернуть заказ на любой пройденный пост (выбор поста). Выполнить один раз в Supabase → SQL Editor (можно повторно).
-- После migration_stage_start.sql.
-- Выбранный пост — снова «новый» (ждёт «Принять»); все пройденные посты после него — снова ждут: заказ заново идёт по цепочке.
-- Вернуть может владелец, начальник или сотрудник текущего поста.

create or replace function public.stage_return(p_order uuid, p_stage uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare cur order_stages; tgt order_stages;
begin
  select * into cur from order_stages where order_id = p_order and status in ('queued', 'accepted') order by sort limit 1;
  if not exists (select 1 from orders o where o.id = p_order and o.status = 'inwork' and (is_admin() or is_my_production(o.production_id)))
     and not (cur.id is not null and on_post(cur.post_id)) then raise exception 'not allowed'; end if;
  select * into tgt from order_stages where id = p_stage and order_id = p_order;
  if tgt.id is null or tgt.status <> 'done' or (cur.id is not null and tgt.sort >= cur.sort) then return false; end if;
  -- текущий и пройденные после выбранного — снова ждут (пропущенные остаются пропущенными)
  update order_stages set status = 'waiting', queued_at = null, accepted_at = null, accepted_by = null, done_at = null, done_by = null
    where order_id = p_order and sort > tgt.sort and status in ('done', 'queued', 'accepted');
  update order_stages set status = 'queued', queued_at = now(), accepted_at = null, accepted_by = null, done_at = null, done_by = null where id = tgt.id;
  return true;
end $$;
revoke all on function public.stage_return(uuid, uuid) from public, anon;
grant execute on function public.stage_return(uuid, uuid) to authenticated;
notify pgrst, 'reload schema';
