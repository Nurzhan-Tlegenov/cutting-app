-- Доска обращений техподдержки (этап 3, claude/support-spec.md). После migration_support_staff.sql.
-- Выполнить в Supabase → SQL Editor целиком (можно повторно).
--
-- Как устроено:
--   • каждое обращение / файл для отладки (app_messages, kind appeal | debug) само попадает в карточку: в открытую карточку
--     этого пользователя, а если открытой нет — в новую (колонка «Новые»). После «Сделано / Не берём» — новая карточка;
--   • ответы пользователю (kind reply) показываются в карточке по времени (пока карточка открыта);
--   • колонки: new → work (В работе) → details (Нужны подробности) → dev (Нужен разработчик) → done / rejected (архив);
--   • «Нужен разработчик» решает только мастер-аккаунт: «Берём в разработку» или «Не берём» (с причиной для пользователя);
--   • каждое действие пишется в историю карточки (кто, когда, что).
-- Безопасность: новые таблицы — без правил доступа, только через функции ниже (security definer + is_support() / is_admin()).
-- Правила на orders, order_details, profiles, app_messages НЕ меняются. На app_messages добавляется только триггер.

-- ═══════════ Таблицы ═══════════
create table if not exists public.support_cards (
  id uuid primary key default gen_random_uuid(),
  num bigint generated always as identity,
  user_id uuid not null references auth.users(id) on delete cascade,     -- автор обращения
  status text not null default 'new' check (status in ('new', 'work', 'details', 'dev', 'done', 'rejected')),
  taken_by uuid references auth.users(id) on delete set null,            -- кто занимается
  summary text,                                                          -- «Кратко» — заполняет поддержка
  dev_ok boolean,                                                        -- мастер: true — берём в разработку
  close_note text,
  legacy boolean not null default false,                                 -- старые обращения (до доски)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz,
  last_user_at timestamptz,
  last_staff_at timestamptz
);
create index if not exists support_cards_user on public.support_cards (user_id, created_at desc);
create index if not exists support_cards_status on public.support_cards (status);

create table if not exists public.support_card_msgs (
  card_id uuid not null references public.support_cards(id) on delete cascade,
  message_id uuid not null references public.app_messages(id) on delete cascade,
  primary key (card_id, message_id)
);
create index if not exists support_card_msgs_msg on public.support_card_msgs (message_id);

create table if not exists public.support_card_events (
  id bigint generated always as identity primary key,
  card_id uuid not null references public.support_cards(id) on delete cascade,
  actor uuid references auth.users(id) on delete set null,
  action text not null,           -- created | message | take | move | assign | reply | summary | dev_take | dev_reject | close | reopen | merge
  from_status text,
  to_status text,
  note text,
  at timestamptz not null default now()
);
create index if not exists support_card_events_card on public.support_card_events (card_id, at);

alter table public.support_cards enable row level security;
alter table public.support_card_msgs enable row level security;
alter table public.support_card_events enable row level security;
revoke all on public.support_cards, public.support_card_msgs, public.support_card_events from anon, authenticated;

-- ═══════════ Вспомогательное ═══════════
create or replace function public.support_name(p_user uuid) returns text
language sql security definer set search_path = public stable as $$
  select coalesce((select nullif(trim(full_name), '') from profiles where id = p_user), 'Пользователь')
$$;

create or replace function public.support_log(p_card uuid, p_action text, p_from text default null, p_to text default null, p_note text default null)
returns void language sql security definer set search_path = public as $$
  insert into support_card_events (card_id, actor, action, from_status, to_status, note)
    values (p_card, auth.uid(), p_action, p_from, p_to, nullif(left(trim(coalesce(p_note, '')), 2000), ''));
  update support_cards set updated_at = now() where id = p_card;
$$;

-- уведомление сотрудникам поддержки (мастер-аккаунт получает свои уведомления об обращениях и так)
create or replace function public.support_push(p_users uuid[], p_title text, p_body text, p_url text, p_tag text) returns void
language plpgsql security definer set search_path = public as $$
declare u uuid;
begin
  foreach u in array coalesce(p_users, '{}'::uuid[]) loop
    if not exists (select 1 from profiles where id = u and role = 'admin') then
      begin perform push_enqueue(u, p_title, p_body, p_url, p_tag); exception when others then null; end;
    end if;
  end loop;
