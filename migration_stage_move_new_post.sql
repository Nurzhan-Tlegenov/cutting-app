-- Перенос заказа на пост, которого нет в его маршруте (пост создали позже, чем заказ пустили в работу):
-- пост сам добавляется в маршрут заказа на своё место по порядку постов, и заказ переносится на него.
-- Выполнить один раз в Supabase → SQL Editor (можно повторно). После migration_stage_log.sql.

create or replace function public.stage_move(p_order uuid, p_post uuid) returns text
language plpgsql security definer set search_path = public as $$
declare cur order_stages; tgt order_stages; boss boolean; o record; p record; pos int;
begin
  select * into o from orders where id = p_order;
  select exists (select 1 from orders x where x.id = p_order and x.status = 'inwork' and (is_admin() or is_my_production(x.production_id))) into boss;
  select * into cur from order_stages where order_id = p_order and status in ('queued', 'accepted') order by sort limit 1;
  select * into tgt from order_stages where order_id = p_order and post_id = p_post order by sort limit 1;
  if tgt.id is null then
    -- поста нет в маршруте: добавить (только руководитель и только пост этого производства)
    select * into p from production_posts where id = p_post and production_id = o.production_id and active;
    if p.id is null then return 'no_stage'; end if;
    if not boss then raise exception 'not allowed'; end if;
    -- место в маршруте: после последнего этапа, чей пост стоит раньше нового по порядку постов
    select coalesce(max(s.sort), 0) + 1 into pos from order_stages s left join production_posts pp on pp.id = s.post_id
      where s.order_id = p_order and pp.id is not null and (pp.sort, pp.created_at) < (p.sort, p.created_at);
    update order_stages set sort = sort + 1 where order_id = p_order and sort >= pos;
    insert into order_stages (order_id, post_id, name, sort, status) values (p_order, p.id, p.name, pos, 'waiting') returning * into tgt;
    if cur.id is not null then select * into cur from order_stages where id = cur.id; end if;   -- его порядок мог сдвинуться
  end if;
  if cur.id is not null and tgt.id = cur.id then return 'same'; end if;
  if cur.id is null or tgt.sort < cur.sort then
    if not boss and not (cur.id is not null and on_post(cur.post_id)) then raise exception 'not allowed'; end if;
    update order_stages set status = 'waiting', queued_at = null, accepted_at = null, accepted_by = null, done_at = null, done_by = null
      where order_id = p_order and sort > tgt.sort and status in ('done', 'queued', 'accepted');
  else
    if not boss then raise exception 'not allowed'; end if;
    update order_stages set status = 'done', done_at = now(), done_by = auth.uid() where id = cur.id;
    update order_stages set status = 'skipped', done_at = now(), done_by = auth.uid()
      where order_id = p_order and sort > cur.sort and sort < tgt.sort and status = 'waiting';
  end if;
  update order_stages set status = 'queued', queued_at = now(), accepted_at = null, accepted_by = null, done_at = null, done_by = null where id = tgt.id;
  return 'ok';
end $$;
revoke all on function public.stage_move(uuid, uuid) from public, anon;
grant execute on function public.stage_move(uuid, uuid) to authenticated;
notify pgrst, 'reload schema';
