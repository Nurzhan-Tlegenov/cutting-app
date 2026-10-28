-- Постпроцессоры по запросу. Выполнить один раз в Supabase → SQL Editor (можно повторно). После migration_messages_posts.sql.
--
-- Было: постпроцессор с галочкой мастера «для всех» видели все пользователи — его команды можно было просто скопировать.
-- Стало:
--   • опубликованный постпроцессор (shared_posts) видят только те, кому мастер-аккаунт его выдал (shared_post_access),
--     и сотрудники их производства; остальные видят в каталоге только название — «доступно по запросу»;
--   • производство отправляет запрос постпроцессора (станок, контроллер, пример программы) — мастеру приходит уведомление;
--   • каждый выпуск программ записывается (post_usage): мастер видит, кто и каким постпроцессором выпускает программы.
-- Кто уже пользовался общим постпроцессором (он выбран в настройках ЧПУ пользователя или производства), получает доступ сам.

-- ═══ кому выдан ═══
create table if not exists public.shared_post_access (
  post_id text not null references public.shared_posts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  granted_at timestamptz not null default now(),
  note text,
  primary key (post_id, user_id)
);
alter table public.shared_post_access enable row level security;
drop policy if exists "shared_post_access: свои" on public.shared_post_access;
create policy "shared_post_access: свои" on public.shared_post_access for select to authenticated using (user_id = auth.uid() or is_admin());
drop policy if exists "shared_post_access: мастер" on public.shared_post_access;
create policy "shared_post_access: мастер" on public.shared_post_access for all to authenticated using (is_admin()) with check (is_admin());

-- виден ли постпроцессор: мастеру; тому, кому выдан; сотруднику производства, владельцу которого выдан
create or replace function public.post_visible(p_id text) returns boolean
language sql security definer set search_path = public stable as $$
  select is_admin() or exists (
    select 1 from shared_post_access a
    where a.post_id = p_id and (a.user_id = auth.uid() or a.user_id in (
      select pr.owner_id from productions pr join production_members m on m.production_id = pr.id
      where m.user_id = auth.uid() and coalesce(m.active, true))))
$$;
grant execute on function public.post_visible(text) to authenticated;

drop policy if exists "shared_posts: читать" on public.shared_posts;
drop policy if exists "shared_posts: читать по доступу" on public.shared_posts;
create policy "shared_posts: читать по доступу" on public.shared_posts for select to authenticated using (post_visible(id));

-- ═══ запросы ═══
create table if not exists public.post_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  post_id text,                       -- запрошен постпроцессор из каталога (или пусто — свой станок)
  machine text,
  controller text,
  note text,
  program_name text,
  program text,                       -- пример рабочей программы станка (текст), до 300 000 знаков
  status text not null default 'new', -- new | done | rejected
  created_at timestamptz not null default now(),
  done_at timestamptz,
  constraint post_requests_program_len check (program is null or length(program) <= 300000)
);
create index if not exists post_requests_user on public.post_requests (user_id, created_at desc);
alter table public.post_requests enable row level security;
drop policy if exists "post_requests: свои" on public.post_requests;
create policy "post_requests: свои" on public.post_requests for select to authenticated using (user_id = auth.uid() or is_admin());
drop policy if exists "post_requests: создать" on public.post_requests;
create policy "post_requests: создать" on public.post_requests for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "post_requests: мастер" on public.post_requests;
create policy "post_requests: мастер" on public.post_requests for update to authenticated using (is_admin()) with check (is_admin());
drop policy if exists "post_requests: мастер удаляет" on public.post_requests;
create policy "post_requests: мастер удаляет" on public.post_requests for delete to authenticated using (is_admin());

-- каталог: названия всех опубликованных постпроцессоров (без команд) и есть ли доступ
create or replace function public.post_catalog() returns json
language sql security definer set search_path = public stable as $$
  select coalesce(json_agg(json_build_object('id', s.id, 'name', s.name, 'kind', coalesce(s.data ->> 'kind', 'router'), 'mine', post_visible(s.id),
    'asked', exists (select 1 from post_requests r where r.user_id = auth.uid() and r.post_id = s.id and r.status = 'new')) order by s.name), '[]'::json)
  from shared_posts s
