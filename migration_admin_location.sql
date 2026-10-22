-- Мастер-аккаунт исправляет страну и город пользователя (Пользователи → ✎ Изменить).
-- Выполнить в Supabase → SQL Editor целиком, один раз (можно повторно).
create or replace function public.admin_set_location(p_user uuid, p_country text, p_city text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'not admin'; end if;
  update profiles set country = nullif(trim(p_country), ''), city = nullif(trim(p_city), '') where id = p_user;
  if not found then raise exception 'profile not found'; end if;
end $$;
revoke all on function public.admin_set_location(uuid, text, text) from public;
grant execute on function public.admin_set_location(uuid, text, text) to authenticated;
