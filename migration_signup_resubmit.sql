-- Повторная заявка после отклонения: человек исправляет данные (настоящие имя и фамилия) и подаёт заявку ещё раз.
-- Заявка снова становится «новой» и ждёт одобрения. Условия: имя похоже на настоящее, отличается от отклонённого,
-- повторов не больше 3. Подтверждение номера в Telegram, если уже было, сохраняется.
alter table public.signup_requests add column if not exists resubmits int not null default 0;
alter table public.signup_requests add column if not exists rejected_name text;

-- имя и фамилия похожи на настоящие: два слова (каждое от 2 букв), без цифр, без слов «тест», «test» и одинаковых слов
create or replace function public.name_looks_real(p text) returns boolean
language plpgsql immutable as $$
declare w text[] := regexp_split_to_array(lower(trim(coalesce(p, ''))), '\s+'); x text; n int := 0;
begin
  foreach x in array w loop
    if regexp_replace(x, '[[:punct:]]', '', 'g') ~ '^(тест|test|qwe|qwerty|asd|йцу|йцукен|фыв|xxx|ххх)$' then return false; end if;
    if x ~ '\d' then return false; end if;
    if length(regexp_replace(x, '[[:punct:][:space:]]', '', 'g')) >= 2 then n := n + 1; end if;
  end loop;
  -- одно слово — только у имён без пробелов (китайские и т. п.): латиница и кириллица — имя и фамилия
  if n < 2 and (n < 1 or lower(p) ~ '[a-zа-яё]') then return false; end if;
  if array_length(w, 1) = 2 and w[1] = w[2] then return false; end if;
  return true;
end $$;

create or replace function public.request_signup2(p_name text, p_phone text, p_comment text default '', p_country text default '',
  p_city text default '', p_messenger text default 'telegram')
returns json language plpgsql security definer set search_path = public, extensions as $$
declare d text := norm_phone(p_phone); r signup_requests; reg boolean; auto boolean; resub text := null;
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
    elsif r.status = 'rejected' and not reg then
      -- повторная заявка после отклонения
      if r.resubmits >= 3 then resub := 'limit';
      elsif not name_looks_real(p_name) then resub := 'bad_name';
      elsif lower(trim(p_name)) = lower(trim(coalesce(r.full_name, ''))) then resub := 'same_name';
      else
        update signup_requests set rejected_name = full_name, full_name = left(trim(p_name), 120),
          comment = coalesce(nullif(left(trim(p_comment), 500), ''), comment),
          country = coalesce(nullif(left(trim(p_country), 60), ''), country), city = coalesce(nullif(left(trim(p_city), 80), ''), city),
          resubmits = resubmits + 1, created_at = now(),
          code = null, code_expires = null, code_attempts = 0, code_ok_at = null,
          status = case when auto then 'approved' else 'new' end
        where id = r.id returning * into r;
        resub := 'ok';
      end if;
    end if;
    if not reg and r.status <> 'rejected' then
      update signup_requests set messenger = m,
        tg_token = coalesce(tg_token, case when m = 'telegram' then encode(gen_random_bytes(12), 'hex') end)
      where id = r.id returning * into r;
    end if;
  end if;
  return json_build_object('status', r.status, 'registered', reg, 'messenger', r.messenger, 'auto', auto, 'resubmit', resub,
    'tg_token', case when not reg and r.status <> 'rejected' and r.phone_verified_at is null then r.tg_token end,
    'verified', r.phone_verified_at is not null,
    'code_issued', r.code is not null and coalesce(r.code_expires > now(), false));
end $$;

create or replace function public.admin_requests() returns json
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'not admin'; end if;
  return (select coalesce(json_agg(x order by x.created_at desc), '[]'::json) from (
    select r.id, r.phone, r.digits, r.full_name, r.comment, r.status, r.created_at, r.country, r.city,
      r.messenger, r.phone_verified_at, (r.tg_chat_id is not null) as tg_linked,
      r.code, r.code_expires, r.code_attempts, r.code_sent_at, (r.code_expires is not null and r.code_expires < now()) as code_expired,
      r.resubmits, r.rejected_name,
      exists (select 1 from auth.users u where norm_phone(split_part(u.email, '@', 1)) = r.digits) as registered
    from signup_requests r) x);
end $$;

revoke all on function public.request_signup2(text, text, text, text, text, text), public.admin_requests() from public, anon, authenticated;
grant execute on function public.request_signup2(text, text, text, text, text, text) to anon, authenticated;
grant execute on function public.admin_requests() to authenticated;
notify pgrst, 'reload schema';
