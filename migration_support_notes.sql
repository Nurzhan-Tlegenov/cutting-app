-- Внутренние заметки поддержки и общий чат команды (этап 4, claude/support-spec.md). После migration_support_board.sql.
-- Выполнить в Supabase → SQL Editor целиком (можно повторно).
--   • заметка у карточки (card_id) — видят только мастер-аккаунт и сотрудники поддержки, пользователь — НЕТ;
--   • card_id пусто — сообщение в общем чате команды поддержки.
-- Безопасность: таблица без правил доступа, только через функции (is_support()). Правила других таблиц не меняются.

create table if not exists public.support_notes (
  id bigint generated always as identity primary key,
  card_id uuid references public.support_cards(id) on delete cascade,   -- пусто — общий чат команды
  author uuid references auth.users(id) on delete set null,
  body text not null,
  created_at timestamptz not null default now()
);
create index if not exists support_notes_card on public.support_notes (card_id, created_at);
create index if not exists support_notes_chat on public.support_notes (created_at) where card_id is null;
alter table public.support_notes enable row level security;
revoke all on public.support_notes from anon, authenticated;

-- заметки карточки (p_card) или общий чат (p_card пусто, последние 300). -> [{ id, created_at, author, author_name, body }]
create or replace function public.support_notes_list(p_card uuid default null) returns json
language plpgsql security definer set search_path = public stable as $$
begin
  if not is_support() then raise exception 'not support'; end if;
  return (select coalesce(json_agg(x order by x.created_at), '[]'::json) from (
    select n.id, n.created_at, n.author, support_name(n.author) as author_name, n.body
    from support_notes n
    where (p_card is null and n.card_id is null) or n.card_id = p_card
    order by n.created_at desc limit 300) x);
end $$;

-- написать заметку / в чат. Уведомление: заметка — тому, кто занимается карточкой; чат — всей команде (кроме автора)
create or replace function public.support_note_add(p_card uuid, p_body text) returns void
language plpgsql security definer set search_path = public as $$
declare b text := left(trim(coalesce(p_body, '')), 4000); c support_cards; u uuid; me text;
begin
  if not is_support() then raise exception 'not support'; end if;
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

-- удалить свою заметку (мастер — любую)
create or replace function public.support_note_delete(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_support() then raise exception 'not support'; end if;
  delete from support_notes where id = p_id and (author = auth.uid() or is_admin());
end $$;

revoke all on function public.support_notes_list(uuid), public.support_note_add(uuid, text), public.support_note_delete(bigint) from public, anon, authenticated;
grant execute on function public.support_notes_list(uuid), public.support_note_add(uuid, text), public.support_note_delete(bigint) to authenticated;

notify pgrst, 'reload schema';
