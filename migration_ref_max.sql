-- Регистрация по ссылке-приглашению через MAX: код присылает пригласивший (например, официальный представитель), а не мастер.
-- • ref_contact — имя и телефон пригласившего: человек видит, кому написать первым в MAX (иначе MAX не пропустит ответ с кодом).
-- • signup_set_app — человек выбрал MAX: пригласившему уходит уведомление «Отправьте код в MAX» (раньше — «в WhatsApp»).
-- Выполнить один раз в Supabase -> SQL Editor (можно повторно), ПОСЛЕ migration_max_invite.sql.
create or replace function public.ref_contact(p_code text) returns json
language plpgsql security definer set search_path = public stable as $$
declare c ref_codes := ref_get(p_code);
begin
if c.code is null then return null; end if;
return json_build_object('name', (select nullif(trim(full_name), '') from profiles where id = c.owner_id),
'phone', user_contact(c.owner_id) ->> 'phone');
end $$;
revoke all on function public.ref_contact(text) from public;
grant execute on function public.ref_contact(text) to anon, authenticated;
create or replace function public.signup_set_app(p_phone text, p_app text) returns void
language plpgsql security definer set search_path = public as $$
declare r signup_requests;
begin
update signup_requests set contact_app = case when p_app = 'max' then 'max' end
where digits = norm_phone(p_phone) and phone_verified_at is null and status <> 'rejected';
if p_app = 'max' then
select * into r from signup_requests where digits = norm_phone(p_phone) and phone_verified_at is null and status = 'approved' and ref_by is not null and code_sent_at is null limit 1;
if found then
begin perform push_enqueue(r.ref_by, 'Отправьте код в MAX', trim(coalesce(nullif(trim(r.full_name), ''), '') || ' · +' || r.digits) || ' — регистрация по вашей ссылке. Он напишет вам первым в MAX', '/invite', 'ref:' || r.id);
exception when others then null; end;
end if;
end if;
end $$;
revoke all on function public.signup_set_app(text, text) from public;
grant execute on function public.signup_set_app(text, text) to anon, authenticated;
notify pgrst, 'reload schema';
