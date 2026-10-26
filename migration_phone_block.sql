-- Заблокированные номера (мастер-аккаунт → Пользователи → «Заблокированные номера»).
-- Номер из списка не может зарегистрироваться (ни по заявке, ни по ссылке-приглашению), оставить заявку,
-- запросить смену пароля или помощь со входом. Ему ничего не сообщается о блокировке — просто «не получилось».
-- Если у номера есть аккаунт — вход в него закрывается (аккаунт не удаляется: удалить можно отдельно).
-- Выполнить один раз в Supabase → SQL Editor (можно повторно).

create table if not exists public.blocked_phones (
  digits text primary key,
  note text,
  created_at timestamptz default now(),
  created_by uuid
);
alter table public.blocked_phones enable row level security;
revoke all on public.blocked_phones from anon, authenticated;

create or replace function public.phone_blocked(p_digits text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from blocked_phones where digits = p_digits and coalesce(p_digits, '') <> '')
$$;

-- Регистрация: аккаунт с заблокированным номером не создаётся (тот же отказ, что у закрытой регистрации)
create or replace function public.check_phone_blocked() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if phone_blocked(norm_phone(split_part(coalesce(new.email, ''), '@', 1))) then raise exception 'signup_closed'; end if;
  return new;
end $$;
drop trigger if exists check_phone_blocked on auth.users;
create trigger check_phone_blocked before insert on auth.users for each row execute function public.check_phone_blocked();

-- Заявка на регистрацию, смена пароля, «не получается войти» — для заблокированного номера не проходят
create or replace function public.block_phone_rows() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if phone_blocked(new.digits) then raise exception 'Не получилось — попробуйте позже'; end if;
  return new;
end $$;
drop trigger if exists block_phone_rows on public.signup_requests;
create trigger block_phone_rows before insert or update on public.signup_requests for each row execute function public.block_phone_rows();
drop trigger if exists block_phone_rows on public.password_resets;
create trigger block_phone_rows before insert or update on public.password_resets for each row execute function public.block_phone_rows();
drop trigger if exists block_phone_rows on public.login_help;
create trigger block_phone_rows before insert on public.login_help for each row execute function public.block_phone_rows();

-- Мастер: заблокировать номер. Аккаунт с этим номером (если есть) — вход закрыт, открытые сеансы завершаются.
create or replace function public.admin_block_phone(p_phone text, p_note text default '') returns text
language plpgsql security definer set search_path = public, auth as $$
declare d text := norm_phone(p_phone); uid uuid;
begin
  if not is_admin() then raise exception 'not admin'; end if;
  if length(d) < 10 or length(d) > 15 then return 'bad phone'; end if;
  select id into uid from auth.users where norm_phone(split_part(email, '@', 1)) = d limit 1;
  if uid = auth.uid() or exists (select 1 from profiles where id = uid and role = 'admin') then return 'admin'; end if;
  -- заявка и запросы смены пароля этого номера убираются (до блокировки: правка этих строк потом уже не пройдёт)
  delete from signup_requests where digits = d;
  delete from password_resets where digits = d;
  insert into blocked_phones (digits, note, created_by) values (d, nullif(left(trim(coalesce(p_note, '')), 200), ''), auth.uid())
    on conflict (digits) do update set note = coalesce(excluded.note, blocked_phones.note);
  if uid is not null then
    update auth.users set banned_until = now() + interval '100 years' where id = uid;
    begin delete from auth.sessions where user_id = uid; exception when others then null; end;
    begin delete from auth.refresh_tokens where user_id = uid::text; exception when others then null; end;
  end if;
  return 'ok';
end $$;

-- Мастер: снять блокировку — номер снова может зарегистрироваться, вход в аккаунт (если он есть) открыт
create or replace function public.admin_unblock_phone(p_phone text) returns text
language plpgsql security definer set search_path = public, auth as $$
declare d text := norm_phone(p_phone);
begin
  if not is_admin() then raise exception 'not admin'; end if;
  delete from blocked_phones where digits = d;
  update auth.users set banned_until = null where norm_phone(split_part(email, '@', 1)) = d;
  return 'ok';
end $$;

-- Мастер: список заблокированных номеров (есть ли у номера аккаунт)
create or replace function public.admin_blocked_phones() returns json
language plpgsql security definer set search_path = public, auth as $$
begin
  if not is_admin() then raise exception 'not admin'; end if;
  return coalesce((select json_agg(json_build_object('digits', b.digits, 'note', b.note, 'created_at', b.created_at,
    'user_id', (select u.id from auth.users u where norm_phone(split_part(u.email, '@', 1)) = b.digits limit 1),
    'name', (select p.full_name from profiles p join auth.users u on u.id = p.id where norm_phone(split_part(u.email, '@', 1)) = b.digits limit 1))
    order by b.created_at desc) from blocked_phones b), '[]'::json);
end $$;

revoke all on function public.phone_blocked(text), public.admin_block_phone(text, text), public.admin_unblock_phone(text),
  public.admin_blocked_phones() from public, anon, authenticated;
grant execute on function public.admin_block_phone(text, text), public.admin_unblock_phone(text), public.admin_blocked_phones() to authenticated;
notify pgrst, 'reload schema';
