-- Исправления техпроцесса. Выполнить один раз в Supabase → SQL Editor (можно повторно). После migration_stage_log.sql.
--
-- 1) У сотрудника на посту висели заказы, которые уже исполнены (их отметили «Исполнен» кнопкой, пока заказ стоял на
--    посту): очередь поста показывает только заказы в работе, а у исполненных заказов незакрытые посты закрываются.
-- 2) Заказ «261010 Тимур» (12 окт., 14:03): у сотрудника приложение не видело детали заказа и посчитало, что кромки
--    и присадки нет, — посты пропустились и заказ исполнился сам. В приложении это исправлено (детали теперь берутся
--    функцией базы, а без деталей посты не пропускаются). Ниже заказ возвращается в работу на пост кромления.

-- 1) очередь поста — только заказы в работе
create or replace function public.my_post_queue() returns json
language sql security definer set search_path = public stable as $$
  select coalesce(json_agg(json_build_object('stage_id', s.id, 'status', s.status, 'post_id', s.post_id, 'post_name', s.name,
      'rule', (select p.rule from production_posts p where p.id = s.post_id),
      'scanned', (select coalesce(sum(n), 0) from stage_scans x where x.stage_id = s.id),
      'queued_at', s.queued_at, 'accepted_at', s.accepted_at,
      'accepted_by', prod_user_name(s.accepted_by, o.production_id),
      'accepted_me', s.accepted_by = auth.uid(),
      'order_id', o.id, 'order_number', o.order_number, 'order_name', o.order_name, 'material_name', o.material_name,
      'production_id', o.production_id, 'gcode_at', o.gcode_at, 'files_saved_at', o.files_saved_at,
      'sheets', order_sheet_count(o.nesting_result),
      'parts', (select coalesce(sum(d.qty), 0) from order_details d where d.order_id = o.id),
      'next_post', (select n.name from order_stages n where n.order_id = s.order_id and n.status = 'waiting' order by n.sort limit 1))
    order by s.status desc, s.queued_at), '[]'::json)
  from order_stages s join orders o on o.id = s.order_id
  where s.status in ('queued', 'accepted') and on_post(s.post_id) and o.status = 'inwork'
$$;
revoke all on function public.my_post_queue() from public, anon;
grant execute on function public.my_post_queue() to authenticated;

-- у исполненных заказов незакрытые посты — закрыть (пропущены)
update public.order_stages s set status = 'skipped', done_at = coalesce(o.done_at, now())
  from public.orders o
  where o.id = s.order_id and o.status = 'done' and s.status in ('waiting', 'queued', 'accepted');

-- 2) вернуть «261010 Тимур» (оформлен 12 окт. около 14:03) в работу — на пост кромления
do $$
declare oid uuid; k order_stages;
begin
  select o.id into oid from orders o
    where o.status = 'done' and (coalesce(o.order_number, '') || ' ' || coalesce(o.order_name, '')) ilike '%261010%'
      and o.created_at between '2026-10-12 08:55+00' and '2026-10-12 09:10+00'
      and exists (select 1 from order_stages s where s.order_id = o.id)
    order by o.created_at desc limit 1;
  if oid is null then raise notice 'Заказ 261010 (14:03) не найден — пропускаю'; return; end if;
  select * into k from order_stages where order_id = oid and name ilike 'кром%' order by sort limit 1;
  if k.id is null then raise notice 'У заказа нет поста кромления — пропускаю'; return; end if;
  -- посты после кромления, пропущенные вместе с ним, — снова ждут (пропущенные при запуске «по галочке» — остаются)
  update order_stages set status = 'waiting', done_at = null, done_by = null
    where order_id = oid and sort > k.sort and status = 'skipped' and done_at >= coalesce(k.queued_at, k.done_at) - interval '1 minute';
  update order_stages set status = 'queued', queued_at = coalesce(queued_at, now()), accepted_at = null, accepted_by = null, done_at = null, done_by = null
    where id = k.id;
  update orders set status = 'inwork', done_at = null, prod_archived_at = null where id = oid;
  raise notice 'Заказ возвращён в работу на пост «%»', k.name;
end $$;
notify pgrst, 'reload schema';