$$;

grant execute on function public.post_catalog() to authenticated;

-- мастеру — уведомление о запросе
create or replace function public.push_on_post_request() returns trigger
language plpgsql security definer set search_path = public as $$
declare who text; what text;
begin
  select coalesce(nullif(p.full_name, ''), p.phone, p.email, 'пользователь') into who from profiles p where p.id = new.user_id;
  select s.name into what from shared_posts s where s.id = new.post_id;
  begin
    perform push_admins('🔑 Запрос постпроцессора', concat_ws(' · ', who, coalesce(what, nullif(concat_ws(' / ', nullif(new.machine, ''), nullif(new.controller, '')), ''), 'свой станок')),
      '/post-access', 'postreq-' || new.id);
  exception when others then null;
  end;
  return new;
end $$;
drop trigger if exists push_on_post_request on public.post_requests;
create trigger push_on_post_request after insert on public.post_requests for each row execute function public.push_on_post_request();

-- ═══ выпуск программ: каким постпроцессором ═══
create table if not exists public.post_usage (
  id bigserial primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  post_id text,
  post_name text,
  kind text,
  shared boolean not null default false,
  order_id uuid,
  sheets integer,
  created_at timestamptz not null default now()
);
create index if not exists post_usage_post on public.post_usage (post_id, created_at desc);
create index if not exists post_usage_user on public.post_usage (user_id, created_at desc);
alter table public.post_usage enable row level security;
drop policy if exists "post_usage: записать" on public.post_usage;
create policy "post_usage: записать" on public.post_usage for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "post_usage: мастер" on public.post_usage;
create policy "post_usage: мастер" on public.post_usage for select to authenticated using (is_admin());

-- ═══ мастер-аккаунт: сводка ═══
create or replace function public.admin_post_access() returns json
language plpgsql security definer set search_path = public stable as $$
declare res json;
begin
  if not is_admin() then return null; end if;
  with who as (
    select u.id, coalesce(nullif(p.full_name, ''), u.email) as name, p.phone,
           (select string_agg(pr.name, ', ') from productions pr where pr.owner_id = u.id) as prod
    from auth.users u left join profiles p on p.id = u.id
  )
  select json_build_object(
    'posts', coalesce((select json_agg(json_build_object(
        'id', s.id, 'name', s.name, 'kind', coalesce(s.data ->> 'kind', 'router'),
        'access', coalesce((select json_agg(json_build_object('user_id', a.user_id, 'name', w.name, 'phone', w.phone, 'prod', w.prod, 'granted_at', a.granted_at, 'note', a.note,
            'runs', (select count(*) from post_usage g where g.post_id = s.id and (g.user_id = a.user_id or g.user_id in (
                       select m.user_id from production_members m join productions pr on pr.id = m.production_id where pr.owner_id = a.user_id)))::int,
            'last', (select max(g.created_at) from post_usage g where g.post_id = s.id and (g.user_id = a.user_id or g.user_id in (
                       select m.user_id from production_members m join productions pr on pr.id = m.production_id where pr.owner_id = a.user_id))))
            order by a.granted_at desc) from shared_post_access a join who w on w.id = a.user_id where a.post_id = s.id), '[]'::json),
        'runs', (select count(*) from post_usage g where g.post_id = s.id)::int,
        'users', (select count(distinct g.user_id) from post_usage g where g.post_id = s.id)::int,
        'last', (select max(g.created_at) from post_usage g where g.post_id = s.id)) order by s.name) from shared_posts s), '[]'::json),
    'requests', coalesce((select json_agg(json_build_object('id', r.id, 'user_id', r.user_id, 'name', w.name, 'phone', w.phone, 'prod', w.prod,
        'post_id', r.post_id, 'post_name', (select s.name from shared_posts s where s.id = r.post_id),
        'machine', r.machine, 'controller', r.controller, 'note', r.note, 'program_name', r.program_name, 'has_program', r.program is not null,
        'status', r.status, 'created_at', r.created_at,
        'user_total', (select count(*) from post_requests x where x.user_id = r.user_id)::int,
        'user_30d', (select count(*) from post_requests x where x.user_id = r.user_id and x.created_at > now() - interval '30 days')::int)
        order by (r.status = 'new') desc, r.created_at desc) from (select * from post_requests order by created_at desc limit 300) r join who w on w.id = r.user_id), '[]'::json),
    -- кто чем выпускает программы (за 90 дней): пользователь — постпроцессоры
    'usage', coalesce((select json_agg(json_build_object('user_id', x.user_id, 'name', w.name, 'prod', w.prod, 'posts', x.posts, 'runs', x.runs, 'last', x.last) order by x.last desc)
        from (select g.user_id, json_agg(distinct jsonb_build_object('name', g.post_name, 'shared', g.shared)) as posts, count(*)::int as runs, max(g.created_at) as last
              from post_usage g where g.created_at > now() - interval '90 days' group by g.user_id) x join who w on w.id = x.user_id), '[]'::json)
  ) into res;
  return res;
