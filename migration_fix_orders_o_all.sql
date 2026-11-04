-- Закрыть лишний доступ к заказам: правило «o_all» (свои ИЛИ is_staff()) давало каждому «сотруднику» по is_staff —
-- по всей видимости, всем с ролью производства — читать, менять и удалять ВСЕ заказы всех пользователей.
-- Его нет ни в одной миграции приложения. Вместо него — правила, на которые рассчитано приложение:
--   свои заказы (и всё — администратору); производство читает оформленные заказы, пришедшие к нему;
--   сотрудники — по правилам «сотрудник читает…» (они уже есть и остаются).
-- Менять чужие заказы производство может только через функции базы (статус, раскрой, пометки) — как и задумано.
-- Выполнить один раз в Supabase → SQL Editor (можно повторно).

drop policy if exists "o_all" on public.orders;

drop policy if exists "orders: свои или админ" on public.orders;
create policy "orders: свои или админ" on public.orders for all
  using (user_id = auth.uid() or public.is_admin()) with check (user_id = auth.uid() or public.is_admin());

drop policy if exists "orders: производство читает оформленные" on public.orders;
create policy "orders: производство читает оформленные" on public.orders for select
  using (status <> 'draft' and public.is_my_production(production_id));

alter table public.orders enable row level security;
notify pgrst, 'reload schema';

-- Проверка: должны остаться 5 правил — «свои или админ», «производство читает оформленные»,
-- «сотрудник читает назначенные», «сотрудник производства читает», «создавать — с доступом клиента».
select policyname, cmd from pg_policies where schemaname = 'public' and tablename = 'orders' order by 1;
