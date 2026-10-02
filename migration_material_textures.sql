-- Свои картинки текстур материалов для 3D-просмотра (по названию материала,
-- для каждого пользователя свои). Выполнить один раз в Supabase → SQL Editor.
-- Запросы можно запускать по одному.
create table if not exists public.material_textures (id uuid default gen_random_uuid() primary key, user_id uuid not null default auth.uid() references auth.users(id) on delete cascade, name text not null, data text not null, size_mm numeric default 600, rot boolean default false, updated_at timestamptz default now(), unique (user_id, name));
alter table public.material_textures enable row level security;
drop policy if exists "own textures" on public.material_textures;
create policy "own textures" on public.material_textures for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
