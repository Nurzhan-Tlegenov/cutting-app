-- Push-уведомления в шторку телефона (приходят, даже когда приложение закрыто).
-- Выполнить один раз в Supabase → SQL Editor целиком (можно повторно). Перед этим — установить функцию «push»
-- (supabase/functions/push/index.ts, «Verify JWT» выключен).
--
-- Кому что приходит:
--   мастер-аккаунт — новая заявка на регистрацию, просьба восстановить пароль, производство ждёт подтверждения,
--                    новое обращение или файл для отладки;
--   производство   — новая заявка (заказ оформлен на него);
--   сотрудник поста — на его пост пришёл заказ;
--   заказчик       — у его заказа сменился статус (принят, исполнен, возвращён на доработку…);
--   все            — новость мастер-аккаунта, ответ мастер-аккаунта на обращение.

create extension if not exists pg_net;

-- телефоны (браузеры), на которые человек разрешил уведомления
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  ua text,
  created_at timestamptz default now()
);
create index if not exists push_subscriptions_user on public.push_subscriptions (user_id);
alter table public.push_subscriptions enable row level security;
drop policy if exists "push_subscriptions: свои" on public.push_subscriptions;
create policy "push_subscriptions: свои" on public.push_subscriptions for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- очередь сообщений и ключи шифрования: только для функции push (политик нет — из приложения не читаются)
create table if not exists public.push_outbox (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  body text,
  url text,
  tag text,
  created_at timestamptz default now(),
  sent_at timestamptz
);
create index if not exists push_outbox_unsent on public.push_outbox (created_at) where sent_at is null;
alter table public.push_outbox enable row level security;
create table if not exists public.push_keys (id int primary key, public_key text not null, private_jwk jsonb not null);
alter table public.push_keys enable row level security;

-- открытый ключ — приложению, чтобы подписать телефон
create or replace function public.push_public_key() returns text
language sql security definer set search_path = public stable as $$ select public_key from push_keys where id = 1 $$;
grant execute on function public.push_public_key() to authenticated;

-- Telegram-чат человека (номер подтверждён в боте) — туда идут уведомления, если push не включён
create or replace function public.push_tg_chat(p_user uuid) returns bigint
language sql security definer set search_path = public stable as $$
  select r.tg_chat_id from signup_requests r
  where r.tg_chat_id is not null and r.phone_verified_at is not null
    and r.digits = norm_phone((select coalesce(nullif(p.phone, ''), split_part(u.email, '@', 1)) from auth.users u left join profiles p on p.id = u.id where u.id = p_user))
  order by r.created_at desc limit 1
$$;
revoke execute on function public.push_tg_chat(uuid) from public, anon, authenticated;

