-- Мои задачи (канбан клиента): свои этапы-колонки (замер, закуп материала, …), карточки-задачи с подзадачами,
-- сроком и напоминанием, связь с заказом. Выполнить один раз в Supabase → SQL Editor (можно повторно).
--
-- Кто видит: только сам пользователь. Мастер-аккаунт — всё (только чтение), чтобы понимать, пользуются ли инструментом.
-- Напоминание приходит push-уведомлением (и в Telegram, если push не включён) — через pg_cron раз в минуту.
-- Если pg_cron не включён: Supabase → Database → Extensions → pg_cron → Enable, затем выполнить этот файл ещё раз.

create table if not exists public.task_columns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null default 'Новый этап',
  color text,
  sort double precision not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists task_columns_user on public.task_columns (user_id, sort);

create table if not exists public.task_cards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  column_id uuid references public.task_columns(id) on delete cascade,
  title text not null default '',
  note text,
  checklist jsonb not null default '[]'::jsonb,        -- подзадачи: [{ id, t, done }]
  due_at timestamptz,                                   -- срок
  remind_at timestamptz,                                -- когда напомнить
  reminded_at timestamptz,                              -- напоминание уже ушло
  order_id uuid references public.orders(id) on delete set null,
  sort double precision not null default 0,
  done_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists task_cards_user on public.task_cards (user_id, column_id, sort);
create index if not exists task_cards_remind on public.task_cards (remind_at) where reminded_at is null and remind_at is not null;

alter table public.task_columns enable row level security;
alter table public.task_cards enable row level security;
drop policy if exists "task_columns: свои" on public.task_columns;
create policy "task_columns: свои" on public.task_columns for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "task_columns: мастер читает" on public.task_columns;
create policy "task_columns: мастер читает" on public.task_columns for select to authenticated using (is_admin());
drop policy if exists "task_cards: свои" on public.task_cards;
create policy "task_cards: свои" on public.task_cards for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "task_cards: мастер читает" on public.task_cards;
create policy "task_cards: мастер читает" on public.task_cards for select to authenticated using (is_admin());

-- срок / напоминание поменялись — напоминание уходит заново
create or replace function public.task_cards_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  if new.remind_at is distinct from old.remind_at then new.reminded_at := null; end if;
  return new;
end $$;
drop trigger if exists task_cards_touch on public.task_cards;
create trigger task_cards_touch before update on public.task_cards for each row execute function public.task_cards_touch();

-- напоминания: что подошло — в очередь push (раз в минуту, pg_cron)
create or replace function public.task_remind() returns integer
language plpgsql security definer set search_path = public as $$
declare c record; n int := 0; left_ int; total int;
begin
  for c in select * from task_cards
           where remind_at is not null and remind_at <= now() and reminded_at is null and done_at is null and archived_at is null
             and remind_at > now() - interval '1 day'
           order by remind_at limit 200 loop
    select count(*) filter (where coalesce((x ->> 'done')::boolean, false) = false), count(*) into left_, total
      from jsonb_array_elements(case when jsonb_typeof(c.checklist) = 'array' then c.checklist else '[]'::jsonb end) x;
    perform push_enqueue(c.user_id, '⏰ ' || coalesce(nullif(c.title, ''), 'Задача'),
      concat_ws(' · ',
        case when total > 0 then format('подзадач осталось %s из %s', left_, total) end,
        nullif(left(coalesce(c.note, ''), 120), '')),
      '/tasks?card=' || c.id, 'task-' || c.id);
    update task_cards set reminded_at = now() where id = c.id;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.task_remind() from public, anon, authenticated;

do $$
begin
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname = 'task-remind';
  perform cron.schedule('task-remind', '* * * * *', 'select public.task_remind()');
  raise notice 'Напоминания включены (pg_cron, раз в минуту)';
exception when others then
  raise notice 'pg_cron не включён — напоминания не уйдут. Supabase → Database → Extensions → pg_cron → Enable, затем выполните файл ещё раз. (%)', sqlerrm;
end $$;

-- мастер-аккаунт: кто и как пользуется задачами за период (0 — всё время)
create or replace function public.admin_task_stats(p_days integer default 30) returns json
language plpgsql security definer set search_path = public stable as $$
declare since timestamptz := case when coalesce(p_days, 0) > 0 then now() - make_interval(days => p_days) end;
begin
  if not is_admin() then return null; end if;
  return json_build_object(
    'users', (select count(distinct user_id) from task_cards),
    'active', (select count(distinct user_id) from task_cards where since is null or updated_at >= since),
    'cards', (select count(*) from task_cards),
    'created', (select count(*) from task_cards where since is null or created_at >= since),
    'done', (select count(*) from task_cards where done_at is not null and (since is null or done_at >= since)),
    'linked', (select count(*) from task_cards where order_id is not null),
    'reminders', (select count(*) from task_cards where remind_at is not null),
    'list', coalesce((select json_agg(r order by r.last desc) from (
      select c.user_id as id, coalesce(p.full_name, u.email) as name, count(*) as cards,
             count(*) filter (where c.done_at is not null) as done, max(c.updated_at) as last,
             (select count(*) from task_columns k where k.user_id = c.user_id) as columns
        from task_cards c join auth.users u on u.id = c.user_id left join profiles p on p.id = c.user_id
        group by c.user_id, p.full_name, u.email) r), '[]'::json));
end $$;
revoke all on function public.admin_task_stats(integer) from public, anon;
grant execute on function public.admin_task_stats(integer) to authenticated;
notify pgrst, 'reload schema';
