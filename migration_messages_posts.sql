-- Сообщения (новости мастер-аккаунта, обращения пользователей, файлы для отладки) и общие постпроцессоры.
-- Выполнить в Supabase → SQL Editor целиком, один раз (можно повторно).
-- Нужен migration_security_all.sql (функция is_admin) — он уже выполнен.

-- ═══════════ Сообщения ═══════════
-- kind: news   — новость от мастер-аккаунта (to_id пусто — всем);
--       appeal — обращение пользователя к мастер-аккаунту;
--       debug  — файл для отладки с комментарием (payload — содержимое файла), приходит мастер-аккаунту;
--       reply  — ответ мастер-аккаунта пользователю (to_id — кому).
create table if not exists public.app_messages (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  from_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  from_name text,
  to_id uuid references auth.users(id) on delete cascade,
  kind text not null check (kind in ('news', 'appeal', 'debug', 'reply')),
  title text,
  body text,
  file_name text,
  file_size integer,
  payload text,
  order_id uuid
);
create index if not exists app_messages_created on public.app_messages (created_at desc);
alter table public.app_messages enable row level security;

drop policy if exists "app_messages: читать" on public.app_messages;
create policy "app_messages: читать" on public.app_messages for select to authenticated
  using (public.is_admin() or from_id = auth.uid() or to_id = auth.uid() or (kind = 'news' and to_id is null));

-- пользователь пишет только мастер-аккаунту (обращение или файл); новости и ответы — только мастер-аккаунт
drop policy if exists "app_messages: писать" on public.app_messages;
create policy "app_messages: писать" on public.app_messages for insert to authenticated
  with check (from_id = auth.uid() and (public.is_admin() or (kind in ('appeal', 'debug') and to_id is null)));

drop policy if exists "app_messages: удалять" on public.app_messages;
create policy "app_messages: удалять" on public.app_messages for delete to authenticated
  using (public.is_admin() or from_id = auth.uid());

-- ═══════════ Общие постпроцессоры ═══════════
-- Постпроцессор, у которого мастер-аккаунт поставил галочку «для всех»: его видят все пользователи.
create table if not exists public.shared_posts (
  id text primary key,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.shared_posts enable row level security;

drop policy if exists "shared_posts: читать" on public.shared_posts;
create policy "shared_posts: читать" on public.shared_posts for select to authenticated using (true);

drop policy if exists "shared_posts: менять — мастер" on public.shared_posts;
create policy "shared_posts: менять — мастер" on public.shared_posts for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
