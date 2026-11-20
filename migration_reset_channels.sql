-- Восстановление пароля: код в Telegram (бот, сам) или на почту (сам), либо через WhatsApp / MAX (код выдаёт мастер).
-- Выполнить один раз в Supabase → SQL Editor (можно повторно). После migration_password_reset.sql и migration_phone_verify.sql.

alter table public.password_resets add column if not exists via text;
alter table public.password_resets add column if not exists issued_at timestamptz;

create table if not exists public.tg_reset_pending (chat bigint primary key, created_at timestamptz not null default now());
alter table public.tg_reset_pending enable row level security;

create or replace function public.reset_uid(d text) returns uuid
language sql security definer set search_path = public stable as $$
  select u.id from auth.users u where norm_phone(split_part(u.email, '@', 1)) = d limit 1
$$;

-- Запрос мастеру с выбором мессенджера (whatsapp | max). Ответ всегда 'ok'.
create or replace function public.request_password_reset2(p_phone text, p_via text) returns text
language plpgsql security definer set search_path = public as $$
declare d text := norm_phone(p_phone); v text := case when p_via = 'max' then 'max' else 'whatsapp' end;
begin
  if length(d) < 10 or length(d) > 15 then raise exception 'bad phone'; end if;
  if reset_uid(d) is not null then
    update password_resets set via = v where digits = d and status in ('new', 'issued');
    if not found then insert into password_resets (digits, via) values (d, v); end if;
  end if;
  return 'ok';
end $$;

-- Код без мастера: действует 1 час, 5 попыток
create or replace function public.svc_issue_reset(d text, v text) returns text
language plpgsql security definer set search_path = public as $$
declare c text := gen_code6();
begin
  update password_resets set status = 'issued', code = c, attempts = 0, expires_at = now() + interval '1 hour', issued_at = now(), via = v
    where digits = d and status in ('new', 'issued');
  if not found then
    insert into password_resets (digits, status, code, expires_at, issued_at, via) values (d, 'issued', c, now() + interval '1 hour', now(), v);
  end if;
  return c;
end $$;

-- Бот: человек открыл ссылку «восстановить пароль»
create or replace function public.tg_reset_start(p_chat bigint) returns text
language plpgsql security definer set search_path = public as $$
begin
  delete from tg_reset_pending where created_at < now() - interval '1 day';
  insert into tg_reset_pending (chat) values (p_chat) on conflict (chat) do update set created_at = now();
  return 'ok';
end $$;

-- Бот: человек поделился своим номером. -> { result: 'none' (не просил) | 'no_account' | 'ok', code, digits }
create or replace function public.tg_reset_contact(p_chat bigint, p_phone text) returns json
language plpgsql security definer set search_path = public as $$
declare d text := norm_phone(p_phone);
begin
  delete from tg_reset_pending where chat = p_chat and created_at > now() - interval '30 minutes';
  if not found then return json_build_object('result', 'none'); end if;
  if reset_uid(d) is null then return json_build_object('result', 'no_account'); end if;
  return json_build_object('result', 'ok', 'code', svc_issue_reset(d, 'telegram'), 'digits', d);
end $$;

-- Почта: та, что человек указал при регистрации по номеру. -> { result: 'none' | 'wait' | 'ok', code, email }
create or replace function public.svc_reset_email(p_phone text) returns json
language plpgsql security definer set search_path = public as $$
declare d text := norm_phone(p_phone); em text; last timestamptz;
begin
  if length(d) < 10 or length(d) > 15 then return json_build_object('result', 'none'); end if;
  select nullif(trim(u.raw_user_meta_data->>'contact_email'), '') into em from auth.users u where u.id = reset_uid(d);
  if em is null or em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then return json_build_object('result', 'none'); end if;
  select max(issued_at) into last from password_resets where digits = d and via = 'email';
  if last > now() - interval '2 minutes' then return json_build_object('result', 'wait'); end if;
  return json_build_object('result', 'ok', 'code', svc_issue_reset(d, 'email'), 'email', em);
end $$;

-- Мастеру — только запросы через WhatsApp / MAX (Telegram и почта обходятся без него)
create or replace function public.admin_password_resets() returns json
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'not admin'; end if;
  return (select coalesce(json_agg(x order by x.created_at desc), '[]'::json) from (
    select r.id, r.digits, r.status, r.code, r.attempts, r.expires_at, r.created_at, r.done_at, coalesce(r.via, 'whatsapp') as via,
      (r.expires_at is not null and r.expires_at < now()) as expired,
      p.full_name, p.phone, p.whatsapp
    from password_resets r
      left join auth.users u on norm_phone(split_part(u.email, '@', 1)) = r.digits
      left join profiles p on p.id = u.id
    where (r.status in ('new', 'issued') and coalesce(r.via, 'whatsapp') in ('whatsapp', 'max')) or r.done_at > now() - interval '7 days') x);
end $$;

revoke all on function public.reset_uid(text), public.request_password_reset2(text, text), public.svc_issue_reset(text, text),
  public.tg_reset_start(bigint), public.tg_reset_contact(bigint, text), public.svc_reset_email(text) from public, anon, authenticated;
grant execute on function public.request_password_reset2(text, text) to anon, authenticated;
grant execute on function public.tg_reset_start(bigint), public.tg_reset_contact(bigint, text), public.svc_reset_email(text) to service_role;
notify pgrst, 'reload schema';
