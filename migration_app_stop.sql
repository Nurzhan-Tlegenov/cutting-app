-- Остановка приложения мастер-аккаунтом (профилактика): пока остановлено, у всех, кроме мастер-аккаунта, вместо
-- приложения — заставка с логотипом. Кто заходил в это время и что написал разработчику — в журнале app_stop_log.
-- Выполнить один раз в Supabase → SQL Editor (можно повторно).

insert into public.app_config (key, value) values ('app_stop', '{"on": false}'::jsonb) on conflict (key) do nothing;

create table if not exists public.app_stop_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  user_id uuid,
  kind text not null check (kind in ('visit', 'message')),
  name text, phone text, body text, path text, ua text
);
alter table public.app_stop_log enable row level security;     -- напрямую не читается и не пишется — только функциями ниже

create or replace function public.app_stopped() returns boolean
language sql security definer set search_path = public stable as $$
  select coalesce((select (value->>'on')::boolean from app_config where key = 'app_stop'), false)
$$;

create or replace function public.admin_set_app_stop(p_on boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'not admin'; end if;
  insert into app_config (key, value) values ('app_stop', jsonb_build_object('on', coalesce(p_on, false), 'since', now()))
  on conflict (key) do update set value = excluded.value;
end $$;

-- заход на заставку: один раз в 10 минут на человека (без входа — на браузер)
create or replace function public.stop_ping(p_path text default '', p_ua text default '') returns void
language plpgsql security definer set search_path = public as $$
declare u uuid := auth.uid();
begin
  if not app_stopped() then return; end if;
  if exists (select 1 from app_stop_log where kind = 'visit' and at > now() - interval '10 minutes'
             and ((u is not null and user_id = u) or (u is null and user_id is null and ua = left(coalesce(p_ua, ''), 300)))) then return; end if;
  insert into app_stop_log (user_id, kind, path, ua) values (u, 'visit', left(coalesce(p_path, ''), 300), left(coalesce(p_ua, ''), 300));
end $$;

-- сообщение разработчику с заставки (можно и без входа); не больше 5 в час с одного аккаунта / номера
create or replace function public.stop_message(p_name text, p_phone text, p_text text) returns void
language plpgsql security definer set search_path = public as $$
declare u uuid := auth.uid(); d text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
begin
  if length(trim(coalesce(p_text, ''))) = 0 then raise exception 'empty'; end if;
  if (select count(*) from app_stop_log where kind = 'message' and at > now() - interval '1 hour'
      and ((u is not null and user_id = u) or (d <> '' and regexp_replace(coalesce(phone, ''), '\D', '', 'g') = d))) >= 5 then raise exception 'too many'; end if;
  insert into app_stop_log (user_id, kind, name, phone, body)
  values (u, 'message', left(trim(coalesce(p_name, '')), 120), left(trim(coalesce(p_phone, '')), 40), left(trim(p_text), 2000));
end $$;

-- журнал с момента последнего включения / выключения остановки
create or replace function public.admin_stop_log() returns json
language plpgsql security definer set search_path = public as $$
declare cfg jsonb; since timestamptz;
begin
  if not is_admin() then raise exception 'not admin'; end if;
  select value into cfg from app_config where key = 'app_stop';
  since := coalesce((cfg->>'since')::timestamptz, now() - interval '30 days');
  return json_build_object('on', coalesce((cfg->>'on')::boolean, false), 'since', since, 'rows', coalesce((
    select json_agg(x order by x.at desc) from (
      select l.id, l.at, l.kind, l.user_id, l.name, l.phone, l.body, l.path,
        coalesce(nullif(trim(p.full_name), ''), '') as user_name, p.phone as user_phone
      from app_stop_log l left join profiles p on p.id = l.user_id
      where l.at >= since order by l.at desc limit 500) x), '[]'::json));
end $$;

revoke all on function public.app_stopped() from public;
revoke all on function public.stop_ping(text, text) from public;
revoke all on function public.stop_message(text, text, text) from public;
revoke all on function public.admin_set_app_stop(boolean) from public;
revoke all on function public.admin_stop_log() from public;
grant execute on function public.app_stopped() to anon, authenticated;
grant execute on function public.stop_ping(text, text) to anon, authenticated;
grant execute on function public.stop_message(text, text, text) to anon, authenticated;
grant execute on function public.admin_set_app_stop(boolean) to authenticated;
grant execute on function public.admin_stop_log() to authenticated;
