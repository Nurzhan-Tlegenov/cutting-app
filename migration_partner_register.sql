-- Представитель сам регистрирует производство (PartnerPage → «Зарегистрировать компанию»):
-- вводит название компании и её телефон → сразу получает код. Потом входит по ссылке с этим кодом,
-- придумывает пароль — аккаунт компании создан и закреплён за представителем (ссылка «для производства» → trg_partner_ref).
create or replace function public.partner_register_company(p_name text, p_phone text, p_country text default '', p_city text default '')
returns json language plpgsql security definer set search_path = public, extensions as $$
declare d text := norm_phone(p_phone); rc text; r signup_requests; c text;
  nm text := left(trim(coalesce(p_name, '')), 120);
begin
  if not is_partner() then raise exception 'not partner'; end if;
  if length(nm) < 2 then return json_build_object('error', 'name'); end if;
  if length(d) < 10 or length(d) > 15 then return json_build_object('error', 'phone'); end if;
  if phone_registered(d) then return json_build_object('error', 'registered'); end if;
  rc := my_ref_code('production');
  select * into r from signup_requests where digits = d for update;
  if not found then
    insert into signup_requests (phone, digits, full_name, comment, country, city, messenger, status, ref_code, ref_by)
      values ('+' || d, d, nm, 'Зарегистрировал представитель', nullif(left(trim(coalesce(p_country, '')), 60), ''),
        nullif(left(trim(coalesce(p_city, '')), 80), ''), 'whatsapp', 'approved', rc, auth.uid())
      returning * into r;
  else
    update signup_requests set status = 'approved', ref_code = rc, ref_by = auth.uid(), full_name = nm,
      country = coalesce(nullif(left(trim(coalesce(p_country, '')), 60), ''), country),
      city = coalesce(nullif(left(trim(coalesce(p_city, '')), 80), ''), city)
      where id = r.id returning * into r;
  end if;
  c := case when r.code is not null and r.code_expires > now() and r.code_attempts < 5 then r.code else issue_signup_code(r.id) end;
  update signup_requests set code_sent_at = now() where id = r.id;
  return json_build_object('code', c, 'digits', d, 'ref', rc, 'name', nm);
end $$;

revoke all on function public.partner_register_company(text, text, text, text) from public, anon;
grant execute on function public.partner_register_company(text, text, text, text) to authenticated;
notify pgrst, 'reload schema';

-- кабинет представителя: телефон клиента — подставляется в «Добавить вход»
create or replace function public.partner_me() returns json
language plpgsql security definer set search_path = public stable as $$
begin
  if not is_partner() then return null; end if;
  return (select json_build_object('title', p.title, 'clients', (
    select coalesce(json_agg(json_build_object('user_id', c.user_id, 'at', c.at, 'name', pr.full_name, 'city', pr.city, 'country', pr.country, 'phone', pr.phone,
        'production', (select x.name from productions x where x.owner_id = c.user_id limit 1),
        'production_status', (select x.status from productions x where x.owner_id = c.user_id limit 1),
        'orders', (select count(*) from orders o where o.user_id = c.user_id or o.production_id in (select id from productions where owner_id = c.user_id)))
      order by c.at desc), '[]'::json)
    from partner_clients c left join profiles pr on pr.id = c.user_id where c.partner_id = p.user_id))
  from partners p where p.user_id = auth.uid());
end $$;
notify pgrst, 'reload schema';
