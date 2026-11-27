-- Партнёры RaskroyPro (особый статус, «ключ» как у постпроцессоров): мастер-аккаунт выдаёт статус пользователю —
-- технологу-внедренцу. Кого партнёр пригласил своими обычными ссылками («Пригласить производство», «Пригласить знакомого»,
-- migration_ref_links.sql) — закрепляется за ним сам (и те, кого он пригласил до выдачи статуса). Мастер может закрепить и вручную.
-- Обращения закреплённых пользователей идут партнёру: он видит в «Поддержке» только своих и отвечает им; может передать
-- задачу разработчику («Нужен разработчик» → мастер-аккаунт). Мастер-аккаунт видит всё, с пометкой «партнёр: …»;
-- обычные сотрудники поддержки обращения клиентов партнёра не видят. Пуш о новом обращении — партнёру, не мастеру.
-- Выполнить один раз в Supabase -> SQL Editor (можно повторно), ПОСЛЕ всех migration_support_*.sql.

create table if not exists public.partners (
  user_id uuid primary key references auth.users(id) on delete cascade,
  title text,                                 -- как называть партнёра (необязательно)
  active boolean not null default true,
  added_by uuid references auth.users(id) on delete set null,
  added_at timestamptz not null default now()
);
create table if not exists public.partner_clients (
  user_id uuid primary key references auth.users(id) on delete cascade,      -- приглашённый (один партнёр на пользователя)
  partner_id uuid not null references auth.users(id) on delete cascade,
  at timestamptz not null default now()
);
create index if not exists partner_clients_partner on public.partner_clients (partner_id);
alter table public.partners enable row level security;
alter table public.partner_clients enable row level security;
revoke all on public.partners, public.partner_clients from anon, authenticated;

create or replace function public.is_partner() returns boolean
language sql security definer set search_path = public stable as $$
  select auth.uid() is not null and exists (select 1 from partners where user_id = auth.uid() and active)
$$;
-- действующий партнёр пользователя (null — нет)
create or replace function public.partner_of(p_user uuid) returns uuid
language sql security definer set search_path = public stable as $$
  select c.partner_id from partner_clients c join partners p on p.user_id = c.partner_id and p.active where c.user_id = p_user
$$;
-- можно ли текущему работать с обращениями пользователя: мастер — всегда; поддержка — кроме клиентов партнёров; партнёр — только свои
create or replace function public.support_user_ok(p_user uuid) returns boolean
language sql security definer set search_path = public stable as $$
  select is_admin() or (is_support() and partner_of(p_user) is null) or (partner_of(p_user) = auth.uid())
$$;
create or replace function public.support_card_ok(p_card uuid) returns boolean
language sql security definer set search_path = public stable as $$
  select coalesce((select support_user_ok(user_id) from support_cards where id = p_card), false)
$$;

-- роль в поддержке для приложения: 'full' (мастер / сотрудник) | 'partner' | null
create or replace function public.support_role() returns text
language sql security definer set search_path = public stable as $$
  select case when is_support() then 'full' when is_partner() then 'partner' end
$$;

-- ── мастер: партнёры ──
create or replace function public.admin_partners() returns json
language plpgsql security definer set search_path = public stable as $$
begin
  if not is_admin() then raise exception 'not admin'; end if;
  return (select coalesce(json_agg(x order by x.active desc, x.added_at), '[]'::json) from (
    select p.user_id, p.title, p.active, p.added_at, pr.full_name, pr.phone,
      (select count(*) from partner_clients c where c.partner_id = p.user_id) as clients
    from partners p left join profiles pr on pr.id = p.user_id) x);
