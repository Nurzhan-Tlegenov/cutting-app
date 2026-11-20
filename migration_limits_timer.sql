-- Срок у личных лимитов: мастер поднял пользователю лимит (или снял все) до даты — с этой даты у него снова
-- общие лимиты, как у всех. Ничего по расписанию не запускается: срок проверяется при каждой проверке лимита.
-- Выполнить один раз в Supabase → SQL Editor (можно повторно). После migration_limits.sql.
--
-- Ничего не пропадает: лимит не трогает то, что уже есть, — только не даёт завести новое. Всё, что заведено до
-- окончания поднятого лимита (или до того, как мастер понизил общие лимиты), доделывается без ограничений:
-- 3D-модель к такому заказу, отправка его по материалам, приём производством, просмотр 3D-модели в работе.

alter table public.user_limits add column if not exists expires_at timestamptz;

-- порог для пользователя: null — без лимита. Личные настройки — только пока не истёк срок
create or replace function public.limit_of(p_user uuid, p_key text) returns integer
language plpgsql security definer set search_path = public stable as $$
declare u record; v jsonb;
begin
  if p_user is null or exists (select 1 from profiles where id = p_user and role = 'admin') then return null; end if;
  select * into u from user_limits where user_id = p_user and (expires_at is null or expires_at > now());
  if found and u.unlimited then return null; end if;
  if found and u.limits ? p_key then v := u.limits -> p_key;
  else v := (select value -> p_key from app_config where key = 'limits'); end if;
  if v is null or jsonb_typeof(v) <> 'number' then return null; end if;
  return greatest(0, floor((v)::text::numeric))::integer;
end $$;

-- мои лимиты (+ until — до какого числа действуют поднятые мне лимиты)
create or replace function public.my_limits() returns json
language plpgsql security definer set search_path = public stable as $$
declare k text; res jsonb := '{}'::jsonb; u record;
begin
  foreach k in array array['orders', 'models', 'materials', 'accepted', 'views3d', 'import_mats'] loop
    res := res || jsonb_build_object(k, jsonb_build_object('limit', limit_of(auth.uid(), k), 'used', usage_of(auth.uid(), k)));
  end loop;
  select * into u from user_limits where user_id = auth.uid() and (expires_at is null or expires_at > now()) and (unlimited or limits <> '{}'::jsonb);
  return json_build_object('limits', res, 'master', is_admin(),
    'unlimited', coalesce(u.unlimited, false), 'until', u.expires_at);
end $$;

create or replace function public.admin_limits() returns json
language plpgsql security definer set search_path = public stable as $$
begin
  if not is_admin() then raise exception 'not admin'; end if;
  return json_build_object(
    'defaults', (select value from app_config where key = 'limits'),
    'users', coalesce((select json_agg(json_build_object('user_id', p.id, 'unlimited', coalesce(u.unlimited, false), 'limits', coalesce(u.limits, '{}'::jsonb),
        'expires_at', u.expires_at, 'expired', coalesce(u.expires_at <= now(), false),
        'used', json_build_object('orders', usage_of(p.id, 'orders'), 'models', usage_of(p.id, 'models'), 'materials', usage_of(p.id, 'materials'), 'accepted', usage_of(p.id, 'accepted'), 'views3d', usage_of(p.id, 'views3d'))))
      from profiles p left join user_limits u on u.user_id = p.id), '[]'::json));
end $$;

-- личные лимиты со сроком: p_expires — до какого момента (null — бессрочно)
create or replace function public.admin_set_user_limits2(p_user uuid, p_unlimited boolean, p_limits jsonb, p_expires timestamptz) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'not admin'; end if;
  insert into user_limits (user_id, unlimited, limits, expires_at, updated_at)
    values (p_user, coalesce(p_unlimited, false), coalesce(p_limits, '{}'::jsonb), p_expires, now())
  on conflict (user_id) do update set unlimited = excluded.unlimited, limits = excluded.limits, expires_at = excluded.expires_at, updated_at = now();
end $$;

