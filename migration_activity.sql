-- Вовлечённость пользователей — для мастер-аккаунта:
--   1) просмотры новостей: кто открыл новость (глазик и число просмотров у новости в «Сообщениях»);
--   2) дни в приложении: приложение раз в полчаса отмечает «пользователь здесь» (сколько дней заходил, когда был последний раз);
--   3) рейтинг активности: дни в приложении, заказы, отправленные заказы, детали, сообщения, просмотры новостей,
--      у производств — полученные и готовые заказы, у сотрудников — отметки на постах.
-- Пользователи свои цифры и чужие просмотры не видят — только мастер-аккаунт.
-- Выполнить один раз в Supabase → SQL Editor (можно повторно).

-- ═══════════ дни в приложении ═══════════
create table if not exists public.user_activity (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  hits integer not null default 1,
  last_at timestamptz not null default now(),
  primary key (user_id, day)
);
alter table public.user_activity enable row level security;   -- политик нет: только через функции ниже

create or replace function public.touch_activity() returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return; end if;
  insert into user_activity (user_id, day) values (auth.uid(), (now() at time zone 'Asia/Almaty')::date)
    on conflict (user_id, day) do update set hits = user_activity.hits + 1, last_at = now();
end $$;
revoke all on function public.touch_activity() from public;
grant execute on function public.touch_activity() to authenticated;

-- ═══════════ просмотры новостей ═══════════
create table if not exists public.message_views (
  message_id uuid not null references public.app_messages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  seen_at timestamptz not null default now(),
  primary key (message_id, user_id)
);
create index if not exists message_views_user on public.message_views (user_id, seen_at);
alter table public.message_views enable row level security;   -- только через функции ниже

-- пользователь открыл «Сообщения»: отмечаем показанные ему новости (свои новости мастер не считает)
create or replace function public.mark_news_seen(p_ids uuid[]) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or p_ids is null then return; end if;
  insert into message_views (message_id, user_id)
    select m.id, auth.uid() from app_messages m
    where m.id = any (p_ids) and m.kind = 'news' and m.to_id is null and m.from_id <> auth.uid()
  on conflict do nothing;
end $$;
revoke all on function public.mark_news_seen(uuid[]) from public;
grant execute on function public.mark_news_seen(uuid[]) to authenticated;

-- мастер: по каждой новости — кто и когда открыл; всего — сколько пользователей могло её увидеть
create or replace function public.admin_news_views() returns json
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'not admin'; end if;
  return json_build_object(
    'news', (select coalesce(json_agg(x), '[]'::json) from (
      select m.id, m.created_at,
        (select count(*) from auth.users u where u.id <> m.from_id) as audience,
        (select coalesce(json_agg(json_build_object('id', v.user_id, 'at', v.seen_at,
            'name', coalesce(nullif(trim(p.full_name), ''), p.phone, split_part(u.email, '@', 1))) order by v.seen_at), '[]'::json)
          from message_views v left join profiles p on p.id = v.user_id left join auth.users u on u.id = v.user_id
          where v.message_id = m.id) as viewers
      from app_messages m where m.kind = 'news' and m.to_id is null) x),
    'users', (select count(*) from auth.users));
end $$;
revoke all on function public.admin_news_views() from public;
grant execute on function public.admin_news_views() to authenticated;

-- ═══════════ рейтинг активности ═══════════
-- p_days — за сколько последних дней считать (0 — за всё время)
create or replace function public.admin_activity(p_days integer default 30) returns json
language plpgsql security definer set search_path = public as $$
declare since timestamptz := case when coalesce(p_days, 0) > 0 then now() - make_interval(days => p_days) else '-infinity'::timestamptz end;
begin
  if not is_admin() then raise exception 'not admin'; end if;
  return (select coalesce(json_agg(x), '[]'::json) from (
    select u.id, u.created_at, u.last_sign_in_at,
      coalesce(nullif(trim(p.full_name), ''), split_part(u.email, '@', 1)) as name, p.phone, coalesce(p.role, 'client') as role,
      coalesce(nullif(trim(p.country), ''), pr.country) as country, coalesce(nullif(trim(p.city), ''), pr.city) as city,
      pr.id as production_id, pr.name as production_name,
      (select max(a.last_at) from user_activity a where a.user_id = u.id) as last_seen,
      (select count(*) from user_activity a where a.user_id = u.id and a.last_at >= since) as days,
      (select coalesce(sum(a.hits), 0) from user_activity a where a.user_id = u.id and a.last_at >= since) as visits,
      (select count(*) from orders o where o.user_id = u.id and o.created_at >= since) as orders,
      (select count(*) from orders o where o.user_id = u.id and o.status <> 'draft' and coalesce(o.submitted_at, o.created_at) >= since) as submitted,
      (select max(o.created_at) from orders o where o.user_id = u.id) as last_order_at,
      (select coalesce(sum(greatest(d.qty, 1)), 0) from order_details d join orders o on o.id = d.order_id where o.user_id = u.id and o.created_at >= since) as parts,
      (select count(*) from app_messages m where m.from_id = u.id and m.kind in ('appeal', 'debug', 'order') and m.created_at >= since) as messages,
      (select count(*) from message_views v where v.user_id = u.id and v.seen_at >= since) as news_seen,
      (select count(*) from orders o where pr.id is not null and o.production_id = pr.id and o.status <> 'draft' and coalesce(o.submitted_at, o.created_at) >= since) as received,
      (select count(*) from orders o where pr.id is not null and o.production_id = pr.id and o.status = 'done' and coalesce(o.done_at, o.accepted_at, o.submitted_at, o.created_at) >= since) as done,
      (select count(*) from stage_events e where e.user_id = u.id and e.at >= since) as stage_marks
    from auth.users u left join profiles p on p.id = u.id left join productions pr on pr.owner_id = u.id) x);
end $$;
revoke all on function public.admin_activity(integer) from public;
grant execute on function public.admin_activity(integer) to authenticated;

notify pgrst, 'reload schema';
