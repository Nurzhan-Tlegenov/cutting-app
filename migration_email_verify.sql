-- Подтверждение почты кодом — для НОВЫХ аккаунтов, зарегистрированных по почте (не по номеру и не через Google).
-- Встроенное «Confirm email» Supabase не включаем: оно сломало бы аккаунты по номеру (служебные адреса @raskoypro.local).
-- Как работает: при создании такого аккаунта появляется запись «нужно подтвердить»; приложение шлёт на почту
-- 6-значный код (вход по коду Supabase, письмо «Magic Link» с {{ .Token }}), человек вводит код — почта подтверждена.
-- Кто зарегистрировался раньше — не затрагивается (записи у них нет).
-- Выполнить один раз в Supabase -> SQL Editor (можно повторно).

create table if not exists public.email_verifications (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  required_at timestamptz not null default now(),
  verified_at timestamptz
);
alter table public.email_verifications enable row level security;   -- читать/писать — только через функции ниже

-- новый аккаунт по почте (провайдер email, не служебный адрес номера) -> «нужно подтвердить»
create or replace function public.email_verify_on_signup() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.email is not null and new.email !~* '@raskoypro\.local$'
     and coalesce(new.raw_app_meta_data->>'provider', 'email') = 'email'
     and coalesce(new.is_anonymous, false) = false then
    insert into email_verifications (user_id, email) values (new.id, new.email) on conflict (user_id) do nothing;
  end if;
  return new;
exception when others then return new;   -- регистрацию не ломаем ни при каких условиях
end $$;
drop trigger if exists email_verify_on_signup on auth.users;
create trigger email_verify_on_signup after insert on auth.users for each row execute function public.email_verify_on_signup();

-- Мой статус: { required, verified, email }
create or replace function public.my_email_status() returns json
language plpgsql security definer set search_path = public stable as $$
declare v email_verifications;
begin
  if auth.uid() is null then return json_build_object('required', false); end if;
  select * into v from email_verifications where user_id = auth.uid();
  if not found then return json_build_object('required', false); end if;
  return json_build_object('required', true, 'verified', v.verified_at is not null,
    'email', (select email from auth.users where id = auth.uid()));
end $$;

-- Отметить почту подтверждённой: только если текущий вход сделан кодом / ссылкой из письма (amr = otp / magiclink)
create or replace function public.mark_email_verified() returns json
language plpgsql security definer set search_path = public as $$
declare amr jsonb := coalesce(auth.jwt()->'amr', '[]'::jsonb);
begin
  if auth.uid() is null then return json_build_object('error', 'not signed in'); end if;
  if not exists (select 1 from jsonb_array_elements(amr) a where a->>'method' in ('otp', 'magiclink')) then
    return json_build_object('error', 'no_otp');
  end if;
  update email_verifications set verified_at = now(), email = (select email from auth.users where id = auth.uid())
    where user_id = auth.uid();
  return json_build_object('ok', true);
end $$;

-- Мастер: кто из новых по почте подтвердил / не подтвердил
create or replace function public.admin_email_verifications() returns json
language plpgsql security definer set search_path = public stable as $$
begin
  if not is_admin() then raise exception 'not admin'; end if;
  return (select coalesce(json_agg(json_build_object('id', user_id, 'verified', verified_at is not null, 'verified_at', verified_at)), '[]'::json)
          from email_verifications);
end $$;

revoke all on function public.my_email_status(), public.mark_email_verified(), public.admin_email_verifications(), public.email_verify_on_signup() from public, anon;
grant execute on function public.my_email_status(), public.mark_email_verified(), public.admin_email_verifications() to authenticated;
notify pgrst, 'reload schema';
