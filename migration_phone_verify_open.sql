-- Подтверждение номера и при ОТКРЫТОЙ регистрации. Выполнить один раз в Supabase → SQL Editor (можно повторно).
-- После migration_phone_verify.sql.
--
-- Как работает при «Открыть для всех»:
--   • Telegram: номер сразу считается «одобренным» — человек жмёт «Поделиться номером» в боте, бот тут же присылает код,
--     человек вводит код и пароль. Администратор не нужен;
--   • WhatsApp: как при регистрации по заявке — администратор одобряет и отправляет код (автоматической отправки в WhatsApp нет);
--   • без верно введённого кода аккаунт не создаётся ни при открытой, ни при закрытой регистрации (проверяет триггер).
--   Регистрация сотрудника по ссылке производства — как раньше, без кода.
--   Учтите: «Add user» в панели Supabase теперь тоже пройдёт только для номера с подтверждённым кодом.

create or replace function public.request_signup2(p_name text, p_phone text, p_comment text default '', p_country text default '',
  p_city text default '', p_messenger text default 'telegram')
returns json language plpgsql security definer set search_path = public, extensions as $$
declare d text := norm_phone(p_phone); r signup_requests; reg boolean; auto boolean;
  m text := case when p_messenger in ('telegram', 'whatsapp') then p_messenger else 'telegram' end;
begin
  if length(d) < 10 or length(d) > 15 then raise exception 'bad phone'; end if;
  auto := signup_open() and m = 'telegram';          -- открытая регистрация через Telegram — без одобрения
  reg := phone_registered(d);
  select * into r from signup_requests where digits = d for update;
  if not found then
    insert into signup_requests (phone, digits, full_name, comment, country, city, messenger, tg_token, status)
      values (left(trim(p_phone), 40), d, left(trim(coalesce(p_name, '')), 120), left(trim(coalesce(p_comment, '')), 500),
        nullif(left(trim(coalesce(p_country, '')), 60), ''), nullif(left(trim(coalesce(p_city, '')), 80), ''), m,
        case when m = 'telegram' then encode(gen_random_bytes(12), 'hex') end,
        case when auto then 'approved' else 'new' end)
      returning * into r;
  else
    if r.status = 'new' then
      update signup_requests set full_name = coalesce(nullif(left(trim(p_name), 120), ''), full_name),
        comment = coalesce(nullif(left(trim(p_comment), 500), ''), comment),
        country = coalesce(nullif(left(trim(p_country), 60), ''), country), city = coalesce(nullif(left(trim(p_city), 80), ''), city),
        status = case when auto then 'approved' else status end
      where id = r.id;
    end if;
    if not reg and r.status <> 'rejected' then
      update signup_requests set messenger = m,
        tg_token = coalesce(tg_token, case when m = 'telegram' then encode(gen_random_bytes(12), 'hex') end)
      where id = r.id returning * into r;
    end if;
  end if;
  return json_build_object('status', r.status, 'registered', reg, 'messenger', r.messenger, 'auto', auto,
    'tg_token', case when not reg and r.status <> 'rejected' and r.phone_verified_at is null then r.tg_token end,
    'verified', r.phone_verified_at is not null,
    'code_issued', r.code is not null and coalesce(r.code_expires > now(), false));
end $$;

-- Аккаунт создаётся только по приглашению производства или по одобренной заявке с верно введённым кодом —
-- открытая регистрация больше не пропускает без кода
create or replace function public.check_signup_allowed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if invite_valid(new.raw_user_meta_data ->> 'invite') then return new; end if;
  if exists (select 1 from signup_requests where status = 'approved' and digits = norm_phone(split_part(coalesce(new.email, ''), '@', 1))
             and code_ok_at > now() - interval '30 minutes') then return new; end if;
  raise exception 'signup_closed';
end $$;
drop trigger if exists check_signup_allowed on auth.users;
create trigger check_signup_allowed before insert on auth.users for each row execute function public.check_signup_allowed();

revoke all on function public.request_signup2(text, text, text, text, text, text) from public;
grant execute on function public.request_signup2(text, text, text, text, text, text) to anon, authenticated;
notify pgrst, 'reload schema';
