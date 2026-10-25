-- Регистрация без имени, страны и города больше невозможна.
-- Раньше вход «У меня есть код» создавал аккаунт с пустыми полями — в расчёте, что они есть в заявке, а сервер принимал
-- и пустую заявку (при открытой регистрации через Telegram она одобряется сама). Теперь:
--   • триггер на auth.users не создаёт аккаунт, если нет имени, страны или города — ни в данных регистрации, ни в заявке;
--   • signup_missing(номер) — чего не хватает в одобренной заявке: приложение до создания аккаунта показывает эти поля.
-- Сотрудник по приглашению производства — как раньше (имя есть в приглашении, страна и город не нужны).
-- Выполнить один раз в Supabase → SQL Editor (можно повторно).

create or replace function public.signup_missing(p_phone text) returns text
language plpgsql security definer set search_path = public as $$
declare r signup_requests;
begin
  select * into r from signup_requests where digits = norm_phone(p_phone) and status = 'approved';
  if not found then return ''; end if;
  return concat_ws(',',
    case when coalesce(trim(r.full_name), '') = '' then 'name' end,
    case when coalesce(trim(r.country), '') = '' then 'country' end,
    case when coalesce(trim(r.city), '') = '' then 'city' end);
end $$;

create or replace function public.check_signup_profile() returns trigger
language plpgsql security definer set search_path = public as $$
declare m jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb); r signup_requests;
begin
  if invite_valid(m ->> 'invite') then return new; end if;
  select * into r from signup_requests where digits = norm_phone(split_part(coalesce(new.email, ''), '@', 1));
  if coalesce(nullif(trim(m ->> 'full_name'), ''), nullif(trim(r.full_name), '')) is null
     or coalesce(nullif(trim(m ->> 'country'), ''), nullif(trim(r.country), '')) is null
     or coalesce(nullif(trim(m ->> 'city'), ''), nullif(trim(r.city), '')) is null then
    raise exception 'signup_incomplete';
  end if;
  return new;
end $$;
drop trigger if exists check_signup_profile on auth.users;
create trigger check_signup_profile before insert on auth.users for each row execute function public.check_signup_profile();

revoke all on function public.signup_missing(text) from public;
grant execute on function public.signup_missing(text) to anon, authenticated;
notify pgrst, 'reload schema';