end $$;
-- выдать / снять статус. Снятие не удаляет — клиенты остаются за ним, но их обращения снова идут мастеру и поддержке
create or replace function public.admin_set_partner(p_user uuid, p_on boolean, p_title text default null) returns json
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'not admin'; end if;
  if not exists (select 1 from auth.users where id = p_user) then raise exception 'no user'; end if;
  insert into partners (user_id, title, active, added_by) values (p_user, nullif(trim(p_title), ''), p_on, auth.uid())
    on conflict (user_id) do update set active = p_on, title = coalesce(nullif(trim(p_title), ''), partners.title);
  -- кого он уже пригласил своими ссылками — закрепить за ним (кто ещё ни за кем не закреплён)
  if p_on then
    insert into partner_clients (user_id, partner_id)
      select distinct a.user_id, p_user from ref_accepts a where a.ref_by = p_user and a.user_id <> p_user
      on conflict (user_id) do nothing;
  end if;
  return (select row_to_json(p) from partners p where p.user_id = p_user);
exception when undefined_table then
  return (select row_to_json(p) from partners p where p.user_id = p_user);
end $$;
-- приняли ссылку-приглашение партнёра — закрепить за ним (один раз; уже закреплён — не меняется)
create or replace function public.trg_partner_ref() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.ref_by is not null and new.ref_by <> new.user_id and exists (select 1 from partners where user_id = new.ref_by and active) then
    insert into partner_clients (user_id, partner_id) values (new.user_id, new.ref_by) on conflict (user_id) do nothing;
    if found then
      begin perform push_enqueue(new.ref_by, 'Новый клиент по вашей ссылке', support_name(new.user_id), '/partner', 'partner:' || new.user_id); exception when others then null; end;
    end if;
  end if;
  return new;
exception when others then return new;   -- закрепление не должно мешать приглашению
end $$;
do $$ begin
  if to_regclass('public.ref_accepts') is not null then
    execute 'drop trigger if exists partner_ref on public.ref_accepts';
    execute 'create trigger partner_ref after insert on public.ref_accepts for each row execute function public.trg_partner_ref()';
  end if;
end $$;
-- мастер: закрепить / открепить пользователя вручную (p_partner null — открепить)
create or replace function public.admin_set_partner_client(p_user uuid, p_partner uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'not admin'; end if;
  if p_partner is null then delete from partner_clients where user_id = p_user; return; end if;
  if not exists (select 1 from partners where user_id = p_partner) then raise exception 'not partner'; end if;
  if p_user = p_partner then raise exception 'self'; end if;
  insert into partner_clients (user_id, partner_id) values (p_user, p_partner)
    on conflict (user_id) do update set partner_id = excluded.partner_id, at = now();
end $$;
-- мастер: кто за каким партнёром (для пометок в списке пользователей) -> { user_id: { id, name } }
create or replace function public.admin_partner_map() returns json
language plpgsql security definer set search_path = public stable as $$
begin
  if not is_admin() then raise exception 'not admin'; end if;
  return (select coalesce(json_object_agg(c.user_id, json_build_object('id', c.partner_id, 'name', support_name(c.partner_id))), '{}'::json) from partner_clients c);
end $$;

-- ── партнёр: мои клиенты ──
create or replace function public.partner_me() returns json
language plpgsql security definer set search_path = public stable as $$
begin
  if not is_partner() then return null; end if;
  return (select json_build_object('title', p.title, 'clients', (
    select coalesce(json_agg(json_build_object('user_id', c.user_id, 'at', c.at, 'name', pr.full_name, 'city', pr.city, 'country', pr.country,
        'production', (select x.name from productions x where x.owner_id = c.user_id limit 1),
        'production_status', (select x.status from productions x where x.owner_id = c.user_id limit 1),
        'orders', (select count(*) from orders o where o.user_id = c.user_id or o.production_id in (select id from productions where owner_id = c.user_id)))
      order by c.at desc), '[]'::json)
    from partner_clients c left join profiles pr on pr.id = c.user_id where c.partner_id = p.user_id))
  from partners p where p.user_id = auth.uid());
end $$;

revoke all on function public.is_partner(), public.partner_of(uuid), public.support_user_ok(uuid), public.support_card_ok(uuid) from public, anon;
grant execute on function public.is_partner(), public.support_role(), public.partner_me(),
  public.admin_partners(), public.admin_set_partner(uuid, boolean, text), public.admin_set_partner_client(uuid, uuid), public.admin_partner_map() to authenticated;

-- ═══════════ Поддержка: те же функции, но с учётом партнёров ═══════════
create or replace function public.support_user_brief(p_user uuid) returns json
language plpgsql security definer set search_path = public stable as $$
begin
  if not support_user_ok(p_user) then raise exception 'not support'; end if;
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
    'orders', (select count(*) from orders o where o.user_id = p.id),
    'partner', (select support_name(pc.partner_id) from partner_clients pc where pc.user_id = p.id))
  from profiles p where p.id = p_user);