end $$;

-- ═══════════ Обращение → карточка (триггер на app_messages) ═══════════
create or replace function public.support_on_message() returns trigger
language plpgsql security definer set search_path = public as $$
declare c support_cards; fresh boolean := false; nm text;
begin
  if new.kind not in ('appeal', 'debug') or new.to_id is not null then return new; end if;
  if exists (select 1 from profiles where id = new.from_id and role = 'admin') then return new; end if;
  select * into c from support_cards where user_id = new.from_id and status not in ('done', 'rejected')
    order by created_at desc limit 1 for update;
  if not found then
    insert into support_cards (user_id, last_user_at) values (new.from_id, new.created_at) returning * into c;
    insert into support_card_events (card_id, actor, action, to_status) values (c.id, new.from_id, 'created', 'new');
    fresh := true;
  else
    update support_cards set last_user_at = new.created_at, updated_at = now(),
      status = case when status = 'details' then (case when taken_by is not null then 'work' else 'new' end) else status end
      where id = c.id returning * into c;
    insert into support_card_events (card_id, actor, action, to_status, note)
      values (c.id, new.from_id, 'message', c.status, case when new.kind = 'debug' then 'файл: ' || coalesce(new.file_name, '') end);
  end if;
  insert into support_card_msgs (card_id, message_id) values (c.id, new.id) on conflict do nothing;
  nm := support_name(new.from_id);
  begin
    if fresh then
      perform support_push(array(select user_id from support_staff where active), 'Поддержка: новое обращение · ' || nm,
        left(coalesce(nullif(new.body, ''), new.file_name, ''), 140), '/support/' || c.id, 'sup:' || c.id);
    elsif c.taken_by is not null then
      perform support_push(array[c.taken_by], 'Поддержка: ' || nm || ' пишет (№' || c.num || ')',
        left(coalesce(nullif(new.body, ''), new.file_name, ''), 140), '/support/' || c.id, 'sup:' || c.id);
    end if;
  exception when others then null;
  end;
  return new;
exception when others then return new;   -- карточка не важнее самого обращения: оно сохраняется в любом случае
end $$;

-- ═══════════ Старые обращения: одной карточкой на пользователя в «Новых» (только один раз) ═══════════
do $$
declare u uuid; cid uuid; first_at timestamptz; last_at timestamptz;
begin
  if exists (select 1 from support_cards) then return; end if;
  for u, first_at, last_at in
    select m.from_id, min(m.created_at), max(m.created_at) from app_messages m
    where m.kind in ('appeal', 'debug') and m.to_id is null
      and not exists (select 1 from profiles p where p.id = m.from_id and p.role = 'admin')
    group by m.from_id
  loop
    insert into support_cards (user_id, legacy, created_at, last_user_at) values (u, true, first_at, last_at) returning id into cid;
    insert into support_card_msgs (card_id, message_id)
      select cid, m.id from app_messages m where m.from_id = u and m.kind in ('appeal', 'debug') and m.to_id is null;
    insert into support_card_events (card_id, actor, action, to_status, note, at) values (cid, null, 'created', 'new', 'старые обращения (до доски)', now());
  end loop;
end $$;

drop trigger if exists support_message on public.app_messages;
create trigger support_message after insert on public.app_messages for each row execute function public.support_on_message();

