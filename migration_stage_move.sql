-- Доска техпроцесса как канбан: заказ перетаскивают на любой пост (удержание и перенос пальцем).
-- Выполнить один раз в Supabase → SQL Editor (можно повторно). После migration_stage_return.sql.
-- Назад: выбранный пост — снова «новый», посты после него снова ждут (заказ заново идёт по цепочке).
-- Вперёд: текущий пост — выполнен, посты между — пропущены, выбранный — «новый».
-- Назад может владелец, начальник или сотрудник текущего поста; вперёд — владелец или начальник.
-- -> 'ok' | 'same' (тот же пост) | 'no_stage' (этого поста нет в маршруте заказа)

create or replace function public.stage_move(p_order uuid, p_post uuid) returns text
language plpgsql security definer set search_path = public as $$
declare cur order_stages; tgt order_stages; boss boolean;
begin
  select exists (select 1 from orders o where o.id = p_order and o.status = 'inwork' and (is_admin() or is_my_production(o.production_id))) into boss;
  select * into cur from order_stages where order_id = p_order and status in ('queued', 'accepted') order by sort limit 1;
  select * into tgt from order_stages where order_id = p_order and post_id = p_post order by sort limit 1;
  if tgt.id is null then return 'no_stage'; end if;
  if cur.id is not null and tgt.id = cur.id then return 'same'; end if;
  if cur.id is null or tgt.sort < cur.sort then
    if not boss and not (cur.id is not null and on_post(cur.post_id)) then raise exception 'not allowed'; end if;
    update order_stages set status = 'waiting', queued_at = null, accepted_at = null, accepted_by = null, done_at = null, done_by = null
      where order_id = p_order and sort > tgt.sort and status in ('done', 'queued', 'accepted');
  else
    if not boss then raise exception 'not allowed'; end if;
    update order_stages set status = 'done', done_at = now(), done_by = auth.uid(),
      accepted_at = coalesce(accepted_at, now()), accepted_by = coalesce(accepted_by, auth.uid()) where id = cur.id;
    update order_stages set status = 'skipped', done_at = now(), done_by = auth.uid()
      where order_id = p_order and sort > cur.sort and sort < tgt.sort and status = 'waiting';
  end if;
  update order_stages set status = 'queued', queued_at = now(), accepted_at = null, accepted_by = null, done_at = null, done_by = null where id = tgt.id;
  return 'ok';
end $$;
revoke all on function public.stage_move(uuid, uuid) from public, anon;
grant execute on function public.stage_move(uuid, uuid) to authenticated;
notify pgrst, 'reload schema';
