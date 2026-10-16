-- Помощь со входом и удаление аккаунта мастер-аккаунтом.
-- Выполнить один раз в Supabase → SQL Editor целиком (можно повторно). После migration_password_reset.sql и migration_push.sql.
--
--   • «Не получается войти?» на экране входа: человек пишет номер и пару слов — мастер-аккаунту приходит уведомление.
--     Номер зарегистрирован — сразу создаётся запрос на смену пароля (мастер выдаёт код и шлёт в WhatsApp, как раньше).
--   • Мастер-аккаунт может удалить аккаунт пользователя целиком (с его заказами), чтобы тот зарегистрировался заново.

create table if not exists public.login_help (
  id uuid primary key default gen_random_uuid(),
  digits text not null,
  name text,
  body text,
  registered boolean not null default false,
  status text not null default 'new' check (status in ('new', 'done')),
  created_at timestamptz default now()
);
alter table public.login_help enable row level security;   -- только через функции ниже

-- -> 'ok' | 'limit'
create or replace function public.login_help_request(p_phone text, p_name text default '', p_text text default '') returns text
language plpgsql security definer set search_path = public as $$
declare d text := norm_phone(p_phone); reg boolean; nm text := left(trim(coalesce(p_name, '')), 120); tx text := left(trim(coalesce(p_text, '')), 1000);
begin
  if length(d) < 10 or length(d) > 15 then raise exception 'bad phone'; end if;
  if (select count(*) from login_help where digits = d and created_at > now() - interval '1 day') >= 3 then return 'limit'; end if;
  reg := exists (select 1 from auth.users u where norm_phone(split_part(u.email, '@', 1)) = d);
  insert into login_help (digits, name, body, registered) values (d, nullif(nm, ''), nullif(tx, ''), reg);
  -- зарегистрирован — заодно запрос на смену пароля: мастер выдаёт код как обычно
  if reg and not exists (select 1 from password_resets where digits = d and status in ('new', 'issued')) then
    insert into password_resets (digits) values (d);
  end if;
  begin
    perform push_admins('Не получается войти: +' || d, coalesce(nullif(nm, '') || ' · ', '') || case when reg then 'аккаунт есть' else 'аккаунта нет' end
      || coalesce(' · ' || left(nullif(tx, ''), 100), ''), '/go?t=users&f=lh', 'lh:' || d);
  exception when others then null;
  end;
  return 'ok';
end $$;

create or replace function public.admin_login_help() returns json
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'not admin'; end if;
  return (select coalesce(json_agg(x order by x.created_at desc), '[]'::json) from (
    select h.id, h.digits, h.name, h.body, h.status, h.created_at,
      exists (select 1 from auth.users u where norm_phone(split_part(u.email, '@', 1)) = h.digits) as registered,
      (select u.id from auth.users u where norm_phone(split_part(u.email, '@', 1)) = h.digits limit 1) as user_id,
      (select s.status from signup_requests s where s.digits = h.digits) as request_status
    from login_help h where h.status = 'new' or h.created_at > now() - interval '3 days') x);
end $$;

create or replace function public.admin_close_login_help(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'not admin'; end if;
  update login_help set status = 'done' where id = p_id;
end $$;

-- Удалить аккаунт пользователя целиком: вход, профиль, заказы, заявку на регистрацию — номер снова свободен.
-- Свой аккаунт и аккаунт администратора удалить нельзя.
create or replace function public.admin_delete_user(p_id uuid) returns text
language plpgsql security definer set search_path = public, auth as $$
declare d text;
begin
  if not is_admin() then raise exception 'not admin'; end if;
  if p_id = auth.uid() then raise exception 'self'; end if;
  if exists (select 1 from profiles where id = p_id and role = 'admin') then raise exception 'admin'; end if;
  select norm_phone(split_part(email, '@', 1)) into d from auth.users where id = p_id;
  if d is null then return 'not found'; end if;
  delete from signup_requests where digits = d;
  delete from password_resets where digits = d;
  update login_help set status = 'done' where digits = d;
  -- своё производство пользователя: без владельца оно больше не показывается клиентам (заказы других клиентов в нём остаются)
  update productions set owner_id = null, status = 'rejected' where owner_id = p_id;
  begin
    delete from auth.users where id = p_id;
  exception when foreign_key_violation then
    get stacked diagnostics d = message_text;
    return 'fk: ' || d;
  end;
  return 'ok';
end $$;

revoke all on function public.login_help_request(text, text, text), public.admin_login_help(), public.admin_close_login_help(uuid),
  public.admin_delete_user(uuid) from public, anon, authenticated;
grant execute on function public.login_help_request(text, text, text) to anon, authenticated;
grant execute on function public.admin_login_help(), public.admin_close_login_help(uuid), public.admin_delete_user(uuid) to authenticated;
notify pgrst, 'reload schema';
