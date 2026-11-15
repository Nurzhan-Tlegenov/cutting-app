-- Повторная отправка в Telegram тем, кто подал заявку, но не подтвердил номер / не ввёл код.
-- Telegram-бот может написать только тому, кто сам открыл бота (нажал «Старт») — по номеру телефона написать нельзя.
-- Поэтому: открыл бота, но не поделился номером — бот напоминает и снова показывает кнопку «Поделиться номером»;
-- номер подтверждён, заявка одобрена — бот присылает код ещё раз (истёк — новый);
-- бота не открывал — мастер отправляет ему в WhatsApp ссылку на бота (t.me/RaskroyProBot?start=<метка>).
-- Выполнить один раз в Supabase -> SQL Editor (можно повторно), ПОСЛЕ migration_ref_links.sql.
-- Затем обновить функцию tg-bot (Edge Functions -> tg-bot -> вставить новый index.ts -> Deploy).

alter table public.signup_requests add column if not exists tg_reminded_at timestamptz;   -- когда бот последний раз напоминал

-- метка для ссылки на бота — у всех, кто ещё не подтвердил номер (в т. ч. выбравших WhatsApp)
update public.signup_requests set tg_token = encode(gen_random_bytes(12), 'hex')
  where tg_token is null and phone_verified_at is null and status <> 'rejected';

-- Для бота (только функция tg-bot с серверным ключом). -> { mode: 'code', code, chat } | { mode: 'share', chat } | { error }
create or replace function public.svc_tg_remind(p_id uuid) returns json
language plpgsql security definer set search_path = public as $$
declare r signup_requests; c text;
begin
  select * into r from signup_requests where id = p_id for update;
  if not found or r.status = 'rejected' then return json_build_object('error', 'not_found'); end if;
  if phone_registered(r.digits) then return json_build_object('error', 'registered'); end if;
  if r.tg_chat_id is not null and r.phone_verified_at is not null then
    if r.status <> 'approved' then return json_build_object('error', 'not_approved'); end if;
    c := case when r.code is not null and r.code_expires > now() and r.code_attempts < 5 then r.code else issue_signup_code(r.id) end;
    update signup_requests set code_sent_at = now(), tg_reminded_at = now() where id = r.id;
    return json_build_object('mode', 'code', 'code', c, 'chat', r.tg_chat_id);
  end if;
  if r.tg_pending_chat is not null then
    update signup_requests set tg_reminded_at = now() where id = r.id;
    return json_build_object('mode', 'share', 'chat', r.tg_pending_chat);
  end if;
  return json_build_object('error', 'no_chat');
end $$;

-- заявки для мастера — плюс кто пригласил и где застрял Telegram (открыл бота / напоминание)
create or replace function public.admin_requests() returns json
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'not admin'; end if;
  return (select coalesce(json_agg(x order by x.created_at desc), '[]'::json) from (
    select r.id, r.phone, r.digits, r.full_name, r.comment, r.status, r.created_at, r.country, r.city,
      r.messenger, r.phone_verified_at, (r.tg_chat_id is not null) as tg_linked,
      r.code, r.code_expires, r.code_attempts, r.code_sent_at, (r.code_expires is not null and r.code_expires < now()) as code_expired,
      r.resubmits, r.rejected_name,
      (r.tg_pending_chat is not null) as tg_pending, r.tg_reminded_at,
      case when r.phone_verified_at is null then r.tg_token end as tg_token,
      (select kind from ref_codes where code = r.ref_code) as ref_kind,
      case when r.ref_by is not null then coalesce(
        (select p.name from ref_codes c join productions p on p.id = c.production_id where c.code = r.ref_code),
        (select full_name from profiles where id = r.ref_by), 'пользователь') end as ref_by_name,
      exists (select 1 from auth.users u where norm_phone(split_part(u.email, '@', 1)) = r.digits) as registered
    from signup_requests r) x);
end $$;

revoke all on function public.svc_tg_remind(uuid), public.admin_requests() from public, anon, authenticated;
grant execute on function public.svc_tg_remind(uuid) to service_role;
grant execute on function public.admin_requests() to authenticated;
notify pgrst, 'reload schema';
