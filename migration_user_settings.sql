-- Настройки пользователя — в своей таблице, а не в данных входа. Выполнить один раз в Supabase → SQL Editor (можно повторно).
--
-- Было: все настройки аккаунта (шаблоны бирок, «Мои шаблоны бирок», постпроцессоры, форматы листа…) лежали в
-- user_metadata.app_settings. Эти данные входят в ключ входа (JWT), который приложение отправляет с КАЖДЫМ запросом.
-- Настройки выросли — ключ перестал пролезать в заголовок запроса, сервер отвечает «Bad Request» на всё подряд:
-- не грузится профиль (мастер-аккаунт становится обычным пользователем), сообщения, заказы.
-- Стало: настройки — в таблице user_settings; в данных входа их больше нет, ключ снова маленький.
-- После выполнения: на каждом устройстве выйти из аккаунта и войти снова (или подождать до часа — ключ обновится сам).

create table if not exists public.user_settings (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.user_settings enable row level security;
drop policy if exists "user_settings: свои" on public.user_settings;
create policy "user_settings: свои" on public.user_settings for select to authenticated using (user_id = auth.uid() or is_admin());
drop policy if exists "user_settings: создать" on public.user_settings;
create policy "user_settings: создать" on public.user_settings for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "user_settings: изменить" on public.user_settings;
create policy "user_settings: изменить" on public.user_settings for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- перенос: настройки из данных входа -> в таблицу (уже перенесённые не трогаем)
insert into public.user_settings (user_id, data)
select u.id, u.raw_user_meta_data -> 'app_settings'
from auth.users u
where jsonb_typeof(u.raw_user_meta_data -> 'app_settings') = 'object'
on conflict (user_id) do nothing;

-- из данных входа — убрать (ключ входа снова маленький)
update auth.users set raw_user_meta_data = raw_user_meta_data - 'app_settings'
where raw_user_meta_data ? 'app_settings';

-- «Кто чем выпускает»: свои постпроцессоры пользователей — теперь из таблицы настроек
create or replace function public.admin_user_posts() returns json
language plpgsql security definer set search_path = public stable as $$
declare std text := post_cmd_key('{"cmdStart":"M16\nG54","cmdToolStart":"G53 Z0\nM05\nM06 T{T}\nG43 H{T}\nM03 S{S}","cmdToolEnd":"G53 Z0\nG54","cmdEnd":"M05\nM30"}'::jsonb);
        res json;
begin
  if not is_admin() then return null; end if;
  with own as (
    select s.user_id, p as post from user_settings s, jsonb_array_elements(coalesce(s.data #> '{cnc,posts}', '[]'::jsonb)) p
    union all
    select pr.owner_id, p from productions pr, jsonb_array_elements(coalesce(pr.cnc -> 'posts', '[]'::jsonb)) p where pr.owner_id is not null
  ), mine as (
    select distinct on (o.user_id, o.post ->> 'name') o.user_id, o.post ->> 'name' as name,
      (select s.name from shared_posts s where post_cmd_key(s.data) = post_cmd_key(o.post) and post_cmd_key(s.data) <> '|||'
         or lower(o.post ->> 'name') like lower(s.name) || '%' limit 1) as base
    from own o
    where coalesce(o.post ->> 'kind', 'router') = 'router' and not coalesce((o.post ->> 'shared')::boolean, false)
      and post_cmd_key(o.post) not in ('', '|||', std)
  ), runs as (
    select g.user_id, count(*) filter (where not g.shared)::int as own_runs, max(g.created_at) filter (where not g.shared) as own_last
    from post_usage g group by g.user_id
  )
  select coalesce(json_agg(json_build_object('user_id', x.user_id, 'own', x.own, 'own_runs', coalesce(r.own_runs, 0), 'own_last', r.own_last)), '[]'::json) into res
  from (select user_id, json_agg(json_build_object('name', name, 'base', base) order by name) as own from mine group by user_id) x
  left join runs r on r.user_id = x.user_id;
  return res;
end $$;
revoke all on function public.admin_user_posts() from public, anon;
grant execute on function public.admin_user_posts() to authenticated;

notify pgrst, 'reload schema';

-- проверка: самые большие данные входа (должно быть маленькое — несколько сотен байт)
select u.email, length(u.raw_user_meta_data::text) as meta_bytes from auth.users u order by 2 desc limit 5;
