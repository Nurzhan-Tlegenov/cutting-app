-- Поддержка: ответ из «Сообщений» засчитывается в карточку обращения + общие «Задачи поддержки» (канбан команды).
-- После migration_support_board.sql и migration_tasks.sql. Выполнить в Supabase → SQL Editor целиком (можно повторно).
--
-- 1) Ответ пользователю, отправленный из «Сообщений» (kind reply) мастером или сотрудником поддержки, теперь тоже
--    отмечается в открытой карточке обращения этого пользователя: «ждёт ответа» снимается, «Новые» → «В работе»,
--    в истории карточки — «ответил (из «Сообщений»)». Уже отвеченные карточки — один раз так же (ниже).
-- 2) «Задачи поддержки» — те же таблицы, что «Мои задачи» (task_columns / task_cards), строки с team = 'support':
--    общие для мастер-аккаунта и сотрудников поддержки (is_support()). Задача может быть связана с обращением
--    (support_card_id). Личные задачи пользователей — только team пусто (как раньше).
-- Правила на orders / order_details / profiles / app_messages НЕ меняются.

-- ═══════════ 1. Ответ из «Сообщений» → карточка обращения ═══════════
create or replace function public.support_on_reply() returns trigger
language plpgsql security definer set search_path = public as $$
declare c support_cards; st text;
begin
  if new.kind <> 'reply' or new.to_id is null then return new; end if;
  -- ответ из самой карточки (support_reply) карточку уже обновил
  if coalesce(new.from_name, '') like 'Поддержка RaskroyPro%' then return new; end if;
  if not (exists (select 1 from profiles where id = new.from_id and role = 'admin')
          or exists (select 1 from support_staff where user_id = new.from_id and active)) then return new; end if;
  select * into c from support_cards where user_id = new.to_id and status not in ('done', 'rejected')
    order by created_at desc limit 1 for update;
  if not found then return new; end if;
  st := case when c.status = 'new' then 'work' else c.status end;
  update support_cards set last_staff_at = new.created_at, taken_by = coalesce(taken_by, new.from_id), status = st, updated_at = now()
    where id = c.id;
  insert into support_card_events (card_id, actor, action, from_status, to_status, note)
    values (c.id, new.from_id, 'reply', c.status, st, left('из «Сообщений»: ' || coalesce(nullif(new.body, ''), '📎 ' || new.file_name, ''), 300));
  return new;
exception when others then return new;   -- ответ важнее карточки: он уходит в любом случае
end $$;
revoke all on function public.support_on_reply() from public, anon, authenticated;
drop trigger if exists support_reply_msg on public.app_messages;
create trigger support_reply_msg after insert on public.app_messages for each row execute function public.support_on_reply();

-- уже отвеченные из «Сообщений» открытые карточки: последний ответ поддержки позже последнего сообщения автора
update support_cards c set last_staff_at = r.at,
  status = case when c.status = 'new' then 'work' else c.status end,
  taken_by = coalesce(c.taken_by, r.who), updated_at = now()
from (select distinct on (m.to_id) m.to_id, m.created_at as at, m.from_id as who
        from app_messages m where m.kind = 'reply' and m.to_id is not null order by m.to_id, m.created_at desc) r
where r.to_id = c.user_id and c.status not in ('done', 'rejected')
  and r.at >= c.created_at and (c.last_staff_at is null or r.at > c.last_staff_at)
  and (c.last_user_at is null or r.at >= c.last_user_at);

-- ═══════════ 2. Задачи поддержки ═══════════
alter table public.task_columns add column if not exists team text;
alter table public.task_cards add column if not exists team text;
alter table public.task_cards add column if not exists support_card_id uuid references public.support_cards(id) on delete set null;
create index if not exists task_columns_team on public.task_columns (team) where team is not null;
create index if not exists task_cards_team on public.task_cards (team) where team is not null;
do $$ begin
  alter table public.task_columns add constraint task_columns_team_chk check (team is null or team = 'support');
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.task_cards add constraint task_cards_team_chk check (team is null or team = 'support');
exception when duplicate_object then null; end $$;

-- личные задачи — только свои и без team (иначе любой мог бы подложить строку в задачи поддержки)
drop policy if exists "task_columns: свои" on public.task_columns;
create policy "task_columns: свои" on public.task_columns for all to authenticated
  using (user_id = auth.uid() and team is null) with check (user_id = auth.uid() and team is null);
drop policy if exists "task_cards: свои" on public.task_cards;
create policy "task_cards: свои" on public.task_cards for all to authenticated
  using (user_id = auth.uid() and team is null) with check (user_id = auth.uid() and team is null);
-- задачи поддержки — вся команда (мастер-аккаунт и активные сотрудники поддержки)
drop policy if exists "task_columns: команда поддержки" on public.task_columns;
create policy "task_columns: команда поддержки" on public.task_columns for all to authenticated
  using (team = 'support' and is_support()) with check (team = 'support' and is_support());
drop policy if exists "task_cards: команда поддержки" on public.task_cards;
create policy "task_cards: команда поддержки" on public.task_cards for all to authenticated
  using (team = 'support' and is_support()) with check (team = 'support' and is_support());

-- этапы доски поддержки по умолчанию — один раз на всю команду (двое открыли сразу — дублей не будет)
create or replace function public.support_tasks_init() returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_support() then raise exception 'not support'; end if;
  perform pg_advisory_xact_lock(hashtext('support_tasks_init'));
  if exists (select 1 from task_columns where team = 'support') then return; end if;
  insert into task_columns (user_id, team, name, sort, color) values
    (auth.uid(), 'support', 'Идеи / из головы', 1, '#7F77DD'),
    (auth.uid(), 'support', 'Надо сделать', 2, '#378ADD'),
    (auth.uid(), 'support', 'В работе', 3, '#BA7517'),
    (auth.uid(), 'support', 'Проверить', 4, '#D85A30'),
    (auth.uid(), 'support', 'Готово', 5, '#1D9E75');
end $$;
revoke all on function public.support_tasks_init() from public, anon, authenticated;
grant execute on function public.support_tasks_init() to authenticated;

-- напоминание по задаче поддержки открывает её на доске поддержки (личные — как раньше, в «Мои задачи»)
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
      case when c.team = 'support' then '/support?tasks=1&card=' || c.id else '/tasks?card=' || c.id end, 'task-' || c.id);
    update task_cards set reminded_at = now() where id = c.id;
    n := n + 1;
  end loop;
  return n;
end $$;

notify pgrst, 'reload schema';

-- Проверка (отдельно): у task_columns / task_cards по 3 правила (свои, мастер читает, команда поддержки)
-- select tablename, policyname, cmd from pg_policies where tablename in ('task_columns', 'task_cards') order by 1, 2;
