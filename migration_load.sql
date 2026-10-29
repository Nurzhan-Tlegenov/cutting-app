-- Мастер-аккаунт: «Нагрузка» — как быстро база отвечает пользователям, где просаживается, сколько места занято.
-- Выполнить один раз в Supabase → SQL Editor (можно повторно).
--
-- Замеры делают сами приложения пользователей: каждый запрос к базе засекается у пользователя, раз в 5 минут
-- приложение отправляет одну строку-сводку (сколько запросов, ошибок, обычное и худшее время, самые медленные).
-- Хранятся 30 дней.

create table if not exists public.perf_samples (
  id bigserial primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  at timestamptz not null default now(),
  via text not null default 'direct',     -- direct | mirror (ru.raskroypro.com)
  n int not null default 0,               -- запросов к базе
  err int not null default 0,             -- из них с ошибкой (сеть, 5xx)
  p50 int,                                -- обычное время ответа, мс
  p95 int,                                -- худшее (95 % запросов быстрее), мс
  mx int,                                 -- самый долгий, мс
  top jsonb                               -- самые медленные места: [{ p: путь, n, ms: суммарно, mx }]
);
create index if not exists perf_samples_at on public.perf_samples (at desc);
alter table public.perf_samples enable row level security;
drop policy if exists "perf_samples: записать" on public.perf_samples;
create policy "perf_samples: записать" on public.perf_samples for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "perf_samples: мастер" on public.perf_samples;
create policy "perf_samples: мастер" on public.perf_samples for select to authenticated using (is_admin());

create or replace function public.admin_load() returns json
language plpgsql security definer set search_path = public, extensions as $$
declare res json; slow json; tz text := 'Asia/Almaty';
begin
  if not is_admin() then return null; end if;
  delete from perf_samples where at < now() - interval '30 days';

  -- самые тяжёлые запросы к базе (если включено расширение pg_stat_statements — в Supabase оно обычно есть)
  begin
    execute $q$
      select coalesce(json_agg(x), '[]'::json) from (
        select left(regexp_replace(query, '\s+', ' ', 'g'), 220) as q, calls::bigint as calls,
               round(mean_exec_time::numeric, 1) as mean_ms, round(total_exec_time::numeric / 1000, 1) as total_s
        from pg_stat_statements
        where dbid = (select oid from pg_database where datname = current_database())
          and query !~* '^(begin|commit|set |show |select set_config)'
        order by total_exec_time desc limit 12) x $q$ into slow;
  exception when others then slow := null;
  end;

  select json_build_object(
    'now', (select json_build_object(
        'online', count(distinct user_id), 'n', coalesce(sum(n), 0), 'err', coalesce(sum(err), 0),
        'p50', round(sum(p50 * n)::numeric / nullif(sum(n), 0)), 'p95', max(p95))
      from perf_samples where at > now() - interval '15 minutes'),
    'hour', (select json_build_object('n', coalesce(sum(n), 0), 'err', coalesce(sum(err), 0),
        'p50', round(sum(p50 * n)::numeric / nullif(sum(n), 0)),
        'p95', round(percentile_cont(0.9) within group (order by p95)::numeric))
      from perf_samples where at > now() - interval '1 hour'),
    'hours', (select coalesce(json_agg(h order by h.t), '[]'::json) from (
        select date_trunc('hour', at at time zone tz) as t, count(distinct user_id) as users, sum(n) as n, sum(err) as err,
               round(sum(p50 * n)::numeric / nullif(sum(n), 0)) as p50,
               round(percentile_cont(0.9) within group (order by p95)::numeric) as p95, max(mx) as mx
        from perf_samples where at > now() - interval '24 hours' group by 1) h),
    'days', (select coalesce(json_agg(d order by d.t), '[]'::json) from (
        select date_trunc('day', at at time zone tz)::date as t, count(distinct user_id) as users, sum(n) as n, sum(err) as err,
               round(sum(p50 * n)::numeric / nullif(sum(n), 0)) as p50,
               round(percentile_cont(0.9) within group (order by p95)::numeric) as p95
        from perf_samples where at > now() - interval '14 days' group by 1) d),
    'via', (select coalesce(json_agg(v), '[]'::json) from (
        select via, count(distinct user_id) as users, sum(n) as n,
               round(sum(p50 * n)::numeric / nullif(sum(n), 0)) as p50,
               round(percentile_cont(0.9) within group (order by p95)::numeric) as p95
        from perf_samples where at > now() - interval '24 hours' group by via) v),
    'top', (select coalesce(json_agg(t), '[]'::json) from (
        select e ->> 'p' as p, sum((e ->> 'n')::int) as n, round(sum((e ->> 'ms')::numeric) / nullif(sum((e ->> 'n')::int), 0)) as avg,
               max((e ->> 'mx')::int) as mx, round(sum((e ->> 'ms')::numeric) / 1000) as total_s
        from perf_samples s, jsonb_array_elements(coalesce(s.top, '[]'::jsonb)) e
        where s.at > now() - interval '24 hours'
        group by 1 order by sum((e ->> 'ms')::numeric) desc limit 10) t),
    'db', json_build_object(
        'bytes', pg_database_size(current_database()),
        'conns', (select count(*) from pg_stat_activity where datname = current_database()),
        'tables', (select coalesce(json_agg(t), '[]'::json) from (
            select c.relname as name, pg_total_relation_size(c.oid) as bytes, c.reltuples::bigint as rows
            from pg_class c join pg_namespace s on s.oid = c.relnamespace
            where s.nspname = 'public' and c.relkind = 'r' order by 2 desc limit 10) t)),
    'storage', (select coalesce(json_agg(b), '[]'::json) from (
        select bucket_id as bucket, count(*) as files, coalesce(sum((metadata ->> 'size')::bigint), 0) as bytes
        from storage.objects group by bucket_id order by 3 desc) b),
    'users', (select count(*) from auth.users),
    'orders', (select count(*) from orders),
    'slow', slow
  ) into res;
  return res;
end $$;
revoke all on function public.admin_load() from public, anon;
grant execute on function public.admin_load() to authenticated;

notify pgrst, 'reload schema';
