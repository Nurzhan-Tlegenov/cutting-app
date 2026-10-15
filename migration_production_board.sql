-- Доска техпроцесса производства: все посты и заказы на них (кто на каком посту), заказы «принят, не пущен в работу».
-- Выполнить один раз в Supabase → SQL Editor (можно повторно). После migration_stage_start.sql.
-- Видят владелец производства и начальник (perms.all).

create or replace function public.production_board(p_prod uuid default null) returns json
language plpgsql security definer set search_path = public stable as $$
declare pr uuid;
begin
  pr := case when p_prod is not null and (is_admin() or is_my_production(p_prod)) then p_prod else my_prod_admin() end;
  if pr is null then return null; end if;
  return json_build_object(
    'posts', coalesce((select json_agg(json_build_object('id', p.id, 'name', p.name, 'rule', p.rule, 'sort', p.sort) order by p.sort, p.created_at)
      from production_posts p where p.production_id = pr and p.active), '[]'::json),
    'items', coalesce((select json_agg(json_build_object('stage_id', s.id, 'status', s.status, 'post_id', s.post_id, 'post_name', s.name,
        'rule', (select p.rule from production_posts p where p.id = s.post_id),
        'scanned', (select coalesce(sum(n), 0) from stage_scans x where x.stage_id = s.id),
        'queued_at', s.queued_at, 'accepted_at', s.accepted_at,
        'accepted_by', (select coalesce(m.name, user_contact(s.accepted_by) ->> 'full_name') from production_members m where m.user_id = s.accepted_by and m.production_id = o.production_id),
        'accepted_me', s.accepted_by = auth.uid(),
        'order_id', o.id, 'order_number', o.order_number, 'order_name', o.order_name, 'material_name', o.material_name,
        'client_name', user_contact(o.user_id) ->> 'full_name', 'own', o.user_id = auth.uid(),
        'production_id', o.production_id, 'gcode_at', o.gcode_at, 'files_saved_at', o.files_saved_at,
        'sheets', order_sheet_count(o.nesting_result),
        'parts', (select coalesce(sum(d.qty), 0) from order_details d where d.order_id = o.id),
        'has_prev', exists (select 1 from order_stages b where b.order_id = s.order_id and b.status = 'done' and b.sort < s.sort),
        'next_post', (select n.name from order_stages n where n.order_id = s.order_id and n.status = 'waiting' order by n.sort limit 1))
      order by s.status desc, s.queued_at)
      from order_stages s join orders o on o.id = s.order_id
      where o.production_id = pr and o.status = 'inwork' and s.status in ('queued', 'accepted')), '[]'::json),
    'idle', coalesce((select json_agg(json_build_object('order_id', o.id, 'order_number', o.order_number, 'order_name', o.order_name,
        'material_name', o.material_name, 'client_name', user_contact(o.user_id) ->> 'full_name', 'own', o.user_id = auth.uid(),
        'accepted_at', o.accepted_at, 'sheets', order_sheet_count(o.nesting_result),
        'parts', (select coalesce(sum(d.qty), 0) from order_details d where d.order_id = o.id)) order by o.accepted_at nulls last)
      from orders o where o.production_id = pr and o.status = 'inwork'
        and not exists (select 1 from order_stages s where s.order_id = o.id)), '[]'::json));
end $$;
revoke all on function public.production_board(uuid) from public, anon;
grant execute on function public.production_board(uuid) to authenticated;
notify pgrst, 'reload schema';
