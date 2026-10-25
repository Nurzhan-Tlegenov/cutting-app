-- Заказчик для производства: страна, город, мессенджер — и переписка по заказу внутри приложения.
-- Производство видит, кто и откуда прислал заказ (бывает, человек из другого города просто тестирует или отправил по
-- ошибке), и может сразу переспросить: в WhatsApp / Telegram или сообщением в приложении — заказчик отвечает там же.
-- Выполнить один раз в Supabase → SQL Editor (можно повторно). Нужны migration_messages_posts.sql и migration_push.sql.

-- ═══ 1) Данные заказчика: + страна, город, мессенджер ═══
create or replace function public.order_client(p_order uuid) returns json
language sql security definer set search_path = public stable as $$
  select json_build_object('full_name', uc.c->>'full_name', 'phone', uc.c->>'phone', 'whatsapp', uc.c->>'whatsapp',
    'production', (select name from productions where id = o.production_id),
    'country', coalesce(nullif(trim(pr.country), ''), nullif(trim(r.country), ''), nullif(trim(u.raw_user_meta_data->>'country'), '')),
    'city', coalesce(nullif(trim(pr.city), ''), nullif(trim(r.city), ''), nullif(trim(u.raw_user_meta_data->>'city'), '')),
    'messenger', r.messenger,
    'telegram', r.tg_chat_id is not null)
  from orders o
    left join lateral (select user_contact(o.user_id) as c) uc on true
    left join profiles pr on pr.id = o.user_id
    left join auth.users u on u.id = o.user_id
    left join signup_requests r on r.digits = norm_phone(split_part(coalesce(u.email, ''), '@', 1))
  where o.id = p_order and (is_admin() or (o.status <> 'draft' and is_my_production(o.production_id)) or o.user_id = auth.uid())
$$;

-- ═══ 2) Переписка по заказу: сообщения вида 'order' ═══
alter table public.app_messages drop constraint if exists app_messages_kind_check;
alter table public.app_messages add constraint app_messages_kind_check check (kind in ('news', 'appeal', 'debug', 'reply', 'order'));
create index if not exists app_messages_order on public.app_messages (order_id, created_at) where order_id is not null;

-- кто может писать и читать по заказу: заказчик и его производство (владелец и сотрудники с полными правами)
create or replace function public.order_chat_ok(p_order uuid) returns boolean
language sql security definer set search_path = public stable as $$
  select exists (select 1 from orders o where o.id = p_order and o.production_id is not null and o.status <> 'draft'
                 and (o.user_id = auth.uid() or is_my_production(o.production_id)))
$$;
grant execute on function public.order_chat_ok(uuid) to authenticated;

-- адресата ставит база: пишет заказчик — владельцу производства, пишет производство — заказчику
create or replace function public.order_message_to() returns trigger
language plpgsql security definer set search_path = public as $$
declare o orders;
begin
  if new.kind <> 'order' then return new; end if;
  select * into o from orders where id = new.order_id;
  if not found then raise exception 'order not found'; end if;
  if o.user_id = new.from_id then new.to_id := (select owner_id from productions where id = o.production_id);
  else new.to_id := o.user_id; end if;
  return new;
end $$;
drop trigger if exists order_message_to on public.app_messages;
create trigger order_message_to before insert on public.app_messages for each row execute function public.order_message_to();

drop policy if exists "app_messages: читать" on public.app_messages;
create policy "app_messages: читать" on public.app_messages for select to authenticated
  using (public.is_admin() or from_id = auth.uid() or to_id = auth.uid() or (kind = 'news' and to_id is null)
         or (kind = 'order' and public.order_chat_ok(order_id)));

drop policy if exists "app_messages: писать" on public.app_messages;
create policy "app_messages: писать" on public.app_messages for insert to authenticated
  with check (from_id = auth.uid() and (public.is_admin() or (kind in ('appeal', 'debug') and to_id is null)
              or (kind = 'order' and order_id is not null and public.order_chat_ok(order_id))));

-- ═══ 3) Пуш: сообщение по заказу — адресату, ссылка сразу на заказ ═══
create or replace function public.push_on_message() returns trigger
language plpgsql security definer set search_path = public as $$
declare u uuid; o orders;
begin
  if new.kind in ('appeal', 'debug') then
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
