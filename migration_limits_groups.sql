-- Две группы общих лимитов:
--   client — аккаунты без производства (только клиенты): app_config.limits / limits_next
--   prod   — аккаунты, у которых есть своё производство: app_config.limits_prod / limits_prod_next — и как клиент
--            (заказы, модели, материалы), и как производство (принятые заказы, 3D)
-- Пока для prod ничего не сохранено — у них общие лимиты клиентов, как раньше.
-- Выполнить один раз в Supabase → SQL Editor (можно повторно). После migration_limits_schedule.sql.

create or replace function public.limits_group(p_user uuid) returns text
language sql security definer set search_path = public stable as $$
  select case when exists (select 1 from productions where owner_id = p_user) then 'prod' else 'client' end
$$;

-- общие пороги группы, действующие сейчас: запланированные — с их дня, иначе текущие
create or replace function public.eff_default_limits(p_group text) returns jsonb
language plpgsql security definer set search_path = public stable as $$
declare k text := case when p_group = 'prod' then 'limits_prod' else 'limits' end; cur jsonb; n jsonb;
begin
  select value into cur from app_config where key = k;
  select value into n from app_config where key = k || '_next';
  if n ? 'at' and (n ->> 'at')::timestamptz <= now() then return n -> 'limits'; end if;
  if cur is null and p_group = 'prod' then return eff_default_limits('client'); end if;
  return coalesce(cur, '{}'::jsonb);
end $$;
create or replace function public.eff_default_limits() returns jsonb
language sql security definer set search_path = public stable as $$ select eff_default_limits('client') $$;

create or replace function public.limit_of(p_user uuid, p_key text) returns integer
language plpgsql security definer set search_path = public stable as $$
declare u record; v jsonb;
begin
  if p_user is null or exists (select 1 from profiles where id = p_user and role = 'admin') then return null; end if;
  select * into u from user_limits where user_id = p_user and (expires_at is null or expires_at > now());
  if found and u.unlimited then return null; end if;
  if found and u.limits ? p_key then v := u.limits -> p_key;
  else v := eff_default_limits(limits_group(p_user)) -> p_key; end if;
  if v is null or jsonb_typeof(v) <> 'number' then return null; end if;
  return greatest(0, floor((v)::text::numeric))::integer;
end $$;

-- «старое» (доделывается без лимита): до конца поднятого лимита / до дня новых общих лимитов своей группы
create or replace function public.limit_grace(p_user uuid) returns timestamptz
language sql security definer set search_path = public stable as $$
  select nullif(greatest(
    coalesce((select expires_at from user_limits where user_id = p_user and expires_at <= now()), '-infinity'::timestamptz),
    coalesce((select (value #>> '{}')::timestamptz from app_config where key = 'limits_at'), '-infinity'::timestamptz),
    coalesce((select (value ->> 'at')::timestamptz from app_config
      where key = case when limits_group(p_user) = 'prod' then 'limits_prod_next' else 'limits_next' end
        and (value ->> 'at')::timestamptz <= now()), '-infinity'::timestamptz)),
    '-infinity'::timestamptz)
$$;

create or replace function public.admin_limits() returns json
language plpgsql security definer set search_path = public stable as $$
declare n jsonb := (select value from app_config where key = 'limits_next');
  np jsonb := (select value from app_config where key = 'limits_prod_next');
begin
  if not is_admin() then raise exception 'not admin'; end if;
  return json_build_object(
    'defaults', eff_default_limits('client'),
    'next', case when n ? 'at' and (n ->> 'at')::timestamptz > now() then n else null end,
    'defaults_prod', eff_default_limits('prod'),
    'next_prod', case when np ? 'at' and (np ->> 'at')::timestamptz > now() then np else null end,
    'prod_own', exists (select 1 from app_config where key in ('limits_prod', 'limits_prod_next')),
    'users', coalesce((select json_agg(json_build_object('user_id', p.id, 'unlimited', coalesce(u.unlimited, false), 'limits', coalesce(u.limits, '{}'::jsonb),
        'expires_at', u.expires_at, 'expired', coalesce(u.expires_at <= now(), false), 'group', limits_group(p.id),
        'used', json_build_object('orders', usage_of(p.id, 'orders'), 'models', usage_of(p.id, 'models'), 'materials', usage_of(p.id, 'materials'), 'accepted', usage_of(p.id, 'accepted'), 'views3d', usage_of(p.id, 'views3d'))))
      from profiles p left join user_limits u on u.user_id = p.id), '[]'::json));
end $$;

-- общие лимиты группы: p_at — с какого момента (null или прошедший — сразу; запланированное тогда отменяется)
create or replace function public.admin_set_group_limits(p_group text, p_limits jsonb, p_at timestamptz) returns void
language plpgsql security definer set search_path = public as $$
declare k text := case when p_group = 'prod' then 'limits_prod' else 'limits' end;
begin
  if not is_admin() then raise exception 'not admin'; end if;
  if p_at is not null and p_at > now() then
    insert into app_config (key, value) values (k, eff_default_limits(p_group)) on conflict (key) do update set value = excluded.value;
    insert into app_config (key, value) values (k || '_next', jsonb_build_object('limits', coalesce(p_limits, '{}'::jsonb), 'at', p_at))
      on conflict (key) do update set value = excluded.value;
  else
    insert into app_config (key, value) values (k, coalesce(p_limits, '{}'::jsonb)) on conflict (key) do update set value = excluded.value;
    insert into app_config (key, value) values ('limits_at', to_jsonb(now())) on conflict (key) do update set value = excluded.value;
    delete from app_config where key = k || '_next';
  end if;
end $$;

create or replace function public.admin_cancel_group_next(p_group text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'not admin'; end if;
  delete from app_config where key = case when p_group = 'prod' then 'limits_prod_next' else 'limits_next' end
    and (value ->> 'at')::timestamptz > now();
end $$;

-- срок тем, кому подняты лимиты, — в одной группе (p_group null — всем). -> сколько пользователей
create or replace function public.admin_limits_expire_group(p_at timestamptz, p_group text) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not is_admin() then raise exception 'not admin'; end if;
  update user_limits set expires_at = p_at, updated_at = now()
    where (unlimited or limits <> '{}'::jsonb) and (expires_at is null or expires_at > now())
      and (p_group is null or limits_group(user_id) = p_group);
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.limits_group(uuid), public.eff_default_limits(text) from public, anon, authenticated;
revoke all on function public.admin_set_group_limits(text, jsonb, timestamptz), public.admin_cancel_group_next(text), public.admin_limits_expire_group(timestamptz, text) from public, anon;
grant execute on function public.admin_set_group_limits(text, jsonb, timestamptz), public.admin_cancel_group_next(text), public.admin_limits_expire_group(timestamptz, text) to authenticated;
notify pgrst, 'reload schema';