-- ═══════════ Краткая карточка автора (без телефона) ═══════════
create or replace function public.support_user_brief(p_user uuid) returns json
language plpgsql security definer set search_path = public stable as $$
begin
  if not is_support() then raise exception 'not support'; end if;
  return (select json_build_object(
    'user_id', p.id, 'full_name', p.full_name, 'country', p.country, 'city', p.city,
    'since', (select created_at from auth.users where id = p.id),
    'production', (select json_build_object('name', x.name, 'city', x.city, 'country', x.country, 'status', x.status)
                     from productions x where x.owner_id = p.id limit 1),
    'works_at', (select coalesce(json_agg(json_build_object('name', x.name, 'city', x.city)), '[]'::json)
                   from production_members m join productions x on x.id = m.production_id where m.user_id = p.id and m.active),
    'posts_granted', (select coalesce(json_agg(s.name order by s.name), '[]'::json)
                        from shared_post_access a join shared_posts s on s.id = a.post_id where a.user_id = p.id),
    'posts_used', (select coalesce(json_agg(distinct u.post_name), '[]'::json)
                     from post_usage u where u.user_id = p.id and u.created_at > now() - interval '180 days' and coalesce(u.post_name, '') <> ''),
    'machines', (select coalesce(json_agg(distinct nullif(trim(concat_ws(' · ', r.machine, r.controller)), '')), '[]'::json)
                   from post_requests r where r.user_id = p.id),
    'orders', (select count(*) from orders o where o.user_id = p.id))
  from profiles p where p.id = p_user);
exception when undefined_table or undefined_column then
  return (select json_build_object('user_id', p.id, 'full_name', p.full_name, 'country', p.country, 'city', p.city) from profiles p where p.id = p_user);
end $$;

-- ═══════════ Доска ═══════════
-- p_archive: false — открытые карточки; true — архив (Сделано / Не берём), с поиском p_q (имя, «кратко», текст сообщений)
create or replace function public.support_board(p_archive boolean default false, p_q text default '') returns json
language plpgsql security definer set search_path = public stable as $$
declare q text := lower(trim(coalesce(p_q, '')));
begin
  if not is_support() then raise exception 'not support'; end if;
  return (select coalesce(json_agg(x order by x.sort_at desc), '[]'::json) from (
    select c.id, c.num, c.status, c.user_id, c.taken_by, c.summary, c.dev_ok, c.legacy, c.close_note,
      c.created_at, c.updated_at, c.closed_at, c.last_user_at, c.last_staff_at,
      coalesce(c.closed_at, greatest(c.last_user_at, c.last_staff_at, c.updated_at)) as sort_at,
      support_name(c.user_id) as author, p.country, p.city,
      case when c.taken_by is not null then support_name(c.taken_by) end as taken_name,
      (select count(*) from support_card_msgs l where l.card_id = c.id) as msgs,
      (select count(*) from support_card_msgs l join app_messages m on m.id = l.message_id where l.card_id = c.id and m.file_name is not null) as files,
      (select left(coalesce(nullif(m.body, ''), '📎 ' || m.file_name, ''), 200) from support_card_msgs l join app_messages m on m.id = l.message_id
         where l.card_id = c.id order by m.created_at desc limit 1) as last_text
    from support_cards c left join profiles p on p.id = c.user_id
    where (case when p_archive then c.status in ('done', 'rejected') else c.status not in ('done', 'rejected') end)
      and (q = '' or lower(coalesce(p.full_name, '') || ' ' || coalesce(c.summary, '') || ' ' || coalesce(c.close_note, '') || ' ' || coalesce(p.city, '') || ' ' || c.num::text) like '%' || q || '%'
           or exists (select 1 from support_card_msgs l join app_messages m on m.id = l.message_id
                      where l.card_id = c.id and lower(coalesce(m.body, '') || ' ' || coalesce(m.file_name, '')) like '%' || q || '%'))
    order by coalesce(c.closed_at, greatest(c.last_user_at, c.last_staff_at, c.updated_at)) desc
    limit case when p_archive then 200 else 1000 end) x);
end $$;

