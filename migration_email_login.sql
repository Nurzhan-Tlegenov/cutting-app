-- Вход и регистрация по email и через Google (для зарубежных пользователей — без Telegram/WhatsApp).
-- Выполнить один раз в Supabase → SQL Editor (можно повторно). После migration_phone_verify_open.sql,
-- migration_signup_required.sql и migration_phone_block.sql.
--
-- Как работает:
--   • аккаунты по номеру телефона (служебный адрес «цифры@raskoypro.local») — всё как раньше: заявка/код, приглашения;
--   • аккаунт с настоящей почтой (регистрация по email или Google) создаётся без кода и без одобрения,
--     пока включено «Регистрация по email и Google» (мастер-аккаунт → Пользователи). Выключили — новые email-аккаунты
--     не создаются (входить уже зарегистрированные могут);
--   • имя, страну и город email-пользователь заполняет в приложении сразу после входа — без них дальше не пустит;
--   • заблокировать можно и почту: она хранится в том же списке «Заблокированные номера».

-- ── Настройка: регистрация по email и Google (по умолчанию включена)
insert into public.app_config (key, value) values ('email_signup', 'true'::jsonb) on conflict (key) do nothing;

create or replace function public.is_phone_email(p text) returns boolean
language sql immutable as $$ select lower(coalesce(p, '')) like '%@raskoypro.local' $$;

create or replace function public.email_signup_open() returns boolean
language sql security definer set search_path = public stable as $$
  select coalesce((select value <> 'false'::jsonb from app_config where key = 'email_signup'), true)
$$;

create or replace function public.admin_set_email_signup(p_open boolean) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'not admin'; end if;
  insert into app_config (key, value) values ('email_signup', to_jsonb(p_open)) on conflict (key) do update set value = excluded.value;
  return p_open;
end $$;

-- ── Создание аккаунта: email-аккаунты — своя ветка, телефонные — без изменений
create or replace function public.check_signup_allowed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not is_phone_email(new.email) then
    if phone_blocked(lower(trim(coalesce(new.email, '')))) then raise exception 'signup_closed'; end if;
    if invite_valid(new.raw_user_meta_data ->> 'invite') then return new; end if;
    if email_signup_open() then return new; end if;
    raise exception 'signup_closed';
  end if;
  if invite_valid(new.raw_user_meta_data ->> 'invite') then return new; end if;
  if exists (select 1 from signup_requests where status = 'approved' and digits = norm_phone(split_part(coalesce(new.email, ''), '@', 1))
             and code_ok_at > now() - interval '30 minutes') then return new; end if;
  raise exception 'signup_closed';
end $$;
drop trigger if exists check_signup_allowed on auth.users;
create trigger check_signup_allowed before insert on auth.users for each row execute function public.check_signup_allowed();

-- Имя, страна, город: у email-аккаунта их спрашивает приложение сразу после входа (у Google их нет до входа)
create or replace function public.check_signup_profile() returns trigger
language plpgsql security definer set search_path = public as $$
declare m jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb); r signup_requests;
begin
  if not is_phone_email(new.email) then return new; end if;
  if invite_valid(m ->> 'invite') then return new; end if;
  select * into r from signup_requests where digits = norm_phone(split_part(coalesce(new.email, ''), '@', 1));
  if coalesce(nullif(trim(m ->> 'full_name'), ''), nullif(trim(r.full_name), '')) is null
     or coalesce(nullif(trim(m ->> 'country'), ''), nullif(trim(r.country), '')) is null
     or coalesce(nullif(trim(m ->> 'city'), ''), nullif(trim(r.city), '')) is null then
    raise exception 'signup_incomplete';
  end if;
  return new;
end $$;
drop trigger if exists check_signup_profile on auth.users;
create trigger check_signup_profile before insert on auth.users for each row execute function public.check_signup_profile();

-- Блокировка номера: у email-аккаунта цифры из адреса почты номером не считаются
create or replace function public.check_phone_blocked() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if is_phone_email(new.email) and phone_blocked(norm_phone(split_part(coalesce(new.email, ''), '@', 1))) then raise exception 'signup_closed'; end if;
  return new;
end $$;
drop trigger if exists check_phone_blocked on auth.users;
create trigger check_phone_blocked before insert on auth.users for each row execute function public.check_phone_blocked();

-- ── Мастер: заблокировать номер или почту (почта хранится в том же списке, в нижнем регистре)
create or replace function public.admin_block_phone(p_phone text, p_note text default '') returns text
language plpgsql security definer set search_path = public, auth as $$
declare em boolean := position('@' in coalesce(p_phone, '')) > 0;
  d text := case when em then lower(trim(p_phone)) else norm_phone(p_phone) end; uid uuid;
begin
  if not is_admin() then raise exception 'not admin'; end if;
  if em then
    if d !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' or is_phone_email(d) then return 'bad phone'; end if;
    select id into uid from auth.users where lower(email) = d limit 1;
  else
    if length(d) < 10 or length(d) > 15 then return 'bad phone'; end if;
    select id into uid from auth.users where is_phone_email(email) and norm_phone(split_part(email, '@', 1)) = d limit 1;
    delete from signup_requests where digits = d;
    delete from password_resets where digits = d;
  end if;
  if uid = auth.uid() or exists (select 1 from profiles where id = uid and role = 'admin') then return 'admin'; end if;
  insert into blocked_phones (digits, note, created_by) values (d, nullif(left(trim(coalesce(p_note, '')), 200), ''), auth.uid())
    on conflict (digits) do update set note = coalesce(excluded.note, blocked_phones.note);
  if uid is not null then
    update auth.users set banned_until = now() + interval '100 years' where id = uid;
    begin delete from auth.sessions where user_id = uid; exception when others then null; end;
    begin delete from auth.refresh_tokens where user_id = uid::text; exception when others then null; end;
  end if;
  return 'ok';
end $$;

create or replace function public.admin_unblock_phone(p_phone text) returns text
language plpgsql security definer set search_path = public, auth as $$
declare em boolean := position('@' in coalesce(p_phone, '')) > 0;
  d text := case when em then lower(trim(p_phone)) else norm_phone(p_phone) end;
begin
  if not is_admin() then raise exception 'not admin'; end if;
  delete from blocked_phones where digits = d;
  if em then update auth.users set banned_until = null where lower(email) = d;
  else update auth.users set banned_until = null where is_phone_email(email) and norm_phone(split_part(email, '@', 1)) = d; end if;
  return 'ok';
end $$;

create or replace function public.admin_blocked_phones() returns json
language plpgsql security definer set search_path = public, auth as $$
begin
  if not is_admin() then raise exception 'not admin'; end if;
  return coalesce((select json_agg(json_build_object('digits', b.digits, 'note', b.note, 'created_at', b.created_at,
    'user_id', x.id, 'name', (select p.full_name from profiles p where p.id = x.id))
    order by b.created_at desc)
    from blocked_phones b
    left join lateral (select u.id from auth.users u
      where (position('@' in b.digits) > 0 and lower(u.email) = b.digits)
         or (position('@' in b.digits) = 0 and is_phone_email(u.email) and norm_phone(split_part(u.email, '@', 1)) = b.digits)
      limit 1) x on true), '[]'::json);
end $$;

revoke all on function public.email_signup_open(), public.admin_set_email_signup(boolean) from public, anon, authenticated;
grant execute on function public.email_signup_open() to anon, authenticated;
grant execute on function public.admin_set_email_signup(boolean) to authenticated;
grant execute on function public.admin_block_phone(text, text), public.admin_unblock_phone(text), public.admin_blocked_phones() to authenticated;

notify pgrst, 'reload schema';