-- положить сообщение в очередь и разбудить функцию (ошибка отправки не мешает основному действию)
create or replace function public.push_enqueue(p_user uuid, p_title text, p_body text, p_url text, p_tag text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_user is null then return; end if;
  insert into push_outbox (user_id, title, body, url, tag) values (p_user, p_title, p_body, p_url, p_tag);
  begin
    perform net.http_post(url := 'https://bmcmyrdsxievaglpspcn.supabase.co/functions/v1/push',
                          body := '{"action":"wake"}'::jsonb,
                          headers := '{"Content-Type":"application/json","apikey":"sb_publishable_M1nC2YyHn_4zJI5QFAI9Cw_IaC6Ou7u"}'::jsonb);   -- открытый ключ: шлюз без него не пускает
  exception when others then null;
  end;
end $$;
revoke execute on function public.push_enqueue(uuid, text, text, text, text) from public, anon, authenticated;

create or replace function public.push_admins(p_title text, p_body text, p_url text, p_tag text) returns void
language plpgsql security definer set search_path = public as $$
declare a uuid;
begin
  for a in select id from profiles where role = 'admin' loop perform push_enqueue(a, p_title, p_body, p_url, p_tag); end loop;
end $$;
revoke execute on function public.push_admins(text, text, text, text) from public, anon, authenticated;

create or replace function public.push_order_title(o orders) returns text
language sql immutable as $$ select coalesce(nullif(trim(o.order_name), ''), o.order_number, 'без названия') $$;

-- ═══ мастер-аккаунт: заявки на регистрацию ═══
create or replace function public.push_on_signup() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'new' and (tg_op = 'INSERT' or old.status is distinct from 'new') then
    perform push_admins('Новая заявка на регистрацию', trim(coalesce(new.full_name, '') || ' · ' || coalesce(new.phone, '')),
      '/go?t=users&f=rq:' || new.id, 'rq:' || new.id);
  end if;
  return new;
end $$;
drop trigger if exists push_signup on public.signup_requests;
create trigger push_signup after insert or update of status on public.signup_requests for each row execute function public.push_on_signup();

-- ═══ мастер-аккаунт: восстановление пароля ═══
create or replace function public.push_on_reset() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform push_admins('Просят восстановить пароль', '+' || new.digits, '/go?t=users&f=pw:' || new.id, 'pw:' || new.id);
  return new;
end $$;
drop trigger if exists push_reset on public.password_resets;
create trigger push_reset after insert on public.password_resets for each row execute function public.push_on_reset();

-- ═══ мастер-аккаунт: производство ждёт подтверждения ═══
create or replace function public.push_on_production() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'pending' and (tg_op = 'INSERT' or old.status is distinct from 'pending') then
    perform push_admins('Производство ждёт подтверждения', trim(coalesce(new.name, '') || ' · ' || coalesce(new.city, '')),
      '/go?t=users&f=pd:' || new.id, 'pd:' || new.id);
  end if;
  return new;
end $$;
drop trigger if exists push_production on public.productions;
create trigger push_production after insert or update of status on public.productions for each row execute function public.push_on_production();

-- ═══ производство и заказчик: заказы ═══
create or replace function public.push_on_order() returns trigger
language plpgsql security definer set search_path = public as $$
declare owner uuid; client text; lbl text;
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then return new; end if;
  -- новая заявка производству
  if new.status = 'new' and new.production_id is not null then
    select owner_id into owner from productions where id = new.production_id and status = 'approved';
    if owner is not null and owner is distinct from new.user_id then
      select full_name into client from profiles where id = new.user_id;
      perform push_enqueue(owner, 'Новая заявка: ' || push_order_title(new), coalesce(client, ''),
        '/go?t=own&f=' || new.id, 'po:' || new.id);
    end if;
  end if;
  -- заказчику: статус сменил кто-то другой (производство, мастер-аккаунт)
  if tg_op = 'UPDATE' and new.user_id is not null and auth.uid() is distinct from new.user_id then
    lbl := case
      when new.status = 'draft' then 'возвращён на доработку'
      when new.status = 'new' then 'отправлен, ждёт ответа'
      when new.status = 'discussion' then 'в обсуждении'
      when new.status = 'inwork' then 'принят в работу'
      when new.status = 'done' then 'исполнен'
      else new.status end;
    perform push_enqueue(new.user_id, 'Заказ «' || push_order_title(new) || '»: ' || lbl,
      case when new.status = 'draft' and coalesce(new.return_note, '') <> '' then new.return_note else '' end,
      '/go?t=client&f=' || new.id, 'os:' || new.id);
  end if;
  return new;
exception when undefined_column then return new;   -- в старой базе нет return_note — уведомление не важнее заказа
end $$;
drop trigger if exists push_order on public.orders;
create trigger push_order after insert or update of status on public.orders for each row execute function public.push_on_order();

-- ═══ сотрудники поста: пришёл заказ ═══
create or replace function public.push_on_stage() returns trigger
language plpgsql security definer set search_path = public as $$
declare m uuid; o orders; pid uuid;
begin
  if new.status = 'queued' and old.status is distinct from 'queued' and new.post_id is not null then
    select * into o from orders where id = new.order_id;
    select production_id into pid from production_posts where id = new.post_id;
    for m in select user_id from post_members where post_id = new.post_id loop
      perform push_enqueue(m, 'Новый заказ на посту «' || new.name || '»', push_order_title(o),
        '/go?t=work&p=' || coalesce(pid::text, '') || '&f=' || new.id, 'ps:' || new.id);
    end loop;
  end if;
  return new;
end $$;
drop trigger if exists push_stage on public.order_stages;
create trigger push_stage after update of status on public.order_stages for each row execute function public.push_on_stage();

-- ═══ сообщения ═══
create or replace function public.push_on_message() returns trigger
language plpgsql security definer set search_path = public as $$
declare u uuid;
begin
  if new.kind in ('appeal', 'debug') then
    perform push_admins(case when new.kind = 'debug' then 'Файл для отладки' else 'Новое обращение' end || coalesce(': ' || nullif(new.from_name, ''), ''),
      left(coalesce(new.body, new.file_name, ''), 140), '/go?t=msg', 'msg:' || new.id);
  elsif new.kind = 'reply' and new.to_id is not null then
    perform push_enqueue(new.to_id, 'Ответ от RaskroyPro', left(coalesce(new.body, ''), 140), '/go?t=msg', 'msg:' || new.id);
  elsif new.kind = 'news' then
    for u in select distinct user_id from push_subscriptions where new.to_id is null or user_id = new.to_id loop
      perform push_enqueue(u, coalesce(nullif(new.title, ''), 'Новость RaskroyPro'), left(coalesce(new.body, ''), 140), '/go?t=msg', 'news:' || new.id);
    end loop;
  end if;
  return new;
end $$;
drop trigger if exists push_message on public.app_messages;
create trigger push_message after insert on public.app_messages for each row execute function public.push_on_message();
