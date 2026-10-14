-- Подтверждение номера телефона при регистрации по заявке (Telegram или WhatsApp).
-- Выполнить один раз в Supabase → SQL Editor (можно повторно). После migration_staff_signup.sql и migration_user_location.sql.
--
-- Как работает:
--   • в заявке человек выбирает, куда прислать код: Telegram (рекомендуем) или WhatsApp;
--   • Telegram: человек открывает бота @RaskroyProBot по ссылке из приложения и жмёт «Поделиться номером» —
--     Telegram сам ручается, что номер его. Номер с опечаткой не совпадёт — бот сразу об этом скажет;
--   • мастер одобряет заявку — база выдаёт 6-значный код (3 дня, 5 попыток). В Telegram бот присылает код сам,
--     в WhatsApp мастер отправляет его одним нажатием;
--   • зарегистрироваться по одобренной заявке можно только с этим кодом: проверяет сама база (триггер на auth.users),
--     номер без кода — даже одобренный — не пройдёт.
--   Регистрация сотрудника по ссылке производства и открытая регистрация работают как раньше.

create extension if not exists pgcrypto with schema extensions;

alter table public.signup_requests add column if not exists messenger text;            -- 'telegram' | 'whatsapp'
alter table public.signup_requests add column if not exists tg_token text;             -- метка для ссылки t.me/<бот>?start=<метка>
alter table public.signup_requests add column if not exists tg_pending_chat bigint;    -- чат, открывший бота по метке (номер ещё не проверен)
alter table public.signup_requests add column if not exists tg_chat_id bigint;         -- чат, в котором номер подтверждён
alter table public.signup_requests add column if not exists phone_verified_at timestamptz;
alter table public.signup_requests add column if not exists code text;
alter table public.signup_requests add column if not exists code_expires timestamptz;
alter table public.signup_requests add column if not exists code_attempts int not null default 0;
alter table public.signup_requests add column if not exists code_ok_at timestamptz;    -- код введён верно (на 30 минут — для самой регистрации)
alter table public.signup_requests add column if not exists code_sent_at timestamptz;
create unique index if not exists signup_requests_tg_token_uq on public.signup_requests (tg_token) where tg_token is not null;

