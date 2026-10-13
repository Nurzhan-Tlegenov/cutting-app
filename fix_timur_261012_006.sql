-- Вернуть заказ 261012_006 («261010 Тимур», 12 окт. 14:03) в работу — на пост кромления.
do $$
declare oid uuid := 'ef2f878f-a078-4edf-9d18-ffda3518f473'; k order_stages;
begin
  select * into k from order_stages where order_id = oid and name ilike 'кром%' order by sort limit 1;
  if k.id is null then raise exception 'У заказа нет поста кромления'; end if;
  -- посты после кромления, пропущенные вместе с ним, — снова ждут (пропущенные при запуске «по галочке» — остаются)
  update order_stages set status = 'waiting', done_at = null, done_by = null
    where order_id = oid and sort > k.sort and status = 'skipped' and done_at >= coalesce(k.queued_at, k.done_at) - interval '1 minute';
  update order_stages set status = 'queued', queued_at = coalesce(queued_at, now()), accepted_at = null, accepted_by = null, done_at = null, done_by = null
    where id = k.id;
  update orders set status = 'inwork', done_at = null, prod_archived_at = null where id = oid;
  raise notice 'Готово: заказ на посту «%»', k.name;
end $$;

-- проверка: где сейчас заказ
select o.order_number, o.status, s.name as post, s.status as post_status
from orders o join order_stages s on s.order_id = o.id
where o.id = 'ef2f878f-a078-4edf-9d18-ffda3518f473' order by s.sort;