-- ═══════════ Одна карточка: автор, переписка (без содержимого файлов), история ═══════════
create or replace function public.support_card(p_id uuid) returns json
language plpgsql security definer set search_path = public stable as $$
declare c support_cards;
begin
  if not is_support() then raise exception 'not support'; end if;
  select * into c from support_cards where id = p_id;
  if not found then return null; end if;
  return json_build_object(
    'card', (select row_to_json(z) from (select c.*, support_name(c.user_id) as author,
              case when c.taken_by is not null then support_name(c.taken_by) end as taken_name) z),
    'author', support_user_brief(c.user_id),
    'messages', (select coalesce(json_agg(m order by m.created_at), '[]'::json) from (
      select m.id, m.created_at, m.kind, m.title, m.body, m.file_name, m.file_size, m.order_id,
        (m.kind = 'reply') as staff, case when m.kind = 'reply' then support_name(m.from_id) end as staff_name, m.read_at
      from app_messages m
      where m.id in (select message_id from support_card_msgs where card_id = c.id)
         or (m.kind = 'reply' and m.to_id = c.user_id and m.created_at >= c.created_at
             and m.created_at <= coalesce(c.closed_at, now()) + interval '1 minute')) m),
    'events', (select coalesce(json_agg(e order by e.at), '[]'::json) from (
      select e.at, e.action, e.from_status, e.to_status, e.note,
        case when e.actor = c.user_id then 'автор' when e.actor is null then 'система' else support_name(e.actor) end as actor_name
      from support_card_events e where e.card_id = c.id) e),
    'others', (select coalesce(json_agg(json_build_object('id', o.id, 'num', o.num, 'status', o.status, 'created_at', o.created_at) order by o.created_at desc), '[]'::json)
                 from support_cards o where o.user_id = c.user_id and o.id <> c.id));
end $$;

-- файл из переписки карточки (обращение / файл для отладки / ответ) -> { payload, file_name }
create or replace function public.support_file(p_msg uuid) returns json
language plpgsql security definer set search_path = public stable as $$
begin
  if not is_support() then raise exception 'not support'; end if;
  return (select json_build_object('payload', m.payload, 'file_name', m.file_name) from app_messages m
    where m.id = p_msg and m.kind in ('appeal', 'debug', 'reply')
      and exists (select 1 from support_cards c where c.user_id = case when m.kind = 'reply' then m.to_id else m.from_id end));
end $$;

