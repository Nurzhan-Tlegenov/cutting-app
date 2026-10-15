-- Восстановление пароля через администратора: пользователь на экране входа нажимает «Забыли пароль?»,
-- администратор в разделе «Пользователи» выдаёт код и сообщает его (например, в WhatsApp),
-- пользователь вводит код и новый пароль. Почта не нужна.
-- Выполнить один раз в Supabase → SQL Editor (можно повторно). После migration_security_all.sql.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.password_resets (
  id uuid primary key default gen_random_uuid(),
  digits text not null,
  status text not null default 'new' check (status in ('new', 'issued', 'done')),
  code text,
  attempts int not null default 0,
  expires_at timestamptz,
  created_at timestamptz default now(),
  done_at timestamptz
);
alter table public.password_resets enable row level security;
-- политик нет: таблица читается и меняется только через функции ниже
create unique index if not exists password_resets_open_uq on public.password_resets (digits) where status in ('new', 'issued');

-- Запрос с экрана входа. Ответ всегда 'ok' — по нему нельзя узнать, зарегистрирован ли номер.
create or replace function public.request_password_reset(p_phone text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare d text := norm_phone(p_phone);
begin
  if length(d) < 10 or length(d) > 15 then raise exception 'bad phone'; end if;
  if exists (select 1 from auth.users u where norm_phone(split_part(u.email, '@', 1)) = d)
     and not exists (select 1 from password_resets where digits = d and status in ('new', 'issued')) then
    insert into password_resets (digits) values (d);
  end if;
  return 'ok';
end $$;

-- Новый пароль по коду. -> 'ok' | 'bad' (нет запроса или код неверный) | 'expired' | 'blocked' (много попыток) | 'weak'
create or replace function public.confirm_password_reset(p_phone text, p_code text, p_password text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare d text := norm_phone(p_phone); r record; uid uuid;
begin
  if length(coalesce(p_password, '')) < 6 then return 'weak'; end if;
  select * into r from password_resets where digits = d and status = 'issued' for update;
  if not found then return 'bad'; end if;
  if r.expires_at is not null and r.expires_at < now() then return 'expired'; end if;
  if r.attempts >= 5 then return 'blocked'; end if;
  if r.code is null or r.code <> regexp_replace(coalesce(p_code, ''), '\D', '', 'g') then
    update password_resets set attempts = attempts + 1 where id = r.id;
    return 'bad';
  end if;
  select u.id into uid from auth.users u where norm_phone(split_part(u.email, '@', 1)) = d limit 1;
  if uid is null then return 'bad'; end if;
  update auth.users set encrypted_password = crypt(p_password, gen_salt('bf', 10)), updated_at = now() where id = uid;
  begin
    delete from auth.sessions where user_id = uid;      -- со старым паролем больше нигде не войдено
  exception when others then null;
  end;
  update password_resets set status = 'done', code = null, done_at = now() where id = r.id;
  return 'ok';
end $$;

-- ── только для администратора ──
create or replace function public.admin_password_resets() returns json
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'not admin'; end if;
  return (select coalesce(json_agg(x order by x.created_at desc), '[]'::json) from (
    select r.id, r.digits, r.status, r.code, r.attempts, r.expires_at, r.created_at, r.done_at,
      (r.expires_at is not null and r.expires_at < now()) as expired,
      p.full_name, p.phone, p.whatsapp
    from password_resets r
      left join auth.users u on norm_phone(split_part(u.email, '@', 1)) = r.digits
      left join profiles p on p.id = u.id
    where r.status in ('new', 'issued') or r.done_at > now() - interval '7 days') x);
end $$;

-- Выдать (или выдать заново) код: 6 цифр, действует сутки, 5 попыток ввода
create or replace function public.admin_issue_reset(p_id uuid) returns text
language plpgsql security definer set search_path = public as $$
declare c text := lpad(((('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 7))::bit(28)::int) % 1000000)::text, 6, '0');
begin
  if not is_admin() then raise exception 'not admin'; end if;
  update password_resets set status = 'issued', code = c, attempts = 0, expires_at = now() + interval '24 hours'
    where id = p_id and status in ('new', 'issued');
  if not found then raise exception 'no request'; end if;
  return c;
end $$;

-- Убрать запрос (отказать или почистить список)
create or replace function public.admin_close_reset(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'not admin'; end if;
  delete from password_resets where id = p_id;
end $$;

revoke all on function public.request_password_reset(text), public.confirm_password_reset(text, text, text),
  public.admin_password_resets(), public.admin_issue_reset(uuid), public.admin_close_reset(uuid) from public;
grant execute on function public.request_password_reset(text), public.confirm_password_reset(text, text, text) to anon, authenticated;
grant execute on function public.admin_password_resets(), public.admin_issue_reset(uuid), public.admin_close_reset(uuid) to authenticated;
notify pgrst, 'reload schema';
