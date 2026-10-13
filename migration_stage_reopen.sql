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