-- срок всем, у кого сейчас подняты лимиты (или сняты все). -> сколько пользователей
create or replace function public.admin_limits_expire_all(p_at timestamptz) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not is_admin() then raise exception 'not admin'; end if;
  update user_limits set expires_at = p_at, updated_at = now()
    where (unlimited or limits <> '{}'::jsonb) and (expires_at is null or expires_at > now());
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.admin_set_user_limits2(uuid, boolean, jsonb, timestamptz), public.admin_limits_expire_all(timestamptz) from public, anon;
grant execute on function public.admin_set_user_limits2(uuid, boolean, jsonb, timestamptz), public.admin_limits_expire_all(timestamptz) to authenticated;

-- ── доделать начатое ──
-- заказ, отправленный по материалам, делится на части — это тот же заказ, а не новый
alter table public.orders add column if not exists split_of uuid;
insert into public.app_config (key, value) values ('limits_at', to_jsonb(now())) on conflict (key) do nothing;

-- до какого момента у пользователя «старое» (доделывается без лимита): конец его поднятого лимита или
-- последнее изменение общих лимитов мастером — что позже. null — ничего такого не было
create or replace function public.limit_grace(p_user uuid) returns timestamptz
language sql security definer set search_path = public stable as $$
  select nullif(greatest(
    coalesce((select expires_at from user_limits where user_id = p_user and expires_at <= now()), '-infinity'::timestamptz),
    coalesce((select (value #>> '{}')::timestamptz from app_config where key = 'limits_at'), '-infinity'::timestamptz)), '-infinity'::timestamptz)
$$;

create or replace function public.admin_set_default_limits(p_limits jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'not admin'; end if;
  insert into app_config (key, value) values ('limits', coalesce(p_limits, '{}'::jsonb)) on conflict (key) do update set value = excluded.value;
  insert into app_config (key, value) values ('limits_at', to_jsonb(now())) on conflict (key) do update set value = excluded.value;
end $$;

create or replace function public.trg_limit_orders() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.split_of is not null and exists (select 1 from orders where id = new.split_of and user_id = new.user_id) then return new; end if;
  perform check_limit(new.user_id, 'orders');
  return new;
end $$;

create or replace function public.trg_limit_models() returns trigger
language plpgsql security definer set search_path = public as $$
declare o record;
begin
  if exists (select 1 from order_models where order_id = new.order_id) then return new; end if;
  select user_id, created_at into o from orders where id = new.order_id;
  if o.created_at < limit_grace(o.user_id) then return new; end if;
  perform check_limit(o.user_id, 'models');
  return new;
end $$;

-- принять заказ: повторно (после доработки) или пришедший до конца лимита — можно
create or replace function public.trg_limit_accept() returns trigger
language plpgsql security definer set search_path = public as $$
declare owner uuid;
begin
  if new.production_id is not null and new.status in ('inwork', 'done') and coalesce(old.status, '') not in ('inwork', 'done') and not is_admin() then
    if old.accepted_at is not null and old.production_id is not distinct from new.production_id then return new; end if;
    owner := (select owner_id from productions where id = new.production_id);
    if coalesce(old.submitted_at, old.created_at) < limit_grace(owner) then return new; end if;
    perform check_limit(owner, 'accepted');
  end if;
  return new;
end $$;

create or replace function public.open_order_model(p_order uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare o record;
begin
  select * into o from orders where id = p_order;
  if not found or o.user_id = auth.uid() or is_admin() or not is_my_production(o.production_id) then return true; end if;
  if exists (select 1 from production_model_views where user_id = auth.uid() and order_id = p_order) then return true; end if;
  if coalesce(o.accepted_at, o.submitted_at, o.created_at) < limit_grace(auth.uid()) then
    insert into production_model_views (user_id, order_id) values (auth.uid(), p_order) on conflict do nothing;
    return true;
  end if;
  perform check_limit(auth.uid(), 'views3d');
  insert into production_model_views (user_id, order_id) values (auth.uid(), p_order) on conflict do nothing;
  return true;
end $$;

revoke all on function public.limit_grace(uuid) from public, anon, authenticated;
notify pgrst, 'reload schema';
