-- Общие лимиты с даты: мастер вписывает новые пороги и день, с которого они действуют; до этого дня — прежние.
-- Ничего по расписанию не запускается: дата сверяется при каждой проверке лимита.
-- Выполнить один раз в Supabase → SQL Editor (можно повторно). После migration_limits_timer.sql.

-- общие пороги, действующие сейчас: запланированные — с их дня, иначе текущие
create or replace function public.eff_default_limits() returns jsonb
language sql security definer set search_path = public stable as $$
  select case when n.value ? 'at' and (n.value ->> 'at')::timestamptz <= now() then n.value -> 'limits'
    else coalesce((select value from app_config where key = 'limits'), '{}'::jsonb) end
  from (select (select value from app_config where key = 'limits_next') as value) n
$$;

create or replace function public.limit_of(p_user uuid, p_key text) returns integer
language plpgsql security definer set search_path = public stable as $$
declare u record; v jsonb;
begin
  if p_user is null or exists (select 1 from profiles where id = p_user and role = 'admin') then return null; end if;
  select * into u from user_limits where user_id = p_user and (expires_at is null or expires_at > now());
  if found and u.unlimited then return null; end if;
  if found and u.limits ? p_key then v := u.limits -> p_key;
  else v := eff_default_limits() -> p_key; end if;
  if v is null or jsonb_typeof(v) <> 'number' then return null; end if;
  return greatest(0, floor((v)::text::numeric))::integer;
end $$;

-- «старое» (доделывается без лимита) — и то, что заведено до дня новых общих лимитов
create or replace function public.limit_grace(p_user uuid) returns timestamptz
language sql security definer set search_path = public stable as $$
  select nullif(greatest(
    coalesce((select expires_at from user_limits where user_id = p_user and expires_at <= now()), '-infinity'::timestamptz),
    coalesce((select (value #>> '{}')::timestamptz from app_config where key = 'limits_at'), '-infinity'::timestamptz),
    coalesce((select (value ->> 'at')::timestamptz from app_config where key = 'limits_next' and (value ->> 'at')::timestamptz <= now()), '-infinity'::timestamptz)),
    '-infinity'::timestamptz)
$$;

create or replace function public.admin_limits() returns json
language plpgsql security definer set search_path = public stable as $$
declare n jsonb := (select value from app_config where key = 'limits_next');
begin
  if not is_admin() then raise exception 'not admin'; end if;
  return json_build_object(
    'defaults', eff_default_limits(),
    'next', case when n ? 'at' and (n ->> 'at')::timestamptz > now() then n else null end,
    'users', coalesce((select json_agg(json_build_object('user_id', p.id, 'unlimited', coalesce(u.unlimited, false), 'limits', coalesce(u.limits, '{}'::jsonb),
        'expires_at', u.expires_at, 'expired', coalesce(u.expires_at <= now(), false),
        'used', json_build_object('orders', usage_of(p.id, 'orders'), 'models', usage_of(p.id, 'models'), 'materials', usage_of(p.id, 'materials'), 'accepted', usage_of(p.id, 'accepted'), 'views3d', usage_of(p.id, 'views3d'))))
      from profiles p left join user_limits u on u.user_id = p.id), '[]'::json));
end $$;

-- общие лимиты: p_at — с какого момента (null или прошедший — сразу). Сразу — запланированное отменяется
create or replace function public.admin_set_default_limits2(p_limits jsonb, p_at timestamptz) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'not admin'; end if;
  if p_at is not null and p_at > now() then
    -- прежде чем планировать, закрепить уже наступившее запланированное как текущее
    insert into app_config (key, value) values ('limits', eff_default_limits()) on conflict (key) do update set value = excluded.value;
    insert into app_config (key, value) values ('limits_next', jsonb_build_object('limits', coalesce(p_limits, '{}'::jsonb), 'at', p_at))
      on conflict (key) do update set value = excluded.value;
  else
    insert into app_config (key, value) values ('limits', coalesce(p_limits, '{}'::jsonb)) on conflict (key) do update set value = excluded.value;
    insert into app_config (key, value) values ('limits_at', to_jsonb(now())) on conflict (key) do update set value = excluded.value;
    delete from app_config where key = 'limits_next';
  end if;
end $$;

-- отменить запланированные общие лимиты (ещё не наступившие)
create or replace function public.admin_cancel_next_limits() returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'not admin'; end if;
  delete from app_config where key = 'limits_next' and (value ->> 'at')::timestamptz > now();
end $$;

revoke all on function public.eff_default_limits() from public, anon, authenticated;
revoke all on function public.admin_set_default_limits2(jsonb, timestamptz), public.admin_cancel_next_limits() from public, anon;
grant execute on function public.admin_set_default_limits2(jsonb, timestamptz), public.admin_cancel_next_limits() to authenticated;
notify pgrst, 'reload schema';
