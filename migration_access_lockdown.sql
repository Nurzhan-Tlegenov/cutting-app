-- Доступ к данным: каждый видит и меняет только своё, всё чужое — только администратор.
-- Выполнить один раз в Supabase → SQL Editor (целиком; можно повторно).
-- ПЕРЕД этим назначьте себя администратором (profiles.role = 'admin'), иначе чужие заказы
-- не увидит никто (в том числе вы) — до тех пор, пока администратор не будет назначен.
--
-- Что делает:
--   • включает защиту строк (RLS) на profiles, orders, order_details, order_models, model_shares, productions;
--   • убирает с них ВСЕ прежние политики (в том числе «полный доступ») и ставит новые;
--   • номер нового заказа выдаёт функция next_order_number — она видит номера всех пользователей,
--     поэтому номера не повторяются, хотя чужие заказы пользователю больше не видны.
-- Просмотр 3D по ссылке (shared_model) и страница «Пользователи» работают как раньше — через свои функции.

create or replace function public.is_admin() returns boolean
language sql security definer set search_path = public stable as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin')
$$;
grant execute on function public.is_admin() to authenticated, anon;

-- следующий номер заказа за день: p_prefix вида '261003_'
create or replace function public.next_order_number(p_prefix text) returns text
language plpgsql security definer set search_path = public as $$
declare last_no text; seq int;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if p_prefix !~ '^[0-9]{6}_$' then raise exception 'bad prefix'; end if;
  select order_number into last_no from orders where order_number like p_prefix || '%' order by order_number desc limit 1;
  seq := coalesce(nullif(regexp_replace(split_part(coalesce(last_no, ''), '_', 2), '\D', '', 'g'), '')::int, 0) + 1;
  return p_prefix || lpad(seq::text, 3, '0');
end $$;
revoke all on function public.next_order_number(text) from public;
grant execute on function public.next_order_number(text) to authenticated;

-- убрать все прежние политики с этих таблиц и включить защиту строк
do $$
declare t text; p record;
begin
  foreach t in array array['profiles', 'orders', 'order_details', 'order_models', 'model_shares', 'productions'] loop
    if to_regclass('public.' || t) is null then continue; end if;
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- профили: свой — видеть и править; все — только администратор
create policy "profiles: свой или админ — читать" on public.profiles for select using (id = auth.uid() or public.is_admin());
create policy "profiles: создать свой" on public.profiles for insert with check (id = auth.uid() or public.is_admin());
create policy "profiles: править свой или админ" on public.profiles for update using (id = auth.uid() or public.is_admin()) with check (id = auth.uid() or public.is_admin());
create policy "profiles: удалять — админ" on public.profiles for delete using (public.is_admin());

-- заказы: свои; все — администратор
create policy "orders: свои или админ" on public.orders for all
  using (user_id = auth.uid() or public.is_admin()) with check (user_id = auth.uid() or public.is_admin());

-- детали и 3D-модель — доступны тому, кому доступен сам заказ
create policy "order_details: по заказу" on public.order_details for all
  using (order_id in (select id from public.orders)) with check (order_id in (select id from public.orders));

do $$
begin
  if to_regclass('public.order_models') is not null then
    execute 'create policy "order_models: по заказу" on public.order_models for all using (order_id in (select id from public.orders)) with check (order_id in (select id from public.orders))';
  end if;
  if to_regclass('public.model_shares') is not null then
    execute 'create policy "model_shares: свои или админ" on public.model_shares for all using (user_id = auth.uid() or public.is_admin()) with check (user_id = auth.uid() and order_id in (select id from public.orders))';
  end if;
  -- производства: список читают все вошедшие (он нужен в раскрое), меняет администратор
  if to_regclass('public.productions') is not null then
    execute 'create policy "productions: читать" on public.productions for select to authenticated using (true)';
    execute 'create policy "productions: менять — админ" on public.productions for all using (public.is_admin()) with check (public.is_admin())';
  end if;
end $$;
