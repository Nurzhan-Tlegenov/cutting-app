-- «📦 Пакет для разработчика» и заказы из обращения (этап 5, claude/support-spec.md). После migration_support_notes.sql.
-- Выполнить в Supabase → SQL Editor целиком (можно повторно).
--   • заказы обращения: те, что приложены к сообщениям (order_id), и те, чей номер (вида 261104_001) встречается в тексте —
--     только заказы автора или заказы, пришедшие на его производство;
--   • поддержка видит такие заказы на просмотр (без правки) — функцией, а не правилами доступа к orders;
--   • пакет (с моделью заказа и файлами) — мастер-аккаунт; сотрудникам — если мастер включил «Сотрудники могут скачивать пакет».
-- Правила на orders, order_details, profiles, app_messages НЕ меняются.

insert into public.app_config (key, value) values ('support_staff_pack', 'false'::jsonb) on conflict (key) do nothing;

-- может ли текущий пользователь скачивать пакет
create or replace function public.support_pack_allowed() returns boolean
language sql security definer set search_path = public stable as $$
  select is_admin() or (is_support() and coalesce((select value = 'true'::jsonb from app_config where key = 'support_staff_pack'), false))
$$;

-- настройки поддержки -> { staff_pack, pack_allowed }
create or replace function public.support_config() returns json
language plpgsql security definer set search_path = public stable as $$
begin
  if not is_support() then raise exception 'not support'; end if;
  return json_build_object('staff_pack', coalesce((select value = 'true'::jsonb from app_config where key = 'support_staff_pack'), false),
    'pack_allowed', support_pack_allowed());
end $$;

create or replace function public.admin_set_support_pack(p_on boolean) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'not admin'; end if;
  insert into app_config (key, value) values ('support_staff_pack', to_jsonb(coalesce(p_on, false)))
    on conflict (key) do update set value = excluded.value;
  return coalesce(p_on, false);
end $$;

-- заказы, на которые ссылается обращение
create or replace function public.support_card_order_ids(p_card uuid) returns setof uuid
language sql security definer set search_path = public stable as $$
  with c as (select * from support_cards where id = p_card),
  msgs as (select m.* from app_messages m join support_card_msgs l on l.message_id = m.id where l.card_id = p_card),
  nums as (select distinct x[1] as num from msgs, regexp_matches(coalesce(msgs.body, '') || ' ' || coalesce(msgs.title, ''), '(\d{6}_\d{3})', 'g') as x)
  select distinct o.id from orders o, c
  where (o.id in (select order_id from msgs where order_id is not null)
         or o.order_number in (select num from nums))
    and (o.user_id = c.user_id or o.production_id in (select id from productions where owner_id = c.user_id))
$$;

-- список заказов обращения -> [{ id, order_number, order_name, material_name, status, created_at, details, own }]
create or replace function public.support_card_orders(p_card uuid) returns json
language plpgsql security definer set search_path = public stable as $$
declare uid uuid;
begin
  if not is_support() then raise exception 'not support'; end if;
  select user_id into uid from support_cards where id = p_card;
  return (select coalesce(json_agg(x order by x.created_at desc), '[]'::json) from (
    select o.id, o.order_number, o.order_name, o.material_name, o.status, o.created_at, (o.user_id = uid) as own,
      (select count(*) from order_details d where d.order_id = o.id) as details
    from orders o where o.id in (select support_card_order_ids(p_card))) x);
end $$;

-- заказ обращения на просмотр: заказ и детали; p_full — ещё модель и выпуски программ (только для пакета)
-- -> { order, details, runs, model }
create or replace function public.support_order_data(p_card uuid, p_order uuid, p_full boolean default false) returns json
language plpgsql security definer set search_path = public stable as $$
begin
  if not is_support() then raise exception 'not support'; end if;
  if p_full and not support_pack_allowed() then raise exception 'not allowed'; end if;
  if p_order not in (select support_card_order_ids(p_card)) then raise exception 'not allowed'; end if;
  return json_build_object(
    'order', (select row_to_json(o) from orders o where o.id = p_order),
    'details', (select coalesce(json_agg(row_to_json(d) order by d.sort_order, d.created_at), '[]'::json) from order_details d where d.order_id = p_order),
    'runs', case when p_full then (select coalesce(json_agg(json_build_object('at', u.created_at, 'post', u.post_name, 'kind', u.kind, 'sheets', u.sheets) order by u.created_at), '[]'::json)
                                     from post_usage u where u.order_id = p_order) end,
    'model', case when p_full then (select m.data from order_models m where m.order_id = p_order and length(m.data) < 30000000) end);
exception when undefined_table then
  return json_build_object('order', (select row_to_json(o) from orders o where o.id = p_order),
    'details', (select coalesce(json_agg(row_to_json(d)), '[]'::json) from order_details d where d.order_id = p_order));
end $$;

revoke all on function public.support_pack_allowed(), public.support_config(), public.admin_set_support_pack(boolean),
  public.support_card_order_ids(uuid), public.support_card_orders(uuid), public.support_order_data(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.support_config(), public.admin_set_support_pack(boolean), public.support_card_orders(uuid),
  public.support_order_data(uuid, uuid, boolean) to authenticated;

notify pgrst, 'reload schema';
