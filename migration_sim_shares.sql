-- Ссылка на симуляцию обработки листа (ЧПУ): по ней симуляция открывается без входа в приложение.
-- Выполнить один раз в Supabase → SQL Editor (можно повторно).
--
-- sim_shares: одна строка = одна ссылка = снимок программы одного листа (G-код, лист, контуры деталей,
-- диаметры инструментов). Создали ссылку на тот же лист ещё раз — снимок обновляется, адрес остаётся прежним.
-- Удалили строку — ссылка перестаёт открываться.

-- 8 знаков без похожих символов (0/O, 1/l/I) — та же функция, что и у ссылок на 3D-модель
create or replace function public.gen_share_code() returns text
language sql volatile as $$
  select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789', 1 + get_byte(uuid_send(gen_random_uuid()), i) % 56, 1), '')
  from generate_series(0, 7) as i
$$;

create table if not exists public.sim_shares (
  code text primary key default public.gen_share_code(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  name text not null,
  data text not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create unique index if not exists sim_shares_uq on public.sim_shares (user_id, order_id, name);
alter table public.sim_shares enable row level security;
drop policy if exists "sim_shares: свои" on public.sim_shares;
create policy "sim_shares: свои" on public.sim_shares for all
  using (user_id = auth.uid() or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'))
  with check (user_id = auth.uid() and order_id in (select id from public.orders));

-- симуляция по коду — без входа; отдаёт только сам снимок
create or replace function public.shared_sim(p_code text) returns json
language sql security definer set search_path = public stable as $$
  select json_build_object('name', s.name, 'data', s.data) from sim_shares s where s.code = p_code
$$;
revoke all on function public.shared_sim(text) from public;
grant execute on function public.shared_sim(text) to anon, authenticated;

notify pgrst, 'reload schema';
