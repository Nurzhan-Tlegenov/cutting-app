-- Имя и телефон заказчика в заявках производства — всегда, даже если у заказчика не заполнен профиль.
-- Выполнить один раз в Supabase -> SQL Editor (можно повторно). После migration_production_marks.sql.
-- Включает в себя migration_material_kind.sql (параметры ХДФ, число листов) — отдельно его выполнять не нужно.
--
-- Причина: имя и телефон берутся из профиля заказчика, а у части зарегистрированных профиль не создался
-- или остался пустым. Теперь: 1) пустые профили заполняются из заявки на регистрацию и номера входа;
-- 2) заявки производства берут имя и телефон с запасом — профиль, затем заявка на регистрацию, затем номер входа;
-- 3) при входе приложение само дозаполняет профиль (функция ensure_profile).

alter table public.productions add column if not exists hdf_kerf_width numeric;
alter table public.productions add column if not exists hdf_margin_left numeric;
alter table public.productions add column if not exists hdf_margin_right numeric;
alter table public.productions add column if not exists hdf_margin_top numeric;
alter table public.productions add column if not exists hdf_margin_bottom numeric;
alter table public.orders add column if not exists material_kind text;

create or replace function public.order_sheet_count(p text) returns int
language plpgsql immutable as $$
declare j jsonb; n int := 0; v jsonb;
begin
  if p is null or p = '' then return 0; end if;
  j := p::jsonb;
  if j->>'multi' = 'true' then
    for v in select value from jsonb_each(j->'byMat') loop
      if jsonb_typeof(v->'sheets') = 'array' then n := n + jsonb_array_length(v->'sheets'); end if;
    end loop;
  elsif jsonb_typeof(j->'sheets') = 'array' then
    n := jsonb_array_length(j->'sheets');
  end if;
  return n;
exception when others then
  return 0;
end $$;

-- Имя и телефон пользователя «с запасом»: профиль -> заявка на регистрацию -> номер, с которым он входит
create or replace function public.user_contact(p_user uuid) returns json
language sql security definer set search_path = public stable as $$
  select json_build_object(
    'full_name', coalesce(nullif(trim(c.full_name), ''), nullif(trim(r.full_name), '')),
    'phone', coalesce(nullif(trim(c.phone), ''), nullif(trim(r.phone), ''),
                      case when u.email like '%@raskoypro.local' then '+' || norm_phone(split_part(u.email, '@', 1)) end),
    'whatsapp', nullif(trim(c.whatsapp), ''))
  from auth.users u
    left join profiles c on c.id = u.id
    left join signup_requests r on r.digits = norm_phone(split_part(u.email, '@', 1))
  where u.id = p_user
$$;
revoke all on function public.user_contact(uuid) from public;
revoke all on function public.user_contact(uuid) from anon, authenticated;

-- 1) пустые и отсутствующие профили — заполнить
insert into public.profiles (id, email, full_name, phone, role)
select u.id, u.email, (public.user_contact(u.id))->>'full_name', (public.user_contact(u.id))->>'phone', 'client'
from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id);

update public.profiles p
set full_name = coalesce(nullif(trim(p.full_name), ''), (public.user_contact(p.id))->>'full_name'),
    phone = coalesce(nullif(trim(p.phone), ''), (public.user_contact(p.id))->>'phone')
where coalesce(trim(p.full_name), '') = '' or coalesce(trim(p.phone), '') = '';

-- 3) то же для одного пользователя — вызывается приложением при входе
create or replace function public.ensure_profile() returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); c json;
begin
  if uid is null then return; end if;
  c := user_contact(uid);
  insert into profiles (id, email, full_name, phone, role)
    select uid, (select email from auth.users where id = uid), c->>'full_name', c->>'phone', 'client'
    where not exists (select 1 from profiles where id = uid);
  update profiles set full_name = coalesce(nullif(trim(full_name), ''), c->>'full_name'),
                      phone = coalesce(nullif(trim(phone), ''), c->>'phone')
    where id = uid and (coalesce(trim(full_name), '') = '' or coalesce(trim(phone), '') = '');
end $$;
revoke all on function public.ensure_profile() from public;
grant execute on function public.ensure_profile() to authenticated;

-- 2) заявки производства и заказчик заказа — с именем и телефоном «с запасом»
create or replace function public.production_orders() returns json
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  return (select coalesce(json_agg(x order by x.submitted_at desc nulls last), '[]'::json) from (
    select o.id, o.order_number, o.order_name, o.material_name, o.status, o.submitted_at, o.accepted_at, o.created_at,
      o.gcode_at, o.files_saved_at, o.material_kind,
      order_sheet_count(o.nesting_result) as sheets,
      o.user_id = auth.uid() as own,
      uc.c->>'full_name' as client_name, uc.c->>'phone' as client_phone, uc.c->>'whatsapp' as client_whatsapp,
      (select coalesce(sum(d.qty), 0) from order_details d where d.order_id = o.id) as parts
    from orders o join productions p on p.id = o.production_id
      left join lateral (select user_contact(o.user_id) as c) uc on true
    where p.owner_id = auth.uid() and p.status = 'approved' and o.status <> 'draft') x);
end $$;

create or replace function public.order_client(p_order uuid) returns json
language sql security definer set search_path = public stable as $$
  select json_build_object('full_name', uc.c->>'full_name', 'phone', uc.c->>'phone', 'whatsapp', uc.c->>'whatsapp',
    'production', (select name from productions where id = o.production_id))
  from orders o left join lateral (select user_contact(o.user_id) as c) uc on true
  where o.id = p_order and (is_admin() or (o.status <> 'draft' and is_my_production(o.production_id)) or o.user_id = auth.uid())
$$;

notify pgrst, 'reload schema';
