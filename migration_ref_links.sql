-- Пригласительные ссылки «Поделиться» (/r/<код>) — регистрация БЕЗ одобрения мастер-аккаунта.
-- Выполнить в Supabase → SQL Editor целиком (можно повторно; после обновления этого файла — выполнить ещё раз). После migration_signup_resubmit.sql и migration_push.sql.
--
-- Как работает:
--   • производство делится ссылкой «для клиентов» — клиент по ней регистрируется без заявки мастеру, нужно только
--     подтвердить номер: Telegram — бот сразу присылает код; WhatsApp — код отправляет тот, кто пригласил (одним нажатием);
--     в раскрое у клиента сразу выбрано это производство;
--   • любой пользователь делится ссылкой «для производства» — приглашённый регистрируется так же, а его производство
--     подтверждается сразу (без мастера). Уже зарегистрированный по такой ссылке — тоже: его производство подтверждается;
--   • отклонённую мастером заявку ссылка не обходит; мастер видит, кто кого пригласил.

create extension if not exists pgcrypto with schema extensions;

-- личные ссылки: у каждого пользователя по одной на вид приглашения
create table if not exists public.ref_codes (
  code text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('client', 'production')),   -- кого приглашает: клиентов (от производства) или производство
  production_id uuid references public.productions(id) on delete cascade,   -- для kind = 'client': чьё производство
  created_at timestamptz default now(),
  unique (owner_id, kind)
);
alter table public.ref_codes enable row level security;   -- только через функции ниже

-- кто открыл ссылку, уже имея аккаунт (или после регистрации)
create table if not exists public.ref_accepts (
  user_id uuid references auth.users(id) on delete cascade,
  kind text not null,
  code text not null,
  ref_by uuid,
  created_at timestamptz default now(),
  primary key (user_id, kind)
);
alter table public.ref_accepts enable row level security;

alter table public.signup_requests add column if not exists ref_code text;
alter table public.signup_requests add column if not exists ref_by uuid;

-- действующая ссылка: владелец есть; для клиентской — производство владельца подтверждено
create or replace function public.ref_get(p_code text) returns public.ref_codes
language sql security definer set search_path = public stable as $$
  select c.* from ref_codes c
  where c.code = lower(trim(coalesce(p_code, '')))
    and (c.kind = 'production' or exists (select 1 from productions p where p.id = c.production_id and p.status = 'approved'))
$$;

