-- Проверка: кто закреплён за каждым постом и где стоит заказ 261012_006. Результат — одна колонка, коротко.
select p.name || ': ' || coalesce((select string_agg(coalesce(nullif(m.name, ''), 'без имени') || case when m.active then '' else ' (выкл)' end, ', ')
    from post_members pm join production_members m on m.user_id = pm.user_id and m.production_id = p.production_id
    where pm.post_id = p.id), '— никого —') as "пост: сотрудники"
from production_posts p
where p.production_id = (select production_id from orders where id = 'ef2f878f-a078-4edf-9d18-ffda3518f473') and p.active
union all
select '261012_006 → ' || s.name || ' [' || s.status || ']' || case when s.post_id is null then ' (пост удалён)'
         when not exists (select 1 from production_posts x where x.id = s.post_id and x.active) then ' (пост выключен)' else '' end
from order_stages s where s.order_id = 'ef2f878f-a078-4edf-9d18-ffda3518f473' and s.status in ('queued', 'accepted');
