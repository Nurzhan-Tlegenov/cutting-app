-- Что случилось с заказом 261012_006: статус, посты, журнал, есть ли детали с кромкой. Одна колонка, коротко.
with o as (select * from orders where id = 'ef2f878f-a078-4edf-9d18-ffda3518f473')
select 'Заказ: ' || o.status || ', деталей ' || (select count(*) from order_details d where d.order_id = o.id)
  || ', с кромкой ' || (select count(*) from order_details d where d.order_id = o.id
       and (coalesce(d.edge_left::text, '') not in ('', 'null', '0', 'false') or coalesce(d.edge_right::text, '') not in ('', 'null', '0', 'false')
         or coalesce(d.edge_top::text, '') not in ('', 'null', '0', 'false') or coalesce(d.edge_bottom::text, '') not in ('', 'null', '0', 'false'))) as "что с заказом"
from o
union all
select 'Пост ' || s.sort || ' ' || s.name || ': ' || s.status from order_stages s where s.order_id = 'ef2f878f-a078-4edf-9d18-ffda3518f473'
union all
select * from (
  select to_char(e.at at time zone 'Asia/Almaty', 'DD.MM HH24:MI') || ' ' || coalesce(e.post_name, '') || ' — ' || e.kind
    || coalesce(' (' || prod_user_name(e.user_id, (select production_id from orders where id = e.order_id)) || ')', '')
  from stage_events e where e.order_id = 'ef2f878f-a078-4edf-9d18-ffda3518f473' order by e.at desc limit 12) x;