-- ═══════════ Действия ═══════════
create or replace function public.support_take(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare c support_cards;
begin
  if not is_support() then raise exception 'not support'; end if;
  select * into c from support_cards where id = p_id for update;
  if not found or c.status in ('done', 'rejected') then raise exception 'card closed'; end if;
  update support_cards set taken_by = auth.uid(), status = case when status = 'new' then 'work' else status end where id = p_id;
  perform support_log(p_id, 'take', c.status, case when c.status = 'new' then 'work' else c.status end,
    case when c.taken_by is not null and c.taken_by <> auth.uid() then 'забрал у ' || support_name(c.taken_by) end);
end $$;

-- передать другому сотруднику поддержки (или мастеру)
create or replace function public.support_assign(p_id uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare c support_cards;
begin
  if not is_support() then raise exception 'not support'; end if;
  if not (exists (select 1 from support_staff where user_id = p_user and active) or exists (select 1 from profiles where id = p_user and role = 'admin'))
    then raise exception 'not in team'; end if;
  select * into c from support_cards where id = p_id for update;
  if not found or c.status in ('done', 'rejected') then raise exception 'card closed'; end if;
  update support_cards set taken_by = p_user, status = case when status = 'new' then 'work' else status end where id = p_id;
  perform support_log(p_id, 'assign', c.status, case when c.status = 'new' then 'work' else c.status end, 'передал: ' || support_name(p_user));
  perform support_push(array[p_user], 'Поддержка: вам передали обращение №' || c.num, support_name(c.user_id), '/support/' || p_id, 'sup:' || p_id);
end $$;

-- перенести в колонку: new (вернуть в «Новые» — никто не занимается) | work | details | dev
create or replace function public.support_move(p_id uuid, p_status text, p_note text default '') returns void
language plpgsql security definer set search_path = public as $$
declare c support_cards;
begin
  if not is_support() then raise exception 'not support'; end if;
  if p_status not in ('new', 'work', 'details', 'dev') then raise exception 'bad status'; end if;
  select * into c from support_cards where id = p_id for update;
  if not found or c.status in ('done', 'rejected') then raise exception 'card closed'; end if;
  update support_cards set status = p_status,
    taken_by = case when p_status = 'new' then null when taken_by is null then auth.uid() else taken_by end,
    dev_ok = case when p_status = 'dev' then dev_ok else null end
    where id = p_id;
  perform support_log(p_id, 'move', c.status, p_status, p_note);
  if p_status = 'dev' and c.status <> 'dev' then
    begin perform push_admins('Поддержка: нужен разработчик (№' || c.num || ')', support_name(c.user_id) || coalesce(' — ' || nullif(c.summary, ''), ''), '/support/' || p_id, 'sup:' || p_id);
    exception when others then null; end;
  end if;
end $$;

-- ответ пользователю из карточки: придёт ему в «Сообщения» и пушем («Ответ от RaskroyPro»). p_status — сразу перенести (например, details)
create or replace function public.support_reply(p_id uuid, p_body text, p_status text default null) returns void
language plpgsql security definer set search_path = public as $$
declare c support_cards; b text := left(trim(coalesce(p_body, '')), 8000);
begin
  if not is_support() then raise exception 'not support'; end if;
  if b = '' then raise exception 'empty'; end if;
  select * into c from support_cards where id = p_id for update;
  if not found then raise exception 'no card'; end if;
  insert into app_messages (from_id, from_name, to_id, kind, body)
    values (auth.uid(), 'Поддержка RaskroyPro · ' || support_name(auth.uid()) || ' → ' || support_name(c.user_id), c.user_id, 'reply', b);
  update support_cards set last_staff_at = now(),
    taken_by = coalesce(taken_by, auth.uid()),
    status = case when p_status in ('work', 'details', 'dev') and status not in ('done', 'rejected') then p_status
                  when status = 'new' then 'work' else status end
    where id = p_id;
  perform support_log(p_id, 'reply', c.status, (select status from support_cards where id = p_id), left(b, 300));
end $$;

create or replace function public.support_set_summary(p_id uuid, p_text text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_support() then raise exception 'not support'; end if;
  update support_cards set summary = nullif(left(trim(coalesce(p_text, '')), 1000), '') where id = p_id;
  if not found then raise exception 'no card'; end if;
  perform support_log(p_id, 'summary', null, null, p_text);
end $$;

-- «Нужен разработчик»: решает только мастер-аккаунт. take=true — «Берём в разработку» (карточка остаётся, пока не сделано);
-- take=false — «Не берём»: карточка в архив, пользователю уходит причина (p_note обязателен)
create or replace function public.support_dev_decide(p_id uuid, p_take boolean, p_note text default '') returns void
language plpgsql security definer set search_path = public as $$
declare c support_cards; n text := trim(coalesce(p_note, ''));
begin
  if not is_admin() then raise exception 'not admin'; end if;
  select * into c from support_cards where id = p_id for update;
  if not found or c.status in ('done', 'rejected') then raise exception 'card closed'; end if;
  if p_take then
    update support_cards set status = 'dev', dev_ok = true where id = p_id;
    perform support_log(p_id, 'dev_take', c.status, 'dev', n);
    if n <> '' then perform support_reply(p_id, n, 'dev'); end if;
  else
    if n = '' then raise exception 'need reason'; end if;
    perform support_reply(p_id, n, null);
    update support_cards set status = 'rejected', dev_ok = false, closed_at = now(), close_note = left(n, 1000) where id = p_id;
    perform support_log(p_id, 'dev_reject', c.status, 'rejected', n);
  end if;
end $$;

-- «Сделано» / «Не берём»: пользователю уходит сообщение (для «Не берём» — обязательно), карточка в архив.
-- Карточку в «Нужен разработчик» закрывает только мастер-аккаунт.
create or replace function public.support_close(p_id uuid, p_status text, p_message text default '') returns void
language plpgsql security definer set search_path = public as $$
declare c support_cards; n text := trim(coalesce(p_message, ''));
begin
  if not is_support() then raise exception 'not support'; end if;
  if p_status not in ('done', 'rejected') then raise exception 'bad status'; end if;
  select * into c from support_cards where id = p_id for update;
  if not found or c.status in ('done', 'rejected') then raise exception 'card closed'; end if;
  if c.status = 'dev' and not is_admin() then raise exception 'dev is master'; end if;
  if p_status = 'rejected' and n = '' then raise exception 'need reason'; end if;
  if n <> '' then perform support_reply(p_id, n, null); end if;
  update support_cards set status = p_status, closed_at = now(), close_note = nullif(left(n, 1000), ''),
    taken_by = coalesce(taken_by, auth.uid()) where id = p_id;
  perform support_log(p_id, 'close', c.status, p_status, n);
end $$;

-- вернуть из архива
create or replace function public.support_reopen(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare c support_cards;
begin
  if not is_support() then raise exception 'not support'; end if;
  select * into c from support_cards where id = p_id for update;
  if not found or c.status not in ('done', 'rejected') then raise exception 'not closed'; end if;
  if exists (select 1 from support_cards where user_id = c.user_id and id <> c.id and status not in ('done', 'rejected'))
    then raise exception 'has open'; end if;
  update support_cards set status = case when taken_by is not null then 'work' else 'new' end, closed_at = null where id = p_id;
  perform support_log(p_id, 'reopen', c.status, (select status from support_cards where id = p_id), null);
end $$;

-- объединить две карточки одного пользователя: сообщения и история из p_from переходят в p_into, p_from удаляется
create or replace function public.support_merge(p_from uuid, p_into uuid) returns void
language plpgsql security definer set search_path = public as $$
declare a support_cards; b support_cards;
begin
  if not is_support() then raise exception 'not support'; end if;
  select * into a from support_cards where id = p_from for update;
  select * into b from support_cards where id = p_into for update;
  if a.id is null or b.id is null or a.id = b.id or a.user_id <> b.user_id then raise exception 'bad merge'; end if;
  insert into support_card_msgs (card_id, message_id) select p_into, message_id from support_card_msgs where card_id = p_from on conflict do nothing;
  update support_card_events set card_id = p_into where card_id = p_from;
  update support_cards set created_at = least(a.created_at, b.created_at),
    last_user_at = greatest(a.last_user_at, b.last_user_at), last_staff_at = greatest(a.last_staff_at, b.last_staff_at),
    summary = coalesce(b.summary, a.summary) where id = p_into;
  delete from support_cards where id = p_from;
  perform support_log(p_into, 'merge', null, null, 'объединено с №' || a.num);
end $$;

-- мастер: все старые карточки (до доски), ещё не тронутые, — разом в архив (без сообщений пользователям)
create or replace function public.support_archive_legacy() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not is_admin() then raise exception 'not admin'; end if;
  with x as (
    update support_cards set status = 'done', closed_at = now(), close_note = 'старое обращение — в архив'
      where legacy and status = 'new' and taken_by is null returning id)
  select count(*) into n from x;
  insert into support_card_events (card_id, actor, action, from_status, to_status, note)
    select id, auth.uid(), 'close', 'new', 'done', 'старые обращения — разом в архив' from support_cards
    where legacy and status = 'done' and close_note = 'старое обращение — в архив' and closed_at > now() - interval '1 minute';
  return n;
end $$;

revoke all on function public.support_name(uuid), public.support_log(uuid, text, text, text, text), public.support_push(uuid[], text, text, text, text),
  public.support_on_message(), public.support_user_brief(uuid), public.support_board(boolean, text), public.support_card(uuid),
  public.support_file(uuid), public.support_take(uuid), public.support_assign(uuid, uuid), public.support_move(uuid, text, text),
  public.support_reply(uuid, text, text), public.support_set_summary(uuid, text), public.support_dev_decide(uuid, boolean, text),
  public.support_close(uuid, text, text), public.support_reopen(uuid), public.support_merge(uuid, uuid), public.support_archive_legacy()
  from public, anon, authenticated;
grant execute on function public.support_user_brief(uuid), public.support_board(boolean, text), public.support_card(uuid),
  public.support_file(uuid), public.support_take(uuid), public.support_assign(uuid, uuid), public.support_move(uuid, text, text),
  public.support_reply(uuid, text, text), public.support_set_summary(uuid, text), public.support_dev_decide(uuid, boolean, text),
  public.support_close(uuid, text, text), public.support_reopen(uuid), public.support_merge(uuid, uuid), public.support_archive_legacy()
  to authenticated;

notify pgrst, 'reload schema';

-- Проверка (отдельно): у support_cards / support_card_msgs / support_card_events правил нет;
-- у orders / order_details / profiles / app_messages — те же 13, что были.
-- select tablename, policyname, cmd from pg_policies
--   where tablename in ('support_cards', 'support_card_msgs', 'support_card_events', 'orders', 'order_details', 'profiles', 'app_messages') order by 1, 2;