exception when undefined_table or undefined_column then
  return (select json_build_object('user_id', p.id, 'full_name', p.full_name, 'country', p.country, 'city', p.city) from profiles p where p.id = p_user);
end $$;

create or replace function public.support_board(p_archive boolean default false, p_q text default '') returns json
language plpgsql security definer set search_path = public stable as $$
declare q text := lower(trim(coalesce(p_q, '')));
begin
  if not (is_support() or is_partner()) then raise exception 'not support'; end if;
  return (select coalesce(json_agg(x order by x.sort_at desc), '[]'::json) from (
    select c.id, c.num, c.status, c.user_id, c.taken_by, c.summary, c.dev_ok, c.legacy, c.close_note,
      c.created_at, c.updated_at, c.closed_at, c.last_user_at, c.last_staff_at,
      coalesce(c.closed_at, greatest(c.last_user_at, c.last_staff_at, c.updated_at)) as sort_at,
      support_name(c.user_id) as author, p.country, p.city,
      (select support_name(pc.partner_id) from partner_clients pc join partners pp on pp.user_id = pc.partner_id and pp.active where pc.user_id = c.user_id) as partner_name,
      case when c.taken_by is not null then support_name(c.taken_by) end as taken_name,
      (select count(*) from support_card_msgs l where l.card_id = c.id) as msgs,
      (select count(*) from support_card_msgs l join app_messages m on m.id = l.message_id where l.card_id = c.id and m.file_name is not null) as files,
      (select left(coalesce(nullif(m.body, ''), '📎 ' || m.file_name, ''), 200) from support_card_msgs l join app_messages m on m.id = l.message_id
         where l.card_id = c.id order by m.created_at desc limit 1) as last_text
    from support_cards c left join profiles p on p.id = c.user_id
    where support_user_ok(c.user_id) and ((case when p_archive then c.status in ('done', 'rejected') else c.status not in ('done', 'rejected') end)
      and (q = '' or lower(coalesce(p.full_name, '') || ' ' || coalesce(c.summary, '') || ' ' || coalesce(c.close_note, '') || ' ' || coalesce(p.city, '') || ' ' || c.num::text) like '%' || q || '%'
           or exists (select 1 from support_card_msgs l join app_messages m on m.id = l.message_id
                      where l.card_id = c.id and lower(coalesce(m.body, '') || ' ' || coalesce(m.file_name, '')) like '%' || q || '%')))
    order by coalesce(c.closed_at, greatest(c.last_user_at, c.last_staff_at, c.updated_at)) desc
    limit case when p_archive then 200 else 1000 end) x);
end $$;

create or replace function public.support_card(p_id uuid) returns json
language plpgsql security definer set search_path = public stable as $$
declare c support_cards;
begin
  if not support_card_ok(p_id) then raise exception 'not support'; end if;
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