-- ── Моя ссылка (создаётся при первом запросе). kind: 'client' — только у владельца подтверждённого производства
create or replace function public.my_ref_code(p_kind text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare k text := case when p_kind = 'client' then 'client' else 'production' end; c text; pid uuid;
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
  else
    update ref_codes set production_id = coalesce(pid, production_id) where code = c;
  end if;
  return c;
end $$;

-- ── Что за ссылка (для страницы /r/<код>, открывается и без входа)
-- -> { kind, inviter, production_id, production_name } | null
create or replace function public.ref_info(p_code text) returns json
language plpgsql security definer set search_path = public stable as $$
declare c ref_codes := ref_get(p_code);
begin
  if c.code is null then return null; end if;
  return json_build_object('kind', c.kind, 'code', c.code,
    'inviter', (select nullif(trim(full_name), '') from profiles where id = c.owner_id),
    'production_id', c.production_id,
    'production_name', (select name from productions where id = c.production_id),
    'production_city', (select city from productions where id = c.production_id));
end $$;

-- ── Заявка по ссылке: сразу одобрена, остаётся подтвердить номер. Возвращает то же, что request_signup2, плюс ref.
create or replace function public.request_signup_ref(p_name text, p_phone text, p_comment text default '', p_country text default '',
  p_city text default '', p_messenger text default 'telegram', p_ref text default '')
returns json language plpgsql security definer set search_path = public, extensions as $$
declare c ref_codes := ref_get(p_ref); d text := norm_phone(p_phone); r signup_requests; j jsonb; fresh boolean := false;
  m text := case when p_messenger in ('telegram', 'whatsapp') then p_messenger else 'telegram' end;
begin
  if c.code is null then   -- ссылка недействительна — обычная заявка
    return (request_signup2(p_name, p_phone, p_comment, p_country, p_city, p_messenger)::jsonb || '{"ref":"bad"}'::jsonb)::json;
  end if;
  if length(d) < 10 or length(d) > 15 then raise exception 'bad phone'; end if;
  if not phone_registered(d) then
    select * into r from signup_requests where digits = d for update;
    if not found then
      insert into signup_requests (phone, digits, full_name, comment, country, city, messenger, tg_token, status, ref_code, ref_by)
        values (left(trim(p_phone), 40), d, left(trim(coalesce(p_name, '')), 120), left(trim(coalesce(p_comment, '')), 500),
          nullif(left(trim(coalesce(p_country, '')), 60), ''), nullif(left(trim(coalesce(p_city, '')), 80), ''), m,
          case when m = 'telegram' then encode(gen_random_bytes(12), 'hex') end, 'approved', c.code, c.owner_id)
        returning * into r;
      fresh := true;
    elsif r.status = 'new' then   -- заявка ждала мастера — по ссылке одобряется сразу
      update signup_requests set status = 'approved', ref_code = c.code, ref_by = c.owner_id,
        full_name = coalesce(nullif(left(trim(p_name), 120), ''), full_name),
        country = coalesce(nullif(left(trim(p_country), 60), ''), country), city = coalesce(nullif(left(trim(p_city), 80), ''), city)
        where id = r.id returning * into r;
      fresh := true;
    elsif r.status = 'approved' and r.ref_code is null then
      update signup_requests set ref_code = c.code, ref_by = c.owner_id where id = r.id returning * into r;
    end if;
    -- код: Telegram-бот выдаст и пришлёт его сам, как только номер подтвердят; в WhatsApp его отправит пригласивший (ref_send_code).
    -- Номер подтвердили в боте ещё ДО одобрения, а код в Telegram так и не ушёл — подтверждение сбрасываем:
    -- человек ещё раз жмёт «Поделиться номером», и бот сразу присылает код (иначе код не придёт никогда).
    if r.status = 'approved' and m = 'telegram' and r.phone_verified_at is not null and r.code_sent_at is null then
      update signup_requests set phone_verified_at = null, tg_token = coalesce(tg_token, encode(gen_random_bytes(12), 'hex')) where id = r.id returning * into r;
    end if;
  end if;
  j := request_signup2(p_name, p_phone, p_comment, p_country, p_city, p_messenger)::jsonb;
  -- пригласившему — уведомление: человеку в WhatsApp нужен код
  if m = 'whatsapp' and r.id is not null and r.status = 'approved' and (fresh or r.code_sent_at is null) then
    begin
      perform push_enqueue(c.owner_id, 'Отправьте код в WhatsApp', trim(coalesce(nullif(trim(p_name), ''), '') || ' · +' || d) || ' — регистрация по вашей ссылке', '/invite', 'ref:' || r.id);
    exception when others then null;
    end;
  end if;
  return (j || jsonb_build_object('ref', 'ok', 'ref_kind', c.kind,
    'inviter', coalesce((select name from productions where id = c.production_id), (select full_name from profiles where id = c.owner_id))))::json;
end $$;

-- ── Открыл ссылку, уже имея аккаунт (или сразу после регистрации). -> { kind, production_id }
-- Ссылка «для производства»: своё производство, ждущее подтверждения, подтверждается сразу.
create or replace function public.accept_ref(p_code text) returns json
language plpgsql security definer set search_path = public as $$
declare c ref_codes := ref_get(p_code);
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if c.code is null then return json_build_object('error', 'bad'); end if;
  if c.owner_id = auth.uid() then return json_build_object('error', 'own', 'kind', c.kind); end if;
  insert into ref_accepts (user_id, kind, code, ref_by) values (auth.uid(), c.kind, c.code, c.owner_id)
    on conflict (user_id, kind) do nothing;
  if c.kind = 'production' then
    update productions set status = 'approved' where owner_id = auth.uid() and status = 'pending';
    if found then update profiles set role = 'operator' where id = auth.uid() and role = 'client'; end if;
  end if;
  return json_build_object('kind', c.kind, 'production_id', c.production_id);
end $$;

-- пришёл по ссылке «для производства» (по заявке или открыв ссылку с аккаунтом)
create or replace function public.ref_production_ok() returns boolean
language sql security definer set search_path = public stable as $$
  select auth.uid() is not null and (
    exists (select 1 from ref_accepts a where a.user_id = auth.uid() and a.kind = 'production')
    or exists (select 1 from signup_requests r join ref_codes c on c.code = r.ref_code
               where c.kind = 'production' and r.status = 'approved'
                 and r.digits = norm_phone(split_part((select email from auth.users where id = auth.uid()), '@', 1))))
$$;

-- регистрация производства: по ссылке «для производства» — подтверждается сразу
create or replace function public.register_production(p_name text, p_phone text default '', p_city text default '',
  p_kerf numeric default null, p_ml numeric default null, p_mr numeric default null, p_mt numeric default null, p_mb numeric default null,
  p_country text default '')
returns uuid language plpgsql security definer set search_path = public as $$
declare pid uuid; ok boolean := is_admin() or signup_open() or ref_production_ok();
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if length(trim(coalesce(p_name, ''))) < 2 then raise exception 'bad name'; end if;
  if length(trim(coalesce(p_country, ''))) < 2 then raise exception 'bad country'; end if;       -- страна обязательна
  select id into pid from productions where owner_id = auth.uid();
  if pid is null then
    insert into productions (name, owner_id, country, phone, city, kerf_width, margin_left, margin_right, margin_top, margin_bottom, status)
      values (left(trim(p_name), 80), auth.uid(), left(trim(p_country), 60), left(trim(coalesce(p_phone, '')), 40), left(trim(coalesce(p_city, '')), 80), coalesce(p_kerf, 4), coalesce(p_ml, 10), coalesce(p_mr, 10), coalesce(p_mt, 10), coalesce(p_mb, 10),
        case when ok then 'approved' else 'pending' end)
      returning id into pid;
  else
    update productions set name = left(trim(p_name), 80), country = left(trim(p_country), 60), phone = left(trim(coalesce(p_phone, '')), 40), city = left(trim(coalesce(p_city, '')), 80),
      kerf_width = coalesce(p_kerf, kerf_width), margin_left = coalesce(p_ml, margin_left), margin_right = coalesce(p_mr, margin_right),
      margin_top = coalesce(p_mt, margin_top), margin_bottom = coalesce(p_mb, margin_bottom),
      status = case when status = 'rejected' then (case when is_admin() or signup_open() then 'approved' else 'pending' end)
                    when status = 'pending' and ok then 'approved' else status end
      where id = pid;
  end if;
  if exists (select 1 from productions where id = pid and status = 'approved') then
    update profiles set role = 'operator' where id = auth.uid() and role = 'client';
  end if;
  return pid;
end $$;

-- ── Пригласившему: кто пришёл по его ссылкам. Ждущим кода в WhatsApp код показывается (его отправляет пригласивший).
-- -> { pending: [{ id, full_name, phone, digits, messenger, verified, code, kind }], registered: N }
create or replace function public.my_ref_people() returns json
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  return json_build_object(
    'pending', (select coalesce(json_agg(x order by x.created_at desc), '[]'::json) from (
      select r.id, r.full_name, r.phone, r.digits, r.messenger, r.created_at, r.code_sent_at,
        (r.phone_verified_at is not null) as verified,
        case when r.code_expires > now() and r.code_attempts < 5 then r.code end as code,
        (select kind from ref_codes where code = r.ref_code) as kind
      from signup_requests r
      where r.ref_by = auth.uid() and r.status = 'approved' and r.created_at > now() - interval '30 days'
        and not phone_registered(r.digits)) x),
    'registered', (select count(*) from signup_requests r where r.ref_by = auth.uid() and phone_registered(r.digits))
      + (select count(*) from ref_accepts a where a.ref_by = auth.uid()
           and not exists (select 1 from signup_requests r where r.ref_by = auth.uid()
                             and r.digits = norm_phone(split_part((select email from auth.users where id = a.user_id), '@', 1)))));
end $$;

-- код для отправки в WhatsApp (новый, если прежний истёк). Только тому, кто пригласил. -> { code, digits, phone }
create or replace function public.ref_send_code(p_id uuid) returns json
language plpgsql security definer set search_path = public as $$
declare r signup_requests; c text;
begin
  select * into r from signup_requests where id = p_id and ref_by = auth.uid() and status = 'approved' for update;
  if not found then raise exception 'not allowed'; end if;
  if phone_registered(r.digits) then return json_build_object('error', 'registered'); end if;
  c := case when r.code is not null and r.code_expires > now() and r.code_attempts < 5 then r.code else issue_signup_code(r.id) end;
  update signup_requests set code_sent_at = now() where id = r.id;
  return json_build_object('code', c, 'digits', r.digits, 'phone', r.phone, 'ref', r.ref_code);
end $$;

-- заявки для мастера — плюс кто пригласил
create or replace function public.admin_requests() returns json
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'not admin'; end if;
  return (select coalesce(json_agg(x order by x.created_at desc), '[]'::json) from (
    select r.id, r.phone, r.digits, r.full_name, r.comment, r.status, r.created_at, r.country, r.city,
      r.messenger, r.phone_verified_at, (r.tg_chat_id is not null) as tg_linked,
      r.code, r.code_expires, r.code_attempts, r.code_sent_at, (r.code_expires is not null and r.code_expires < now()) as code_expired,
      r.resubmits, r.rejected_name,
      (select kind from ref_codes where code = r.ref_code) as ref_kind,
      case when r.ref_by is not null then coalesce(
        (select p.name from ref_codes c join productions p on p.id = c.production_id where c.code = r.ref_code),
        (select full_name from profiles where id = r.ref_by), 'пользователь') end as ref_by_name,
      exists (select 1 from auth.users u where norm_phone(split_part(u.email, '@', 1)) = r.digits) as registered
    from signup_requests r) x);
end $$;

revoke all on function public.ref_get(text), public.my_ref_code(text), public.ref_info(text),
  public.request_signup_ref(text, text, text, text, text, text, text), public.accept_ref(text), public.ref_production_ok(),
  public.my_ref_people(), public.ref_send_code(uuid), public.admin_requests(),
  public.register_production(text, text, text, numeric, numeric, numeric, numeric, numeric, text) from public, anon, authenticated;
grant execute on function public.ref_info(text), public.request_signup_ref(text, text, text, text, text, text, text) to anon, authenticated;
grant execute on function public.my_ref_code(text), public.accept_ref(text), public.my_ref_people(), public.ref_send_code(uuid),
  public.admin_requests(), public.register_production(text, text, text, numeric, numeric, numeric, numeric, numeric, text) to authenticated;

notify pgrst, 'reload schema';
