-- Тестовые заказы: время прохождения всех этапов задаёт мастер-аккаунт (по умолчанию 60 минут).
-- Выполнить один раз в Supabase → SQL Editor (можно повторно). После migration_stats_test.sql.
-- Мастер-аккаунт убирает из итогов любой заказ; производство — только прошедший быстрее заданного времени,
-- остальные — через обращение к мастеру.

insert into public.app_config (key, value) values ('test_order_minutes', '60'::jsonb) on conflict (key) do nothing;

create or replace function public.test_order_minutes() returns int
language sql security definer set search_path = public stable as $$
  select coalesce((select (value #>> '{}')::int from app_config where key = 'test_order_minutes'), 60)
$$;

create or replace function public.admin_set_test_minutes(p_min int) returns int
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'not admin'; end if;
  if p_min is null or p_min < 1 or p_min > 10080 then raise exception 'bad minutes'; end if;
  insert into app_config (key, value) values ('test_order_minutes', to_jsonb(p_min)) on conflict (key) do update set value = excluded.value;
  return p_min;
end $$;

create or replace function public.production_exclude_stats(p_order uuid, p_on boolean default true) returns boolean
language plpgsql security definer set search_path = public as $$
declare pr uuid; t0 timestamptz; t1 timestamptz; st text;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select o.production_id, coalesce(o.accepted_at, o.submitted_at), o.done_at, o.status into pr, t0, t1, st from orders o where o.id = p_order;
  if pr is null then
    select h.production_id, coalesce(h.accepted_at, h.submitted_at), h.done_at, coalesce(h.status, 'done') into pr, t0, t1, st from order_history h where h.order_id = p_order;
  end if;
  if pr is null then raise exception 'not found'; end if;
  if not (is_admin() or exists (select 1 from productions where id = pr and owner_id = auth.uid())) then raise exception 'not allowed'; end if;
  if not p_on then delete from stats_excluded where order_id = p_order; return false; end if;
  if not is_admin() and (st <> 'done' or t0 is null or t1 is null or t1 - t0 > make_interval(mins => test_order_minutes())) then raise exception 'not a fast order'; end if;
  insert into stats_excluded (order_id, production_id, excluded_by) values (p_order, pr, auth.uid()) on conflict (order_id) do nothing;
  return true;
end $$;

revoke all on function public.test_order_minutes(), public.admin_set_test_minutes(int), public.production_exclude_stats(uuid, boolean) from public, anon;
grant execute on function public.test_order_minutes(), public.admin_set_test_minutes(int), public.production_exclude_stats(uuid, boolean) to authenticated;
notify pgrst, 'reload schema';
