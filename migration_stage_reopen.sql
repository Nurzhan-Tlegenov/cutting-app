-- Вернуть заказ в техпроцесс на любой пост — и исполненный тоже (кто-то нажал не то — руководитель исправляет сам).
-- Выполнить один раз в Supabase → SQL Editor (можно повторно). После migration_stage_log.sql.
-- Выбранный пост — снова «новый» (ждёт «Принять»), посты после него снова ждут своей очереди: выполненные и пропущенные
-- (кроме постов «по галочке», которые в заказе не отмечены). Исполненный заказ снова «в работе» и возвращается в списки.
-- Может владелец или начальник производства.

create or replace function public.stage_reopen(p_order uuid, p_stage uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare o record; tgt order_stages;
begin
  select * into o from orders where id = p_order;
  if not found or not order_boss(p_order) then raise exception 'not allowed'; end if;
  if o.status not in ('inwork', 'done') then return false; end if;
  select * into tgt from order_stages where id = p_stage and order_id = p_order;
  if tgt.id is null then return false; end if;
  -- посты раньше выбранного, стоявшие активными, — считаются пройденными
  update order_stages set status = 'done', done_at = now(), done_by = auth.uid()
    where order_id = p_order and sort < tgt.sort and status in ('queued', 'accepted');
  -- посты после выбранного — снова ждут (посты «по галочке» без отметки в заказе остаются пропущенными)
  update order_stages s set status = 'waiting', queued_at = null, accepted_at = null, accepted_by = null, done_at = null, done_by = null
    where s.order_id = p_order and s.sort > tgt.sort
      and (s.status in ('done', 'queued', 'accepted')
        or (s.status = 'skipped' and (not post_on_demand((select p.rule from production_posts p where p.id = s.post_id), s.name)
                                      or coalesce((o.stage_ops ->> s.post_id::text)::boolean, false))));
  update order_stages set status = 'queued', queued_at = now(), accepted_at = null, accepted_by = null, done_at = null, done_by = null
    where id = tgt.id;
  if o.status = 'done' then
    update orders set status = 'inwork', done_at = null, prod_archived_at = null where id = p_order;
  end if;
  return true;
end $$;
revoke all on function public.stage_reopen(uuid, uuid) from public, anon;
grant execute on function public.stage_reopen(uuid, uuid) to authenticated;
notify pgrst, 'reload schema';

-- Вернуть в техпроцесс на пост, которого нет в маршруте заказа (пост создали позже): пост добавляется в маршрут
-- на своё место по порядку постов, и заказ встаёт на него. -> true | false
create or replace function public.stage_reopen_post(p_order uuid, p_post uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare o record; p record; s order_stages; pos int;
begin
  select * into o from orders where id = p_order;
  if not found or not order_boss(p_order) then raise exception 'not allowed'; end if;
  select * into s from order_stages where order_id = p_order and post_id = p_post order by sort limit 1;
  if s.id is null then
    select * into p from production_posts where id = p_post and production_id = o.production_id and active;
    if p.id is null then return false; end if;
    select coalesce(max(x.sort), 0) + 1 into pos from order_stages x join production_posts pp on pp.id = x.post_id
      where x.order_id = p_order and (pp.sort, pp.created_at) < (p.sort, p.created_at);
    update order_stages set sort = sort + 1 where order_id = p_order and sort >= pos;
    insert into order_stages (order_id, post_id, name, sort, status) values (p_order, p.id, p.name, pos, 'waiting') returning * into s;
  end if;
  return stage_reopen(p_order, s.id);
end $$;
revoke all on function public.stage_reopen_post(uuid, uuid) from public, anon;
grant execute on function public.stage_reopen_post(uuid, uuid) to authenticated;
notify pgrst, 'reload schema';
