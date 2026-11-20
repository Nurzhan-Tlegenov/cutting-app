-- Срок у личных лимитов: мастер поднял пользователю лимит (или снял все) до даты — с этой даты у него снова
-- общие лимиты, как у всех. Ничего по расписанию не запускается: срок проверяется при каждой проверке лимита.
-- Выполнить один раз в Supabase → SQL Editor (можно повторно). После migration_limits.sql.

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
notify pgrst, 'reload schema';