create or replace function public.support_take(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare c support_cards;
begin
  if not support_card_ok(p_id) then raise exception 'not support'; end if;
  select * into c from support_cards where id = p_id for update;
  if not found or c.status in ('done', 'rejected') then raise exception 'card closed'; end if;
  update support_cards set taken_by = auth.uid(), status = case when status = 'new' then 'work' else status end where id = p_id;
  perform support_log(p_id, 'take', c.status, case when c.status = 'new' then 'work' else c.status end,
    case when c.taken_by is not null and c.taken_by <> auth.uid() then 'забрал у ' || support_name(c.taken_by) end);
end $$;

create or replace function public.support_move(p_id uuid, p_status text, p_note text default '') returns void
language plpgsql security definer set search_path = public as $$
declare c support_cards;
begin
  if not support_card_ok(p_id) then raise exception 'not support'; end if;
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

create or replace function public.support_reply(p_id uuid, p_body text, p_status text default null) returns void
language plpgsql security definer set search_path = public as $$
declare c support_cards; b text := left(trim(coalesce(p_body, '')), 8000);
begin
  if not support_card_ok(p_id) then raise exception 'not support'; end if;
  if b = '' then raise exception 'empty'; end if;
  select * into c from support_cards where id = p_id for update;
  if not found then raise exception 'no card'; end if;
  insert into app_messages (from_id, from_name, to_id, kind, body)
    values (auth.uid(), case when is_support() then 'Поддержка RaskroyPro · ' else 'Официальный представитель RaskroyPro · ' end || support_name(auth.uid()) || ' → ' || support_name(c.user_id), c.user_id, 'reply', b);
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
  if not support_card_ok(p_id) then raise exception 'not support'; end if;
  update support_cards set summary = nullif(left(trim(coalesce(p_text, '')), 1000), '') where id = p_id;
  if not found then raise exception 'no card'; end if;
  perform support_log(p_id, 'summary', null, null, p_text);
end $$;

create or replace function public.support_close(p_id uuid, p_status text, p_message text default '') returns void
language plpgsql security definer set search_path = public as $$
declare c support_cards; n text := trim(coalesce(p_message, ''));
begin
  if not support_card_ok(p_id) then raise exception 'not support'; end if;
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

create or replace function public.support_reopen(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare c support_cards;
begin
  if not support_card_ok(p_id) then raise exception 'not support'; end if;
  select * into c from support_cards where id = p_id for update;
  if not found or c.status not in ('done', 'rejected') then raise exception 'not closed'; end if;
  if exists (select 1 from support_cards where user_id = c.user_id and id <> c.id and status not in ('done', 'rejected'))
    then raise exception 'has open'; end if;
  update support_cards set status = case when taken_by is not null then 'work' else 'new' end, closed_at = null where id = p_id;
  perform support_log(p_id, 'reopen', c.status, (select status from support_cards where id = p_id), null);
end $$;

create or replace function public.support_assign(p_id uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare c support_cards;
begin
  if not is_support() or not support_card_ok(p_id) then raise exception 'not support'; end if;
  if not (exists (select 1 from support_staff where user_id = p_user and active) or exists (select 1 from profiles where id = p_user and role = 'admin'))
    then raise exception 'not in team'; end if;
  select * into c from support_cards where id = p_id for update;
  if not found or c.status in ('done', 'rejected') then raise exception 'card closed'; end if;
  update support_cards set taken_by = p_user, status = case when status = 'new' then 'work' else status end where id = p_id;
  perform support_log(p_id, 'assign', c.status, case when c.status = 'new' then 'work' else c.status end, 'передал: ' || support_name(p_user));
  perform support_push(array[p_user], 'Поддержка: вам передали обращение №' || c.num, support_name(c.user_id), '/support/' || p_id, 'sup:' || p_id);
end $$;

create or replace function public.support_file(p_msg uuid) returns json
language plpgsql security definer set search_path = public stable as $$
begin
  if not (is_support() or is_partner()) then raise exception 'not support'; end if;
  return (select json_build_object('payload', m.payload, 'file_name', m.file_name) from app_messages m
    where m.id = p_msg and m.kind in ('appeal', 'debug', 'reply')
      and exists (select 1 from support_cards c where c.user_id = case when m.kind = 'reply' then m.to_id else m.from_id end)
      and support_user_ok(case when m.kind = 'reply' then m.to_id else m.from_id end));
end $$;

create or replace function public.support_on_message() returns trigger
language plpgsql security definer set search_path = public as $$
declare c support_cards; fresh boolean := false; nm text; pt uuid;
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
    pt := partner_of(new.from_id);
    if fresh and pt is not null then
      perform push_enqueue(pt, 'Обращение вашего клиента · ' || nm,
        left(coalesce(nullif(new.body, ''), new.file_name, ''), 140), '/support/' || c.id, 'sup:' || c.id);
    elsif fresh then
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

create or replace function public.support_notes_list(p_card uuid default null) returns json
language plpgsql security definer set search_path = public stable as $$
begin
  if not (case when p_card is null then is_support() else support_card_ok(p_card) end) then raise exception 'not support'; end if;
  return (select coalesce(json_agg(x order by x.created_at), '[]'::json) from (
    select n.id, n.created_at, n.author, support_name(n.author) as author_name, n.body
    from support_notes n
    where (p_card is null and n.card_id is null) or n.card_id = p_card
    order by n.created_at desc limit 300) x);
end $$;

create or replace function public.support_note_add(p_card uuid, p_body text) returns void
language plpgsql security definer set search_path = public as $$
declare b text := left(trim(coalesce(p_body, '')), 4000); c support_cards; u uuid; me text;
begin
  if not (case when p_card is null then is_support() else support_card_ok(p_card) end) then raise exception 'not support'; end if;
  if b = '' then raise exception 'empty'; end if;
  if p_card is not null then
    select * into c from support_cards where id = p_card;
    if not found then raise exception 'no card'; end if;
  end if;
  insert into support_notes (card_id, author, body) values (p_card, auth.uid(), b);
  me := support_name(auth.uid());
  begin
    if p_card is null then
      for u in select user_id from support_staff where active and user_id <> auth.uid()
               union select id from profiles where role = 'admin' and id <> auth.uid() loop
        perform push_enqueue(u, 'Чат поддержки · ' || me, left(b, 140), '/support?chat=1', 'supchat');
      end loop;
    else
      perform support_log(p_card, 'note', null, null, left(b, 200));
      if c.taken_by is not null and c.taken_by <> auth.uid() then
        perform push_enqueue(c.taken_by, 'Заметка к обращению №' || c.num || ' · ' || me, left(b, 140), '/support/' || p_card, 'sup:' || p_card);
      end if;
    end if;
  exception when others then null;
  end;
end $$;

create or replace function public.push_on_message() returns trigger
language plpgsql security definer set search_path = public as $$
declare u uuid; o orders;
begin
  if new.kind in ('appeal', 'debug') and partner_of(new.from_id) is not null then
    null;   -- клиент партнёра: уведомление получает партнёр (support_on_message), не мастер-аккаунт
  elsif new.kind in ('appeal', 'debug') then
    perform push_admins(case when new.kind = 'debug' then 'Файл для отладки' else 'Новое обращение' end || coalesce(': ' || nullif(new.from_name, ''), ''),
      left(coalesce(new.body, new.file_name, ''), 140), '/go?t=msg', 'msg:' || new.id);
  elsif new.kind = 'reply' and new.to_id is not null then
    perform push_enqueue(new.to_id, 'Ответ от RaskroyPro', left(coalesce(new.body, ''), 140), '/go?t=msg', 'msg:' || new.id);
  elsif new.kind = 'order' and new.to_id is not null then
    select * into o from orders where id = new.order_id;
    perform push_enqueue(new.to_id, 'Сообщение по заказу «' || push_order_title(o) || '»', left(coalesce(new.body, ''), 140),
      case when new.to_id = o.user_id then '/go?t=client&f=' else '/go?t=own&f=' end || o.id, 'om:' || new.id);
  elsif new.kind = 'news' then
    for u in select distinct user_id from push_subscriptions where new.to_id is null or user_id = new.to_id loop
      perform push_enqueue(u, coalesce(nullif(new.title, ''), 'Новость RaskroyPro'), left(coalesce(new.body, ''), 140), '/go?t=msg', 'news:' || new.id);
    end loop;
  end if;
  return new;
end $$;

notify pgrst, 'reload schema';