end $$;
revoke all on function public.admin_post_access() from public, anon;
grant execute on function public.admin_post_access() to authenticated;

-- поиск пользователя для выдачи (мастер): имя, телефон, почта, производство
create or replace function public.admin_find_users(p_q text) returns json
language sql security definer set search_path = public stable as $$
  select case when not is_admin() then null else coalesce((select json_agg(r) from (
    select u.id, coalesce(nullif(p.full_name, ''), u.email) as name, p.phone,
           (select string_agg(pr.name, ', ') from productions pr where pr.owner_id = u.id) as prod
    from auth.users u left join profiles p on p.id = u.id
    where coalesce(p_q, '') <> '' and (p.full_name ilike '%' || p_q || '%' or p.phone ilike '%' || p_q || '%' or u.email ilike '%' || p_q || '%'
           or exists (select 1 from productions pr where pr.owner_id = u.id and pr.name ilike '%' || p_q || '%'))
    order by 2 limit 20) r), '[]'::json) end
$$;
revoke all on function public.admin_find_users(text) from public, anon;
grant execute on function public.admin_find_users(text) to authenticated;

-- пример программы из запроса (мастер)
create or replace function public.admin_post_request_program(p_id uuid) returns json
language sql security definer set search_path = public stable as $$
  select case when not is_admin() then null else (select json_build_object('name', program_name, 'text', program) from post_requests where id = p_id) end
$$;
revoke all on function public.admin_post_request_program(uuid) from public, anon;
grant execute on function public.admin_post_request_program(uuid) to authenticated;

-- ═══ переход: кто уже пользовался общим постпроцессором — получает доступ ═══
insert into public.shared_post_access (post_id, user_id, note)
select s.id, u.id, 'выдан автоматически: уже пользовался'
from public.shared_posts s
join auth.users u on (
  u.raw_user_meta_data #>> '{app_settings,cnc,router}' = s.id or u.raw_user_meta_data #>> '{app_settings,cnc,router2}' = s.id
  or u.raw_user_meta_data #>> '{app_settings,cnc,post}' = s.id
  or coalesce(u.raw_user_meta_data #> '{app_settings,cnc,use6}', '[]'::jsonb) ? s.id)
on conflict do nothing;
insert into public.shared_post_access (post_id, user_id, note)
select s.id, pr.owner_id, 'выдан автоматически: уже пользовалось производство'
from public.shared_posts s
join public.productions pr on pr.owner_id is not null and pr.cnc is not null and (
  pr.cnc ->> 'router' = s.id or pr.cnc ->> 'router2' = s.id or pr.cnc ->> 'post' = s.id or coalesce(pr.cnc -> 'use6', '[]'::jsonb) ? s.id)
on conflict do nothing;

notify pgrst, 'reload schema';
