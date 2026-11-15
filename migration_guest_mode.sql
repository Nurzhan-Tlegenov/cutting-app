-- Выключатель пробного режима без регистрации («Попробовать без регистрации» на экране входа).
-- Сам пробный режим работает без базы (заказы гостя — на его устройстве); здесь только включить / выключить кнопку.
-- Выполнить один раз в Supabase -> SQL Editor (можно повторно). Без этого файла кнопка просто включена.

insert into public.app_config (key, value) values ('guest_mode', 'true'::jsonb) on conflict (key) do nothing;

create or replace function public.guest_mode_open() returns boolean
language sql security definer set search_path = public stable as $$
  select coalesce((select value <> 'false'::jsonb from app_config where key = 'guest_mode'), true)
$$;

create or replace function public.admin_set_guest_mode(p_open boolean) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'not admin'; end if;
  insert into app_config (key, value) values ('guest_mode', to_jsonb(p_open)) on conflict (key) do update set value = excluded.value;
  return p_open;
end $$;

revoke all on function public.guest_mode_open(), public.admin_set_guest_mode(boolean) from public, anon, authenticated;
grant execute on function public.guest_mode_open() to anon, authenticated;
grant execute on function public.admin_set_guest_mode(boolean) to authenticated;
notify pgrst, 'reload schema';
