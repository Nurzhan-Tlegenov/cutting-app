-- Ссылка на рабочий пост: /post/<id> — открывает один пост (его очередь заказов и сканирование деталей),
-- например на настольном компьютере со сканером-пистолетом. Выполнить один раз в Supabase → SQL Editor (можно повторно).
-- После migration_posts.sql и migration_stage_parts.sql.
--
-- Пост видят только свои: сотрудники, закреплённые за постом, владелец производства и начальник (perms.all).
-- Чужому аккаунту ссылка ничего не покажет.

create or replace function public.post_page(p_post uuid) returns json
language plpgsql security definer set search_path = public stable as $$
declare p production_posts;
begin
  select * into p from production_posts where id = p_post;
  if not found then return null; end if;
  if not (is_admin() or on_post(p.id) or is_my_production(p.production_id) or my_prod_admin() = p.production_id) then return null; end if;
  return json_build_object(
    'post', json_build_object('id', p.id, 'name', p.name, 'rule', p.rule, 'active', p.active, 'production_id', p.production_id,
      'production_name', (select name from productions where id = p.production_id),
      'next_post', (select n.name from production_posts n where n.production_id = p.production_id and n.active and n.sort > p.sort order by n.sort limit 1)),
    'queue', coalesce((select json_agg(json_build_object('stage_id', s.id, 'status', s.status, 'post_id', s.post_id, 'post_name', s.name,
        'rule', p.rule,
        'scanned', (select coalesce(sum(n), 0) from stage_scans x where x.stage_id = s.id),
        'queued_at', s.queued_at, 'accepted_at', s.accepted_at,
        'accepted_by', (select coalesce(m.name, user_contact(s.accepted_by) ->> 'full_name') from production_members m where m.user_id = s.accepted_by and m.production_id = o.production_id),
        'accepted_me', s.accepted_by = auth.uid(),
        'order_id', o.id, 'order_number', o.order_number, 'order_name', o.order_name, 'material_name', o.material_name,
        'client_name', user_contact(o.user_id) ->> 'full_name',
        'production_id', o.production_id, 'gcode_at', o.gcode_at, 'files_saved_at', o.files_saved_at,
        'sheets', order_sheet_count(o.nesting_result),
        'parts', (select coalesce(sum(d.qty), 0) from order_details d where d.order_id = o.id),
        'next_post', (select n.name from order_stages n where n.order_id = s.order_id and n.status = 'waiting' order by n.sort limit 1))
      order by s.status desc, s.queued_at)
      from order_stages s join orders o on o.id = s.order_id
      where s.post_id = p.id and s.status in ('queued', 'accepted')), '[]'::json));
end $$;

revoke all on function public.post_page(uuid) from public, anon;
grant execute on function public.post_page(uuid) to authenticated;
notify pgrst, 'reload schema';
