-- Объединённый раскрой нескольких заказов (бета). Выполнить один раз в Supabase → SQL Editor.
--
-- Объединение — отдельный заказ: в merge_of — список заказов-источников [{ id, number, name, seq, sig }],
-- детали источников скопированы в него. У заказов-источников merged_into — пометка «в объединении».
-- Бета: кто пробует — мастер включает в «Пользователях» (β Объединённый раскрой); мастер видит всегда.

alter table public.orders add column if not exists merge_of jsonb;
alter table public.orders add column if not exists merged_into uuid;

-- мои бета-функции; мастер-аккаунт — все
create or replace function public.my_beta() returns text[]
language plpgsql security definer set search_path = public stable as $$
begin
  if is_admin() then return array['beam_saw', 'merge_nesting']; end if;
  return coalesce((select features from beta_testers where user_id = auth.uid()), '{}');
end $$;

revoke all on function public.my_beta() from public, anon;
grant execute on function public.my_beta() to authenticated;
