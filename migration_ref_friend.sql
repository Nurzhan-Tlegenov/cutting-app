-- «Пригласить знакомого» (/r/<код>, kind = 'friend') — ссылка есть у ЛЮБОГО пользователя: клиента, производства, сотрудника.
-- По ней человек регистрируется клиентом без одобрения мастер-аккаунта, только подтверждает номер (Telegram / WhatsApp).
-- Производство у нового клиента заранее не выбирается; если у пригласившего есть своё производство или он режет
-- на каком-то производстве — оно только подсказывается (выбрать или нет — решает сам клиент).
-- Блокировка номеров (blocked_phones) действует и здесь — она на триггерах заявок и аккаунтов.
-- Выполнить в Supabase → SQL Editor целиком (можно повторно). После migration_ref_links.sql.

-- 1. новый вид ссылки
do $$
declare c record;
begin
  for c in select conname from pg_constraint
           where conrelid = 'public.ref_codes'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%kind%'
  loop
    execute format('alter table public.ref_codes drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.ref_codes add constraint ref_codes_kind_check check (kind in ('client', 'production', 'friend'));

-- 2. действующая ссылка: для «клиентов» — производство владельца подтверждено; «производство» и «знакомый» — всегда
create or replace function public.ref_get(p_code text) returns public.ref_codes
language sql security definer set search_path = public stable as $$
  select c.* from ref_codes c
  where c.code = lower(trim(coalesce(p_code, '')))
    and (c.kind <> 'client' or exists (select 1 from productions p where p.id = c.production_id and p.status = 'approved'))
$$;

-- 3. моя ссылка: 'client' — только у владельца подтверждённого производства; 'friend' и 'production' — у всех
create or replace function public.my_ref_code(p_kind text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare k text := case when p_kind in ('client', 'friend') then p_kind else 'production' end; c text; pid uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if k = 'client' then
    select id into pid from productions where owner_id = auth.uid() and status = 'approved';
    if pid is null then raise exception 'no production'; end if;
  end if;
  select code into c from ref_codes where owner_id = auth.uid() and kind = k;
  if c is null then
    insert into ref_codes (code, owner_id, kind, production_id)
      values (encode(gen_random_bytes(5), 'hex'), auth.uid(), k, pid)
      returning code into c;
  elsif pid is not null then
    update ref_codes set production_id = pid where code = c;
  end if;
  return c;
end $$;

-- производство-подсказка от пригласившего: своё подтверждённое, иначе то, где он режет последним
create or replace function public.ref_hint_production(p_user uuid) returns uuid
language sql security definer set search_path = public stable as $$
  select coalesce(
    (select id from productions where owner_id = p_user and status = 'approved' limit 1),
    (select p.id from user_settings s join productions p on p.id::text = s.data ->> 'lastProductionId'
      where s.user_id = p_user and p.status = 'approved' limit 1))
$$;

-- 4. что за ссылка (страница /r/<код>, открывается и без входа)
-- -> { kind, code, inviter, production_id, production_name, production_city, hint_production_id, hint_production_name, hint_production_city } | null
create or replace function public.ref_info(p_code text) returns json
language plpgsql security definer set search_path = public stable as $$
declare c ref_codes := ref_get(p_code); h uuid;
begin
  if c.code is null then return null; end if;
  if c.kind = 'friend' then h := ref_hint_production(c.owner_id); end if;
  return json_build_object('kind', c.kind, 'code', c.code,
    'inviter', (select nullif(trim(full_name), '') from profiles where id = c.owner_id),
    'production_id', c.production_id,
    'production_name', (select name from productions where id = c.production_id),
    'production_city', (select city from productions where id = c.production_id),
    'hint_production_id', h,
    'hint_production_name', (select name from productions where id = h),
    'hint_production_city', (select city from productions where id = h));
end $$;

-- 5. пригласившему: кто пришёл по его ссылкам (+ сколько зарегистрировалось по каждому виду ссылки)
-- -> { pending: [...], registered: N, by_kind: { client: N, production: N, friend: N } }
create or replace function public.my_ref_people() returns json
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  return (
    with reg as (
      select (select kind from ref_codes where code = r.ref_code) as kind
      from signup_requests r where r.ref_by = auth.uid() and phone_registered(r.digits)
      union all
      select a.kind from ref_accepts a
      where a.ref_by = auth.uid()
        and not exists (select 1 from signup_requests r where r.ref_by = auth.uid()
                          and r.digits = norm_phone(split_part((select email from auth.users where id = a.user_id), '@', 1)))
    )
    select json_build_object(
      'pending', (select coalesce(json_agg(x order by x.created_at desc), '[]'::json) from (
        select r.id, r.full_name, r.phone, r.digits, r.messenger, r.created_at, r.code_sent_at,
          (r.phone_verified_at is not null) as verified,
          case when r.code_expires > now() and r.code_attempts < 5 then r.code end as code,
          (select kind from ref_codes where code = r.ref_code) as kind
        from signup_requests r
        where r.ref_by = auth.uid() and r.status = 'approved' and r.created_at > now() - interval '30 days'
          and not phone_registered(r.digits)) x),
      'registered', (select count(*) from reg),
      'by_kind', (select coalesce(json_object_agg(k, n), '{}'::json) from (
        select coalesce(kind, 'client') as k, count(*) as n from reg group by 1) y)));
end $$;

-- 6. мастер-аккаунт: кто кого пригласил (для карточки пользователя). -> [{ user_id, ref_by, ref_by_name, kind, at }]
create or replace function public.admin_ref_by() returns json
language plpgsql security definer set search_path = public stable as $$
begin
  if not is_admin() then return null; end if;
  return (select coalesce(json_agg(x), '[]'::json) from (
    select distinct on (u.id) u.id as user_id, s.ref_by, s.kind, s.at,
      coalesce(nullif(trim(p.full_name), ''), 'пользователь') as ref_by_name
    from auth.users u
    join lateral (
      select r.ref_by, (select kind from ref_codes where code = r.ref_code) as kind, r.created_at as at, 1 as pri
        from signup_requests r
        where r.ref_by is not null and r.digits = norm_phone(split_part(u.email, '@', 1))
      union all
      select a.ref_by, a.kind, a.created_at, 2 from ref_accepts a where a.user_id = u.id and a.ref_by is not null
    ) s on true
    left join profiles p on p.id = s.ref_by
    order by u.id, s.pri, s.at) x);
end $$;

revoke all on function public.ref_get(text), public.my_ref_code(text), public.ref_info(text), public.ref_hint_production(uuid),
  public.my_ref_people(), public.admin_ref_by() from public, anon, authenticated;
grant execute on function public.ref_info(text) to anon, authenticated;
grant execute on function public.my_ref_code(text), public.my_ref_people(), public.admin_ref_by() to authenticated;

notify pgrst, 'reload schema';
