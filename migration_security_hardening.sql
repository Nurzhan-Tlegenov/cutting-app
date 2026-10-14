-- Усиление защиты (аудит, октябрь 2026). Выполнить один раз в Supabase → SQL Editor (можно повторно).
--
-- 1. Функции базы, работающие с правами владельца (security definer), без входа в приложение (роль anon)
--    можно вызывать только те, что нужны до входа: регистрация, восстановление пароля, ссылки на 3D-модель и
--    симуляцию, приглашение сотрудника. У остальных право вызова без входа снимается — даже если внутри функции
--    есть своя проверка, лишняя дверь закрыта.
--    Supabase по умолчанию выдаёт это право роли anon напрямую, поэтому «revoke … from public» его не снимал.
-- 2. start_stages (запуск техпроцесса заказа) вызывается только базой (при «Пустить в работу») — снимаем право
--    вызывать её напрямую у всех вошедших пользователей.

do $$
declare f record; keep text[] := array[
  'signup_open', 'request_signup', 'request_signup2', 'confirm_signup_code',
  'request_password_reset', 'confirm_password_reset',
  'shared_model', 'shared_model_code', 'shared_sim',
  'invite_info', 'invite_valid'];
begin
  for f in
    select p.oid::regprocedure as sig, p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef and p.prokind = 'f'
      and has_function_privilege('anon', p.oid, 'execute')
  loop
    if f.proname = any(keep) then continue; end if;
    execute format('revoke execute on function %s from anon, public', f.sig);
    raise notice 'закрыто без входа: %', f.sig;
  end loop;
end $$;

-- новые функции тоже не получают право вызова без входа автоматически
alter default privileges revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon;

do $$ begin
  if to_regprocedure('public.start_stages(uuid)') is not null then
    revoke execute on function public.start_stages(uuid) from anon, authenticated, public;
  end if;
end $$;

notify pgrst, 'reload schema';
