-- Мессенджер MAX для кода регистрации: человек выбирает в заявке «MAX» — код ему отправляет мастер сам (как WhatsApp).
-- В базе такая заявка идёт как обычная «код пришлёт администратор» (messenger = 'whatsapp'), а отметка contact_app = 'max'
-- говорит мастеру, куда слать код. Выполнить один раз в Supabase -> SQL Editor (можно повторно), ПОСЛЕ migration_tg_remind.sql.

alter table public.signup_requests add column if not exists contact_app text;   -- 'max' — код отправить в MAX; пусто — как выбрано в messenger

-- Отметка «код — в MAX» на заявке этого номера (вызывает приложение сразу после отправки заявки; любое другое — снять отметку)
create or replace function public.signup_set_app(p_phone text, p_app text) returns void
language plpgsql security definer set search_path = public as $$
begin
  update signup_requests set contact_app = case when p_app = 'max' then 'max' end
    where digits = norm_phone(p_phone) and phone_verified_at is null and status <> 'rejected';
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
      (r.tg_pending_chat is not null) as tg_pending, r.tg_reminded_at, r.contact_app,
      case when r.phone_verified_at is null then r.tg_token end as tg_token,
      (select kind from ref_codes where code = r.ref_code) as ref_kind,
      case when r.ref_by is not null then coalesce(
        (select p.name from ref_codes c join productions p on p.id = c.production_id where c.code = r.ref_code),
        (select full_name from profiles where id = r.ref_by), 'пользователь') end as ref_by_name,
      exists (select 1 from auth.users u where norm_phone(split_part(u.email, '@', 1)) = r.digits) as registered
    from signup_requests r) x);
end $$;

revoke all on function public.signup_set_app(text, text), public.admin_requests() from public, anon, authenticated;
grant execute on function public.signup_set_app(text, text) to anon, authenticated;
grant execute on function public.admin_requests() to authenticated;
notify pgrst, 'reload schema';
