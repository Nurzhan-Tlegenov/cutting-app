-- Конструктор мебели: проекты пользователя (корпуса, панели, стекло, профили — одним JSON).
-- Выполнить один раз в Supabase → SQL Editor (можно повторно).
-- Видит и правит только сам пользователь. Пока таблицы нет, проекты хранятся в браузере (на этом устройстве).

create table if not exists public.cad_projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null default 'Новый проект',
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists cad_projects_user on public.cad_projects (user_id, updated_at desc);

alter table public.cad_projects enable row level security;
drop policy if exists "cad_projects: свои" on public.cad_projects;
create policy "cad_projects: свои" on public.cad_projects
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

grant select, insert, update, delete on public.cad_projects to authenticated;
