-- Закрыть остальной лишний доступ через is_staff(): правила «p_sel» (profiles) и «d_all» (order_details) — их нет в
-- миграциях приложения. Вместо них — правила приложения: профиль — свой (все — администратору; контакты клиента
-- производство получает функцией базы order_client); детали — читать, если виден сам заказ, менять — хозяину заказа
-- и администратору (производство меняет через функции базы). Выполнить один раз в Supabase → SQL Editor.

drop policy if exists "p_sel" on public.profiles;
drop policy if exists "profiles: свой или админ — читать" on public.profiles;
create policy "profiles: свой или админ — читать" on public.profiles for select using (id = auth.uid() or public.is_admin());

drop policy if exists "d_all" on public.order_details;
drop policy if exists "order_details: читать по заказу" on public.order_details;
create policy "order_details: читать по заказу" on public.order_details for select using (order_id in (select id from public.orders));
drop policy if exists "order_details: менять свои" on public.order_details;
create policy "order_details: менять свои" on public.order_details for all
  using (order_id in (select id from public.orders where user_id = auth.uid() or public.is_admin()))
  with check (order_id in (select id from public.orders where user_id = auth.uid() or public.is_admin()));

alter table public.profiles enable row level security;
alter table public.order_details enable row level security;
notify pgrst, 'reload schema';

-- Проверка: правила с латинскими именами (не из приложения) по всем таблицам — в идеале пусто
select tablename, policyname, cmd, qual from pg_policies
where schemaname = 'public' and policyname !~ '[а-яА-ЯёЁ]' order by 1, 2;