create or replace function public.gen_code6() returns text
language sql volatile as $$
  select lpad(((('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 7))::bit(28)::int) % 1000000)::text, 6, '0')
$$;

create or replace function public.phone_registered(p_digits text) returns boolean
language sql security definer set search_path = public stable as $$
  select exists (select 1 from auth.users u where norm_phone(split_part(u.email, '@', 1)) = p_digits)
$$;

-- выдать новый код по заявке (внутренняя, без проверки прав)
create or replace function public.issue_signup_code(p_id uuid) returns text
language plpgsql security definer set search_path = public as $$
declare c text := gen_code6();
begin
  update signup_requests set code = c, code_expires = now() + interval '3 days', code_attempts = 0, code_ok_at = null where id = p_id;
  return c;
end $$;

-- ── Заявка с экрана входа (новая версия: с мессенджером). Старая request_signup остаётся для старых копий приложения.
-- -> { status: 'open'|'new'|'approved'|'rejected', registered, messenger, tg_token, verified, code_issued }
create or replace function public.request_signup2(p_name text, p_phone text, p_comment text default '', p_country text default '',
  p_city text default '', p_messenger text default 'telegram')
returns json language plpgsql security definer set search_path = public, extensions as $$
declare d text := norm_phone(p_phone); r signup_requests; reg boolean;
  m text := case when p_messenger in ('telegram', 'whatsapp') then p_messenger else 'telegram' end;
begin
  if signup_open() then return json_build_object('status', 'open'); end if;
  if length(d) < 10 or length(d) > 15 then raise exception 'bad phone'; end if;
  reg := phone_registered(d);
  select * into r from signup_requests where digits = d for update;
  if not found then
    insert into signup_requests (phone, digits, full_name, comment, country, city, messenger, tg_token)
      values (left(trim(p_phone), 40), d, left(trim(coalesce(p_name, '')), 120), left(trim(coalesce(p_comment, '')), 500),
        nullif(left(trim(coalesce(p_country, '')), 60), ''), nullif(left(trim(coalesce(p_city, '')), 80), ''), m,
        case when m = 'telegram' then encode(gen_random_bytes(12), 'hex') end)
      returning * into r;
  else
    if r.status = 'new' then
      update signup_requests set full_name = coalesce(nullif(left(trim(p_name), 120), ''), full_name),
        comment = coalesce(nullif(left(trim(p_comment), 500), ''), comment),
        country = coalesce(nullif(left(trim(p_country), 60), ''), country), city = coalesce(nullif(left(trim(p_city), 80), ''), city)
      where id = r.id;
    end if;
    if not reg and r.status <> 'rejected' then
      update signup_requests set messenger = m,
        tg_token = coalesce(tg_token, case when m = 'telegram' then encode(gen_random_bytes(12), 'hex') end)
      where id = r.id returning * into r;
    end if;
  end if;
  return json_build_object('status', r.status, 'registered', reg, 'messenger', r.messenger,
    'tg_token', case when not reg and r.status <> 'rejected' and r.phone_verified_at is null then r.tg_token end,
    'verified', r.phone_verified_at is not null,
    'code_issued', r.code is not null and coalesce(r.code_expires > now(), false));
end $$;

-- ── Проверка кода перед регистрацией. -> 'ok' | 'bad' | 'expired' | 'blocked' | 'nocode' | 'registered'
-- Неверные попытки считаются здесь (функция не откатывается), поэтому код нельзя подобрать.
create or replace function public.confirm_signup_code(p_phone text, p_code text) returns text
language plpgsql security definer set search_path = public as $$
declare d text := norm_phone(p_phone); r signup_requests;
begin
  select * into r from signup_requests where digits = d and status = 'approved' for update;
  if not found then return 'bad'; end if;
  if phone_registered(d) then return 'registered'; end if;
  if r.code is null then return 'nocode'; end if;
  if r.code_expires < now() then return 'expired'; end if;
  if r.code_attempts >= 5 then return 'blocked'; end if;
  if r.code <> regexp_replace(coalesce(p_code, ''), '\D', '', 'g') then
    update signup_requests set code_attempts = code_attempts + 1 where id = r.id;
    return 'bad';
  end if;
  update signup_requests set code_ok_at = now() where id = r.id;
  return 'ok';
end $$;

-- ── Проверка перед созданием аккаунта: открытая регистрация, приглашение производства — или одобренная заявка
-- с верно введённым кодом (не старше 30 минут).
create or replace function public.check_signup_allowed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if signup_open() then return new; end if;
  if invite_valid(new.raw_user_meta_data ->> 'invite') then return new; end if;
  if exists (select 1 from signup_requests where status = 'approved' and digits = norm_phone(split_part(coalesce(new.email, ''), '@', 1))
             and code_ok_at > now() - interval '30 minutes') then return new; end if;
  raise exception 'signup_closed';
end $$;
drop trigger if exists check_signup_allowed on auth.users;
create trigger check_signup_allowed before insert on auth.users for each row execute function public.check_signup_allowed();

-- ── Для бота (вызывает только функция tg-bot с серверным ключом) ──
-- Человек открыл бота по ссылке из приложения. -> 'ok' | 'verified' (уже подтверждён) | 'notfound'
create or replace function public.tg_start(p_token text, p_chat bigint) returns text
language plpgsql security definer set search_path = public as $$
declare r signup_requests;
begin
  select * into r from signup_requests where tg_token = trim(coalesce(p_token, '')) for update;
  if not found then return 'notfound'; end if;
  if r.phone_verified_at is not null and r.tg_chat_id = p_chat then return 'verified'; end if;
  update signup_requests set tg_pending_chat = p_chat where id = r.id;
  return 'ok';
end $$;

-- Человек поделился своим номером в боте.
-- -> { result: 'ok'|'mismatch'|'nolink', status, code (если заявка уже одобрена), expected (номер заявки, частично скрыт) }
create or replace function public.tg_contact(p_chat bigint, p_phone text) returns json
language plpgsql security definer set search_path = public as $$
declare d text := norm_phone(p_phone); r signup_requests; c text;
begin
  -- сначала заявка, к которой этот чат пришёл по ссылке; если такой нет — заявка с этим же номером
  select * into r from signup_requests where tg_pending_chat = p_chat and status <> 'rejected' order by created_at desc limit 1 for update;
  if not found then
    select * into r from signup_requests where digits = d and status <> 'rejected' for update;
    if not found then return json_build_object('result', 'nolink'); end if;
  end if;
  if r.digits <> d then
    return json_build_object('result', 'mismatch', 'expected', '+' || left(r.digits, length(r.digits) - 4) || '••' || right(r.digits, 2));
  end if;
  update signup_requests set phone_verified_at = coalesce(phone_verified_at, now()), tg_chat_id = p_chat, tg_pending_chat = null, messenger = 'telegram'
    where id = r.id;
  if r.status = 'approved' and not phone_registered(d) then
    c := case when r.code is not null and r.code_expires > now() and r.code_attempts < 5 then r.code else issue_signup_code(r.id) end;
    update signup_requests set code_sent_at = now() where id = r.id;
  end if;
  return json_build_object('result', 'ok', 'status', r.status, 'code', c);
end $$;

-- Код для отправки в Telegram по просьбе мастера (права мастера проверяет функция бота). -> { code, chat } | { error }
create or replace function public.svc_signup_code(p_id uuid) returns json
language plpgsql security definer set search_path = public as $$
declare r signup_requests; c text;
begin
  select * into r from signup_requests where id = p_id for update;
  if not found or r.status <> 'approved' then return json_build_object('error', 'not_approved'); end if;
  if r.tg_chat_id is null then return json_build_object('error', 'no_telegram'); end if;
  c := case when r.code is not null and r.code_expires > now() and r.code_attempts < 5 then r.code else issue_signup_code(r.id) end;
  update signup_requests set code_sent_at = now() where id = r.id;
  return json_build_object('code', c, 'chat', r.tg_chat_id);
end $$;

-- ── Только для мастера ──
-- Одобрить заявку (или выдать новый код по уже одобренной). -> { code, messenger, telegram, digits, phone, full_name }
create or replace function public.admin_approve_request(p_id uuid) returns json
language plpgsql security definer set search_path = public as $$
declare r signup_requests; c text;
begin
  if not is_admin() then raise exception 'not admin'; end if;
  update signup_requests set status = 'approved' where id = p_id returning * into r;
  if not found then raise exception 'no request'; end if;
  c := issue_signup_code(p_id);
  return json_build_object('code', c, 'messenger', r.messenger, 'telegram', r.tg_chat_id is not null and r.phone_verified_at is not null,
    'digits', r.digits, 'phone', r.phone, 'full_name', r.full_name);
end $$;

-- заявки для мастера — с отметками подтверждения и кодом
create or replace function public.admin_requests() returns json
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'not admin'; end if;
  return (select coalesce(json_agg(x order by x.created_at desc), '[]'::json) from (
    select r.id, r.phone, r.digits, r.full_name, r.comment, r.status, r.created_at, r.country, r.city,
      r.messenger, r.phone_verified_at, (r.tg_chat_id is not null) as tg_linked,
      r.code, r.code_expires, r.code_attempts, r.code_sent_at, (r.code_expires is not null and r.code_expires < now()) as code_expired,
      exists (select 1 from auth.users u where norm_phone(split_part(u.email, '@', 1)) = r.digits) as registered
    from signup_requests r) x);
end $$;

revoke all on function public.gen_code6(), public.phone_registered(text), public.issue_signup_code(uuid),
  public.request_signup2(text, text, text, text, text, text), public.confirm_signup_code(text, text),
  public.tg_start(text, bigint), public.tg_contact(bigint, text), public.svc_signup_code(uuid),
  public.admin_approve_request(uuid), public.admin_requests() from public, anon, authenticated;
grant execute on function public.request_signup2(text, text, text, text, text, text), public.confirm_signup_code(text, text) to anon, authenticated;
grant execute on function public.admin_approve_request(uuid), public.admin_requests() to authenticated;
grant execute on function public.tg_start(text, bigint), public.tg_contact(bigint, text), public.svc_signup_code(uuid) to service_role;

notify pgrst, 'reload schema';
