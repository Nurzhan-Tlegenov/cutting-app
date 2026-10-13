-- Защита от самопропуска постов. Выполнить один раз в Supabase → SQL Editor (можно повторно). После migration_stage_fix.sql.
--
-- Что было: у сотрудника на телефоне оставалась старая версия приложения (из памяти телефона). Она не видела детали
-- заказа и «пропускала» кромление и присадку как ненужные — заказ сам улетал в «Исполнен», сотрудник успевал только
-- нажать «Принять». Теперь база сама проверяет пропуск:
--   • старая версия приложения пропускать посты больше не может (прежняя функция удалена);
--   • новая передаёт, сколько деталей она видела, — не совпало с базой, ничего не пропускается;
--   • пост «Без списка деталей» не пропускается никогда — только «Принять» → «Выполнено» или перенос заказа;
--   • пост кромления не пропускается, если у заказа есть хоть одна деталь с кромкой.
-- И заказ 261012_006 («261010 Тимур») снова возвращается на кромление.

drop function if exists public.stage_auto_skip(uuid, uuid[]);

create or replace function public.stage_auto_skip_v2(p_order uuid, p_posts uuid[], p_seen integer) returns integer
language plpgsql security definer set search_path = public as $$
declare o record; n int := 0; was_active boolean := false; real_n int; edged boolean; ok uuid[];
begin
  select * into o from orders where id = p_order;
  if not found or o.status <> 'inwork' or not (is_admin() or is_my_production(o.production_id) or member_can(o.production_id, null)) then return 0; end if;
  select count(*) into real_n from order_details where order_id = p_order;
  if real_n = 0 or coalesce(p_seen, 0) <> real_n then return 0; end if;           -- приложение видело не все детали
  select exists (select 1 from order_details d where d.order_id = p_order and (
    coalesce(d.edge_left::text, '') not in ('', 'null', 'false') or coalesce(d.edge_right::text, '') not in ('', 'null', 'false')
    or coalesce(d.edge_top::text, '') not in ('', 'null', 'false') or coalesce(d.edge_bottom::text, '') not in ('', 'null', 'false'))) into edged;
  -- какие посты можно пропустить: не «без списка деталей»; кромление — только когда кромки нет
  select array_agg(p.id) into ok from production_posts p
    where p.id = any(p_posts)
      and coalesce(p.rule ->> 'list', case when p.name ~* 'кром' then 'edge' when p.name ~* '(присад|сверл)' then 'drill' else 'all' end) in ('edge', 'drill')
      and not (coalesce(p.rule ->> 'list', case when p.name ~* 'кром' then 'edge' else '' end) = 'edge' and edged);
  if ok is null then return 0; end if;
  select exists (select 1 from order_stages s where s.order_id = p_order and s.post_id = any(ok) and s.status = 'queued'
                   and not exists (select 1 from stage_scans x where x.stage_id = s.id)) into was_active;
  update order_stages s set status = 'skipped', done_at = now()
    where s.order_id = p_order and s.post_id = any(ok) and s.status in ('waiting', 'queued')
      and not exists (select 1 from stage_scans x where x.stage_id = s.id);
  get diagnostics n = row_count;
  if was_active and not exists (select 1 from order_stages where order_id = p_order and status in ('queued', 'accepted')) then
    perform advance_stage(p_order);
  end if;
  return n;
end $$;
revoke all on function public.stage_auto_skip_v2(uuid, uuid[], integer) from public, anon;
grant execute on function public.stage_auto_skip_v2(uuid, uuid[], integer) to authenticated;

-- заказ 261012_006 — снова на кромление
do $$
declare oid uuid := 'ef2f878f-a078-4edf-9d18-ffda3518f473'; k order_stages; t timestamptz;
begin
  select * into k from order_stages where order_id = oid and name ilike 'кром%' order by sort limit 1;
  if k.id is null then raise notice 'У заказа нет поста кромления'; return; end if;
  t := coalesce(k.queued_at, k.done_at, now()) - interval '1 minute';
  update order_stages set status = 'waiting', done_at = null, done_by = null
    where order_id = oid and sort > k.sort and status = 'skipped' and done_at >= t;
  update order_stages set status = 'queued', queued_at = now(), accepted_at = null, accepted_by = null, done_at = null, done_by = null where id = k.id;
  update orders set status = 'inwork', done_at = null, prod_archived_at = null where id = oid;
  raise notice 'Готово: заказ на посту «%»', k.name;
end $$;
notify pgrst, 'reload schema';
