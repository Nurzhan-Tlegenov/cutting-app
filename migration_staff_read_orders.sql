-- Сотрудник производства видит (только читает) заказы своего производства — для сканера бирки и 3D-модели на сборке.
-- Раньше сотрудник видел заказ, только пока тот стоял на его посту. Выполнить один раз в Supabase → SQL Editor (можно повторно).
-- Детали и 3D-модель открываются следом: их правила — «у кого виден заказ». Цены здесь не открываются (они в отдельной таблице).

drop policy if exists "orders: сотрудник производства читает" on public.orders;
create policy "orders: сотрудник производства читает" on public.orders for select
  using (status <> 'draft' and production_id is not null and public.member_can(production_id, null));
notify pgrst, 'reload schema';
